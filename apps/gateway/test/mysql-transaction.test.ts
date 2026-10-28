import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/server';

const PORT = process.env.AIDB_TEST_MYSQL_PORT ? Number(process.env.AIDB_TEST_MYSQL_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass';
const DB = 'aidb_tx';
const PG_PORT = process.env.AIDB_TEST_PG_TX_PORT ? Number(process.env.AIDB_TEST_PG_TX_PORT) : undefined;
const PG_PASSWORD = process.env.AIDB_TEST_PG_TX_PASSWORD ?? 'testpass';

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-tx-'));
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

test('MySQL 跨请求事务：提交保留、回滚撤销、只读与非 MySQL 被拒', { skip: !PORT }, async () => {
  const env = await harness();
  after(env.close);
  const created = await env.api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'mysql-tx',
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

  const run = (sql: string, sessionId?: string) =>
    env.api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId, database: DB, sql, sessionId }),
    });

  await run('DROP TABLE IF EXISTS tx_probe');
  await run('CREATE TABLE tx_probe (id INT PRIMARY KEY, note VARCHAR(32)) ENGINE=InnoDB');
  await run("INSERT INTO tx_probe VALUES (1, 'seed')");

  // 提交路径：事务内插入后提交，另一条普通查询必须看得到。
  assert.equal((await env.api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId, sessionId: 's-commit', database: DB }) })).status, 200);
  await run("INSERT INTO tx_probe VALUES (2, 'committed')", 's-commit');
  assert.equal((await env.api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId: 's-commit' }) })).status, 200);
  const afterCommit = await run('SELECT id FROM tx_probe ORDER BY id');
  assert.deepEqual(afterCommit.body.batch.sets[0].rows.map((row) => row[0]), [1, 2], '提交后新行可见');

  // 回滚路径：事务内插入后回滚，行必须消失。
  assert.equal((await env.api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId, sessionId: 's-rollback', database: DB }) })).status, 200);
  await run("INSERT INTO tx_probe VALUES (3, 'rolled-back')", 's-rollback');
  assert.equal((await env.api('/tx/rollback', { method: 'POST', body: JSON.stringify({ sessionId: 's-rollback' }) })).status, 200);
  const afterRollback = await run('SELECT id FROM tx_probe ORDER BY id');
  assert.deepEqual(afterRollback.body.batch.sets[0].rows.map((row) => row[0]), [1, 2], '回滚后新行不存在');

  // 会话结束后再提交必须 404，不能静默成功。
  assert.equal((await env.api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId: 's-rollback' }) })).status, 404);

  // 只读连接不允许开事务。
  const roCreated = await env.api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'mysql-tx-ro',
      engine: 'mysql',
      host: '127.0.0.1',
      port: PORT,
      user: 'root',
      password: PASSWORD,
      database: DB,
      groupName: 'live',
      color: 'blue',
      environment: 'dev',
      readonly: true,
    }),
  });
  const ro = await env.api('/tx/begin', {
    method: 'POST',
    body: JSON.stringify({ connectionId: roCreated.body.connection.id, sessionId: 's-ro', database: DB }),
  });
  assert.equal(ro.status, 403);
  assert.equal((ro.body as any).error.code, 'READONLY');

  await run('DROP TABLE IF EXISTS tx_probe');
});

test('PostgreSQL 跨请求事务：提交保留、回滚撤销', { skip: !PG_PORT }, async () => {
  const env = await harness();
  after(env.close);
  const created = await env.api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'pg-tx',
      engine: 'postgresql',
      host: '127.0.0.1',
      port: PG_PORT,
      user: 'postgres',
      password: PG_PASSWORD,
      database: 'aidb_tx',
      groupName: 'live',
      color: 'blue',
      environment: 'dev',
      readonly: false,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connectionId = created.body.connection.id;

  const run = (sql: string, sessionId?: string) =>
    env.api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId, database: 'aidb_tx', sql, sessionId }),
    });

  await run('DROP TABLE IF EXISTS tx_probe');
  await run('CREATE TABLE tx_probe (id INT PRIMARY KEY, note VARCHAR(32))');
  await run("INSERT INTO tx_probe VALUES (1, 'seed')");

  assert.equal((await env.api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId, sessionId: 'pg-commit', database: 'aidb_tx' }) })).status, 200);
  await run("INSERT INTO tx_probe VALUES (2, 'committed')", 'pg-commit');
  assert.equal((await env.api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId: 'pg-commit' }) })).status, 200);
  const afterCommit = await run('SELECT id FROM tx_probe ORDER BY id');
  assert.deepEqual(afterCommit.body.batch.sets[0].rows.map((row) => row[0]), [1, 2], '提交后新行可见');

  assert.equal((await env.api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId, sessionId: 'pg-rollback', database: 'aidb_tx' }) })).status, 200);
  await run("INSERT INTO tx_probe VALUES (3, 'rolled-back')", 'pg-rollback');
  assert.equal((await env.api('/tx/rollback', { method: 'POST', body: JSON.stringify({ sessionId: 'pg-rollback' }) })).status, 200);
  const afterRollback = await run('SELECT id FROM tx_probe ORDER BY id');
  assert.deepEqual(afterRollback.body.batch.sets[0].rows.map((row) => row[0]), [1, 2], '回滚后新行不存在');

  assert.equal((await env.api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId: 'pg-rollback' }) })).status, 404);

  await run('DROP TABLE IF EXISTS tx_probe');
});