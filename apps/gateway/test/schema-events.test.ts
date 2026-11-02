import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { listenRandom } from './helpers';
import { GatewayEvents, type SchemaChangedEvent } from '../src/events';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

test('事件总线把事件送达每个订阅者', () => {
  const bus = new GatewayEvents();
  const first: SchemaChangedEvent[] = [];
  const second: SchemaChangedEvent[] = [];
  bus.onSchemaChanged((event) => first.push(event));
  bus.onSchemaChanged((event) => second.push(event));

  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'agent', at: '2026-11-02T00:00:00.000Z' });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].connectionId, 'c1');
  assert.equal(first[0].cause, 'agent');
});

test('取消订阅后不再收到事件', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  const off = bus.onSchemaChanged((event) => seen.push(event));
  off();
  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' });
  assert.equal(seen.length, 0);
});

test('一个监听器抛错不影响其它监听器', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  bus.onSchemaChanged(() => {
    throw new Error('boom');
  });
  bus.onSchemaChanged((event) => seen.push(event));

  assert.doesNotThrow(() =>
    bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' }),
  );
  assert.equal(seen.length, 1);
});

const home = mkdtempSync(join(tmpdir(), 'aidb-schema-events-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'schema-events-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'schema-events-secret',
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
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
// GatewayInstance 不暴露 executor，测试自己建一个，与其它测试文件的写法一致。
const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function connectWs(): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/** 在 fn 执行期间收集 schema_changed 事件。开头留 120ms 让订阅先就位。 */
async function collect(fn: () => Promise<void>, waitMs = 400): Promise<any[]> {
  const ws = await connectWs();
  const received: any[] = [];
  ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fn();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  ws.close();
  return received.filter((item) => item.type === 'schema_changed');
}

test('invalidate 会把 schema_changed 广播到已连接的客户端', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    gateway.manager.invalidate(conn.id, 'agent');
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].connectionId, conn.id);
  assert.equal(events[0].cause, 'agent');
  assert.ok(typeof events[0].at === 'string' && events[0].at.length > 0);
});

test('错 token 的 ws 以 4401 被拒', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=wrong-token`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('没有在预期时间内被拒')), 5000);
    ws.once('close', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    ws.once('error', () => undefined);
  });
  assert.equal(code, 4401);
});

test('SQL 窗口执行 CREATE TABLE 会发事件（本轮修掉的漏清缓存缺陷）', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    const result = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE wq_probe (id INTEGER PRIMARY KEY)' }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
  assert.equal(events[0].cause, 'user');
});

test('纯 SELECT 不发事件', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sql: 'SELECT 1' }) });
  });
  assert.equal(events.length, 0);
});

test('/ddl/execute 只发一次事件（不得与路由层重复）', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    const result = await api('/ddl/execute', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, statements: ['CREATE TABLE ddl_probe (id INTEGER PRIMARY KEY)'] }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
});

test('Agent 的 run_sql 跑 DDL 只发一次事件且 cause 为 agent', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    const result = await executor.execute(
      { id: 'call-run-sql', name: 'run_sql', args: { sql: 'CREATE TABLE agent_probe (id INTEGER PRIMARY KEY)' } } as any,
      { sessionId: 'schema-event-session', connectionId: conn.id },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
  assert.equal(events[0].cause, 'agent');
});

test('工具箱改名只发一次事件（tableOps 不得与 query() 双发）', async () => {
  const conn = gateway.store.listConnections()[0];
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE toolbox_probe (id INTEGER PRIMARY KEY)' }),
  });
  const events = await collect(async () => {
    const result = await api('/tables/ops', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, table: 'toolbox_probe', op: 'rename', newName: 'toolbox_probe_renamed' }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
});

test('事务内 DDL 提交前不发事件，提交后发一次', async () => {
  const conn = gateway.store.listConnections()[0];
  const sessionId = 'schema-tx-1';
  await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sessionId }) });

  const beforeCommit = await collect(async () => {
    const result = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE tx_probe (id INTEGER PRIMARY KEY)', sessionId }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(beforeCommit.length, 0, '未提交时别发事件：别的会话还看不到');

  const afterCommit = await collect(async () => {
    const result = await api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(afterCommit.length, 1, `提交后应发一次，实际 ${afterCommit.length}`);
});

test('事务内 DDL 回滚后发事件（结构可能已回退，客户端要重读）', async () => {
  const conn = gateway.store.listConnections()[0];
  const sessionId = 'schema-tx-2';
  await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sessionId }) });
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE tx_probe2 (id INTEGER PRIMARY KEY)', sessionId }),
  });

  const afterRollback = await collect(async () => {
    const result = await api('/tx/rollback', { method: 'POST', body: JSON.stringify({ sessionId }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(afterRollback.length, 1);
});

test('没有 DDL 的事务提交不发事件', async () => {
  const conn = gateway.store.listConnections()[0];
  const sessionId = 'schema-tx-3';
  await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sessionId }) });
  await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sql: 'SELECT 1', sessionId }) });

  const afterCommit = await collect(async () => {
    await api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId }) });
  });
  assert.equal(afterCommit.length, 0);
});

test('一个客户端发送失败不影响其它客户端收到同一事件', async () => {
  // 两个健康客户端 + 一个"坏"客户端。坏的那个用 readyState=1 但 send 抛错来模拟。
  const good = [await connectWs(), await connectWs()];
  const seen: any[][] = good.map(() => []);
  good.forEach((ws, i) => ws.on('message', (raw) => seen[i].push(JSON.parse(String(raw)))));

  // 直接往 wss.clients 里塞一个坏 socket，验证广播循环不会因为它中断。
  const broken = {
    readyState: 1,
    send: () => {
      throw new Error('socket closed mid-send');
    },
  } as any;
  // 关键：把坏客户端排在最前面。广播是同一个监听器里的 for 循环，
  // 如果循环体没有逐项保护，它抛错就会中断后面所有客户端的投递。
  const healthy = [...gateway.wss.clients];
  gateway.wss.clients.clear();
  gateway.wss.clients.add(broken);
  for (const ws of healthy) gateway.wss.clients.add(ws);

  try {
    gateway.manager.invalidate(gateway.store.listConnections()[0].id, 'user');
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    gateway.wss.clients.delete(broken);
    for (const ws of good) ws.close();
  }

  const counts = seen.map((list) => list.filter((m) => m.type === 'schema_changed').length);
  assert.deepEqual(counts, [1, 1], `两个健康客户端都应收到，实际 ${JSON.stringify(counts)}`);
});

test('事务超时被回收时，schemaDirty 的连接仍然发事件', async () => {
  const conn = gateway.store.listConnections()[0];
  const sessionId = 'schema-tx-reap';
  await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sessionId }) });
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE reap_probe (id INTEGER PRIMARY KEY)', sessionId }),
  });

  // 把 lastUsedAt 推远古，让 reaper 认定它超时。
  const sessions = (gateway.manager as any).txSessions as Map<string, { lastUsedAt: number }>;
  const entry = sessions.get(sessionId);
  assert.ok(entry, '前提：事务会话存在');
  entry.lastUsedAt = Date.now() - 60 * 60 * 1000;

  const events = await collect(async () => {
    await gateway.manager.reapIdleTransactions();
  });
  assert.equal(events.length, 1, `回收带结构变更的事务必须发事件，实际 ${events.length}`);
});
