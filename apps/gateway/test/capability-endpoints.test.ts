import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { ConnectionConfig } from '@aidb/core';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-cap-endpoint-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });

const TOKEN = 'cap-endpoint-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'cap-endpoint-secret',
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
  // Windows 上 SQLite 句柄释放稍有延迟，清理失败不应让测试变红。
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api${path}`, { headers, ...init });
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

let demo: ConnectionConfig;
test('demo 连接就绪', async () => {
  const boot = await api<{ connections: ConnectionConfig[] }>('/bootstrap');
  demo = boot.body.connections.find((item) => item.engine === 'sqlite')!;
  assert.ok(demo, 'demo 连接存在');
});

// ---------- /transfer：契约校验 ----------

test('/transfer 缺必填返回 400 且带 field', async () => {
  const response = await api('/transfer', { method: 'POST', body: JSON.stringify({ sourceId: demo.id }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_INPUT');
  assert.equal(response.body.error.field, 'targetConnectionId');
  assert.match(response.body.error.message, /目标连接必填/);
});

test('/transfer 允许 body 为空对象（不是「body 必须是对象」）', async () => {
  const response = await api('/transfer', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'sourceConnectionId');
});

test('/transfer 非法 mode 返回 400', async () => {
  const response = await api('/transfer', {
    method: 'POST',
    body: JSON.stringify({ sourceId: demo.id, targetId: demo.id, mode: 'merge' }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'mode');
  assert.match(response.body.error.message, /只能是 append \/ replace/);
});

test('/transfer 接受旧字段名 sourceId / targetId（迁移期别名）', async () => {
  const response = await api('/transfer', {
    method: 'POST',
    body: JSON.stringify({ sourceId: demo.id, targetId: demo.id, tables: ['users'], mode: 'append' }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.results[0].table, 'users');
});

test('/transfer 也接受契约规范名 sourceConnectionId / targetConnectionId', async () => {
  const response = await api('/transfer', {
    method: 'POST',
    body: JSON.stringify({ sourceConnectionId: demo.id, targetConnectionId: demo.id, tables: ['users'] }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
});

test('/transfer 的 mode 默认值由契约补齐（不传 = append）', async () => {
  const response = await api<{ result: { results: Array<{ name: string; truncated: boolean }> } }>('/transfer', {
    method: 'POST',
    body: JSON.stringify({ sourceId: demo.id, targetId: demo.id, tables: ['users'] }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.results[0].truncated, false, 'append 模式不应清空目标表');
});

// ---------- /jobs：契约校验 ----------

test('/jobs 缺连接返回 400 且带 field', async () => {
  const response = await api('/jobs', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'connectionId');
});

test('/jobs 不传 type 时默认 query，因此 sql 变成必填', async () => {
  const response = await api('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', connectionId: demo.id }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'sql');
  assert.match(response.body.error.message, /SQL必填/);
});

test('/jobs type=backup 时不要求 sql', async () => {
  const response = await api<{ job: { id: string; type: string } }>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: '备份任务', connectionId: demo.id, type: 'backup' }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.job.type, 'backup');
  await api(`/jobs/${response.body.job.id}`, { method: 'DELETE' });
});

test('/jobs intervalSeconds 低于 30 被拒', async () => {
  const response = await api('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', connectionId: demo.id, sql: 'SELECT 1', intervalSeconds: 5 }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'intervalSeconds');
});

test('/jobs 正常创建并在 intervalSeconds 缺省时用契约默认值 3600', async () => {
  const response = await api<{ job: { id: string; intervalSeconds: number; enabled: boolean } }>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: '计数任务', connectionId: demo.id, sql: 'SELECT COUNT(*) FROM orders' }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.job.intervalSeconds, 3600);
  assert.equal(response.body.job.enabled, true);
  await api(`/jobs/${response.body.job.id}`, { method: 'DELETE' });
});

test('/jobs 连接不存在仍返回 404（契约只校验形状，不校验存在性）', async () => {
  const response = await api('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', connectionId: 'no-such-connection', sql: 'SELECT 1' }),
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'CONNECTION_NOT_FOUND');
});

// ---------- /generate：契约校验 ----------

test('/generate 缺连接返回 400 且带 field', async () => {
  const response = await api('/generate', { method: 'POST', body: JSON.stringify({ table: 'users' }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_INPUT');
  assert.equal(response.body.error.field, 'connectionId');
  assert.match(response.body.error.message, /连接必填/);
});

test('/generate 缺表返回 400 且带 field', async () => {
  const response = await api('/generate', { method: 'POST', body: JSON.stringify({ connectionId: demo.id }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'table');
  assert.match(response.body.error.message, /表必填/);
});

test('/generate 行数超上限（5000）被拒', async () => {
  const response = await api('/generate', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'users', rows: 9000 }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'rows');
  assert.match(response.body.error.message, /不能大于 5000/);
});

test('/generate rows 缺省时用契约默认值 10 且默认插入', async () => {
  const before = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) FROM users' }),
  });
  const response = await api<{ result: { table: string; dryRun: boolean; inserted: number; rowsPreview: unknown[][] } }>('/generate', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'users' }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.table, 'users');
  assert.equal(response.body.result.dryRun, false);
  // 契约默认 rows=10；rowsPreview 固定取前 5 行做预览，因此校验 inserted 而不是预览行数
  assert.equal(response.body.result.inserted, 10);
  assert.ok(response.body.result.rowsPreview.length > 0);
  const after = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) FROM users' }),
  });
  assert.equal(Number(after.body.batch.sets[0].rows[0][0]) - Number(before.body.batch.sets[0].rows[0][0]), 10, '应插入 10 行');
});

test('/generate dryRun=true 只预览不插入', async () => {
  const before = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) FROM users' }),
  });
  const response = await api<{ result: { dryRun: boolean; inserted: number } }>('/generate', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'users', rows: 2, dryRun: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.result.dryRun, true);
  assert.equal(response.body.result.inserted, 0);
  const after = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) FROM users' }),
  });
  assert.equal(before.body.batch.sets[0].rows[0][0], after.body.batch.sets[0].rows[0][0], 'dryRun 不应改变行数');
});

// ---------- /dictionary：契约校验 ----------

test('/dictionary 缺连接返回 400 且带 field', async () => {
  const response = await api('/dictionary');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'connectionId');
});

test('/dictionary 正常返回字典', async () => {
  const response = await api<{ dictionary: { tableCount: number; markdown: string } }>(`/dictionary?connectionId=${demo.id}`);
  assert.equal(response.status, 200);
  assert.ok(response.body.dictionary.tableCount > 0);
  assert.match(response.body.dictionary.markdown, /orders/);
});

// ---------- /schema/sync：契约校验（兼容 string[] 与 DDL 文本） ----------

test('/schema/sync 缺连接返回 400', async () => {
  const response = await api('/schema/sync', { method: 'POST', body: JSON.stringify({ statements: ['SELECT 1'] }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'connectionId');
});

test('/schema/sync 缺语句返回 400', async () => {
  const response = await api('/schema/sync', { method: 'POST', body: JSON.stringify({ connectionId: demo.id }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'statements');
});

test('/schema/sync 接受 string[]（旧 UI 形态）并执行', async () => {
  const response = await api('/schema/sync', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, statements: ['CREATE TABLE IF NOT EXISTS cap_sync_a (id INTEGER PRIMARY KEY)'] }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const check = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='cap_sync_a'" }),
  });
  assert.equal(check.body.batch.sets[0].rows.length, 1, '表应已创建');
});

test('/schema/sync 接受 DDL 文本（契约 code 字段形态）并拆成多条执行', async () => {
  const response = await api('/schema/sync', {
    method: 'POST',
    body: JSON.stringify({
      connectionId: demo.id,
      statements: 'CREATE TABLE IF NOT EXISTS cap_sync_b (id INTEGER PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS cap_sync_c (id INTEGER PRIMARY KEY);',
    }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const check = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cap_sync_b','cap_sync_c')" }),
  });
  assert.equal(check.body.batch.sets[0].rows.length, 2, '两张表都应创建');
});

// ---------- /data/compare：契约校验 ----------

test('/data/compare 缺目标返回 400 且带 field', async () => {
  const response = await api('/data/compare', { method: 'POST', body: JSON.stringify({ sourceId: demo.id }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_INPUT');
  assert.equal(response.body.error.field, 'targetId');
});

test('/data/compare 正常对比同一连接（字段名保持 sourceId/targetId）', async () => {
  const response = await api<{ result: { rows: Array<{ table: string; status: string }> } }>('/data/compare', {
    method: 'POST',
    body: JSON.stringify({ sourceId: demo.id, targetId: demo.id }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.result.rows.length > 0);
});

// ---------- /monitor 与 /objects：契约校验 ----------

test('/monitor 缺连接返回 400 且带 field', async () => {
  const response = await api('/monitor');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'connectionId');
});

test('/monitor 正常返回指标', async () => {
  const response = await api<{ monitor: { engine: string; sections: unknown[] } }>(`/monitor?connectionId=${demo.id}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.monitor.sections.length > 0);
});

test('/objects 缺连接返回 400 且带 field', async () => {
  const response = await api('/objects');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'connectionId');
});

test('/objects 正常返回（SQLite 无高级对象也不报错）', async () => {
  const response = await api<{ objects: { supported: boolean } }>(`/objects?connectionId=${demo.id}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(typeof response.body.objects.supported, 'boolean');
});

// ---------- /search 与 /users/action：契约校验 ----------

test('/search 缺关键词返回 400 且带 field', async () => {
  const response = await api('/search', { method: 'POST', body: JSON.stringify({ connectionId: demo.id }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'query');
});

test('/search scope 非法值被拒', async () => {
  const response = await api('/search', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, query: 'orders', scope: 'everything' }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'scope');
});

test('/search 正常返回对象匹配', async () => {
  const response = await api<{ objects: unknown[] }>('/search', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, query: 'orders', scope: 'objects' }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.objects.length > 0);
});

test('/users/action 缺连接返回 400', async () => {
  const response = await api('/users/action', { method: 'POST', body: JSON.stringify({ action: 'list' }) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'connectionId');
});

test('/users/action action=list 走只读分支并返回 supported 标记', async () => {
  const response = await api<{ result: { supported: boolean } }>('/users/action', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, action: 'list' }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  // SQLite 不支持用户管理 → supported:false，不抛错
  assert.equal(typeof response.body.result.supported, 'boolean');
});

test('/users/action action=create 缺 name 时由执行层拒绝（契约只对 create 要求 name）', async () => {
  const response = await api('/users/action', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, action: 'create', password: 'x' }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'name');
});

// ---------- /transfer/stream 与 /transfer 共用同一份契约 ----------

test('/transfer/stream 缺必填在 SSE 之前返回 400 JSON（不是流内错误事件）', async () => {
  const response = await fetch(`${base}/api/transfer/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sourceId: demo.id }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; field?: string } };
  assert.equal(body.error.code, 'INVALID_INPUT');
  assert.equal(body.error.field, 'targetConnectionId');
});

test('/transfer/stream 非法 mode 同样被契约拒绝', async () => {
  const response = await fetch(`${base}/api/transfer/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sourceId: demo.id, targetId: demo.id, mode: 'merge' }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { field?: string } };
  assert.equal(body.error.field, 'mode');
});

test('/transfer/stream 接受契约规范名，且 limit 在读取阶段生效', async () => {
  const response = await fetch(`${base}/api/transfer/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sourceConnectionId: demo.id, targetConnectionId: demo.id, tables: ['orders'], limit: 5 }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text())
    .split('\n\n')
    .map((frame) => frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  // limit 限制的是「从源表读多少行」，所以 read 阶段的行数应恰好是 5
  const readPhase = events.find((event) => event.type === 'phase-done' && event.phase === 'read');
  assert.ok(readPhase, '应有 read 阶段事件');
  assert.equal(readPhase.rows, 5, 'limit 应限制读取行数为 5');
  assert.equal(readPhase.limitReached, true, 'limitReached 应为 true');
});
