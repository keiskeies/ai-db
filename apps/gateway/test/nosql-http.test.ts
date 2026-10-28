import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { createGateway } from '../src/server';

const MONGO_PORT = process.env.AIDB_TEST_MONGO_PORT ? Number(process.env.AIDB_TEST_MONGO_PORT) : undefined;
const REDIS_PORT = process.env.AIDB_TEST_REDIS_PORT ? Number(process.env.AIDB_TEST_REDIS_PORT) : undefined;

test('MongoDB and Redis work through the HTTP query/schema pipeline', { skip: !MONGO_PORT || !REDIS_PORT }, async () => {
  const mongo = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  await mongo.db('aidb_http').dropDatabase();
  await mongo.db('aidb_http').collection('events').insertMany([
    { kind: 'click', weight: 2 },
    { kind: 'view', weight: 1 },
    { kind: 'click', weight: 5 },
  ]);
  await mongo.close();

  const home = mkdtempSync(join(tmpdir(), 'aidb-nosql-http-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  const gateway = await createGateway({
    home,
    dbPath: join(home, 'aidb.db'),
    secret: 'it-secret',
    token: 'it-token',
    demoDir: join(home, 'demo'),
    exportDir: join(home, 'exports'),
    importDir: join(home, 'imports'),
    backupDir: join(home, 'backups'),
    staticDir: join(home, 'static-missing'),
    port: 0,
    host: '127.0.0.1',
    production: false,
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (gateway.server.address() as AddressInfo).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    const createdMongo = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'mongo-live',
        engine: 'mongodb',
        host: '127.0.0.1',
        port: MONGO_PORT,
        database: 'aidb_http',
        groupName: 'live',
        color: 'green',
        environment: 'dev',
        readonly: false,
      }),
    });
    assert.equal(createdMongo.status, 201, JSON.stringify(createdMongo.body));
    const mongoId = createdMongo.body.connection.id;

    const schema = await api<{ schemas: Array<{ name: string; tables: Array<{ name: string; kind?: string; columns?: unknown[] }> }> }>(
      `/connections/${mongoId}/schema?database=aidb_http`,
    );
    assert.equal(schema.status, 200, JSON.stringify(schema.body));
    const events = schema.body.schemas.flatMap((item) => item.tables).find((table) => table.name === 'events');
    assert.ok(events);
    assert.equal(events.kind, 'collection');
    assert.ok((events.columns ?? []).length >= 3);

    const find = await api<{ batch: { sets: Array<{ rowCount: number; resultKind?: string }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: mongoId,
        database: 'aidb_http',
        sql: JSON.stringify({ collection: 'events', op: 'aggregate', pipeline: [{ $group: { _id: '$kind', total: { $sum: '$weight' } } }, { $sort: { _id: 1 } }] }),
      }),
    });
    assert.equal(find.status, 200, JSON.stringify(find.body));
    assert.equal(find.body.batch.sets[0].rowCount, 2);
    assert.equal(find.body.batch.sets[0].resultKind, 'documents');

    const redis = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'redis-live',
        engine: 'redis',
        host: '127.0.0.1',
        port: REDIS_PORT,
        database: '0',
        groupName: 'live',
        color: 'red',
        environment: 'dev',
        readonly: false,
      }),
    });
    assert.equal(redis.status, 201, JSON.stringify(redis.body));
    const redisId = redis.body.connection.id;

    const set = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: redisId, database: '0', sql: 'SET aidb:http:key hello' }),
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.batch.sets[0].rows, [['OK']]);

    const scan = await api<{ batch: { sets: Array<{ resultKind?: string; rowCount: number }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: redisId, database: '0', sql: 'SCAN 0 MATCH aidb:http:* COUNT 100' }),
    });
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.equal(scan.body.batch.sets[0].resultKind, 'keys');
    assert.ok(scan.body.batch.sets[0].rowCount >= 1);

    const redisSchema = await api<{ schemas: Array<{ tables: Array<{ name: string; kind?: string }> }> }>(
      `/connections/${redisId}/schema?database=0`,
    );
    assert.equal(redisSchema.status, 200, JSON.stringify(redisSchema.body));
    assert.equal(redisSchema.body.schemas[0].tables[0].kind, 'key');

    const monitor = await api(`/monitor?connectionId=${mongoId}`);
    assert.equal(monitor.status, 400);
    assert.equal((monitor.body as any).error.code, 'UNSUPPORTED_ENGINE');

    await api(`/connections/${redisId}`, { method: 'DELETE' });
    await api(`/connections/${mongoId}`, { method: 'DELETE' });
  } finally {
    await gateway.close();
    rmSync(home, { recursive: true, force: true });
  }
});
