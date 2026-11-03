import { isTimeSeries } from './stats';

/**
 * 图表类型与数据形态的唯一判定口径。
 * 前端工具条、Agent 的 render_chart、报告图表都必须读这一份，
 * 否则会出现「工具记录说饼图、实际渲染成柱状图」这类不一致。
 */

export type ChartKind = 'bar' | 'stacked' | 'line' | 'pie' | 'scatter' | 'heatmap' | 'radar';

export interface ChartFitPoint {
  label: string;
  value: number;
}

export interface ChartFitSeries {
  name: string;
  values: number[];
}

export interface ChartFitInput {
  series?: ChartFitPoint[];
  extraSeries?: ChartFitSeries[];
  scatter?: Array<{ x: number; y: number; label?: string }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values?: number[][] };
  forecast?: Array<unknown>;
}

export interface ChartFit {
  ok: boolean;
  reason?: string;
}

export const CHART_KIND_LABELS: Record<ChartKind, string> = {
  bar: '柱状图',
  stacked: '堆叠柱状图',
  line: '折线图',
  pie: '饼图',
  scatter: '散点图',
  heatmap: '热力图',
  radar: '雷达图',
};

export function chartSuitability(chart: ChartFitInput): Record<ChartKind, ChartFit> {
  const series = chart.series ?? [];
  const extras = (chart.extraSeries ?? []).filter((entry) => entry.values.length === series.length);
  const categories = series.length;
  const values = series.flatMap((point, index) => [point.value, ...extras.map((extra) => extra.values[index] ?? 0)]);
  const nonNegative = values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0);
  const numbers = series.map((point) => Number(point.label));
  const numericLabels = series.length >= 2 && numbers.every((value, index) => Number.isFinite(value) && String(series[index].label).trim() !== '');
  const numericOrdered =
    numericLabels &&
    (numbers.every((value, index) => index === 0 || value > numbers[index - 1]) ||
      numbers.every((value, index) => index === 0 || value < numbers[index - 1]));
  const ordered = numericOrdered || (series.length >= 2 && isTimeSeries(series));
  const hasForecast = Boolean(chart.forecast?.length);
  const scatterPoints = chart.scatter?.length ?? 0;
  const hasHeatmap = Boolean(chart.heatmap?.xLabels.length && chart.heatmap?.yLabels.length);
  const fit = (ok: boolean, reason?: string): ChartFit => ({ ok, reason });

  return {
    bar: fit(categories > 0, '没有可展示的数据点'),
    line: fit(series.length >= 2 && ordered, 'X 轴不是有序的时间或数值序列'),
    stacked: fit(categories > 0 && extras.length >= 1 && nonNegative, extras.length ? '包含负值，无法堆叠' : '只有一个度量列'),
    pie: fit(
      categories >= 3 && categories <= 8 && extras.length === 0 && nonNegative && !hasForecast,
      hasForecast
        ? '时间序列不适合用饼图表示占比'
        : extras.length
          ? '包含多个度量列，无法计算占比'
          : categories > 8
            ? `分类有 ${categories} 个，饼图最多 8 个`
            : categories < 3
              ? '分类少于 3 个'
              : '包含负值',
    ),
    scatter: fit(scatterPoints >= 2 || numericLabels, scatterPoints > 0 ? '散点不足 2 个数据点' : '没有两个数值列'),
    heatmap: fit(hasHeatmap, '缺少两个分类维度和数值度量'),
    radar: fit(
      categories >= 3 && categories <= 8 && !ordered && nonNegative,
      categories > 8 ? '类别超过 8 个' : categories < 3 ? '类别少于 3 个' : ordered ? '有序时间轴不适合雷达图' : '包含负值',
    ),
  };
}

export function recommendChartType(fit: Record<ChartKind, ChartFit>): ChartKind | undefined {
  if (fit.line.ok) return 'line';
  if (fit.bar.ok) return 'bar';
  return (['pie', 'radar', 'stacked', 'scatter', 'heatmap'] as ChartKind[]).find((type) => fit[type].ok);
}
