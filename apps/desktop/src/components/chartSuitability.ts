import {
  CHART_KIND_LABELS,
  chartSuitability as chartFit,
  recommendChartType,
  type ChartFit,
  type ChartKind,
} from '@aidb/core';
import type { ChartType } from './ChartToolbar';

export type { ChartFit };
export { recommendChartType };

export const CHART_TYPE_NAMES: Record<ChartType, string> = { ...CHART_KIND_LABELS };

export interface ChartSuitabilityInput {
  type: ChartType;
  series: Array<{ label: string; value: number }>;
  extraSeries?: Array<{ name: string; values: number[] }>;
  scatter?: Array<{ x: number; y: number; label?: string }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][]; valueLabel?: string };
  forecast?: Array<{ label: string; value: number; lower: number; upper: number }>;
}

/** 选型规则在 @aidb/core：工具条、Agent 图表与报告图表共用同一份判定。 */
export function chartSuitability(chart: ChartSuitabilityInput): Record<ChartKind, ChartFit> {
  return chartFit(chart);
}
