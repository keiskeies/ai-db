import type { Engine, ForeignKeyInfo, TableInfo } from '../../types';
import type { TimeBucketGrain } from '../../sql/ddl';
import { buildTimeBucketExpr } from '../../sql/ddl';
import { quoteIdent, quoteLiteral } from '../../sql/ident';

/**
 * 离线推理器的查询模型与编译器。
 *
 * 这一层只认识「结构化意图」，不认识自然语言：解析由 parse.ts 负责，方言拼接由这里负责。
 * 分成两半是为了可测——给定 spec 必须产出确定 SQL，不依赖语料，也不受话术变化影响。
 */

export interface ColumnRef {
  table: string;
  column: string;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'like' | 'is_null' | 'not_null';

export interface FilterSpec {
  col: ColumnRef;
  op: FilterOp;
  /** eq/ne/gt… 用 values[0]；in/like 用整个数组；is_null/not_null 忽略。 */
  values?: Array<string | number>;
  /** 时间窗过滤：解析器只给日期边界，编译器负责半开区间。 */
  window?: { from: string; to: string };
  /** 追问文案用：用户说的是「上海」，落地列可能是 city_code。 */
  source?: string;
}

export type AggregateFn = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';

export interface MeasureSpec {
  fn: AggregateFn;
  /** count 时可省略，表示 COUNT(*)。 */
  col?: ColumnRef;
}

export interface TimeBucketSpec {
  col: ColumnRef;
  grain: TimeBucketGrain;
}

export interface OrderSpec {
  /** 结果列别名（period / label / value…），不引用原始列名。 */
  alias: string;
  desc: boolean;
}

export interface JoinSpec {
  /** 已在 FROM 或前一个 JOIN 中出现的表。 */
  left: string;
  /** 新引入的表。 */
  right: string;
  on: Array<{ left: ColumnRef; right: ColumnRef }>;
  via: 'fk' | 'relation';
}

export interface QuerySpec {
  table: string;
  joins: JoinSpec[];
  filters: FilterSpec[];
  groupBy: ColumnRef[];
  timeBucket?: TimeBucketSpec;
  measures: MeasureSpec[];
  /** 逐行取数（「金额最高的 10 笔订单」）：非空时不聚合、不分组。 */
  detail?: ColumnRef[];
  orderBy?: OrderSpec;
  /** orderBy 指向原始列而非结果别名时使用（明细查询按度量列排序）。 */
  orderByRef?: ColumnRef;
  limit?: number;
}

export interface CompiledQuery {
  sql: string;
  /** SELECT 首个结果列的别名：时间桶为 period，否则 label。 */
  axisAlias: string;
  valueAliases: string[];
  /** 人可读的一句说明，用于执行过程与结论里的口径交代。 */
  notes: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `[from, to)` 半开区间：结束日推到次日零点，避免 BETWEEN 把边界日重复计入。
 * 与网关报表的 windowFilter 同一口径，离线问答和报表的数字才对得上。
 */
export function windowCondition(engine: Engine, ref: string, from: string, to: string): string {
  const next = new Date(`${to}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const exclusive = next.toISOString().slice(0, 10);
  if (!ISO_DATE.test(from) || !ISO_DATE.test(exclusive)) return '';
  return `${ref} >= ${quoteLiteral(from)} AND ${ref} < ${quoteLiteral(exclusive)}`;
}

function literal(value: string | number): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : quoteLiteral(String(value));
}

export interface JoinEdge {
  a: string;
  b: string;
  on: Array<{ a: ColumnRef; b: ColumnRef }>;
  via: 'fk' | 'relation';
}

/** 外键 + 用户在「Agent 上下文」里手工声明的关系，合成一张可连边表。 */
export function joinEdges(tables: TableInfo[], relations: Array<{ leftTable: string; leftColumn: string; rightTable: string; rightColumn: string }>): JoinEdge[] {
  const edges: JoinEdge[] = [];
  for (const table of tables) {
    for (const fk of table.foreignKeys ?? []) {
      const on = fkPairs(table.name, fk);
      if (on.length) edges.push({ a: table.name, b: fk.refTable, on, via: 'fk' });
    }
  }
  for (const relation of relations) {
    if (!relation.leftTable || !relation.rightTable || !relation.leftColumn || !relation.rightColumn) continue;
    edges.push({
      a: relation.leftTable,
      b: relation.rightTable,
      on: [{ a: { table: relation.leftTable, column: relation.leftColumn }, b: { table: relation.rightTable, column: relation.rightColumn } }],
      via: 'relation',
    });
  }
  return edges;
}

function fkPairs(table: string, fk: ForeignKeyInfo): Array<{ a: ColumnRef; b: ColumnRef }> {
  if (!fk.columns.length || !fk.refTable) return [];
  const refs = fk.refColumns.length ? fk.refColumns : fk.columns;
  return fk.columns
    .map((column, index) => ({ a: { table, column }, b: { table: fk.refTable, column: refs[index] ?? refs[0]! } }))
    .filter((pair) => Boolean(pair.a.column && pair.b.column));
}

/**
 * 无向图上的最短连接路径，最多 maxHops 条边。
 * 找不到返回 undefined：规划器宁可追问「用哪个字段连」，也不凭列名同音猜 JOIN——
 * 猜错的关系会静默放大或丢行，数字看着合理其实全错。
 */
export function findJoinPath(from: string, to: string, edges: JoinEdge[], maxHops = 2): JoinSpec[] | undefined {
  if (from === to) return [];
  const adjacency = new Map<string, JoinEdge[]>();
  for (const edge of edges) {
    for (const key of [edge.a, edge.b]) {
      const bucket = adjacency.get(key) ?? [];
      bucket.push(edge);
      adjacency.set(key, bucket);
    }
  }
  const queue: Array<{ table: string; path: JoinSpec[] }> = [{ table: from, path: [] }];
  const seen = new Set<string>([from]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.path.length >= maxHops) continue;
    for (const edge of adjacency.get(current.table) ?? []) {
      const forward = edge.a === current.table;
      const next = forward ? edge.b : edge.a;
      if (seen.has(next)) continue;
      const path: JoinSpec[] = [
        ...current.path,
        {
          left: current.table,
          right: next,
          on: edge.on.map((pair) => (forward ? { left: pair.a, right: pair.b } : { left: pair.b, right: pair.a })),
          via: edge.via,
        },
      ];
      if (next === to) return path;
      seen.add(next);
      queue.push({ table: next, path });
    }
  }
  return undefined;
}

/**
 * 编译成一条只读 SELECT。
 *
 * 结果列一律固定别名（period / label / label2 / value / value2…）：上层的答案模板和图表
 * 按别名取数，不必猜各方言返回的列名大小写。多表查询必须限定列名，
 * 因为 JOIN 后两张表往往都有 created_at。
 */
export function compileQuery(engine: Engine, spec: QuerySpec): CompiledQuery {
  const qualify = spec.joins.length > 0;
  const ref = (column: ColumnRef): string => (qualify ? `${quoteIdent(column.table, engine)}.${quoteIdent(column.column, engine)}` : quoteIdent(column.column, engine));

  const select: string[] = [];
  const groupBy: string[] = [];
  const valueAliases: string[] = [];
  const notes: string[] = [];
  let axisAlias = '';

  if (spec.detail?.length) {
    // 明细查询不聚合：「金额最高的 10 笔订单」要的是行，不是分组数字。排序列由 orderByRef 给出。
    for (const [index, column] of spec.detail.entries()) {
      const alias = index === 0 ? 'label' : `label${index + 1}`;
      if (!axisAlias) axisAlias = alias;
      select.push(`${ref(column)} AS ${quoteIdent(alias, engine)}`);
    }
  } else {
    if (spec.timeBucket) {
      const bucket = buildTimeBucketExpr(engine, spec.timeBucket.col.column, spec.timeBucket.grain, qualify ? spec.timeBucket.col.table : undefined);
      axisAlias = 'period';
      select.push(`${bucket} AS ${quoteIdent('period', engine)}`);
      groupBy.push(bucket);
      notes.push(`时间按${GRAIN_CN[spec.timeBucket.grain]}分桶`);
    }
    for (const [index, column] of spec.groupBy.entries()) {
      const alias = index === 0 ? 'label' : `label${index + 1}`;
      if (!axisAlias) axisAlias = alias;
      select.push(`${ref(column)} AS ${quoteIdent(alias, engine)}`);
      groupBy.push(ref(column));
    }
    for (const [index, measure] of spec.measures.entries()) {
      const alias = index === 0 ? 'value' : `value${index + 1}`;
      valueAliases.push(alias);
      select.push(`${measureExpr(engine, measure, ref)} AS ${quoteIdent(alias, engine)}`);
    }
    if (!select.length) {
      select.push(`COUNT(*) AS ${quoteIdent('value', engine)}`);
      valueAliases.push('value');
    }
  }

  const from = quoteIdent(spec.table, engine);
  const joins = spec.joins
    .map((join) => `INNER JOIN ${quoteIdent(join.right, engine)} ON ${join.on.map((pair) => `${ref(pair.left)} = ${ref(pair.right)}`).join(' AND ')}`)
    .join(' ');
  if (spec.joins.length) notes.push(`通过${spec.joins[0].via === 'fk' ? '外键' : '已登记的关联'}连接 ${spec.joins.map((join) => join.right).join('、')}`);

  const where = spec.filters
    .map((filter) => filterCondition(engine, filter, ref))
    .filter(Boolean)
    .join(' AND ');

  let sql = `SELECT ${select.join(', ')} FROM ${from}`;
  if (joins) sql += ` ${joins}`;
  if (where) sql += ` WHERE ${where}`;
  if (groupBy.length) sql += ` GROUP BY ${groupBy.join(', ')}`;

  const order = spec.orderBy ?? (spec.timeBucket ? { alias: 'period', desc: false } : valueAliases.length ? { alias: valueAliases[0]!, desc: true } : undefined);
  if (order) sql += ` ORDER BY ${spec.orderByRef ? ref(spec.orderByRef) : quoteIdent(order.alias, engine)}${order.desc ? ' DESC' : ' ASC'}`;
  if (spec.limit && spec.limit > 0) sql += ` LIMIT ${Math.floor(spec.limit)}`;

  return { sql, axisAlias: axisAlias || valueAliases[0] || 'value', valueAliases, notes };
}

const GRAIN_CN: Record<TimeBucketGrain, string> = { hour: '小时', day: '天', week: '周', month: '月', quarter: '季度', year: '年' };

function measureExpr(engine: Engine, measure: MeasureSpec, ref: (column: ColumnRef) => string): string {
  if (measure.fn === 'count') return measure.col ? `COUNT(${ref(measure.col)})` : 'COUNT(*)';
  if (measure.fn === 'count_distinct') return `COUNT(DISTINCT ${ref(measure.col!)})`;
  return `${measure.fn.toUpperCase()}(${ref(measure.col!)})`;
}

function filterCondition(engine: Engine, filter: FilterSpec, ref: (column: ColumnRef) => string): string {
  const column = ref(filter.col);
  const values = filter.values ?? [];
  if (filter.window) return windowCondition(engine, column, filter.window.from, filter.window.to);
  switch (filter.op) {
    case 'is_null':
      return `${column} IS NULL`;
    case 'not_null':
      return `${column} IS NOT NULL`;
    case 'between':
      return `${column} BETWEEN ${literal(values[0] ?? 0)} AND ${literal(values[1] ?? 0)}`;
    case 'in':
      return values.length ? `${column} IN (${values.map(literal).join(', ')})` : '';
    case 'like':
      return values.length ? `${column} LIKE ${quoteLiteral(`%${String(values[0])}%`)}` : '';
    case 'ne':
      return `${column} <> ${literal(values[0] ?? '')}`;
    case 'gt':
      return `${column} > ${literal(values[0] ?? '')}`;
    case 'gte':
      return `${column} >= ${literal(values[0] ?? '')}`;
    case 'lt':
      return `${column} < ${literal(values[0] ?? '')}`;
    case 'lte':
      return `${column} <= ${literal(values[0] ?? '')}`;
    default:
      return `${column} = ${literal(values[0] ?? '')}`;
  }
}
