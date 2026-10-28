import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';

const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-import-docs-'));
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
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (gateway.server.address() as AddressInfo).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const createConnection = async (body: Record<string, unknown>) => {
    const created = await api<{ connection: { id: string } }>('/connections', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.connection.id;
  };
  return { api, createConnection, close: async () => { await gateway.close(); rmSync(home, { recursive: true, force: true }); } };
}

test('CSV import writes Qdrant points with id, vector and typed payload', { skip: !QDRANT_PORT }, async () => {
  const base = `http://127.0.0.1:${QDRANT_PORT}`;
  await fetch(`${base}/collections/aidb_import`, { method: 'DELETE' }).catch(() => undefined);
  const put = await fetch(`${base}/collections/aidb_import`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: 2, distance: 'Cosine' } }),
  });
  assert.equal(put.status, 200, await put.text());

  const env = await harness();
  after(env.close);
  const connectionId = await env.createConnection({
    name: 'qdrant-import',
    engine: 'qdrant',
    host: '127.0.0.1',
    port: QDRANT_PORT,
    database: 'default',
    groupName: 'live',
    color: 'cyan',
    environment: 'dev',
    readonly: false,
  });

  const csv = ['id,vector,title,score,flag', '1,"[0.1, 0.2]",alpha,3,true', '2,"0.3 0.4",beta,4,false'].join('\n');
  const imported = await env.api<{ result: { imported: number; skipped: number; errors: string[] } }>('/documents/import', {
    method: 'POST',
    body: JSON.stringify({ connectionId, collection: 'aidb_import', csv, idColumn: 'id', vectorColumn: 'vector' }),
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.result.imported, 2);
  assert.deepEqual(imported.body.result.errors, []);

  const scroll = await fetch(`${base}/collections/aidb_import/points/scroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 10, with_payload: true }),
  }).then((res) => res.json() as any);
  const byId = new Map<number, Record<string, unknown>>(scroll.result.points.map((point: any) => [point.id, point.payload]));
  assert.equal(byId.get(1)?.title, 'alpha');
  assert.equal(byId.get(1)?.score, 3);
  assert.equal(byId.get(1)?.flag, true);
  assert.equal(byId.get(2)?.flag, false);

  const broken = await env.api<{ error: { message: string } }>('/documents/import', {
    method: 'POST',
    body: JSON.stringify({ connectionId, collection: 'aidb_import', csv: 'id,vector\n5,not-a-vector', idColumn: 'id', vectorColumn: 'vector' }),
  });
  assert.equal(broken.status, 400);
  assert.match(broken.body.error.message, /vector/);

  const readonlyId = await env.createConnection({
    name: 'qdrant-import-readonly',
    engine: 'qdrant',
    host: '127.0.0.1',
    port: QDRANT_PORT,
    database: 'default',
    groupName: 'live',
    color: 'cyan',
    environment: 'dev',
    readonly: true,
  });
  const refused = await env.api<{ error: { code: string } }>('/documents/import', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonlyId, collection: 'aidb_import', csv: 'id,vector\n9,"[1,0]"', idColumn: 'id', vectorColumn: 'vector' }),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'READONLY');

  await fetch(`${base}/collections/aidb_import`, { method: 'DELETE' }).catch(() => undefined);
});

test('CSV import indexes Elasticsearch documents by id', { skip: !ES_PORT }, async () => {
  const base = `http://127.0.0.1:${ES_PORT}`;
  await fetch(`${base}/aidb_import_logs`, { method: 'DELETE' }).catch(() => undefined);

  const env = await harness();
  after(env.close);
  const connectionId = await env.createConnection({
    name: 'es-import',
    engine: 'elasticsearch',
    host: '127.0.0.1',
    port: ES_PORT,
    groupName: 'live',
    color: 'orange',
    environment: 'dev',
    readonly: false,
  });

  const csv = ['doc_id,level,message', 'a1,error,disk full', 'a2,info,rotated'].join('\n');
  const imported = await env.api<{ result: { imported: number } }>('/documents/import', {
    method: 'POST',
    body: JSON.stringify({ connectionId, collection: 'aidb_import_logs', csv, idColumn: 'doc_id' }),
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.result.imported, 2);

  const search = await fetch(`${base}/aidb_import_logs/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: { match_all: {} } }),
  }).then((res) => res.json() as any);
  const ids = (search.hits?.hits ?? []).map((hit: any) => hit._id).sort();
  assert.deepEqual(ids, ['a1', 'a2']);
  const first = (search.hits.hits as any[]).find((hit) => hit._id === 'a1');
  assert.equal(first._source.message, 'disk full');

  await fetch(`${base}/aidb_import_logs`, { method: 'DELETE' }).catch(() => undefined);
});
