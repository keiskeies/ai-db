import { linearFit, round, type StatPoint } from './stats';

/**
 * 确定性预测：不调模型、不引入图表库，同样输入永远同样输出，可单测对照手算。
 * 模型只负责把这里的数字写成话，不允许自己外推。
 */

export type ForecastMethod = 'auto' | 'linear' | 'moving_average';

export interface ForecastPoint {
  label: string;
  value: number;
  lower: number;
  upper: number;
}

export interface ForecastResult {
  ok: boolean;
  code?: 'NOT_ENOUGH_SAMPLES';
  message?: string;
  method?: 'linear' | 'moving_average';
  /** 拟合度 Pearson r，moving_average 下也给出，便于判断该不该信 */
  r?: number;
  slope?: number;
  window?: number;
  note: string;
  /** 保留原始序列，方便下游继续用（对齐 SQLBot 的返回约定） */
  original: StatPoint[];
  forecast: ForecastPoint[];
}

export interface ForecastOptions {
  /** 外推期数，1-12，默认 3 */
  periods?: number;
  method?: ForecastMethod;
  /** 生成未来点标签；index 是绝对下标，默认渲染成相对期数 "+1" "+2" */
  labelFor?: (index: number, points: StatPoint[]) => string;
}

const MIN_SAMPLES = 4;
/** 1.28σ ≈ 80% 区间；明确是粗略区间，不是置信承诺。 */
const Z = 1.28;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function movingAverageWindow(n: number): number {
  return clamp(Math.floor(n / 2), 2, 4);
}

export function forecastSeries(input: StatPoint[], opts: ForecastOptions = {}): ForecastResult {
  // 调用方可能直接把结果集塞进来，这里再兜一次底：NaN / Infinity 一律丢弃。
  const points = (input ?? []).filter((p) => Number.isFinite(p?.value));
  const n = points.length;
  if (n < MIN_SAMPLES) {
    return {
      ok: false,
      code: 'NOT_ENOUGH_SAMPLES',
      message: `样本不足：只有 ${n} 个有效数据点，至少需要 ${MIN_SAMPLES} 个才能预测。请放宽时间范围或降低分组粒度。`,
      note: '',
      original: points,
      forecast: [],
    };
  }

  const periods = clamp(Math.trunc(opts.periods ?? 3), 1, 12);
  const fit = linearFit(points);
  const r = fit?.r ?? 0;
  const requested = opts.method ?? 'auto';
  const method: 'linear' | 'moving_average' = requested === 'auto' ? (Math.abs(r) >= 0.6 ? 'linear' : 'moving_average') : requested;

  const labelFor = opts.labelFor ?? ((index: number, pts: StatPoint[]) => `+${index - pts.length + 1}`);
  const last = n - 1;

  let sigma = 0;
  const forecast: ForecastPoint[] = [];

  if (method === 'linear' && fit) {
    sigma = fit.residualStd;
    for (let i = 1; i <= periods; i++) {
      const value = fit.intercept + fit.slope * (last + i);
      forecast.push({ label: labelFor(last + i, points), value: round(value), lower: round(value - Z * sigma), upper: round(value + Z * sigma) });
    }
  } else {
    const w = movingAverageWindow(n);
    const tail = points.slice(n - w);
    const mean = tail.reduce((sum, p) => sum + p.value, 0) / w;
    // 移动平均没有回归残差，用尾窗自身波动当区间宽度，否则区间会假装成一个点。
    sigma = Math.sqrt(tail.reduce((sum, p) => sum + (p.value - mean) ** 2, 0) / w);
    for (let i = 1; i <= periods; i++) {
      forecast.push({ label: labelFor(last + i, points), value: round(mean), lower: round(mean - Z * sigma), upper: round(mean + Z * sigma) });
    }
  }

  // σ=0（全同值 / 完美拟合）时区间自然收敛为一点，round 已经把非有限值挡成 0，不会输出 NaN。
  const parts: string[] = [
    method === 'linear'
      ? `方法：线性回归，斜率 ${round(fit?.slope ?? 0, 4)}/期，拟合度 r=${round(r, 3)}`
      : `方法：移动平均，窗口 ${movingAverageWindow(n)} 期，拟合度 r=${round(r, 3)}`,
    `基于 ${n} 个有效数据点外推 ${periods} 期`,
    `区间为 ±${Z}σ 的粗略范围，不是置信承诺`,
  ];
  if (forecast.some((p) => p.value < 0 || p.lower < 0)) {
    parts.push('预测出现负值：若该指标是计数/金额类，实际下限应视为 0');
  }
  if (method === 'moving_average' && requested === 'auto') {
    parts.push(`线性趋势不明显（|r|=${round(Math.abs(r), 3)} < 0.6），因此改用移动平均`);
  }
  if (Math.abs(r) < 0.3) parts.push('历史序列与线性趋势相关性很弱，预测仅供参考');

  return {
    ok: true,
    method,
    r: round(r, 4),
    ...(method === 'linear' ? { slope: round(fit?.slope ?? 0, 6) } : { window: movingAverageWindow(n) }),
    note: parts.join('；'),
    original: points,
    forecast,
  };
}
