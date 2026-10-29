import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

const PORT = process.env.AIDB_TEST_MYSQL_PORT ? Number(process.env.AIDB_TEST_MYSQL_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass';
const DB = 'aidb_tx';

async function harness(txIdleMs?: number) {
  const home = mkdtempSync(join(tmpdir(), 'aidb-agent-tx-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  const gateway = await createGateway({
    home,
    dbPath: join(home, 'aidb.db'),
    secret: 'it-secret',
    token: 'it-token',
    demoDir: join(home, 'demo'),
    exportDir: join(home, 'exports'),
    importDir: join(home, 'imports'),
    backupDir: join(home, 'backups'),
    staticDir: join(home, 'static-missing'),
    port: 0,
    host: '127.0.0.1',
    production: false,
    txIdleMs,
  });
  await listenRandom(gateway.server);
  const port = (gateway.server.address() as any).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    api,
    gateway,
    close: async () => {
      await gateway.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows 上 SQLite 句柄可能还未释放 */
      }
    },
  };
}

test('Agent 事务工具：begin → run_sql → rollback/commit 作用在同一条连接', { skip: !PORT }, async () => {
  const env = await harness();
  after(env.close);
  const created = await env.api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'agent-tx',
      engine: 'mysql',
      host: '127.0.0.1',
      port: PORT,
      user: 'root',
      password: PASSWORD,
      database: DB,
      groupName: 'live',
      color: 'blue',
      environment: 'dev',
      readonly: false,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connectionId = created.body.connection.id;
  const executor = new ToolExecutor(env.gateway.store, env.gateway.manager, env.gateway.config, () => env.gateway.store.getSettings());
  const run = (name: string, args: Record<string, unknown>, sessionId = 'agent-s1') =>
    executor.execute({ id: `${name}-${Math.random()}`, name: name as any, args: { connectionId, database: DB, ...args } }, { sessionId, connectionId });

  await run('run_sql', { sql: 'DROP TABLE IF EXISTS agent_tx_probe' });
  await run('run_sql', { sql: 'CREATE TABLE agent_tx_probe (id INT PRIMARY KEY, note VARCHAR(32)) ENGINE=InnoDB' });
  await run('run_sql', { sql: "INSERT INTO agent_tx_probe VALUES (1, 'seed')" });

  // 回滚路径：事务内写入后回滚，行必须消失。
  assert.equal((await run('begin_transaction', {})).ok, true);
  assert.equal((await run('run_sql', { sql: "INSERT INTO agent_tx_probe VALUES (2, 'rolled-back')" })).ok, true);
  const inside = await run('run_sql', { sql: 'SELECT COUNT(*) AS n FROM agent_tx_probe' });
  assert.equal(Number((inside.data as any).rows?.[0]?.[0] ?? (inside.data as any).rows?.[0]?.n), 2, '事务内可见未提交行');
  assert.equal((await run('rollback_transaction', {})).ok, true);
  const afterRollback = await run('run_sql', { sql: 'SELECT COUNT(*) AS n FROM agent_tx_probe' });
  assert.equal(Number((afterRollback.data as any).rows?.[0]?.[0] ?? (afterRollback.data as any).rows?.[0]?.n), 1, '回滚后新行不存在');

  // 提交路径：另一个会话提交后行保留。
  assert.equal((await run('begin_transaction', {}, 'agent-s2')).ok, true);
  await run('run_sql', { sql: "INSERT INTO agent_tx_probe VALUES (3, 'committed')" }, 'agent-s2');
  assert.equal((await run('commit_transaction', {}, 'agent-s2')).ok, true);
  const afterCommit = await run('run_sql', { sql: 'SELECT COUNT(*) AS n FROM agent_tx_probe' });
  assert.equal(Number((afterCommit.data as any).rows?.[0]?.[0] ?? (afterCommit.data as any).rows?.[0]?.n), 2, '提交后新行可见');

  // 没有事务时提交必须失败，而不是静默成功。
  const noTx = await run('commit_transaction', {});
  assert.equal(noTx.ok, false);

  await run('run_sql', { sql: 'DROP TABLE agent_tx_probe' });
});

test('空闲事务会被定时回收并回滚', { skip: !PORT }, async () => {
  const env = await harness(400);
  after(env.close);
  const created = await env.api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'agent-tx-idle',
      engine: 'mysql',
      host: '127.0.0.1',
      port: PORT,
      user: 'root',
      password: PASSWORD,
      database: DB,
      groupName: 'live',
      color: 'blue',
      environment: 'dev',
      readonly: false,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connectionId = created.body.connection.id;
  const executor = new ToolExecutor(env.gateway.store, env.gateway.manager, env.gateway.config, () => env.gateway.store.getSettings());
  const run = (name: string, args: Record<string, unknown>, sessionId = 'idle-s1') =>
    executor.execute({ id: `${name}-${Math.random()}`, name: name as any, args: { connectionId, database: DB, ...args } }, { sessionId, connectionId });

  await run('run_sql', { sql: 'DROP TABLE IF EXISTS agent_idle_probe' });
  await run('run_sql', { sql: 'CREATE TABLE agent_idle_probe (id INT PRIMARY KEY, note VARCHAR(32)) ENGINE=InnoDB' });
  await run('run_sql', { sql: "INSERT INTO agent_idle_probe VALUES (1, 'seed')" });
  assert.equal((await run('begin_transaction', {})).ok, true);
  assert.equal((await run('run_sql', { sql: "INSERT INTO agent_idle_probe VALUES (2, 'stale')" })).ok, true);

  await new Promise((resolve) => setTimeout(resolve, 1600));
  const commit = await run('commit_transaction', {});
  assert.equal(commit.ok, false, '空闲超时后事务应已被回收');
  const count = await run('run_sql', { sql: 'SELECT COUNT(*) AS n FROM agent_idle_probe' });
  assert.equal(Number((count.data as any).rows?.[0]?.[0] ?? (count.data as any).rows?.[0]?.n), 1, '未提交行应已回滚');
  await run('run_sql', { sql: 'DROP TABLE agent_idle_probe' });
});
