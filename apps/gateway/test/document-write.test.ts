import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantDriver } from '../src/drivers/qdrant';
import { ElasticsearchDriver } from '../src/drivers/elasticsearch';
import { WeaviateDriver } from '../src/drivers/weaviate';
import { MilvusDriver } from '../src/drivers/milvus';
import { supportsDocumentWrite } from '../src/drivers/types';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('Qdrant upsert sends a point with vector and payload', async () => {
  const seen: Array<{ url: string; method?: string; body?: any }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return json({ result: { status: 'completed' } });
  });
  const driver = new QdrantDriver({ host: '127.0.0.1', port: 6335 });
  try {
    assert.equal(supportsDocumentWrite(driver), true);
    const result = await driver.upsertDocument({ collection: 'docs', document: { id: 7, vector: [0.1, 0.2], payload: { title: 'hi' } } });
    assert.deepEqual(result, { id: '7', upserted: 1 });
    assert.match(seen[0].url, /\/collections\/docs\/points\?wait=true$/);
    assert.equal(seen[0].method, 'PUT');
    assert.deepEqual(seen[0].body, { points: [{ id: 7, vector: [0.1, 0.2], payload: { title: 'hi' } }] });

    await assert.rejects(() => driver.upsertDocument({ collection: 'docs', document: { payload: {} } }), /vector/);
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Elasticsearch upsert puts a document by id', async () => {
  const seen: Array<{ url: string; method?: string; body?: any }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return json({ _id: 'abc', result: 'updated' });
  });
  const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9203 });
  try {
    const result = await driver.upsertDocument({ collection: 'logs', id: 'abc', document: { _id: 'ignored', message: 'boom' } });
    assert.deepEqual(result, { id: 'abc', upserted: 1 });
    assert.equal(seen[0].method, 'PUT');
    assert.match(seen[0].url, /\/logs\/_doc\/abc$/);
    assert.deepEqual(seen[0].body, { message: 'boom' });
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Weaviate upsert uses PUT when an id is supplied', async () => {
  const seen: Array<{ url: string; method?: string; body?: any }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return json({ id: 'obj-1' });
  });
  const driver = new WeaviateDriver({ host: '127.0.0.1', port: 8081 });
  try {
    const result = await driver.upsertDocument({
      collection: 'Article',
      id: 'obj-1',
      document: { properties: { title: 'hi' }, vector: [1, 0] },
    });
    assert.deepEqual(result, { id: 'obj-1', upserted: 1 });
    assert.equal(seen[0].method, 'PUT');
    assert.match(seen[0].url, /\/v1\/objects\/Article\/obj-1$/);
    assert.deepEqual(seen[0].body, { class: 'Article', properties: { title: 'hi' }, id: 'obj-1', vector: [1, 0] });
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Milvus upsert posts entities and returns the insert id', async () => {
  const seen: Array<{ url: string; body?: any }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return json({ code: 0, data: { upsertCount: 1, upsertIds: [42] } });
  });
  const driver = new MilvusDriver({ host: '127.0.0.1', port: 19531 });
  try {
    const result = await driver.upsertDocument({ collection: 'items', document: { id: 42, vector: [0.5], title: 'hi' } });
    assert.deepEqual(result, { id: '42', upserted: 1 });
    assert.match(seen[0].url, /\/v2\/vectordb\/entities\/upsert$/);
    assert.deepEqual(seen[0].body, { collectionName: 'items', data: [{ id: 42, vector: [0.5], title: 'hi' }] });
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});
