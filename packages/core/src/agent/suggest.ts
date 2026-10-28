import type { AgentContextBundle, ColumnInfo, DatabaseSchema, TableInfo } from '../types';
import { applyTableVisibility, isColumnDisabled } from './context';

export type SuggestionKind = 'trend' | 'group' | 'topn' | 'quality' | 'relation';

export interface QuestionSuggestion {
  id: string;
  kind: SuggestionKind;
  /** 直接填入输入框的自然语言问题 */
  prompt: string;
  /** 为什么推荐这条（UI tooltip） */
  reason: string;
  table: string;
  database?: string;
}

export interface SuggestOptions {
  limit?: number;
  /** 最近查询里出现过的表名，命中的表优先推荐 */
  history?: string[];
  bundle?: AgentContextBundle;
  /** 每类最多保留几条，保证推荐结果的多样性 */
  maxPerKind?: number;
}

const TIME_TYPE = /(date|time|timestamp|year)/i;
const TIME_NAME = /(created?|updated?|deleted?|_at$|_time$|_date$|^date$|day|month|year|timestamp)/i;
const NUMERIC_TYPE = /(int|decimal|numeric|double|float|real|number|money|bit)/i;
const TEXT_TYPE = /(char|text|enum|uuid|json)/i;
const DIMENSION_NAME = /(status|state|type|kind|category|class|level|grade|channel|source|gender|flag|is_|enabled|region|city)/i;
/**
 * 标识符列虽然常是数值类型，但对它求和/趋势毫无业务意义
 * （demo 库里就会推出「近 12 个月 events 的 user_id 趋势」这种废话）。
 * 物理外键能覆盖的情况由 foreignKeyColumns 处理，这里兜住没有外键约束的库。
 */
const IDENTIFIER_NAME = /(^|_)(id|ids|uuid|guid|key|code|seq|sn|no)$|^id$/i;

const lower = (value: string) => value.trim().toLowerCase();

export function isTimeColumn(column: ColumnInfo): boolean {
  return TIME_TYPE.test(column.type) || TIME_NAME.test(column.name);
}

export function isMeasureColumn(column: ColumnInfo, foreignKeyColumns: Set<string>): boolean {
  if (column.primaryKey || column.autoIncrement) return false;
  if (foreignKeyColumns.has(lower(column.name))) return false;
  if (IDENTIFIER_NAME.test(column.name)) return false;
  if (isTimeColumn(column)) return false;
  return NUMERIC_TYPE.test(column.type);
}

export function isDimensionColumn(column: ColumnInfo): boolean {
  if (column.primaryKey || column.autoIncrement) return false;
  if (isTimeColumn(column)) return false;
  return TEXT_TYPE.test(column.type) || DIMENSION_NAME.test(column.name);
}

function foreignKeyColumnsOf(table: TableInfo): Set<string> {
  const set = new Set<string>();
  for (const fk of table.foreignKeys ?? []) for (const c of fk.columns) set.add(lower(c));
  return set;
}

function visibleColumns(table: TableInfo, bundle?: AgentContextBundle): ColumnInfo[] {
  const columns = table.columns ?? [];
  return bundle ? columns.filter((c) => !isColumnDisabled(bundle, table.name, c.name)) : columns;
}

/** 业务别名优先，退回物理名——推荐语直接说人话。 */
function tableLabel(bundle: AgentContextBundle | undefined, table: TableInfo): string {
  const alias = bundle?.tableMeta[lower(table.name)]?.alias?.trim();
  return alias || table.comment?.trim() || table.name;
}

function columnLabel(bundle: AgentContextBundle | undefined, table: TableInfo, column: ColumnInfo): string {
  const meta = bundle?.columnMeta[lower(table.name)]?.[column.name] ?? bundle?.columnMeta[lower(table.name)]?.[lower(column.name)];
  return meta?.alias?.trim() || column.comment?.trim() || column.name;
}

interface Candidate extends QuestionSuggestion {
  score: number;
}

/**
 * 基于已加载的 schema 生成推荐问题。
 *
 * 纯函数：不查库、不调模型，因此离线模式下同样可用，也不会产生任何 token 成本。
 * 只在「有把握」时推荐——找不到时间列就不编趋势问题，找不到外键就不编关联问题。
 */
export function suggestQuestions(schemas: DatabaseSchema[] | undefined, opts: SuggestOptions = {}): QuestionSuggestion[] {
  if (!schemas?.length) return [];
  const limit = Math.max(1, Math.min(12, opts.limit ?? 6));
  const maxPerKind = Math.max(1, opts.maxPerKind ?? 2);
  const bundle = opts.bundle;
  const history = new Set((opts.history ?? []).map(lower));
  const candidates: Candidate[] = [];

  for (const schema of schemas) {
    const tables = applyTableVisibility(schema.tables ?? [], bundle).filter((t) => t.type === 'table' && (t.columns?.length ?? 0) > 0);
    for (const table of tables) {
      const columns = visibleColumns(table, bundle);
      if (!columns.length) continue;
      const fkColumns = foreignKeyColumnsOf(table);
      const tLabel = tableLabel(bundle, table);
      // 用户显式标注过、或最近查询里出现过的表，说明它在业务里更重要
      const boost = (history.has(lower(table.name)) ? 0.15 : 0) + (bundle?.tableMeta[lower(table.name)] ? 0.1 : 0);
      const push = (kind: SuggestionKind, prompt: string, reason: string, score: number, refTable?: string) => {
        candidates.push({ id: `${kind}:${schema.name}:${table.name}:${refTable ?? ''}:${prompt.length}`, kind, prompt, reason, table: table.name, database: schema.name, score: score + boost });
      };

      const time = columns.find(isTimeColumn);
      const measure = columns.find((c) => isMeasureColumn(c, fkColumns));
      const dimension = columns.find(isDimensionColumn);

      if (time) {
        push(
          'trend',
          measure
            ? `近 12 个月 ${tLabel} 的 ${columnLabel(bundle, table, measure)} 趋势`
            : `近 12 个月 ${tLabel} 的记录数趋势`,
          `${table.name} 有时间列 ${time.name}${measure ? `、数值列 ${measure.name}` : ''}`,
          measure ? 0.9 : 0.75,
        );
      }
      if (dimension) {
        push(
          'group',
          measure
            ? `按 ${columnLabel(bundle, table, dimension)} 统计 ${tLabel} 的 ${columnLabel(bundle, table, measure)} 合计`
            : `按 ${columnLabel(bundle, table, dimension)} 统计 ${tLabel} 的记录数分布`,
          `${table.name}.${dimension.name} 适合做分组维度`,
          measure ? 0.85 : 0.7,
        );
        push('quality', `检查 ${tLabel} 的 ${columnLabel(bundle, table, dimension)} 空值、空串与重复情况`, `${table.name}.${dimension.name} 的取值质量`, 0.55);
      }
      for (const fk of (table.foreignKeys ?? []).slice(0, 3)) {
        if (bundle && (isColumnDisabled(bundle, table.name, fk.columns[0] ?? '') || fk.columns.some((c) => isColumnDisabled(bundle, table.name, c)))) continue;
        const refLabel = bundle?.tableMeta[lower(fk.refTable)]?.alias?.trim() || fk.refTable;
        push('topn', `${refLabel} 中关联 ${tLabel} 数量最多的前 10 个`, `${table.name}.${fk.columns.join(',')} → ${fk.refTable} 的外键`, 0.8, fk.refTable);
        push('relation', `检查 ${tLabel} 与 ${refLabel} 的关联完整性（是否存在孤儿记录）`, `外键 ${fk.name ?? fk.columns.join(',')}`, 0.6, fk.refTable);
      }
    }
  }

  if (!candidates.length) return [];

  // 先按分数排序，再按种类轮转挑选，避免 6 条全是同一类问题
  candidates.sort((a, b) => b.score - a.score || a.prompt.localeCompare(b.prompt));
  const perKind = new Map<SuggestionKind, number>();
  const byKind = new Map<SuggestionKind, Candidate[]>();
  for (const c of candidates) {
    const used = perKind.get(c.kind) ?? 0;
    if (used >= maxPerKind) continue;
    perKind.set(c.kind, used + 1);
    byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  }
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  let added = true;
  while (picked.length < limit && added) {
    added = false;
    for (const list of byKind.values()) {
      const next = list.shift();
      if (!next || seen.has(next.prompt)) continue;
      seen.add(next.prompt);
      picked.push(next);
      added = true;
      if (picked.length >= limit) break;
    }
  }
  return picked
    .sort((a, b) => b.score - a.score)
    .map(({ id, kind, prompt, reason, table, database }) => ({ id, kind, prompt, reason, table, database }));
}

/** 从 SQL 文本里粗提表名，用于把「最近查过的表」加权到推荐前列。 */
export function tablesFromSql(sql: string): string[] {
  if (!sql) return [];
  const out = new Set<string>();
  const re = /\b(?:from|join|update|into|table)\s+[`"[]?([A-Za-z_][A-Za-z0-9_$]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) out.add(match[1].toLowerCase());
  return [...out];
}

const KIND_LABEL: Record<SuggestionKind, string> = {
  trend: '趋势',
  group: '分组统计',
  topn: 'Top N',
  quality: '数据质量',
  relation: '关联完整性',
};

export function suggestionLabel(kind: SuggestionKind): string {
  return KIND_LABEL[kind];
}

/**
 * 追问建议：基于本轮真正调用过的工具与涉及的表生成，
 * 对所有 provider 都成立（不依赖模型输出特定标签），且零 token 成本。
 */
export function suggestFollowUps(input: {
  schemas: DatabaseSchema[] | undefined;
  tables: string[];
  usedTools: string[];
  bundle?: AgentContextBundle;
  limit?: number;
}): QuestionSuggestion[] {
  const wanted = new Set(input.tables.map(lower));
  if (!wanted.size || !input.schemas?.length) return [];
  const scoped: DatabaseSchema[] = input.schemas.map((s) => ({ ...s, tables: (s.tables ?? []).filter((t) => wanted.has(lower(t.name))) }));
  const base = suggestQuestions(scoped, { bundle: input.bundle, limit: Math.max(3, input.limit ?? 3), maxPerKind: 1 });
  // 已经查过质量/审计的，就别再推荐同类问题
  const used = new Set(input.usedTools);
  const filtered = base.filter((s) => {
    if (s.kind === 'quality' && (used.has('check_data_quality') || used.has('audit_database'))) return false;
    if (s.kind === 'trend' && used.has('render_chart')) return false;
    return true;
  });
  return (filtered.length ? filtered : base).slice(0, input.limit ?? 3);
}
