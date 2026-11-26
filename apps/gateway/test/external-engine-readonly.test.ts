import { listenRandom } from './helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/server';

const MYSQL_PORT = process.env.AIDB_TEST_MYSQL_PORT ? Number(process.env.AIDB_TEST_MYSQL_PORT) : undefined;
const MYSQL_PASSWORD = process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass';
const PG_PORT = process.env.AIDB_TEST_PG_TX_PORT ? Number(process.env.AIDB_TEST_PG_TX_PORT) : undefined;
const PG_PASSWORD = process.env.AIDB_TEST_PG_TX_PASSWORD ?? 'testpass';

type Api = (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;

async function harness(): Promise<{ api: Api; close: () => Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'aidb-external-readonly-'));
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
  await listenRandom(gateway.server);
  const port = (gateway.server.address() as any).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api: Api = async (path, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    api,
    close: async () => {
      await gateway.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows may retain SQLite handles briefly after shutdown. */
      }
    },
  };
}

async function verifyReadonly(options: {
  engine: 'mysql' | 'postgresql';
  port: number;
  user: string;
  password: string;
  database: string;
  table: string;
  createTable: string;
}): Promise<void> {
  const env = await harness();
  let writableId: string | undefined;
  const connect = async (readonly: boolean): Promise<string> => {
    const created = await env.api('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: `${options.engine}-readonly-${readonly}`,
        engine: options.engine,
        host: '127.0.0.1',
        port: options.port,
        user: options.user,
        password: options.password,
        database: options.database,
        groupName: 'live',
        color: 'blue',
        environment: 'dev',
        readonly,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.connection.id;
  };
  const run = (connectionId: string, sql: string, sessionId?: string) => env.api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId, database: options.database, sql, sessionId }),
  });

  try {
    writableId = await connect(false);
    assert.equal((await run(writableId, `DROP TABLE IF EXISTS ${options.table}`)).status, 200);
    assert.equal((await run(writableId, options.createTable)).status, 200);
    assert.equal((await run(writableId, `INSERT INTO ${options.table} VALUES (1, 'seed')`)).status, 200);

    const readonlyId = await connect(true);
    const select = await run(readonlyId, `SELECT id, note FROM ${options.table} ORDER BY id`);
    assert.equal(select.status, 200, JSON.stringify(select.body));
    assert.deepEqual(select.body.batch.sets[0].rows, [[1, 'seed']]);

    const blocked = await run(readonlyId, `UPDATE ${options.table} SET note = 'blocked' WHERE id = 1`);
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'READONLY');

    const begin = await env.api('/tx/begin', {
      method: 'POST',
      body: JSON.stringify({ connectionId: readonlyId, sessionId: 'readonly-probe', database: options.database }),
    });
    assert.equal(begin.status, 403, JSON.stringify(begin.body));
    assert.equal(begin.body.error.code, 'READONLY');

    const unchanged = await run(writableId, `SELECT note FROM ${options.table} WHERE id = 1`);
    assert.deepEqual(unchanged.body.batch.sets[0].rows, [['seed']], 'blocked UPDATE must not reach the server');
  } finally {
    if (writableId) await run(writableId, `DROP TABLE IF EXISTS ${options.table}`).catch(() => undefined);
    await env.close();
  }
}

test('MySQL live read-only SQL and transaction enforcement', { skip: !MYSQL_PORT }, async () => {
  await verifyReadonly({
    engine: 'mysql',
    port: MYSQL_PORT!,
    user: 'root',
    password: MYSQL_PASSWORD,
    database: 'aidb_tx',
    table: 'aidb_readonly_mysql_probe',
    createTable: 'CREATE TABLE aidb_readonly_mysql_probe (id INT PRIMARY KEY, note VARCHAR(32)) ENGINE=InnoDB',
  });
});

test('PostgreSQL live read-only SQL and transaction enforcement', { skip: !PG_PORT }, async () => {
  await verifyReadonly({
    engine: 'postgresql',
    port: PG_PORT!,
    user: 'postgres',
    password: PG_PASSWORD,
    database: 'aidb_tx',
    table: 'aidb_readonly_pg_probe',
    createTable: 'CREATE TABLE aidb_readonly_pg_probe (id INT PRIMARY KEY, note VARCHAR(32))',
  });
});
