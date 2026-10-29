import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleDriver } from '../src/drivers/oracle';
import { supportsTransaction } from '../src/drivers/types';

const PORT = process.env.AIDB_TEST_ORACLE_PORT ? Number(process.env.AIDB_TEST_ORACLE_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_ORACLE_PASSWORD ?? 'testpass';
const SERVICE = process.env.AIDB_TEST_ORACLE_SERVICE ?? 'FREEPDB1';
const USER = process.env.AIDB_TEST_ORACLE_USER ?? 'system';

function driver(): OracleDriver {
  return new OracleDriver({ host: '127.0.0.1', port: PORT!, user: USER, password: PASSWORD, database: SERVICE });
}

test('Oracle 跨请求事务：提交保留、回滚撤销', { skip: !PORT }, async () => {
  const db = driver();
  try {
    assert.equal(supportsTransaction(db), true);
    assert.equal((await db.test()).ok, true);

    const sid = 'oracle-tx-test';
    await db.run('DROP TABLE tx_probe', { database: SERVICE }).catch(() => undefined);
    await db.beginTransaction(sid, SERVICE);
    await db.runInTransaction(sid, 'CREATE TABLE tx_probe (id NUMBER PRIMARY KEY, note VARCHAR2(32))', []);
    await db.runInTransaction(sid, "INSERT INTO tx_probe VALUES (1, 'seed')", []);
    await db.commitTransaction(sid);

    const seeded = await db.run('SELECT COUNT(*) AS n FROM tx_probe', { database: SERVICE });
    assert.equal(Number(seeded.rows[0][0]), 1, '提交后种子行可见');

    // 回滚路径：事务内插入在事务内可见，回滚后消失。
    await db.beginTransaction(sid, SERVICE);
    await db.runInTransaction(sid, "INSERT INTO tx_probe VALUES (2, 'in-tx')", []);
    const inside = await db.runInTransaction(sid, 'SELECT COUNT(*) AS n FROM tx_probe', []);
    assert.equal(Number(inside.rows[0][0]), 2, '事务内能看到未提交的行');
    await db.rollbackTransaction(sid);

    const after = await db.run('SELECT COUNT(*) AS n FROM tx_probe', { database: SERVICE });
    assert.equal(Number(after.rows[0][0]), 1, '回滚后新行不存在');

    // 已结束的会话再提交必须报错，而不是静默成功。
    await assert.rejects(() => db.commitTransaction(sid), /事务会话不存在/);

    await db.run('DROP TABLE tx_probe', { database: SERVICE });
  } finally {
    await db.close();
  }
});
