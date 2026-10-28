import { listenRandom } from './helpers';
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { editsRecords, engineMeta } from '@aidb/core';
import { ElasticsearchDriver } from '../src/drivers/elasticsearch';
import { QdrantDriver } from '../src/drivers/qdrant';
import { WeaviateDriver } from '../src/drivers/weaviate';
import { supportsDocumentRead } from '../src/drivers/types';
import { createGateway } from '../src/server';

const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;
const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const WEAVIATE_PORT = process.env.AIDB_TEST_WEAVIATE_PORT ? Number(process.env.AIDB_TEST_WEAVIATE_PORT) : undefined;
// Qdrant 的点 id 只接受无符号整数或 UUID，字符串主键会被服务端拒绝。
const POINT_ID = '7';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('recordEdit 只开给实现了单记录读取的引擎', () => {
  for (const engine of ['mongodb', 'qdrant', 'weaviate', 'elasticsearch', 'opensearch'] as const) {
    assert.equal(editsRecords(engine), true, engine);
  }
  for (const engine of ['redis', 'milvus', 'arangodb', 'mysql', 'cassandra'] as const) {
    assert.equal(editsRecords(engine), false, engine);
  }
  assert.equal(engineMeta('milvus').capabilities.documentWrite, true, 'Milvus 仍可批量写入，只是没有单点读回入口');
});

test('ES / Qdrant / Weaviate 的 getDocument 读回可写回的原文', async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method });
    const url = String(input);
    if (url.includes('/points/')) return json({ result: { id: 7, vector: [0.1, 0.2], payload: { title: 'hello' } } });
    if (url.includes('/v1/objects/')) return json({ id: 'abc', class: 'Article', properties: { title: 'hello' }, vector: [0.5] });
    if (url.includes('/_doc/')) return json({ _index: 'logs', _id: '42', found: true, _source: { message: 'hi' } });
    return json({ found: false });
  });
  try {
    const es = new ElasticsearchDriver({ host: '127.0.0.1', port: 9203 });
    assert.equal(supportsDocumentRead(es), true);
    const esDoc = await es.getDocument('logs', '42');
    assert.match(seen[0].url, /\/logs\/_doc\/42$/);
    assert.deepEqual(JSON.parse(esDoc.document), { _id: '42', message: 'hi' });

    const qdrant = new QdrantDriver({ host: '127.0.0.1', port: 6335 });
    assert.equal(supportsDocumentRead(qdrant), true);
    const point = await qdrant.getDocument('notes', '7');
    assert.match(seen[1].url, /\/collections\/notes\/points\/7\?with_vector=true&with_payload=true$/);
    assert.deepEqual(JSON.parse(point.document), { id: 7, vector: [0.1, 0.2], payload: { title: 'hello' } });

    const weaviate = new WeaviateDriver({ host: '127.0.0.1', port: 8081 });
    assert.equal(supportsDocumentRead(weaviate), true);
    const object = await weaviate.getDocument('article', 'abc');
    assert.match(seen[2].url, /\/v1\/objects\/Article\/abc\?include=vector$/, 'class 名补首字母大写');
    assert.deepEqual(JSON.parse(object.document), { id: 'abc', class: 'Article', vector: [0.5], properties: { title: 'hello' } });

    await assert.rejects(() => es.getDocument('  ', '1'), /索引名/);
    await assert.rejects(() => qdrant.getDocument('', '1'), /collection/);
    await assert.rejects(() => weaviate.getDocument('', '1'), /class 名/);
  } finally {
    mocked.mock.restore();
  }
});

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-record-edit-'));
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
  const connect = async (partial: Record<string, unknown>) => {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({ groupName: 'live', color: 'orange', environment: 'dev', readonly: false, ...partial }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.connection.id;
  };
  return {
    api,
    connect,
    gateway,
    close: async () => {
      await gateway.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows 上 SQLite 句柄可能还未释放，临时目录交给系统清理 */
      }
    },
  };
}

test('HTTP 读回单条记录：ES 索引文档、Qdrant 点、Weaviate 对象', { skip: !ES_PORT || !QDRANT_PORT || !WEAVIATE_PORT }, async () => {
  const env = await harness();
  after(env.close);
  const esId = await env.connect({ name: 'es-edit', engine: 'elasticsearch', host: '127.0.0.1', port: ES_PORT });
  const qdId = await env.connect({ name: 'qdrant-edit', engine: 'qdrant', host: '127.0.0.1', port: QDRANT_PORT });
  const wvId = await env.connect({ name: 'weaviate-edit', engine: 'weaviate', host: '127.0.0.1', port: WEAVIATE_PORT });

  await env.api('/objects/create', { method: 'POST', body: JSON.stringify({ connectionId: esId, name: 'aidb_record_es', fields: [{ name: 'message', type: 'text' }] }) });
  await env.api('/objects/create', { method: 'POST', body: JSON.stringify({ connectionId: qdId, name: 'aidb_record_qdrant', dimension: 3 }) });
  await env.api('/objects/create', { method: 'POST', body: JSON.stringify({ connectionId: wvId, name: 'AidbRecordWv', fields: [{ name: 'title', type: 'text' }] }) });

  await env.api('/documents/upsert', {
    method: 'POST',
    body: JSON.stringify({ connectionId: esId, collection: 'aidb_record_es', documents: [{ _id: 'r1', message: 'hello' }] }),
  });
  await env.api('/documents/upsert', {
    method: 'POST',
    body: JSON.stringify({ connectionId: qdId, collection: 'aidb_record_qdrant', documents: [{ id: POINT_ID, vector: [0.1, 0.2, 0.3], payload: { title: 'hello' } }] }),
  });
  const wvWrite = await env.api('/documents/upsert', {
    method: 'POST',
    body: JSON.stringify({ connectionId: wvId, collection: 'AidbRecordWv', documents: [{ id: 'c0ffee00-0000-4000-8000-000000000001', properties: { title: 'hello' } }] }),
  });
  assert.equal(wvWrite.status, 200, JSON.stringify(wvWrite.body));

  const esDoc = await env.api<{ detail: { id: string; document: string } }>(
    `/documents/get?connectionId=${esId}&collection=aidb_record_es&id=r1`,
  );
  assert.equal(esDoc.status, 200, JSON.stringify(esDoc.body));
  assert.equal(JSON.parse(esDoc.body.detail.document).message, 'hello');

  const point = await env.api<{ detail: { id: string; document: string } }>(
    `/documents/get?connectionId=${qdId}&collection=aidb_record_qdrant&id=${POINT_ID}`,
  );
  assert.equal(point.status, 200, JSON.stringify(point.body));
  const pointDoc = JSON.parse(point.body.detail.document);
  assert.deepEqual(pointDoc.payload, { title: 'hello' });
  assert.equal(pointDoc.vector.length, 3, '读回向量，编辑后可原样写回');

  const object = await env.api<{ detail: { id: string; document: string } }>(
    `/documents/get?connectionId=${wvId}&collection=AidbRecordWv&id=c0ffee00-0000-4000-8000-000000000001`,
  );
  assert.equal(object.status, 200, JSON.stringify(object.body));
  assert.deepEqual(JSON.parse(object.body.detail.document).properties, { title: 'hello' });

  const missing = await env.api<{ error: { code: string } }>(`/documents/get?connectionId=${esId}&collection=aidb_record_es&id=nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'SEARCH_DOC_NOT_FOUND');

  const readonly = await env.connect({ name: 'es-edit-ro', engine: 'elasticsearch', host: '127.0.0.1', port: ES_PORT, readonly: true });
  const roRead = await env.api(`/documents/get?connectionId=${readonly}&collection=aidb_record_es&id=r1`);
  assert.equal(roRead.status, 200, '只读连接仍可读回记录，只是不能写回');

  const redisRead = await env.api<{ error: { code: string } }>(`/documents/get?connectionId=${esId}&collection=aidb_record_es&id=`);
  assert.equal(redisRead.status, 400);

  await env.api('/objects/drop', { method: 'POST', body: JSON.stringify({ connectionId: esId, name: 'aidb_record_es' }) });
  await env.api('/objects/drop', { method: 'POST', body: JSON.stringify({ connectionId: qdId, name: 'aidb_record_qdrant' }) });
  await env.api('/objects/drop', { method: 'POST', body: JSON.stringify({ connectionId: wvId, name: 'AidbRecordWv' }) });
});