import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ElasticsearchDriver } from '../src/drivers/elasticsearch';

const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;
const base = ES_PORT ? `http://127.0.0.1:${ES_PORT}` : '';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('describe lists indices on ES 7.6 without unsupported cat parameters', async () => {
  const seen: string[] = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('/_cat/indices')) {
      return json([{ index: 'logs-2026', health: 'green', 'docs.count': '42' }]);
    }
    if (url.includes('/_all/_mapping')) {
      return json({
        'logs-2026': {
          mappings: { properties: { msg: { type: 'text' }, meta: { properties: { ip: { type: 'ip' } } } } },
        },
      });
    }
    return json({}, 404);
  });
  try {
    const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9200 });
    const tables = await driver.describe();
    // ES 7.6 的 _cat/indices 不认识 expand_wildcards，带上会整个列表 400。
    assert.ok(seen.every((url) => !url.includes('expand_wildcards')), seen.join('\n'));
    assert.equal(tables.length, 1);
    assert.equal(tables[0].name, 'logs-2026');
    assert.equal(tables[0].rowEstimate, 42);
    assert.deepEqual(tables[0].columns?.map((column) => column.name), ['_id', 'msg', 'meta.ip']);
  } finally {
    mocked.mock.restore();
  }
});

test('describe keeps the index list when mapping is forbidden', async () => {
  const mocked = mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(input);
    if (url.includes('/_cat/indices')) return json([{ index: 'logs-2026', health: 'green', 'docs.count': '7' }]);
    return json({ error: { reason: 'action [indices:admin/mappings/get] is unauthorized' } }, 403);
  });
  try {
    const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9200 });
    const tables = await driver.describe();
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].columns?.map((column) => column.name), ['_id']);
  } finally {
    mocked.mock.restore();
  }
});

test('Elasticsearch/OpenSearch driver contract', { skip: !ES_PORT }, async () => {
  await fetch(`${base}/aidb_test`, { method: 'DELETE' }).catch(() => undefined);
  const created = await fetch(`${base}/aidb_test`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mappings: { properties: { name: { type: 'keyword' }, kind: { type: 'keyword' } } } }),
  });
  assert.ok(created.ok, await created.text());
  const bulk = [
    JSON.stringify({ index: { _index: 'aidb_test', _id: '1' } }),
    JSON.stringify({ name: 'Ada', kind: 'math' }),
    JSON.stringify({ index: { _index: 'aidb_test', _id: '2' } }),
    JSON.stringify({ name: 'Linus', kind: 'kernel' }),
    '',
  ].join('\n');
  const inserted = await fetch(`${base}/_bulk?refresh=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: bulk,
  });
  assert.ok(inserted.ok, await inserted.text());

  const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: ES_PORT! });
  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);

  const tables = await driver.describe();
  const index = tables.find((table) => table.name === 'aidb_test');
  assert.ok(index, 'index listed');
  assert.equal(index.kind, 'index');
  assert.ok(index.columns?.some((column) => column.name === 'name'));
  assert.ok(index.columns?.some((column) => column.name === 'kind'));

  const all = await driver.executeQuery({ language: 'search', index: 'aidb_test', body: { query: { match_all: {} } }, size: 10 });
  assert.equal(all.rowCount, 2);
  assert.equal(all.truncated, false);
  assert.equal(all.resultKind, 'documents');
  assert.deepEqual(all.columns.slice(0, 2).map((column) => column.name), ['_id', '_score']);

  // 取满整页但总数正好等于 size 时不算截断；真正少于 total 才标记
  const exact = await driver.run(JSON.stringify({ index: 'aidb_test', query: { match_all: {} }, size: 2 }));
  assert.equal(exact.rowCount, 2);
  assert.equal(exact.truncated, false);
  const limited = await driver.run(JSON.stringify({ index: 'aidb_test', query: { match_all: {} }, size: 1 }));
  assert.equal(limited.rowCount, 1);
  assert.equal(limited.truncated, true);

  const filtered = await driver.run(JSON.stringify({ index: 'aidb_test', query: { term: { kind: 'math' } }, size: 10 }));
  assert.equal(filtered.rowCount, 1);
  const nameIndex = filtered.columns.findIndex((column) => column.name === 'name');
  assert.equal(filtered.rows[0][nameIndex], 'Ada');

  await driver.close();
  await fetch(`${base}/aidb_test`, { method: 'DELETE' });
});
