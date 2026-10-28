import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantDriver } from '../src/drivers/qdrant';
import { ElasticsearchDriver } from '../src/drivers/elasticsearch';
import { WeaviateDriver } from '../src/drivers/weaviate';
import { MilvusDriver } from '../src/drivers/milvus';
import { supportsDocumentWrite } from '../src/drivers/types';

interface Seen {
  url: string;
  method?: string;
  body?: string;
  contentType?: string;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function stub(seen: Seen[], reply: (url: string) => Response) {
  return mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const url = String(input);
    seen.push({
      url,
      method: init?.method,
      body: init?.body ? String(init.body) : undefined,
      contentType: headers['content-type'] ?? headers['Content-Type'],
    });
    return reply(url);
  });
}

test('Qdrant writes and deletes points in batch', async () => {
  const seen: Seen[] = [];
  const mocked = stub(seen, () => json({ result: { status: 'completed' } }));
  const driver = new QdrantDriver({ host: '127.0.0.1', port: 6335 });
  try {
    assert.equal(supportsDocumentWrite(driver), true);
    const write = await driver.upsertDocuments({
      collection: 'docs',
      documents: [
        { id: 1, vector: [0.1, 0.2], payload: { name: 'Ada' } },
        { id: '2', vector: [0.3, 0.4], title: 'Linus' },
      ],
    });
    assert.deepEqual(write, { ids: ['1', '2'], upserted: 2 });
    assert.equal(seen[0].method, 'PUT');
    assert.match(seen[0].url, /\/collections\/docs\/points\?wait=true$/);
    const points = JSON.parse(seen[0].body ?? '{}').points;
    assert.equal(points[0].id, 1);
    assert.deepEqual(points[1].payload, { title: 'Linus' });

    const del = await driver.deleteDocuments({ collection: 'docs', ids: ['1', '2'] });
    assert.deepEqual(del, { deleted: 2 });
    assert.equal(seen[1].method, 'POST');
    assert.match(seen[1].url, /\/collections\/docs\/points\/delete\?wait=true$/);
    assert.deepEqual(JSON.parse(seen[1].body ?? '{}').points, [1, 2]);

    await assert.rejects(() => driver.upsertDocuments({ collection: 'docs', documents: [{ payload: {} }] }), /vector/);
    await assert.rejects(() => driver.deleteDocuments({ collection: 'docs', ids: [] }), /ids/);
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Elasticsearch bulk indexes and deletes by ids', async () => {
  const seen: Seen[] = [];
  const mocked = stub(seen, (url) =>
    url.includes('_bulk')
      ? json({ errors: false, items: [{ index: { _id: 'a' } }, { index: { _id: 'b' } }] })
      : json({ deleted: 2 }),
  );
  const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9203 });
  try {
    const write = await driver.upsertDocuments({
      collection: 'logs',
      documents: [{ _id: 'a', message: 'one' }, { message: 'two' }],
    });
    assert.deepEqual(write, { ids: ['a', 'b'], upserted: 2 });
    assert.equal(seen[0].method, 'POST');
    assert.match(seen[0].url, /\/_bulk\?refresh=true$/);
    assert.equal(seen[0].contentType, 'application/x-ndjson');
    const lines = (seen[0].body ?? '').trim().split('\n');
    assert.equal(lines.length, 4);
    assert.deepEqual(JSON.parse(lines[0]), { index: { _index: 'logs', _id: 'a' } });
    assert.deepEqual(JSON.parse(lines[1]), { message: 'one' });

    const del = await driver.deleteDocuments({ collection: 'logs', ids: ['a', 'b'] });
    assert.deepEqual(del, { deleted: 2 });
    assert.match(seen[1].url, /\/logs\/_delete_by_query\?refresh=true$/);
    assert.deepEqual(JSON.parse(seen[1].body ?? '{}').query.ids.values, ['a', 'b']);

    await assert.rejects(() => driver.upsertDocuments({ collection: '', documents: [{ a: 1 }] }), /index/);
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Elasticsearch surfaces per-item bulk errors', async () => {
  const mocked = stub([], () => json({ errors: true, items: [{ index: { error: { reason: 'mapper_parsing_exception' } } }] }));
  const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9203 });
  try {
    await assert.rejects(() => driver.upsertDocuments({ collection: 'logs', documents: [{ a: 1 }] }), /mapper_parsing_exception/);
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Weaviate batches objects and deletes by id', async () => {
  const seen: Seen[] = [];
  const mocked = stub(seen, (url) => (url.includes('/v1/batch/objects') ? json([{ id: 'o1' }, { id: 'o2' }]) : json({ acknowledged: true })));
  const driver = new WeaviateDriver({ host: '127.0.0.1', port: 8081 });
  try {
    const write = await driver.upsertDocuments({
      collection: 'Article',
      documents: [{ id: 'o1', properties: { title: 'one' } }, { title: 'two', vector: [1, 0] }],
    });
    assert.deepEqual(write, { ids: ['o1', 'o2'], upserted: 2 });
    assert.equal(seen[0].method, 'POST');
    assert.match(seen[0].url, /\/v1\/batch\/objects$/);
    const objects = JSON.parse(seen[0].body ?? '{}').objects;
    assert.equal(objects[0].class, 'Article');
    assert.deepEqual(objects[0].properties, { title: 'one' });
    assert.deepEqual(objects[1].vector, [1, 0]);

    const del = await driver.deleteDocuments({ collection: 'Article', ids: ['o1', 'o2'] });
    assert.deepEqual(del, { deleted: 2 });
    assert.equal(seen[1].method, 'DELETE');
    assert.match(seen[1].url, /\/v1\/objects\/Article\/o1$/);
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Weaviate reports batch failures', async () => {
  const mocked = stub([], () => json([{ id: 'o1', result: { error: { message: 'class not found' } } }]));
  const driver = new WeaviateDriver({ host: '127.0.0.1', port: 8081 });
  try {
    await assert.rejects(() => driver.upsertDocuments({ collection: 'Missing', documents: [{ properties: {} }] }), /class not found/);
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});

test('Milvus upserts and deletes with an id filter', async () => {
  const seen: Seen[] = [];
  const mocked = stub(seen, (url) =>
    url.includes('upsert')
      ? json({ code: 0, data: { upsertCount: 2, upsertIds: [1, 2] } })
      : json({ code: 0, data: { deleteCount: 2 } }),
  );
  const driver = new MilvusDriver({ host: '127.0.0.1', port: 19531 });
  try {
    const write = await driver.upsertDocuments({
      collection: 'items',
      documents: [
        { id: 1, vector: [0.5], title: 'a' },
        { id: 2, vector: [0.6], title: 'b' },
      ],
    });
    assert.deepEqual(write, { ids: ['1', '2'], upserted: 2 });
    assert.match(seen[0].url, /\/v2\/vectordb\/entities\/upsert$/);

    const del = await driver.deleteDocuments({ collection: 'items', ids: ['1', 'abc'] });
    assert.deepEqual(del, { deleted: 2 });
    assert.match(seen[1].url, /\/v2\/vectordb\/entities\/delete$/);
    assert.equal(JSON.parse(seen[1].body ?? '{}').filter, "id in [1, 'abc']");

    await assert.rejects(() => driver.deleteDocuments({ collection: 'items', ids: ["a'b"] }), /引号/);
  } finally {
    mocked.mock.restore();
    await driver.close();
  }
});
