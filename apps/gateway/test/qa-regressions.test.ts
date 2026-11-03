import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectionConfig } from '@aidb/core';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-qa-regressions-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });

const TOKEN = 'qa-regressions-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'qa-regressions-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  attachmentDir: join(home, 'attachments'),
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
    /* Windows 句柄释放延迟 */
  }
});

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api${path}`, { headers, ...init });
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

async function createSqliteConnection(name: string, database: string, readonly = false): Promise<ConnectionConfig> {
  const response = await api<{ connection: ConnectionConfig }>('/connections', {
    method: 'POST',
    body: JSON.stringify({ name, engine: 'sqlite', database, readonly, groupName: '测试' }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.connection;
}

const scratchFile = join(home, 'demo', 'regression.sqlite');
const scratch = new DatabaseSync(scratchFile);
scratch.exec('PRAGMA journal_mode = WAL');
scratch.exec('CREATE TABLE qa_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT 1, amount INTEGER NOT NULL DEFAULT 0)');
scratch.exec('CREATE TABLE qa_many (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL)');
scratch.exec('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 120) INSERT INTO qa_many (n) SELECT x FROM c');
scratch.close();

let writable: ConnectionConfig;
let readonlyConn: ConnectionConfig;
let demo: ConnectionConfig;

test('准备测试连接', async () => {
  const boot = await api<{ connections: ConnectionConfig[] }>('/bootstrap');
  demo = boot.body.connections.find((item) => item.engine === 'sqlite')!;
  assert.ok(demo);
  writable = await createSqliteConnection('QA 回归·可写', scratchFile);
  readonlyConn = await createSqliteConnection('QA 回归·只读', scratchFile, true);
});

test('网格插入布尔值按 0/1 落库', async () => {
  const inserted = await api<{ result: { affected: number } }>('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, table: 'qa_rows', op: 'insert', values: { name: 'bool-true', active: true, amount: 5 } }),
  });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  const check = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, sql: "SELECT active FROM qa_rows WHERE name = 'bool-true'" }),
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(Number(check.body.batch.sets[0].rows[0][0]), 1);
});

test('网格更新布尔值按 0/1 落库', async () => {
  const updated = await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, table: 'qa_rows', op: 'update', values: { active: false }, key: { id: 1 } }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const check = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, sql: 'SELECT active FROM qa_rows WHERE id = 1' }),
  });
  assert.equal(Number(check.body.batch.sets[0].rows[0][0]), 0);
});

test('CSV 导入布尔列不报绑定错误', async () => {
  const imported = await api<{ result: { inserted: number } }>('/import', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, table: 'qa_rows', csv: 'name,active,amount\ncsv-a,1,10\ncsv-b,0,20\n', hasHeader: true }),
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.result.inserted, 2);
});

test('自动限行结果标记 truncated', async () => {
  const queried = await api<{ batch: { sets: Array<{ rows: unknown[][]; truncated: boolean; rowCount: number }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, sql: 'SELECT * FROM qa_many', limit: 100 }),
  });
  assert.equal(queried.status, 200, JSON.stringify(queried.body));
  const set = queried.body.batch.sets[0];
  assert.equal(set.rows.length, 100);
  assert.equal(set.rowCount, 100);
  assert.equal(set.truncated, true, '自动限行时必须标记结果被截断');
});

test('显式 LIMIT 小于自动上限时不误报截断', async () => {
  const queried = await api<{ batch: { sets: Array<{ rows: unknown[][]; truncated: boolean }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, sql: 'SELECT * FROM qa_many LIMIT 10', limit: 100 }),
  });
  assert.equal(queried.status, 200, JSON.stringify(queried.body));
  assert.equal(queried.body.batch.sets[0].truncated, false);
});

test('记忆部分更新不因 undefined 绑定失败', async () => {
  const created = await api<{ memory: { id: string } }>('/agent/memories', {
    method: 'POST',
    body: JSON.stringify({ title: 'QA 记忆', content: '订单金额口径为 pay_cents', kind: 'fact' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const updated = await api<{ memory: { importance: number; title: string } }>(`/agent/memories/${created.body.memory.id}`, {
    method: 'PUT',
    body: JSON.stringify({ importance: 0.9 }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.memory.importance, 0.9);
  assert.equal(updated.body.memory.title, 'QA 记忆');
});

test('只读连接的 generate 返回 403 READONLY', async () => {
  const generated = await api<{ error: { code: string } }>('/generate', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonlyConn.id, table: 'qa_rows', rows: 1 }),
  });
  assert.equal(generated.status, 403, JSON.stringify(generated.body));
  assert.equal(generated.body.error.code, 'READONLY');
});

test('备份创建返回可恢复的完整记录', async () => {
  const created = await api<{ backup: { id?: string; path: string; bytes: number; tables: number; rows: number } }>('/backups', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, label: 'qa-regression' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(typeof created.body.backup.id, 'string', '创建接口必须返回备份 id');
  const listed = await api<{ backups: Array<{ id: string }> }>(`/backups?connectionId=${demo.id}`);
  assert.ok(listed.body.backups.some((backup) => backup.id === created.body.backup.id));
});

test('恢复备份会先清理同名对象，可在非空库上重放', async () => {
  const marker = await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, table: 'qa_rows', op: 'insert', values: { name: 'restore-marker', amount: 42 } }),
  });
  assert.equal(marker.status, 200, JSON.stringify(marker.body));
  const created = await api<{ backup: { id: string } }>('/backups', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, label: 'qa-restore' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const removed = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, sql: "DELETE FROM qa_rows WHERE name = 'restore-marker'" }),
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const restored = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>(`/backups/${created.body.backup.id}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const check = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable.id, sql: "SELECT COUNT(*) FROM qa_rows WHERE name = 'restore-marker'" }),
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(Number(check.body.batch.sets[0].rows[0][0]), 1, '恢复后标记行应回来');
});
