import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { TdengineDriver } from '../src/drivers/tdengine';

function reply(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function stubFetch(seen: Array<{ url: string; sql: string; auth?: string }>) {
  return mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    const sql = String(init?.body ?? '').trim();
    seen.push({ url, sql, auth: init?.headers?.authorization });
    if (init?.headers?.authorization !== `Basic ${Buffer.from('root:taosdata').toString('base64')}`) {
      return reply({ code: 8001, desc: 'authentication failure' });
    }
    const upper = sql.toUpperCase();
    if (upper.startsWith('SELECT SERVER_VERSION()')) {
      return reply({ code: 0, column_meta: [['server_version()', 'VARCHAR', 32]], data: [['3.2.3.0']], rows: 1 });
    }
    if (upper === 'SHOW DATABASES') {
      return reply({
        code: 0,
        column_meta: [
          ['name', 'VARCHAR', 32],
          ['created_time', 'TIMESTAMP', 8],
        ],
        data: [
          ['information_schema', '2026-01-01 00:00:00.000'],
          ['power', '2026-01-02 00:00:00.000'],
          ['aidb', '2026-01-03 00:00:00.000'],
        ],
        rows: 3,
      });
    }
    if (upper === 'SHOW STABLES') {
      return reply({ code: 0, column_meta: [['stable_name', 'VARCHAR', 192]], data: [['meters']], rows: 1 });
    }
    if (upper === 'SHOW TABLES') {
      return reply({
        code: 0,
        column_meta: [
          ['table_name', 'VARCHAR', 192],
          ['created_time', 'TIMESTAMP', 8],
          ['stable_name', 'VARCHAR', 192],
        ],
        data: [
          ['meters', '2026-01-01 00:00:00.000', ''],
          ['d1001', '2026-01-01 00:00:00.000', 'meters'],
        ],
        rows: 2,
      });
    }
    if (upper.startsWith('DESCRIBE')) {
      return reply({
        code: 0,
        column_meta: [
          ['field', 'VARCHAR', 64],
          ['type', 'VARCHAR', 32],
          ['length', 'INT', 4],
          ['note', 'VARCHAR', 8],
        ],
        data: [
          ['ts', 'TIMESTAMP', 8, ''],
          ['current', 'FLOAT', 4, ''],
          ['location', 'NCHAR', 64, 'TAG'],
        ],
        rows: 3,
      });
    }
    if (upper.startsWith('SELECT')) {
      return reply({
        code: 0,
        column_meta: [
          ['ts', 'TIMESTAMP', 8],
          ['current', 'FLOAT', 4],
        ],
        data: [['2026-10-01 00:00:00.000', 10.3]],
        rows: 1,
      });
    }
    if (upper.startsWith('INSERT')) return reply({ code: 0, rows: 1 });
    return reply({ code: 0, column_meta: [['status', 'VARCHAR', 32]], data: [['ok']], rows: 1 });
  });
}

test('TDengine driver speaks the taosAdapter REST protocol', async () => {
  const seen: Array<{ url: string; sql: string; auth?: string }> = [];
  const fetchMock = stubFetch(seen);
  const driver = new TdengineDriver({ host: '127.0.0.1', port: 6041, user: 'root', password: 'taosdata', database: 'power' });
  try {
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);
    assert.match(String(ping.version), /3\.2\.3\.0/);

    assert.deepEqual(await driver.listDatabases(), ['power', 'aidb']);

    const tables = await driver.describe();
    assert.deepEqual(tables.map((table) => table.name), ['meters', 'd1001']);
    assert.equal(tables[0].comment, '超级表');
    assert.match(String(tables[1].comment), /子表/);
    assert.deepEqual(
      tables[0].columns?.map((column) => column.name),
      ['ts', 'current', 'location'],
    );
    assert.equal(tables[0].columns?.[2].comment, 'TAG');
    assert.equal(tables[0].columns?.[1].type, 'FLOAT');

    const result = await driver.run('SELECT ts, current FROM meters LIMIT 10');
    assert.equal(result.resultKind, 'table');
    assert.deepEqual(result.columns.map((column) => column.name), ['ts', 'current']);
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0][1], 10.3);
    assert.ok(seen.some((call) => call.url === 'http://127.0.0.1:6041/rest/sql/power'), 'uses database-scoped REST path');

    const insert = await driver.run("INSERT INTO d1001 USING meters TAGS ('beijing') VALUES (NOW, 10.3)");
    assert.equal(insert.columns.length, 0);
    assert.equal(insert.affected, 1);

    const bad = new TdengineDriver({ host: '127.0.0.1', port: 6041, user: 'root', password: 'wrong' });
    await assert.rejects(() => bad.run('SHOW DATABASES'), /authentication failure/);
    await assert.rejects(() => driver.runParams('SELECT ?', [1]), /参数化/);
  } finally {
    fetchMock.mock.restore();
    await driver.close();
  }
});

/** Live taosAdapter instance, e.g. docker run -p 6041:6041 tdengine/tdengine. */
const LIVE_PORT = process.env.AIDB_TEST_TDENGINE_PORT ? Number(process.env.AIDB_TEST_TDENGINE_PORT) : undefined;

test('TDengine driver works against a live taosAdapter', { skip: !LIVE_PORT }, async () => {
  const driver = new TdengineDriver({
    host: '127.0.0.1',
    port: LIVE_PORT!,
    user: process.env.AIDB_TEST_TDENGINE_USER ?? 'root',
    password: process.env.AIDB_TEST_TDENGINE_PASSWORD ?? 'taosdata',
    database: 'aidb_test',
  });
  try {
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);
    await driver.run('CREATE DATABASE IF NOT EXISTS aidb_test');
    await driver.run('CREATE STABLE IF NOT EXISTS meters (ts TIMESTAMP, current FLOAT, voltage INT, phase FLOAT) TAGS (location NCHAR(64), groupid INT)');
    await driver.run("INSERT INTO d1001 USING meters TAGS ('beijing', 2) VALUES (NOW, 10.3, 219, 0.31)");
    const result = await driver.run('SELECT ts, current, location FROM meters LIMIT 10', { database: 'aidb_test' });
    assert.ok(result.rowCount >= 1);
    assert.ok(result.columns.some((column) => column.name === 'location'));
    const tables = await driver.describe('aidb_test');
    assert.ok(tables.some((table) => table.name === 'meters'));
  } finally {
    await driver.close();
  }
});