import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, type TableInfo } from '@aidb/core';
import { ConnectionManager } from '../src/manager';
import { Store } from '../src/store';
import { DbError } from '../src/drivers/types';
import { dumpDatabase, restoreBackupFile } from '../src/services';
import { runScript } from '../src/pipeline/script';
import { transferData, TransferAbortedError } from '../src/features/transfer';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-cancel-boundary-'));
  for (const name of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(dir, name), { recursive: true });
  const config = {
    version: '0', home: dir, dbPath: join(dir, 'aidb.db'), host: '127.0.0.1', port: 0,
    token: 't', secret: 'secret', demoDir: join(dir, 'demo'), exportDir: join(dir, 'exports'),
    importDir: join(dir, 'imports'), backupDir: join(dir, 'backups'), attachmentDir: join(dir, 'attachments'),
    staticDir: join(dir, 'static'), production: false,
  };
  const store = new Store(config.dbPath, config.secret);
  const manager = new ConnectionManager(store, config, () => DEFAULT_SETTINGS);
  return {
    dir, config, store, manager,
    cleanup: async () => {
      await manager.closeAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedDatabase(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
}

function abortableQuery(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new DbError('工具执行已取消', { code: 'ABORTED' }));
      return;
    }
    signal?.addEventListener('abort', () => reject(new DbError('工具执行已取消', { code: 'ABORTED' })), { once: true });
  });
}

test('取消直驱写后立即返回，但执行追踪保留到底层写真正结束', async () => {
  const { manager, cleanup } = setup();
  const controller = new AbortController();
  const started = deferred();
  const finish = deferred();
  const state = manager as any;
  state.driverFor = async () => ({});
  try {
    const pending = state.trackWrite('fake', { actor: 'user', executionId: 'write-1', signal: controller.signal }, async () => {
      started.resolve();
      await finish.promise;
      return 'done';
    });
    await started.promise;
    controller.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
    manager.releaseExecution('write-1');
    assert.equal(state.activeExecutions.has('write-1'), true, '调用方释放不能抹掉仍在执行的写');
    assert.equal(manager.cancelExecution('write-1'), true, '后续 stop 仍能定位到底层写');
    finish.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state.activeExecutions.has('write-1'), false);
    assert.equal(state.abandonedExecutions.has('write-1'), false);
  } finally {
    finish.resolve();
    await cleanup();
  }
});

test('脚本在 mkdir/writeFile 期间被取消时不会启动子进程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-script-abort-'));
  const marker = join(dir, 'spawned.txt');
  const controller = new AbortController();
  try {
    const pending = runScript({
      runtime: 'node',
      code: `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'spawned'); function transform(rows) { return rows; }`,
      payload: { rows: [], columns: [], params: {}, state: {}, run: {} },
      dir: join(dir, 'work'),
      timeoutMs: 5000,
      maxRows: 10,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, { code: 'PIPELINE_ABORTED' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(existsSync(marker), false, '取消发生在启动前，用户脚本不能产生副作用');
  } finally {
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('整库备份的非流式读取带执行追踪，取消后删除未完成文件', async () => {
  const { dir, config, store, cleanup } = setup();
  const conn = store.createConnection({ name: 'backup', engine: 'sqlite', database: join(dir, 'source.db') });
  const table: TableInfo = { name: 'items', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: false }] };
  const controller = new AbortController();
  const started = deferred();
  let schemaOptions: unknown;
  let queryOptions: any;
  const manager = {
    schema: async (_id: string, _db: string, refresh: boolean, ttl: number, options: unknown) => {
      schemaOptions = options;
      assert.equal(refresh, true);
      assert.equal(ttl, 30000);
      return [{ name: 'main', tables: [table] }];
    },
    rawDriver: async () => ({}),
    query: async (_id: string, _sql: string, options: any) => {
      queryOptions = options;
      started.resolve();
      return abortableQuery(options.signal);
    },
  } as unknown as ConnectionManager;
  try {
    const pending = dumpDatabase(store, manager, config, conn.id, undefined, 'cancel-test', controller.signal, 'backup-1');
    await started.promise;
    controller.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
    assert.equal((schemaOptions as any).executionId, 'backup-1');
    assert.equal(queryOptions.executionId, 'backup-1');
    assert.equal(queryOptions.signal, controller.signal);
    assert.deepEqual(readdirSync(config.backupDir), [], '未完成备份不能留在目录里');
  } finally {
    controller.abort();
    await cleanup();
  }
});

test('恢复备份的分批执行带取消信号与执行 ID', async () => {
  const { dir, store, cleanup } = setup();
  const conn = store.createConnection({ name: 'restore', engine: 'sqlite', database: join(dir, 'target.db') });
  const file = join(dir, 'restore.sql');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, 'CREATE TABLE items (id INTEGER);\nINSERT INTO items (id) VALUES (1);\n');
  const controller = new AbortController();
  const started = deferred();
  let queryOptions: any;
  const manager = {
    rawDriver: async () => ({}),
    query: async (_id: string, _sql: string, options: any) => {
      queryOptions = options;
      started.resolve();
      return abortableQuery(options.signal);
    },
  } as unknown as ConnectionManager;
  try {
    const pending = restoreBackupFile(store, manager, conn.id, file, undefined, { signal: controller.signal, executionId: 'restore-1' });
    await started.promise;
    controller.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
    assert.equal(queryOptions.executionId, 'restore-1');
    assert.equal(queryOptions.signal, controller.signal);
    assert.equal(queryOptions.allowMulti, true);
  } finally {
    controller.abort();
    await cleanup();
  }
});

test('replace 提交期间取消：提交成功后不再尝试回滚', async () => {
  const { dir, store, manager, cleanup } = setup();
  const sourcePath = join(dir, 'source.db');
  const targetPath = join(dir, 'target.db');
  seedDatabase(sourcePath, 'CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (2);');
  seedDatabase(targetPath, 'CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1);');
  const source = store.createConnection({ name: 'source', engine: 'sqlite', database: sourcePath });
  const target = store.createConnection({ name: 'target', engine: 'sqlite', database: targetPath });
  const controller = new AbortController();
  const commitStarted = deferred();
  const finishCommit = deferred();
  const originalCommit = manager.commitTransaction.bind(manager);
  const originalRollback = manager.rollbackTransaction.bind(manager);
  let rollbacks = 0;
  manager.commitTransaction = async (...args: Parameters<ConnectionManager['commitTransaction']>) => {
    commitStarted.resolve();
    await finishCommit.promise;
    return originalCommit(...args);
  };
  manager.rollbackTransaction = async (...args: Parameters<ConnectionManager['rollbackTransaction']>) => {
    rollbacks += 1;
    return originalRollback(...args);
  };
  try {
    const pending = transferData(store, manager, {
      sourceId: source.id, targetId: target.id, tables: ['items'], mode: 'replace', signal: controller.signal,
    });
    await commitStarted.promise;
    controller.abort();
    finishCommit.resolve();
    await assert.rejects(pending, TransferAbortedError);
    assert.equal(rollbacks, 0, '提交已经成功，不能把已提交事务当失败回滚');
    const result = await manager.query(target.id, 'SELECT id FROM items', { autoLimit: false, actor: 'user' });
    assert.deepEqual(result.sets[0].rows, [[2]]);
  } finally {
    finishCommit.resolve();
    await cleanup();
  }
});
