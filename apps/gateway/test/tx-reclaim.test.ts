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

test('空闲事务会被回收，活跃事务不受影响', { skip: !PORT }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'aidb-tx-reclaim-'));
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
  try {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'tx-reclaim', engine: 'mysql', host: '127.0.0.1', port: PORT,
        user: 'root', password: PASSWORD, database: DB,
        groupName: 'live', color: 'blue', environment: 'dev', readonly: false,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const connectionId = created.body.connection.id;
    const run = (sql: string, sessionId?: string) =>
      api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
        method: 'POST',
        body: JSON.stringify({ connectionId, database: DB, sql, sessionId }),
      });

    await run('DROP TABLE IF EXISTS tx_reclaim');
    await run('CREATE TABLE tx_reclaim (id INT PRIMARY KEY) ENGINE=InnoDB');
    await run('INSERT INTO tx_reclaim VALUES (1)');

    // 伪造一个 16 分钟前活跃的会话，下一次事务操作应把它回滚掉。
    const begin = await api<{ result: { sessionId: string } }>('/tx/begin', {
      method: 'POST',
      body: JSON.stringify({ connectionId, sessionId: 'stale', database: DB }),
    });
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    await run('INSERT INTO tx_reclaim VALUES (2)', 'stale');
    (gateway.manager as any).txSessions.get('stale').lastUsedAt = Date.now() - 16 * 60 * 1000;

    // 触发回收：开启另一个事务时会先清扫超时会话。
    assert.equal((await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId, sessionId: 'fresh', database: DB }) })).status, 200);
    assert.equal((gateway.manager as any).txSessions.has('stale'), false, '超时会话已被移除');

    const rows = await run('SELECT id FROM tx_reclaim ORDER BY id');
    assert.deepEqual(rows.body.batch.sets[0].rows.map((row) => row[0]), [1], '超时事务里的写入已回滚');

    // 活跃事务不会被误回收。
    await run('INSERT INTO tx_reclaim VALUES (3)', 'fresh');
    assert.equal((gateway.manager as any).txSessions.has('fresh'), true, '活跃会话保留');
    assert.equal((await api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId: 'fresh' }) })).status, 200);
    const afterCommit = await run('SELECT id FROM tx_reclaim ORDER BY id');
    assert.deepEqual(afterCommit.body.batch.sets[0].rows.map((row) => row[0]), [1, 3], '活跃事务提交成功');

    await run('DROP TABLE tx_reclaim');
  } finally {
    await gateway.close();
    rmSync(home, { recursive: true, force: true });
  }
});
