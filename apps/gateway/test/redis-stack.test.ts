import test from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { RedisDriver } from '../src/drivers/redis';

const PORT = process.env.AIDB_TEST_REDIS_STACK_PORT ? Number(process.env.AIDB_TEST_REDIS_STACK_PORT) : undefined;
const INDEX = 'aidb_e2e';

test('Redis Stack driver reports modules and browses RediSearch indexes', { skip: !PORT }, async () => {
  const stack = new Redis({ host: '127.0.0.1', port: PORT!, lazyConnect: true });
  await stack.connect();
  await stack.call('JSON.SET', 'doc:1', '$', '{"name":"Ada"}');
  await stack.call('JSON.SET', 'doc:2', '$', '{"name":"Linus"}');
  await stack.call('FT.CREATE', INDEX, 'ON', 'JSON', 'PREFIX', '1', 'doc:', 'SCHEMA', '$.name', 'AS', 'name', 'TEXT').catch(() => undefined);
  await stack.quit();

  const driver = new RedisDriver({ host: '127.0.0.1', port: PORT!, database: '0' });
  try {
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);
    assert.match(String(ping.version), /JSON/);
    assert.match(String(ping.version), /RediSearch/);

    const tables = await driver.describe('0');
    assert.ok(tables.some((table) => table.name === 'keys' && table.kind === 'key'));
    const index = tables.find((table) => table.name === INDEX);
    assert.ok(index, 'RediSearch 索引出现在对象树');
    assert.equal(index?.kind, 'index');

    const search = await driver.executeQuery({ language: 'redis', command: 'FT.SEARCH', args: [INDEX, '*', 'LIMIT', '0', '10'] });
    assert.equal(search.rowCount, 2);
    assert.equal(search.resultKind, 'documents');
    assert.equal(search.columns[0].name, 'key');
    assert.deepEqual(
      search.rows.map((row) => row[0]).sort(),
      ['doc:1', 'doc:2'],
    );
    assert.match(String(search.messages?.[0]), /total=2/);

    const json = await driver.executeQuery({ language: 'redis', command: 'JSON.GET', args: ['doc:1'] });
    assert.match(String(json.rows[0][0]), /Ada/);

    const info = await driver.executeQuery({ language: 'redis', command: 'FT.INFO', args: [INDEX] });
    assert.ok(info.rowCount > 0);
  } finally {
    await driver.close();
  }
});
