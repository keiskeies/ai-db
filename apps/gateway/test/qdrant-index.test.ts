import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantDriver } from '../src/drivers/qdrant';
import { supportsCollectionIndexes } from '../src/drivers/types';

const PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const COLLECTION = 'aidb_qdrant_idx';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('Qdrant payload 索引按字段建删，类型缺省 keyword', async () => {
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined });
    return json({ result: true, status: 'ok' });
  });
  try {
    const driver = new QdrantDriver({ host: '127.0.0.1', port: 6335 });
    assert.equal(supportsCollectionIndexes(driver), true);

    assert.deepEqual(await driver.createIndex({ collection: 'docs', columns: ['weight'], type: 'integer' }), { name: 'weight', created: true });
    assert.equal(seen[0].method, 'PUT');
    assert.match(seen[0].url, /\/collections\/docs\/index\?wait=true$/);
    assert.deepEqual(JSON.parse(seen[0].body ?? '{}'), { field_name: 'weight', field_schema: { type: 'integer' } }, '新版 Qdrant 要 field_schema');

    await driver.createIndex({ collection: 'docs', columns: ['tag'] });
    assert.deepEqual(JSON.parse(seen[1].body ?? '{}'), { field_name: 'tag', field_schema: { type: 'keyword' } }, '未知类型退回 keyword');

    await assert.rejects(() => driver.createIndex({ collection: 'docs', columns: ['a', 'b'] }), /一个字段/);
    await assert.rejects(() => driver.createIndex({ collection: '', columns: ['a'] }), /collection/);

    assert.deepEqual(await driver.dropIndex({ collection: 'docs', name: 'weight' }), { name: 'weight', dropped: true });
    assert.equal(seen[2].method, 'DELETE');
    await assert.rejects(() => driver.dropIndex({ collection: 'docs', name: '  ' }), /索引名/);
  } finally {
    mocked.mock.restore();
  }
});

test('Qdrant 的 payload 索引出现在对象信息里，并能联机建删', { skip: !PORT }, async () => {
  const driver = new QdrantDriver({ host: '127.0.0.1', port: PORT! });
  await driver.dropObject(COLLECTION).catch(() => undefined);
  await driver.createObject({ name: COLLECTION, dimension: 2, distance: 'Cosine' });
  try {
    await driver.upsertDocuments({ collection: COLLECTION, documents: [{ id: 1, vector: [0.1, 0.2], payload: { weight: 7, tag: 'a' } }] });

    const created = await driver.createIndex({ collection: COLLECTION, columns: ['weight'], type: 'integer' });
    assert.equal(created.name, 'weight');

    const listed = await driver.describe();
    const table = listed.find((item) => item.name === COLLECTION);
    assert.ok(table?.indexes?.some((index) => index.name === 'weight' && index.method === 'integer'), 'payload_schema 里的索引被列出');
    assert.equal(table?.indexes?.some((index) => index.name === 'tag'), false, '没建索引的字段不该出现在索引里');

    const dropped = await driver.dropIndex({ collection: COLLECTION, name: 'weight' });
    assert.equal(dropped.dropped, true);
    const afterDrop = await driver.describe();
    assert.equal(
      afterDrop.find((item) => item.name === COLLECTION)?.indexes?.some((index) => index.name === 'weight'),
      false,
      '删除后索引消失',
    );
  } finally {
    await driver.dropObject(COLLECTION).catch(() => undefined);
  }
});
