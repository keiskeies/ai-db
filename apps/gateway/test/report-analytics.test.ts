import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolvePeriod } from '@aidb/core';
import { createGateway } from '../src/server';
import { generateReport } from '../src/features/report';

const home = mkdtempSync(join(tmpdir(), 'aidb-report-analytics-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });

/**
 * 一份带维度列、跨月、跨年、且本期未走完的样本：
 * 归因、同比、日均口径、异常点这四件事都要有真实数据才能验。
 */
const shopPath = join(home, 'shop.sqlite');
const shop = new DatabaseSync(shopPath);
shop.exec(`
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    amount REAL,
    channel TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO orders (id, amount, channel, created_at) VALUES
    (1,  10, '自然流量', '2025-10-05 10:00:00'),
    (2,  10, '自然流量', '2025-10-20 10:00:00'),
    (3,  20, '广告',     '2025-10-21 10:00:00'),
    (4,  30, '自然流量', '2026-09-02 10:00:00'),
    (5,  30, '自然流量', '2026-09-08 10:00:00'),
    (6,  40, '广告',     '2026-09-15 10:00:00'),
    (7,  50, '活动',     '2026-10-01 10:00:00'),
    (8,  60, '活动',     '2026-10-02 10:00:00'),
    (9,  70, '广告',     '2026-10-03 10:00:00'),
    (10, 80, '广告',     '2026-10-04 10:00:00'),
    (11, 90, '合作',     '2026-10-05 10:00:00'),
    (12, 90, '合作',     '2026-10-06 10:00:00');
`);
shop.close();

const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'analytics-secret',
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

const conn = gateway.store.createConnection({ name: 'Shop', engine: 'sqlite', database: shopPath });

const fullPeriod = resolvePeriod({ period: { from: '2026-10-01', to: '2026-10-31' }, now: '2026-11-02' });
// 「本月」在月末解析：本期 31 天，环比基线是 30 天的 9 月——天数不等，直接读总量差就是假下跌。
const unevenPeriod = resolvePeriod({ period: '本月', now: '2026-10-31' });

const metricsOf = (spec: ReturnType<typeof Object>) =>
  (spec as any).sections[0].blocks.filter((block: any) => block.kind === 'metric').flatMap((block: any) => block.metrics ?? []);

test('确定性报告的每个数字都能回溯到产生它的查询', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单',
    resolvedPeriod: fullPeriod,
  });
  const evidence = spec.meta.evidence ?? {};
  const orders = metricsOf(spec).find((metric: any) => metric.label === '订单量');
  assert.ok(orders, '缺少订单量');
  assert.ok(orders.resultRef, '指标必须带 resultRef');
  const entry = evidence[orders.resultRef!];
  assert.ok(entry, `证据表里缺少 ${orders.resultRef}`);
  assert.equal(entry.tool, 'run_sql');
  assert.match(entry.sql ?? '', /FROM .*orders/i);
  assert.equal(typeof entry.durationMs, 'number');
  // 基线来自另一次查询，不能复用本期的 ref。
  assert.ok(orders.baselineResultRef, '基线应带自己的 resultRef');
  assert.notEqual(orders.baselineResultRef, orders.resultRef);
  // 图表同样可追溯。
  const chart = spec.sections.flatMap((section) => section.blocks).find((block) => block.kind === 'chart');
  assert.ok(chart?.resultRef && evidence[chart.resultRef], '图表应绑定证据');
});

test('环比变化按维度拆开，并给出各项贡献占比', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单',
    resolvedPeriod: fullPeriod,
  });
  const attribution = spec.sections.find((section) => section.id === 'attribution');
  assert.ok(attribution, `缺少归因章节：${spec.sections.map((section) => section.id).join(', ')}`);
  const table = attribution!.blocks.find((block) => block.kind === 'table');
  assert.ok(table, '归因应是表格块');
  assert.deepEqual(table!.columns, ['channel', '本期', '上期', '变化', '占整体变化']);
  const rows = table!.rows ?? [];
  assert.ok(rows.length >= 2, '至少拆开两个维度项');
  const shares = rows.map((row) => Number.parseFloat(String(row[4])));
  assert.ok(shares.every((share) => Number.isFinite(share) && share > 0 && share <= 100), `占比应在 0~100：${shares.join(', ')}`);
  const [current, baseline, delta] = [Number(rows[0]![1]), Number(rows[0]![2]), Number(rows[0]![3])];
  assert.equal(delta, Math.round((current - baseline) * 100) / 100, '变化列必须等于本期减上期');
  // 归因表的两期数字都得能回溯。
  assert.ok((table!.resultRefs ?? []).length >= 2, '归因表应绑定两期查询');
});

test('维度值撞到取回上限时，合计要说清只覆盖取回的部分', async () => {
  // 51 个渠道 > 归因的 50 个上限：SQL 层已经 LIMIT，批次不会标记 truncated，
  // 于是「整体变化」只是取回部分的合计——这一点必须写在表注里。
  const widePath = join(home, 'wide.sqlite');
  const wide = new DatabaseSync(widePath);
  wide.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL, channel TEXT, created_at TEXT NOT NULL);`);
  const rows: string[] = [];
  let id = 1;
  for (let region = 0; region < 51; region += 1) {
    const name = `R${String(region).padStart(2, '0')}`;
    // 每个渠道两期都要有变化，否则整体变化为 0，归因本来就不该出表。
    rows.push(`(${id++}, ${region + 2}, '${name}', '2026-10-05 10:00:00')`);
    rows.push(`(${id++}, 1, '${name}', '2026-10-20 10:00:00')`);
    rows.push(`(${id++}, 1, '${name}', '2026-09-05 10:00:00')`);
  }
  wide.exec(`INSERT INTO orders (id, amount, channel, created_at) VALUES ${rows.join(',')};`);
  wide.close();
  const wideConn = gateway.store.createConnection({ name: 'Wide', engine: 'sqlite', database: widePath });
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: wideConn.id }],
    topic: '10 月订单',
    resolvedPeriod: fullPeriod,
  });
  const table = spec.sections
    .find((section) => section.id === 'attribution')
    ?.blocks.find((block) => block.kind === 'table');
  assert.ok(table, `维度超过上限时仍应给出归因表：${spec.sections.map((section) => section.id).join(', ')}`);
  assert.match(table!.note ?? '', /不计入整体变化/, `表注应承认合计只覆盖取回的部分：${table!.note ?? '无'}`);
});

test('维度没撞上限时不要瞎报「不计入整体变化」', async () => {
  // shop 样本只有 4 个渠道：口径完整，表注里不该出现截断提醒。
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单',
    resolvedPeriod: fullPeriod,
  });
  const table = spec.sections
    .find((section) => section.id === 'attribution')
    ?.blocks.find((block) => block.kind === 'table');
  assert.ok(table, '应有归因表');
  assert.doesNotMatch(table!.note ?? '', /不计入整体变化/, table!.note ?? '无');
});

test('两期天数不等时补同长切片与日均口径，而不是直接读总量差', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单',
    resolvedPeriod: unevenPeriod,
  });
  const orders = metricsOf(spec).find((metric: any) => metric.label === '订单量');
  const alternatives: Array<{ label: string; value?: number }> = orders?.alternativeBaselines ?? [];
  assert.ok(alternatives.length, '本期未走完时必须给出第二读法');
  assert.ok(
    alternatives.some((item) => /日均口径/.test(item.label)),
    `应给出日均口径：${alternatives.map((item) => item.label).join(' / ')}`,
  );
  assert.ok(
    alternatives.some((item) => /同长 31 天/.test(item.label)),
    `应给出等长切片：${alternatives.map((item) => item.label).join(' / ')}`,
  );
  // 读者要能在风险里看到这条口径提醒，否则补的读法等于白算。
  assert.ok(
    (spec.executive?.risks ?? []).some((risk) => /日均口径/.test(risk)),
    `风险里应写明天数不等：${(spec.executive?.risks ?? []).join(' / ')}`,
  );
});

test('主基线是环比时补一条同比，读者才分得清趋势与季节', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单',
    resolvedPeriod: fullPeriod,
  });
  const orders = metricsOf(spec).find((metric: any) => metric.label === '订单量');
  const alternatives: Array<{ label: string; value?: number; delta?: { absolute: number } }> = orders?.alternativeBaselines ?? [];
  const yoy = alternatives.find((item) => /同比 去年同期/.test(item.label));
  assert.ok(yoy, `缺少同比：${alternatives.map((item) => item.label).join(' / ')}`);
  // 2025-10 有 3 笔样本；同比必须带着自己的差值，由应用计算。
  assert.equal(yoy!.value, 3);
  assert.equal(yoy!.delta?.absolute, 3);
});

test('趋势序列上的异常点进风险，只报事实不编原因', async () => {
  const spikePath = join(home, 'spike.sqlite');
  const spike = new DatabaseSync(spikePath);
  spike.exec(`CREATE TABLE visits (id INTEGER PRIMARY KEY, visit_time TEXT NOT NULL);`);
  // 连续 6 天每天 10 次，第 7 天 200 次：均值与标准差足够稳定，偏离必须被抓出来。
  const bulk: string[] = [];
  let id = 1;
  for (let day = 1; day <= 6; day += 1) {
    for (let n = 0; n < 10; n += 1) bulk.push(`(${id++}, '2026-10-0${day} 1${n % 8}:00:00')`);
  }
  for (let n = 0; n < 200; n += 1) bulk.push(`(${id++}, '2026-10-07 1${n % 8}:00:00')`);
  spike.exec(`INSERT INTO visits (id, visit_time) VALUES ${bulk.join(',')};`);
  spike.close();
  const spikeConn = gateway.store.createConnection({ name: 'Spike', engine: 'sqlite', database: spikePath });
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: spikeConn.id }],
    topic: '10 月访问',
    resolvedPeriod: resolvePeriod({ period: { from: '2026-10-01', to: '2026-10-07' }, now: '2026-10-08' }),
  });
  const risks = spec.executive?.risks ?? [];
  const anomaly = risks.find((risk) => /标准差/.test(risk));
  assert.ok(anomaly, `风险里应给出异常点：${risks.join(' / ')}`);
  assert.match(anomaly, /2026-10-07/);
  // 只描述偏离，不替读者编造原因。
  assert.ok(!/因为|由于|导致/.test(anomaly), `异常描述不应臆测原因：${anomaly}`);
});
