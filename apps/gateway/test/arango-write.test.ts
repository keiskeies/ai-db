import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArangoDriver } from '../src/drivers/arangodb';
import { supportsDocumentWrite } from '../src/drivers/types';

const PORT = process.env.AIDB_TEST_ARANGO_PORT ? Number(process.env.AIDB_TEST_ARANGO_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_ARANGO_PASSWORD ?? 'testpass';
const COLLECTION = 'aidb_arango_write';

// Windows 上 --test-force-exit 会在 socket 句柄尚未关闭时硬退出，留出时间让连接自然关闭
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
});

function driver(): ArangoDriver {
  return new ArangoDriver({ host: '127.0.0.1', port: PORT!, database: '_system', user: 'root', password: PASSWORD });
}

async function count(client: ArangoDriver): Promise<number> {
  const result = await client.executeQuery({
    language: 'aql',
    text: `RETURN LENGTH(FOR d IN @@collection RETURN d)`,
    params: { '@collection': COLLECTION },
  });
  return Number(result.rows[0]?.[0] ?? -1);
}

test('ArangoDB upsert strips _id/_rev and reports per-item errors', async () => {
  const seen: Array<{ url: string; body?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), body: init?.body ? String(init.body) : undefined });
    return new Response(JSON.stringify([{ _key: 'k1', _id: 'c/k1' }]), { status: 202, headers: { 'content-type': 'application/json' } });
  });
  try {
    const client = new ArangoDriver({ host: '127.0.0.1', port: 8530, database: 'appdb' });
    assert.equal(supportsDocumentWrite(client), true);
    const written = await client.upsertDocuments({
      collection: 'c',
      documents: [{ _key: 'k1', _id: 'c/k1', _rev: 'x', name: 'Ada' }],
    });
    assert.equal(written.upserted, 1);
    assert.deepEqual(written.ids, ['k1']);
    assert.match(seen[0].url, /\/_db\/appdb\/_api\/document\/c\?overwriteMode=replace$/);
    assert.deepEqual(JSON.parse(seen[0].body ?? '[]'), [{ _key: 'k1', name: 'Ada' }], '不能把 _id/_rev 写回文档');

    await assert.rejects(() => client.upsertDocuments({ collection: '', documents: [{ a: 1 }] }), /collection/);
    await assert.rejects(() => client.upsertDocuments({ collection: 'c', documents: [] }), /至少需要一个文档/);
    await assert.rejects(() => client.deleteDocuments({ collection: 'c', ids: [] }), /ids/);
  } finally {
    mocked.mock.restore();
  }
});

test('ArangoDB upsert surfaces the item-level error', async () => {
  const mocked = mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify([{ _key: 'ok' }, { error: true, errorNum: 1221, errorMessage: 'illegal document key' }]), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
  );
  try {
    const client = new ArangoDriver({ host: '127.0.0.1', port: 8530, database: 'appdb' });
    await assert.rejects(
      () => client.upsertDocuments({ collection: 'c', documents: [{ _key: 'ok' }, { _key: 'bad key!' }] }),
      /illegal document key/,
    );
  } finally {
    mocked.mock.restore();
  }
});

test('ArangoDB writes, replaces and deletes documents against a live server', { skip: !PORT }, async () => {
  const client = driver();
  await client.dropObject(COLLECTION).catch(() => undefined);
  await client.createObject({ name: COLLECTION });
  try {
    const written = await client.upsertDocuments({
      collection: COLLECTION,
      documents: [{ _key: 'ada', name: 'Ada' }, { name: 'NoKey' }],
    });
    assert.equal(written.upserted, 2);
    assert.equal(written.ids[0], 'ada');
    assert.ok(written.ids[1], '没有 _key 的文档由服务端生成主键');
    assert.equal(await count(client), 2);

    const replaced = await client.upsertDocuments({ collection: COLLECTION, documents: [{ _key: 'ada', name: 'Ada Lovelace' }] });
    assert.deepEqual(replaced.ids, ['ada']);
    assert.equal(await count(client), 2, '同 _key 覆盖而不是新增');
    const names = await client.executeQuery({
      language: 'aql',
      text: `RETURN FIRST(FOR d IN @@collection FILTER d._key == 'ada' RETURN d.name)`,
      params: { '@collection': COLLECTION },
    });
    assert.equal(names.rows[0]?.[0], 'Ada Lovelace');

    const deleted = await client.deleteDocuments({ collection: COLLECTION, ids: ['ada', 'missing'] });
    assert.equal(deleted.deleted, 1, '只统计真实存在的文档');
    assert.equal(await count(client), 1);
  } finally {
    await client.dropObject(COLLECTION).catch(() => undefined);
  }
});
