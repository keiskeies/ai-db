import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolvePeriod } from '@aidb/core';
import { createGateway } from '../src/server';
import { generateReport } from '../src/features/report';

const home = mkdtempSync(join(tmpdir(), 'aidb-report-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });

const shopPath = join(home, 'shop.sqlite');
const shop = new DatabaseSync(shopPath);
shop.exec(`
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    amount REAL,
    created_at TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE refunds (
    id INTEGER PRIMARY KEY,
    amount REAL,
    created_at TEXT NOT NULL
  );
  INSERT INTO orders (id, amount, created_at, is_deleted) VALUES
    (1, 100, '2026-07-05 10:00:00', 0),
    (2, 100, '2026-08-05 10:00:00', 0),
    (3, 50,  '2026-09-05 10:00:00', 0),
    (4, 50,  '2026-09-20 10:00:00', 0),
    (5, 100, '2026-10-05 10:00:00', 0),
    (6, 200, '2026-10-12 10:00:00', 0),
    (7, 300, '2026-10-20 10:00:00', 0),
    (8, 999, '2026-10-21 10:00:00', 1);
  INSERT INTO refunds (id, amount, created_at) VALUES
    (1, 30, '2026-09-10 10:00:00'),
    (2, 40, '2026-10-10 10:00:00'),
    (3, 60, '2026-10-18 10:00:00');
`);
shop.close();

const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'report-secret',
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

/** 固定窗口，避免测试随「今天」漂移。 */
const period = resolvePeriod({ period: { from: '2026-10-01', to: '2026-10-31' }, now: '2026-11-02' });

test('确定性报告输出业务指标、同口径基线与差值', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单与退款',
    resolvedPeriod: period,
  });
  const metrics = spec.sections[0].blocks.filter((block) => block.kind === 'metric').flatMap((block) => block.metrics ?? []);
  const orders = metrics.find((metric) => metric.label === '订单单量');
  assert.ok(orders, `缺少订单单量：${metrics.map((metric) => metric.label).join(', ')}`);
  // 软删除行不计入；本期 3 笔 vs 上期 2 笔。
  assert.equal(orders?.value, 3);
  assert.equal(orders?.baseline, 2);
  assert.equal(orders?.delta?.absolute, 1);
  assert.equal(orders?.delta?.percent, 50);
  assert.match(orders?.baselineLabel ?? '', /环比/);

  const amount = metrics.find((metric) => metric.label === '订单金额');
  assert.equal(amount?.value, 600);
  assert.equal(amount?.baseline, 100);
  // 退款上升是坏消息：方向由业务语义决定，而不是数字正负。
  const refunds = metrics.find((metric) => metric.label === '退款单量');
  assert.equal(refunds?.value, 2);
  assert.equal(refunds?.baseline, 1);
  assert.equal(refunds?.goodDirection, 'down');
});

test('确定性报告带管理层摘要、章节结论与时间口径', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单与退款',
    resolvedPeriod: period,
  });
  assert.match(spec.executive?.headline ?? '', /2026-10-01 ~ 2026-10-31/);
  assert.ok((spec.executive?.takeaways.length ?? 0) >= 1);
  assert.equal(spec.meta.period?.from, '2026-10-01');
  assert.equal(spec.meta.period?.to, '2026-10-31');
  assert.ok(spec.meta.assumptions?.some((line) => /统计区间 2026-10-01 ~ 2026-10-31/.test(line)));
  // 概览不再重复摘要里的那句话；章节结论出现在趋势/分布这类需要解读的章节。
  assert.equal(spec.sections[0].conclusion, undefined);
  const trend = spec.sections.find((section) => section.id === 'trend');
  assert.ok(trend?.conclusion && trend.conclusion.length > 0);
  const scale = spec.sections[0].blocks.find((block) => block.kind === 'metric' && block.title === '数据规模');
  assert.ok(scale, '数据规模应单独成块');
  assert.match(scale?.note ?? '', /不代表业务表现/);
});

test('趋势图按业务时间分桶，并给出可核对的口径脚注', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '10 月订单与退款',
    resolvedPeriod: period,
  });
  const trend = spec.sections.find((section) => section.id === 'trend');
  assert.ok(trend, '缺少趋势章节');
  const chart = trend?.blocks.find((block) => block.kind === 'chart');
  assert.ok(chart && chart.series && chart.series.length >= 3);
  assert.ok(chart?.series?.every((point) => /^\d{4}-\d{2}$/.test(point.label)), '月度趋势的横轴应是月份桶');
  assert.match(chart?.note ?? '', /按 .* 分月统计/);
});

test('显式 period 槽位优先于主题里的时间话术', async () => {
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: conn.id }],
    topic: '本月订单',
    period: { from: '2026-09-01', to: '2026-09-30' },
    resolvedPeriod: resolvePeriod({ period: { from: '2026-09-01', to: '2026-09-30' }, now: '2026-11-02' }),
  });
  assert.equal(spec.meta.period?.from, '2026-09-01');
  const orders = spec.sections[0].blocks
    .filter((block) => block.kind === 'metric')
    .flatMap((block) => block.metrics ?? [])
    .find((metric) => metric.label === '订单单量');
  assert.equal(orders?.value, 2);
});

test('没有业务时间列时不给假指标，明确说明只能做规模盘点', async () => {
  const barePath = join(home, 'bare.sqlite');
  const bare = new DatabaseSync(barePath);
  bare.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Bob');`);
  bare.close();
  const bareConn = gateway.store.createConnection({ name: 'Bare', engine: 'sqlite', database: barePath });
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: bareConn.id }],
    topic: '用户概览',
    resolvedPeriod: period,
  });
  const metrics = spec.sections[0].blocks.filter((block) => block.kind === 'metric').flatMap((block) => block.metrics ?? []);
  assert.ok(!metrics.some((metric) => metric.label.includes('单量')), `不应把文本列当时间列：${metrics.map((metric) => metric.label).join(', ')}`);
  assert.ok(spec.sections[0].blocks.some((block) => block.kind === 'callout' && block.tone === 'warning'));
  assert.match(spec.executive?.headline ?? '', /未识别出/);
});

test('确定性报告在存在低基数维度时生成构成饼图', async () => {
  const eventsPath = join(home, 'events.sqlite');
  const events = new DatabaseSync(eventsPath);
  events.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      amount REAL,
      created_at TEXT NOT NULL
    );
    INSERT INTO events (id, channel, amount, created_at) VALUES
      (1, '自然流量', 10, '2026-10-02 10:00:00'),
      (2, '自然流量', 20, '2026-10-03 10:00:00'),
      (3, '广告', 30, '2026-10-04 10:00:00'),
      (4, '广告', 40, '2026-10-05 10:00:00'),
      (5, '活动', 50, '2026-10-06 10:00:00'),
      (6, '活动', 60, '2026-10-07 10:00:00'),
      (7, '合作', 70, '2026-10-08 10:00:00'),
      (8, '合作', 80, '2026-10-09 10:00:00');
  `);
  events.close();
  const eventsConn = gateway.store.createConnection({ name: 'Events', engine: 'sqlite', database: eventsPath });
  const spec = await generateReport(gateway.store, gateway.manager, {
    sources: [{ connectionId: eventsConn.id }],
    topic: '10 月渠道构成',
    resolvedPeriod: period,
  });
  const trend = spec.sections.find((section) => section.id === 'trend');
  const pie = trend?.blocks.find((block) => block.kind === 'chart' && block.chartType === 'pie');
  assert.ok(pie, `缺少构成饼图：${(trend?.blocks ?? []).map((block) => block.kind === 'chart' ? block.chartType : block.kind).join(', ')}`);
  assert.equal(pie.series?.length, 4);
  assert.deepEqual(pie.series?.map((point) => point.label).sort(), ['合作', '广告', '活动', '自然流量'].sort());
  assert.match(pie.note ?? '', /按 channel 分组/);
});

