import test from 'node:test';
import assert from 'node:assert/strict';
import { WeaviateDriver } from '../src/drivers/weaviate';

const WEAVIATE_PORT = process.env.AIDB_TEST_WEAVIATE_PORT ? Number(process.env.AIDB_TEST_WEAVIATE_PORT) : undefined;
const base = WEAVIATE_PORT ? `http://127.0.0.1:${WEAVIATE_PORT}` : '';

test('Weaviate driver contract', { skip: !WEAVIATE_PORT }, async () => {
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  await request('/v1/schema/AidbTest', 'DELETE');
  const created = await request('/v1/schema', 'POST', {
    class: 'AidbTest',
    vectorizer: 'none',
    properties: [
      { name: 'name', dataType: ['text'] },
      { name: 'kind', dataType: ['text'] },
    ],
  });
  assert.ok(created.status < 300, JSON.stringify(created.body));
  for (const [name, kind, vector] of [
    ['Ada', 'math', [1, 0, 0]],
    ['Linus', 'kernel', [0, 1, 0]],
  ] as const) {
    const inserted = await request('/v1/objects', 'POST', { class: 'AidbTest', properties: { name, kind }, vector });
    assert.ok(inserted.status < 300, JSON.stringify(inserted.body));
  }

  const driver = new WeaviateDriver({ host: '127.0.0.1', port: WEAVIATE_PORT! });
  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);
  assert.match(String(ping.version), /Weaviate/i);

  const tables = await driver.describe();
  const klass = tables.find((table) => table.name === 'AidbTest');
  assert.ok(klass, 'class listed');
  assert.equal(klass.kind, 'vector_collection');
  assert.ok(klass.columns?.some((column) => column.name === 'name'));

  const scroll = await driver.executeQuery({ language: 'vector', collection: 'AidbTest', op: 'scroll', topK: 20 });
  assert.equal(scroll.rowCount, 2);
  assert.equal(scroll.resultKind, 'vectors');

  const search = await driver.executeQuery({ language: 'vector', collection: 'AidbTest', vector: [1, 0, 0], topK: 2 });
  assert.equal(search.rowCount, 2);
  const scoreIndex = search.columns.findIndex((column) => column.name === 'score');
  const nameIndex = search.columns.findIndex((column) => column.name === 'name');
  assert.ok(scoreIndex >= 0);
  assert.ok(nameIndex >= 0);
  assert.equal(Number(search.rows[0][scoreIndex]), 1);
  assert.equal(search.rows[0][nameIndex], 'Ada');

  const parsed = await driver.run(JSON.stringify({ collection: 'AidbTest', op: 'scroll', topK: 1 }));
  assert.equal(parsed.rowCount, 1);

  await driver.close();
  await request('/v1/schema/AidbTest', 'DELETE');
});
