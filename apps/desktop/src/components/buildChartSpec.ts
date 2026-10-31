import type { ChartSpec } from './ChartView';
import type { ChartType } from './ChartToolbar';

/** 组图只需要三件事：列名、行值、来源 SQL。QueryView 的结果集与仪表板卡片的刷新返回都满足它。 */
export interface ChartDataset {
  columns: Array<{ name: string }>;
  rows: unknown[][];
  statement?: string;
}

export interface BuildChartSpecInput {
  data: ChartDataset | null | undefined;
  type: ChartType;
  x?: string;
  y?: string;
  extraY?: string[];
  dualAxis?: boolean;
  title?: string;
}

const POINT_LIMIT = 24;
const SCATTER_POINT_LIMIT = 200;

/** 单元格是否可当作数值；严格模式排除 null 与空串，避免把缺失值画成 0。 */
export function isNumericCell(value: unknown, strict = false): boolean {
  if (strict) {
    if (typeof value === 'number') return Number.isFinite(value);
    if (value === null || value === undefined) return false;
    const text = String(value).trim();
    return text !== '' && Number.isFinite(Number(text));
  }
  return Number.isFinite(Number(value));
}

export function numericColumnNames(data: ChartDataset | null | undefined, strict = false): string[] {
  if (!data) return [];
  return data.columns
    .filter((_, index) => data.rows.some((row) => isNumericCell(row[index], strict)))
    .map((column) => column.name);
}

/**
 * 结果集 → ChartSpec。列选择规则与 QueryView 历史上保持一致：
 * x 回退到首列，y 回退到第一个数值列（跳过首列，避免拿分类列当度量）。
 */
export function buildChartSpec(input: BuildChartSpecInput): ChartSpec | null {
  const { data, type, extraY = [], dualAxis = false } = input;
  if (!data || !data.columns.length || !data.rows.length) return null;
  const names = data.columns.map((column) => column.name);
  const fallbackX = names[0];
  const numericIndex = data.columns.findIndex((_, index) => data.rows.some((row) => isNumericCell(row[index])));
  const effectiveX = input.x && names.includes(input.x) ? input.x : fallbackX;
  const effectiveY =
    input.y && names.includes(input.y)
      ? input.y
      : names[numericIndex > 0 ? numericIndex : Math.min(1, names.length - 1)];
  if (!effectiveX || !effectiveY || effectiveX === effectiveY) return null;
  const xIndex = names.indexOf(effectiveX);
  const yIndex = names.indexOf(effectiveY);
  const extraColumns = extraY
    .filter((name) => name !== effectiveY && names.includes(name))
    .map((name) => ({ name, index: names.indexOf(name) }));
  const points = data.rows
    .slice(0, type === 'scatter' ? SCATTER_POINT_LIMIT : POINT_LIMIT)
    .map((row) => ({
      label: String(row[xIndex] ?? '—'),
      value: Number(row[yIndex]),
      extras: extraColumns.map((column) => {
        const value = Number(row[column.index]);
        return Number.isFinite(value) ? value : 0;
      }),
    }))
    .filter((point) => Number.isFinite(point.value));
  if (!points.length) return null;
  return {
    type,
    title: input.title ?? `${effectiveY} by ${effectiveX}`,
    xLabel: effectiveX,
    yLabel: effectiveY,
    sql: data.statement,
    series: points.map((point) => ({ label: point.label, value: point.value })),
    extraSeries: extraColumns.length
      ? extraColumns.map((column, offset) => ({ name: column.name, values: points.map((point) => point.extras[offset]) }))
      : undefined,
    stacked: type === 'stacked' || undefined,
    dualAxis: dualAxis || undefined,
  };
}
