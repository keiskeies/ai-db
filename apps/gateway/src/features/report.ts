import { buildCount, buildTimeBucketExpr, createProvider, engineMeta, quoteIdent, type ConnectionConfig, type TableInfo } from '@aidb/core';
import type {
  CommandSourceInput,
  ReportBlock,
  ReportExecutive,
  ReportLayout,
  ReportMetric,
  ReportSection,
  ReportSourceRef,
  ReportSpec,
  ResolvedPeriod,
} from '@aidb/core';
import { computeMetricDelta, formatPeriodForReader, resolvePeriod } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';
import { flattenTables, type TableFact } from './databaseBrief';
import { businessTimeOf, columnsOf, dimensionLabel, dimensionOf, factScore, moneyOf, softDeleteFilter, tableLabel, tableRef } from './dashboardGenerate';

/**
 * 无模型时可用的业务名：英文库名直译成中文，读者才不会看到「orders单量」。
 * 只覆盖高频实体；有表注释或 AI_DB.md 时 tableLabel 已经给出更好的名字。
 */
const ENTITY_ZH: Array<[RegExp, string]> = [
  [/^(orders?|order_info|trade_orders?|order_items?)$/i, '订单'],
  [/^(users?|user_info|members?)$/i, '用户'],
  [/^(refunds?|refund_orders?)$/i, '退款'],
  [/^(payments?|pay_orders?|transactions?)$/i, '支付'],
  [/^(products?|items?|skus?|goods)$/i, '商品'],
  [/^(customers?|clients?)$/i, '客户'],
  [/^(invoices?)$/i, '发票'],
  [/^(shipments?|deliver(y|ies)|logistics)$/i, '履约'],
  [/^(carts?)$/i, '购物车'],
  [/^(tickets?|issues?)$/i, '工单'],
  [/^(visits?|sessions?|page_?views?)$/i, '访问'],
  [/^(complaints?|reports?)$/i, '投诉'],
];

function businessLabel(fact: TableFact): string {
  const base = tableLabel(fact);
  for (const [pattern, zh] of ENTITY_ZH) {
    if (pattern.test(base) || pattern.test(fact.name)) return zh;
  }
  return base;
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
}

/** 一条确定性图表数据。 */
interface BusinessSeries {
  title: string;
  chartType: 'line' | 'bar' | 'pie' | 'stacked';
  points: Array<{ label: string; value: number }>;
  definition: string;
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

/** 跑一条只读聚合，取第一行第一列。失败返回 null，不拖垮整份报告。 */
async function scalarQuery(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  database: string | undefined,
  sql: string,
): Promise<number | null> {
  try {
    const batch = await manager.query(conn.id, sql, { database, maxRows: 5, allowMulti: false, autoLimit: false, actor: 'user' });
    const value = batch.sets[0]?.rows[0]?.[0];
    const numeric = Number(value);
    return value === null || value === undefined || !Number.isFinite(numeric) ? null : numeric;
  } catch {
    return null;
  }
}

/** 跑一条聚合，取多行多列。 */
async function rowsQuery(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  database: string | undefined,
  sql: string,
  maxRows = 24,
): Promise<Array<Array<unknown>>> {
  try {
    const batch = await manager.query(conn.id, sql, { database, maxRows, allowMulti: false, autoLimit: false, actor: 'user' });
    return batch.sets[0]?.rows ?? [];
  } catch {
    return [];
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
): Promise<{ facts: BusinessFact[]; series: BusinessSeries[]; calibers: string[] }> {
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
  let compositionTried = false;

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
      scalarQuery(manager, conn, database, `SELECT ${fn} FROM ${table} ${whereFor(start, end)}`);

    const current = await aggregate('COUNT(*)', from, to);
    if (current === null) continue;
    const baseline = previous ? await aggregate('COUNT(*)', previous.from, previous.to) : null;
    out.push({
      label: `${label}单量`,
      value: current,
      unit: '笔',
      goodDirection: inferGoodDirection(label),
      ...(baseline === null ? {} : { baseline, baselineLabel }),
      definition: `${label}：按 ${time} 统计 ${from} ~ ${to} 的记录数${softDelete ? '（已按软删除过滤）' : ''}`,
      tableLabel: label,
    });
    calibers.push(`${label} 时间口径：${time}`);

    if (money) {
      const sum = `SUM(${quoteIdent(money, engine)})`;
      const amountCurrent = await aggregate(sum, from, to);
      if (amountCurrent !== null) {
        const amountPrevious = previous ? await aggregate(sum, previous.from, previous.to) : null;
        // 以「分」存储的金额在这里统一换算成元，并在口径里写明——业务读者拿到的是元，不是分。
        const cents = /(_cents?|cents?)$/i.test(money);
        const scale = (value: number) => Math.round(value * (cents ? 0.01 : 1) * 100) / 100;
        out.push({
          label: `${label}金额`,
          value: scale(amountCurrent),
          unit: cents ? '元' : undefined,
          goodDirection: inferGoodDirection(label),
          ...(amountPrevious === null || amountPrevious === undefined ? {} : { baseline: scale(amountPrevious), baselineLabel }),
          definition: `${label}：SUM(${money})${cents ? '／100（元）' : ''}，${from} ~ ${to}`,
          tableLabel: label,
        });
        calibers.push(`${label} 金额口径：SUM(${money})${cents ? '，按 100 分 = 1 元换算' : ''}`);
      }
    }

    if (!series.length) {
      const bucket = buildTimeBucketExpr(engine, time, 'month');
      const trendRows = await rowsQuery(
        manager,
        conn,
        database,
        `SELECT ${bucket} AS period, COUNT(*) AS cnt FROM ${table} ${softDelete} GROUP BY period ORDER BY period DESC LIMIT 12`,
        12,
      ).then((rows) => rows.reverse());
      const points = trendRows
        .map((row) => ({ label: String(row[0] ?? '—'), value: Number(row[1]) }))
        .filter((point) => Number.isFinite(point.value) && !/^\s*$/.test(point.label));
      if (points.length >= 3) {
        series.push({ title: `${label}月度趋势`, chartType: 'line', points, definition: `${label}：按 ${time} 分月统计记录数` });
      }
    }

    // 一张低基数维度构成：有明确业务维度时，报告应能回答「占比」而不是只有时间趋势。
    // 先查 9 行判断是否真的是一个完整整体；超过 8 类就不画饼图，避免把 Top 8 伪装成全部。
    if (!compositionTried) {
      const dim = dimensionOf(fact, [time, ...(money ? [money] : [])]);
      if (dim) {
        compositionTried = true;
        const composition = await rowsQuery(
          manager,
          conn,
          database,
          `SELECT ${quoteIdent(dim, engine)} AS dim_value, COUNT(*) AS cnt FROM ${table} ${whereFor(from, to)} GROUP BY dim_value ORDER BY cnt DESC LIMIT 9`,
          9,
        );
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
          });
          calibers.push(`${label} 构成口径：按 ${dim} 分组`);
        }
      }
    }

    if (series.length < 2) {
      const distribution = await rowsQuery(
        manager,
        conn,
        database,
        `SELECT ${buildTimeBucketExpr(engine, time, 'day')} AS bucket, COUNT(*) AS cnt FROM ${table} ${whereFor(from, to)} GROUP BY bucket ORDER BY cnt DESC LIMIT 8`,
        8,
      );
      const points = distribution
        .map((row) => ({ label: String(row[0] ?? '—'), value: Number(row[1]) }))
        .filter((point) => Number.isFinite(point.value) && !/^\s*$/.test(point.label));
      if (points.length >= 2) {
        series.push({ title: `${label}：按天分布`, chartType: 'bar', points, definition: `${label}：${from} ~ ${to} 内按 ${time} 的按天分布` });
      }
    }
  }
  return { facts: out, series, calibers };
}

/** BusinessFact → ReportMetric：差值与方向由应用计算，基线保证和本期同口径。 */
function toReportMetric(fact: BusinessFact, sourceKey?: string): ReportMetric {
  const metric: ReportMetric = {
    label: fact.label,
    value: fact.value,
    ...(fact.unit ? { unit: fact.unit } : {}),
    ...(sourceKey ? { source: sourceKey } : {}),
    ...(fact.goodDirection ? { goodDirection: fact.goodDirection } : {}),
  };
  if (fact.baseline !== undefined) {
    metric.baseline = fact.baseline;
    metric.baselineLabel = fact.baselineLabel;
    metric.delta = computeMetricDelta(fact.value, fact.baseline);
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
function executiveSummary(period: ResolvedPeriod, facts: BusinessFact[], seriesCount: number): ReportExecutive {
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
  return { headline, takeaways, ...(risks.length ? { risks } : {}) };
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
  const topic = input.topic.trim() || '数据概览';
  const period = input.resolvedPeriod ?? resolvePeriod({ period: input.period, topic });
  const audience = input.audience ?? 'business';
  const selectedTables = new Set((input.tables ?? []).map((table) => table.toLowerCase()));
  const sources: SourceData[] = [];
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
    const business = await businessFactsOf(manager, conn, source.database ?? conn.database, factPool, period).catch(() => ({
      facts: [] as BusinessFact[],
      series: [] as BusinessSeries[],
      calibers: [] as string[],
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
    });
  }

  const layout = layoutFor(sources.length, topic);
  const totalTables = sources.reduce((sum, source) => sum + source.tableCount, 0);
  const totalRows = sources.reduce((sum, source) => sum + source.totalRows, 0);
  const sourceRefs = sources.map((source) => source.ref);
  const allFacts = sources.flatMap((source) => source.facts);
  const allSeries = sources.flatMap((source) => source.series);
  const executive = executiveSummary(period, allFacts, allSeries.length);

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
      })),
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
    },
  };
}
