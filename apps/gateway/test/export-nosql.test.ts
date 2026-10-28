import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';

const ARANGO_PORT = process.env.AIDB_TEST_ARANGO_PORT ? Number(process.env.AIDB_TEST_ARANGO_PORT) : undefined;
const ARANGO_PASSWORD = process.env.AIDB_TEST_ARANGO_PASSWORD ?? 'testpass';
const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;

async function seedArango(database: string) {
  const auth = `Basic ${Buffer.from(`root:${ARANGO_PASSWORD}`).toString('base64')}`;
  const base = `http://127.0.0.1:${ARANGO_PORT}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: auth, 'content-type': 'application/json' } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  await call('/_db/_system/_api/database', { method: 'POST', body: JSON.stringify({ name: database }) });
  await call(`/_db/${database}/_api/collection/thing`, { method: 'DELETE' });
  await call(`/_db/${database}/_api/collection`, { method: 'POST', body: JSON.stringify({ name: 'thing' }) });
  await call(`/_db/${database}/_api/document/thing`, {
    method: 'POST',
    body: JSON.stringify([
      { _key: 'a', name: 'Alpha' },
      { _key: 'b', name: 'Beta' },
    ]),
  });
}

test('non-SQL engines export their result set through /export', { skip: !ARANGO_PORT }, async () => {
  const database = 'aidb_export';
  await seedArango(database);

  const home = mkdtempSync(join(tmpdir(), 'aidb-export-nosql-'));
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
  const port = (gateway.server.address() as AddressInfo).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  after(async () => {
    // 先清掉测试库，避免污染共享实例的对象树
    await fetch(`http://127.0.0.1:${ARANGO_PORT}/_db/_system/_api/database/aidb_export`, {
      method: 'DELETE',
      headers: { authorization: `Basic ${Buffer.from(`root:${ARANGO_PASSWORD}`).toString('base64')}` },
    }).catch(() => undefined);
    await gateway.close();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* Windows 上 SQLite 句柄可能还未释放，临时目录交给系统清理 */
    }
  });

  const created = await api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'arango-export',
      engine: 'arangodb',
      host: '127.0.0.1',
      port: ARANGO_PORT,
      database,
      username: 'root',
      password: ARANGO_PASSWORD,
      groupName: 'live',
      color: 'green',
      environment: 'dev',
      readonly: true,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connectionId = created.body.connection.id;

  const csv = await api<{ file: { path: string; rows: number } }>('/export', {
    method: 'POST',
    body: JSON.stringify({ connectionId, database, sql: 'FOR d IN thing SORT d.name RETURN d', format: 'csv' }),
  });
  assert.equal(csv.status, 200, JSON.stringify(csv.body));
  assert.equal(csv.body.file.rows, 2);
  assert.ok(existsSync(csv.body.file.path), '导出文件存在');
  const text = readFileSync(csv.body.file.path, 'utf8');
  assert.match(text, /Alpha/);
  assert.match(text, /Beta/);

  const json = await api<{ file: { path: string; rows: number } }>('/export', {
    method: 'POST',
    body: JSON.stringify({ connectionId, database, sql: 'FOR d IN thing SORT d.name RETURN d', format: 'json' }),
  });
  assert.equal(json.status, 200, JSON.stringify(json.body));
  assert.deepEqual(JSON.parse(readFileSync(json.body.file.path, 'utf8')).map((row: Record<string, unknown>) => row.name), ['Alpha', 'Beta']);

  const refused = await api<{ error: { message: string } }>('/export', {
    method: 'POST',
    body: JSON.stringify({ connectionId, database, sql: 'FOR d IN thing RETURN d', format: 'sql' }),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /INSERT/);

  const noStatement = await api<{ error: { message: string; hint?: string } }>('/export', {
    method: 'POST',
    body: JSON.stringify({ connectionId, database, table: 'thing', format: 'csv' }),
  });
  assert.equal(noStatement.status, 400);
  assert.match(noStatement.body.error.message, /查询语句/);

  const audit = await api<{ entries: Array<{ tool: string; sql: string }> }>('/audit?limit=50');
  assert.ok(audit.body.entries.some((item) => item.tool === 'export' && /FOR d IN thing/.test(item.sql)), '导出进入审计');
});

test('Qdrant scroll results export to CSV', { skip: !QDRANT_PORT }, async () => {
  const base = `http://127.0.0.1:${QDRANT_PORT}`;
  await fetch(`${base}/collections/aidb_export`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${base}/collections/aidb_export`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: 2, distance: 'Cosine' } }),
  });
  await fetch(`${base}/collections/aidb_export/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      points: [
        { id: 1, vector: [1, 0], payload: { name: 'Ada' } },
        { id: 2, vector: [0, 1], payload: { name: 'Linus' } },
      ],
    }),
  });

  const home = mkdtempSync(join(tmpdir(), 'aidb-export-qdrant-'));
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
  const port = (gateway.server.address() as AddressInfo).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  after(async () => {
    // 先清掉测试集合，避免污染共享实例的对象树
    await fetch(`${base}/collections/aidb_export`, { method: 'DELETE' }).catch(() => undefined);
    await gateway.close();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* Windows 上 SQLite 句柄可能还未释放，临时目录交给系统清理 */
    }
  });

  const created = await api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'qdrant-export',
      engine: 'qdrant',
      host: '127.0.0.1',
      port: QDRANT_PORT,
      database: 'default',
      groupName: 'live',
      color: 'cyan',
      environment: 'dev',
      readonly: true,
    }),
  });
  const connectionId = created.body.connection.id;

  const exported = await api<{ file: { path: string; rows: number } }>('/export', {
    method: 'POST',
    body: JSON.stringify({
      connectionId,
      sql: JSON.stringify({ collection: 'aidb_export', op: 'scroll', topK: 10 }),
      format: 'csv',
    }),
  });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.file.rows, 2);
  const text = readFileSync(exported.body.file.path, 'utf8');
  assert.match(text, /Ada/);
  assert.match(text, /Linus/);
});
