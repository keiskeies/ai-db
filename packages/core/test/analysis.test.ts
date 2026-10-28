import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deltas,
  forecastSeries,
  guessAxes,
  isTimeSeries,
  linearFit,
  movingAverageWindow,
  pearson,
  round,
  summarize,
  toSeries,
  topShare,
} from '../src/index';

const series = (...values: number[]) => values.map((value, i) => ({ label: `p${i}`, value }));

// ---------- stats ----------

test('toSeries drops SQL NULLs instead of turning them into 0 points', () => {
  const rows = [
    { month: '2026-01', total: null },
    { month: '2026-02', total: 10 },
    { month: '2026-03', total: '' },
    { month: '2026-04', total: 20 },
    { month: '2026-05', total: '30' },
  ];
  const points = toSeries(rows, 'month', 'total');
  assert.deepEqual(points, [
    { label: '2026-02', value: 10 },
    { label: '2026-04', value: 20 },
    { label: '2026-05', value: 30 },
  ]);
  assert.ok(!points.some((p) => p.value === 0), 'NULL 被转成了 0，会静默污染拟合');
});

test('toSeries resolves column names case-insensitively', () => {
  const points = toSeries([{ STATUS: 'PAID', Cnt: 3 }], 'status', 'cnt');
  assert.deepEqual(points, [{ label: 'PAID', value: 3 }]);
});

test('summarize / topShare / deltas give hand-checkable numbers', () => {
  const points = [
    { label: 'a', value: 10 },
    { label: 'b', value: 30 },
    { label: 'c', value: 60 },
  ];
  const stats = summarize(points)!;
  assert.deepEqual(stats, { count: 3, sum: 100, avg: 100 / 3, min: 10, max: 60, argmin: 'a', argmax: 'c' });
  assert.equal(summarize([]), null);

  const top = topShare(points, 2);
  assert.deepEqual(top, [
    { label: 'c', value: 60, share: 0.6 },
    { label: 'b', value: 30, share: 0.3 },
  ]);
  assert.deepEqual(topShare([{ label: 'z', value: 0 }]), [{ label: 'z', value: 0, share: 0 }], '总量为 0 时占比必须是 0 而不是 NaN');

  const d = deltas(points);
  assert.deepEqual(d, [
    { label: 'b', value: 30, delta: 20, ratio: 2 },
    { label: 'c', value: 60, delta: 30, ratio: 1 },
  ]);
  assert.equal(deltas([{ label: 'a', value: 5 }]).length, 0);
  assert.equal(deltas([{ label: 'a', value: 0 }, { label: 'b', value: 7 }])[0].ratio, null, '前值为 0 时环比无定义');
});

test('pearson and linearFit match hand computation', () => {
  assert.equal(round(pearson([0, 1, 2], [0, 1, 2]), 6), 1);
  assert.equal(pearson([0, 1, 2], [5, 5, 5]), 0, '常数序列分母为 0，必须返回 0 而不是 NaN');

  const fit = linearFit(series(10, 20, 30, 40))!;
  assert.equal(round(fit.slope, 6), 10);
  assert.equal(round(fit.intercept, 6), 10);
  assert.equal(round(fit.r, 6), 1);
  assert.equal(fit.residualStd, 0);
  assert.equal(linearFit(series(1)), null);
});

test('guessAxes picks a non-identifier numeric column as the measure', () => {
  const axes = guessAxes(['status', 'cnt'], [{ status: 'PAID', cnt: 3 }]);
  assert.deepEqual(axes, { x: 'status', y: 'cnt' });
  assert.equal(guessAxes([], []), null);
});

test('isTimeSeries recognises date-like labels only', () => {
  assert.ok(isTimeSeries([{ label: '2026-01', value: 1 }, { label: '2026-02', value: 2 }]));
  assert.ok(isTimeSeries([{ label: '2026年1月', value: 1 }, { label: '2026年2月', value: 2 }]));
  assert.ok(isTimeSeries([{ label: '2026年1月5日', value: 1 }, { label: '2026年1月6日', value: 2 }]));
  assert.ok(isTimeSeries([{ label: '2026', value: 1 }, { label: '2027', value: 2 }]));
  assert.ok(isTimeSeries([{ label: '2026-01-05T10:00:00Z', value: 1 }, { label: '2026-01-06T10:00:00Z', value: 2 }]));
  assert.ok(!isTimeSeries([{ label: 'PAID', value: 1 }, { label: 'NEW', value: 2 }]));
  assert.ok(!isTimeSeries([{ label: '12345', value: 1 }, { label: '67890', value: 2 }]), '纯数字 id 不是日期');
  assert.ok(!isTimeSeries([{ label: '2026-01', value: 1 }]), '单点无从判断趋势');
});

// ---------- forecast ----------

test('an exact linear series extrapolates to hand-checkable values with a collapsed band', () => {
  const result = forecastSeries(series(10, 20, 30, 40), { periods: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'linear');
  assert.equal(result.slope, 10);
  assert.equal(result.r, 1);
  assert.deepEqual(result.forecast, [
    { label: '+1', value: 50, lower: 50, upper: 50 },
    { label: '+2', value: 60, lower: 60, upper: 60 },
  ]);
});

test('a flat/no-trend series falls back to moving average', () => {
  const result = forecastSeries(series(100, 0, 100, 0), { periods: 1 });
  assert.equal(result.method, 'moving_average');
  assert.equal(result.window, movingAverageWindow(4));
  assert.equal(result.window, 2);
  assert.equal(result.forecast[0].value, 50, '末窗 [100,0] 的均值');
  assert.ok(result.forecast[0].upper > result.forecast[0].value, '移动平均的区间要反映尾窗波动，不能塌成一个点');
});

test('moving average window is clamped to 2..4', () => {
  assert.deepEqual([4, 5, 6, 8, 20, 100].map(movingAverageWindow), [2, 2, 3, 4, 4, 4]);
});

test('fewer than 4 samples is refused instead of guessed', () => {
  const result = forecastSeries(series(1, 2, 3), { periods: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_ENOUGH_SAMPLES');
  assert.match(result.message!, /只有 3 个/);
  assert.match(result.message!, /至少需要 4 个/);
  assert.deepEqual(result.forecast, []);
  assert.deepEqual(result.original, series(1, 2, 3));
});

test('a constant series produces a point interval, never NaN', () => {
  const result = forecastSeries(series(5, 5, 5, 5), { periods: 3 });
  assert.equal(result.ok, true);
  for (const point of result.forecast) {
    assert.ok(Number.isFinite(point.value) && Number.isFinite(point.lower) && Number.isFinite(point.upper));
    assert.deepEqual([point.lower, point.value, point.upper], [5, 5, 5]);
  }
});

test('NULLs in the input never drag the slope down', () => {
  const rows = [
    { m: '2026-01', v: null },
    { m: '2026-02', v: 10 },
    { m: '2026-03', v: 20 },
    { m: '2026-04', v: 30 },
    { m: '2026-05', v: 40 },
  ];
  const points = toSeries(rows, 'm', 'v');
  const result = forecastSeries(points, { periods: 1 });
  assert.equal(result.original.length, 4, 'NULL 行必须被丢弃，不是变成 0');
  assert.equal(result.method, 'linear');
  assert.equal(result.slope, 10, '若 NULL 被当成 0，斜率会变成 8');
  assert.equal(result.forecast[0].value, 50);
});

test('a negative forecast is flagged in the note rather than silently clamped', () => {
  const result = forecastSeries(series(100, 60, 30, 10), { periods: 2 });
  assert.equal(result.method, 'linear');
  assert.ok(result.forecast.some((p) => p.value < 0), '外推确实应该跨过 0');
  assert.match(result.note, /负值/);
  assert.match(result.note, /下限应视为 0/);
});

test('the note states method, slope or window and fit quality', () => {
  const linear = forecastSeries(series(1, 2, 3, 4), { periods: 1 });
  assert.match(linear.note, /线性回归/);
  assert.match(linear.note, /斜率 1/);
  assert.match(linear.note, /r=1/);
  assert.match(linear.note, /4 个有效数据点/);

  const flat = forecastSeries(series(100, 0, 100, 0), { periods: 1 });
  assert.match(flat.note, /移动平均/);
  assert.match(flat.note, /窗口 2 期/);
  assert.match(flat.note, /线性趋势不明显（\|r\|=0\.447 < 0\.6）/);

  // ys=[0,3,3,0] 的 Pearson r 恰好为 0：对称抛物线，线性趋势完全不成立
  const weak = forecastSeries(series(0, 3, 3, 0), { periods: 1 });
  assert.equal(weak.r, 0);
  assert.match(weak.note, /相关性很弱/);
  assert.match(weak.note, /预测仅供参考/);
});

test('the original series is preserved verbatim for downstream consumers', () => {
  const input = series(4, 8, 12, 16);
  const result = forecastSeries(input, { periods: 1 });
  assert.deepEqual(result.original, input);
  assert.notEqual(result.original, input, '必须是副本，不能让调用方改到内部状态');
});

test('explicit method overrides auto and periods are clamped to 1..12', () => {
  const forced = forecastSeries(series(10, 20, 30, 40), { method: 'moving_average', periods: 1 });
  assert.equal(forced.method, 'moving_average');
  assert.equal(forced.window, 2);

  assert.equal(forecastSeries(series(1, 2, 3, 4), { periods: 99 }).forecast.length, 12);
  assert.equal(forecastSeries(series(1, 2, 3, 4), { periods: 0 }).forecast.length, 1);
});

test('custom labels are used for future points', () => {
  const result = forecastSeries(
    [
      { label: '2026-01', value: 1 },
      { label: '2026-02', value: 2 },
      { label: '2026-03', value: 3 },
      { label: '2026-04', value: 4 },
    ],
    { periods: 2, labelFor: (i, points) => `2026-0${i - points.length + 5}` },
  );
  assert.deepEqual(result.forecast.map((p) => p.label), ['2026-05', '2026-06']);
});

test('non-finite values in the input are filtered before fitting', () => {
  const result = forecastSeries([
    { label: 'a', value: 1 },
    { label: 'b', value: Number.NaN },
    { label: 'c', value: 2 },
    { label: 'd', value: 3 },
    { label: 'e', value: 4 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.original.length, 4);
});

test('round keeps integers clean and never emits NaN', () => {
  assert.equal(round(1234.5600000000002), 1234.56);
  assert.equal(round(10), 10);
  assert.equal(round(Number.NaN), 0);
  assert.equal(round(Number.POSITIVE_INFINITY), 0);
  assert.equal(round(1.005, 2), 1);
});
