import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '@aidb/core';
import { createDriver } from '../src/drivers';
import { MongoDriver } from '../src/drivers/mongodb';
import { Neo4jDriver } from '../src/drivers/neo4j';
import { RedisDriver } from '../src/drivers/redis';
import { MysqlDriver } from '../src/drivers/mysql';
import { PostgresDriver } from '../src/drivers/postgres';

function config(engine: ConnectionConfig['engine'], port: number): ConnectionConfig {
  return {
    id: `test-${engine}`,
    name: engine,
    engine,
    color: 'blue',
    environment: 'dev',
    groupName: '',
    host: '127.0.0.1',
    port,
    readonly: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('driver factory routes protocol aliases to the shared SQL drivers', async () => {
  const kingbase = await createDriver(config('kingbase', 54321));
  assert.equal(kingbase.driver.engine, 'kingbase');
  assert.ok(kingbase.driver instanceof PostgresDriver);
  await kingbase.close();

  const tidb = await createDriver(config('tidb', 4000));
  assert.equal(tidb.driver.engine, 'tidb');
  assert.ok(tidb.driver instanceof MysqlDriver);
  await tidb.close();
});

test('driver factory creates MongoDB and Redis drivers without connecting', async () => {
  const mongo = await createDriver(config('mongodb', 27017));
  assert.equal(mongo.driver.engine, 'mongodb');
  assert.ok(mongo.driver instanceof MongoDriver);
  await mongo.close();

  const redis = await createDriver(config('redis', 6379));
  assert.equal(redis.driver.engine, 'redis');
  assert.ok(redis.driver instanceof RedisDriver);
  await redis.close();

  const neo4j = await createDriver(config('neo4j', 7687));
  assert.equal(neo4j.driver.engine, 'neo4j');
  assert.ok(neo4j.driver instanceof Neo4jDriver);
  await neo4j.close();
});

test('MongoDB, Redis and Neo4j reject SQL/positional parameters before dialing', async () => {
  const mongo = new MongoDriver({ host: '127.0.0.1', port: 27017 });
  await assert.rejects(() => mongo.run('SELECT 1'), /JSON/);
  await assert.rejects(() => mongo.runParams(), /参数化 SQL/);
  await mongo.close();

  const redis = new RedisDriver({ host: '127.0.0.1', port: 6379 });
  await assert.rejects(() => redis.executeQuery({ language: 'redis', command: 'SELECT', args: ['1'] }), /切换 Redis DB/);
  await assert.rejects(() => redis.runParams(), /参数化 SQL/);
  await redis.close();

  const neo4j = new Neo4jDriver({ host: '127.0.0.1', port: 7687 });
  await assert.rejects(() => neo4j.executeQuery({ language: 'cypher', text: '   ' }), /Cypher 不能为空/);
  await neo4j.close();
});
