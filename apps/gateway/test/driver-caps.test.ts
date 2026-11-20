import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MysqlDriver } from '../src/drivers/mysql';
import { PostgresDriver } from '../src/drivers/postgres';
import { SqliteDriver } from '../src/drivers/sqlite';
import { DuckdbDriver } from '../src/drivers/duckdb';
import { DbError } from '../src/drivers/types';
import { injectMaxExecutionTime, isSingleSelect, wrapSelectLimit } from '../src/drivers/sqlCap';

/**
 * WP1 驱动层真超时与结果上限：
 * MySQL 看门狗/排队超时、LIMIT 下推判定、PG statement_timeout 设置与 RESET、
 * SQLite 逐行双上限、DuckDB 流式上限与 interrupt。全部用假连接/本地引擎，不依赖活库。
 */

/* ---------------- MySQL 看门狗 ---------------- */

function stalledFake() {
  const stream = new Readable({ objectMode: true, read() {} });
  const query = { stream: () => stream, on: () => query };
  const conn = {
    destroyed: 0,
    query: () => query,
    destroy() {
      this.destroyed += 1;
    },
    release() {},
  };
  return { conn, stream };
}

const collect = (driver: MysqlDriver, conn: unknown, opts: Record<string, unknown>, inTx = false) =>
  (driver as unknown as { streamCollect: (...args: unknown[]) => Promise<any> }).streamCollect(
    conn,
    'SELECT * FROM t',
    [],
    opts,
    Date.now(),
    inTx,
  );

const mysqlOpts = { host: 'fake', port: 0, user: 'fake' };

test('MySQL 看门狗：到期 reject MYSQL_TIMEOUT 并销毁连接（非事务）', async () => {
  const fake = stalledFake();
  const started = Date.now();
  await assert.rejects(
    collect(new MysqlDriver(mysqlOpts), fake.conn, { timeoutMs: 60 }),
    (err: unknown) => err instanceof DbError && (err as DbError).code === 'MYSQL_TIMEOUT' && (err as DbError).status === 504,
  );
  assert.ok(Date.now() - started < 3000, '看门狗应立即返回而不是等服务器回包');
  assert.equal(fake.conn.destroyed, 1);
});

test('MySQL 看门狗：事务内到期不销毁连接（沿用事务约束）', async () => {
  const fake = stalledFake();
  await assert.rejects(
    collect(new MysqlDriver(mysqlOpts), fake.conn, { timeoutMs: 60 }, true),
    (err: unknown) => (err as DbError).code === 'MYSQL_TIMEOUT',
  );
  assert.equal(fake.conn.destroyed, 0);
});

test('MySQL 看门狗：正常 settle 后定时器被清理，不会迟到销毁连接', async () => {
  const stream = new Readable({ objectMode: true, read() {} });
  const query = { stream: () => stream, on: () => query };
  const conn = {
    destroyed: 0,
    query: () => query,
    destroy() {
      this.destroyed += 1;
    },
    release() {},
  };
  setImmediate(() => {
    stream.emit('fields', [{ name: 'id', type: 3 }]);
    stream.push({ id: 1 });
    stream.push(null);
  });
  const result = await collect(new MysqlDriver(mysqlOpts), conn, { timeoutMs: 80 });
  assert.equal(result.rows.length, 1);
  // 等过看门狗期限：若定时器泄漏，连接会被迟到销毁。
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(conn.destroyed, 0);
});

test('MySQL 排队超时：reject POOL_TIMEOUT，迟到连接必须 release 不泄漏', async () => {
  const driver = new MysqlDriver(mysqlOpts);
  (driver as unknown as { acquireTimeoutMs: number }).acquireTimeoutMs = 50;
  const late = { released: 0, release() { this.released += 1; } };
  (driver as unknown as { pools: Map<string, unknown> }).pools.set('', {
    getConnection: () => new Promise((resolve) => setTimeout(() => resolve(late), 120)),
  });
  await assert.rejects(
    driver.run('SELECT 1'),
    (err: unknown) => err instanceof DbError && (err as DbError).code === 'POOL_TIMEOUT' && (err as DbError).status === 504,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(late.released, 1, '超时后迟到的连接要归还池子');
});

/* ---------------- LIMIT 下推 / 提示注入判定 ---------------- */

test('isSingleSelect：只认单条只读 SELECT/WITH', () => {
  assert.equal(isSingleSelect('SELECT * FROM t'), true);
  assert.equal(isSingleSelect('  WITH c AS (SELECT 1) SELECT * FROM c;  '), true);
  assert.equal(isSingleSelect('SELECT 1; SELECT 2'), false);
  assert.equal(isSingleSelect('UPDATE t SET a = 1'), false);
  assert.equal(isSingleSelect('SHOW TABLES'), false);
  assert.equal(isSingleSelect('EXPLAIN SELECT 1'), false);
  assert.equal(isSingleSelect('SELECT * FROM t FOR UPDATE'), false);
  assert.equal(isSingleSelect('WITH c AS (SELECT 1) DELETE FROM t'), false);
  assert.equal(isSingleSelect("SELECT 'SELECT 1; SELECT 2' AS s"), true, '字符串里的分号不算多语句');
});

test('wrapSelectLimit：单条 SELECT/WITH 外包 LIMIT，其余不包', () => {
  assert.equal(wrapSelectLimit('SELECT * FROM t', 3), 'SELECT * FROM (SELECT * FROM t\n) AS _aidb_limit LIMIT 3');
  assert.equal(wrapSelectLimit('SELECT * FROM t;', 3), 'SELECT * FROM (SELECT * FROM t\n) AS _aidb_limit LIMIT 3');
  assert.equal(
    wrapSelectLimit('WITH c AS (SELECT 1) SELECT * FROM c', 5),
    'SELECT * FROM (WITH c AS (SELECT 1) SELECT * FROM c\n) AS _aidb_limit LIMIT 5',
  );
  assert.equal(wrapSelectLimit('SELECT 1; SELECT 2', 3), undefined);
  assert.equal(wrapSelectLimit('INSERT INTO t VALUES (1)', 3), undefined);
  assert.equal(wrapSelectLimit('SELECT * FROM t', 0), undefined);
});

test('injectMaxExecutionTime：提示插在顶层 SELECT 后，WITH 跳过 CTE 内的 SELECT', () => {
  assert.equal(injectMaxExecutionTime('SELECT * FROM t', 1000), 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t');
  const withSql = 'WITH c AS (SELECT 1) SELECT * FROM c';
  assert.equal(
    injectMaxExecutionTime(withSql, 2000),
    'WITH c AS (SELECT 1) SELECT /*+ MAX_EXECUTION_TIME(2000) */ * FROM c',
  );
  assert.equal(injectMaxExecutionTime('UPDATE t SET a = 1', 1000), 'UPDATE t SET a = 1');
  assert.equal(injectMaxExecutionTime('SELECT 1; SELECT 2', 1000), 'SELECT 1; SELECT 2');
  assert.equal(
    injectMaxExecutionTime("SELECT 'SELECT x' AS s", 1000),
    "SELECT /*+ MAX_EXECUTION_TIME(1000) */ 'SELECT x' AS s",
    '字符串里的 SELECT 不触发注入',
  );
});

/* ---------------- PG statement_timeout / RESET ---------------- */

interface FakePgQuery {
  text: string;
  emit: (event: string, ...args: unknown[]) => boolean;
}
/** 流式契约：SELECT 以 Query 实例提交，假 client 逐行 emit('row') 再 emit('end')。 */
function emitPgResult(query: FakePgQuery, res: { rows?: unknown[]; fields?: unknown[]; rowCount?: number } | undefined) {
  if (!res) return;
  for (const row of res.rows ?? []) query.emit('row', row, { fields: res.fields ?? [] });
  query.emit('end', { fields: res.fields ?? [], rowCount: res.rowCount ?? res.rows?.length ?? 0 });
}

function fakePg(handler: (text: string) => any) {
  const calls: string[] = [];
  const client = {
    released: 0,
    destroyed: 0,
    query(q: unknown) {
      if (typeof q === 'string') {
        calls.push(q);
        return Promise.resolve(handler(q));
      }
      const query = q as FakePgQuery;
      calls.push(query.text);
      let out: any;
      try {
        out = handler(query.text);
      } catch (err) {
        setImmediate(() => query.emit('error', err));
        return query;
      }
      if (out && typeof out.then === 'function') {
        out.then(
          (res: any) => emitPgResult(query, res),
          (err: any) => query.emit('error', err),
        );
        return query;
      }
      setImmediate(() => emitPgResult(query, out));
      return query;
    },
    release(err?: unknown) {
      if (err) this.destroyed += 1;
      else this.released += 1;
    },
  };
  const driver = new PostgresDriver({ host: 'fake', port: 0, user: 'fake', database: 'db' });
  (driver as unknown as { pool: () => unknown }).pool = () => ({ connect: async () => client });
  return { driver, client, calls };
}

const pgRow = { rows: [{ id: 1 }], fields: [{ name: 'id', dataTypeID: 23 }], rowCount: 1 };

test('PG：执行前 SET statement_timeout，finally RESET 并归还 client', async () => {
  const { driver, client, calls } = fakePg((text) => (text.startsWith('SELECT') ? pgRow : { rows: [] }));
  const result = await driver.runParams('SELECT * FROM t', [], { timeoutMs: 1234 });
  assert.equal(result.rows.length, 1);
  assert.equal(calls[0], 'SET statement_timeout = 1234');
  assert.equal(calls[1], 'SELECT * FROM t');
  assert.equal(calls[2], 'RESET statement_timeout');
  assert.equal(client.released, 1);
  assert.equal(client.destroyed, 0);
});

test('PG：RESET 失败销毁 client 不回池（避免会话设置泄漏）', async () => {
  const { driver, client } = fakePg((text) => {
    if (text === 'RESET statement_timeout') throw new Error('connection terminated');
    return text.startsWith('SELECT') ? pgRow : { rows: [] };
  });
  await driver.runParams('SELECT * FROM t', [], { timeoutMs: 1000 });
  assert.equal(client.destroyed, 1);
  assert.equal(client.released, 0);
});

test('PG：客户端看门狗到期销毁 client 并报 PG_TIMEOUT', async () => {
  const { driver, client, calls } = fakePg((text) => {
    if (text.startsWith('SELECT')) return new Promise(() => undefined);
    return { rows: [] };
  });
  await assert.rejects(
    driver.runParams('SELECT * FROM t', [], { timeoutMs: 60 }),
    (err: unknown) => err instanceof DbError && (err as DbError).code === 'PG_TIMEOUT' && (err as DbError).status === 504,
  );
  assert.equal(client.destroyed, 1);
  assert.equal(calls.includes('RESET statement_timeout'), false, '已销毁的 client 不再 RESET');
});

test('PG：服务端 57014 取消映射为 PG_TIMEOUT，client 正常 RESET 归还', async () => {
  const { driver, client, calls } = fakePg((text) => {
    if (text.startsWith('SELECT')) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    return { rows: [] };
  });
  await assert.rejects(
    driver.runParams('SELECT * FROM t', [], { timeoutMs: 1000 }),
    (err: unknown) => (err as DbError).code === 'PG_TIMEOUT' && (err as DbError).status === 504,
  );
  assert.ok(calls.includes('RESET statement_timeout'));
  assert.equal(client.released, 1);
});

test('PG：单条 SELECT 下推 LIMIT maxRows+1，多一行即 truncated', async () => {
  const three = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], fields: [{ name: 'id', dataTypeID: 23 }], rowCount: 3 };
  const { driver, client, calls } = fakePg((text) => (text.startsWith('SELECT') ? three : { rows: [] }));
  const result = await driver.runParams('SELECT * FROM t', [], { maxRows: 2, timeoutMs: 1000 });
  assert.equal(calls[1], 'SELECT * FROM (SELECT * FROM t\n) AS _aidb_limit LIMIT 3');
  assert.equal(result.statement, 'SELECT * FROM t', 'statement 回用户原句，不漏下推包装句');
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(client.destroyed, 1, '事务外截断销毁 client，终止服务端剩余输出');
});

test('PG：多语句/非 SELECT 不下推；重复列名（42701）回落原句', async () => {
  const { driver, calls } = fakePg((text) => (text.startsWith('SELECT') ? pgRow : { rows: [] }));
  await driver.runParams('SELECT 1; SELECT 2', [], { maxRows: 2, timeoutMs: 1000 });
  assert.equal(calls[1], 'SELECT 1; SELECT 2');

  const dup = fakePg((text) => {
    if (text.startsWith('SELECT * FROM (')) throw Object.assign(new Error('column "id" specified more than once'), { code: '42701' });
    return text.startsWith('SELECT') ? pgRow : { rows: [] };
  });
  const result = await dup.driver.runParams('SELECT a.id, b.id FROM a JOIN b ON a.id = b.id', [], { maxRows: 2, timeoutMs: 1000 });
  assert.equal(result.rows.length, 1);
  assert.ok(dup.calls.includes('SELECT a.id, b.id FROM a JOIN b ON a.id = b.id'), '42701 后必须用原句重试');
});

test('PG 事务：SET LOCAL 自动还原，不 RESET 不归还；看门狗到期不销毁', async () => {
  const { driver, client, calls } = fakePg((text) => (text.startsWith('SELECT') ? pgRow : { rows: [] }));
  (driver as unknown as { txClients: Map<string, unknown> }).txClients.set('s', client);
  await driver.runInTransaction('s', 'SELECT * FROM t', [], { timeoutMs: 500 });
  assert.equal(calls[0], 'SET LOCAL statement_timeout = 500');
  assert.equal(calls.includes('RESET statement_timeout'), false);
  assert.equal(client.released, 0);
  assert.equal(client.destroyed, 0);

  const stalled = fakePg((text) => (text.startsWith('SELECT') ? new Promise(() => undefined) : { rows: [] }));
  (stalled.driver as unknown as { txClients: Map<string, unknown> }).txClients.set('s', stalled.client);
  await assert.rejects(
    stalled.driver.runInTransaction('s', 'SELECT * FROM t', [], { timeoutMs: 60 }),
    (err: unknown) => (err as DbError).code === 'PG_TIMEOUT',
  );
  assert.equal(stalled.client.destroyed, 0, '事务内看门狗到期不销毁连接');
});

/* ---------------- SQLite 逐行双上限 / describe ---------------- */

function sqliteEnv(seed: (db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-sqlite-caps-'));
  const file = join(dir, 'caps.db');
  const db = new DatabaseSync(file);
  seed(db);
  db.close();
  const driver = new SqliteDriver(file, false);
  return {
    driver,
    cleanup: async () => {
      await driver.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('SQLite：行数上限截断；恰好等于上限不误报；显式 LIMIT 更小不误报', async () => {
  const env = sqliteEnv((db) => {
    db.exec('CREATE TABLE t (id INTEGER)');
    db.exec('INSERT INTO t VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10)');
  });
  try {
    const capped = await env.driver.run('SELECT * FROM t', { maxRows: 3 });
    assert.equal(capped.rows.length, 3);
    assert.equal(capped.truncated, true);
    const exact = await env.driver.run('SELECT * FROM t LIMIT 3', { maxRows: 3 });
    assert.equal(exact.rows.length, 3);
    assert.equal(exact.truncated, false);
    const small = await env.driver.run('SELECT * FROM t LIMIT 2', { maxRows: 100 });
    assert.equal(small.truncated, false);
  } finally {
    await env.cleanup();
  }
});

test('SQLite：字节上限截断，首行超预算也保留（对齐 mysql 64MB 语义）', async () => {
  const env = sqliteEnv((db) => {
    db.exec('CREATE TABLE big (id INTEGER, doc TEXT)');
    const insert = db.prepare('INSERT INTO big VALUES (?, ?)');
    insert.run(1, 'x'.repeat(65 * 1024 * 1024));
    insert.run(2, 'small');
  });
  try {
    const result = await env.driver.run('SELECT * FROM big');
    assert.equal(result.rows.length, 1);
    assert.equal(result.truncated, true);
  } finally {
    await env.cleanup();
  }
});

test('SQLite describe：不做 COUNT(*)，行数取 sqlite_stat1，缺失时退 MAX(rowid)，WITHOUT ROWID 省略', async () => {
  const env = sqliteEnv((db) => {
    db.exec('CREATE TABLE t (id INTEGER)');
    db.exec('INSERT INTO t VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10)');
    db.exec('CREATE TABLE wr (k TEXT PRIMARY KEY) WITHOUT ROWID');
    db.exec("INSERT INTO wr VALUES ('a'),('b')");
  });
  try {
    // 未 ANALYZE：stat1 不存在，rowid 表退到 MAX(rowid)（O(log n)，非全表扫描）。
    const before = await env.driver.describe();
    assert.equal(before.find((t) => t.name === 't')?.rowEstimate, 10);
    // WITHOUT ROWID 表没有 rowid 列，两个来源都拿不到，保持省略。
    assert.equal(before.find((t) => t.name === 'wr')?.rowEstimate, undefined);
    const raw = new DatabaseSync(await env.driver.filePathValue());
    raw.exec('ANALYZE');
    raw.close();
    const after = await env.driver.describe();
    assert.equal(after.find((t) => t.name === 't')?.rowEstimate, 10);
  } finally {
    await env.cleanup();
  }
});

/* ---------------- DuckDB 流式上限 / interrupt ---------------- */

test('DuckDB：行数上限截断并标记 truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-duck-caps-'));
  const driver = new DuckdbDriver(join(dir, 'caps.duckdb'), false);
  try {
    await driver.run('CREATE TABLE t AS SELECT * FROM range(10) tbl(id)');
    const result = await driver.run('SELECT * FROM t ORDER BY id', { maxRows: 3 });
    assert.equal(result.rows.length, 3);
    assert.equal(result.truncated, true);
    const exact = await driver.run('SELECT * FROM t ORDER BY id LIMIT 3', { maxRows: 3 });
    assert.equal(exact.truncated, undefined);
  } finally {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DuckDB：看门狗 interrupt 终止慢查询，连接随后仍可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-duck-timeout-'));
  const driver = new DuckdbDriver(join(dir, 'timeout.duckdb'), false);
  try {
    const started = Date.now();
    await assert.rejects(
      driver.run('SELECT sum(i * j) FROM range(10000000) t1(i), range(10000000) t2(j)', { timeoutMs: 150 }),
      (err: unknown) => err instanceof DbError && (err as DbError).code === 'DUCKDB_TIMEOUT' && (err as DbError).status === 504,
    );
    assert.ok(Date.now() - started < 15000, 'interrupt 应立即终止而不是跑完笛卡尔积');
    // 流式结果必须 closeSync 释放连接，否则下一条语句被阻塞。
    const ping = await driver.run('SELECT 1 AS x');
    assert.deepEqual(ping.rows, [[1]]);
  } finally {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});