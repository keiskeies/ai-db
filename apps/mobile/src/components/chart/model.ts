import type { ChartKind } from '@aidb/core';
import { BarChart3, Grid3x3, Layers, LineChart, PieChart, Radar, ScatterChart } from 'lucide-react-native';
import { chartPalette } from '../../theme';

export interface MobileInsightAnalysis {
  rowCount: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  argmin: string;
  argmax: string;
  topShare: Array<{ label: string; value: number; share: number }>;
  deltas: Array<{ label: string; value: number; delta: number; ratio: number | null }>;
  isTimeSeries: boolean;
}

export interface ChartShape {
  type?: string;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  sql?: string;
  series?: Array<{ label: string; value: number; baseline?: number }>;
  baselineName?: string;
  extraSeries?: Array<{ name: string; values: number[] }>;
  stacked?: boolean;
  dualAxis?: boolean;
  scatter?: Array<{ x: number; y: number; label?: string }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][]; valueLabel?: string };
  forecast?: Array<{ label: string; value: number; lower: number; upper: number }>;
  note?: string;
}

export const CHART_COLORS = chartPalette;

export const CHART_TYPES: Array<{ value: ChartKind; label: string; icon: typeof BarChart3 }> = [
  { value: 'bar', label: '柱状', icon: BarChart3 },
  { value: 'stacked', label: '堆叠', icon: Layers },
  { value: 'line', label: '折线', icon: LineChart },
  { value: 'pie', label: '饼图', icon: PieChart },
  { value: 'scatter', label: '散点', icon: ScatterChart },
  { value: 'heatmap', label: '热力', icon: Grid3x3 },
  { value: 'radar', label: '雷达', icon: Radar },
];

export const normalizeChartType = (value?: string): ChartKind =>
  value && CHART_TYPES.some((item) => item.value === value) ? (value as ChartKind) : 'bar';

const chartCharWidth = (char: string, size: number): number =>
  /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(char) ? size : size * 0.56;

export const chartLabelWidth = (text: string, size: number): number =>
  Array.from(text).reduce((sum, char) => sum + chartCharWidth(char, size), 0);

const CHART_DATE_LABEL = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?[日号]?$/;

/** 日期轴永不截断；其余标签按可用像素宽度裁切，避免旋转后互相压字。 */
export const fitChartLabel = (label: string, maxWidth: number): string => {
  if (!Number.isFinite(maxWidth) || CHART_DATE_LABEL.test(label) || chartLabelWidth(label, 8) <= maxWidth) return label;
  let used = 0;
  let kept = '';
  for (const char of label) {
    const width = chartCharWidth(char, 8);
    if (used + width > maxWidth - 4) break;
    used += width;
    kept += char;
  }
  return kept ? `${kept}…` : label.slice(0, 1);
};

export const compactNumber = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${+(value / 1e8).toFixed(1)}亿`;
  if (abs >= 1e4) return `${+(value / 1e4).toFixed(1)}万`;
  if (abs >= 1e3) return `${+(value / 1e3).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return String(+value.toFixed(2));
};

export interface ChartSelection {
  label: string;
  index?: number;
  entries: Array<{ name: string; value: string; color: string }>;
}

export const formatMetric = (value: number): string =>
  Number.isFinite(value) && !Number.isInteger(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : Number(value).toLocaleString();
