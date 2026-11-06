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
    if (url.includes('/_mapping')) {
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

test('ES 6 typed mappings and numeric hits.total stay readable', async () => {
  const searchBodies: Array<Record<string, any>> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith(':9200/')) return json({ version: { number: '6.8.23' } });
    if (url.includes('/_cat/indices')) return json([{ index: 'logs-2026', health: 'green', 'docs.count': '42' }]);
    if (url.includes('/_mapping')) {
      return json({
        'logs-2026': { mappings: { doc: { properties: { msg: { type: 'text' }, meta: { properties: { ip: { type: 'ip' } } } } } } },
      });
    }
    if (url.includes('/logs-2026/_search')) {
      searchBodies.push(JSON.parse(init.body));
      return json({ hits: { total: 42, hits: [{ _id: '1', _source: { msg: 'hi' } }] } });
    }
    return json({}, 404);
  });
  try {
    const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9200 });
    const tables = await driver.describe();
    assert.deepEqual(tables[0].columns?.map((column) => column.name), ['_id', 'msg', 'meta.ip']);

    const result = await driver.run(JSON.stringify({ index: 'logs-2026', query: { match_all: {} }, size: 1 }));
    assert.equal(result.rowCount, 1);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.messages, ['total=42']);
    // ES 6 不认识 track_total_hits；版本探测到 6.x 后不应继续发送。
    assert.equal('track_total_hits' in searchBodies[0], false, JSON.stringify(searchBodies[0]));
  } finally {
    mocked.mock.restore();
  }
});

test('OpenSearch 2.x is treated as the ES 7 API baseline', async () => {
  let searchBody: Record<string, any> | undefined;
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith(':9200/')) {
      return json({ version: { distribution: 'opensearch', number: '2.11.1' } });
    }
    if (url.includes('/docs/_search')) {
      searchBody = JSON.parse(init.body);
      return json({ hits: { total: { value: 3, relation: 'eq' }, hits: [{ _id: '1', _source: {} }] } });
    }
    return json({}, 404);
  });
  try {
    const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9200 });
    assert.equal((await driver.test()).version, 'OpenSearch 2.11.1');
    const result = await driver.run(JSON.stringify({ index: 'docs', size: 1 }));
    assert.equal(result.truncated, true);
    assert.equal(searchBody?.track_total_hits, true);
  } finally {
    mocked.mock.restore();
  }
});

test('describe falls back to mapping keys when cat indices is forbidden', async () => {
  const mocked = mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(input);
    if (url.endsWith(':9200/')) return json({ version: { number: '8.13.0' } });
    if (url.includes('/_cat/indices')) return json({ error: { reason: 'action [indices:monitor/stats] is unauthorized' } }, 403);
    if (url.includes('/_all/_mapping')) {
      return json({
        'kbook-books': { mappings: { properties: { title: { type: 'text' } } } },
        'book_index': { mappings: { properties: { author: { type: 'text' } } } },
      });
    }
    return json({}, 404);
  });
  try {
    const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9200 });
    const tables = await driver.describe();
    assert.deepEqual(tables.map((table) => table.name), ['kbook-books', 'book_index']);
    assert.deepEqual(tables[0].columns?.map((column) => column.name), ['_id', 'title']);
  } finally {
    mocked.mock.restore();
  }
});

test('search retries without track_total_hits when the server does not know it', async () => {
  const searchBodies: Array<Record<string, any>> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith(':9200/')) return json({ error: 'forbidden' }, 403);
    if (url.includes('/legacy/_search')) {
      const body = JSON.parse(init.body);
      searchBodies.push(body);
      if ('track_total_hits' in body) {
        return json({ error: { reason: 'unknown key [track_total_hits]' } }, 400);
      }
      return json({ hits: { total: 5, hits: [{ _id: '1', _source: {} }] } });
    }
    return json({}, 404);
  });
  try {
    const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9200 });
    const result = await driver.run(JSON.stringify({ index: 'legacy', size: 1 }));
    assert.equal(result.truncated, true);
    assert.equal(searchBodies.length, 2);
    assert.equal('track_total_hits' in searchBodies[0], true);
    assert.equal('track_total_hits' in searchBodies[1], false);
  } finally {
    mocked.mock.restore();
  }
});

test('describe batches mapping requests instead of one huge _all/_mapping', async () => {
  const names = Array.from({ length: 130 }, (_, index) => `idx-${index}`);
  const mappingUrls: string[] = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(input);
    if (url.includes('/_cat/indices')) return json(names.map((name) => ({ index: name, health: 'green', 'docs.count': '1' })));
    if (url.includes('/_mapping')) {
      mappingUrls.push(url);
      const batch = url.replace(/^https?:\/\/[^/]+\//, '').split('/_mapping')[0].split(',');
      return json(Object.fromEntries(batch.map((name) => [name, { mappings: { properties: { title: { type: 'text' } } } }])));
    }
    return json({}, 404);
  });
  try {
    const driver = new ElasticsearchDriver({ host: '127.0.0.1', port: 9200 });
    const tables = await driver.describe();
    assert.equal(tables.length, 130);
    // 130 个索引按 60 一批 = 3 次请求，并且只取 mappings，不再一次拉整份 _all/_mapping。
    assert.equal(mappingUrls.length, 3);
    assert.ok(mappingUrls.every((url) => url.includes('filter_path')), mappingUrls.join('\n'));
    assert.ok(mappingUrls.every((url) => !url.includes('_all')), mappingUrls.join('\n'));
    assert.deepEqual(tables[0].columns?.map((column) => column.name), ['_id', 'title']);
  } finally {
    mocked.mock.restore();
  }
});

test('ES API Key replaces Basic auth, and Basic still applies without it', async () => {
  const seen: string[] = [];
  const mocked = mock.method(globalThis, 'fetch', async (_input: any, init?: any) => {
    seen.push(String(init?.headers?.authorization ?? ''));
    return json({ version: { number: '8.13.0' } });
  });
  try {
    await new ElasticsearchDriver({ host: '127.0.0.1', port: 9200, user: 'elastic', password: 'pw', apiKey: 'kvT3Xg:abc' }).test();
    await new ElasticsearchDriver({ host: '127.0.0.1', port: 9200, user: 'elastic', password: 'pw' }).test();
  } finally {
    mocked.mock.restore();
  }
  assert.equal(seen[0], 'ApiKey kvT3Xg:abc');
  assert.equal(seen[1], `Basic ${Buffer.from('elastic:pw').toString('base64')}`);
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
