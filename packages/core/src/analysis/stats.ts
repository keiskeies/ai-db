/**
 * 图表统计量：全部是纯函数，算术只在服务端算一次，模型只负责把数字写成业务解读。
 * 之所以不让模型自己算：LLM 对聚合数字的可靠性远低于一次 reduce。
 */

export interface StatPoint {
  label: string;
  value: number;
}

export interface SeriesStats {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  argmin: string;
  argmax: string;
}

/** 大小写不敏感地取列值：不同引擎返回的列名大小写并不一致。 */
function pick(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  const lower = column.toLowerCase();
  for (const key of Object.keys(row)) if (key.toLowerCase() === lower) return row[key];
  return undefined;
}

/**
 * 把结果集抽成 (x, y) 序列。
 *
 * ⚠️ 必须先剔除 null / undefined / '' 再做 Number() 转换：`Number(null) === 0`，
 * 直接转换会把 SQL 里的 NULL 变成 0 数据点，静默污染拟合结果（P3 探针实测踩到）。
 */
export function toSeries(rows: Array<Record<string, unknown>>, x: string, y: string): StatPoint[] {
  const out: StatPoint[] = [];
  for (const row of rows ?? []) {
    const rawY = pick(row, y);
    if (rawY === null || rawY === undefined || rawY === '') continue;
    const value = typeof rawY === 'number' ? rawY : Number(String(rawY).trim());
    if (!Number.isFinite(value)) continue;
    const rawX = pick(row, x);
    const label = rawX === null || rawX === undefined ? '' : String(rawX);
    out.push({ label, value });
  }
  return out;
}

/** 自动挑 x / y 列：x 取第一个非数值列，y 取第一个数值列（跳过标识列）。 */
export function guessAxes(columns: string[], rows: Array<Record<string, unknown>>): { x: string; y: string } | null {
  if (!columns.length || !rows.length) return null;
  // 只看首行会踩坑：首行该列可能恰好是 NULL。多扫几行再判定数值列。
  const sample = rows.slice(0, 20);
  const isNumeric = (column: string) => sample.some((row) => {
    const value = pick(row, column);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  });
  const numeric = columns.filter(isNumeric);
  const y = numeric.find((c) => !/(^|_)(id|ids|uuid|guid|key|code|seq|sn|no)$/i.test(c)) ?? numeric[0];
  const x = columns.find((c) => c !== y);
  if (!y || !x) return null;
  return { x, y };
}

export function summarize(points: StatPoint[]): SeriesStats | null {
  if (!points.length) return null;
  let sum = 0;
  let min = points[0].value;
  let max = points[0].value;
  let argmin = points[0].label;
  let argmax = points[0].label;
  for (const point of points) {
    sum += point.value;
    if (point.value < min) { min = point.value; argmin = point.label; }
    if (point.value > max) { max = point.value; argmax = point.label; }
  }
  return { count: points.length, sum, avg: sum / points.length, min, max, argmin, argmax };
}

/** 前 N 项及其占比；总量为 0 时占比记 0，不产 NaN。 */
export function topShare(points: StatPoint[], limit = 5): Array<{ label: string; value: number; share: number }> {
  const total = points.reduce((sum, p) => sum + p.value, 0);
  return [...points]
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((p) => ({ label: p.label, value: p.value, share: total ? p.value / total : 0 }));
}

/** 环比：只在序列长度 ≥2 时有意义；首项没有前值，直接跳过。 */
export function deltas(points: StatPoint[]): Array<{ label: string; value: number; delta: number; ratio: number | null }> {
  const out: Array<{ label: string; value: number; delta: number; ratio: number | null }> = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value;
    const value = points[i].value;
    out.push({ label: points[i].label, value, delta: value - prev, ratio: prev === 0 ? null : (value - prev) / Math.abs(prev) });
  }
  return out;
}

/** Pearson 相关系数；分母为 0（常数序列）时返回 0，不产 NaN。 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (!dx || !dy) return 0;
  return num / Math.sqrt(dx * dy);
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r: number;
  /** 残差标准差，按 n-2 自由度；样本不足或完美拟合时为 0。 */
  residualStd: number;
}

/** 最小二乘 y = intercept + slope·t，t 取 0..n-1。 */
export function linearFit(points: StatPoint[]): LinearFit | null {
  const n = points.length;
  if (n < 2) return null;
  const xs = points.map((_, i) => i);
  const ys = points.map((p) => p.value);
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) * (i - mx);
  }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const err = ys[i] - (intercept + slope * i);
    sse += err * err;
  }
  const dof = n - 2;
  return { slope, intercept, r: pearson(xs, ys), residualStd: dof > 0 ? Math.sqrt(sse / dof) : 0 };
}

/** x 轴是否看起来是时间序列（决定要不要算环比）。支持 2026-01 / 2026年1月 / 2026 / ISO 时间戳。 */
export function isTimeSeries(points: StatPoint[]): boolean {
  if (points.length < 2) return false;
  const dated = points.filter((p) => looksLikeDate(p.label)).length;
  return dated / points.length >= 0.8;
}

function looksLikeDate(label: string): boolean {
  const raw = (label ?? '').trim();
  if (!raw) return false;
  if (/^(19|20)\d{2}[-/]\d{1,2}([-/]\d{1,2})?([T ]|$)/.test(raw)) return true;
  // 中文日期先归一化成 2026-1-5 再比对，避免「2026年1月」这种尾缀单位漏判
  const normalized = raw
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/[.\-/]+/g, '-')
    .replace(/-+$/, '');
  return /^(19|20)\d{2}(-\d{1,2}(-\d{1,2})?)?$/.test(normalized);
}

/** 展示用四舍五入：整数保持整数，小数保留 2 位，避免出现 1234.5600000000002。 */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
