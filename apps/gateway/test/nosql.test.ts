import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { MongoDriver } from '../src/drivers/mongodb';
import { RedisDriver } from '../src/drivers/redis';

const MONGO_PORT = process.env.AIDB_TEST_MONGO_PORT ? Number(process.env.AIDB_TEST_MONGO_PORT) : undefined;
const REDIS_PORT = process.env.AIDB_TEST_REDIS_PORT ? Number(process.env.AIDB_TEST_REDIS_PORT) : undefined;

test('MongoDB driver contract', { skip: !MONGO_PORT }, async () => {
  const port = MONGO_PORT!;
  const client = new MongoClient(`mongodb://127.0.0.1:${port}`, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db('aidb_test');
  await db.dropDatabase();
  await db.collection('users').insertMany([
    { name: 'Ada', age: 36, tags: ['math'], meta: { city: 'London' } },
    { name: 'Linus', age: 55, tags: ['kernel'], meta: { city: 'Portland' } },
    { name: 'Grace', age: 85, tags: ['navy'], meta: { city: 'New York' } },
  ]);
  await client.close();

  const driver = new MongoDriver({ host: '127.0.0.1', port, database: 'aidb_test' });
  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);
  assert.match(String(ping.version), /MongoDB/);

  const databases = await driver.listDatabases();
  assert.ok(databases.includes('aidb_test'));

  const tables = await driver.describe('aidb_test');
  const users = tables.find((table) => table.name === 'users');
  assert.ok(users, 'users collection listed');
  assert.equal(users.kind, 'collection');
  assert.equal(users.rowEstimate, 3);
  assert.ok(users.columns?.some((column) => column.name === '_id' && column.primaryKey));
  assert.ok(users.columns?.some((column) => column.name === 'meta.city'), 'nested fields are flattened for inference');

  const find = await driver.executeQuery({
    language: 'mql',
    collection: 'users',
    op: 'find',
    filter: { age: { $gte: 50 } },
    sort: { age: 1 },
    limit: 10,
  });
  assert.equal(find.rowCount, 2);
  assert.equal(find.resultKind, 'documents');
  assert.equal(find.columns[0].name, '_id');
  assert.deepEqual(
    find.rows.map((row) => row[find.columns.findIndex((column) => column.name === 'name')]),
    ['Linus', 'Grace'],
  );

  const count = await driver.executeQuery({ language: 'mql', collection: 'users', op: 'count' });
  assert.deepEqual(count.rows, [[3]]);

  const distinct = await driver.executeQuery({ language: 'mql', collection: 'users', op: 'distinct', field: 'meta.city' });
  assert.equal(distinct.rowCount, 3);

  const aggregate = await driver.executeQuery({
    language: 'mql',
    collection: 'users',
    op: 'aggregate',
    pipeline: [{ $group: { _id: null, avg: { $avg: '$age' } } }],
  });
  assert.equal(aggregate.rowCount, 1);
  const avgIndex = aggregate.columns.findIndex((column) => column.name === 'avg');
  assert.ok(avgIndex >= 0);
  assert.ok(Math.abs(Number(aggregate.rows[0][avgIndex]) - 176 / 3) < 0.001);

  const parsed = await driver.run(JSON.stringify({ collection: 'users', op: 'find', limit: 1 }));
  assert.equal(parsed.rowCount, 1);
  await assert.rejects(() => driver.run('SELECT 1'), /JSON/);
  await driver.close();
});

test('Redis driver contract', { skip: !REDIS_PORT }, async () => {
  const driver = new RedisDriver({ host: '127.0.0.1', port: REDIS_PORT!, database: '0' });
  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);
  assert.match(String(ping.version), /Redis/);

  const databases = await driver.listDatabases();
  assert.ok(databases.includes('0'));

  const tables = await driver.describe('0');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].kind, 'key');
  assert.ok((tables[0].rowEstimate ?? 0) >= 0);

  await driver.executeQuery({ language: 'redis', command: 'SET', args: ['aidb:test:name', 'Ada'] });
  await driver.executeQuery({ language: 'redis', command: 'HSET', args: ['aidb:test:user', 'name', 'Ada', 'age', '36'] });

  const get = await driver.executeQuery({ language: 'redis', command: 'GET', args: ['aidb:test:name'] });
  assert.deepEqual(get.rows, [['Ada']]);

  const hash = await driver.executeQuery({ language: 'redis', command: 'HGETALL', args: ['aidb:test:user'] });
  assert.deepEqual(hash.columns.map((column) => column.name), ['field', 'value']);
  assert.equal(hash.rowCount, 2);

  const scan = await driver.executeQuery({
    language: 'redis',
    command: 'SCAN',
    args: ['0', 'MATCH', 'aidb:test:*', 'COUNT', '100'],
  });
  assert.equal(scan.resultKind, 'keys');
  assert.ok(scan.rowCount >= 2, 'SCAN returns both keys');
  assert.ok(scan.messages?.some((message) => message.startsWith('cursor=')));

  const keys = await driver.executeQuery({ language: 'redis', command: 'KEYS', args: ['aidb:test:*'] });
  assert.equal(keys.rowCount, 2);

  const info = await driver.executeQuery({ language: 'redis', command: 'INFO', args: ['server'] });
  assert.deepEqual(info.columns.map((column) => column.name), ['field', 'value']);
  assert.ok(info.rows.some((row) => String(row[0]) === 'redis_version'));

  await driver.executeQuery({ language: 'redis', command: 'DEL', args: ['aidb:test:name', 'aidb:test:user'] });
  await assert.rejects(
    () => driver.executeQuery({ language: 'redis', command: 'SELECT', args: ['1'] }),
    /切换 Redis DB/,
  );
  await driver.close();
});
