import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { ConnectionConfig, ToolResult } from '@aidb/core';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-chart-insight-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });

const TOKEN = 'chart-insight-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'chart-insight-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const port = (gateway.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

after(async () => {
  await gateway.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

async function insight(body: Record<string, unknown>): Promise<{ status: number; result?: ToolResult; error?: { code: string; message: string } }> {
  const response = await fetch(`${base}/api/agent/chart-insight`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => ({}))) as any;
  return { status: response.status, result: json.result, error: json.error };
}

let demo: ConnectionConfig;
test('demo 连接就绪', async () => {
  const response = await fetch(`${base}/api/bootstrap`, { headers });
  const boot = (await response.json()) as { connections: ConnectionConfig[] };
  demo = boot.connections.find((item) => item.engine === 'sqlite')!;
  assert.ok(demo, 'demo 连接存在');
});

const GROUPED = 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status';
const TIMED = `SELECT '2026-01' AS m, 10 AS v
  UNION ALL SELECT '2026-02', 20
  UNION ALL SELECT '2026-03', 30
  UNION ALL SELECT '2026-04', 40`;

test('analyze 模式返回执行器权威统计', async () => {
  const { status, result } = await insight({ connectionId: demo.id, sql: GROUPED, mode: 'analyze' });
  assert.equal(status, 200);
  assert.equal(result?.ok, true, result?.error?.message);
  const data = result?.data as any;
  assert.equal(data.x, 'status');
  assert.equal(data.y, 'cnt');
  assert.ok(data.rowCount >= 2);
  assert.ok(data.sum > 0);
  assert.equal(data.argmax, data.topShare[0].label);
});

test('forecast 模式返回预测段与图表注记', async () => {
  const { status, result } = await insight({ connectionId: demo.id, sql: TIMED, mode: 'forecast', periods: 3 });
  assert.equal(status, 200);
  assert.equal(result?.ok, true, result?.error?.message);
  const data = result?.data as any;
  assert.deepEqual(data.forecast.map((p: any) => p.value), [50, 60, 70]);
  assert.equal(data.chart.type, 'line');
  assert.equal(data.chart.forecast.length, 3);
  assert.match(data.note, /线性回归/);
});

test('显式 x/y 透传给执行器', async () => {
  const { status, result } = await insight({ connectionId: demo.id, sql: 'SELECT status, COUNT(*) AS cnt, SUM(total_cents) AS gmv FROM orders GROUP BY status', mode: 'analyze', x: 'status', y: 'gmv' });
  assert.equal(status, 200);
  assert.equal((result?.data as any).y, 'gmv');
});

test('mode 非法返回 400', async () => {
  const { status, error } = await insight({ connectionId: demo.id, sql: GROUPED, mode: 'magic' });
  assert.equal(status, 400);
  assert.equal(error?.code, 'INVALID_INPUT');
});

test('sql 缺失返回 400', async () => {
  const { status, error } = await insight({ connectionId: demo.id, mode: 'analyze' });
  assert.equal(status, 400);
  assert.equal(error?.code, 'INVALID_INPUT');
});

test('connectionId 缺失返回 400', async () => {
  const { status, error } = await insight({ sql: GROUPED });
  assert.equal(status, 400);
  assert.equal(error?.code, 'INVALID_INPUT');
});

test('periods 越界返回 400', async () => {
  for (const periods of [0, 13, 2.5]) {
    const { status, error } = await insight({ connectionId: demo.id, sql: TIMED, mode: 'forecast', periods });
    assert.equal(status, 400, `periods=${periods}`);
    assert.equal(error?.code, 'INVALID_INPUT');
  }
});

test('method 非法返回 400', async () => {
  const { status, error } = await insight({ connectionId: demo.id, sql: TIMED, mode: 'forecast', method: 'arima' });
  assert.equal(status, 400);
  assert.equal(error?.code, 'INVALID_INPUT');
});

test('空结果透传 EMPTY_SERIES', async () => {
  const { status, result } = await insight({ connectionId: demo.id, sql: "SELECT 'a' AS m, NULL AS v WHERE 1 = 0", mode: 'analyze' });
  assert.equal(status, 400);
  assert.equal(result?.ok, false);
  assert.equal(result?.error?.code, 'EMPTY_SERIES');
});

test('样本不足透传 NOT_ENOUGH_SAMPLES', async () => {
  const { status, result } = await insight({ connectionId: demo.id, sql: "SELECT '2026-01' AS m, 1 AS v UNION ALL SELECT '2026-02', 2", mode: 'forecast' });
  assert.equal(status, 400);
  assert.equal(result?.error?.code, 'NOT_ENOUGH_SAMPLES');
});

test('一键解读同样落审计', async () => {
  const before = gateway.store.listAudit({ limit: 200 }).filter((row: any) => row.tool === 'analyze_chart').length;
  await insight({ connectionId: demo.id, sql: GROUPED, mode: 'analyze' });
  const after = gateway.store.listAudit({ limit: 200 }).filter((row: any) => row.tool === 'analyze_chart');
  assert.equal(after.length, before + 1);
  assert.equal(after[0].risk, 'read');
});