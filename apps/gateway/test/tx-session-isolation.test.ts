import { listenRandom } from './helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../src/server';

test('别的事务会话 id 落到另一条连接上时按普通查询执行', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aidb-tx-isolation-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  for (const name of ['a.db', 'b.db']) {
    const db = new DatabaseSync(join(home, name));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)');
    db.exec(`INSERT INTO t VALUES (1, '${name}')`);
    db.close();
  }

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
    const make = async (name: string, file: string) => {
      const created = await api<{ connection: { id: string } }>('/connections', {
        method: 'POST',
        body: JSON.stringify({ name, engine: 'sqlite', database: join(home, file), groupName: 'live', color: 'green', environment: 'dev', readonly: false }),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body.connection.id;
    };
    const a = await make('tx-a', 'a.db');
    const b = await make('tx-b', 'b.db');

    assert.equal((await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: a, sessionId: 'only-a' }) })).status, 200);

    // 把 A 的事务 id 发给 B：必须正常返回结果，而不是 TX_NOT_FOUND。
    const cross = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: b, sql: 'SELECT note FROM t', sessionId: 'only-a' }),
    });
    assert.equal(cross.status, 200, JSON.stringify(cross.body));
    assert.deepEqual(cross.body.batch.sets[0].rows, [['b.db']], '查询落在 B 连接上');

    // A 的事务仍然健在，可以正常提交。
    assert.equal((await api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId: 'only-a' }) })).status, 200);
  } finally {
    await gateway.close();
    rmSync(home, { recursive: true, force: true });
  }
});
