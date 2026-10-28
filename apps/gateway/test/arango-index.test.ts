import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArangoDriver } from '../src/drivers/arangodb';
import { supportsCollectionIndexes } from '../src/drivers/types';

const PORT = process.env.AIDB_TEST_ARANGO_PORT ? Number(process.env.AIDB_TEST_ARANGO_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_ARANGO_PASSWORD ?? 'testpass';
const COLLECTION = 'aidb_arango_idx';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function driver(): ArangoDriver {
  return new ArangoDriver({ host: '127.0.0.1', port: PORT!, database: '_system', user: 'root', password: PASSWORD });
}

test('ArangoDB 建 inverted 索引、按名字找 id 再删', async () => {
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    seen.push({ url, method: init?.method, body: init?.body ? String(init.body) : undefined });
    if (url.includes('/_api/index') && (init?.method ?? 'GET') === 'GET') {
      return json({
        indexes: [
          { id: 'c/0', name: 'primary', type: 'primary', fields: ['_key'], unique: true },
          { id: 'c/42', name: 'weight', type: 'inverted', fields: [{ name: 'weight' }] },
        ],
      });
    }
    return json({ id: 'c/43', name: 'tag', type: 'inverted', fields: ['tag'] });
  });
  try {
    const arango = new ArangoDriver({ host: '127.0.0.1', port: 8530, database: 'appdb' });
    assert.equal(supportsCollectionIndexes(arango), true);

    assert.deepEqual(await arango.createIndex({ collection: COLLECTION, columns: ['weight', 'tag'] }), { name: 'tag', created: true });
    assert.match(seen[0].url, /\/_db\/appdb\/_api\/index\?collection=aidb_arango_idx$/);
    assert.deepEqual(JSON.parse(seen[0].body ?? '{}'), { type: 'inverted', fields: ['weight', 'tag'], name: 'weight_tag' }, '缺省用字段名当索引名，避免出现 idx_<数字>');

    assert.deepEqual(await arango.dropIndex({ collection: COLLECTION, name: 'weight' }), { name: 'weight', dropped: true });
    const listCall = seen.find((item) => (item.method ?? 'GET') === 'GET');
    assert.ok(listCall, '删除前要先查索引列表');
    const deleteCall = seen[seen.length - 1];
    assert.equal(deleteCall.method, 'DELETE');
    assert.match(deleteCall.url, /\/_api\/index\/c\/42$/, '按 collection/编号 删除，而不是把 id 当一段');

    await assert.rejects(() => arango.createIndex({ collection: COLLECTION, columns: ['  '] }), /一个字段/);
    await assert.rejects(() => arango.dropIndex({ collection: COLLECTION, name: 'primary' }), /主键索引/);
    await assert.rejects(() => arango.dropIndex({ collection: COLLECTION, name: 'ghost' }), /索引不存在/);
  } finally {
    mocked.mock.restore();
  }
});

test('ArangoDB 索引在对象信息里可见并能联机建删', { skip: !PORT }, async () => {
  const arango = driver();
  await arango.dropObject(COLLECTION).catch(() => undefined);
  await arango.createObject({ name: COLLECTION });
  try {
    await arango.upsertDocuments({ collection: COLLECTION, documents: [{ _key: 'a', weight: 1 }] });

    const created = await arango.createIndex({ collection: COLLECTION, columns: ['weight'] });
    assert.ok(created.name, '返回索引名');

    const listed = await arango.describe();
    const table = listed.find((item) => item.name === COLLECTION);
    const names = (table?.indexes ?? []).map((index) => index.name);
    assert.ok(names.includes('primary'), '主键索引可见');
    assert.equal((table?.indexes ?? []).find((index) => index.name === 'primary')?.primary, true);
    assert.equal((table?.indexes ?? []).find((index) => index.name === created.name)?.method, 'inverted');

    const dropped = await arango.dropIndex({ collection: COLLECTION, name: created.name });
    assert.equal(dropped.dropped, true);
    const afterDrop = await arango.describe();
    assert.equal(
      (afterDrop.find((item) => item.name === COLLECTION)?.indexes ?? []).some((index) => index.name === created.name),
      false,
      '删除后索引消失',
    );

    await assert.rejects(() => arango.dropIndex({ collection: COLLECTION, name: 'primary' }), /主键索引/);
  } finally {
    await arango.dropObject(COLLECTION).catch(() => undefined);
  }
});
