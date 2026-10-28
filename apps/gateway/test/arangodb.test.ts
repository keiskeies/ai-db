import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArangoDriver } from '../src/drivers/arangodb';

const PORT = process.env.AIDB_TEST_ARANGO_PORT ? Number(process.env.AIDB_TEST_ARANGO_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_ARANGO_PASSWORD ?? 'testpass';
const DB = 'aidb_test';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function stubFetch(seen: Array<{ url: string; body?: string; auth?: string }>) {
  return mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : undefined;
    const auth = init?.headers?.authorization;
    seen.push({ url, body, auth });
    if (auth !== basic('root', 'sekret')) return json({ error: true, errorMessage: 'not authorized', errorNum: 11 }, 401);
    if (url.endsWith('/_api/version')) return json({ server: 'arango', version: '3.12.0' });
    if (url.endsWith('/_api/database') && !url.includes('/_db/')) return json({ result: ['_system', 'aidb_e2e'] });
    if (url.includes('/_api/collection')) {
      return json({
        result: [
          { name: 'person', type: 2, isSystem: false },
          { name: 'knows', type: 3, isSystem: false },
          { name: '_analyzers', type: 2, isSystem: true },
        ],
      });
    }
    if (url.includes('/_api/cursor')) {
      const payload = body ? (JSON.parse(body) as { query: string }) : { query: '' };
      const q = payload.query.toUpperCase();
      if (q === 'RETURN 1') return json({ result: [1], hasMore: false });
      if (q.startsWith('FOR D IN @@COLLECTION LIMIT 30 RETURN D')) {
        return json({ result: [{ _key: 'ada', name: 'Ada' }, { _key: 'linus', name: 'Linus' }], hasMore: false });
      }
      if (q.startsWith('FOR D IN PERSON')) {
        return json({ result: [{ _key: 'ada', name: 'Ada', age: 36 }, { _key: 'linus', name: 'Linus' }], hasMore: false });
      }
      if (q.startsWith('FOR D IN KNOWS')) {
        return json({ result: [{ _key: 'k1', _from: 'person/ada', _to: 'person/linus', since: 2020 }], hasMore: false });
      }
      if (q.startsWith('INSERT')) return json({ result: [], hasMore: false, extra: { stats: { writesExecuted: 1 } } });
      return json({ result: [], hasMore: false });
    }
    return json({ error: true, errorMessage: 'unexpected path', errorNum: 404 }, 404);
  });
}

test('ArangoDB driver speaks the cursor HTTP API', async () => {
  const seen: Array<{ url: string; body?: string; auth?: string }> = [];
  const mockFetch = stubFetch(seen);
  const driver = new ArangoDriver({ host: '127.0.0.1', port: 8530, user: 'root', password: 'sekret', database: 'aidb_e2e' });
  try {
    const probe = await driver.test();
    assert.equal(probe.ok, true, probe.message);
    assert.match(String(probe.version), /3\.12/);

    assert.deepEqual(await driver.listDatabases(), ['_system', 'aidb_e2e']);

    const tables = await driver.describe('aidb_e2e');
    assert.equal(tables.length, 2);
    assert.deepEqual(
      tables.map((table) => [table.name, table.kind]),
      [
        ['person', 'collection'],
        ['knows', 'edge_label'],
      ],
    );
    assert.ok(tables[0].columns?.some((column) => column.name === 'name'));

    const docs = await driver.executeQuery({ language: 'aql', text: 'FOR d IN person LIMIT 10 RETURN d' });
    assert.equal(docs.rowCount, 2);
    assert.equal(docs.resultKind, 'table');
    assert.deepEqual(docs.columns.map((column) => column.name), ['_key', 'name', 'age']);
    assert.deepEqual(docs.rows[0], ['ada', 'Ada', 36]);

    const edges = await driver.executeQuery({ language: 'aql', text: 'FOR d IN knows LIMIT 10 RETURN d' });
    assert.equal(edges.resultKind, 'graph');
    assert.equal(edges.graph?.edges.length, 1);
    assert.equal(edges.graph?.edges[0].source, 'person/ada');
    assert.equal(edges.graph?.nodes.length, 2);

    const written = await driver.executeQuery({ language: 'aql', text: 'INSERT { name: "Grace" } INTO person' });
    assert.equal(written.rowCount, 0);
    assert.equal(written.affected, 1);

    await assert.rejects(() => driver.executeQuery({ language: 'cypher', text: 'MATCH (n) RETURN n' } as never), /AQL/);

    const sent = seen.find((item) => item.url.includes('/_api/cursor'));
    assert.match(String(sent?.url), /\/_db\/aidb_e2e\/_api\/cursor/);
    assert.equal(sent?.auth, basic('root', 'sekret'));
  } finally {
    mockFetch.mock.restore();
    await driver.close();
  }
});

test('ArangoDB driver rejects bad credentials', async () => {
  const mockFetch = stubFetch([]);
  const driver = new ArangoDriver({ host: '127.0.0.1', port: 8530, user: 'root', password: 'wrong', database: 'aidb_e2e' });
  try {
    const probe = await driver.test();
    assert.equal(probe.ok, false);
    assert.match(String(probe.message), /not authorized/);
  } finally {
    mockFetch.mock.restore();
    await driver.close();
  }
});

test('ArangoDB live cursor, traversal and writes', { skip: !PORT }, async () => {
  const auth = { authorization: basic('root', PASSWORD), 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${PORT}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  await call('/_db/_system/_api/database', { method: 'POST', body: JSON.stringify({ name: DB }) });
  for (const name of ['knows', 'person']) await call(`/_db/${DB}/_api/collection/${name}`, { method: 'DELETE' });
  await call(`/_db/${DB}/_api/collection`, { method: 'POST', body: JSON.stringify({ name: 'person' }) });
  await call(`/_db/${DB}/_api/collection`, { method: 'POST', body: JSON.stringify({ name: 'knows', type: 3 }) });
  await call(`/_db/${DB}/_api/document/person`, {
    method: 'POST',
    body: JSON.stringify([
      { _key: 'ada', name: 'Ada' },
      { _key: 'linus', name: 'Linus' },
    ]),
  });
  await call(`/_db/${DB}/_api/document/knows`, {
    method: 'POST',
    body: JSON.stringify([{ _key: 'k1', _from: 'person/ada', _to: 'person/linus', since: 2020 }]),
  });

  const driver = new ArangoDriver({ host: '127.0.0.1', port: PORT!, user: 'root', password: PASSWORD, database: DB });
  try {
    const probe = await driver.test();
    assert.equal(probe.ok, true, probe.message);
    assert.ok((await driver.listDatabases()).includes(DB));

    const tables = await driver.describe(DB);
    assert.ok(tables.some((table) => table.name === 'person' && table.kind === 'collection'));
    assert.ok(tables.some((table) => table.name === 'knows' && table.kind === 'edge_label'));

    const docs = await driver.executeQuery({ language: 'aql', text: 'FOR d IN person SORT d.name RETURN d' });
    assert.equal(docs.rowCount, 2);
    const nameIndex = docs.columns.findIndex((column) => column.name === 'name');
    assert.deepEqual(docs.rows.map((row) => row[nameIndex]), ['Ada', 'Linus']);

    const path = await driver.executeQuery({
      language: 'aql',
      text: "FOR v, e, p IN 1..1 OUTBOUND 'person/ada' knows RETURN p",
    });
    assert.equal(path.resultKind, 'graph');
    assert.equal(path.graph?.nodes.length, 2);
    assert.equal(path.graph?.edges.length, 1);
    assert.equal(path.graph?.edges[0].type, 'knows');

    const inserted = await driver.executeQuery({
      language: 'aql',
      text: 'INSERT { name: @name } INTO person',
      params: { name: 'Grace' },
    });
    assert.equal(inserted.affected, 1);
    const count = await driver.executeQuery({ language: 'aql', text: 'RETURN LENGTH(person)' });
    assert.equal(Number(count.rows[0][0]), 3);

    // 绑定参数走 @bindVar；集合名走 @@collection
    const bound = await driver.executeQuery({
      language: 'aql',
      text: 'FOR d IN @@collection FILTER d.name == @name RETURN d._key',
      params: { '@collection': 'person', name: 'Grace' },
    });
    assert.equal(bound.rowCount, 1);

    await assert.rejects(() => driver.executeQuery({ language: 'sql', text: 'SELECT 1' } as never), /AQL/);
  } finally {
    await driver.close();
  }
});
