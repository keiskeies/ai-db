import test from 'node:test';
import assert from 'node:assert/strict';
import { DmDriver } from '../src/drivers/dm';
import { supportsTransaction } from '../src/drivers/types';

const PORT = process.env.AIDB_TEST_DM_TX_PORT ? Number(process.env.AIDB_TEST_DM_TX_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_DM_PASSWORD ?? 'SYSDBA';

// dmdb 使用 DES-CFB 登录加密，运行时需要 NODE_OPTIONS=--openssl-legacy-provider
test('DM8 跨请求事务：提交保留、回滚撤销', { skip: !PORT }, async () => {
  const db = new DmDriver({ host: '127.0.0.1', port: PORT!, user: 'SYSDBA', password: PASSWORD });
  try {
    assert.equal(supportsTransaction(db), true);
    assert.equal((await db.test()).ok, true);

    const sid = 'dm-tx-test';
    await db.run('DROP TABLE AIDB_TX_PROBE').catch(() => undefined);
    await db.beginTransaction(sid);
    await db.runInTransaction(sid, 'CREATE TABLE AIDB_TX_PROBE (ID INT PRIMARY KEY, NOTE VARCHAR(32))', []);
    await db.runInTransaction(sid, "INSERT INTO AIDB_TX_PROBE VALUES (1, 'seed')", []);
    await db.commitTransaction(sid);

    const seeded = await db.run('SELECT COUNT(*) AS N FROM AIDB_TX_PROBE');
    assert.equal(Number(seeded.rows[0][0]), 1, '提交后种子行可见');

    await db.beginTransaction(sid);
    await db.runInTransaction(sid, "INSERT INTO AIDB_TX_PROBE VALUES (2, 'in-tx')", []);
    const inside = await db.runInTransaction(sid, 'SELECT COUNT(*) AS N FROM AIDB_TX_PROBE', []);
    assert.equal(Number(inside.rows[0][0]), 2, '事务内能看到未提交的行');
    await db.rollbackTransaction(sid);

    const after = await db.run('SELECT COUNT(*) AS N FROM AIDB_TX_PROBE');
    assert.equal(Number(after.rows[0][0]), 1, '回滚后新行不存在');

    await assert.rejects(() => db.commitTransaction(sid), /事务会话不存在/);

    await db.run('DROP TABLE AIDB_TX_PROBE');
  } finally {
    await db.close();
  }
});
