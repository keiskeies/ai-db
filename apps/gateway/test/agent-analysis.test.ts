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

test('render_chart supports multi-series comparison', async () => {
  const result = await run('render_chart', {
    sql: 'SELECT status, COUNT(*) AS cnt, SUM(total_cents) AS gmv FROM orders GROUP BY status',
    type: 'bar',
    ys: ['gmv'],
    stacked: true,
  });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.series.length > 0, true);
  assert.equal(chart.extraSeries?.length, 1, '附加列应进入 extraSeries');
  assert.equal(chart.extraSeries[0].name, 'gmv');
  assert.equal(chart.extraSeries[0].values.length, chart.series.length, '附加列必须与主序列等长');
  assert.equal(chart.stacked, true);
});

test('render_chart stacked type stacks without relying on the legacy flag', async () => {
  const result = await run('render_chart', {
    sql: 'SELECT status, COUNT(*) AS cnt, SUM(total_cents) AS gmv FROM orders GROUP BY status',
    type: 'stacked',
    ys: ['gmv'],
  });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.type, 'stacked');
  assert.equal(chart.stacked, true);
});

test('render_chart scatter keeps raw numeric x/y pairs and point labels', async () => {
  const result = await run('render_chart', {
    sql: 'SELECT total_cents, user_id, status FROM orders WHERE total_cents IS NOT NULL LIMIT 80',
    type: 'scatter',
    x: 'total_cents',
    y: 'user_id',
    label: 'status',
  });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.type, 'scatter');
  assert.equal(chart.scatter.length >= 2, true, '散点至少需要两个点');
  assert.equal(chart.scatter.every((point: any) => Number.isFinite(point.x) && Number.isFinite(point.y)), true);
  assert.equal(chart.scatter.some((point: any) => typeof point.label === 'string'), true, 'label 列应进入 tooltip');
  assert.equal(chart.series.length <= 24, true);
});

test('render_chart scatter refuses a categorical x axis instead of faking one', async () => {
  const result = await run('render_chart', {
    sql: 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status',
    type: 'scatter',
    x: 'status',
    y: 'cnt',
  });
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? '', /散点图至少需要/);
});

test('render_chart heatmap builds a category × category matrix with summed cells', async () => {
  const result = await run('render_chart', {
    sql: 'SELECT status, channel, COUNT(*) AS cnt FROM orders GROUP BY status, channel',
    type: 'heatmap',
    x: 'status',
    y: 'channel',
    value: 'cnt',
  });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.type, 'heatmap');
  assert.equal(chart.heatmap.xLabels.length >= 2, true);
  assert.equal(chart.heatmap.yLabels.length >= 2, true);
  assert.equal(chart.heatmap.values.length, chart.heatmap.yLabels.length);
  assert.equal(chart.heatmap.values.every((row: number[]) => row.length === chart.heatmap.xLabels.length), true);
  assert.equal(chart.heatmap.values.flat().reduce((sum: number, cell: number) => sum + cell, 0) > 0, true);
  assert.equal(chart.series.length, chart.heatmap.yLabels.length, '行合计用于切回其它图形');
  assert.match(result.summary, /热力图/);
});

test('render_chart heatmap requires two categories and a numeric value', async () => {
  const result = await run('render_chart', { sql: 'SELECT status FROM orders', type: 'heatmap' });
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? '', /热力图需要/);
});

test('render_chart radar keeps multiple measures and enforces three axes', async () => {
  const result = await run('render_chart', {
    sql: 'SELECT status, COUNT(*) AS cnt, SUM(total_cents) AS gmv FROM orders GROUP BY status',
    type: 'radar',
    ys: ['gmv'],
  });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.type, 'radar');
  assert.equal(chart.series.length >= 3, true);
  assert.equal(chart.extraSeries?.length, 1);

  const tooFew = await run('render_chart', {
    sql: "SELECT 'a' AS k, 1 AS v UNION ALL SELECT 'b', 2",
    type: 'radar',
  });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.error?.message ?? '', /3 个类别轴/);
});

test('render_chart 对不适配的饼图做确定性降级，并让工具记录与图表一致', async () => {
  const tooMany = await run('render_chart', {
    sql: "SELECT 'c' || id AS bucket, id AS cnt FROM orders LIMIT 10",
    type: 'pie',
    x: 'bucket',
    y: 'cnt',
  });
  assert.equal(tooMany.ok, true, tooMany.error?.message);
  const tooManyChart = (tooMany.data as any).chart;
  assert.equal(tooManyChart.type, 'bar', '10 个切片超过饼图上限，应降级为柱状图');
  assert.match(tooManyChart.note ?? '', /饼图不适配.*最多 8 个.*已改用柱状图/);
  assert.match(tooMany.summary, /已改用柱状图/);

  const multiMeasure = await run('render_chart', {
    sql: 'SELECT status, COUNT(*) AS cnt, SUM(total_cents) AS gmv FROM orders GROUP BY status',
    type: 'pie',
    ys: ['gmv'],
  });
  assert.equal(multiMeasure.ok, true, multiMeasure.error?.message);
  const multiChart = (multiMeasure.data as any).chart;
  assert.equal(multiChart.type, 'bar');
  assert.match(multiChart.note ?? '', /多个度量/);
});

test('render_chart 保留合法的饼图与雷达图，不误降级', async () => {
  const pie = await run('render_chart', {
    sql: 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status',
    type: 'pie',
  });
  assert.equal(pie.ok, true, pie.error?.message);
  assert.equal((pie.data as any).chart.type, 'pie');
  assert.equal((pie.data as any).chart.note, undefined);
});

test('render_chart 对缺度量的堆叠图与超类别的雷达图降级', async () => {
  const stacked = await run('render_chart', {
    sql: 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status',
    type: 'stacked',
  });
  assert.equal(stacked.ok, true, stacked.error?.message);
  assert.equal((stacked.data as any).chart.type, 'bar');
  assert.match((stacked.data as any).chart.note ?? '', /只有一个度量列/);

  const radar = await run('render_chart', {
    sql: "SELECT 'c' || id AS bucket, id AS cnt FROM orders LIMIT 10",
    type: 'radar',
    x: 'bucket',
    y: 'cnt',
  });
  assert.equal(radar.ok, true, radar.error?.message);
  assert.equal((radar.data as any).chart.type, 'bar');
  assert.match((radar.data as any).chart.note ?? '', /类别超过 8 个/);
});

test('render_chart 审计记录同时留下请求类型与实际类型', async () => {
  await run('render_chart', {
    sql: "SELECT 'c' || id AS bucket, id AS cnt FROM orders LIMIT 10",
    type: 'pie',
    x: 'bucket',
    y: 'cnt',
  });
  const entry = gateway.store.listAudit({ limit: 20 }).find((row: any) => row.tool === 'render_chart');
  assert.equal(entry?.meta?.requestedChartType, 'pie');
  assert.equal(entry?.meta?.chartType, 'bar');
});


test('render_chart 无序类别点 line 时确定性降级 bar，并注记原因', async () => {
  const result = await run('render_chart', { sql: 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status', type: 'line' });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.type, 'bar', '无序类别不能画折线');
  assert.match(chart.note ?? '', /折线图不适配.*已改用柱状图/);
});

test('render_chart 合法时间序列保留 line 且无注记', async () => {
  const result = await run('render_chart', { sql: "SELECT strftime('%Y-%m', created_at) AS m, COUNT(*) AS cnt FROM orders GROUP BY m ORDER BY m", type: 'line' });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.type, 'line');
  assert.equal(chart.note, undefined);
});

test('render_chart 截断必须显式注记：line 上限 200、bar 上限 24', async () => {
  const line = await run('render_chart', { sql: 'SELECT ROW_NUMBER() OVER (ORDER BY id) AS n, total_cents AS v FROM orders', type: 'line', x: 'n', y: 'v' });
  assert.equal(line.ok, true, line.error?.message);
  const lineChart = (line.data as any).chart;
  assert.equal(lineChart.type, 'line', '有序数值轴是合法 line');
  assert.equal(lineChart.series.length, 200);
  assert.match(lineChart.note ?? '', /仅展示前 200 行/);
  const bar = await run('render_chart', { sql: 'SELECT id, total_cents AS v FROM orders LIMIT 30', type: 'bar' });
  assert.equal(bar.ok, true, bar.error?.message);
  const barChart = (bar.data as any).chart;
  assert.equal(barChart.series.length, 24);
  assert.match(barChart.note ?? '', /仅展示前 24 行/);
});

test('render_chart 散点超 300 截断注记', async () => {
  const result = await run('render_chart', { sql: 'SELECT total_cents AS x, id AS y FROM orders', type: 'scatter' });
  assert.equal(result.ok, true, result.error?.message);
  const chart = (result.data as any).chart;
  assert.equal(chart.scatter.length, 300);
  assert.match(chart.note ?? '', /仅展示前 300 个/);
});

test('图表工具在执行层拒绝写 SQL，静态 read 风险不能绕过', async () => {
  for (const [index, spec] of [
    ['render_chart', { type: 'bar' }],
    ['render_chart', { type: 'heatmap' }],
    ['analyze_chart', {}],
    ['forecast_chart', {}],
  ].entries()) {
    const [name, extra] = spec as [string, Record<string, unknown>];
    const table = `chart_write_guard_${index}`;
    const result = await run(name, {
      sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`,
      ...extra,
    });
    assert.equal(result.ok, false, `${name} 不应执行 DDL`);
    assert.equal(result.error?.code, 'CHART_SQL_NOT_READONLY', `${name} 应在调用驱动前拒绝`);
    const check = await gateway.manager.query(
      demo.id,
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
      { actor: 'user', autoLimit: false },
    );
    assert.equal(Number(check.sets[0].rows[0][0]), 0, `${name} 不得产生写副作用`);
  }

  const mixed = await run('render_chart', {
    sql: 'SELECT 1 AS x, 2 AS y; CREATE TABLE chart_write_guard_mixed (id INTEGER)',
    type: 'bar',
  });
  assert.equal(mixed.error?.code, 'CHART_SQL_NOT_READONLY', '多语句也不能夹带写入');
});
