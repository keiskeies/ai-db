import { isTimeSeries } from '@aidb/core';
import type { ChartType } from './ChartToolbar';

export type ChartFit = { ok: boolean; reason?: string };

export const CHART_TYPE_NAMES: Record<ChartType, string> = {
  bar: '柱状图',
  stacked: '堆叠柱状图',
  line: '折线图',
  pie: '饼图',
  scatter: '散点图',
  heatmap: '热力图',
  radar: '雷达图',
};

export interface ChartSuitabilityInput {
  type: ChartType;
  series: Array<{ label: string; value: number }>;
  extraSeries?: Array<{ name: string; values: number[] }>;
  scatter?: Array<{ x: number; y: number; label?: string }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][]; valueLabel?: string };
  forecast?: Array<{ label: string; value: number; lower: number; upper: number }>;
}

/** 根据数据形状判断每种图是否有意义，工具条据此禁用不适配的类型。 */
export function chartSuitability(chart: ChartSuitabilityInput): Record<ChartType, ChartFit> {
  const series = chart.series ?? [];
  const extras = (chart.extraSeries ?? []).filter((entry) => entry.values.length === series.length);
  const categories = series.length;
  const values = series.flatMap((point, index) => [point.value, ...extras.map((extra) => extra.values[index] ?? 0)]);
  const nonNegative = values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0);
  const numbers = series.map((point) => Number(point.label));
  const numericLabels = series.length >= 2 && numbers.every((value, index) => Number.isFinite(value) && String(series[index].label).trim() !== '');
  const numericOrdered = numericLabels && (numbers.every((value, index) => index === 0 || value > numbers[index - 1]) || numbers.every((value, index) => index === 0 || value < numbers[index - 1]));
  const ordered = numericOrdered || (series.length >= 2 && isTimeSeries(series));
  const hasForecast = Boolean(chart.forecast?.length);
  const scatterPoints = chart.scatter?.length ?? 0;
  const hasHeatmap = Boolean(chart.heatmap?.xLabels.length && chart.heatmap?.yLabels.length);
  const fit = (ok: boolean, reason?: string): ChartFit => ({ ok, reason });

  return {
    bar: fit(categories > 0, '没有可展示的数据点'),
    line: fit(series.length >= 2 && ordered, 'X 轴不是有序的时间或数值序列'),
    stacked: fit(categories > 0 && extras.length >= 1 && nonNegative, extras.length ? '包含负值，无法堆叠' : '只有一个度量列'),
    pie: fit(categories >= 3 && categories <= 8 && extras.length === 0 && nonNegative && !hasForecast,
      hasForecast ? '时间序列不适合用饼图表示占比'
        : extras.length ? '包含多个度量列，无法计算占比'
          : categories > 8 ? `分类有 ${categories} 个，饼图最多 8 个`
            : categories < 3 ? '分类少于 3 个'
              : '包含负值'),
    scatter: fit(scatterPoints >= 2 || numericLabels, scatterPoints > 0 ? '散点不足 2 个数据点' : '没有两个数值列'),
    heatmap: fit(hasHeatmap, '缺少两个分类维度和数值度量'),
    radar: fit(categories >= 3 && categories <= 8 && !ordered && nonNegative,
      categories > 8 ? '类别超过 8 个'
        : categories < 3 ? '类别少于 3 个'
          : ordered ? '有序时间轴不适合雷达图'
            : '包含负值'),
  };
}

export function recommendChartType(fit: Record<ChartType, ChartFit>): ChartType | undefined {
  if (fit.line.ok) return 'line';
  if (fit.bar.ok) return 'bar';
  return (['pie', 'radar', 'stacked', 'scatter', 'heatmap'] as ChartType[]).find((type) => fit[type].ok);
}
