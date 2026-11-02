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

test('清缓存失败不能把已经成功的 DDL 报成失败', async () => {
  // 场景：DDL 已经在数据库里落地了，紧接着清 schema 缓存时 sqlite 出错
  // （锁冲突、磁盘满、库文件被移走等）。此时抛出会让调用方以为 DDL 失败
  // 并重试，而实际已经生效 —— 比"缓存没清干净"严重得多。
  const conn = gateway.store.listConnections()[0];
  const original = gateway.store.clearSchemaCache.bind(gateway.store);
  const boom = () => {
    throw new Error('clearSchemaCache: database is locked');
  };
  (gateway.store as any).clearSchemaCache = boom;

  let result: any;
  let thrown: any;
  try {
    result = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE resilient_probe (id INTEGER PRIMARY KEY)' }),
    });
  } catch (err) {
    thrown = err;
  } finally {
    (gateway.store as any).clearSchemaCache = original;
  }

  assert.equal(thrown, undefined, `清缓存失败不该让请求抛错：${thrown?.message}`);
  assert.equal(result.status, 200, `DDL 应报成功，实际 ${result.status} ${JSON.stringify(result.body)}`);

  // 表确实建出来了，证明"DDL 成功但清缓存失败"这个组合是真实存在的。
  const after = await fetch(`${base}/api/connections/${conn.id}/schema?refresh=1`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
  assert.ok(JSON.stringify(after).includes('resilient_probe'), '表应已建好');
});

test('纯数据变更只清缓存、不广播结构变更事件', async () => {
  const conn = gateway.store.listConnections()[0];
  // 准备一张有数据的表
  await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE quiet_probe (id INTEGER PRIMARY KEY, note TEXT)' }) });
  await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sql: "INSERT INTO quiet_probe (id, note) VALUES (1, 'aa')" }) });
  await new Promise((r) => setTimeout(r, 200));

  // 路径 1：CSV 导入（纯写数据）
  const importEvents = await collect(async () => {
    const res = await api('/import', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, table: 'quiet_probe', csv: 'id,note\n2,bb\n', hasHeader: true }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
  assert.equal(importEvents.length, 0, `CSV 导入不该广播，实际 ${importEvents.length}`);

  // 路径 2：数据替换（纯 UPDATE）
  const replaceEvents = await collect(async () => {
    const res = await api('/data/replace', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, table: 'quiet_probe', column: 'note', find: 'aa', replace: 'zz' }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
  assert.equal(replaceEvents.length, 0, `数据替换不该广播，实际 ${replaceEvents.length}`);
});

test('纯数据变更仍然清掉 schema 缓存（行数估算要能刷新）', async () => {
  const conn = gateway.store.listConnections()[0];
  // 先让缓存就位
  await fetch(`${base}/api/connections/${conn.id}/schema`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const before = gateway.store.getSchemaCache(conn.id, gateway.store.getConnection(conn.id).database ?? 'main');
  assert.ok(before, '前提：缓存应已写入');

  await api('/import', {
    method: 'POST',
    body: JSON.stringify({ connectionId: conn.id, table: 'quiet_probe', csv: 'id,note\n3,cc\n', hasHeader: true }),
  });

  const after = gateway.store.getSchemaCache(conn.id, gateway.store.getConnection(conn.id).database ?? 'main');
  assert.equal(after, undefined, '不广播不等于可以留脏缓存：缓存必须被清掉');
});

test('SQL Server 走 manager.query 执行 EXEC sp_rename 会发事件', async () => {
  // 用假驱动替掉真实 SQL Server：本条要验的是「SQL Server 这类语句进入
  // manager.query() 后会不会被判为结构变更并广播」，不是驱动本身对不对。
  // 没有这个用例，SQL Server 的工具箱重命名路径就没有端到端覆盖 —— 上一轮
  // 正是因为判定比 classifySql 更窄，这条路径既不广播也不清缓存。
  const sqlserver = gateway.store.createConnection({
    name: 'e2e-sqlserver',
    engine: 'sqlserver',
    host: '127.0.0.1',
    port: 1433,
    database: 'master',
    username: 'sa',
  });

  const ran: string[] = [];
  const fakeDriver = {
    engine: 'sqlserver' as const,
    test: async () => ({ ok: true, latencyMs: 1 }),
    listDatabases: async () => ['master'],
    describe: async () => [],
    run: async (sql: string) => {
      ran.push(sql);
      return { columns: [], rows: [], rowCount: 0, durationMs: 1 };
    },
    runParams: async () => ({ columns: [], rows: [], rowCount: 0, durationMs: 1 }),
    close: async () => undefined,
  };
  // 注入到 manager 的驱动缓存，绕开真实建连。
  (gateway.manager as any).clients.set(sqlserver.id, { driver: fakeDriver, close: async () => undefined });

  try {
    const events = await collect(async () => {
      const res = await api('/query', {
        method: 'POST',
        body: JSON.stringify({ connectionId: sqlserver.id, sql: "EXEC sp_rename 'dbo.orders','orders_v2'" }),
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
    assert.deepEqual(ran, ["EXEC sp_rename 'dbo.orders','orders_v2'"], '语句应真的交给驱动执行');
    assert.equal(events.length, 1, `SQL Server 重命名必须发事件，实际 ${events.length}`);
    assert.equal(events[0].connectionId, sqlserver.id);
  } finally {
    (gateway.manager as any).clients.delete(sqlserver.id);
    gateway.store.deleteConnection(sqlserver.id);
  }
});

test('MySQL 事务内 DDL 立刻发事件（DDL 隐式提交，等 COMMIT 就太晚了）', async () => {
  // MySQL/MariaDB/Oracle/DM 的 DDL 会隐式提交当前事务，执行完就已对别的会话可见。
  // 若按「等 COMMIT 再发」处理，用户会一直看着旧结构，直到他敲 COMMIT 或手动刷新。
  const mysql = gateway.store.createConnection({
    name: 'e2e-mysql',
    engine: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    database: 'demo',
    username: 'root',
  });

  const ran: string[] = [];
  const fakeDriver = {
    engine: 'mysql' as const,
    test: async () => ({ ok: true, latencyMs: 1 }),
    listDatabases: async () => ['demo'],
    describe: async () => [],
    run: async (sql: string) => {
      ran.push(sql);
      return { columns: [], rows: [], rowCount: 0, durationMs: 1 };
    },
    runParams: async () => ({ columns: [], rows: [], rowCount: 0, durationMs: 1 }),
    close: async () => undefined,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    runInTransaction: async (_sid: string, sql: string) => {
      ran.push(sql);
      return { columns: [], rows: [], rowCount: 0, durationMs: 1 };
    },
  };
  (gateway.manager as any).clients.set(mysql.id, { driver: fakeDriver, close: async () => undefined });

  const sessionId = 'e2e-mysql-tx';
  try {
    await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: mysql.id, sessionId }) });

    const events = await collect(async () => {
      const res = await api('/query', {
        method: 'POST',
        body: JSON.stringify({ connectionId: mysql.id, sql: 'ALTER TABLE orders ADD COLUMN note TEXT', sessionId }),
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    assert.deepEqual(ran, ['ALTER TABLE orders ADD COLUMN note TEXT'], '事务内语句应走 runInTransaction');
    assert.equal(events.length, 1, `MySQL 隐式提交的 DDL 必须立刻发事件，实际 ${events.length}`);
  } finally {
    (gateway.manager as any).clients.delete(mysql.id);
    gateway.store.deleteConnection(mysql.id);
  }
});
