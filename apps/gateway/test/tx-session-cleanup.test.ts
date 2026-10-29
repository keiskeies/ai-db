import { listenRandom } from './helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../src/server';

test('关闭连接会一并清掉它的事务会话，不阻塞同名的新事务', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aidb-tx-cleanup-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  const dbFile = join(home, 'cleanup.db');
  const seed = new DatabaseSync(dbFile);
  seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  seed.close();

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
        name: 'sqlite-cleanup', engine: 'sqlite', database: dbFile,
        groupName: 'live', color: 'green', environment: 'dev', readonly: false,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const connectionId = created.body.connection.id;

    assert.equal((await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId, sessionId: 's1' }) })).status, 200);
    assert.equal((gateway.manager as any).txSessions.has('s1'), true);

    await gateway.manager.close(connectionId);
    assert.equal((gateway.manager as any).txSessions.has('s1'), false, '关闭连接后事务会话被清掉');

    // 同一个 sessionId 可以重新开事务，不会被 TX_ACTIVE 挡住。
    assert.equal((await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId, sessionId: 's1' }) })).status, 200);
    assert.equal((await api('/tx/rollback', { method: 'POST', body: JSON.stringify({ sessionId: 's1' }) })).status, 200);
  } finally {
    await gateway.close();
    rmSync(home, { recursive: true, force: true });
  }
});
