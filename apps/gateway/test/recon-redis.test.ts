import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const enabled = process.env.AIDB_REDIS_TEST === '1';
const home = mkdtempSync(join(tmpdir(), 'aidb-recon-redis-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });

const sqlitePath = join(home, 'source.sqlite');
const sqlite = new DatabaseSync(sqlitePath);
sqlite.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, status TEXT);
  INSERT INTO users (id, name, status) VALUES
    (1, 'Ada', 'PAID'),
    (2, 'Bob', 'PAID'),
    (3, 'Cid', 'NEW');
`);
sqlite.close();

const TOKEN = 'recon-redis-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'recon-redis-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const port = (gateway.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

const sqliteConn = gateway.store.createConnection({ name: 'SQLite users', engine: 'sqlite', database: sqlitePath });
const redisConn = gateway.store.createConnection({
  name: 'Redis test',
  engine: 'redis',
  host: '127.0.0.1',
  port: Number(process.env.AIDB_REDIS_PORT || 16379),
  database: '0',
  password: process.env.AIDB_REDIS_PASSWORD || '123456',
});

const prefix = `aidb:recon:${Date.now()}:${Math.floor(Math.random() * 1000)}:`;
const keys = [`${prefix}1`, `${prefix}2`, `${prefix}5`];
const setKey = `${prefix}3`;

after(async () => {
  if (enabled) {
    await gateway.manager.query(redisConn.id, `DEL ${[...keys, setKey].join(' ')}`, { database: '0', actor: 'user' }).catch(() => undefined);
  }
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function streamRun(runId: string): Promise<any[]> {
  const res = await fetch(`${base}/api/commands/runs/${runId}/events`, { headers });
  assert.equal(res.status, 200);
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data));
}

test('MySQL/SQLite ↔ Redis hash 异构对账', { skip: enabled ? false : 'set AIDB_REDIS_TEST=1 to run' }, async () => {
  await gateway.manager.query(redisConn.id, `HSET ${keys[0]} name Ada status PAID`, { database: '0', actor: 'user' });
  await gateway.manager.query(redisConn.id, `HSET ${keys[1]} name Bob status NEW`, { database: '0', actor: 'user' });
  await gateway.manager.query(redisConn.id, `HSET ${keys[2]} name Eve status PAID`, { database: '0', actor: 'user' });

  const started = await api('/commands/recon/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: sqliteConn.id, label: 'SQLite' }, { connectionId: redisConn.id, label: 'Redis' }],
        level: 'fields',
        maxKeys: 1000,
        mapping: {
          mode: 'table-keyspace',
          left: { kind: 'table', connectionId: sqliteConn.id, table: 'users', keyColumns: ['id'] },
          right: {
            kind: 'keyspace',
            connectionId: redisConn.id,
            database: '0',
            keyPattern: `${prefix}*`,
            keyExtract: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.+)$`,
            valueType: 'hash',
            fields: ['name', 'status'],
          },
          fieldMap: [
            { left: 'name', right: 'name' },
            { left: 'status', right: 'status' },
          ],
          baseSide: 'left',
          maxKeys: 1000,
        },
      },
      saveAs: { title: 'SQLite ↔ Redis 对账' },
    }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const events = await streamRun(started.body.run.id);
  const finished = events.find((event) => event.type === 'run_finished');
  assert.equal(finished.status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const runs = await api(`/artifacts/${artifactId}/runs`);
  const result = runs.body.runs[0].result;
  assert.equal(result.summary.missingInRight, 1);
  assert.equal(result.summary.extraInRight, 1);
  assert.equal(result.summary.valueChanged, 1);
  assert.ok(result.target.differences.some((diff: any) => diff.key === '3' && diff.status === 'missing_in_right'));
  assert.ok(result.target.differences.some((diff: any) => diff.key === '5' && diff.status === 'extra_in_right'));
  assert.ok(result.target.differences.some((diff: any) => diff.key === '2' && diff.status === 'value_changed'));
  assert.ok(result.repair.some((command: string) => command.startsWith('HSET')));
  assert.ok(result.repair.some((command: string) => command.startsWith('DEL')));
});


test('Redis set 类型明确拒绝，不静默跳过', { skip: enabled ? false : 'set AIDB_REDIS_TEST=1 to run' }, async () => {
  await gateway.manager.query(redisConn.id, `SADD ${setKey} a b`, { database: '0', actor: 'user' });
  const started = await api('/commands/recon/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: sqliteConn.id }, { connectionId: redisConn.id }],
        level: 'keys',
        mapping: {
          mode: 'table-keyspace',
          left: { kind: 'table', connectionId: sqliteConn.id, table: 'users', keyColumns: ['id'] },
          right: {
            kind: 'keyspace',
            connectionId: redisConn.id,
            keyPattern: `${prefix}*`,
            keyExtract: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.+)$`,
            valueType: 'hash',
            fields: ['name'],
          },
        },
      },
    }),
  });
  assert.equal(started.status, 202);
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'failed');
  assert.equal(events.find((event) => event.type === 'step_failed').error.code, 'RECON_UNSUPPORTED_TYPE');
  await gateway.manager.query(redisConn.id, `DEL ${setKey}`, { database: '0', actor: 'user' });
});

test('Redis 修复命令可以快照后写回并复检', { skip: enabled ? false : 'set AIDB_REDIS_TEST=1 to run' }, async () => {
  const started = await api('/commands/recon/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: sqliteConn.id }, { connectionId: redisConn.id }],
        level: 'fields',
        mapping: {
          mode: 'table-keyspace',
          left: { kind: 'table', connectionId: sqliteConn.id, table: 'users', keyColumns: ['id'] },
          right: {
            kind: 'keyspace',
            connectionId: redisConn.id,
            database: '0',
            keyPattern: `${prefix}*`,
            keyExtract: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.+)$`,
            valueType: 'hash',
            fields: ['name', 'status'],
          },
          fieldMap: [
            { left: 'name', right: 'name' },
            { left: 'status', right: 'status' },
          ],
          baseSide: 'left',
          maxKeys: 1000,
        },
      },
    }),
  });
  const events = await streamRun(started.body.run.id);
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const executed = await api(`/artifacts/${artifactId}/recon/execute`, {
    method: 'POST',
    body: JSON.stringify({ confirm: 'EXECUTE' }),
  });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.ok(executed.body.executed > 0);
  assert.ok(executed.body.backupPath);
  assert.equal(executed.body.verification.ok, true, JSON.stringify(executed.body.verification));
  const type = await gateway.manager.query(redisConn.id, `TYPE ${prefix}3`, { database: '0', actor: 'user', maxRows: 1, allowMulti: false, autoLimit: false });
  assert.equal(String(type.sets[0].rows[0][0]), 'hash');
});
