import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, type QueryResult, type TableInfo } from '@aidb/core';
import type { GatewayConfig } from '../src/config';
import { ConnectionManager } from '../src/manager';
import { Store } from '../src/store';
import { compareData } from '../src/features/compareData';
import { reconcileData, type ReconMapping } from '../src/features/reconcile';
import { transferData, TransferAbortedError, type TransferEvent } from '../src/features/transfer';

function configFor(dir: string): GatewayConfig {
  for (const name of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(dir, name), { recursive: true });
  return {
    version: '0', home: dir, dbPath: join(dir, 'aidb.db'), host: '127.0.0.1', port: 0,
    token: 'test-token', secret: 'test-secret', demoDir: join(dir, 'demo'), exportDir: join(dir, 'exports'),
    importDir: join(dir, 'imports'), backupDir: join(dir, 'backups'), attachmentDir: join(dir, 'attachments'),
    staticDir: join(dir, 'static'), production: false,
  };
}

function sqliteEnvironment() {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-data-safety-'));
  const config = configFor(dir);
  const store = new Store(config.dbPath, config.secret);
  const manager = new ConnectionManager(store, config, () => DEFAULT_SETTINGS);
  return {
    dir, store, manager,
    cleanup: async () => {
      await manager.closeAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
}

function result(rows: unknown[][] = [], columns: Array<{ name: string }> = []): QueryResult {
  return { columns, rows, rowCount: rows.length, affected: 0, durationMs: 0 };
}

const transferTable: TableInfo = {
  name: 'items',
  type: 'table',
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, autoIncrement: false }],
  indexes: [],
  foreignKeys: [],
};

function sqlServerIdentityHarness(opts: { createMissing?: boolean; canTx?: boolean; failWrite?: boolean; abortOnWrite?: boolean } = {}) {
  const sourceTable: TableInfo = {
    ...transferTable,
    schema: 'dbo',
    columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, autoIncrement: true }],
  };
  const targetTable: TableInfo = { ...sourceTable };
  const controller = new AbortController();
  const calls: Array<{ kind: 'query' | 'write'; sql: string; sessionId?: string; signal?: AbortSignal; executionId?: string }> = [];
  const tx = { begin: 0, commit: 0, rollback: 0 };
  let begunSession = '';
  let targetExists = !opts.createMissing;
  const store = {
    getConnection: (id: string) => ({
      id, name: id, engine: id === 'source' ? 'sqlite' : 'sqlserver', database: id, readonly: false,
    }),
    addHistory: () => undefined,
  };
  const targetDriver = opts.canTx === false ? {} : {
    beginTransaction: async () => undefined,
    runInTransaction: async () => result(),
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const manager = {
    schema: async (id: string) => [{ name: 'dbo', tables: id === 'source' ? [sourceTable] : targetExists ? [targetTable] : [] }],
    rawDriver: async (id: string) => id === 'source' ? {} : targetDriver,
    query: async (id: string, sql: string, options: any) => {
      if (id === 'source') {
        return { sets: [result([[7]], [{ name: 'id' }])], messages: [], durationMs: 0 };
      }
      calls.push({ kind: 'query', sql, sessionId: options.sessionId, signal: options.signal, executionId: options.executionId });
      if (/^CREATE TABLE/i.test(sql)) targetExists = true;
      return { sets: [], messages: [], durationMs: 0 };
    },
    runParams: async (_id: string, sql: string, _params: unknown[], options: any) => {
      calls.push({ kind: 'write', sql, sessionId: options.sessionId, signal: options.signal, executionId: options.executionId });
      if (opts.abortOnWrite) {
        controller.abort();
        throw new Error('client disconnected during identity insert');
      }
      if (opts.failWrite) throw new Error('identity insert failed');
      return result();
    },
    beginTransaction: async (sessionId: string) => {
      tx.begin += 1;
      begunSession = sessionId;
      return { sessionId, database: 'target' };
    },
    commitTransaction: async () => { tx.commit += 1; },
    rollbackTransaction: async () => { tx.rollback += 1; },
  };
  return {
    calls, tx, controller, begunSession: () => begunSession,
    run: (extra: Record<string, unknown> = {}) => transferData(store as any, manager as any, {
      sourceId: 'source', targetId: 'target', tables: ['items'], mode: 'append', signal: controller.signal, ...extra,
    }),
  };
}

function identityTransferCalls(h: ReturnType<typeof sqlServerIdentityHarness>) {
  const on = h.calls.find((call) => /^SET IDENTITY_INSERT .+ ON$/i.test(call.sql));
  const off = h.calls.find((call) => /^SET IDENTITY_INSERT .+ OFF$/i.test(call.sql));
  const writes = h.calls.filter((call) => call.kind === 'write');
  assert.ok(on, 'IDENTITY_INSERT must be enabled');
  assert.ok(off, 'IDENTITY_INSERT must be disabled in finally');
  assert.equal(writes.length, 1);
  const sessionIds = [on.sessionId, ...writes.map((call) => call.sessionId), off.sessionId];
  assert.ok(sessionIds.every(Boolean), 'every identity statement must carry a session id');
  assert.equal(new Set(sessionIds).size, 1, 'ON, INSERT and OFF must share one session');
  assert.equal(h.begunSession(), on.sessionId, 'the pinned session must be the begun transaction');
  assert.ok(h.calls.indexOf(on) < h.calls.indexOf(writes[0]));
  assert.ok(h.calls.indexOf(writes[0]) < h.calls.indexOf(off));
  return { on, off, writes };
}

test('SQL Server identity append pins ON, INSERT and OFF to one committed transaction', async () => {
  const h = sqlServerIdentityHarness();
  const transferred = await h.run();
  assert.equal(transferred.results[0].status, 'ok', transferred.results[0].error);
  identityTransferCalls(h);
  assert.deepEqual(h.tx, { begin: 1, commit: 1, rollback: 0 });
});

test('SQL Server identity transfer into a new table pins CREATE and every data statement', async () => {
  const h = sqlServerIdentityHarness({ createMissing: true });
  const transferred = await h.run();
  assert.equal(transferred.results[0].status, 'ok', transferred.results[0].error);
  assert.equal(transferred.results[0].created, true);
  const create = h.calls.find((call) => /^CREATE TABLE/i.test(call.sql));
  assert.ok(create);
  const { on } = identityTransferCalls(h);
  assert.equal(create.sessionId, on.sessionId, 'CREATE must share the identity transfer transaction');
  assert.ok(h.calls.every((call) => call.sessionId === on.sessionId), 'no target statement may escape the pinned session');
  assert.deepEqual(h.tx, { begin: 1, commit: 1, rollback: 0 });
});

test('SQL Server identity append turns IDENTITY_INSERT off and rolls back on write failure', async () => {
  const h = sqlServerIdentityHarness({ failWrite: true });
  const transferred = await h.run();
  assert.equal(transferred.results[0].status, 'error');
  const { off } = identityTransferCalls(h);
  assert.equal(off.signal, undefined, 'cleanup must not inherit an aborted signal');
  assert.deepEqual(h.tx, { begin: 1, commit: 0, rollback: 1 });
});

test('SQL Server identity append cleans up and rolls back when cancelled during a write', async () => {
  const h = sqlServerIdentityHarness({ abortOnWrite: true });
  await assert.rejects(h.run(), TransferAbortedError);
  const { off } = identityTransferCalls(h);
  assert.equal(off.signal, undefined, 'cancellation must not prevent OFF from executing');
  assert.equal(off.executionId, undefined);
  assert.deepEqual(h.tx, { begin: 1, commit: 0, rollback: 1 });
});

test('SQL Server identity append fails closed when transactions are unavailable', async () => {
  const h = sqlServerIdentityHarness({ canTx: false });
  const transferred = await h.run();
  assert.equal(transferred.results[0].status, 'error');
  assert.equal(transferred.results[0].code, 'ATOMIC_TRANSFER_UNSUPPORTED');
  assert.deepEqual(h.calls, [], 'unsupported identity append must not issue target statements');
  assert.deepEqual(h.tx, { begin: 0, commit: 0, rollback: 0 });
});

test('required transaction sessions fail closed instead of falling back to pooled execution', async () => {
  const env = sqliteEnvironment();
  const conn = env.store.createConnection({ name: 'strict-session', engine: 'sqlite', database: ':memory:' });
  let pooledExecutions = 0;
  const state = env.manager as any;
  state.driverFor = async () => ({
    run: async () => { pooledExecutions += 1; return result(); },
    runParams: async () => { pooledExecutions += 1; return result(); },
  });
  try {
    const options = { actor: 'user' as const, sessionId: 'missing-session', requireTransaction: true };
    await assert.rejects(env.manager.query(conn.id, 'SELECT 1', options), { code: 'ATOMIC_TRANSFER_UNSUPPORTED' });
    await assert.rejects(env.manager.runParams(conn.id, 'SELECT ?', [1], options), { code: 'ATOMIC_TRANSFER_UNSUPPORTED' });
    state.txSessions.set('vanishing-session', { connectionId: conn.id, startedAt: Date.now(), lastUsedAt: Date.now() });
    state.driverFor = async () => {
      state.txSessions.delete('vanishing-session');
      return {
        run: async () => { pooledExecutions += 1; return result(); },
        runParams: async () => { pooledExecutions += 1; return result(); },
      };
    };
    await assert.rejects(env.manager.query(conn.id, 'SELECT 1', { ...options, sessionId: 'vanishing-session' }), { code: 'ATOMIC_TRANSFER_UNSUPPORTED' });
    assert.equal(pooledExecutions, 0, 'a session lost while acquiring the driver must not fall back to the pool');
  } finally {
    await env.cleanup();
  }
});

test('replace transfer uses DELETE inside the transaction and commits the copied rows', async () => {
  const env = sqliteEnvironment();
  const sourcePath = join(env.dir, 'source.db');
  const targetPath = join(env.dir, 'target.db');
  seed(sourcePath, 'CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (2), (3);');
  seed(targetPath, 'CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1);');
  const source = env.store.createConnection({ name: 'source', engine: 'sqlite', database: sourcePath });
  const target = env.store.createConnection({ name: 'target', engine: 'sqlite', database: targetPath });

  const originalQuery = env.manager.query.bind(env.manager);
  const originalRunParams = env.manager.runParams.bind(env.manager);
  const originalBegin = env.manager.beginTransaction.bind(env.manager);
  const originalCommit = env.manager.commitTransaction.bind(env.manager);
  const originalRollback = env.manager.rollbackTransaction.bind(env.manager);
  const targetQueries: Array<{ sql: string; sessionId?: string }> = [];
  const targetWrites: Array<{ sql: string; sessionId?: string }> = [];
  const transactions = { begin: 0, commit: 0, rollback: 0 };
  env.manager.query = async (...args: Parameters<ConnectionManager['query']>) => {
    if (args[0] === target.id) targetQueries.push({ sql: args[1], sessionId: args[2].sessionId });
    return originalQuery(...args);
  };
  env.manager.runParams = async (...args: Parameters<ConnectionManager['runParams']>) => {
    if (args[0] === target.id) targetWrites.push({ sql: args[1], sessionId: args[3].sessionId });
    return originalRunParams(...args);
  };
  env.manager.beginTransaction = async (...args: Parameters<ConnectionManager['beginTransaction']>) => {
    transactions.begin++;
    return originalBegin(...args);
  };
  env.manager.commitTransaction = async (...args: Parameters<ConnectionManager['commitTransaction']>) => {
    transactions.commit++;
    return originalCommit(...args);
  };
  env.manager.rollbackTransaction = async (...args: Parameters<ConnectionManager['rollbackTransaction']>) => {
    transactions.rollback++;
    return originalRollback(...args);
  };

  try {
    const transferred = await transferData(env.store, env.manager, {
      sourceId: source.id, targetId: target.id, tables: ['items'], mode: 'replace',
    });
    assert.equal(transferred.results[0].status, 'ok', transferred.results[0].error ?? 'transfer failed');
    assert.equal(transferred.results[0].truncated, true);
    assert.equal(targetQueries.some((item) => /\bTRUNCATE\b/i.test(item.sql)), false, 'replace must not emit TRUNCATE');
    const deletion = targetQueries.find((item) => /^DELETE FROM\s+"items"$/i.test(item.sql));
    assert.ok(deletion, 'replace must clear the target with DELETE');
    assert.ok(deletion.sessionId, 'DELETE must run in the transfer transaction');
    assert.equal(targetWrites.length, 1);
    assert.equal(targetWrites[0].sessionId, deletion.sessionId, 'INSERT must share the DELETE transaction');
    assert.deepEqual(transactions, { begin: 1, commit: 1, rollback: 0 });

    const rows = await env.manager.query(target.id, 'SELECT id FROM items ORDER BY id', { actor: 'user', autoLimit: false });
    assert.deepEqual(rows.sets[0].rows, [[2], [3]], 'the old target row must be replaced by the source rows');
  } finally {
    await env.cleanup();
  }
});

test('transfer writes actual target column names when only their case differs', async () => {
  const sourceTable: TableInfo = {
    ...transferTable,
    columns: [...transferTable.columns!, { name: 'DisplayName', type: 'TEXT', nullable: true, primaryKey: false }],
  };
  const targetTable: TableInfo = {
    ...transferTable,
    columns: [...transferTable.columns!, { name: 'displayname', type: 'TEXT', nullable: true, primaryKey: false }],
  };
  const store = {
    getConnection: (id: string) => ({ id, name: id, engine: id === 'source' ? 'sqlite' : 'postgresql', database: id, readonly: false }),
  };
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    schema: async (id: string) => [{ name: 'main', tables: [id === 'source' ? sourceTable : targetTable] }],
    rawDriver: async () => ({}),
    query: async (id: string) => id === 'source'
      ? { sets: [result([[1, 'Ada']], [{ name: 'id' }, { name: 'DisplayName' }])], messages: [], durationMs: 0 }
      : { sets: [], messages: [], durationMs: 0 },
    runParams: async (_id: string, sql: string, params: unknown[]) => { writes.push({ sql, params }); },
  };

  const transferred = await transferData(store as any, manager as any, { sourceId: 'source', targetId: 'target', tables: ['items'] });
  assert.equal(transferred.results[0].status, 'ok');
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /"displayname"/);
  assert.doesNotMatch(writes[0].sql, /"DisplayName"/);
  assert.deepEqual(writes[0].params, [1, 'Ada']);
});

test('replace transfer rejects with TRANSFER_ROLLBACK_FAILED when rollback fails', async () => {
  const store = {
    getConnection: (id: string) => ({ id, name: id, engine: 'sqlite', database: id, readonly: false }),
  };
  const targetDriver = {
    beginTransaction: async () => undefined,
    runInTransaction: async () => result(),
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => { throw new Error('rollback connection lost'); },
  };
  const events: TransferEvent[] = [];
  const manager = {
    schema: async () => [{ name: 'main', tables: [transferTable] }],
    rawDriver: async (id: string) => id === 'source' ? {} : targetDriver,
    query: async (id: string, sql: string) => {
      if (id === 'source' && /^SELECT/i.test(sql)) {
        return { sets: [result([[1]], [{ name: 'id' }])], messages: [], durationMs: 0 };
      }
      return { sets: [], messages: [], durationMs: 0 };
    },
    runParams: async () => { throw new Error('insert failed'); },
    beginTransaction: async () => undefined,
    commitTransaction: async () => { assert.fail('a failed transfer must not commit'); },
    rollbackTransaction: async () => { throw new Error('rollback connection lost'); },
  };

  await assert.rejects(
    () => transferData(store as any, manager as any, {
      sourceId: 'source', targetId: 'target', tables: ['items'], mode: 'replace', onEvent: (event) => events.push(event),
    }),
    (error: any) => {
      assert.equal(error.code, 'TRANSFER_ROLLBACK_FAILED');
      assert.equal(error.cause?.message, 'rollback connection lost');
      return true;
    },
  );
  assert.equal(events.some((event) => event.type === 'done'), false, 'rollback failure must not be reported as a completed transfer');
});

test('replace transfer rolls back when beginTransaction throws after opening a session and closes the source stream', async () => {
  const store = {
    getConnection: (id: string) => ({ id, name: id, engine: 'sqlite', database: id, readonly: false }),
  };
  const targetDriver = {
    beginTransaction: async () => undefined,
    runInTransaction: async () => result(),
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  let streamClosed = false;
  const sourceDriver = {
    async *iterateRows() {
      try {
        yield { columns: [{ name: 'id' }], rows: [[1]] };
      } finally {
        streamClosed = true;
      }
    },
  };
  const transactions: string[] = [];
  const manager = {
    schema: async () => [{ name: 'main', tables: [transferTable] }],
    rawDriver: async (id: string) => id === 'source' ? sourceDriver : targetDriver,
    query: async () => ({ sets: [], messages: [], durationMs: 0 }),
    runParams: async () => result(),
    beginTransaction: async () => {
      transactions.push('begin');
      throw new Error('begin acknowledgement lost');
    },
    commitTransaction: async () => { assert.fail('a failed begin must not commit'); },
    rollbackTransaction: async () => { transactions.push('rollback'); },
  };

  const transferred = await transferData(store as any, manager as any, {
    sourceId: 'source', targetId: 'target', tables: ['items'], mode: 'replace',
  });
  assert.deepEqual(transactions, ['begin', 'rollback'], 'a begin with an uncertain outcome must be followed by rollback');
  assert.equal(transferred.results[0].status, 'error');
  assert.match(transferred.results[0].error ?? '', /begin acknowledgement lost/);
  assert.equal(streamClosed, true, 'the streamed source generator must be closed on every exit path');
});

test('replace transfer cancellation rolls back even when the triggering write error is not coded ABORTED', async () => {
  const store = {
    getConnection: (id: string) => ({ id, name: id, engine: 'sqlite', database: id, readonly: false }),
  };
  const targetDriver = {
    beginTransaction: async () => undefined,
    runInTransaction: async () => result(),
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  let aborted = false;
  let streamClosed = false;
  const sourceDriver = {
    async *iterateRows() {
      try {
        yield { columns: [{ name: 'id' }], rows: [[1]] };
      } finally {
        streamClosed = true;
      }
    },
  };
  const transactions: string[] = [];
  const manager = {
    schema: async () => [{ name: 'main', tables: [transferTable] }],
    rawDriver: async (id: string) => id === 'source' ? sourceDriver : targetDriver,
    query: async () => ({ sets: [], messages: [], durationMs: 0 }),
    runParams: async () => {
      aborted = true;
      throw new Error('client disconnected during write');
    },
    beginTransaction: async () => { transactions.push('begin'); },
    commitTransaction: async () => { assert.fail('an aborted transfer must not commit'); },
    rollbackTransaction: async () => { transactions.push('rollback'); },
  };

  await assert.rejects(
    () => transferData(store as any, manager as any, {
      sourceId: 'source', targetId: 'target', tables: ['items'], mode: 'replace', shouldAbort: () => aborted,
    }),
    TransferAbortedError,
  );
  assert.deepEqual(transactions, ['begin', 'rollback']);
  assert.equal(streamClosed, true, 'cancellation must close the streamed source generator');
});

function tableMapping(leftId: string, rightId: string, table: string, keyColumns: string[], fields: Array<{ left: string; right: string }>): ReconMapping {
  return {
    mode: 'table-table',
    left: { kind: 'table', connectionId: leftId, table, keyColumns },
    right: { kind: 'table', connectionId: rightId, table, keyColumns },
    fieldMap: fields,
    baseSide: 'left',
  };
}

test('reconcile preserves NULL composite key parts and keeps them distinct from empty strings', async () => {
  const env = sqliteEnvironment();
  const sourcePath = join(env.dir, 'source.db');
  const targetPath = join(env.dir, 'target.db');
  seed(sourcePath, [
    'CREATE TABLE items (tenant INTEGER, external_id TEXT, note TEXT, PRIMARY KEY (tenant, external_id));',
    "INSERT INTO items VALUES (1, NULL, 'left-null'), (1, '', 'left-empty');",
  ].join('\n'));
  seed(targetPath, [
    'CREATE TABLE items (tenant INTEGER, external_id TEXT, note TEXT, PRIMARY KEY (tenant, external_id));',
    "INSERT INTO items VALUES (1, NULL, 'right-null'), (1, '', 'right-empty');",
  ].join('\n'));
  const source = env.store.createConnection({ name: 'source', engine: 'sqlite', database: sourcePath });
  const target = env.store.createConnection({ name: 'target', engine: 'sqlite', database: targetPath });

  try {
    const reconciled = await reconcileData(env.store, env.manager, tableMapping(source.id, target.id, 'items', ['tenant', 'external_id'], [{ left: 'note', right: 'note' }]), 'fields');
    assert.deepEqual(reconciled.target.counts, { left: 2, right: 2 });
    assert.equal(reconciled.summary.comparedKeys, 2, 'NULL and empty-string key components must identify different rows');
    assert.equal(reconciled.summary.valueChanged, 2);
    assert.ok(reconciled.repair.includes('UPDATE "items" SET "note" = \'left-null\' WHERE "tenant" = 1 AND "external_id" IS NULL;'));
    assert.ok(reconciled.repair.includes('UPDATE "items" SET "note" = \'left-empty\' WHERE "tenant" = 1 AND "external_id" = \'\';'));
  } finally {
    await env.cleanup();
  }
});

test('reconcile reports NULL versus empty string and preserves NULL in repair SQL', async () => {
  const env = sqliteEnvironment();
  const sourcePath = join(env.dir, 'source.db');
  const targetPath = join(env.dir, 'target.db');
  seed(sourcePath, 'CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO items VALUES (1, NULL);');
  seed(targetPath, 'CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO items VALUES (1, \'\');');
  const source = env.store.createConnection({ name: 'source', engine: 'sqlite', database: sourcePath });
  const target = env.store.createConnection({ name: 'target', engine: 'sqlite', database: targetPath });

  try {
    const reconciled = await reconcileData(env.store, env.manager, tableMapping(source.id, target.id, 'items', ['id'], [{ left: 'note', right: 'note' }]), 'fields');
    assert.equal(reconciled.summary.nullMismatch, 1);
    assert.equal(reconciled.summary.valueChanged, 0);
    assert.deepEqual(reconciled.target.differences[0], {
      key: '1', status: 'null_mismatch', fields: ['note'], left: { note: null }, right: { note: '' },
    });
    assert.deepEqual(reconciled.repair, ['UPDATE "items" SET "note" = NULL WHERE "id" = 1;']);
  } finally {
    await env.cleanup();
  }
});

function redisReconciliationEnvironment() {
  const env = sqliteEnvironment();
  const left = env.store.createConnection({ name: 'left-redis', engine: 'redis', host: '127.0.0.1', port: 6379, database: '0' });
  const right = env.store.createConnection({ name: 'right-redis', engine: 'redis', host: '127.0.0.1', port: 6379, database: '0' });
  const values = new Map<string, string>([[left.id, 'left'], [right.id, 'right']]);
  env.manager.query = async (connectionId: string, sql: string) => {
    if (sql.startsWith('SCAN ')) return { sets: [result([['item:1']], [{ name: 'key' }])], messages: ['cursor=0'], durationMs: 0 };
    if (sql.startsWith('TYPE ')) return { sets: [result([['string']], [{ name: 'type' }])], messages: [], durationMs: 0 };
    if (sql.startsWith('MGET ')) return { sets: [result([[values.get(connectionId)]], [{ name: 'value' }])], messages: [], durationMs: 0 };
    throw new Error(`unexpected Redis reconciliation command: ${sql}`);
  };
  return { ...env, left, right, values };
}

test('Redis string reconciliation compares values by default and repairs with SET', async () => {
  const env = redisReconciliationEnvironment();
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: env.left.id, keyPattern: 'item:*', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: env.right.id, keyPattern: 'item:*', valueType: 'string' },
    baseSide: 'left',
  };

  try {
    const reconciled = await reconcileData(env.store, env.manager, mapping, 'fields');
    assert.equal(reconciled.summary.valueChanged, 1);
    assert.deepEqual(reconciled.target.differences[0], {
      key: 'item:1', status: 'value_changed', fields: ['value'], left: { value: 'left' }, right: { value: 'right' },
    });
    assert.deepEqual(reconciled.repair, ['SET "item:1" "left"']);
  } finally {
    await env.cleanup();
  }
});

test('Redis JSON field reconciliation does not emit a destructive scalar SET repair', async () => {
  const env = redisReconciliationEnvironment();
  env.values.set(env.left.id, JSON.stringify({ name: 'left' }));
  env.values.set(env.right.id, JSON.stringify({ name: 'right' }));
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: env.left.id, keyPattern: 'item:*', valueType: 'json', fields: ['name'] },
    right: { kind: 'keyspace', connectionId: env.right.id, keyPattern: 'item:*', valueType: 'json', fields: ['name'] },
    baseSide: 'left',
  };

  try {
    const reconciled = await reconcileData(env.store, env.manager, mapping, 'fields');
    assert.equal(reconciled.summary.valueChanged, 1);
    assert.deepEqual(reconciled.repair, []);
    assert.match(reconciled.repairNote ?? '', /JSON/);
  } finally {
    await env.cleanup();
  }
});

test('compare detects non-key value drift and row-count drift inside rolled-back snapshots', async () => {
  const env = sqliteEnvironment();
  const sourcePath = join(env.dir, 'source.db');
  const targetPath = join(env.dir, 'target.db');
  seed(sourcePath, [
    'CREATE TABLE value_drift (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);',
    "INSERT INTO value_drift VALUES (1, 'same-name', 10);",
    'CREATE TABLE count_drift (id INTEGER PRIMARY KEY, name TEXT);',
    "INSERT INTO count_drift VALUES (1, 'one'), (2, 'two');",
    'CREATE TABLE identical (id INTEGER PRIMARY KEY, name TEXT);',
    "INSERT INTO identical VALUES (1, 'same');",
  ].join('\n'));
  seed(targetPath, [
    'CREATE TABLE value_drift (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);',
    "INSERT INTO value_drift VALUES (1, 'same-name', 11);",
    'CREATE TABLE count_drift (id INTEGER PRIMARY KEY, name TEXT);',
    "INSERT INTO count_drift VALUES (1, 'one');",
    'CREATE TABLE identical (id INTEGER PRIMARY KEY, name TEXT);',
    "INSERT INTO identical VALUES (1, 'same');",
  ].join('\n'));
  const source = env.store.createConnection({ name: 'source', engine: 'sqlite', database: sourcePath });
  const target = env.store.createConnection({ name: 'target', engine: 'sqlite', database: targetPath });

  const originalBegin = env.manager.beginTransaction.bind(env.manager);
  const originalCommit = env.manager.commitTransaction.bind(env.manager);
  const originalRollback = env.manager.rollbackTransaction.bind(env.manager);
  const begun: string[] = [];
  const committed: string[] = [];
  const rolledBack: string[] = [];
  env.manager.beginTransaction = async (...args: Parameters<ConnectionManager['beginTransaction']>) => {
    begun.push(args[0]);
    return originalBegin(...args);
  };
  env.manager.commitTransaction = async (...args: Parameters<ConnectionManager['commitTransaction']>) => {
    committed.push(args[0]);
    return originalCommit(...args);
  };
  env.manager.rollbackTransaction = async (...args: Parameters<ConnectionManager['rollbackTransaction']>) => {
    rolledBack.push(args[0]);
    return originalRollback(...args);
  };

  try {
    const compared = await compareData(env.store, env.manager, {
      sourceId: source.id, targetId: target.id, tables: ['value_drift', 'count_drift', 'identical'],
    });
    const byTable = new Map(compared.rows.map((row) => [row.table, row]));
    assert.deepEqual(byTable.get('value_drift'), { table: 'value_drift', sourceRows: 1, targetRows: 1, status: 'different' });
    assert.deepEqual(byTable.get('count_drift'), { table: 'count_drift', sourceRows: 2, targetRows: 1, status: 'different' });
    assert.deepEqual(byTable.get('identical'), { table: 'identical', sourceRows: 1, targetRows: 1, status: 'same' });
    assert.equal(compared.different, 2);
    assert.equal(compared.same, 1);
    assert.equal(begun.filter((id) => id.startsWith('compare-source-')).length, 3);
    assert.equal(begun.filter((id) => id.startsWith('compare-target-')).length, 3);
    assert.deepEqual([...rolledBack].sort(), [...begun].sort(), 'both sides of every comparison must end their snapshot transaction');
    assert.deepEqual(committed, [], 'read-only comparison snapshots must be rolled back, not committed');
  } finally {
    await env.cleanup();
  }
});

async function compareMockValues(left: unknown, right: unknown, leftType: string, rightType: string): Promise<string> {
  const columns: NonNullable<TableInfo['columns']> = [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'value', type: leftType, nullable: true, primaryKey: false },
  ];
  const targetColumns: NonNullable<TableInfo['columns']> = [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'value', type: rightType, nullable: true, primaryKey: false },
  ];
  const sourceTable: TableInfo = { ...transferTable, columns };
  const targetTable: TableInfo = { ...transferTable, columns: targetColumns };
  const store = {
    getConnection: (id: string) => ({ id, name: id, engine: id === 'source' ? 'postgresql' : 'sqlite', database: id, readonly: false }),
  };
  const driver = {
    beginTransaction: async () => undefined,
    runInTransaction: async () => result(),
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const manager = {
    schema: async (id: string) => [{ name: id === 'source' ? 'public' : 'main', tables: [id === 'source' ? sourceTable : targetTable] }],
    rawDriver: async () => driver,
    beginTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    query: async (id: string, sql: string) => {
      if (sql.startsWith('SET TRANSACTION')) return { sets: [], messages: [], durationMs: 0 };
      if (sql.includes('COUNT(*)')) return { sets: [result([[1]], [{ name: 'count' }])], messages: [], durationMs: 0 };
      if (id === 'source' && sql.includes('ORDER BY')) {
        return { sets: [result([[1, left]], columns.map((column) => ({ name: column.name })))], messages: [], durationMs: 0 };
      }
      if (id === 'target' && sql.includes('WHERE')) {
        return { sets: [result([[1, right]], targetColumns.map((column) => ({ name: column.name })))], messages: [], durationMs: 0 };
      }
      throw new Error(`unexpected compare query: ${id}: ${sql}`);
    },
  };
  const compared = await compareData(store as any, manager as any, { sourceId: 'source', targetId: 'target', tables: ['items'] });
  assert.equal(compared.rows[0].status === 'error', false, compared.rows[0].error);
  return compared.rows[0].status;
}

test('compare keeps primitive types distinct except for declared numeric cross-engine values', async (t) => {
  const cases: Array<{ name: string; left: unknown; right: unknown; leftType: string; rightType: string; expected: string }> = [
    { name: 'text versus number', left: '1', right: 1, leftType: 'TEXT', rightType: 'INTEGER', expected: 'different' },
    { name: 'text formatting remains significant', left: '1.50', right: '1.5', leftType: 'VARCHAR', rightType: 'TEXT', expected: 'different' },
    { name: 'boolean versus number', left: true, right: 1, leftType: 'BOOLEAN', rightType: 'TINYINT', expected: 'different' },
    { name: 'null versus zero', left: null, right: 0, leftType: 'INTEGER', rightType: 'INTEGER', expected: 'different' },
    { name: 'null versus empty string', left: null, right: '', leftType: 'TEXT', rightType: 'TEXT', expected: 'different' },
    { name: 'numeric driver representation compatibility', left: '1.50', right: 1.5, leftType: 'DECIMAL(10,2)', rightType: 'NUMERIC', expected: 'same' },
    { name: 'equal text values', left: 'same', right: 'same', leftType: 'TEXT', rightType: 'TEXT', expected: 'same' },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      assert.equal(await compareMockValues(item.left, item.right, item.leftType, item.rightType), item.expected);
    });
  }
});
