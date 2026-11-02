import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPeriodForPrompt,
  formatPeriodForReader,
  grainForSpan,
  parseDateText,
  resolvePeriod,
} from '../src/commands';

// 2026-11-02 是周一，2026-02-28 是闰年前夜，用于覆盖月末/周锚点边界。
const MON = new Date(2026, 10, 2, 9, 30);

function period(topic: string, now: Date = MON) {
  return resolvePeriod({ topic, now });
}

describe('time window resolution', () => {
  it('rejects impossible calendar dates instead of drifting them', () => {
    assert.equal(parseDateText('2026-02-30'), undefined);
    assert.equal(parseDateText('2024-02-29'), '2024-02-29');
    assert.equal(parseDateText('2026-13-01'), undefined);
    assert.equal(parseDateText('26-11-02'), undefined);
    assert.equal(parseDateText(' 2026-11-02 '), '2026-11-02');
  });

  it('anchors 本周 on Monday and compares with the previous week', () => {
    const resolved = period('本周订单与履约情况');
    assert.equal(resolved.current.from, '2026-11-02');
    assert.equal(resolved.current.to, '2026-11-02');
    assert.equal(resolved.partial, true);
    assert.equal(resolved.previous?.from, '2026-10-26');
    assert.equal(resolved.previous?.to, '2026-10-26');
    assert.match(resolved.previous?.label ?? '', /环比 上期/);
  });

  it('gives 上周 a full window when it already ended', () => {
    const resolved = period('上周的退款情况');
    assert.equal(resolved.current.from, '2026-10-26');
    assert.equal(resolved.current.to, '2026-11-01');
    assert.equal(resolved.partial, false);
    assert.equal(resolved.previous?.from, '2026-10-19');
    assert.equal(resolved.previous?.to, '2026-10-25');
  });

  it('prefers the current-period phrase over an offset one in the same topic', () => {
    const resolved = period('本月与上月对比');
    assert.equal(resolved.current.from, '2026-11-01');
    assert.equal(resolved.current.to, '2026-11-02');
    // 上月在基线里已经出现，不需要把它当本期。
    assert.equal(resolved.previous?.from, '2026-10-01');
    assert.equal(resolved.previous?.to, '2026-10-02');
  });

  it('clamps 本月 to today and slices the baseline to the same length', () => {
    const resolved = period('本月销售额');
    assert.equal(resolved.current.from, '2026-11-01');
    assert.equal(resolved.current.to, '2026-11-02');
    assert.equal(resolved.partial, true);
    assert.equal(resolved.previous?.from, '2026-10-01');
    assert.equal(resolved.previous?.to, '2026-10-02');
  });

  it('rolls 上月 back to a full month', () => {
    const resolved = period('上月库存周转');
    assert.equal(resolved.current.from, '2026-10-01');
    assert.equal(resolved.current.to, '2026-10-31');
    assert.equal(resolved.partial, false);
    assert.equal(resolved.previous?.from, '2026-09-01');
    assert.equal(resolved.previous?.to, '2026-09-30');
  });

  it('uses 同比 for yearly windows', () => {
    const resolved = period('今年的履约率');
    assert.equal(resolved.current.from, '2026-01-01');
    assert.equal(resolved.current.to, '2026-11-02');
    assert.equal(resolved.baselineKind, 'year');
    assert.equal(resolved.previous?.from, '2025-01-01');
    assert.equal(resolved.previous?.to, '2025-11-02');
    assert.match(resolved.previous?.label ?? '', /同比 去年同期/);
  });

  it('truncates month arithmetic at month end, including leap years', () => {
    const leap = resolvePeriod({ topic: '本月回款', now: new Date(2024, 2, 31) });
    assert.equal(leap.current.from, '2024-03-01');
    assert.equal(leap.current.to, '2024-03-31');
    assert.equal(leap.previous?.from, '2024-02-01');
    assert.equal(leap.previous?.to, '2024-02-29');
    const plain = resolvePeriod({ topic: '本月回款', now: new Date(2025, 2, 31) });
    assert.equal(plain.previous?.to, '2025-02-28');
    const quarter = resolvePeriod({ topic: '本季度回款', now: new Date(2024, 4, 31) });
    assert.equal(quarter.current.from, '2024-04-01');
    assert.equal(quarter.current.to, '2024-05-31');
    assert.equal(quarter.previous?.from, '2024-01-01');
    // 日历平移而不是补足天数：Q1 只到 2 月 29 日，这正是业务口径里的「同期」。
    assert.equal(quarter.previous?.to, '2024-02-29');
  });

  it('reads 上半年 as the named half-year, not as 去年 or 近 6 个月', () => {
    const resolved = period('上半年营收');
    assert.equal(resolved.current.from, '2026-01-01');
    assert.equal(resolved.current.to, '2026-06-30');
    assert.equal(resolved.partial, false);
    assert.equal(resolved.baselineKind, 'year');
    assert.equal(resolved.previous?.from, '2025-01-01');
    assert.equal(resolved.previous?.to, '2025-06-30');
    assert.match(resolved.current.label, /上半年/);
  });

  it('clamps the current half to today and resolves numbered quarters', () => {
    const h2 = period('下半年毛利');
    assert.equal(h2.current.from, '2026-07-01');
    assert.equal(h2.current.to, '2026-11-02');
    assert.equal(h2.partial, true);
    const q3 = period('第 3 季度回款');
    assert.equal(q3.current.from, '2026-07-01');
    assert.equal(q3.current.to, '2026-09-30');
    assert.equal(q3.previous?.from, '2025-07-01');
    const q2 = period('Q2 新客');
    assert.equal(q2.current.from, '2026-04-01');
    assert.equal(q2.current.to, '2026-06-30');
  });

  it('keeps a future window intact instead of producing an empty range', () => {
    const resolved = period('下周排班');
    assert.equal(resolved.current.from, '2026-11-09');
    assert.equal(resolved.current.to, '2026-11-15');
    // 未来的周期一定不完整（数据还不存在），必须标出来，不能当作完整周期解读。
    assert.equal(resolved.partial, true);
    assert.equal(resolved.previous?.from, '2026-11-02');
    assert.equal(resolved.previous?.to, '2026-11-08');
  });

  it('builds rolling windows with an equal-length baseline', () => {
    const resolved = period('近 30 天活跃用户');
    assert.equal(resolved.current.to, '2026-11-02');
    assert.equal(resolved.current.from, '2026-10-04');
    assert.equal(resolved.previous?.from, '2026-09-04');
    assert.equal(resolved.previous?.to, '2026-10-03');
    assert.equal(resolved.partial, true);
  });

  it('anchors rolling months on the calendar so 近 3 个月 includes this month', () => {
    const resolved = period('近 3 个月订单');
    assert.equal(resolved.current.from, '2026-09-01');
    assert.equal(resolved.current.to, '2026-11-02');
    const span = Math.round((Date.parse(resolved.current.to) - Date.parse(resolved.current.from)) / 86_400_000) + 1;
    assert.equal(resolved.previous?.to, '2026-08-31');
    assert.equal(Math.round((Date.parse(resolved.previous?.to ?? '') - Date.parse(resolved.previous?.from ?? '')) / 86_400_000) + 1, span);
  });

  it('truncates rolling month arithmetic at month end', () => {
    const resolved = resolvePeriod({ topic: '近 1 个月的回款', now: new Date(2024, 2, 15) });
    assert.equal(resolved.current.from, '2024-03-01');
    assert.equal(resolved.current.to, '2024-03-15');
    // 基线是等长的前一段，而不是「上一个整月」——后者会让 3 月只剩 15 天时凭空跌一半。
    assert.equal(resolved.previous?.from, '2024-02-15');
    assert.equal(resolved.previous?.to, '2024-02-29');
  });

  it('falls back to the last 30 days when the topic says nothing about time', () => {
    const resolved = period('数据概览');
    assert.equal(resolved.source, 'default');
    assert.equal(resolved.current.from, '2026-10-04');
    assert.equal(resolved.current.to, '2026-11-02');
    assert.equal(resolved.previous?.from, '2026-09-04');
    assert.equal(resolved.previous?.to, '2026-10-03');
    assert.equal(resolved.partial, true);
  });

  it('accepts explicit ranges from the period slot and ignores topic phrases', () => {
    const resolved = resolvePeriod({ period: { from: '2026-08-01', to: '2026-08-31' }, topic: '本周订单', now: MON });
    assert.equal(resolved.source, 'explicit');
    assert.equal(resolved.current.from, '2026-08-01');
    assert.equal(resolved.current.to, '2026-08-31');
    // 31 天的窗口，基线就是紧挨着的前 31 天（整个 7 月）。
    assert.equal(resolved.previous?.from, '2026-07-01');
    assert.equal(resolved.previous?.to, '2026-07-31');
  });

  it('reads textual and array period slots', () => {
    const dashed = resolvePeriod({ period: '2026-07-01 ~ 2026-07-31', topic: '本周订单', now: MON });
    assert.equal(dashed.current.from, '2026-07-01');
    assert.equal(dashed.current.to, '2026-07-31');
    const arrayed = resolvePeriod({ period: ['2026-07-01', '2026-07-31'], now: MON });
    assert.equal(arrayed.current.from, '2026-07-01');
    const monthOnly = resolvePeriod({ period: '2026-06', now: MON });
    assert.equal(monthOnly.current.from, '2026-06-01');
    assert.equal(monthOnly.current.to, '2026-06-30');
    const swapped = resolvePeriod({ period: { from: '2026-08-31', to: '2026-08-01' }, now: MON });
    assert.equal(swapped.current.from, '2026-08-01');
    assert.equal(swapped.current.to, '2026-08-31');
  });

  it('ignores a malformed period slot and keeps resolving from the topic', () => {
    const resolved = resolvePeriod({ period: { from: '2026-02-30', to: 'nope' }, topic: '本月销售额', now: MON });
    assert.equal(resolved.current.from, '2026-11-01');
    assert.notEqual(resolved.source, 'explicit');
  });

  it('suggests a bucket grain that keeps trend lines readable', () => {
    assert.equal(grainForSpan('2026-11-01', '2026-11-02', 'month'), 'day');
    assert.equal(grainForSpan('2026-09-01', '2026-11-02', 'month'), 'month');
    assert.equal(grainForSpan('2026-10-26', '2026-11-01', 'week'), 'day');
    assert.equal(grainForSpan('2026-01-01', '2026-11-02', 'year'), 'month');
    assert.equal(grainForSpan('2020-01-01', '2026-11-02', 'year'), 'year');
    assert.equal(period('近 30 天活跃用户').grain, 'day');
    assert.equal(period('近 8 周留存').grain, 'week');
  });

  it('prints a prompt block that carries the boundaries and the partial caveat', () => {
    const resolved = period('本月销售额');
    const prompt = formatPeriodForPrompt(resolved);
    assert.match(prompt, /2026-11-01 ~ 2026-11-02/);
    assert.match(prompt, /2026-10-01 ~ 2026-10-02/);
    assert.match(prompt, /本期尚未结束/);
    assert.match(prompt, /今天：2026-11-02/);
    assert.match(formatPeriodForPrompt(period('上月销售额')), /本期已完整结束/);
  });

  it('summarises the window for the reader footnote', () => {
    assert.equal(
      formatPeriodForReader(period('本月销售额')),
      '统计区间 2026-11-01 ~ 2026-11-02（本期未结束），对比环比 上期',
    );
    assert.equal(formatPeriodForReader(period('上月销售额')), '统计区间 2026-10-01 ~ 2026-10-31，对比环比 上期');
  });

  it('accepts an injected clock string as well as a Date', () => {
    assert.equal(resolvePeriod({ topic: '本月', now: '2026-05-06' }).current.to, '2026-05-06');
    assert.equal(resolvePeriod({ topic: '本月', now: '2026-05-06T18:00:00' }).current.to, '2026-05-06');
  });
});
