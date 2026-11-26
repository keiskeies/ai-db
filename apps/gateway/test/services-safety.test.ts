import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, type QueryResult, type TableInfo } from '@aidb/core';
import type { GatewayConfig } from '../src/config';
import { ConnectionManager } from '../src/manager';
import { Store } from '../src/store';
import { backupCapacityByteLimit, dumpDatabase, resolveImportFile, restoreBackupFile, restoreDropStatements } from '../src/services';

function configFor(dir: string): GatewayConfig {
  for (const name of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(dir, name), { recursive: true });
  return {
    version: '0',
    home: dir,
    dbPath: join(dir, 'aidb.db'),
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    secret: 'test-secret',
    demoDir: join(dir, 'demo'),
    exportDir: join(dir, 'exports'),
    importDir: join(dir, 'imports'),
    backupDir: join(dir, 'backups'),
    attachmentDir: join(dir, 'attachments'),
    staticDir: join(dir, 'static'),
    production: false,
  };
}

function mockBackupCapacity(t: TestContext): () => void {
  const mocked = t.mock.method(fs, 'statfsSync', (() => ({ bavail: 8, bsize: 1024 ** 3 })) as any);
  syncBuiltinESMExports();
  return () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
}

function mysqlRestoreHarness(dir: string, options: { swapError?: Error; verificationError?: Error; unsupportedIn?: 'staging' | 'target'; externalReference?: boolean } = {}) {
  const config = configFor(dir);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'restore', engine: 'mysql', database: 'target' });
  const file = join(dir, 'restore.sql');
  writeFileSync(file, 'CREATE TABLE items (id INTEGER PRIMARY KEY);\nINSERT INTO items (id) VALUES (1);\n');
  const databases = new Map<string, Set<string>>([['target', new Set(['items'])]]);
  const scripts: string[] = [];
  const drops: string[] = [];
  let swapCommitted = false;
  const emptyBatch = () => ({ sets: [emptyResult()], messages: [], durationMs: 0 });
  const manager = {
    schema: async (_connectionId: string, database: string) => [{
      name: database,
      tables: [...(databases.get(database) ?? [])].map((name) => ({ ...dumpTable, name, schema: database })),
    }],
    listDatabases: async () => {
      if (options.verificationError && swapCommitted) throw options.verificationError;
      return [...databases.keys()];
    },
    execScript: async (_connectionId: string, sql: string, opts: { database?: string }) => {
      scripts.push(sql);
      if (sql.includes('RENAME TABLE')) {
        const staging = [...databases.keys()].find((name) => name.startsWith('aidb_restore_'))!;
        const rollback = [...databases.keys()].find((name) => name.startsWith('aidb_rollback_'))!;
        databases.get(rollback)!.add('items');
        databases.get(conn.database!)!.delete('items');
        databases.get(staging)!.delete('items');
        databases.get(conn.database!)!.add('items');
        swapCommitted = true;
        if (options.swapError) throw options.swapError;
        return true;
      }
      if (opts.database?.startsWith('aidb_restore_') && /CREATE TABLE items/i.test(sql)) databases.get(opts.database)!.add('items');
      return true;
    },
    query: async (_connectionId: string, sql: string, opts: { database?: string }) => {
      const create = sql.match(/CREATE DATABASE `([^`]+)`/i);
      if (create) databases.set(create[1], new Set());
      const drop = sql.match(/DROP DATABASE(?: IF EXISTS)? `([^`]+)`/i);
      if (drop) {
        drops.push(drop[1]);
        databases.delete(drop[1]);
      }
      if (sql.includes('information_schema.TRIGGERS') && options.unsupportedIn === opts.database) {
        return { sets: [{ ...emptyResult(), columns: [{ name: 'object_type' }, { name: 'object_name' }], rows: [['routine', 'unsupported_routine']], rowCount: 1 }], messages: [], durationMs: 0 };
      }
      if (sql.includes('information_schema.KEY_COLUMN_USAGE') && options.externalReference) {
        return { sets: [{ ...emptyResult(), columns: [{ name: 'CONSTRAINT_SCHEMA' }, { name: 'TABLE_NAME' }, { name: 'REFERENCED_TABLE_SCHEMA' }, { name: 'REFERENCED_TABLE_NAME' }], rows: [['other', 'child', 'target', 'items']], rowCount: 1 }], messages: [], durationMs: 0 };
      }
      return emptyBatch();
    },
    invalidate: () => undefined,
  } as unknown as ConnectionManager;
  return { config, store, conn, file, manager, databases, scripts, drops };
}

test('resolveImportFile confines direct, sibling-prefix, and symlink escape paths', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-import-confinement-'));
  const config = configFor(dir);
  const nested = join(config.importDir, 'nested');
  mkdirSync(nested);
  const inside = join(nested, 'data.csv');
  writeFileSync(inside, 'id,name\n1,Ada\n');

  const outsideDir = join(dir, 'outside');
  mkdirSync(outsideDir);
  const outside = join(outsideDir, 'data.csv');
  writeFileSync(outside, 'id,name\n2,Bob\n');
  const siblingDir = `${config.importDir}-evil`;
  mkdirSync(siblingDir);
  const sibling = join(siblingDir, 'data.csv');
  writeFileSync(sibling, 'id,name\n3,Cid\n');

  try {
    assert.equal(resolveImportFile(config, inside), fs.realpathSync(inside));
    for (const candidate of [outside, sibling]) {
      assert.throws(() => resolveImportFile(config, candidate), { code: 'PATH_NOT_ALLOWED' }, candidate);
    }

    const linkedDir = join(config.importDir, 'linked-dir');
    symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveImportFile(config, join(linkedDir, 'data.csv')), { code: 'PATH_NOT_ALLOWED' });

    await t.test('a file symlink cannot escape the import root', { skip: process.platform === 'win32' ? 'file symlinks require Windows developer mode or elevation' : false }, () => {
      const linkedFile = join(config.importDir, 'linked.csv');
      symlinkSync(outside, linkedFile, 'file');
      assert.throws(() => resolveImportFile(config, linkedFile), { code: 'PATH_NOT_ALLOWED' });
      assert.equal(readFileSync(outside, 'utf8'), 'id,name\n2,Bob\n');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite restore rolls back DDL and earlier INSERTs after a mid-script failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-restore-rollback-'));
  const config = configFor(dir);
  const database = join(dir, 'target.db');
  const seed = new DatabaseSync(database);
  seed.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO items VALUES (1, 'original');");
  seed.close();

  const store = new Store(config.dbPath, config.secret);
  const manager = new ConnectionManager(store, config, () => DEFAULT_SETTINGS);
  const conn = store.createConnection({ name: 'restore', engine: 'sqlite', database });
  const file = join(dir, 'restore.sql');
  writeFileSync(file, [
    'CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT);',
    "INSERT INTO items (id, note) VALUES (2, 'partial');",
    'CREATE TABLE should_not_survive (id INTEGER PRIMARY KEY);',
    "INSERT INTO items (id, note) VALUES (2, 'duplicate');",
  ].join('\n'));

  const originalRollback = manager.rollbackTransaction.bind(manager);
  const originalCommit = manager.commitTransaction.bind(manager);
  const rolledBack: string[] = [];
  const committed: string[] = [];
  manager.rollbackTransaction = async (sessionId, actor) => {
    rolledBack.push(sessionId);
    return originalRollback(sessionId, actor);
  };
  manager.commitTransaction = async (sessionId, actor) => {
    committed.push(sessionId);
    return originalCommit(sessionId, actor);
  };

  try {
    await assert.rejects(() => restoreBackupFile(store, manager, conn.id, file), (error: any) => {
      assert.match(error.message, /UNIQUE constraint failed/);
      return true;
    });
    assert.equal(rolledBack.length, 1, 'the failed restore must explicitly roll back its transaction');
    assert.match(rolledBack[0], /^restore-/);
    assert.deepEqual(committed, [], 'a failed restore must never commit');

    const rows = await manager.query(conn.id, 'SELECT id, note FROM items ORDER BY id', { actor: 'user', autoLimit: false });
    assert.deepEqual(rows.sets[0].rows, [[1, 'original']], 'the original table and row must survive the failed restore');
    const schema = await manager.schema(conn.id, undefined, true);
    assert.equal(schema.flatMap((item) => item.tables).some((item) => item.name === 'should_not_survive'), false, 'rolled-back CREATE TABLE must not survive');
    const foreignKeys = await manager.query(conn.id, 'PRAGMA foreign_keys', { actor: 'user', autoLimit: false });
    assert.deepEqual(foreignKeys.sets[0].rows, [[1]], 'SQLite foreign-key enforcement must be restored after failure');
  } finally {
    await manager.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const dumpTable: TableInfo = {
  name: 'items',
  type: 'table',
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, autoIncrement: false }],
  indexes: [],
  foreignKeys: [],
};

function emptyResult(truncated = false): QueryResult {
  return { columns: [], rows: [], rowCount: 0, affected: 0, durationMs: 0, truncated };
}

test('MySQL restore preserves rollback data when RENAME commits but its acknowledgement is lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-mysql-restore-ack-'));
  const harness = mysqlRestoreHarness(dir, { swapError: new Error('connection lost after RENAME') });
  try {
    await assert.rejects(() => restoreBackupFile(harness.store, harness.manager, harness.conn.id, harness.file), (error: any) => {
      assert.equal(error.code, 'ATOMIC_RESTORE_OUTCOME_UNKNOWN');
      assert.match(error.message, /回滚库 aidb_rollback_/);
      assert.match(error.message, /人工核对/);
      assert.equal(error.cause?.message, 'connection lost after RENAME');
      return true;
    });
    assert.deepEqual(harness.drops, [], 'an ambiguous swap must not trigger DROP cleanup');
    const rollback = [...harness.databases.keys()].find((name) => name.startsWith('aidb_rollback_'))!;
    const staging = [...harness.databases.keys()].find((name) => name.startsWith('aidb_restore_'))!;
    assert.ok(harness.databases.get(rollback)?.has('items'), 'the old table must remain available for manual recovery');
    assert.equal(harness.databases.get(staging)?.size, 0);
    assert.ok(harness.databases.get('target')?.has('items'));
    assert.equal(harness.scripts.filter((sql) => sql.includes('RENAME TABLE')).length, 1, 'the swap must remain one atomic RENAME statement');
  } finally {
    harness.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MySQL restore preserves all swap databases when post-swap verification cannot complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-mysql-restore-verify-'));
  const harness = mysqlRestoreHarness(dir, { verificationError: new Error('metadata connection lost') });
  try {
    await assert.rejects(() => restoreBackupFile(harness.store, harness.manager, harness.conn.id, harness.file), (error: any) => {
      assert.equal(error.code, 'ATOMIC_RESTORE_OUTCOME_UNKNOWN');
      assert.match(error.message, /状态核对为 unknown/);
      assert.match(error.message, /停止自动清理/);
      return true;
    });
    assert.deepEqual(harness.drops, [], 'unverified state must never be cleaned automatically');
    assert.ok([...harness.databases.keys()].some((name) => name.startsWith('aidb_rollback_')));
    assert.ok([...harness.databases.keys()].some((name) => name.startsWith('aidb_restore_')));
  } finally {
    harness.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MySQL restore fails closed on routines outside the table-only staging model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-mysql-restore-deps-'));
  const harness = mysqlRestoreHarness(dir, { unsupportedIn: 'target' });
  try {
    await assert.rejects(() => restoreBackupFile(harness.store, harness.manager, harness.conn.id, harness.file), (error: any) => {
      assert.equal(error.code, 'ATOMIC_RESTORE_UNSUPPORTED');
      assert.match(error.message, /unsupported_routine/);
      return true;
    });
    assert.equal(harness.scripts.some((sql) => sql.includes('RENAME TABLE')), false, 'dependency validation must run before the destructive swap');
    assert.ok(harness.databases.has('target'));
    assert.equal([...harness.databases.keys()].some((name) => name.startsWith('aidb_restore_')), false, 'pre-swap staging cleanup remains safe');
  } finally {
    harness.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MySQL restore rejects cross-database foreign-key dependencies before RENAME', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-mysql-restore-fk-'));
  const harness = mysqlRestoreHarness(dir, { externalReference: true });
  try {
    await assert.rejects(() => restoreBackupFile(harness.store, harness.manager, harness.conn.id, harness.file), (error: any) => {
      assert.equal(error.code, 'ATOMIC_RESTORE_UNSUPPORTED');
      assert.match(error.message, /other\.child/);
      assert.match(error.message, /target\.items/);
      return true;
    });
    assert.equal(harness.scripts.some((sql) => sql.includes('RENAME TABLE')), false);
    assert.ok(harness.databases.get('target')?.has('items'));
  } finally {
    harness.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MySQL restore verifies the completed swap before dropping staging and rollback databases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-mysql-restore-ok-'));
  const harness = mysqlRestoreHarness(dir);
  try {
    const restored = await restoreBackupFile(harness.store, harness.manager, harness.conn.id, harness.file);
    assert.match(restored.messages.at(-1) ?? '', /备份已原子恢复/);
    assert.equal(harness.drops.length, 2);
    assert.match(harness.drops[0], /^aidb_rollback_/);
    assert.match(harness.drops[1], /^aidb_restore_/);
    assert.deepEqual([...harness.databases.keys()], ['target']);
    assert.ok(harness.databases.get('target')?.has('items'));
  } finally {
    harness.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL restore fails closed when sequences or routines make CASCADE unsafe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-postgres-restore-deps-'));
  const config = configFor(dir);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'restore', engine: 'postgresql', database: 'target' });
  const file = join(dir, 'restore.sql');
  writeFileSync(file, 'CREATE TABLE items (id INTEGER PRIMARY KEY);\n');
  let began = false;
  const driver = {
    beginTransaction: async () => { began = true; },
    runInTransaction: async () => emptyResult(),
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const manager = {
    listDatabases: async () => ['target'],
    schema: async () => [{ name: 'public', tables: [dumpTable] }],
    rawDriver: async () => driver,
    query: async (_connectionId: string, sql: string) => {
      assert.match(sql, /pg_class/);
      return { sets: [{ ...emptyResult(), columns: [{ name: 'count' }], rows: [[1]], rowCount: 1 }], messages: [], durationMs: 0 };
    },
  } as unknown as ConnectionManager;
  try {
    await assert.rejects(() => restoreBackupFile(store, manager, conn.id, file), { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
    assert.equal(began, false, 'unsupported dependencies must be rejected before opening the destructive restore transaction');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreDropStatements preserves qualified escaped PostgreSQL and SQL Server identifiers', () => {
  const postgres = restoreDropStatements('postgresql', [
    'CREATE TABLE "public"."ord""ers" (id INTEGER);',
    'CREATE VIEW "public""audit"."order""view" AS SELECT 1;',
  ].join('\n'));
  assert.deepEqual(postgres, [
    'DROP VIEW IF EXISTS "public""audit"."order""view" CASCADE;',
    'DROP TABLE IF EXISTS "public"."ord""ers" CASCADE;',
  ]);

  const sqlServer = restoreDropStatements('sqlserver', [
    'CREATE TABLE [dbo]]audit].[ord]]ers] (id INTEGER);',
    'CREATE VIEW [dbo]]audit].[order]]view] AS SELECT 1;',
  ].join('\n'));
  assert.deepEqual(sqlServer, [
    'DROP VIEW IF EXISTS [dbo]]audit].[order]]view];',
    'DROP TABLE IF EXISTS [dbo]]audit].[ord]]ers];',
  ]);

  assert.deepEqual(restoreDropStatements('postgresql', [
    'CREATE TABLE "public"."Users" (id INTEGER);',
    'CREATE TABLE "public"."users" (id INTEGER);',
  ].join('\n')), [
    'DROP TABLE IF EXISTS "public"."Users" CASCADE;',
    'DROP TABLE IF EXISTS "public"."users" CASCADE;',
  ]);
  assert.deepEqual(restoreDropStatements('sqlserver', [
    'CREATE TABLE [dbo].[Users] (id INTEGER);',
    'CREATE TABLE [dbo].[users] (id INTEGER);',
  ].join('\n'), true), [
    'DROP TABLE IF EXISTS [dbo].[Users];',
    'DROP TABLE IF EXISTS [dbo].[users];',
  ]);
});

test('qualified PostgreSQL and SQL Server restores match schema objects and drop full names', async (t) => {
  const cases = [
    {
      engine: 'postgresql',
      schema: 'public',
      name: 'ord"ers',
      create: 'CREATE TABLE "public"."ord""ers" (id INTEGER);',
      drop: 'DROP TABLE IF EXISTS "public"."ord""ers" CASCADE;',
      dependencyMarker: 'pg_class',
    },
    {
      engine: 'sqlserver',
      schema: 'dbo]audit',
      name: 'ord]ers',
      create: 'CREATE TABLE [dbo]]audit].[ord]]ers] (id INTEGER);',
      drop: 'DROP TABLE IF EXISTS [dbo]]audit].[ord]]ers];',
      dependencyMarker: 'sys.sequences',
    },
  ] as const;
  for (const item of cases) {
    await t.test(item.engine, async () => {
      const dir = mkdtempSync(join(tmpdir(), `aidb-${item.engine}-qualified-restore-`));
      const config = configFor(dir);
      const store = new Store(config.dbPath, config.secret);
      const conn = store.createConnection({ name: 'restore', engine: item.engine, database: 'target' });
      const file = join(dir, 'restore.sql');
      writeFileSync(file, `${item.create}\n`);
      const statements: string[] = [];
      const driver = {
        beginTransaction: async () => undefined,
        runInTransaction: async () => emptyResult(),
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
      };
      const manager = {
        listDatabases: async () => ['target'],
        schema: async () => [{ name: item.schema, tables: [{ ...dumpTable, name: item.name, schema: item.schema }] }],
        rawDriver: async () => driver,
        beginTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
        query: async (_connectionId: string, sql: string) => {
          if (sql.includes('DATABASEPROPERTYEX')) {
            return { sets: [{ ...emptyResult(), columns: [{ name: 'collation' }], rows: [['SQL_Latin1_General_CP1_CI_AS']], rowCount: 1 }], messages: [], durationMs: 0 };
          }
          if (sql.includes(item.dependencyMarker)) {
            return { sets: [{ ...emptyResult(), columns: [{ name: 'count' }], rows: [[0]], rowCount: 1 }], messages: [], durationMs: 0 };
          }
          statements.push(sql);
          return { sets: [], messages: [], durationMs: 0 };
        },
      } as unknown as ConnectionManager;
      try {
        const restored = await restoreBackupFile(store, manager, conn.id, file);
        assert.match(restored.messages.at(-1) ?? '', /备份已原子恢复/);
        assert.deepEqual(statements.filter((sql) => /^DROP TABLE/i.test(sql)), [item.drop]);
        assert.ok(statements.includes(item.create), 'the original qualified CREATE must be replayed');
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('restore object identity preserves quoted PostgreSQL case and follows SQL Server collation', async (t) => {
  const cases = [
    {
      name: 'PostgreSQL quoted Users does not match target users',
      engine: 'postgresql', schema: 'public', targetName: 'users',
      create: 'CREATE TABLE "public"."Users" (id INTEGER);', dependencyMarker: 'pg_class', mismatch: true,
    },
    {
      name: 'PostgreSQL bare identifiers remain case-insensitive',
      engine: 'postgresql', schema: 'public', targetName: 'users',
      create: 'CREATE TABLE public.USERS (id INTEGER);', dependencyMarker: 'pg_class',
      drop: 'DROP TABLE IF EXISTS public.USERS CASCADE;',
    },
    {
      name: 'SQL Server CS collation rejects a case-only target mismatch',
      engine: 'sqlserver', schema: 'dbo', targetName: 'users', collation: 'Latin1_General_100_CS_AS',
      create: 'CREATE TABLE [dbo].[Users] (id INTEGER);', dependencyMarker: 'sys.sequences', mismatch: true,
    },
    {
      name: 'SQL Server BIN2 collation is also case-sensitive',
      engine: 'sqlserver', schema: 'dbo', targetName: 'users', collation: 'Latin1_General_100_BIN2',
      create: 'CREATE TABLE [dbo].[Users] (id INTEGER);', dependencyMarker: 'sys.sequences', mismatch: true,
    },
    {
      name: 'SQL Server CS collation accepts the exact quoted object',
      engine: 'sqlserver', schema: 'dbo', targetName: 'Users', collation: 'Latin1_General_100_CS_AS',
      create: 'CREATE TABLE [dbo].[Users] (id INTEGER);', dependencyMarker: 'sys.sequences',
      drop: 'DROP TABLE IF EXISTS [dbo].[Users];',
    },
    {
      name: 'SQL Server CI collation retains case-insensitive matching',
      engine: 'sqlserver', schema: 'dbo', targetName: 'users', collation: 'SQL_Latin1_General_CP1_CI_AS',
      create: 'CREATE TABLE [dbo].[Users] (id INTEGER);', dependencyMarker: 'sys.sequences',
      drop: 'DROP TABLE IF EXISTS [dbo].[Users];',
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, async () => {
      const collation = 'collation' in item ? item.collation : '';
      const mismatch = 'mismatch' in item && item.mismatch;
      const drop = 'drop' in item ? item.drop : undefined;
      const dir = mkdtempSync(join(tmpdir(), 'aidb-restore-identity-'));
      const config = configFor(dir);
      const store = new Store(config.dbPath, config.secret);
      const conn = store.createConnection({ name: 'restore', engine: item.engine, database: 'target' });
      const file = join(dir, 'restore.sql');
      writeFileSync(file, `${item.create}\n`);
      const statements: string[] = [];
      let began = false;
      const driver = {
        beginTransaction: async () => { began = true; },
        runInTransaction: async () => emptyResult(),
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
      };
      const manager = {
        listDatabases: async () => ['target'],
        schema: async () => [{ name: item.schema, tables: [{ ...dumpTable, name: item.targetName, schema: item.schema }] }],
        rawDriver: async () => driver,
        beginTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
        query: async (_connectionId: string, sql: string) => {
          if (sql.includes('DATABASEPROPERTYEX')) {
            return { sets: [{ ...emptyResult(), columns: [{ name: 'collation' }], rows: [[collation]], rowCount: 1 }], messages: [], durationMs: 0 };
          }
          if (sql.includes(item.dependencyMarker)) {
            return { sets: [{ ...emptyResult(), columns: [{ name: 'count' }], rows: [[0]], rowCount: 1 }], messages: [], durationMs: 0 };
          }
          statements.push(sql);
          return { sets: [], messages: [], durationMs: 0 };
        },
      } as unknown as ConnectionManager;
      try {
        if (mismatch) {
          await assert.rejects(() => restoreBackupFile(store, manager, conn.id, file), (error: any) => {
            assert.equal(error.code, 'RESTORE_OBJECT_MISMATCH');
            assert.match(error.message, new RegExp(item.targetName));
            return true;
          });
          assert.equal(began, false, 'a case-only extra target object must be rejected before DROP');
          assert.deepEqual(statements, []);
        } else {
          await restoreBackupFile(store, manager, conn.id, file);
          assert.deepEqual(statements.filter((sql) => /^DROP TABLE/i.test(sql)), [drop]);
          assert.ok(statements.includes(item.create), 'the parsed original CREATE must be replayed');
        }
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('SQL Server restore fails closed when the target collation cannot be established', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-restore-collation-'));
  const config = configFor(dir);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'restore', engine: 'sqlserver', database: 'target' });
  const file = join(dir, 'restore.sql');
  writeFileSync(file, 'CREATE TABLE [dbo].[Users] (id INTEGER);\n');
  let schemaReads = 0;
  const manager = {
    listDatabases: async () => ['target'],
    schema: async () => { schemaReads++; return []; },
    query: async () => ({ sets: [], messages: [], durationMs: 0 }),
  } as unknown as ConnectionManager;
  try {
    await assert.rejects(() => restoreBackupFile(store, manager, conn.id, file), (error: any) => {
      assert.equal(error.code, 'ATOMIC_RESTORE_UNSUPPORTED');
      assert.match(error.message, /排序规则/);
      return true;
    });
    assert.equal(schemaReads, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dumpDatabase rejects a truncated snapshot read, rolls back, and deletes the partial backup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-backup-truncated-'));
  const config = configFor(dir);
  const restoreCapacity = mockBackupCapacity(t);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'backup', engine: 'sqlite', database: join(dir, 'source.db') });
  const events: string[] = [];
  let transactionId = '';
  const driver = {
    engine: 'sqlite',
    beginTransaction: async (id: string) => { transactionId = id; events.push('begin'); },
    describeInTransaction: async (id: string) => {
      assert.equal(id, transactionId);
      events.push('schema');
      return [dumpTable];
    },
    runInTransaction: async (id: string, sql: string) => {
      assert.equal(id, transactionId);
      if (sql.includes('sqlite_master')) return { ...emptyResult(), columns: [{ name: 'count' }], rows: [[0]], rowCount: 1 };
      events.push('read');
      return { ...emptyResult(true), columns: [{ name: 'id' }], rows: [[1]], rowCount: 1 };
    },
    commitTransaction: async () => { events.push('commit'); },
    rollbackTransaction: async () => { events.push('rollback'); },
  };
  const manager = { rawDriver: async () => driver } as unknown as ConnectionManager;

  try {
    await assert.rejects(() => dumpDatabase(store, manager, config, conn.id), { code: 'BACKUP_TRUNCATED' });
    assert.deepEqual(events, ['begin', 'schema', 'read', 'rollback']);
    assert.deepEqual(readdirSync(config.backupDir), [], 'an incomplete backup must not remain on disk');
    assert.deepEqual(store.listBackups(conn.id), [], 'an incomplete backup must not be registered');
  } finally {
    restoreCapacity();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dumpDatabase refuses a driver without transaction support before creating a backup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-backup-no-tx-'));
  const config = configFor(dir);
  const restoreCapacity = mockBackupCapacity(t);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'backup', engine: 'sqlite', database: join(dir, 'source.db') });
  const manager = {
    schema: async () => { assert.fail('schema must not be read before transaction capability is established'); },
    rawDriver: async () => ({}),
  } as unknown as ConnectionManager;

  try {
    await assert.rejects(() => dumpDatabase(store, manager, config, conn.id), { code: 'CONSISTENT_BACKUP_UNSUPPORTED' });
    assert.deepEqual(readdirSync(config.backupDir), []);
    assert.deepEqual(store.listBackups(conn.id), []);
  } finally {
    restoreCapacity();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dumpDatabase fails closed before BEGIN when the driver cannot read schema in its transaction', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-backup-no-tx-schema-'));
  const config = configFor(dir);
  const restoreCapacity = mockBackupCapacity(t);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'backup', engine: 'sqlserver', database: 'target' });
  const events: string[] = [];
  const driver = {
    beginTransaction: async () => { events.push('begin'); },
    runInTransaction: async (_id: string, sql: string) => { events.push(sql); return emptyResult(); },
    commitTransaction: async () => { events.push('commit'); },
    rollbackTransaction: async () => { events.push('rollback'); },
  };
  const manager = {
    schema: async () => { assert.fail('ordinary schema reads cannot back a transaction snapshot'); },
    rawDriver: async () => driver,
  } as unknown as ConnectionManager;
  try {
    await assert.rejects(() => dumpDatabase(store, manager, config, conn.id), (error: any) => {
      assert.equal(error.code, 'CONSISTENT_BACKUP_UNSUPPORTED');
      assert.match(error.message, /事务内结构读取/);
      return true;
    });
    assert.deepEqual(events, [], 'unsupported drivers must not BEGIN or issue a late SET');
    assert.deepEqual(readdirSync(config.backupDir), []);
  } finally {
    restoreCapacity();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dumpDatabase applies required transaction settings before schema and metadata reads', async (t) => {
  const cases = [
    { engine: 'postgresql', setting: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' },
    { engine: 'oracle', setting: 'SET TRANSACTION READ ONLY' },
    { engine: 'dm', setting: 'SET TRANSACTION READ ONLY' },
    { engine: 'sqlserver', setting: 'SET TRANSACTION ISOLATION LEVEL SNAPSHOT' },
  ] as const;
  for (const item of cases) {
    await t.test(item.engine, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), `aidb-${item.engine}-backup-order-`));
      const config = configFor(dir);
      const restoreCapacity = mockBackupCapacity(t);
      const store = new Store(config.dbPath, config.secret);
      const conn = store.createConnection({ name: 'backup', engine: item.engine, database: 'target' });
      const controller = new AbortController();
      const events: string[] = [];
      let began = false;
      const driver = {
        beginTransaction: async () => { began = true; events.push('begin'); },
        describeInTransaction: async (_id: string, _db: string | undefined, options: any) => {
          assert.equal(began, true, 'schema must be collected after BEGIN');
          assert.equal(options.signal, controller.signal);
          assert.equal(options.executionId, `${item.engine}-backup`);
          events.push('schema');
          return [{ ...dumpTable, schema: 'app' }];
        },
        runInTransaction: async (_id: string, sql: string, _params: unknown[], options: any) => {
          assert.equal(began, true, 'metadata must be collected after BEGIN');
          assert.equal(options.signal, controller.signal);
          assert.equal(options.executionId, `${item.engine}-backup`);
          events.push(sql);
          if (sql === item.setting) return emptyResult();
          if (sql.includes('COUNT(*)')) return { ...emptyResult(), columns: [{ name: 'count' }], rows: [[0]], rowCount: 1 };
          if (/^SELECT \* FROM/.test(sql)) return { ...emptyResult(), columns: [{ name: 'id' }], rows: [], rowCount: 0 };
          assert.fail(`unexpected backup query: ${sql}`);
        },
        commitTransaction: async () => { events.push('commit'); },
        rollbackTransaction: async () => { events.push('rollback'); },
      };
      const manager = { rawDriver: async () => driver } as unknown as ConnectionManager;
      try {
        const backup = await dumpDatabase(store, manager, config, conn.id, undefined, undefined, controller.signal, `${item.engine}-backup`);
        assert.equal(backup.tables, 1);
        assert.deepEqual(events.slice(0, 3), ['begin', item.setting, 'schema']);
        assert.equal(events.at(-1), 'commit');
        assert.equal(events.includes('rollback'), false);
      } finally {
        controller.abort();
        restoreCapacity();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('dumpDatabase rejects nontransactional MySQL tables before writing a consistency backup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-backup-myisam-'));
  const config = configFor(dir);
  const restoreCapacity = mockBackupCapacity(t);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'backup', engine: 'mysql', database: 'app' });
  const events: string[] = [];
  const driver = {
    engine: 'mysql',
    beginTransaction: async () => { events.push('begin'); },
    describeInTransaction: async () => { events.push('schema'); return [dumpTable]; },
    runInTransaction: async (_id: string, sql: string) => {
      if (sql === 'SELECT @@transaction_isolation') {
        events.push('isolation');
        return { ...emptyResult(), columns: [{ name: '@@transaction_isolation' }], rows: [['REPEATABLE-READ']], rowCount: 1 };
      }
      if (sql.includes('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES')) {
        events.push('engines');
        return { ...emptyResult(), columns: [{ name: 'TABLE_NAME' }, { name: 'ENGINE' }], rows: [['items', 'MyISAM']], rowCount: 1 };
      }
      assert.fail(`backup must stop before reading table data: ${sql}`);
    },
    commitTransaction: async () => { assert.fail('an unsupported backup must not commit'); },
    rollbackTransaction: async () => { events.push('rollback'); },
  };
  const manager = { rawDriver: async () => driver } as unknown as ConnectionManager;

  try {
    await assert.rejects(() => dumpDatabase(store, manager, config, conn.id), (error: any) => {
      assert.equal(error.code, 'CONSISTENT_BACKUP_UNSUPPORTED');
      assert.match(error.message, /myisam/i);
      return true;
    });
    assert.deepEqual(events, ['begin', 'isolation', 'schema', 'engines', 'rollback']);
    assert.deepEqual(readdirSync(config.backupDir), [], 'an unsupported backup must not remain on disk');
    assert.deepEqual(store.listBackups(conn.id), [], 'an unsupported backup must not be registered');
  } finally {
    restoreCapacity();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dumpDatabase accepts a complete InnoDB table inventory for a transaction snapshot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-backup-innodb-'));
  const config = configFor(dir);
  const restoreCapacity = mockBackupCapacity(t);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'backup', engine: 'mysql', database: 'app' });
  const events: string[] = [];
  const driver = {
    engine: 'mysql',
    beginTransaction: async () => { events.push('begin'); },
    describeInTransaction: async () => { events.push('schema'); return [dumpTable]; },
    runInTransaction: async (_id: string, sql: string) => {
      if (sql === 'SELECT @@transaction_isolation') return { ...emptyResult(), columns: [{ name: 'isolation' }], rows: [['REPEATABLE-READ']], rowCount: 1 };
      if (sql.includes('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES')) return { ...emptyResult(), columns: [{ name: 'TABLE_NAME' }, { name: 'ENGINE' }], rows: [['items', 'InnoDB']], rowCount: 1 };
      if (sql.includes('information_schema.TRIGGERS')) return { ...emptyResult(), columns: [{ name: 'count' }], rows: [[0]], rowCount: 1 };
      if (/^SELECT \* FROM/.test(sql)) return { ...emptyResult(), columns: [{ name: 'id' }], rows: [], rowCount: 0 };
      assert.fail(`unexpected backup query: ${sql}`);
    },
    commitTransaction: async () => { events.push('commit'); },
    rollbackTransaction: async () => { events.push('rollback'); },
  };
  const manager = { rawDriver: async () => driver } as unknown as ConnectionManager;
  try {
    const backup = await dumpDatabase(store, manager, config, conn.id);
    assert.equal(backup.tables, 1);
    assert.equal(backup.rows, 0);
    assert.deepEqual(events, ['begin', 'schema', 'commit']);
    assert.match(readFileSync(backup.path, 'utf8'), /consistency: transaction snapshot/);
    assert.equal(store.listBackups(conn.id).length, 1);
  } finally {
    restoreCapacity();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dumpDatabase creates an owner-only backup file on POSIX', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-backup-mode-'));
  const config = configFor(dir);
  const restoreCapacity = mockBackupCapacity(t);
  const database = join(dir, 'source.db');
  const seed = new DatabaseSync(database);
  seed.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO items VALUES (1, 'secret');");
  seed.close();
  const store = new Store(config.dbPath, config.secret);
  const manager = new ConnectionManager(store, config, () => DEFAULT_SETTINGS);
  const conn = store.createConnection({ name: 'backup', engine: 'sqlite', database });

  try {
    const backup = await dumpDatabase(store, manager, config, conn.id);
    assert.equal(backup.rows, 1);
    assert.match(readFileSync(backup.path, 'utf8'), /INSERT INTO "items"/);
    assert.equal(store.listBackups(conn.id)[0]?.path, backup.path);
    if (process.platform !== 'win32') assert.equal(fs.lstatSync(backup.path).mode & 0o777, 0o600);
  } finally {
    await manager.closeAll();
    restoreCapacity();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup capacity reserves 1GB and enforces the 20GB ceiling', () => {
  const gib = 1024 ** 3;
  assert.throws(() => backupCapacityByteLimit(gib - 1), { code: 'BACKUP_CAPACITY' });
  assert.equal(backupCapacityByteLimit(gib + 2048), 2048);
  assert.equal(backupCapacityByteLimit(21 * gib + 4096), 20 * gib);
});
