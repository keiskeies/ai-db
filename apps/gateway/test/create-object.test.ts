import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { QdrantDriver } from '../src/drivers/qdrant';
import { ElasticsearchDriver } from '../src/drivers/elasticsearch';
import { WeaviateDriver } from '../src/drivers/weaviate';
import { MilvusDriver } from '../src/drivers/milvus';
import { supportsObjectCreate } from '../src/drivers/types';
import { createGateway } from '../src/server';

const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;
const WEAVIATE_PORT = process.env.AIDB_TEST_WEAVIATE_PORT ? Number(process.env.AIDB_TEST_WEAVIATE_PORT) : undefined;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('createObject builds engine-specific payloads', async () => {
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined });
    return json({ result: { status: 'ok' } });
  });
  try {
    const qdrant = new QdrantDriver({ host: '127.0.0.1', port: 6335 });
    assert.equal(supportsObjectCreate(qdrant), true);
    assert.deepEqual(await qdrant.createObject({ name: 'docs', dimension: 4, distance: 'Dot' }), { name: 'docs', kind: 'collection' });
    assert.match(seen[0].url, /\/collections\/docs$/);
    assert.equal(seen[0].method, 'PUT');
    assert.deepEqual(JSON.parse(seen[0].body ?? '{}'), { vectors: { size: 4, distance: 'Dot' } });
    await assert.rejects(() => qdrant.createObject({ name: 'docs' }), /维度/);

    const es = new ElasticsearchDriver({ host: '127.0.0.1', port: 9203 });
    assert.deepEqual(
      await es.createObject({ name: 'logs', fields: [{ name: 'msg', type: 'text' }, { name: 'code', type: 'not-a-type' }] }),
      { name: 'logs', kind: 'index' },
    );
    assert.deepEqual(JSON.parse(seen[1].body ?? '{}'), { mappings: { properties: { msg: { type: 'text' }, code: { type: 'keyword' } } } });

    const weaviate = new WeaviateDriver({ host: '127.0.0.1', port: 8081 });
    assert.deepEqual(
      await weaviate.createObject({ name: 'article', fields: [{ name: 'title', type: 'string' }, { name: 'views', type: 'int' }] }),
      { name: 'Article', kind: 'class' },
    );
    const classBody = JSON.parse(seen[2].body ?? '{}');
    assert.equal(classBody.class, 'Article');
    assert.equal(classBody.vectorizer, 'none');
    assert.deepEqual(classBody.properties, [
      { name: 'title', dataType: ['text'] },
      { name: 'views', dataType: ['int'] },
    ]);

    const milvus = new MilvusDriver({ host: '127.0.0.1', port: 19531 });
    assert.equal(supportsObjectCreate(milvus), false, 'Milvus 需要完整字段定义，不走通用建集合通道');
  } finally {
    mocked.mock.restore();
  }
});

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-create-object-'));
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
  return {
    api,
    createConnection,
    close: async () => {
      await gateway.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows 上句柄可能还未释放 */
      }
    },
  };
}

test('Qdrant collection is created over HTTP and appears in the schema', { skip: !QDRANT_PORT }, async () => {
  const base = `http://127.0.0.1:${QDRANT_PORT}`;
  await fetch(`${base}/collections/aidb_created`, { method: 'DELETE' }).catch(() => undefined);

  const env = await harness();
  after(env.close);
  const connectionId = await env.createConnection({
    name: 'qdrant-create',
    engine: 'qdrant',
    host: '127.0.0.1',
    port: QDRANT_PORT,
    database: 'default',
    groupName: 'live',
    color: 'cyan',
    environment: 'dev',
    readonly: false,
  });

  const created = await env.api<{ result: { name: string; kind: string } }>('/objects/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId, name: 'aidb_created', dimension: 3, distance: 'Cosine' }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.result.name, 'aidb_created');
  const schemas = await env.api<{ schemas: Array<{ tables: Array<{ name: string }> }> }>(`/connections/${connectionId}/schema?refresh=1`);
  assert.ok(schemas.body.schemas[0].tables.some((table) => table.name === 'aidb_created'), '刷新后的对象树包含新集合');

  const readonlyId = await env.createConnection({
    name: 'qdrant-create-readonly',
    engine: 'qdrant',
    host: '127.0.0.1',
    port: QDRANT_PORT,
    database: 'default',
    groupName: 'live',
    color: 'cyan',
    environment: 'dev',
    readonly: true,
  });
  const refused = await env.api<{ error: { code: string } }>('/objects/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonlyId, name: 'nope', dimension: 3 }),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'READONLY');

  await fetch(`${base}/collections/aidb_created`, { method: 'DELETE' }).catch(() => undefined);
});

test('Elasticsearch index and Weaviate class are created over HTTP', { skip: !ES_PORT || !WEAVIATE_PORT }, async () => {
  const esBase = `http://127.0.0.1:${ES_PORT}`;
  const wvBase = `http://127.0.0.1:${WEAVIATE_PORT}`;
  await fetch(`${esBase}/aidb_es_index`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${wvBase}/v1/schema/AidbClass`, { method: 'DELETE' }).catch(() => undefined);

  const env = await harness();
  after(env.close);
  const esId = await env.createConnection({
    name: 'es-create',
    engine: 'elasticsearch',
    host: '127.0.0.1',
    port: ES_PORT,
    groupName: 'live',
    color: 'orange',
    environment: 'dev',
    readonly: false,
  });
  const esCreated = await env.api<{ result: { kind: string } }>('/objects/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: esId, name: 'aidb_es_index', fields: [{ name: 'message', type: 'text' }] }),
  });
  assert.equal(esCreated.status, 200, JSON.stringify(esCreated.body));
  assert.equal(esCreated.body.result.kind, 'index');
  const mapping = (await fetch(`${esBase}/aidb_es_index/_mapping`).then((res) => res.json())) as any;
  assert.equal(mapping.aidb_es_index.mappings.properties.message.type, 'text');

  const wvId = await env.createConnection({
    name: 'weaviate-create',
    engine: 'weaviate',
    host: '127.0.0.1',
    port: WEAVIATE_PORT,
    groupName: 'live',
    color: 'purple',
    environment: 'dev',
    readonly: false,
  });
  const wvCreated = await env.api<{ result: { name: string; kind: string } }>('/objects/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: wvId, name: 'aidbClass', fields: [{ name: 'title', type: 'text' }] }),
  });
  assert.equal(wvCreated.status, 200, JSON.stringify(wvCreated.body));
  assert.equal(wvCreated.body.result.name, 'AidbClass');
  const schema = (await fetch(`${wvBase}/v1/schema/AidbClass`).then((res) => res.json())) as any;
  assert.equal(schema.class, 'AidbClass');
  assert.equal(schema.properties?.[0]?.name, 'title');

  await fetch(`${esBase}/aidb_es_index`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${wvBase}/v1/schema/AidbClass`, { method: 'DELETE' }).catch(() => undefined);
});
