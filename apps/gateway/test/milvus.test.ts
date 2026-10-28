import test from 'node:test';
import assert from 'node:assert/strict';
import { MilvusDriver } from '../src/drivers/milvus';

const MILVUS_PORT = process.env.AIDB_TEST_MILVUS_PORT ? Number(process.env.AIDB_TEST_MILVUS_PORT) : undefined;
const base = MILVUS_PORT ? `http://127.0.0.1:${MILVUS_PORT}` : '';

test('Milvus driver contract', { skip: !MILVUS_PORT }, async () => {
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<any>;
  };
  await post('/v2/vectordb/collections/drop', { collectionName: 'aidb_test' });
  const created = await post('/v2/vectordb/collections/create', {
    collectionName: 'aidb_test',
    dimension: 3,
    metricType: 'COSINE',
    primaryFieldName: 'id',
    vectorFieldName: 'vector',
    idType: 'Int64',
    autoID: false,
    enableDynamicField: true,
  });
  assert.equal(created.code, 0, JSON.stringify(created));
  const inserted = await post('/v2/vectordb/entities/insert', {
    collectionName: 'aidb_test',
    data: [
      { id: 1, vector: [1, 0, 0], name: 'Ada', kind: 'math' },
      { id: 2, vector: [0, 1, 0], name: 'Linus', kind: 'kernel' },
    ],
  });
  assert.equal(inserted.code, 0, JSON.stringify(inserted));

  const driver = new MilvusDriver({ host: '127.0.0.1', port: MILVUS_PORT! });
  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);

  const tables = await driver.describe();
  const collection = tables.find((table) => table.name === 'aidb_test');
  assert.ok(collection, 'collection listed');
  assert.equal(collection.kind, 'vector_collection');
  assert.ok(collection.columns?.some((column) => column.name === 'vector' && /vector\(3\)/.test(column.type)));
  assert.ok(collection.columns?.some((column) => column.name === 'id' && column.primaryKey));

  const scroll = await driver.executeQuery({ language: 'vector', collection: 'aidb_test', op: 'scroll', topK: 20 });
  assert.equal(scroll.rowCount, 2);
  assert.equal(scroll.resultKind, 'vectors');
  assert.ok(scroll.columns.some((column) => column.name === 'name'));

  const search = await driver.executeQuery({ language: 'vector', collection: 'aidb_test', vector: [1, 0, 0], topK: 2 });
  assert.equal(search.rowCount, 2);
  assert.deepEqual(search.rows[0].slice(0, 2), [1, 1]);

  const parsed = await driver.run(JSON.stringify({ collection: 'aidb_test', op: 'scroll', topK: 1 }));
  assert.equal(parsed.rowCount, 1);

  await driver.close();
  await post('/v2/vectordb/collections/drop', { collectionName: 'aidb_test' });
});
