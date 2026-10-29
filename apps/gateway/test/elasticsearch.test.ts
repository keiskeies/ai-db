import test from 'node:test';
import assert from 'node:assert/strict';
import { ElasticsearchDriver } from '../src/drivers/elasticsearch';

const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;
const base = ES_PORT ? `http://127.0.0.1:${ES_PORT}` : '';

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
