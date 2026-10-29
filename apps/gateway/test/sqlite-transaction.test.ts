import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDriver } from '../src/drivers/sqlite';
import { supportsTransaction } from '../src/drivers/types';

test('SQLite 跨请求事务：提交保留、回滚撤销、重复开启被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-sqlite-tx-'));
  const file = join(dir, 'tx.db');
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, note TEXT)');
  seed.exec("INSERT INTO tx_probe VALUES (1, 'seed')");
  seed.close();

  const db = new SqliteDriver(file, false);
  try {
    assert.equal(supportsTransaction(db), true);

    const sid = 'sqlite-tx';
    await db.beginTransaction(sid);
    await db.runInTransaction(sid, "INSERT INTO tx_probe VALUES (2, 'committed')", []);
    await db.commitTransaction(sid);
    const afterCommit = await db.run('SELECT COUNT(*) AS n FROM tx_probe');
    assert.equal(Number(afterCommit.rows[0][0]), 2, '提交后新行可见');

    await db.beginTransaction(sid);
    await db.runInTransaction(sid, "INSERT INTO tx_probe VALUES (3, 'rolled-back')", []);
    const inside = await db.runInTransaction(sid, 'SELECT COUNT(*) AS n FROM tx_probe', []);
    assert.equal(Number(inside.rows[0][0]), 3, '事务内能看到未提交的行');
    await db.rollbackTransaction(sid);
    const afterRollback = await db.run('SELECT COUNT(*) AS n FROM tx_probe');
    assert.equal(Number(afterRollback.rows[0][0]), 2, '回滚后新行不存在');

    // 会话结束后再提交必须报错，不能静默成功。
    await assert.rejects(() => db.commitTransaction(sid), /事务会话不存在/);

    // 同一时刻只允许一个事务。
    await db.beginTransaction('a');
    await assert.rejects(() => db.beginTransaction('b'), /已有进行中的事务/);
    await db.rollbackTransaction('a');
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
