import { listenRandom } from './helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

test('只读连接上 Agent 不能开事务，只读保护在管理器层生效', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aidb-agent-tx-ro-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  const dbFile = join(home, 'ro.db');
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
      body: JSON.stringify({ name: 'ro', engine: 'sqlite', database: dbFile, groupName: 'live', color: 'green', environment: 'dev', readonly: true }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const connectionId = created.body.connection.id;
    const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());
    const run = (name: string, args: Record<string, unknown> = {}) =>
      executor.execute(
        { id: `${name}-1`, name: name as any, args: { connectionId, ...args } },
        { sessionId: 'ro-s1', connectionId },
      );

    const began = await run('begin_transaction');
    assert.equal(began.ok, false, '只读连接不能开事务');
    assert.equal(began.error?.code, 'READONLY');
    assert.equal((gateway.manager as any).txSessions.size, 0, '失败的 begin 不留下会话');

    // 只读连接上读语句照常可用，写语句必须被拦截。
    const select = await run('run_sql', { sql: 'SELECT COUNT(*) AS n FROM t' });
    assert.equal(select.ok, true, select.error?.message);
    const write = await run('run_sql', { sql: 'INSERT INTO t VALUES (1)' });
    assert.equal(write.ok, false, '只读连接不能写入');
    assert.equal(write.error?.code, 'READONLY');
  } finally {
    await gateway.close();
    rmSync(home, { recursive: true, force: true });
  }
});
