import test from 'node:test';
import assert from 'node:assert/strict';
import mssql from 'mssql';
import { SqlServerDriver } from '../src/drivers/sqlserver';
import { supportsTransaction } from '../src/drivers/types';

const PORT = process.env.AIDB_TEST_SQLSERVER_PORT ? Number(process.env.AIDB_TEST_SQLSERVER_PORT) : undefined;
const PASSWORD = process.env.AIDB_TEST_SQLSERVER_PASSWORD ?? 'Aidb_test1!';
const DATABASE = process.env.AIDB_TEST_SQLSERVER_DB ?? 'aidb_tx';

function driver(): SqlServerDriver {
  return new SqlServerDriver({ host: '127.0.0.1', port: PORT!, user: 'sa', password: PASSWORD, database: DATABASE });
}

test('SQL Server 跨请求事务：提交保留、回滚撤销', { skip: !PORT }, async () => {
  const db = driver();
  try {
    assert.equal(supportsTransaction(db), true);
    assert.equal((await db.test()).ok, true);

    const sid = 'mssql-tx-test';
    await db.run('IF OBJECT_ID(N\'dbo.tx_probe\', N\'U\') IS NOT NULL DROP TABLE dbo.tx_probe', { database: DATABASE });
    await db.beginTransaction(sid, DATABASE);
    await db.runInTransaction(sid, 'CREATE TABLE dbo.tx_probe (id INT PRIMARY KEY, note VARCHAR(32))', []);
    await db.runInTransaction(sid, "INSERT INTO dbo.tx_probe VALUES (1, 'seed')", []);
    await db.commitTransaction(sid);

    const seeded = await db.run('SELECT COUNT(*) AS n FROM dbo.tx_probe', { database: DATABASE });
    assert.equal(Number(seeded.rows[0][0]), 1, '提交后种子行可见');

    await db.beginTransaction(sid, DATABASE);
    await db.runInTransaction(sid, "INSERT INTO dbo.tx_probe VALUES (2, 'in-tx')", []);
    const inside = await db.runInTransaction(sid, 'SELECT COUNT(*) AS n FROM dbo.tx_probe', []);
    assert.equal(Number(inside.rows[0][0]), 2, '事务内能看到未提交的行');
    await db.rollbackTransaction(sid);

    const after = await db.run('SELECT COUNT(*) AS n FROM dbo.tx_probe', { database: DATABASE });
    assert.equal(Number(after.rows[0][0]), 1, '回滚后新行不存在');

    await assert.rejects(() => db.commitTransaction(sid), /事务会话不存在/);

    await db.run('DROP TABLE dbo.tx_probe', { database: DATABASE });
  } finally {
    await db.close();
  }
});

test('SQL Server transaction request is cancelled and reported as ABORTED', async () => {
  const db = new SqlServerDriver({ host: '127.0.0.1', port: 1, user: 'sa', database: DATABASE });
  const controller = new AbortController();
  let cancelCount = 0;
  let rejectQuery!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  class FakeRequest {
    constructor(_transaction: unknown) {
      markStarted();
    }
    cancel(): void {
      cancelCount += 1;
      rejectQuery(new Error('cancelled'));
    }
    async query(): Promise<never> {
      return new Promise<never>((_resolve, reject) => { rejectQuery = reject; });
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(mssql, 'Request');
  assert.ok(descriptor);
  Object.defineProperty(mssql, 'Request', { ...descriptor, value: FakeRequest });
  (db as any).txTransactions.set('cancel-session', {});
  try {
    const pending = db.runInTransaction('cancel-session', 'INSERT INTO dbo.items (id) VALUES (1)', [], { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
    assert.equal(cancelCount, 1, 'abort must cancel the request pinned to the transaction');
  } finally {
    controller.abort();
    (db as any).txTransactions.clear();
    Object.defineProperty(mssql, 'Request', descriptor);
    await db.close();
  }
});
