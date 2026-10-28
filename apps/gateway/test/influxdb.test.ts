import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { InfluxdbDriver, bindPositional } from '../src/drivers/influxdb';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(seen: Array<{ url: string; body?: string; auth?: string }>) {
  return mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : undefined;
    const auth = init?.headers?.authorization;
    seen.push({ url, body, auth });
    if (url.endsWith('/health')) return new Response('OK', { status: 200 });
    if (url.includes('/api/v3/configure/database')) {
      return json([{ 'iox::database': '_internal' }, { 'iox::database': 'aidb_e2e' }]);
    }
    if (!url.includes('/api/v3/query_sql')) return json({ error: 'unexpected path' }, 404);
    if (auth !== 'Bearer tok') return json({ error: 'the request was not authenticated' }, 401);
    const payload = JSON.parse(body ?? '{}') as { db: string; q: string };
    if (payload.db !== 'aidb_e2e' && payload.db !== 'aidb') return json({ error: `database not found: ${payload.db}` }, 404);
    const q = payload.q.toUpperCase();
    if (q === 'SELECT 1 AS OK') return json([{ ok: 1 }]);
    if (q.startsWith('SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES')) {
      return json([{ table_name: 'cpu', table_type: 'BASE TABLE' }]);
    }
    if (q.startsWith('SELECT TABLE_NAME, COLUMN_NAME')) {
      return json([
        { table_name: 'cpu', column_name: 'host', data_type: 'Dictionary(Int32, Utf8)', is_nullable: 'YES' },
        { table_name: 'cpu', column_name: 'time', data_type: 'Timestamp(ns)', is_nullable: 'NO' },
        { table_name: 'cpu', column_name: 'value', data_type: 'Float64', is_nullable: 'YES' },
      ]);
    }
    if (q.startsWith('SELECT * FROM CPU')) {
      return json([
        { host: 'a', time: '2023-11-14T22:13:20', value: 1 },
        { host: 'b', time: '2023-11-14T22:14:20', value: 2 },
      ]);
    }
    if (q.startsWith('SELECT COUNT(*)')) return json([{ count: 2 }]);
    if (q.startsWith('CREATE')) return json({ error: 'DDL not supported: CreateMemoryTable' }, 400);
    return json([]);
  });
}

test('InfluxDB driver speaks the v3 SQL API', async () => {
  const seen: Array<{ url: string; body?: string; auth?: string }> = [];
  const mockFetch = stubFetch(seen);
  const driver = new InfluxdbDriver({ host: '127.0.0.1', port: 8184, token: 'tok', database: 'aidb_e2e' });
  try {
    const probe = await driver.test();
    assert.equal(probe.ok, true, probe.message);

    assert.deepEqual(await driver.listDatabases(), ['aidb_e2e']);

    const tables = await driver.describe('aidb_e2e');
    assert.equal(tables.length, 1);
    assert.equal(tables[0].name, 'cpu');
    assert.deepEqual(
      tables[0].columns?.map((column) => [column.name, column.type, column.nullable]),
      [
        ['host', 'string', true],
        ['time', 'timestamp', false],
        ['value', 'number', true],
      ],
    );

    const rows = await driver.run('SELECT * FROM cpu');
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.columns.map((column) => column.name), ['host', 'time', 'value']);
    assert.deepEqual(rows.rows[0], ['a', '2023-11-14T22:13:20', 1]);
    assert.equal(rows.columns[2].type, 'integer');

    const count = await driver.run('SELECT COUNT(*) AS count FROM cpu');
    assert.equal(count.rows[0][0], 2);

    await assert.rejects(() => driver.run('SELECT * FROM cpu', { database: 'missing' }), /database not found/);
    await assert.rejects(() => driver.run('CREATE TABLE t1 (id BIGINT)'), /DDL not supported/);

    const unauthorized = new InfluxdbDriver({ host: '127.0.0.1', port: 8184, token: 'bad', database: 'aidb_e2e' });
    await assert.rejects(() => unauthorized.run('SELECT 1'), /not authenticated/);

    assert.equal(bindPositional('INSERT INTO t (a, b) VALUES (?, ?)', ['x', 2]), "INSERT INTO t (a, b) VALUES ('x', 2)");
    assert.equal(bindPositional("SELECT '?' AS q, a FROM t WHERE a = ?", [true]), "SELECT '?' AS q, a FROM t WHERE a = TRUE");
    assert.equal(bindPositional('SELECT a FROM t WHERE a = ? AND b = ?', [null, "o'k"]), "SELECT a FROM t WHERE a = NULL AND b = 'o''k'");
  } finally {
    await driver.close();
    mockFetch.mock.restore();
  }
});
const LIVE = process.env.AIDB_TEST_INFLUXDB_PORT ? Number(process.env.AIDB_TEST_INFLUXDB_PORT) : undefined;
const LIVE_DB = 'aidb_live';

test('InfluxDB driver works against a live server', { skip: !LIVE }, async () => {
  const base = `http://127.0.0.1:${LIVE}`;
  const write = await fetch(`${base}/api/v3/write_lp?db=${LIVE_DB}&precision=nanosecond`, {
    method: 'POST',
    body: 'cpu,host=a value=1.0 1700000000000000000\ncpu,host=b value=2.0 1700000060000000000',
  });
  assert.equal(write.status, 204, await write.text());

  const driver = new InfluxdbDriver({ host: '127.0.0.1', port: LIVE!, database: LIVE_DB });
  try {
    const probe = await driver.test();
    assert.equal(probe.ok, true, probe.message);
    assert.ok((await driver.listDatabases()).includes(LIVE_DB));

    const tables = await driver.describe(LIVE_DB);
    const cpu = tables.find((table) => table.name === 'cpu');
    assert.ok(cpu, 'cpu measurement should be listed');
    assert.deepEqual(cpu?.columns?.map((column) => column.name), ['host', 'time', 'value']);
    assert.equal(cpu?.columns?.find((column) => column.name === 'time')?.type, 'timestamp');

    const rows = await driver.run('SELECT host, value FROM cpu ORDER BY host');
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows, [['a', 1], ['b', 2]]);

    const grouped = await driver.run("SELECT date_format(\"time\", '%Y-%m') AS m, count(*) AS c FROM cpu GROUP BY 1");
    assert.equal(grouped.rows[0][0], '2023-11');

    const plan = await driver.run('EXPLAIN SELECT * FROM cpu');
    assert.ok(plan.columns.some((column) => column.name === 'plan'));

    await assert.rejects(() => driver.run('CREATE TABLE nope (id BIGINT)'), /DDL not supported/);
    await assert.rejects(() => driver.run('SELECT * FROM cpu', { database: 'missing_db' }), /database not found/);
  } finally {
    await driver.close();
  }
});
