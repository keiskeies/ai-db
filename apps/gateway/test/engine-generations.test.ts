import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { InfluxdbDriver } from '../src/drivers/influxdb';
import { MilvusDriver } from '../src/drivers/milvus';
import { Neo4jDriver } from '../src/drivers/neo4j';

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('InfluxDB 1.x is detected and served through the /query + /write API', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/ping')) return json({}, 200, { 'x-influxdb-version': '1.8.10' });
    if (url.includes('/query')) {
      // URLSearchParams 会把空格编码成 +，断言前先还原成查询文本
      const query = decodeURIComponent(url).replace(/\+/g, ' ');
      if (query.includes('SHOW DATABASES')) {
        return json({ results: [{ series: [{ name: 'databases', columns: ['name'], values: [['logs'], ['_internal']] }] }] });
      }
      if (query.includes('SHOW MEASUREMENTS')) {
        return json({ results: [{ series: [{ name: 'measurements', columns: ['name'], values: [['cpu']] }] }] });
      }
      if (query.includes('SHOW FIELD KEYS')) {
        return json({ results: [{ series: [{ name: 'cpu', columns: ['fieldKey', 'fieldType'], values: [['usage', 'float']] }] }] });
      }
      return json({ results: [{ series: [{ name: 'cpu', columns: ['time', 'usage'], values: [[1, 0.5], [2, 0.7]] }] }] });
    }
    if (url.includes('/write')) return json({});
    return json({}, 404);
  });
  try {
    const driver = new InfluxdbDriver({ host: '127.0.0.1', port: 8086, user: 'admin', token: 'secret', database: 'logs' });
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);
    assert.equal(ping.version, 'InfluxDB 1.8.10');
    assert.deepEqual(await driver.listDatabases(), ['logs']);
    const tables = await driver.describe('logs');
    assert.deepEqual(tables.map((table) => table.name), ['cpu']);
    assert.deepEqual(tables[0].columns?.map((column) => [column.name, column.type]), [['usage', 'number']]);

    const result = await driver.run('SELECT * FROM cpu');
    assert.equal(result.rowCount, 2);
    assert.deepEqual(result.columns.map((column) => column.name), ['time', 'usage']);
    assert.deepEqual(result.rows[0], [1, 0.5]);

    await driver.writeLineProtocol(['cpu,host=a usage=0.5 1'], 'logs');
    const write = calls.find((call) => call.url.includes('/write'));
    assert.ok(write, 'v1 write goes to /write');
    assert.match(String(write!.init.headers.authorization), /^Basic /);
    assert.ok(!calls.some((call) => call.url.includes('/api/v3/query_sql')), 'v1 must not use the v3 endpoint');
  } finally {
    mocked.mock.restore();
  }
});

test('InfluxDB 2.x and 3.x are told apart by the same probe', async () => {
  const mocked = mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(input);
    if (url.includes('/ping')) return json({}, 200, { 'x-influxdb-version': '2.7.1' });
    return json({}, 404);
  });
  try {
    const driver = new InfluxdbDriver({ host: '127.0.0.1', port: 8086, token: 't' });
    const result = await driver.test();
    assert.equal(result.ok, false);
    assert.match(String(result.message), /DataFusion/);
    assert.match(String(result.message), /2\.7\.1/);
  } finally {
    mocked.mock.restore();
  }

  const v3 = mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(input);
    if (url.includes('/ping')) return json({}, 404);
    if (url.includes('/health')) return json({ name: 'influxdb3-server', version: '3.0.0', status: 'pass' });
    if (url.includes('/api/v3/query_sql')) return json([{ ok: 1 }]);
    return json({}, 404);
  });
  try {
    const driver = new InfluxdbDriver({ host: '127.0.0.1', port: 8181, token: 't' });
    const result = await driver.test();
    assert.equal(result.ok, true, result.message);
    assert.equal(result.version, 'InfluxDB 3 3.0.0');
  } finally {
    v3.mock.restore();
  }
});

test('Milvus without the 2.4 REST surface says so instead of looking offline', async () => {
  const mocked = mock.method(globalThis, 'fetch', async () => json({ message: 'not found' }, 404));
  try {
    const result = await new MilvusDriver({ host: '127.0.0.1', port: 19530 }).test();
    assert.equal(result.ok, false);
    assert.match(String(result.message), /Milvus 2\.4\+/);
  } finally {
    mocked.mock.restore();
  }
});

test('Neo4j 3.5 sessions drop the database option', async () => {
  const driver = new Neo4jDriver({ host: '127.0.0.1', port: 7687 });
  const sessions: unknown[] = [];
  (driver as any).driver = () => ({
    session: (config?: unknown) => {
      sessions.push(config);
      return {
        run: async () => ({ records: [] }),
        close: async () => undefined,
      };
    },
    getServerInfo: async () => ({ agent: 'Neo4j/Ruby-Neo4j/3.5.14' }),
  });

  (driver as any).serverMajor = null;
  await (driver as any).probe();
  assert.equal((driver as any).serverMajor, 3);
  await driver.describe('neo4j');
  assert.deepEqual(sessions.at(-1), undefined);

  (driver as any).serverMajor = 5;
  await driver.listDatabases();
  assert.deepEqual(sessions.at(-1), { database: 'system' });
});
