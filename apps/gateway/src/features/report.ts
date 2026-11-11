import { buildCount, buildTimeBucketExpr, createProvider, engineMeta, quoteIdent, type ConnectionConfig, type TableInfo } from '@aidb/core';
import type {
  CommandSourceInput,
  ReportBlock,
  ReportEvidence,
  ReportDelta,
  ReportExecutive,
  ReportLayout,
  ReportMetric,
  ReportSection,
  ReportSourceRef,
  ReportSpec,
  ResolvedPeriod,
  TimeWindow,
} from '@aidb/core';
import { chainWindow, computeMetricDelta, formatPeriodForReader, precedingEqualWindow, resolvePeriod, windowDays, yearAgoWindow } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';
import { flattenTables, type TableFact } from './databaseBrief';
import { businessTimeOf, columnsOf, dimensionLabel, dimensionOf, factScore, moneyOf, softDeleteFilter, tableLabel, tableRef } from './dashboardGenerate';

/**
 * 无模型时可用的业务名：英文库名直译成中文，读者才不会看到「orders单量」。
 * 只覆盖高频实体；有表注释或 AI_DB.md 时 tableLabel 已经给出更好的名字。
 *
 * 计量的说法必须跟着实体变。以前所有事实表都写成「XX单量 / 笔」，
 * 用户表就变成了「用户单量 1,200 笔」——业务读者一眼就能看出这不是人写的。
 */
interface EntityShape {
  zh: string;
  /** 计数指标的名字与单位，例如「订单量 / 笔」「活跃用户 / 人」。 */
  count: { label: string; unit: string };
  money: string;
}

const ENTITY_SHAPES: Array<{ pattern: RegExp } & EntityShape> = [
  { pattern: /^(orders?|order_info|trade_orders?|order_items?)$/i, zh: '订单', count: { label: '订单量', unit: '笔' }, money: '订单金额' },
  { pattern: /^(users?|user_info|members?)$/i, zh: '用户', count: { label: '活跃用户', unit: '人' }, money: '用户消费额' },
  { pattern: /^(refunds?|refund_orders?)$/i, zh: '退款', count: { label: '退款量', unit: '笔' }, money: '退款金额' },
  { pattern: /^(payments?|pay_orders?|transactions?)$/i, zh: '支付', count: { label: '支付笔数', unit: '笔' }, money: '支付金额' },
  { pattern: /^(products?|items?|skus?|goods)$/i, zh: '商品', count: { label: '商品数', unit: '个' }, money: '商品金额' },
  { pattern: /^(customers?|clients?)$/i, zh: '客户', count: { label: '客户数', unit: '位' }, money: '客户金额' },
  { pattern: /^(invoices?)$/i, zh: '发票', count: { label: '开票量', unit: '张' }, money: '开票金额' },
  { pattern: /^(shipments?|deliver(y|ies)|logistics)$/i, zh: '履约', count: { label: '履约单量', unit: '单' }, money: '履约金额' },
  { pattern: /^(carts?)$/i, zh: '购物车', count: { label: '加购量', unit: '次' }, money: '加购金额' },
  { pattern: /^(tickets?|issues?)$/i, zh: '工单', count: { label: '工单量', unit: '单' }, money: '工单金额' },
  { pattern: /^(visits?|sessions?|page_?views?)$/i, zh: '访问', count: { label: '访问量', unit: '次' }, money: '访问金额' },
  { pattern: /^(complaints?|reports?)$/i, zh: '投诉', count: { label: '投诉量', unit: '件' }, money: '投诉金额' },
];

function entityOf(fact: TableFact): EntityShape | undefined {
  const base = tableLabel(fact);
  return ENTITY_SHAPES.find((entry) => entry.pattern.test(base) || entry.pattern.test(fact.name));
}

function businessLabel(fact: TableFact): string {
  return entityOf(fact)?.zh ?? tableLabel(fact);
}

/** 计数指标名与单位；未识别的实体退回中性的「记录数 / 条」。 */
function countMeasure(fact: TableFact): { label: string; unit: string } {
  const entity = entityOf(fact);
  if (entity) return entity.count;
  return { label: `${tableLabel(fact)}记录数`, unit: '条' };
}

function moneyMeasure(fact: TableFact): string {
  return entityOf(fact)?.money ?? `${tableLabel(fact)}金额`;
}

export interface ReportInput {
  sources: CommandSourceInput[];
  topic: string;
  tables?: string[];
  /** 表单里的时间范围；缺省时按主题的「本周/上月」等短语解析，再兜底近 30 天。 */
  period?: unknown;
  audience?: 'executive' | 'business' | 'technical';
  /** 已解析好的时间窗（Agent 与确定性两条路径共用同一份解析结果）。 */
  resolvedPeriod?: ResolvedPeriod;
  /**
   * 读者自己给的参照值，例如「订单量 5000」。
   * 环比/同比只能回答「和过去比」，回答不了「和计划比」。
   */
  target?: string;
}

/**
 * 解析读者给的参照值：取第一个数字做值，它前面的文字做指标名。
 * 「订单量 5000」「日均 120 笔」「5000」都能解析；解析不出数字就当没填。
 */
export function parseTarget(value: string | undefined): { label?: string; value: number } | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const match = /(-?\d[\d,]*(?:\.\d+)?)/.exec(text.replace(/[，,](?=\d{3}\b)/g, ''));
  if (!match) return undefined;
  const numeric = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return undefined;
  const label = text.slice(0, match.index).replace(/[：:=\s]+$/u, '').trim();
  return { ...(label ? { label } : {}), value: numeric };
}

interface SourceData {
  ref: ReportSourceRef;
  conn: ConnectionConfig;
  tables: Array<{ name: string; columns: number; rows: number | null }>;
  totalRows: number;
  tableCount: number;
  /** 该源的确定性业务指标；一张合适的表都没找到时为空。 */
  facts: BusinessFact[];
  /** 该源的确定性趋势/分布图。 */
  series: BusinessSeries[];
  /** 口径说明：哪个时间列、哪个金额列、是否剔除软删除。 */
  calibers: string[];
  /** 趋势序列上的异常点与口径风险提示。 */
  risks: string[];
  /** 环比变化的维度归因。 */
  attributions: Attribution[];
}

/** 一条确定性业务指标：本期值 + 基线值，差值由应用算。 */
interface BusinessFact {
  label: string;
  value: number;
  unit?: string;
  baseline?: number;
  baselineLabel?: string;
  goodDirection?: 'up' | 'down' | 'neutral';
  definition: string;
  tableLabel: string;
  /** 产生该数字的查询；确定性报告同样可追溯。 */
  ref?: string;
  /** 基线数字来自哪次查询。 */
  baselineRef?: string;
  /** 环比之外的补充基线（同比、本期未结束时的同长切片）。 */
  alternatives?: Array<{ label: string; value?: number; delta?: ReportDelta }>;
  /** 该事实所属的事实表与时间列：归因与异常检测要按它再查一次。 */
  table: string;
  timeColumn: string;
  dimension?: string;
  dimensionLabel?: string;
  /** 与本期同口径的过滤条件（不含时间边界）。 */
  filter: string;
  /** 计数用的聚合表达式，例如 COUNT(*)。 */
  measure: string;
}

/** 一条确定性图表数据。 */
interface BusinessSeries {
  title: string;
  chartType: 'line' | 'bar' | 'pie' | 'stacked';
  points: Array<{ label: string; value: number }>;
  definition: string;
  ref?: string;
}

/** 归因取维度值的上限：高基数维度不能把整张表拉回内存。 */
const DIMENSION_LIMIT = 50;

/** 环比变化按维度拆开：总量涨跌只有拆到维度上才可解释。 */
interface Attribution {
  label: string;
  dimensionLabel: string;
  dimension: string;
  movers: Array<{ value: string; current: number; baseline: number; delta: number; share: number }>;
  totalDelta: number;
  /** 维度值撞到 DIMENSION_LIMIT：合计只覆盖取回的那部分，必须在读者面前承认。 */
  capped: boolean;
  ref?: string;
  baselineRef?: string;
}

/** 环比变化按主维度拆开。两个窗口共用同一条过滤模板，只换时间边界。 */
async function attributionOf(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  database: string | undefined,
  fact: BusinessFact,
  period: ResolvedPeriod,
  topN = 6,
  trace?: EvidenceTrace,
): Promise<Attribution | undefined> {
  const previous = period.previous;
  if (!previous || !fact.dimension) return undefined;
  const engine = conn.engine;
  const dim = quoteIdent(fact.dimension, engine);
  const windowOf = (start: string, end: string): string => {
    const bounds = windowFilter(fact.timeColumn, engine, start, end);
    const clauses = [fact.filter.replace(/^WHERE\s+/i, '').trim(), bounds].filter(Boolean);
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  };
  const sqlOf = (start: string, end: string) =>
    `SELECT ${dim} AS dim_value, ${fact.measure} AS metric FROM ${fact.table} ${windowOf(start, end)} GROUP BY dim_value ORDER BY metric DESC LIMIT ${DIMENSION_LIMIT}`;
  const [current, baseline] = await Promise.all([
    rowsQuery(manager, conn, database, sqlOf(period.current.from, period.current.to), 50, trace),
    rowsQuery(manager, conn, database, sqlOf(previous.from, previous.to), 50, trace),
  ]);
  if (!current.rows.length && !baseline.rows.length) return undefined;
  const merged = new Map<string, { current: number; baseline: number }>();
  for (const row of current.rows) {
    const key = String(row[0] ?? '—');
    const value = Number(row[1]);
    if (!Number.isFinite(value)) continue;
    const entry = merged.get(key) ?? { current: 0, baseline: 0 };
    entry.current += value;
    merged.set(key, entry);
  }
  for (const row of baseline.rows) {
    const key = String(row[0] ?? '—');
    const value = Number(row[1]);
    if (!Number.isFinite(value)) continue;
    const entry = merged.get(key) ?? { current: 0, baseline: 0 };
    entry.baseline += value;
    merged.set(key, entry);
  }
  const rows = [...merged.entries()].map(([value, entry]) => ({ value, ...entry, delta: entry.current - entry.baseline }));
  const totalDelta = rows.reduce((sum, row) => sum + row.delta, 0);
  if (!rows.length || totalDelta === 0) return undefined;
  const absTotal = rows.reduce((sum, row) => sum + Math.abs(row.delta), 0) || 1;
  return {
    label: fact.label,
    dimensionLabel: fact.dimensionLabel ?? fact.dimension,
    dimension: fact.dimension,
    movers: [...rows]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, topN)
      .map((row) => ({ ...row, share: (Math.abs(row.delta) / absTotal) * 100 })),
    totalDelta,
    // 两条 SQL 都带 LIMIT 50：维度值更多时被砍掉的那些不进合计。SQL 层已经限流，
    // 批次不会标记 truncated，只能自己说出来——否则「整体变化」会被当成全量。
    capped: current.rows.length >= DIMENSION_LIMIT || baseline.rows.length >= DIMENSION_LIMIT,
    ...(current.ref ? { ref: current.ref } : {}),
    ...(baseline.ref ? { baselineRef: baseline.ref } : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 归因表：读「对整体变化的贡献」而不是各自涨跌幅——小体量的大涨会骗人。 */
function attributionTable(attribution: Attribution): ReportBlock {
  const refs = [attribution.ref, attribution.baselineRef].filter((ref): ref is string => Boolean(ref));
  return {
    kind: 'table',
    title: `${attribution.label}：环比变化主要来自哪里（按 ${attribution.dimensionLabel}）`,
    columns: [attribution.dimensionLabel, '本期', '上期', '变化', '占整体变化'],
    measureColumns: ['本期', '上期', '变化', '占整体变化'],
    rows: attribution.movers.map((mover) => [mover.value, round2(mover.current), round2(mover.baseline), round2(mover.delta), `${mover.share.toFixed(1)}%`]),
    ...(attribution.ref ? { resultRef: attribution.ref } : {}),
    ...(refs.length ? { resultRefs: refs } : {}),
    note: `整体变化 ${signed(attribution.totalDelta)}；占比 = 该项变化量 ÷ 各项变化量绝对值之和，正负项都计入分母。${
      attribution.capped ? `维度值超过 ${DIMENSION_LIMIT} 个，未取回的部分不计入整体变化。` : ''
    }`,
  };
}

/** 偏离均值多少个标准差。少于 4 个样本时标准差不稳定，宁可不报。 */
function detectAnomalies(points: Array<{ label: string; value: number }>, threshold = 2): Array<{ label: string; value: number; mean: number; deviation: number }> {
  const values = points.map((point) => point.value);
  if (values.length < 4) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  if (!(sd > 0)) return [];
  return points
    .map((point) => ({ label: point.label, value: point.value, mean, deviation: (point.value - mean) / sd }))
    .filter((point) => Math.abs(point.deviation) >= threshold)
    .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
    .slice(0, 3);
}

async function countRows(manager: ConnectionManager, conn: ConnectionConfig, table: TableInfo, database?: string): Promise<number | null> {
  try {
    const batch = await manager.query(conn.id, buildCount(conn.engine, table.name, connectionSchema(conn, table)), {
      database,
      maxRows: 1,
      allowMulti: false,
      autoLimit: false,
      actor: 'user',
    });
    const value = batch.sets[0]?.rows[0]?.[0];
    return value === undefined || value === null ? null : Number(value);
  } catch {
    return null;
  }
}

function layoutFor(sources: number, topic: string): ReportLayout {
  if (sources > 1 && /对比|比较|compare/i.test(topic)) return 'comparison';
  if (sources > 1 && /合并|汇总|合计|总体|加起来|sum/i.test(topic)) return 'merged';
  if (sources > 1 && /综合|周报|月报|报告|全面|overview/i.test(topic)) return 'mixed';
  return 'sections';
}

function rowsTable(data: SourceData): ReportBlock {
  return {
    kind: 'table',
    title: '表与行数',
    columns: ['表', '列数', '行数'],
    rows: data.tables.map((table) => [table.name, table.columns, table.rows]),
    note: '数据规模盘点：与业务口径无关，用于核对库内对象。',
  };
}

/** 时间窗边界必须是 ISO 日期，否则不能拼进 SQL。 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `[from, to)` 的半开区间条件：把 to 推到次日零点，避免 BETWEEN 把边界日重复计入。 */
function windowFilter(column: string, engine: ConnectionConfig['engine'], from: string, to: string): string {
  const col = quoteIdent(column, engine);
  const next = new Date(`${to}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const exclusive = next.toISOString().slice(0, 10);
  if (!ISO_DATE.test(from) || !ISO_DATE.test(exclusive)) return '';
  return `${col} >= '${from}' AND ${col} < '${exclusive}'`;
}

/**
 * 证据登记器：记下「这个数字是哪条 SQL 查出来的」。
 * 确定性路径同样要有证据链——没开 AI 时，读者若不能复核，就只能选择相信。
 */
interface EvidenceTrace {
  record(entry: Omit<ReportEvidence, 'ref' | 'ranAt'>): string;
}

function newTrace(): { trace: EvidenceTrace; dump: () => Record<string, ReportEvidence> } {
  const map = new Map<string, ReportEvidence>();
  let seq = 0;
  return {
    trace: {
      record(entry) {
        seq += 1;
        const ref = `q${seq}`;
        map.set(ref, { ref, ranAt: new Date().toISOString(), ...entry });
        return ref;
      },
    },
    dump: () => Object.fromEntries(map),
  };
}

/** 跑一条只读聚合，取第一行第一列。失败返回 null，不拖垮整份报告。 */
async function scalarQuery(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  database: string | undefined,
  sql: string,
  trace?: EvidenceTrace,
): Promise<{ value: number | null; ref?: string }> {
  try {
    const batch = await manager.query(conn.id, sql, { database, maxRows: 5, allowMulti: false, autoLimit: false, actor: 'user' });
    const value = batch.sets[0]?.rows[0]?.[0];
    const numeric = Number(value);
    const clean = value === null || value === undefined || !Number.isFinite(numeric) ? null : numeric;
    if (!trace) return { value: clean };
    return { value: clean, ref: trace.record({ tool: 'run_sql', sql, rowCount: batch.sets[0]?.rowCount, durationMs: batch.durationMs }) };
  } catch {
    return { value: null };
  }
}

/** 跑一条聚合，取多行多列。 */
async function rowsQuery(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  database: string | undefined,
  sql: string,
  maxRows = 24,
  trace?: EvidenceTrace,
): Promise<{ rows: Array<Array<unknown>>; ref?: string }> {
  try {
    // 报告里的分组聚合可能命中超大表；把行数上限下推成 LIMIT，别把整组结果拉回来。
    const batch = await manager.query(conn.id, sql, { database, maxRows, allowMulti: false, autoLimit: true, actor: 'user' });
    const rows = batch.sets[0]?.rows ?? [];
    if (!trace) return { rows };
    return {
      rows,
      ref: trace.record({
        tool: 'run_sql',
        sql,
        rowCount: batch.sets[0]?.rowCount ?? rows.length,
        truncated: batch.sets[0]?.truncated,
        durationMs: batch.durationMs,
      }),
    };
  } catch {
    return { rows: [] };
  }
}

/** 退款 / 投诉这类表，数量上涨是坏消息——上色前先看业务方向。 */
const NEGATIVE_EVENT = /退款|退货|取消|失败|异常|逾期|投诉|差评|流失|超时|欠款|坏账/;

function inferGoodDirection(label: string): 'up' | 'down' {
  return NEGATIVE_EVENT.test(label) ? 'down' : 'up';
}

const DATE_LIKE_NAME = /(date|Date|time|Time|day|Day|month|Month|year|Year|_at$|At$|日期|时间|日|月)/;

/**
 * 报告用的时间列必须真能当时钟。共享的 businessTimeOf 会在纯文本列里挑一个兜底
 * （出图建议够用），但报告拿它做区间过滤，把 name 当成日期会算出全 0 的假指标。
 */
function factTimeOf(fact: TableFact): string | undefined {
  const column = businessTimeOf(fact);
  if (!column) return undefined;
  const info = columnsOf(fact).find((item) => item.name === column);
  const type = info?.type ?? '';
  if (/(date|datetime|timestamp|time)\b/i.test(type)) return column;
  if (/(char|text|varchar|string)/i.test(type) && DATE_LIKE_NAME.test(column)) return column;
  return undefined;
}

/**
 * 确定性业务指标：在没有可用模型时，报告也必须长得像一份业务报表，
 * 而不是一份 DBA 自检清单。策略与仪表板的确定性候选一致——
 * 以「钱 + 时间 + 维度」挑事实表，取本期/上期两个口径相同的聚合值。
 */
async function businessFactsOf(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  database: string | undefined,
  facts: TableFact[],
  period: ResolvedPeriod,
  limit = 4,
  trace?: EvidenceTrace,
  target?: { label?: string; value: number },
): Promise<{ facts: BusinessFact[]; series: BusinessSeries[]; calibers: string[]; risks: string[]; attributions: Attribution[] }> {
  const engine = conn.engine;
  const out: BusinessFact[] = [];
  const series: BusinessSeries[] = [];
  const calibers: string[] = [];
  const usable = facts
    .filter((fact) => (fact.table.rowEstimate ?? 0) > 0 && factTimeOf(fact))
    .sort((a, b) => factScore(b, []) - factScore(a, []))
    .slice(0, 6);
  const { from, to } = period.current;
  const previous = period.previous;
  // 基线读法直接取解析器的标签（已含「环比 / 同比」），不要再加前缀，否则会变成「环比 环比 上期」。
  const baselineLabel = previous ? previous.label.split('（')[0]?.trim() : undefined;
  const risks: string[] = [];
  const attributions: Attribution[] = [];
  let compositionTried = false;
  let attributionDone = false;
  /** 读者填的参照值只贴到名字对得上的指标上；对不上就不贴，绝不硬套到第一个指标。 */
  const withTarget = (
    list: Array<{ label: string; value?: number; delta?: ReportDelta }>,
    metricLabel: string,
    currentValue: number,
  ): Array<{ label: string; value?: number; delta?: ReportDelta }> => {
    if (!target) return list;
    if (target.label && !(metricLabel.includes(target.label) || target.label.includes(metricLabel))) return list;
    if (list.some((item) => item.label.includes('目标'))) return list;
    return [...list, { label: target.label ? `目标 ${target.label}` : '目标', value: target.value, delta: computeMetricDelta(currentValue, target.value) }];
  };
  // 每条报告为「多一条基线」额外发的查询数：值得多问一句，但不值得把生产库打满。
  let altBudget = 4;
  const currentDays = windowDays(from, to);
  const baselineDays = previous ? windowDays(previous.from, previous.to) : undefined;
  const primaryWindow = previous ? `${previous.from}~${previous.to}` : '';
  // 本期未走完 / 两期天数不等时，直接环比会凭空造出涨跌，补两个不依赖长度的读法。
  const sliceWindow = precedingEqualWindow(period);
  const yoyWindow = yearAgoWindow(period.current);
  const chainView = period.baselineKind === 'year' ? chainWindow(period.current) : undefined;

  for (const fact of usable) {
    if (out.length >= limit && series.length >= 2) break;
    const time = factTimeOf(fact);
    if (!time) continue;
    const table = tableRef(fact, engine);
    const label = businessLabel(fact);
    const money = moneyOf(fact);
    const softDelete = softDeleteFilter(fact, engine);

    /** 同一张表、同一软删除口径，只换时间窗——本期与上期必须严格同口径。 */
    const whereFor = (start: string, end: string): string => {
      const bounds = windowFilter(time, engine, start, end);
      const clauses = [softDelete.replace(/^WHERE\s+/i, '').trim(), bounds].filter(Boolean);
      return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    };
    const aggregate = (fn: string, start: string, end: string) =>
      scalarQuery(manager, conn, database, `SELECT ${fn} FROM ${table} ${whereFor(start, end)}`, trace);

    /**
     * 环比之外的补充基线：同比、前一区间，以及两期天数不等时的日均口径。
     * 只有一条基线的报告分不清「比上月少」是趋势还是季节，也分不清是不是本月没过完。
     */
    const alternativesFor = async (
      measure: string,
      scale: (value: number) => number,
      currentValue: number,
      baselineValue?: number,
    ): Promise<Array<{ label: string; value?: number; delta?: ReportDelta }>> => {
      const out: Array<{ label: string; value?: number; delta?: ReportDelta }> = [];
      let windowBaselines = 0;
      if (
        previous &&
        baselineValue !== undefined &&
        baselineDays !== undefined &&
        baselineDays !== currentDays &&
        baselineValue > 0
      ) {
        const perDay = (value: number, days: number) => Math.round((value / days) * 100) / 100;
        const currentPerDay = perDay(currentValue, currentDays);
        const baselinePerDay = perDay(baselineValue, baselineDays);
        out.push({
          label: `日均口径（本期 ${currentDays} 天 / 基线 ${baselineDays} 天）`,
          value: currentPerDay,
          delta: computeMetricDelta(currentPerDay, baselinePerDay),
        });
      }
      const seen = new Set<string>([primaryWindow]);
      for (const window of [sliceWindow, yoyWindow, chainView]) {
        if (!window || altBudget <= 0) continue;
        altBudget -= 1;
        const key = `${window.from}~${window.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // 窗口型基线最多两条：同长切片与同比（或环比视角），再多就是在重复问同一个问题。
        if (windowBaselines >= 2) break;
        windowBaselines += 1;
        const hit = await scalarQuery(manager, conn, database, `SELECT ${measure} FROM ${table} ${whereFor(window.from, window.to)}`, trace);
        // 查不到或为 0 一律跳过：那里多半根本没有那一年的数据，不是真的腰斩。
        if (hit.value === null || hit.value === 0) continue;
        const value = scale(hit.value);
        out.push({
          label: window.label.split('（')[0]?.trim() ?? '对比',
          value,
          delta: computeMetricDelta(currentValue, value),
        });
      }
      return out;
    };

    const counted = await aggregate('COUNT(*)', from, to);
    if (counted.value === null) continue;
    const prior = previous ? await aggregate('COUNT(*)', previous.from, previous.to) : undefined;
    const count = countMeasure(fact);
    out.push({
      label: count.label,
      value: counted.value,
      unit: count.unit,
      goodDirection: inferGoodDirection(label),
      ...(counted.ref ? { ref: counted.ref } : {}),
      ...(prior?.value === undefined || prior.value === null ? {} : { baseline: prior.value, baselineLabel, ...(prior.ref ? { baselineRef: prior.ref } : {}) }),
      alternatives: withTarget(
        await alternativesFor('COUNT(*)', (value) => value, counted.value, prior?.value ?? undefined),
        count.label,
        counted.value,
      ),
      table,
      timeColumn: time,
      filter: softDelete,
      measure: 'COUNT(*)',
      definition: `${label}：按 ${time} 统计 ${from} ~ ${to} 的记录数${softDelete ? '（已按软删除过滤）' : ''}`,
      tableLabel: label,
    });
    calibers.push(`${label} 时间口径：${time}`);

    if (money) {
      const sum = `SUM(${quoteIdent(money, engine)})`;
      const amountCurrent = await aggregate(sum, from, to);
      if (amountCurrent.value !== null) {
        const amountPrevious = previous ? await aggregate(sum, previous.from, previous.to) : undefined;
        // 以「分」存储的金额在这里统一换算成元，并在口径里写明——业务读者拿到的是元，不是分。
        const cents = /(_cents?|cents?)$/i.test(money);
        const scale = (value: number) => Math.round(value * (cents ? 0.01 : 1) * 100) / 100;
        out.push({
          label: moneyMeasure(fact),
          value: scale(amountCurrent.value),
          unit: cents ? '元' : undefined,
          goodDirection: inferGoodDirection(label),
          ...(amountCurrent.ref ? { ref: amountCurrent.ref } : {}),
          ...(amountPrevious?.value === undefined || amountPrevious.value === null
            ? {}
            : { baseline: scale(amountPrevious.value), baselineLabel, ...(amountPrevious.ref ? { baselineRef: amountPrevious.ref } : {}) }),
          alternatives: withTarget(
            await alternativesFor(sum, scale, scale(amountCurrent.value), amountPrevious?.value === undefined || amountPrevious.value === null ? undefined : scale(amountPrevious.value)),
            moneyMeasure(fact),
            scale(amountCurrent.value),
          ),
          table,
          timeColumn: time,
          filter: softDelete,
          measure: sum,
          definition: `${label}：SUM(${money})${cents ? '／100（元）' : ''}，${from} ~ ${to}`,
          tableLabel: label,
        });
        calibers.push(`${label} 金额口径：SUM(${money})${cents ? '，按 100 分 = 1 元换算' : ''}`);
      }
    }

    if (!series.length) {
      const bucket = buildTimeBucketExpr(engine, time, 'month');
      const trend = await rowsQuery(
        manager,
        conn,
        database,
        `SELECT ${bucket} AS period, COUNT(*) AS cnt FROM ${table} ${softDelete} GROUP BY period ORDER BY period DESC LIMIT 12`,
        12,
        trace,
      );
      const points = trend.rows
        .reverse()
        .map((row) => ({ label: String(row[0] ?? '—'), value: Number(row[1]) }))
        .filter((point) => Number.isFinite(point.value) && !/^\s*$/.test(point.label));
      if (points.length >= 3) {
        series.push({ title: `${label}月度趋势`, chartType: 'line', points, definition: `${label}：按 ${time} 分月统计记录数`, ...(trend.ref ? { ref: trend.ref } : {}) });
      }
    }

    // 一张低基数维度构成：有明确业务维度时，报告应能回答「占比」而不是只有时间趋势。
    // 先查 9 行判断是否真的是一个完整整体；超过 8 类就不画饼图，避免把 Top 8 伪装成全部。
    if (!compositionTried) {
      const dim = dimensionOf(fact, [time, ...(money ? [money] : [])]);
      if (dim) {
        compositionTried = true;
        const grouped = await rowsQuery(
          manager,
          conn,
          database,
          `SELECT ${quoteIdent(dim, engine)} AS dim_value, COUNT(*) AS cnt FROM ${table} ${whereFor(from, to)} GROUP BY dim_value ORDER BY cnt DESC LIMIT 9`,
          9,
          trace,
        );
        const composition = grouped.rows;
        const points = composition
          .slice(0, 8)
          .map((row) => ({ label: String(row[0] ?? '—'), value: Number(row[1]) }))
          .filter((point) => point.label.trim() && Number.isFinite(point.value) && point.value >= 0);
        if (composition.length <= 8 && points.length >= 3) {
          const dimText = dimensionLabel(fact, dim);
          series.push({
            title: `${label}${dimText}构成`,
            chartType: 'pie',
            points,
            definition: `${label}：${from} ~ ${to} 按 ${dim} 分组统计记录数`,
            ...(grouped.ref ? { ref: grouped.ref } : {}),
          });
          calibers.push(`${label} 构成口径：按 ${dim} 分组`);
        }
      }
    }

    // 环比变化按维度拆开：总量涨跌只有落到维度上才可解释、可行动。
    if (!attributionDone) {
      const countFact = out.find((item) => item.tableLabel === label && item.baseline !== undefined);
      const dim = dimensionOf(fact, [time, ...(money ? [money] : [])]);
      if (countFact && dim) {
        attributionDone = true;
        countFact.dimension = dim;
        countFact.dimensionLabel = dimensionLabel(fact, dim);
        const attribution = await attributionOf(manager, conn, database, countFact, period, 6, trace).catch(() => undefined);
        if (attribution) attributions.push(attribution);
      }
    }

    if (series.length < 2) {
      const daily = await rowsQuery(
        manager,
        conn,
        database,
        `SELECT ${buildTimeBucketExpr(engine, time, 'day')} AS bucket, COUNT(*) AS cnt FROM ${table} ${whereFor(from, to)} GROUP BY bucket ORDER BY cnt DESC LIMIT 8`,
        8,
        trace,
      );
      const distribution = daily.rows;
      const points = distribution
        .map((row) => ({ label: String(row[0] ?? '—'), value: Number(row[1]) }))
        .filter((point) => Number.isFinite(point.value) && !/^\s*$/.test(point.label));
      if (points.length >= 2) {
        series.push({ title: `${label}：按天分布`, chartType: 'bar', points, definition: `${label}：${from} ~ ${to} 内按 ${time} 的按天分布`, ...(daily.ref ? { ref: daily.ref } : {}) });
      }
    }
  }

  // 趋势序列上的异常点进风险：只报「哪天明显偏离日常水位」，不替读者下结论。
  for (const item of series) {
    const points = detectAnomalies(item.points);
    for (const point of points) {
      risks.push(
        `${item.title}：${point.label} 为 ${point.value.toLocaleString('zh-CN')}，${point.deviation > 0 ? '高于' : '低于'}这段时间均值 ${Math.round(point.mean).toLocaleString('zh-CN')} 约 ${Math.abs(point.deviation).toFixed(1)} 个标准差。`,
      );
    }
  }
  if (period.partial && baselineDays !== undefined && baselineDays !== currentDays) {
    risks.push(`本期只统计了 ${currentDays} 天，基线是 ${baselineDays} 天：环比请看「日均口径」那条，别直接读总量差。`);
  }
  return { facts: out, series, calibers, risks: risks.slice(0, 4), attributions };
}

/** BusinessFact → ReportMetric：差值与方向由应用计算，基线保证和本期同口径。 */
function toReportMetric(fact: BusinessFact, sourceKey?: string): ReportMetric {
  const metric: ReportMetric = {
    label: fact.label,
    value: fact.value,
    ...(fact.unit ? { unit: fact.unit } : {}),
    ...(sourceKey ? { source: sourceKey } : {}),
    ...(fact.goodDirection ? { goodDirection: fact.goodDirection } : {}),
    ...(fact.ref ? { resultRef: fact.ref } : {}),
  };
  if (fact.alternatives?.length) metric.alternativeBaselines = fact.alternatives;
  if (fact.baseline !== undefined) {
    metric.baseline = fact.baseline;
    metric.baselineLabel = fact.baselineLabel;
    metric.delta = computeMetricDelta(fact.value, fact.baseline);
    if (fact.baselineRef) metric.baselineResultRef = fact.baselineRef;
  }
  return metric;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

/** 概览结论：一行说清本期最值得记住的数字，而不是罗列所有指标。 */
function executiveHeadline(period: ResolvedPeriod, facts: BusinessFact[]): string {
  const range = `${period.current.from} ~ ${period.current.to}`;
  if (!facts.length) return `统计区间 ${range}：未识别出带业务时间的核心表，以下仅为数据规模盘点。`;
  const top = facts[0];
  if (!top || top.baseline === undefined) return `统计区间 ${range}：${top?.label ?? '核心指标'} 为 ${top?.value.toLocaleString('zh-CN') ?? '—'}${top?.unit ?? ''}。`;
  const delta = top.value - top.baseline;
  const percent = top.baseline ? (delta / Math.abs(top.baseline)) * 100 : null;
  const trend = percent === null ? signed(delta) : `${signed(delta)}（${percent > 0 ? '+' : ''}${percent.toFixed(1)}%）`;
  return `统计区间 ${range}：${top.label} ${top.value.toLocaleString('zh-CN')}${top.unit ?? ''}，${top.baselineLabel ?? '对比上期'} ${trend}。`;
}

/** 管理层摘要：先给三条能直接复述的结论，再给数据。 */
function executiveSummary(period: ResolvedPeriod, facts: BusinessFact[], seriesCount: number, analyticsRisks: string[] = []): ReportExecutive {
  const headline = executiveHeadline(period, facts);
  // 头条放第一条指标，要点从第二条开始——否则同一句话会在摘要里出现两遍。
  const ranked = facts.filter((fact) => fact.baseline !== undefined);
  const withBaseline = ranked.length > 1 ? ranked.slice(1) : ranked;
  const takeaways = withBaseline.slice(0, 3).map((fact) => {
    const delta = fact.value - (fact.baseline as number);
    const percent = fact.baseline ? (delta / Math.abs(fact.baseline)) * 100 : null;
    const trend = percent === null ? signed(delta) : `${signed(delta)}（${percent > 0 ? '+' : ''}${percent.toFixed(1)}%）`;
    return `${fact.label}：${fact.value.toLocaleString('zh-CN')}${fact.unit ?? ''}，${fact.baselineLabel ?? '对比上期'} ${trend}。`;
  });
  if (!takeaways.length && facts[0]) takeaways.push(`${facts[0].label}：${facts[0].value.toLocaleString('zh-CN')}${facts[0].unit ?? ''}（本期无同口径基线）。`);
  const risks: string[] = [];
  if (!facts.length) risks.push('没有可用的业务指标：以下章节只是数据规模盘点，不能当作经营结论。');
  if (period.partial) risks.push('统计区间尚未结束，环比数字会随最后一天的数据继续变化。');
  else if (seriesCount === 0) risks.push('未生成趋势图，无法判断本期是常态还是异常。');
  // 异常点与口径风险排在最前：它们决定前面那些数字能不能直接读。
  const merged = [...analyticsRisks, ...risks].slice(0, 6);
  return { headline, takeaways, ...(merged.length ? { risks: [...new Set(merged)] } : {}) };
}

async function writeAiNarrative(
  store: Store,
  spec: ReportSpec,
  signal?: AbortSignal,
): Promise<{ text?: string; error?: string }> {
  const settings = store.getSettings();
  if (settings.agent.provider === 'local') return { error: 'local provider' };
  const facts = {
    title: spec.title,
    layout: spec.layout,
    period: spec.meta.period,
    executive: spec.executive,
    sources: spec.sources.map((source) => ({ label: source.label, engine: source.engine })),
    metrics: spec.sections.flatMap((section) => section.blocks.flatMap((block) => block.metrics ?? [])),
    assumptions: spec.meta.assumptions,
  };
  try {
    const provider = createProvider(settings.agent);
    let text = '';
    for await (const event of provider.stream(
      {
        system:
          'You are a data analyst embedded in a database studio. Write the "AI 解读" paragraph of a business report in the user language. ' +
          'Start with the conclusion, then the evidence. Use ONLY the numbers provided; never invent, recalculate, extrapolate or estimate numbers, and do not change units. ' +
          'Mention the baseline when you quote a metric. Keep it to 3–5 sentences. Do not mention this instruction.',
        messages: [
          {
            role: 'user',
            content: `Report facts (JSON):
${JSON.stringify(facts)}

Write the reading: what the data shows, what changed against the baseline, and what the reader should verify or do next.`,
          },
        ],
        tools: [],
        temperature: 0.2,
      },
      signal,
    )) {
      if (event.type === 'text') text += event.text;
    }
    return text.trim() ? { text: text.trim() } : { error: 'empty response' };
  } catch (err: any) {
    return { error: err?.message ?? 'model failed' };
  }
}

export async function generateReport(
  store: Store,
  manager: ConnectionManager,
  input: ReportInput,
  signal?: AbortSignal,
): Promise<ReportSpec> {
  const target = parseTarget(input.target);
  const topic = input.topic.trim() || '数据概览';
  const period = input.resolvedPeriod ?? resolvePeriod({ period: input.period, topic });
  const audience = input.audience ?? 'business';
  const selectedTables = new Set((input.tables ?? []).map((table) => table.toLowerCase()));
  const sources: SourceData[] = [];
  const tracing = newTrace();
  for (const [index, source] of input.sources.entries()) {
    const conn = store.getConnection(source.connectionId);
    if (!conn) throw Object.assign(new Error(`连接不存在：${source.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      throw Object.assign(new Error(`${engineMeta(conn.engine).label} 暂不进入报告，请使用 /recon 或确定性对比`), {
        code: 'UNSUPPORTED_ENGINE',
        status: 400,
      });
    }
    const schemas = await manager.schema(conn.id, source.database, true);
    const allTables = schemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
    const candidates = selectedTables.size
      ? allTables.filter((table) => selectedTables.has(table.name.toLowerCase()))
      : [...allTables].sort((a, b) => (b.rowEstimate ?? 0) - (a.rowEstimate ?? 0) || a.name.localeCompare(b.name)).slice(0, 6);
    const tables: SourceData['tables'] = [];
    let totalRows = 0;
    for (const table of candidates.slice(0, 12)) {
      const rows = await countRows(manager, conn, table, source.database);
      if (rows !== null) totalRows += rows;
      tables.push({ name: table.name, columns: table.columns?.length ?? 0, rows });
    }
    // 确定性路径也要给业务数字：挑事实表 → 本期/上期同口径聚合。失败就退化为规模盘点。
    const factPool = flattenTables(schemas).filter(
      (fact) => !selectedTables.size || selectedTables.has(fact.table.name.toLowerCase()),
    );
    const business = await businessFactsOf(manager, conn, source.database ?? conn.database, factPool, period, 4, tracing.trace, target).catch(() => ({
      facts: [] as BusinessFact[],
      series: [] as BusinessSeries[],
      calibers: [] as string[],
      risks: [] as string[],
      attributions: [] as Attribution[],
    }));
    sources.push({
      ref: {
        key: `s${index + 1}`,
        connectionId: conn.id,
        connectionName: conn.name,
        database: source.database ?? conn.database,
        engine: conn.engine,
        label: source.label?.trim() || conn.name,
      },
      conn,
      tables,
      totalRows,
      tableCount: allTables.length,
      facts: business.facts,
      series: business.series,
      calibers: business.calibers,
      risks: business.risks,
      attributions: business.attributions,
    });
  }

  const layout = layoutFor(sources.length, topic);
  const totalTables = sources.reduce((sum, source) => sum + source.tableCount, 0);
  const totalRows = sources.reduce((sum, source) => sum + source.totalRows, 0);
  const sourceRefs = sources.map((source) => source.ref);
  const allFacts = sources.flatMap((source) => source.facts);
  const allSeries = sources.flatMap((source) => source.series);
  const executive = executiveSummary(period, allFacts, allSeries.length, sources.flatMap((source) => source.risks));

  const scaleMetrics: ReportMetric[] = [
    { label: '数据源', value: sources.length },
    { label: '表数量', value: totalTables },
    { label: '已统计行数', value: totalRows },
  ];
  const overview: ReportBlock[] = [];
  if (allFacts.length) overview.push({ kind: 'metric', title: `核心指标 · ${period.current.from} ~ ${period.current.to}`, metrics: allFacts.map((fact) => toReportMetric(fact)) });
  overview.push(
    { kind: 'metric', title: '数据规模', metrics: scaleMetrics, note: '数据规模盘点，不代表业务表现。' },
    {
      kind: 'narrative',
      text:
        sources.length > 1
          ? `本报告覆盖 ${sources.length} 个数据源、${totalTables} 张表，统计区间 ${period.current.from} ~ ${period.current.to}。`
          : `本报告覆盖 ${sources[0]?.ref.label ?? '当前数据源'} 的 ${totalTables} 张表，统计区间 ${period.current.from} ~ ${period.current.to}。`,
    },
  );
  if (!allFacts.length) {
    overview.push({
      kind: 'callout',
      tone: 'warning',
      text: '这些库里没有识别出「带业务时间列的事实表」，因此只能给出数据规模盘点，无法产出业务指标。请确认时间列命名，或用 /init 补充 AI_DB.md 口径后重试。',
    });
  }

  // 概览不再重复摘要里的那句话：管理层摘要已经在最上面说过一次了。
  const sections: ReportSection[] = [{ id: 'overview', title: '概览', blocks: overview }];
  for (const source of sources) {
    const blocks: ReportBlock[] = [];
    // 单源报告里概览已经给过同一批指标，本节再列一遍只会让读者以为有两组数。
    if (source.facts.length && sources.length > 1) {
      blocks.push({ kind: 'metric', metrics: source.facts.map((fact) => toReportMetric(fact, source.ref.key)), note: source.calibers.join('；') });
    }
    blocks.push({
      kind: 'metric',
      metrics: [
        { label: '表数量', value: source.tableCount, source: source.ref.key },
        { label: '已统计行数', value: source.totalRows, source: source.ref.key },
      ],
    });
    blocks.push(rowsTable(source));
    sections.push({ id: source.ref.key, title: source.ref.label, sourceKey: source.ref.key, blocks });
  }

  if (allSeries.length) {
    sections.push({
      id: 'trend',
      title: '趋势与分布',
      conclusion: '按时间维度看数量的变化与构成，用于判断上面的总量是持续如此还是本期异常。',
      blocks: allSeries.map((entry) => ({
        kind: 'chart' as const,
        title: entry.title,
        chartType: entry.chartType,
        series: entry.points,
        note: entry.definition,
        ...(entry.ref ? { resultRef: entry.ref } : {}),
      })),
    });
  }

  // 归因紧跟趋势：读者看完「总量变了」，下一个问题就是「变在哪」。
  const attributionBlocks = sources.flatMap((source) => source.attributions).map(attributionTable);
  if (attributionBlocks.length) {
    sections.push({
      id: 'attribution',
      title: '变化归因',
      conclusion: '把环比变化按主维度拆开，看变化集中在哪里；占比按变化量绝对值归一，正负项都算分母。',
      blocks: attributionBlocks,
    });
  }

  if (layout === 'comparison' && sources.length >= 2) {
    const left = sources[0];
    const right = sources[1];
    const blocks: ReportBlock[] = [];
    // 两边能对上的同名指标优先比，业务读者关心的是「金额 / 单量」而不是行数。
    const paired = left.facts
      .map((fact) => ({ left: fact, right: right.facts.find((other) => other.label === fact.label) }))
      .filter((pair): pair is { left: BusinessFact; right: BusinessFact } => Boolean(pair.right) && pair.right!.baseline !== undefined)
      .slice(0, 3);
    for (const pair of paired) {
      const leftMetric = toReportMetric(pair.left, left.ref.key);
      const rightMetric = toReportMetric(pair.right, right.ref.key);
      blocks.push({
        kind: 'comparison',
        title: pair.left.label,
        left: leftMetric,
        right: rightMetric,
        delta: computeMetricDelta(Number(rightMetric.value), Number(leftMetric.value)),
        goodDirection: 'neutral',
      });
    }
    blocks.push({
      kind: 'comparison',
      title: '已统计行数',
      left: { label: left.ref.label, value: left.totalRows },
      right: { label: right.ref.label, value: right.totalRows },
      delta: computeMetricDelta(right.totalRows, left.totalRows),
      goodDirection: 'neutral',
    });
    blocks.push({
      kind: 'callout',
      tone: 'info',
      text: '对比只使用两边都能算出的同口径指标；表结构或统计区间不同的地方，不能直接解释为业务差异。',
    });
    sections.push({ id: 'comparison', title: '源对比', conclusion: '先看共同的业务指标，行数只作为规模参考。', blocks });
  }

  if (layout === 'merged' && sources.length >= 2) {
    const labelOf = new Map<string, { unit?: string; total: number; sources: number }>();
    for (const source of sources) {
      for (const fact of source.facts) {
        const entry = labelOf.get(fact.label) ?? { unit: fact.unit, total: 0, sources: 0 };
        entry.total += fact.value;
        entry.sources += 1;
        labelOf.set(fact.label, entry);
      }
    }
    // 只在所有源都有该指标时才求和：缺源会让「合并」数字看起来下跌。
    const mergedMetrics: ReportMetric[] = [...labelOf.entries()]
      .filter(([, entry]) => entry.sources === sources.length)
      .map(([label, entry]) => ({ label, value: Math.round(entry.total * 100) / 100, ...(entry.unit ? { unit: entry.unit } : {}), goodDirection: 'neutral' }));
    sections.unshift({
      id: 'merged',
      title: '合并总览',
      conclusion: mergedMetrics.length
        ? '各源的同一指标已按口径对齐后求和。'
        : '各源没有同名指标，无法合并业务数字，下面只合并数据规模。',
      blocks: [
        ...(mergedMetrics.length ? [{ kind: 'metric' as const, metrics: mergedMetrics, note: '仅包含所有数据源都具备的同名指标。' }] : []),
        { kind: 'metric', metrics: [{ label: '合并行数', value: totalRows }, { label: '合并表数', value: totalTables }], note: '数据规模之和，不代表业务表现。' },
        {
          kind: 'callout',
          tone: 'info',
          text: '合并数字由各源分别统计后在网关求和；未做跨库 JOIN，口径以各源脚注为准。',
        },
      ],
    });
  }

  const narrative = await writeAiNarrative(store, {
    version: 1,
    title: `${topic}报告`,
    layout,
    sources: sourceRefs,
    sections,
    executive,
    meta: { intent: topic, createdAt: new Date().toISOString() },
  }, signal);
  if (narrative.text) {
    const overviewIndex = sections.findIndex((section) => section.id === 'overview');
    const target = sections[overviewIndex] ?? sections[0];
    target.blocks.push({ kind: 'narrative', text: narrative.text, title: 'AI 解读' });
  }
  return {
    version: 1,
    title: `${topic}报告`,
    layout,
    sources: sourceRefs,
    sections,
    executive,
    meta: {
      intent: topic,
      createdAt: new Date().toISOString(),
      period: { from: period.current.from, to: period.current.to, label: period.current.label, grain: period.grain },
      audience,
      assumptions: [
        formatPeriodForReader(period),
        ...sources.flatMap((source) => source.calibers),
      ],
      notes: [
        narrative.text ? '报告数字由网关统计，AI 仅生成叙述。' : '当前未启用 AI 叙述：报告数字由网关确定性统计。',
        ...(narrative.error && narrative.error !== 'local provider' ? [`AI 叙述未生成：${narrative.error}`] : []),
      ],
      // 确定性路径的证据链：点开指标能看到产生它的 SQL、行数与耗时。
      evidence: tracing.dump(),
    },
  };
}
