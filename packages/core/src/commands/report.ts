import type { ReportBrief } from './reportBrief';

export type ReportLayout = 'sections' | 'comparison' | 'merged' | 'mixed';

export interface ReportSourceRef {
  key: string;
  connectionId: string;
  connectionName: string;
  database?: string;
  engine: string;
  label: string;
}

/**
 * 涨跌方向的业务语义：决定配色，而不是数字正负。
 * 退款率、客诉率上升是坏事，按符号上色会把风险显示成好消息。
 */
export type MetricDirection = 'up' | 'down' | 'neutral';

export interface ReportDelta {
  absolute: number;
  percent: number | null;
  /** 与 absolute 同源；差值由应用按 baseline 计算，模型不手写。 */
  direction?: MetricDirection;
}

export interface ReportMetric {
  label: string;
  value: number | string;
  unit?: string;
  source?: string;
  /** 产生该数字的工具调用 id；compose_report 用它做来源校验。 */
  resultRef?: string;
  /** 对比基线的值（上一周期、去年同期或目标值），必须同样来自工具结果。 */
  baseline?: number;
  /** 基线叫什么，例如「环比 上周」「同比 去年同期」「目标」。 */
  baselineLabel?: string;
  /** 基线数字来自哪次工具调用；缺省沿用 resultRef。 */
  baselineResultRef?: string;
  /** 由应用从 value/baseline 计算，模型不需要（也不应该）提供。 */
  delta?: ReportDelta;
  /** 该指标涨是好还是跌是好，缺省 up。 */
  goodDirection?: MetricDirection;
  /**
   * 主基线（环比）之外的补充基线，例如同比去年同期、上期日均。
   * 只有一条基线时读者无法判断这是季节波动还是趋势变化。
   */
  alternativeBaselines?: Array<{ label: string; value?: number; resultRef?: string; delta?: ReportDelta }>;
}

export interface ReportChartPoint {
  label: string;
  value: number;
  /** 同刻度的基线值（例如上期），用于「本期 vs 上期」双折线。 */
  baseline?: number;
  /** 基线数字来自哪次工具调用；缺省沿用所在 chart block 的 resultRef。 */
  baselineResultRef?: string;
}

export type ReportChartType = 'bar' | 'line' | 'pie' | 'stacked' | 'scatter' | 'heatmap' | 'radar';

export interface ReportChartExtraSeries {
  name: string;
  values: number[];
}

export interface ReportScatterPoint {
  x: number;
  y: number;
  label?: string;
}

export interface ReportHeatmap {
  xLabels: string[];
  yLabels: string[];
  values: number[][];
  valueLabel?: string;
}

export interface ReportActionItem {
  /** 建议本身，必须可执行、可验证。 */
  text: string;
  /** 支撑该建议的数字来自哪次工具调用。 */
  resultRef?: string;
  /** 预期影响，例如「约可挽回 3% 的履约超时」。 */
  impact?: string;
  /** 建议由谁跟进；模型只在数据/用户上下文里能判断时才填。 */
  owner?: string;
  /** 多快该做完，例如「本周内」。 */
  due?: string;
}

export interface ReportBlock {
  kind: 'narrative' | 'metric' | 'table' | 'chart' | 'comparison' | 'callout' | 'actions';
  title?: string;
  /** 该数据块绑定的工具调用 id；compose_report 用它做来源校验。 */
  resultRef?: string;
  /** 一个块由多次查询共同支撑时使用（例如本期与上期两条折线）。 */
  resultRefs?: string[];
  text?: string;
  tone?: 'info' | 'warning' | 'danger';
  metrics?: ReportMetric[];
  columns?: string[];
  rows?: Array<Array<string | number | null>>;
  /** 哪些列是度量列：导出与渲染按数字处理（千分位、右对齐），而不是当文本。 */
  measureColumns?: string[];
  chartType?: ReportChartType;
  /** 折线/柱状的基线系列名，例如「上期」。 */
  baselineName?: string;
  xLabel?: string;
  yLabel?: string;
  series?: ReportChartPoint[];
  extraSeries?: ReportChartExtraSeries[];
  stacked?: boolean;
  dualAxis?: boolean;
  scatter?: ReportScatterPoint[];
  heatmap?: ReportHeatmap;
  left?: ReportMetric;
  right?: ReportMetric;
  delta?: ReportDelta;
  goodDirection?: MetricDirection;
  /** 口径说明：统计范围、过滤条件、单位。作为脚注呈现，不进正文。 */
  note?: string;
  /** 建议清单（kind = 'actions'）。 */
  actions?: ReportActionItem[];
}

export interface ReportSection {
  id: string;
  title: string;
  sourceKey?: string;
  /** 本节结论，先行一句话；渲染在该节数据之前。 */
  conclusion?: string;
  blocks: ReportBlock[];
}

/**
 * 一次工具查询的证据。报告里的每个数字都通过 resultRef 指向这里，
 * 于是「这个数字哪来的」在报告生成之后仍然是可以回答的问题——
 * 读者点开卡片能看到 SQL、行数、耗时与是否被截断，两次运行之间还能比对口径是否漂移。
 */
export interface ReportEvidence {
  /** 工具调用 id，与 block 上的 resultRef 对应。 */
  ref: string;
  tool: string;
  /** 给读者看的口径描述：Agent 报告里是实际执行的 SQL，确定性报告里是统计描述。 */
  sql?: string;
  /** 查询参数摘要（表名、分组列等），不含连接凭据。 */
  args?: Record<string, string | number | boolean>;
  rowCount?: number;
  /** 结果是否被行数上限截断：截断后的聚合值不能当总体值读。 */
  truncated?: boolean;
  durationMs?: number;
  ranAt: string;
}

/** 报告开头的管理层摘要：先看结论，再看数据。 */
export interface ReportExecutive {
  headline: string;
  takeaways: string[];
  /** 本期最需要注意的风险或机会。 */
  risks?: string[];
}

export interface ReportSpec {
  version: 1;
  title: string;
  layout: ReportLayout;
  sources: ReportSourceRef[];
  sections: ReportSection[];
  executive?: ReportExecutive;
  meta: {
    intent: string;
    createdAt: string;
    /** 报告覆盖的时间窗，由网关按 period 解析后写入。 */
    period?: { from: string; to: string; label?: string; grain?: string };
    /** 报告脚注里给读者看的一句话。 */
    audience?: 'executive' | 'business' | 'technical';
    /** 生成报告时的口径假设，例如「订单=已支付，剔除退款」。 */
    assumptions?: string[];
    notes?: string[];
    /**
     * 渲染文案的语言：deck / PPTX / Excel 由网关生成，没有 React 的 t() 可用，
     * 只能靠这里决定中英。正文内容永远跟着模型输出的语言，这里只管子生成器的标签。
     */
    locale?: 'zh' | 'en';
    /** 数字的证据链：resultRef → 产生它的查询。 */
    evidence?: Record<string, ReportEvidence>;
    /**
     * 报告是降级产物时写明原因（例如 Agent 失败回退确定性统计）。
     * UI 必须显式标出来——降级报告长得和正常报告一样，是对读者的误导。
     */
    degraded?: string;
    /** 质量闸口的非阻断提示：结构合法但写作质量有欠缺的地方，如实告诉读者。 */
    qualityNotes?: string[];
    /** 本轮需求扩写、schema grounding 与分析计划。 */
    brief?: ReportBrief;
    /** 数据形状不支持某项分析时的具体说明。 */
    coverageExceptions?: string[];
  };
}

/** 中文业务报表的读数以「万 / 亿」为单位缩写；>=1 万才有必要。 */
const ZH_ABBREVIATE_MIN = 10_000;

/**
 * 把权威原值格式化成业务人员能一眼读完的文本。
 * 原值永远不被改写：缩放只发生在展示层，鼠标悬停与导出仍可拿到全精度。
 */
export function formatReportNumber(value: number, locale: 'zh' | 'en' = 'zh'): { text: string; exact: string; abbreviated: boolean } {
  const exact = value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 });
  if (!Number.isFinite(value) || Math.abs(value) < ZH_ABBREVIATE_MIN) return { text: exact, exact, abbreviated: false };
  if (locale === 'zh') {
    const yi = value / 100_000_000;
    if (Math.abs(yi) >= 1) return { text: `${trimScale(yi)} 亿`, exact, abbreviated: true };
    const wan = value / 10_000;
    return { text: `${trimScale(wan)} 万`, exact, abbreviated: true };
  }
  const millions = value / 1_000_000;
  if (Math.abs(millions) >= 1) return { text: `${trimScale(millions)}M`, exact, abbreviated: true };
  const thousands = value / 1_000;
  return { text: `${trimScale(thousands)}K`, exact, abbreviated: true };
}

function trimScale(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, '');
}

/** 差值由应用计算：模型只提交本期与基线两个权威数字。 */
export function computeMetricDelta(value: number, baseline: number): ReportDelta {
  const absolute = value - baseline;
  return {
    absolute,
    percent: baseline ? (absolute / Math.abs(baseline)) * 100 : null,
  };
}

/** 涨得好不好看，取决于业务方向，而不是数字正负。 */
export function deltaIsGood(delta: number, goodDirection: MetricDirection = 'up'): 'good' | 'bad' | 'neutral' {
  if (delta === 0 || goodDirection === 'neutral') return 'neutral';
  return delta > 0 === (goodDirection === 'up') ? 'good' : 'bad';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isReportMetric(value: unknown): boolean {
  if (!isRecord(value) || typeof value.label !== 'string' || !(['number', 'string'].includes(typeof value.value))) return false;
  if (value.baseline !== undefined && typeof value.baseline !== 'number') return false;
  if (value.alternativeBaselines !== undefined && (!Array.isArray(value.alternativeBaselines) || !value.alternativeBaselines.every((item) => isRecord(item) && typeof item.label === 'string'))) return false;
  return true;
}

function isReportBlock(value: unknown): boolean {
  if (!isRecord(value) || !['narrative', 'metric', 'table', 'chart', 'comparison', 'callout', 'actions'].includes(String(value.kind))) return false;
  if (value.resultRefs !== undefined && !isStringArray(value.resultRefs)) return false;
  if (value.metrics !== undefined && (!Array.isArray(value.metrics) || !value.metrics.every(isReportMetric))) return false;
  if (value.columns !== undefined && !isStringArray(value.columns)) return false;
  if (value.rows !== undefined && (!Array.isArray(value.rows) || !value.rows.every((row) => Array.isArray(row) && row.every((cell) => cell === null || ['string', 'number'].includes(typeof cell))))) return false;
  if (value.series !== undefined && (!Array.isArray(value.series) || !value.series.every((point) => isRecord(point) && typeof point.label === 'string' && typeof point.value === 'number' && Number.isFinite(point.value)))) return false;
  if (value.extraSeries !== undefined && (!Array.isArray(value.extraSeries) || !value.extraSeries.every((series) => isRecord(series) && typeof series.name === 'string' && Array.isArray(series.values) && series.values.every((item) => typeof item === 'number' && Number.isFinite(item))))) return false;
  if (value.scatter !== undefined && (!Array.isArray(value.scatter) || !value.scatter.every((point) => isRecord(point) && typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)))) return false;
  if (value.heatmap !== undefined) {
    if (!isRecord(value.heatmap) || !isStringArray(value.heatmap.xLabels) || !isStringArray(value.heatmap.yLabels)) return false;
    if (!Array.isArray(value.heatmap.values) || !value.heatmap.values.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'number' && Number.isFinite(cell)))) return false;
  }
  if (value.left !== undefined && !isReportMetric(value.left)) return false;
  if (value.right !== undefined && !isReportMetric(value.right)) return false;
  if (value.actions !== undefined && (!Array.isArray(value.actions) || !value.actions.every((action) => isRecord(action) && typeof action.text === 'string'))) return false;
  return true;
}

function isReportBrief(value: unknown): boolean {
  if (!isRecord(value) || typeof value.objective !== 'string' || !isStringArray(value.questions) || !isStringArray(value.analyses)) return false;
  if (!isRecord(value.coverage) || !isRecord(value.grounding) || !Array.isArray(value.grounding.tables) || !Array.isArray(value.grounding.joins) || !Array.isArray(value.grounding.businessTerms)) return false;
  if (!Array.isArray(value.plan) || !value.plan.every((step) => isRecord(step) && typeof step.id === 'string' && typeof step.title === 'string' && isStringArray(step.tables) && isStringArray(step.columns) && typeof step.deliverable === 'string')) return false;
  return true;
}

/** 持久化产物可能来自旧版本或损坏写入，渲染前必须确认所有会被遍历的数组存在。 */
export function isReportSpec(value: unknown): value is ReportSpec {
  if (!isRecord(value) || value.version !== 1 || typeof value.title !== 'string' || typeof value.layout !== 'string') return false;
  if (!Array.isArray(value.sources) || !value.sources.every((source) => isRecord(source) && typeof source.label === 'string' && typeof source.engine === 'string')) return false;
  if (!Array.isArray(value.sections) || !value.sections.every((section) => isRecord(section) && typeof section.id === 'string' && typeof section.title === 'string' && Array.isArray(section.blocks) && section.blocks.every(isReportBlock))) return false;
  if (!isRecord(value.meta) || typeof value.meta.intent !== 'string' || typeof value.meta.createdAt !== 'string') return false;
  if (!isOptionalStringArray(value.meta.assumptions) || !isOptionalStringArray(value.meta.notes) || !isOptionalStringArray(value.meta.qualityNotes) || !isOptionalStringArray(value.meta.coverageExceptions)) return false;
  if (value.meta.period !== undefined && (!isRecord(value.meta.period) || typeof value.meta.period.from !== 'string' || typeof value.meta.period.to !== 'string')) return false;
  if (value.meta.brief !== undefined && !isReportBrief(value.meta.brief)) return false;
  if (value.executive !== undefined && (!isRecord(value.executive) || typeof value.executive.headline !== 'string' || !isStringArray(value.executive.takeaways) || !isOptionalStringArray(value.executive.risks))) return false;
  return true;
}
