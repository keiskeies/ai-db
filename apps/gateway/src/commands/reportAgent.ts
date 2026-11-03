import { randomUUID } from 'node:crypto';
import {
  AgentRuntime,
  computeMetricDelta,
  compressSchema,
  createProvider,
  formatBusinessContext,
  formatPeriodForPrompt,
  getTool,
  providerTools,
  resolvePeriod,
  type CommandSourceInput,
  type ProviderTool,
  type ReportActionItem,
  type ReportBlock,
  type ReportChartPoint,
  type ReportExecutive,
  type ReportLayout,
  type ReportMetric,
  type ReportSection,
  type ReportSourceRef,
  type ReportSpec,
  type ResolvedPeriod,
  type ToolDefinition,
  type ToolResult,
} from '@aidb/core';
import type { ToolExecutor } from '../executor';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { briefPromptBlock, defaultBriefPath, loadBrief, readBrief } from '../features/databaseBrief';

const REPORT_TOOLS = [
  'inspect_schema',
  'search_objects',
  'run_sql',
  'explain_sql',
  'sample_rows',
  'profile_column',
  'analyze_chart',
  'forecast_chart',
  'render_chart',
  'memory_search',
  'update_plan',
];

/** 数字只能来自这几类工具的结果；结构类工具（schema、搜索）不贡献数字。 */
const NUMERIC_TOOLS = new Set(['run_sql', 'analyze_chart', 'forecast_chart', 'render_chart', 'sample_rows', 'profile_column']);

/** 展示层缩写只做单位换算（百分比 0.1234 -> 12.34%），不做数量级篡改。 */
const PERCENT_SCALE = 100;

const COMPOSE_REPORT: ToolDefinition = {
  name: 'compose_report',
  description:
    'Submit the final report specification. Call exactly once when all numbers are gathered. Every numeric value in metric/chart/table/comparison blocks must be quoted verbatim at full precision from a previous tool result — never calculate, invent, or re-scale it (the app abbreviates large numbers for display on its own). Write for a business reader, not a DBA: fill the executive summary, give each section a conclusion, and use plain business wording in titles.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'layout', 'sections', 'executive'],
    properties: {
      title: { type: 'string', description: 'Business-readable report title, e.g. 「10 月订单与履约月报」. No table or column names.' },
      audience: { type: 'string', enum: ['executive', 'business', 'technical'] },
      layout: { type: 'string', enum: ['sections', 'comparison', 'merged', 'mixed'] },
      executive: {
        type: 'object',
        additionalProperties: false,
        required: ['headline', 'takeaways'],
        properties: {
          headline: { type: 'string', description: 'One sentence: the single most important conclusion, with its number.' },
          takeaways: { type: 'array', items: { type: 'string' }, description: '3–5 conclusions, each carrying one authoritative number.' },
          risks: { type: 'array', items: { type: 'string' }, description: 'Risks or opportunities worth flagging; omit when there are none.' },
        },
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Metric definitions you chose: which column, which filters, which time field, currency/unit. Shown as a footnote, never in the body.',
      },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'blocks'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string', description: 'Business wording, no table/column names.' },
            sourceKey: { type: 'string' },
            conclusion: { type: 'string', description: 'One-sentence conclusion for this section, rendered before its data.' },
            blocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  summarize: () => '提交报告规格',
};

const TOOL_DEFS = new Map<string, ToolDefinition>(
  providerTools().filter((tool) => REPORT_TOOLS.includes(tool.name)).map((tool) => [tool.name, getTool(tool.name)!]),
);
TOOL_DEFS.set('compose_report', COMPOSE_REPORT);

function providerToolsForReport(): ProviderTool[] {
  return [...TOOL_DEFS.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

function collectNumbers(value: unknown, out: Set<number>, depth = 0): void {
  if (depth > 8 || out.size > 5000) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(value);
    return;
  }
  if (typeof value === 'string') {
    // 单元格的字符串数字同样权威，但只有「看起来就是一个数」才收录：
    // 否则 "2026-11-01" 之类的日期串会污染数字池。
    const trimmed = value.trim();
    if (/^-?(\d+(\.\d+)?|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) out.add(parsed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectNumbers(item, out, depth + 1);
  }
}

function sameNumber(known: number, numeric: number): boolean {
  return Math.abs(known - numeric) <= Math.max(0.000001, Math.abs(known) * 1e-9);
}

/**
 * 数字是否真的来自那次工具结果。
 * 除了原值本身，还接受「同一数字的百分比展示值」（0.1234 -> 12.34）：
 * 展示层需要把比率写成百分数，但这只是单位换算，数量级仍被锁定，模型依然不能凭空造数。
 */
function hasNumber(out: Set<number>, value: unknown): boolean {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return true;
  for (const known of out) {
    if (sameNumber(known, numeric)) return true;
    if (known !== 0 && Math.abs(known) < 1 && sameNumber(known * PERCENT_SCALE, numeric)) return true;
  }
  return false;
}

function refIdsOf(block: { resultRef?: string; resultRefs?: string[] }): string[] {
  const ids = [...(block.resultRefs ?? [])];
  if (block.resultRef) ids.unshift(block.resultRef);
  return [...new Set(ids)];
}

function invalid(message: string): ToolResult {
  return { ok: false, summary: '报告规格不合法', error: { code: 'INVALID_REPORT_SPEC', message }, meta: { durationMs: 0 } };
}

export function normalizeReportBlock(
  raw: any,
  numbers: Set<number>,
  refNumbers: Map<string, Set<number>>,
  requireRef: boolean,
): ReportBlock | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'block 必须是对象' };
  const kind = raw.kind;
  const blockRef = typeof raw.resultRef === 'string' ? raw.resultRef : undefined;
  const blockRefs = refIdsOf({ resultRef: blockRef, resultRefs: Array.isArray(raw.resultRefs) ? raw.resultRefs.map(String) : undefined });
  for (const id of blockRefs) {
    if (!refNumbers.has(id)) return { error: `${String(kind)} 的 resultRef 不存在：${id}` };
  }
  /**
   * 校验一个数字归属哪次工具结果。
   * 绑定了具体 ref 时只认那次结果——否则模型可以把 A 查询的数字挂到 B 上；
   * 未绑定（或整块多来源）时退回「本次会话已出现过的数字」池。
   */
  const checkRef = (ref: string | undefined, label: string): Set<number> | { error: string } => {
    if (!ref) {
      if (requireRef) return { error: `${label} 缺少 resultRef` };
      return numbers;
    }
    const refSet = refNumbers.get(ref);
    if (!refSet) return { error: `${label} 的 resultRef 不存在：${ref}` };
    return refSet;
  };
  const scopeFor = (ref: string | undefined): Set<number> => {
    if (ref) return refNumbers.get(ref) ?? numbers;
    if (blockRefs.length === 1) return refNumbers.get(blockRefs[0]) ?? numbers;
    if (!blockRefs.length) return numbers;
    const merged = new Set<number>();
    for (const id of blockRefs) for (const value of refNumbers.get(id) ?? []) merged.add(value);
    return merged;
  };
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined;
  if (kind === 'narrative') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) return { error: 'narrative 缺少 text' };
    return { kind, text: raw.text.trim(), ...(note ? { note } : {}) };
  }
  if (kind === 'callout') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) return { error: 'callout 缺少 text' };
    return { kind, text: raw.text.trim(), tone: raw.tone === 'warning' || raw.tone === 'danger' ? raw.tone : 'info', ...(note ? { note } : {}) };
  }
  if (kind === 'actions') {
    const items = Array.isArray(raw.actions) ? raw.actions : [];
    const out: ReportActionItem[] = [];
    for (const item of items) {
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      if (!text) continue;
      const actionRef = typeof item?.resultRef === 'string' ? item.resultRef : undefined;
      const refSet = checkRef(actionRef ?? blockRef, `建议「${text.slice(0, 16)}」`);
      if ('error' in refSet) return refSet;
      out.push({
        text,
        resultRef: actionRef ?? blockRef,
        ...(typeof item?.impact === 'string' && item.impact.trim() ? { impact: item.impact.trim() } : {}),
        ...(typeof item?.owner === 'string' && item.owner.trim() ? { owner: item.owner.trim() } : {}),
        ...(typeof item?.due === 'string' && item.due.trim() ? { due: item.due.trim() } : {}),
      });
    }
    if (!out.length) return { error: 'actions 缺少有效建议' };
    return { kind, resultRef: blockRef, ...(blockRefs.length > 1 ? { resultRefs: blockRefs } : {}), title: raw.title === undefined ? undefined : String(raw.title), actions: out };
  }
  if (kind === 'metric') {
    const metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
    if (!metrics.length) return { error: 'metric 缺少 metrics' };
    const out: ReportMetric[] = [];
    for (const metric of metrics) {
      const label = String(metric?.label ?? '');
      if (!label) continue;
      const ref = typeof metric?.resultRef === 'string' ? metric.resultRef : blockRef;
      const refSet = checkRef(ref, `指标 ${label}`);
      if ('error' in refSet) return refSet;
      if (!hasNumber(refSet, metric?.value)) return { error: `指标 ${label} 的数字没有对应 resultRef 的来源` };
      const normalized: ReportMetric = {
        label,
        value: metric?.value,
        unit: metric?.unit === undefined ? undefined : String(metric.unit),
        resultRef: ref,
      };
      if (metric?.unit === undefined) delete normalized.unit;
      // 基线同样必须是查出来的数；差值一律由应用计算，模型手写差值等于放行幻觉。
      if (metric?.baseline !== undefined && metric?.baseline !== null && metric.baseline !== '') {
        const baselineRef = typeof metric?.baselineResultRef === 'string' ? metric.baselineResultRef : ref;
        const baselineSet = checkRef(baselineRef, `指标 ${label} 的基线`);
        if ('error' in baselineSet) return baselineSet;
        if (!hasNumber(baselineSet, metric.baseline)) return { error: `指标 ${label} 的基线数字没有对应 resultRef 的来源` };
        const baseline = Number(metric.baseline);
        const value = Number(metric.value);
        normalized.baseline = baseline;
        normalized.baselineResultRef = baselineRef;
        if (typeof metric?.baselineLabel === 'string' && metric.baselineLabel.trim()) normalized.baselineLabel = metric.baselineLabel.trim();
        if (Number.isFinite(value)) normalized.delta = computeMetricDelta(value, baseline);
      }
      if (metric?.goodDirection === 'down' || metric?.goodDirection === 'neutral') normalized.goodDirection = metric.goodDirection;
      out.push(normalized);
    }
    if (!out.length) return { error: 'metric 缺少有效指标' };
    return { kind, resultRef: blockRef, ...(blockRefs.length > 1 ? { resultRefs: blockRefs } : {}), title: raw.title === undefined ? undefined : String(raw.title), metrics: out, ...(note ? { note } : {}) };
  }
  if (kind === 'table') {
    const refSet = scopeFor(blockRef);
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    for (const row of rows) {
      if (!Array.isArray(row)) return { error: 'table.rows 必须是数组' };
      for (const cell of row) {
        if (!hasNumber(refSet, cell)) return { error: '表格数字没有对应 resultRef 的来源' };
      }
    }
    const columns = Array.isArray(raw.columns) ? raw.columns.map(String) : [];
    const measureColumns = Array.isArray(raw.measureColumns)
      ? raw.measureColumns.map(String).filter((column: string) => columns.includes(column))
      : [];
    return {
      kind,
      resultRef: blockRef,
      ...(blockRefs.length > 1 ? { resultRefs: blockRefs } : {}),
      title: raw.title === undefined ? undefined : String(raw.title),
      columns,
      rows: rows.map((row: unknown[]) => row.map((cell) => (cell === null || cell === undefined ? null : String(cell)))),
      ...(measureColumns.length ? { measureColumns } : {}),
      ...(note ? { note } : {}),
    };
  }
  if (kind === 'chart') {
    const refSet = scopeFor(blockRef);
    const series = Array.isArray(raw.series) ? raw.series : [];
    if (!series.length) return { error: 'chart 缺少 series' };
    const out: ReportChartPoint[] = [];
    for (const point of series) {
      if (!hasNumber(refSet, point?.value)) return { error: '图表数字没有对应 resultRef 的来源' };
      const value = Number(point?.value);
      const chartPoint: ReportChartPoint = { label: String(point?.label ?? ''), value };
      // 基线点用于「本期 vs 上期」双折线，同样要能追到工具结果。
      if (point?.baseline !== undefined && point.baseline !== null && point.baseline !== '') {
        const baselineRef = typeof point?.baselineResultRef === 'string' ? point.baselineResultRef : undefined;
        const baselineSet = baselineRef ? checkRef(baselineRef, `图表基线 ${chartPoint.label}`) : refSet;
        if ('error' in baselineSet) return baselineSet;
        if (!hasNumber(baselineSet, point.baseline)) return { error: `图表基线数字没有对应 resultRef 的来源：${chartPoint.label}` };
        chartPoint.baseline = Number(point.baseline);
      }
      out.push(chartPoint);
    }
    const chartType = (() => {
      const rawType = raw.chartType === undefined || raw.chartType === null || String(raw.chartType).trim() === ''
        ? 'bar'
        : String(raw.chartType).trim();
      if (!['bar', 'line', 'pie', 'stacked'].includes(rawType)) {
        return { error: `报告图表不支持 ${rawType}；可用 bar/line/pie/stacked，热力图/雷达图/散点图请在对话中用 render_chart 展示` } as const;
      }
      return rawType as 'bar' | 'line' | 'pie' | 'stacked';
    })();
    if (typeof chartType !== 'string') return chartType;
    if (chartType === 'pie') {
      if (out.length < 3 || out.length > 8) return { error: 'pie 需要 3–8 个切片' };
      if (out.some((point) => point.value < 0)) return { error: 'pie 不支持负值' };
    }
    if (chartType === 'pie' && out.some((point) => point.baseline !== undefined)) return { error: 'pie 不支持基线系列' };
    return {
      kind,
      resultRef: blockRef,
      ...(blockRefs.length > 1 ? { resultRefs: blockRefs } : {}),
      title: raw.title === undefined ? undefined : String(raw.title),
      chartType,
      ...(typeof raw.baselineName === 'string' && raw.baselineName.trim() ? { baselineName: raw.baselineName.trim() } : {}),
      series: out,
      ...(note ? { note } : {}),
    };
  }
  if (kind === 'comparison') {
    const left = raw.left ?? {};
    const right = raw.right ?? {};
    const leftRef = typeof left.resultRef === 'string' ? left.resultRef : blockRef;
    const rightRef = typeof right.resultRef === 'string' ? right.resultRef : blockRef;
    const leftSet = checkRef(leftRef, 'comparison.left');
    if ('error' in leftSet) return leftSet;
    const rightSet = checkRef(rightRef, 'comparison.right');
    if ('error' in rightSet) return rightSet;
    if (!hasNumber(leftSet, left.value) || !hasNumber(rightSet, right.value)) {
      return { error: 'comparison 的数字没有对应 resultRef 的来源' };
    }
    const l = Number(left.value);
    const r = Number(right.value);
    // 差值方向沿用「B 相对 A」：absolute = right - left，与确定性对比路径一致。
    const delta = computeMetricDelta(r, l);
    return {
      kind,
      resultRef: blockRef,
      ...(blockRefs.length > 1 ? { resultRefs: blockRefs } : {}),
      title: raw.title === undefined ? undefined : String(raw.title),
      left: { label: String(left.label ?? 'A'), value: l, resultRef: leftRef },
      right: { label: String(right.label ?? 'B'), value: r, resultRef: rightRef },
      delta,
      ...(raw.goodDirection === 'down' || raw.goodDirection === 'neutral' ? { goodDirection: raw.goodDirection } : {}),
      ...(note ? { note } : {}),
    };
  }
  return { error: `不支持的 block kind：${String(kind)}` };
}

export interface AgentReportInput {
  sources: CommandSourceInput[];
  topic: string;
  tables?: string[];
  mode?: 'report' | 'compare';
  leftLabel?: string;
  rightLabel?: string;
  queryA?: string;
  queryB?: string;
  /** 表单里的时间范围槽位；支持文本短语或 {from,to}。 */
  period?: unknown;
  /** 阅读对象，决定信息密度与措辞。 */
  audience?: 'executive' | 'business' | 'technical';
  /** 用于定位 AI_DB.md（口径来源）；缺省时按连接的默认路径查找。 */
  home?: string;
}

import { REPORT_CRAFT } from './reportCraft';

export async function generateAgentReport(
  store: Store,
  manager: ConnectionManager,
  executor: ToolExecutor,
  input: AgentReportInput,
  signal?: AbortSignal,
): Promise<ReportSpec> {
  const settings = store.getSettings();
  if (settings.agent.provider === 'local') throw Object.assign(new Error('本地推理器不生成 Agent 报告'), { code: 'MODEL_REQUIRED', status: 400 });
  const provider = createProvider(settings.agent);
  const schemas: Array<{ source: CommandSourceInput; connection: any; schemas: any[]; label: string }> = [];
  for (const [index, source] of input.sources.entries()) {
    const connection = store.getConnection(source.connectionId);
    if (!connection) throw Object.assign(new Error(`连接不存在：${source.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
    const loaded = await manager.schema(connection.id, source.database, true);
    schemas.push({
      source,
      connection,
      schemas: loaded,
      label: source.label?.trim() || connection.name || `源 ${index + 1}`,
    });
  }
  const sourceRefs: ReportSourceRef[] = schemas.map((item, index) => ({
    key: `s${index + 1}`,
    connectionId: item.connection.id,
    connectionName: item.connection.name,
    database: item.source.database ?? item.connection.database,
    engine: item.connection.engine,
    label: item.label,
  }));
  const schemaText = schemas
    .map((item) => {
      const focus = input.tables?.length ? input.tables : [];
      return `### Source [${item.connection.id}] ${item.label} (${item.connection.engine})\n${compressSchema(item.schemas, focus, 12)}`;
    })
    .join('\n\n');
  const connectionsText = sourceRefs
    .map((source) => `- [${source.connectionId}] label=${source.label} engine=${source.engine} database=${source.database ?? ''}`)
    .join('\n');

  const compare = input.mode === 'compare';
  const audience = input.audience ?? 'business';

  // 报告是业务交付物：术语表、反模式、JOIN 关系、标准口径 SQL、AI_DB.md 交接文档
  // 与本轮记忆召回都必须注入，否则模型会按字段名猜业务口径——这正是主 Agent 已经解决的问题。
  const primary = schemas[0];
  const recall = primary
    ? store.recallForTurn(input.topic, { connectionId: primary.connection.id, database: primary.source.database ?? primary.connection.database })
    : { memories: [], glossary: [], sqlExamples: [] };
  const businessContext = primary
    ? store.agentContextBundle(primary.connection.id, primary.source.database ?? primary.connection.database)
    : undefined;
  const business = formatBusinessContext({ context: businessContext, glossary: recall.glossary, sqlExamples: recall.sqlExamples });
  let briefBlock = '';
  if (primary && input.home) {
    const database = primary.source.database ?? primary.connection.database;
    const record = store.getDatabaseBrief(primary.connection.id, database);
    const path = record?.path ?? defaultBriefPath(input.home, primary.connection);
    const markdown = await readBrief(path).catch(() => null);
    if (markdown) {
      const brief = loadBrief(markdown, path, primary.schemas);
      briefBlock = briefPromptBlock(brief);
    }
  }
  const memoriesBlock = recall.memories.length
    ? `## Memories recalled for this turn\n${recall.memories.map((memory: any) => `- ${memory.title}: ${memory.content}`).join('\n')}`
    : '';

  const period = resolvePeriod({ period: input.period, topic: input.topic });

  const header = compare
    ? `You are AiDB Compare Agent. Compare the two sides using the selected data sources, and write it up for a business reader.
Metric: ${input.topic}
Side A: ${input.leftLabel ?? 'A'}
Side B: ${input.rightLabel ?? 'B'}
${input.queryA ? `Side A SQL (use exactly): ${input.queryA}` : 'Generate a Side A SQL with a single numeric result.'}
${input.queryB ? `Side B SQL (use exactly): ${input.queryB}` : 'Generate a Side B SQL with a single numeric result.'}
${input.tables?.length ? `Focus tables: ${input.tables.join(', ')}` : ''}`
    : `You are AiDB Report Agent. You produce the report a business owner reads: conclusions first, numbers you can defend, plain business wording.
Topic: ${input.topic}
Audience: ${audience}${audience === 'executive' ? ' — one page of decisions and risks; no operational detail.' : audience === 'technical' ? ' — engineering detail (query shape, data quality) is welcome.' : ''}
${input.tables?.length ? `Focus tables: ${input.tables.join(', ')}` : ''}`;
  const system = `${header}

${formatPeriodForPrompt(period)}

${REPORT_CRAFT}

## Connections
${connectionsText}

## Schema
${schemaText}
${business ? `\n${business}\n` : ''}
${briefBlock ? `\n${briefBlock}\n` : ''}
${memoriesBlock ? `\n${memoriesBlock}\n` : ''}

Rules:
- Use only read-only tools (inspect_schema, search_objects, run_sql, explain_sql, sample_rows, profile_column, analyze_chart, forecast_chart, render_chart, memory_search, update_plan).
- For 3+ steps, call update_plan first, then call it again after each finished step: mark the step done and the next step doing. Never leave the plan at 0/N while continuing to run tools. Keep the same plan items across updates and only change their statuses; do not replace the plan with a shorter one unless the task scope itself changed.
- Inspect schema before writing SQL when unsure. Keep SQL bounded; use aggregate SQL for summaries.
- Never calculate totals, deltas, ratios or shares by hand. Use one aggregate SQL or analyze_chart; quote its numbers verbatim. The app computes comparison deltas from the submitted left/right values and the metric baseline you supply.
- KPI cards need a reference point: for each headline metric, query its baseline in a second aggregate SQL and submit it as \`baseline\` + \`baselineLabel\` (e.g. 环比 上周 / 同比 去年同期 / 目标). Set \`goodDirection\` to "down" for metrics where a rise is bad (refund rate, complaint rate, latency, cost). The app computes the delta; never submit a delta yourself.
- Numbers must be the exact values returned by a tool. The app abbreviates for display (12,345,678 -> 「1234.57 万」) — never pre-round or re-scale a number yourself, and never write a percentage that was not returned (a 0.1234 ratio stays 0.1234 in the payload).
- Report chart blocks support bar / line / pie / stacked. Choose line for an ordered time axis, bar for category comparisons, stacked for parts-of-a-total across an ordered axis, and pie only for 3–8 non-negative parts of one whole (never for time series or multi-period comparison). Other render_chart types (scatter/heatmap/radar) are for exploration during the turn, not for compose_report blocks; never force them into a pie just to add a chart. For a trend that should show 本期 vs 上期, submit one line chart whose series points each carry a \`baseline\`.
- Time series must be bucketed. Group by a date expression (day / week / month), never by a raw timestamp — one point per row is not a trend.
- Do not join across different sources. Each source is queried separately; if the user asks for a merged total, aggregate per source and label the result.
- ${compare ? 'This is a comparison: use layout comparison and include a comparison block with the two numeric results. Both queries must use the same aggregation and filters; only the compared period/segment may differ.' : 'Choose the layout from the user semantics: sections for per-source sections, comparison for side-by-side comparison, merged for summed totals, mixed for a broad report. Do not ask the user which layout.'}
- The ONLY acceptable completion is a successful compose_report tool call. A plain-text answer is invalid and will be discarded.
- When ready, call compose_report exactly once. Every data block (metric/table/chart/comparison) MUST include resultRef = the tool call id shown in the tool result; every numeric value must come from that referenced result. Use resultRefs when one block draws on several queries. The app rejects missing or wrong references.
- Fill \`executive\` (headline + 3–5 takeaways, each with a real number) and \`assumptions\` (the metric definitions you chose: which time column, which filters, which amount column, units). These are required: a report without a conclusion is a data dump.
- Add one \`actions\` block at the end when the data supports a concrete next step; each action must be executable and verifiable, and must cite the query that justifies it. Omit it when the data does not support a recommendation.
- If the data cannot answer the question, still call compose_report with a narrative-only section that states the concrete missing table/column; do not answer with prose.
- Example KPI block: {"kind":"metric","metrics":[{"label":"订单额","value":1234567.89,"unit":"元","resultRef":"<id>","baseline":1100000.5,"baselineLabel":"环比 上周","baselineResultRef":"<id2>","goodDirection":"up"}]}
- After compose_report succeeds, give one short sentence. Reply in the user's language.`;

  let captured: ReportSpec | undefined;
  let composeError = '';
  const knownNumbers = new Set<number>();
  const toolNumbers = new Map<string, Set<number>>();
  const runtime = new AgentRuntime({
    provider,
    maxSteps: Math.min(40, Math.max(20, (settings.agent.maxSteps || 12) * 2)),
    temperature: settings.agent.temperature,
    generateId: () => randomUUID(),
    tools: providerToolsForReport(),
    getTool: (name) => TOOL_DEFS.get(name),
    buildSystem: () => system,
    requestApproval: async () => ({ decision: 'deny', scope: 'once' }),
    emit: (event) => {
      if (event.type === 'tool_result' && event.tool === 'compose_report' && !event.result.ok) {
        composeError = event.result.error?.message ?? event.result.summary;
      }
    },
    executeTool: async (call, abort) => {
      if (call.name === 'compose_report') {
        const args = call.args as any;
        const numbers = knownNumbers;
        if (typeof args?.title !== 'string' || !args.title.trim()) return invalid('缺少 title');
        const layout: ReportLayout = ['sections', 'comparison', 'merged', 'mixed'].includes(args.layout) ? args.layout : 'sections';
        if (!Array.isArray(args.sections) || !args.sections.length) return invalid('缺少 sections');
        // 摘要是「给老板看」的那一段：没有结论先行的开头，报告就只是一堆数字。
        const headline = typeof args?.executive?.headline === 'string' ? args.executive.headline.trim() : '';
        const rawTakeaways = Array.isArray(args?.executive?.takeaways) ? args.executive.takeaways : [];
        const takeaways = rawTakeaways.map((item: unknown) => String(item ?? '').trim()).filter(Boolean);
        if (!headline) return invalid('缺少 executive.headline：先用一句话给出最重要的结论');
        if (!takeaways.length) return invalid('缺少 executive.takeaways：至少一条带数字的结论');
        const rawRisks = Array.isArray(args?.executive?.risks) ? args.executive.risks : [];
        const risks = rawRisks.map((item: unknown) => String(item ?? '').trim()).filter(Boolean);
        const executive: ReportExecutive = { headline, takeaways, ...(risks.length ? { risks } : {}) };
        const rawAssumptions = Array.isArray(args?.assumptions) ? args.assumptions : [];
        const assumptions = rawAssumptions.map((item: unknown) => String(item ?? '').trim()).filter(Boolean);
        const sections: ReportSection[] = [];
        for (const [index, rawSection] of args.sections.slice(0, 30).entries()) {
          const blocks: ReportBlock[] = [];
          for (const rawBlock of Array.isArray(rawSection?.blocks) ? rawSection.blocks.slice(0, 30) : []) {
            const block = normalizeReportBlock(rawBlock, numbers, toolNumbers, true);
            if ('error' in block) return invalid(`第 ${index + 1} 节：${block.error}`);
            blocks.push(block);
          }
          if (!blocks.length) return invalid(`第 ${index + 1} 节没有任何有效内容块`);
          const conclusion = typeof rawSection?.conclusion === 'string' ? rawSection.conclusion.trim() : '';
          sections.push({
            id: String(rawSection?.id ?? `section-${index + 1}`),
            title: String(rawSection?.title ?? `章节 ${index + 1}`),
            sourceKey: rawSection?.sourceKey === undefined ? undefined : String(rawSection.sourceKey),
            ...(conclusion ? { conclusion } : {}),
            blocks,
          });
        }
        captured = {
          version: 1,
          title: args.title.trim(),
          layout,
          sources: sourceRefs,
          sections,
          executive,
          meta: {
            intent: input.topic,
            createdAt: new Date().toISOString(),
            audience,
            period: { from: period.current.from, to: period.current.to, label: period.current.label, grain: period.grain },
            ...(assumptions.length ? { assumptions } : {}),
            notes: [...(Array.isArray(args.notes) ? args.notes.map(String) : []), compare ? '对比由 Agent 查数，差值由应用计算。' : '报告由 Agent 查数并生成。'],
          },
        };
        return {
          ok: true,
          summary: `报告规格已提交：${sections.length} 个章节`,
          data: { title: captured.title, layout, sections: sections.length },
          meta: { durationMs: 0 },
        };
      }
      const result = await executor.execute(call, {
        sessionId: `report:${input.topic}`,
        connectionId: typeof call.args.connectionId === 'string' ? call.args.connectionId : undefined,
        database: typeof call.args.database === 'string' ? call.args.database : undefined,
        signal: abort,
      });
      if (result.ok && NUMERIC_TOOLS.has(call.name)) {
        const refSet = new Set<number>();
        collectNumbers(result.data, refSet);
        toolNumbers.set(call.id, refSet);
        for (const value of refSet) knownNumbers.add(value);
      }
      return result;
    },
  });

  const result = await runtime.run({
    sessionId: `${compare ? 'compare' : 'report'}:${Date.now()}`,
    userText: input.topic,
    mode: 'readonly',
    environment: 'dev',
    connectionReadonly: false,
    history: [],
    context: {
      connection: schemas[0]?.connection,
      databases: schemas[0]?.schemas,
      sources: schemas.map((item) => ({ connection: item.connection, databases: item.schemas, label: item.label })),
    },
  });
  if (result.status !== 'done') throw Object.assign(new Error(result.error?.message ?? '报告生成失败'), { code: result.error?.code ?? 'MODEL_REPORT_FAILED', status: 502 });
  if (!captured) throw Object.assign(new Error(`模型没有提交报告规格${composeError ? `：${composeError}` : ''}`), { code: 'MODEL_REPORT_FAILED', status: 502 });
  return captured;
}
