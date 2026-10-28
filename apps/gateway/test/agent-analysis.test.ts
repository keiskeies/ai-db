import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '@aidb/core';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

const home = mkdtempSync(join(tmpdir(), 'aidb-analysis-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'analysis-secret',
  token: 'analysis-token',
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());
const demo = gateway.store.listConnections().find((c) => /demo/i.test(c.name))!;
assert.ok(demo, 'demo connection must exist');

async function run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return executor.execute({ id: `call-${name}-${Math.random().toString(36).slice(2)}`, name, args: { connectionId: demo.id, ...args } }, { sessionId: 's1', connectionId: demo.id });
}

// NULL 必须被丢弃而不是变成 0：这是 forecast/analyze 最容易静默出错的地方
const UNION = `SELECT '2026-01' AS m, NULL AS v
  UNION ALL SELECT '2026-02', 10
  UNION ALL SELECT '2026-03', 20
  UNION ALL SELECT '2026-04', 30
  UNION ALL SELECT '2026-05', 40`;

test('analyze_chart returns authoritative stats over a grouped aggregate', async () => {
  const result = await run('analyze_chart', { sql: 'SELECT status, COUNT(*) AS cnt, SUM(total_cents) AS gmv FROM orders GROUP BY status' });
  assert.equal(result.ok, true, result.error?.message);
  const data = result.data as any;
  assert.equal(data.x, 'status');
  assert.equal(data.y, 'cnt', 'y 应自动落在第一个非标识数值列');
  assert.ok(data.rowCount >= 2);
  if (data.rowCount <= 5) {
    assert.equal(data.topShare.reduce((s: number, t: any) => s + t.value, 0), data.sum, '分组不超过 5 个时，TopN 之和必须等于合计');
  }
  assert.equal(data.argmax, data.topShare[0].label);
  assert.equal(data.max, data.topShare[0].value);
  assert.ok(data.min <= data.max);
  assert.equal(data.avg, Math.round((data.sum / data.rowCount) * 100) / 100);
});

test('analyze_chart honours an explicit y and reports share against the full total', async () => {
  const result = await run('analyze_chart', { sql: 'SELECT status, SUM(total_cents) AS gmv FROM orders GROUP BY status', y: 'gmv', topN: 2 });
  const data = result.data as any;
  assert.equal(data.y, 'gmv');
  assert.equal(data.topShare.length, Math.min(2, data.rowCount));
  const shareSum = data.topShare.reduce((s: number, t: any) => s + t.share, 0);
  assert.ok(shareSum <= 1.0001, `占比之和不能超过 1，得到 ${shareSum}`);
  assert.ok(data.sum > 0);
});

test('analyze_chart drops SQL NULLs instead of counting them as 0', async () => {
  const result = await run('analyze_chart', { sql: UNION });
  const data = result.data as any;
  assert.equal(data.rowCount, 4, 'NULL 行必须被丢弃');
  assert.equal(data.sum, 100);
  assert.equal(data.avg, 25, '若 NULL 被当成 0，均值会变成 20');
  assert.equal(data.min, 10);
  assert.equal(data.argmin, '2026-02');
});

test('analyze_chart computes period-over-period deltas only for a time axis', async () => {
  const timed = await run('analyze_chart', { sql: UNION });
  const data = timed.data as any;
  assert.equal(data.isTimeSeries, true);
  assert.deepEqual(data.deltas.map((d: any) => d.delta), [10, 10, 10]);
  assert.deepEqual(data.deltas.map((d: any) => d.label), ['2026-03', '2026-04', '2026-05']);
  assert.equal(data.deltas[0].ratio, 1, '10 → 20 是 +100%');

  const categorical = await run('analyze_chart', { sql: 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status' });
  assert.equal((categorical.data as any).isTimeSeries, false);
  assert.deepEqual((categorical.data as any).deltas, [], '非时间轴不该硬算环比');
});

test('analyze_chart refuses an empty or all-NULL series', async () => {
  const result = await run('analyze_chart', { sql: "SELECT 'a' AS m, NULL AS v WHERE 1 = 0" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EMPTY_SERIES');
});

test('analyze_chart rejects a column that is not in the result set', async () => {
  const result = await run('analyze_chart', { sql: UNION, y: 'nope' });
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? '', /没有列 nope/);
  assert.match(result.error?.message ?? '', /可用列：m, v/);
});

test('forecast_chart extrapolates an exact linear series and keeps the original data', async () => {
  const result = await run('forecast_chart', { sql: UNION, periods: 3 });
  assert.equal(result.ok, true, result.error?.message);
  const data = result.data as any;
  assert.equal(data.method, 'linear');
  assert.equal(data.slope, 10);
  assert.equal(data.r, 1);
  assert.deepEqual(data.forecast.map((p: any) => p.value), [50, 60, 70]);
  assert.deepEqual(data.original.map((p: any) => p.value), [10, 20, 30, 40], 'NULL 没有混进原始序列');
  assert.match(data.note, /线性回归/);
  assert.match(data.note, /粗略/);
  // 前端要靠这份数据画虚线预测段与区间带
  assert.equal(data.chart.type, 'line');
  assert.equal(data.chart.series.length, 4);
  assert.equal(data.chart.forecast.length, 3);
  assert.equal(data.chartSql.trim().slice(0, 6), 'SELECT');
});

test('forecast_chart refuses fewer than 4 samples instead of guessing', async () => {
  const result = await run('forecast_chart', { sql: "SELECT '2026-01' AS m, 1 AS v UNION ALL SELECT '2026-02', 2 UNION ALL SELECT '2026-03', 3" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'NOT_ENOUGH_SAMPLES');
  assert.match(result.error?.message ?? '', /至少需要 4 个/);
});

test('forecast_chart works on real demo data and never emits NaN', async () => {
  const result = await run('forecast_chart', {
    sql: "SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS c FROM events GROUP BY month ORDER BY month",
    periods: 2,
  });
  assert.equal(result.ok, true, result.error?.message);
  const data = result.data as any;
  assert.ok(data.original.length >= 4, `demo 的 events 至少覆盖 4 个月，实际 ${data.original.length}`);
  assert.ok(['linear', 'moving_average'].includes(data.method));
  assert.equal(data.forecast.length, 2);
  for (const point of data.forecast) {
    assert.ok(Number.isFinite(point.value) && Number.isFinite(point.lower) && Number.isFinite(point.upper));
    assert.ok(point.lower <= point.value && point.value <= point.upper, '区间必须包住预测值');
  }
  assert.match(data.note, /基于 \d+ 个有效数据点外推 2 期/);
  if (data.forecast.some((p: any) => p.lower < 0)) assert.match(data.note, /下限应视为 0/);
});

test('both tools are read-only and land in the audit log', async () => {
  const before = gateway.store.listAudit({ limit: 200 }).filter((row: any) => row.tool === 'analyze_chart').length;
  await run('analyze_chart', { sql: UNION });
  const after = gateway.store.listAudit({ limit: 200 }).filter((row: any) => row.tool === 'analyze_chart');
  assert.equal(after.length, before + 1);
  assert.equal(after[0].risk, 'read');
  assert.equal(after[0].actor, 'agent');
});
