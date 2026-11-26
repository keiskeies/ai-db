import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResult } from '@aidb/core';
import { PostgresDriver } from '../src/drivers/postgres';
import { MysqlDriver } from '../src/drivers/mysql';
import { SqlServerDriver } from '../src/drivers/sqlserver';
import { OracleDriver } from '../src/drivers/oracle';
import { DmDriver } from '../src/drivers/dm';

function emptyResult(): QueryResult {
  return { columns: [], rows: [], rowCount: 0, affected: 0, durationMs: 0 };
}

function result(columns: string[], rows: unknown[][]): QueryResult {
  return {
    columns: columns.map((name) => ({ name })),
    rows,
    rowCount: rows.length,
    durationMs: 0,
  };
}

function forbidPool(driver: object): void {
  (driver as any).pool = () => assert.fail('transaction schema introspection must not acquire a pool connection');
}

test('PostgreSQL transaction introspection runs every catalog on the pinned client with execution options', async () => {
  const driver = new PostgresDriver({ host: '127.0.0.1', port: 5432, user: 'postgres', database: 'app' });
  forbidPool(driver);
  (driver as any).txClients.set('snapshot', { pinned: true });
  const controller = new AbortController();
  const options = { timeoutMs: 4321, signal: controller.signal, executionId: 'backup-pg' };
  const calls: Array<{ sql: string; params: unknown[]; options: unknown }> = [];
  (driver as any).runInTransaction = async (sessionId: string, sql: string, params: unknown[], opts: unknown) => {
    assert.equal(sessionId, 'snapshot');
    assert.equal(opts, options);
    calls.push({ sql, params, options: opts });
    if (sql.includes('information_schema.tables')) {
      return result(['table_schema', 'table_name', 'table_type'], [['public', 'Users', 'BASE TABLE']]);
    }
    return emptyResult();
  };

  const tables = await driver.describeInTransaction('snapshot', 'app', options);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'Users');
  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.params.length === 0));
  assert.ok(calls.some((call) => call.sql.includes('pg_index')));
});

test('MySQL transaction introspection runs every catalog on the pinned connection with execution options', async () => {
  const driver = new MysqlDriver({ host: '127.0.0.1', port: 3306, user: 'root', database: 'app' });
  forbidPool(driver);
  (driver as any).txConnections.set('snapshot', { pinned: true });
  const controller = new AbortController();
  const options = { timeoutMs: 4321, signal: controller.signal, executionId: 'backup-mysql' };
  const calls: Array<{ sql: string; params: unknown[]; options: unknown }> = [];
  (driver as any).runInTransaction = async (sessionId: string, sql: string, params: unknown[], opts: unknown) => {
    assert.equal(sessionId, 'snapshot');
    assert.equal(opts, options);
    calls.push({ sql, params, options: opts });
    if (sql.includes('information_schema.TABLES')) {
      return result(['TABLE_NAME', 'TABLE_TYPE', 'TABLE_COMMENT', 'TABLE_ROWS'], [['Users', 'BASE TABLE', '', 0]]);
    }
    return emptyResult();
  };

  const tables = await driver.describeInTransaction('snapshot', 'app', options);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'Users');
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.params[0] === 'app'));
});

test('SQL Server transaction introspection runs every catalog on the pinned transaction with execution options', async () => {
  const driver = new SqlServerDriver({ host: '127.0.0.1', port: 1433, user: 'sa', database: 'app' });
  forbidPool(driver);
  (driver as any).txTransactions.set('snapshot', { pinned: true });
  const controller = new AbortController();
  const options = { timeoutMs: 4321, signal: controller.signal, executionId: 'backup-mssql' };
  const calls: Array<{ sql: string; params: unknown[]; options: unknown }> = [];
  (driver as any).runInTransaction = async (sessionId: string, sql: string, params: unknown[], opts: unknown) => {
    assert.equal(sessionId, 'snapshot');
    assert.equal(opts, options);
    calls.push({ sql, params, options: opts });
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return result(['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE'], [['dbo', 'Users', 'BASE TABLE']]);
    }
    return emptyResult();
  };

  const tables = await driver.describeInTransaction('snapshot', 'app', options);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'Users');
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.params.length === 0));
});

test('Oracle transaction introspection reuses the pinned connection, preserves timeout, and never closes it', async () => {
  const driver = new OracleDriver({ host: '127.0.0.1', port: 1521, user: 'app', database: 'ORCL' });
  forbidPool(driver);
  const controller = new AbortController();
  const connection = {
    callTimeout: 0,
    closed: false,
    async execute(sql: string) {
      assert.equal(this.callTimeout, 4321);
      if (sql.includes('FROM ALL_TABLES')) {
        return { rows: [{ OWNER: 'APP', TABLE_NAME: 'Users', KIND: 'TABLE', NUM_ROWS: 0 }] };
      }
      return { rows: [] };
    },
    async close() { this.closed = true; },
  };
  (driver as any).txConnections.set('snapshot', connection);

  const tables = await driver.describeInTransaction('snapshot', 'ORCL', {
    timeoutMs: 4321,
    signal: controller.signal,
    executionId: 'backup-oracle',
  });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'Users');
  assert.equal(connection.callTimeout, 0);
  assert.equal(connection.closed, false);
});

test('DM transaction introspection resolves schema and catalogs on the pinned connection without auto-commit', async () => {
  const driver = new DmDriver({ host: '127.0.0.1', port: 5236, user: 'SYSDBA' });
  forbidPool(driver);
  const controller = new AbortController();
  const calls: Array<{ sql: string; options: Record<string, unknown> }> = [];
  const connection = {
    closed: false,
    async execute(sql: string, _params: unknown[], options: Record<string, unknown>) {
      calls.push({ sql, options });
      assert.equal(options.autoCommit, false);
      if (sql.includes('FROM ALL_TABLES')) return { rows: [{ NAME: 'USERS', ROW_EST: 0 }] };
      return { rows: [] };
    },
    async close() { this.closed = true; },
  };
  (driver as any).txConnections.set('snapshot', connection);

  const tables = await driver.describeInTransaction('snapshot', undefined, {
    timeoutMs: 4321,
    signal: controller.signal,
    executionId: 'backup-dm',
  });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'USERS');
  assert.equal(calls[0].sql, 'SELECT USER AS NAME FROM DUAL');
  assert.equal(calls.length, 6);
  assert.equal(connection.closed, false);
});

test('Oracle and DM transaction introspection honor an already-aborted signal before catalog reads', async () => {
  const oracle = new OracleDriver({ host: '127.0.0.1', port: 1521, user: 'app' });
  forbidPool(oracle);
  let oracleReads = 0;
  (oracle as any).txConnections.set('snapshot', { execute: async () => { oracleReads++; return { rows: [] }; } });
  const dm = new DmDriver({ host: '127.0.0.1', port: 5236 });
  forbidPool(dm);
  let dmReads = 0;
  (dm as any).txConnections.set('snapshot', { execute: async () => { dmReads++; return { rows: [] }; } });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => oracle.describeInTransaction('snapshot', undefined, { signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(() => dm.describeInTransaction('snapshot', undefined, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(oracleReads, 0);
  assert.equal(dmReads, 0);
});
