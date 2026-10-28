import test from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { RedisDriver } from '../src/drivers/redis';
import { supportsKeyDetail } from '../src/drivers/types';

const PORT = process.env.AIDB_TEST_REDIS_STACK_PORT ? Number(process.env.AIDB_TEST_REDIS_STACK_PORT) : undefined;

test('Redis key detail renders every supported type', { skip: !PORT }, async () => {
  const seed = new Redis({ host: '127.0.0.1', port: PORT!, lazyConnect: true });
  await seed.connect();
  await seed.del('aidb_k_str', 'aidb_k_hash', 'aidb_k_list', 'aidb_k_set', 'aidb_k_zset', 'aidb_k_stream', 'aidb_k_json', 'aidb_k_ts');
  await seed.set('aidb_k_str', 'hello');
  await seed.expire('aidb_k_str', 600);
  await seed.hset('aidb_k_hash', 'city', 'Hangzhou', 'level', '3');
  await seed.lpush('aidb_k_list', 'b', 'a');
  await seed.sadd('aidb_k_set', 'x', 'y');
  await seed.zadd('aidb_k_zset', 1, 'ada', 2, 'linus');
  await seed.xadd('aidb_k_stream', '*', 'kind', 'click');
  await seed.call('JSON.SET', 'aidb_k_json', '$', '{"a":1}');
  await seed.call('TS.CREATE', 'aidb_k_ts').catch(() => undefined);
  await seed.call('TS.ADD', 'aidb_k_ts', '1700000000', '2').catch(() => undefined);
  await seed.quit();

  const driver = new RedisDriver({ host: '127.0.0.1', port: PORT!, database: '0' });
  try {
    assert.equal(supportsKeyDetail(driver), true);

    const str = await driver.describeKey('aidb_k_str', '0');
    assert.equal(str.type, 'string');
    assert.equal(str.rows[0][0], 'hello');
    assert.equal(str.size, 5);
    assert.ok(str.ttl > 500 && str.ttl <= 600, `TTL 应接近 600，实际 ${str.ttl}`);
    assert.equal(str.encoding, 'embstr');

    const hash = await driver.describeKey('aidb_k_hash', '0');
    assert.equal(hash.type, 'hash');
    assert.equal(hash.size, 2);
    assert.deepEqual(hash.columns.map((column) => column.name), ['field', 'value']);
    assert.ok(hash.rows.some((row) => row[0] === 'city' && row[1] === 'Hangzhou'));

    const list = await driver.describeKey('aidb_k_list', '0');
    assert.deepEqual(list.rows, [[0, 'a'], [1, 'b']], '列表按 LRANGE 顺序（表头优先）展示');

    const set = await driver.describeKey('aidb_k_set', '0');
    assert.deepEqual(set.rows.map((row) => row[0]).sort(), ['x', 'y']);

    const zset = await driver.describeKey('aidb_k_zset', '0');
    assert.deepEqual(zset.columns.map((column) => column.name), ['member', 'score']);
    assert.ok(zset.rows.some((row) => row[0] === 'ada' && String(row[1]) === '1'));

    const stream = await driver.describeKey('aidb_k_stream', '0');
    assert.equal(stream.type, 'stream');
    assert.equal(stream.rows.length, 1);
    assert.match(String(stream.rows[0][1]), /click/);

    const json = await driver.describeKey('aidb_k_json', '0');
    assert.equal(json.type, 'json', 'ReJSON-RL 归一化为 json');
    assert.match(String(json.rows[0][0]), /"a": 1/);

    const ts = await driver.describeKey('aidb_k_ts', '0');
    assert.equal(ts.type, 'timeseries');
    assert.equal(ts.rows.length, 1);
    assert.equal(String(ts.rows[0][1]), '2');

    await assert.rejects(() => driver.describeKey('aidb_k_missing', '0'), /键不存在/);
  } finally {
    await driver.close();
  }
});
