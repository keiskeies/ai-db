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
}

export interface ReportChartPoint {
  label: string;
  value: number;
  /** 同刻度的基线值（例如上期），用于「本期 vs 上期」双折线。 */
  baseline?: number;
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
  chartType?: 'bar' | 'line' | 'pie' | 'stacked';
  /** 折线/柱状的基线系列名，例如「上期」。 */
  baselineName?: string;
  series?: ReportChartPoint[];
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
    /** 阅读对象：管理层 / 业务 / 技术，影响排版与信息密度。 */
    audience?: 'executive' | 'business' | 'technical';
    /** 生成报告时的口径假设，例如「订单=已支付，剔除退款」。 */
    assumptions?: string[];
    notes?: string[];
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
