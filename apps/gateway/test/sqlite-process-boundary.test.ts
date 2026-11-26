import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDriver } from '../src/drivers/sqlite';
import { DbError } from '../src/drivers/types';

const slowQuery = `
  WITH RECURSIVE cnt(x) AS (
    VALUES(1)
    UNION ALL
    SELECT x + 1 FROM cnt WHERE x < 1000000000
  )
  SELECT sum(x) AS total FROM cnt
`;

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'aidb-sqlite-process-'));
  const filePath = join(directory, 'app.db');
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT, payload BLOB)');
  db.close();
  return {
    filePath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof DbError && error.code === code;
}

test('SQLite 慢查询在子进程中执行，超时终止且不阻塞网关事件循环', async () => {
  const { filePath, cleanup } = database();
  const driver = new SqliteDriver(filePath, false);
  try {
    await driver.run('SELECT 1 AS ready');
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats += 1; }, 5);
    const started = Date.now();
    try {
      await assert.rejects(driver.run(slowQuery, { timeoutMs: 150 }), hasCode('SQLITE_TIMEOUT'));
    } finally {
      clearInterval(heartbeat);
    }
    assert.ok(Date.now() - started < 3_000, '超时必须在主线程可响应的时间内返回');
    assert.ok(heartbeats >= 1, '慢查询运行期间事件循环定时器应继续执行');

    const recovered = await driver.run('SELECT 7 AS value');
    assert.deepEqual(recovered.rows, [[7]]);
  } finally {
    await driver.close();
    cleanup();
  }
});

test('AbortSignal 终止 SQLite 子进程，迟到查询不会在重建连接后继续执行', async () => {
  const { filePath, cleanup } = database();
  const driver = new SqliteDriver(filePath, false);
  const controller = new AbortController();
  try {
    await driver.run('SELECT 1');
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await assert.rejects(driver.run(slowQuery, { timeoutMs: 5_000, signal: controller.signal }), hasCode('ABORTED'));
    } finally {
      clearTimeout(timer);
    }
    const recovered = await driver.run('SELECT count(*) AS count FROM items');
    assert.deepEqual(recovered.rows, [[0]]);
  } finally {
    await driver.close();
    cleanup();
  }
});

test('事务内超时终止进程并回滚，旧事务会话不能继续提交', async () => {
  const { filePath, cleanup } = database();
  const driver = new SqliteDriver(filePath, false);
  try {
    await driver.beginTransaction('tx-1');
    await driver.runInTransaction('tx-1', "INSERT INTO items (value) VALUES ('uncommitted')", []);
    await assert.rejects(driver.runInTransaction('tx-1', slowQuery, [], { timeoutMs: 100 }), hasCode('SQLITE_TIMEOUT'));
    await assert.rejects(driver.commitTransaction('tx-1'), hasCode('TX_NOT_FOUND'));
    const rows = await driver.run('SELECT count(*) AS count FROM items');
    assert.deepEqual(rows.rows, [[0]]);
  } finally {
    await driver.close();
    cleanup();
  }
});

test('execScript 超时可终止，IPC 保留 BLOB 参数和结果', async () => {
  const { filePath, cleanup } = database();
  const driver = new SqliteDriver(filePath, false);
  try {
    await assert.rejects(driver.execScript(`
      WITH RECURSIVE cnt(x) AS (
        VALUES(1)
        UNION ALL
        SELECT x + 1 FROM cnt WHERE x < 1000000000
      )
      INSERT INTO items (value) SELECT 'slow-' || x FROM cnt;
    `, undefined, { timeoutMs: 100 }), hasCode('SQLITE_TIMEOUT'));

    const payload = new Uint8Array([0, 1, 127, 255]);
    await driver.runParams('INSERT INTO items (value, payload) VALUES (?, ?)', ['blob', payload]);
    const withParams = await driver.runParams('SELECT payload FROM items WHERE value = ?', ['blob'], { maxRows: 1 });
    assert.deepEqual(Array.from(withParams.rows[0][0] as Uint8Array), [0, 1, 127, 255]);
  } finally {
    await driver.close();
    cleanup();
  }
});
