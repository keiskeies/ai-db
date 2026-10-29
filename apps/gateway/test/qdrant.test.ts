import test from 'node:test';
import assert from 'node:assert/strict';
import { QdrantDriver } from '../src/drivers/qdrant';

const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const base = QDRANT_PORT ? `http://127.0.0.1:${QDRANT_PORT}` : '';

test('Qdrant driver contract', { skip: !QDRANT_PORT }, async () => {
  await fetch(`${base}/collections/aidb_test`, { method: 'DELETE' }).catch(() => undefined);
  const created = await fetch(`${base}/collections/aidb_test`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: 3, distance: 'Cosine' } }),
  });
  assert.equal(created.ok, true, await created.text());
  const upsert = await fetch(`${base}/collections/aidb_test/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      points: [
        { id: 1, vector: [1, 0, 0], payload: { name: 'Ada', kind: 'math' } },
        { id: 2, vector: [0, 1, 0], payload: { name: 'Linus', kind: 'kernel' } },
      ],
    }),
  });
  assert.equal(upsert.ok, true, await upsert.text());

  const driver = new QdrantDriver({ host: '127.0.0.1', port: QDRANT_PORT! });
  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);

  const tables = await driver.describe();
  const collection = tables.find((table) => table.name === 'aidb_test');
  assert.ok(collection, 'collection listed');
  assert.equal(collection.kind, 'vector_collection');
  assert.equal(collection.rowEstimate, 2);
  assert.ok(collection.columns?.some((column) => column.name === 'vector' && /vector\(3\)/.test(column.type)));
  assert.ok(collection.columns?.some((column) => column.name === 'name'));

  const scroll = await driver.executeQuery({ language: 'vector', collection: 'aidb_test', op: 'scroll', topK: 10 });
  assert.equal(scroll.rowCount, 2);
  assert.equal(scroll.truncated, false);
  assert.equal(scroll.resultKind, 'vectors');
  assert.deepEqual(scroll.columns.map((column) => column.name).slice(0, 2), ['id', 'name']);

  const search = await driver.executeQuery({ language: 'vector', collection: 'aidb_test', vector: [1, 0, 0], topK: 2 });
  assert.equal(search.rowCount, 2);
  assert.deepEqual(search.rows[0].slice(0, 2), [1, 1]);

  const parsed = await driver.run(JSON.stringify({ collection: 'aidb_test', op: 'scroll', topK: 1 }));
  assert.equal(parsed.rowCount, 1);
  assert.equal(parsed.truncated, true);
  // /query 会带 maxRows；查询自带的 topK 不应被 maxRows 覆盖
  const capped = await driver.run(JSON.stringify({ collection: 'aidb_test', op: 'scroll', topK: 1 }), { maxRows: 1000 });
  assert.equal(capped.rowCount, 1);
  assert.equal(capped.truncated, true);

  const empty = await driver.executeQuery({ language: 'vector', collection: 'aidb_test', topK: 2 });
  assert.equal(empty.rowCount, 2);

  await fetch(`${base}/collections/aidb_test`, { method: 'DELETE' });
  await driver.close();
});
