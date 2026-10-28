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
import { MongoDriver } from '../src/drivers/mongodb';
import { ArangoDriver } from '../src/drivers/arangodb';
import { supportsObjectCreate } from '../src/drivers/types';
import { createGateway } from '../src/server';

const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;
const WEAVIATE_PORT = process.env.AIDB_TEST_WEAVIATE_PORT ? Number(process.env.AIDB_TEST_WEAVIATE_PORT) : undefined;
const ARANGO_PORT = process.env.AIDB_TEST_ARANGO_PORT ? Number(process.env.AIDB_TEST_ARANGO_PORT) : undefined;
const ARANGO_PASSWORD = process.env.AIDB_TEST_ARANGO_PASSWORD ?? 'testpass';

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

test('dropObject issues engine-specific DELETE requests', async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method });
    return json({ acknowledged: true, headers_present: {}, http_code: 200, data: {}, error: false });
  });
  try {
    const qdrant = new QdrantDriver({ host: '127.0.0.1', port: 6335 });
    assert.deepEqual(await qdrant.dropObject('docs'), { name: 'docs', dropped: true });
    assert.equal(seen[0].method, 'DELETE');
    assert.match(seen[0].url, /\/collections\/docs$/);

    const es = new ElasticsearchDriver({ host: '127.0.0.1', port: 9203 });
    assert.deepEqual(await es.dropObject('logs'), { name: 'logs', dropped: true });
    assert.equal(seen[1].method, 'DELETE');
    assert.match(seen[1].url, /\/logs$/);

    const weaviate = new WeaviateDriver({ host: '127.0.0.1', port: 8081 });
    assert.deepEqual(await weaviate.dropObject('article'), { name: 'Article', dropped: true });
    assert.equal(seen[2].method, 'DELETE');
    assert.match(seen[2].url, /\/v1\/schema\/Article$/);

    await assert.rejects(() => qdrant.dropObject('  '), /不能为空/);
  } finally {
    mocked.mock.restore();
  }
});

test('ArangoDB builds document or edge collections and refuses system names', async () => {
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined });
    return json({ name: 'ignored' });
  });
  try {
    const arango = new ArangoDriver({ host: '127.0.0.1', port: 8530, database: 'aidb' });
    assert.equal(supportsObjectCreate(arango), true);
    assert.deepEqual(await arango.createObject({ name: 'people' }), { name: 'people', kind: 'collection' });
    assert.match(seen[0].url, /\/_db\/aidb\/_api\/collection$/);
    assert.deepEqual(JSON.parse(seen[0].body ?? '{}'), { name: 'people', type: 2 });

    assert.deepEqual(await arango.createObject({ name: 'knows', edge: true }), { name: 'knows', kind: 'edge_label' });
    assert.deepEqual(JSON.parse(seen[1].body ?? '{}'), { name: 'knows', type: 3 }, '边集合靠 body 里的 type=3');

    await assert.rejects(() => arango.createObject({ name: '_private' }), /系统集合/);
    assert.deepEqual(await arango.dropObject('people'), { name: 'people', dropped: true });
    assert.equal(seen[2].method, 'DELETE');
    assert.match(seen[2].url, /\/_api\/collection\/people$/);
    await assert.rejects(() => arango.dropObject('_graphs'), /系统集合/);
  } finally {
    mocked.mock.restore();
  }
});

test('MongoDB create/drop collection uses the driver API', async () => {
  const calls: string[] = [];
  const client = {
    db(name: string) {
      return {
        createCollection(collection: string) {
          calls.push(`create ${name}.${collection}`);
          return Promise.resolve();
        },
        collection(collection: string) {
          return {
            drop() {
              calls.push(`drop ${name}.${collection}`);
              return Promise.resolve(true);
            },
          };
        },
      };
    },
  };
  const driver = new MongoDriver({ host: '127.0.0.1', port: 27018, database: 'appdb' });
  const connect = mock.method(driver as any, 'connect', () => Promise.resolve(client as any));
  try {
    assert.equal(supportsObjectCreate(driver), true);
    assert.deepEqual(await driver.createObject({ name: 'logs' }), { name: 'logs', kind: 'collection' });
    assert.deepEqual(await driver.dropObject('logs'), { name: 'logs', dropped: true });
    assert.deepEqual(calls, ['create appdb.logs', 'drop appdb.logs']);
  } finally {
    connect.mock.restore();
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

  const dropRefused = await env.api<{ error: { code: string } }>('/objects/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonlyId, name: 'aidb_created' }),
  });
  assert.equal(dropRefused.status, 403);
  assert.equal(dropRefused.body.error.code, 'READONLY');

  const dropped = await env.api<{ result: { name: string; dropped: boolean } }>('/objects/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId, name: 'aidb_created' }),
  });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal(dropped.body.result.dropped, true);
  const listed = (await fetch(`${base}/collections`).then((res) => res.json())) as any;
  assert.ok(
    !(listed?.collections ?? []).some((item: any) => item?.name === 'aidb_created'),
    '删除后集合不再出现',
  );
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

  const esDropped = await env.api<{ result: { dropped: boolean } }>('/objects/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId: esId, name: 'aidb_es_index' }),
  });
  assert.equal(esDropped.status, 200, JSON.stringify(esDropped.body));
  assert.equal((await fetch(`${esBase}/aidb_es_index`).then((res) => res.status)), 404);

  const wvDropped = await env.api<{ result: { name: string; dropped: boolean } }>('/objects/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId: wvId, name: 'aidbClass' }),
  });
  assert.equal(wvDropped.status, 200, JSON.stringify(wvDropped.body));
  assert.equal(wvDropped.body.result.name, 'AidbClass', '删除时同样补上首字母大写');
  assert.equal((await fetch(`${wvBase}/v1/schema/AidbClass`).then((res) => res.status)), 404);
});

test('ArangoDB 文档集合与边集合能建能删', { skip: !ARANGO_PORT }, async () => {
  const base = `http://127.0.0.1:${ARANGO_PORT}`;
  const auth = { authorization: `Basic ${Buffer.from(`root:${ARANGO_PASSWORD}`, 'utf8').toString('base64')}` };
  for (const name of ['aidb_docs', 'aidb_edges']) {
    await fetch(`${base}/_db/_system/_api/collection/${name}`, { method: 'DELETE', headers: auth }).catch(() => undefined);
  }

  const env = await harness();
  after(env.close);
  const connectionId = await env.createConnection({
    name: 'arango-create-drop',
    engine: 'arangodb',
    host: '127.0.0.1',
    port: ARANGO_PORT,
    database: '_system',
    username: 'root',
    password: ARANGO_PASSWORD,
    groupName: 'live',
    color: 'cyan',
    environment: 'dev',
    readonly: false,
  });

  const docs = await env.api<{ result: { kind: string } }>('/objects/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId, name: 'aidb_docs' }),
  });
  assert.equal(docs.status, 200, JSON.stringify(docs.body));
  assert.equal(docs.body.result.kind, 'collection');

  const edges = await env.api<{ result: { kind: string } }>('/objects/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId, name: 'aidb_edges', edge: true }),
  });
  assert.equal(edges.status, 200, JSON.stringify(edges.body));
  assert.equal(edges.body.result.kind, 'edge_label');
  const edgeMeta = (await fetch(`${base}/_db/_system/_api/collection/aidb_edges`, { headers: auth }).then((res) => res.json())) as any;
  assert.equal(edgeMeta.type, 3, '边集合真的是 edge collection');

  const schemas = await env.api<{ schemas: Array<{ tables: Array<{ name: string; kind?: string }> }> }>(
    `/connections/${connectionId}/schema?refresh=1`,
  );
  const tables = schemas.body.schemas[0].tables;
  assert.ok(tables.some((table) => table.name === 'aidb_docs'), '对象树包含新建集合');
  assert.ok(tables.some((table) => table.name === 'aidb_edges' && table.kind === 'edge_label'), '对象树标出边集合');

  const refused = await env.api<{ error: { code: string } }>('/objects/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId, name: '_graphs' }),
  });
  assert.ok(refused.status >= 400, '系统集合不允许删除');

  const dropped = await env.api<{ result: { dropped: boolean } }>('/objects/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId, name: 'aidb_docs' }),
  });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal((await fetch(`${base}/_db/_system/_api/collection/aidb_docs`, { headers: auth }).then((res) => res.status)), 404);

  await env.api('/objects/drop', { method: 'POST', body: JSON.stringify({ connectionId, name: 'aidb_edges' }) });
});
