import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '@aidb/core';
import { createDriver } from '../src/drivers';
import { DmDriver } from '../src/drivers/dm';
import { DuckdbDriver } from '../src/drivers/duckdb';
import { MilvusDriver } from '../src/drivers/milvus';
import { MongoDriver } from '../src/drivers/mongodb';
import { Neo4jDriver } from '../src/drivers/neo4j';
import { QdrantDriver } from '../src/drivers/qdrant';
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

  const dm = await createDriver(config('dm', 5236));
  assert.equal(dm.driver.engine, 'dm');
  assert.ok(dm.driver instanceof DmDriver);
  await dm.close();
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

  const qdrant = await createDriver(config('qdrant', 6333));
  assert.equal(qdrant.driver.engine, 'qdrant');
  assert.ok(qdrant.driver instanceof QdrantDriver);
  await qdrant.close();

  const milvus = await createDriver(config('milvus', 19530));
  assert.equal(milvus.driver.engine, 'milvus');
  assert.ok(milvus.driver instanceof MilvusDriver);
  await milvus.close();

  const duckdbConfig = { ...config('duckdb', 0), database: 'C:/tmp/aidb-driver-test.duckdb' };
  const duckdb = await createDriver(duckdbConfig);
  assert.equal(duckdb.driver.engine, 'duckdb');
  assert.ok(duckdb.driver instanceof DuckdbDriver);
  await duckdb.close();
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
