import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TableInfo, ToolResult } from '@aidb/core';
import { MysqlDriver } from '../src/drivers/mysql';
import { PostgresDriver } from '../src/drivers/postgres';
import { DbError } from '../src/drivers/types';
import { writeTableRows } from '../src/services';
import { capToolArgs, capToolResult } from '../src/agentHost';
import { transferData, TransferAbortedError, type TransferEvent } from '../src/features/transfer';
import { createGateway } from '../src/server';

/**
 * OOM 回归：驱动流式上限、备份字节分批、工具结果落库裁剪、端口占用不炸进程。
 * MySQL 侧用假连接/假报文流驱动真实的 streamCollect / iterateRows 逻辑，不依赖活库。
 */

interface FakeQuery {
  stream(options?: { highWaterMark?: number }): Readable;
  on(event: 'error', listener: (err: Error) => void): FakeQuery;
  errorHandlers: Array<(err: Error) => void>;
}

function makeFake(
  rows: unknown[],
  fields: Array<{ name: string; type?: number }>,
  opts: { header?: unknown; error?: Error; end?: boolean } = {},
) {
  const stream = new Readable({ objectMode: true, read() {} });
  const query: FakeQuery = {
    errorHandlers: [],
    stream: () => stream,
    on(event, listener) {
      if (event === 'error') this.errorHandlers.push(listener);
      return this;
    },
  };
  const conn = {
    destroyed: 0,
    released: 0,
    query: () => query,
    destroy() {
      this.destroyed += 1;
    },
    release() {
      this.released += 1;
    },
  };
  setImmediate(() => {
    stream.emit('fields', fields);
    if (opts.header) stream.push(opts.header);
    for (const row of rows) {
      if (stream.destroyed) break;
      stream.push(row);
    }
    if (opts.error) stream.destroy(opts.error);
    else if (opts.end !== false && !stream.destroyed) stream.push(null);
  });
  return { conn, stream, query };
}

const FIELDS = [
  { name: 'id', type: 3 },
  { name: 'doc', type: 252 },
];
const driverOpts = { host: 'fake', port: 0, user: 'fake' };
const collect = (driver: MysqlDriver, conn: unknown, opts: Record<string, unknown>, inTx = false) =>
  (driver as unknown as { streamCollect: (...args: unknown[]) => Promise<any> }).streamCollect(
    conn,
    'SELECT * FROM t',
    [],
    opts,
    Date.now(),
    inTx,
  );

test('streamCollect：行数上限截断并销毁连接（事务外）', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, doc: 'x' }));
  const fake = makeFake(rows, FIELDS);
  const result = await collect(new MysqlDriver(driverOpts), fake.conn, { maxRows: 3 });
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(fake.conn.destroyed, 1);
  assert.deepEqual(result.columns.map((c: { name: string }) => c.name), ['id', 'doc']);
});

test('streamCollect：字节上限截断，首行即使单独超预算也保留', async () => {
  const rows = [{ id: 1, doc: 'a'.repeat(65 * 1024 * 1024) }, { id: 2, doc: 'small' }];
  const fake = makeFake(rows, FIELDS);
  const result = await collect(new MysqlDriver(driverOpts), fake.conn, {});
  assert.equal(result.rows.length, 1, '首行超预算也要给用户看到，第二行起严格执行字节预算');
  assert.equal(result.truncated, true);
  assert.equal(fake.conn.destroyed, 1);
});

test('streamCollect：事务内截断不销毁连接（剩余报文排空，事务继续）', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, doc: 'x' }));
  const fake = makeFake(rows, FIELDS);
  const result = await collect(new MysqlDriver(driverOpts), fake.conn, { maxRows: 1 }, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(fake.conn.destroyed, 0);
});

test('streamCollect：OK 包映射为 affected/lastInsertId', async () => {
  const fake = makeFake([], [], { header: { affectedRows: 5, insertId: 9 } });
  const result = await collect(new MysqlDriver(driverOpts), fake.conn, {});
  assert.equal(result.affected, 5);
  assert.equal(result.lastInsertId, 9);
  assert.equal(result.rows.length, 0);
});

test('streamCollect：正常读完不截断、不销毁连接', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, doc: 'ok' }));
  const fake = makeFake(rows, FIELDS);
  const result = await collect(new MysqlDriver(driverOpts), fake.conn, {});
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, false);
  assert.equal(fake.conn.destroyed, 0);
});

test('streamCollect：流错误包装成 DbError 抛出', async () => {
  const fake = makeFake([], FIELDS, { error: Object.assign(new Error('boom'), { code: 'ER_BOOM' }) });
  await assert.rejects(collect(new MysqlDriver(driverOpts), fake.conn, {}), (err: unknown) => {
    assert.ok(err instanceof DbError);
    assert.equal((err as DbError & { code?: string }).code, 'ER_BOOM');
    return true;
  });
});

/** PG 侧同款假连接：streamCollect 内部构造真 pg.Query（EventEmitter），假 client 直接 emit 报文事件。 */
const PG_FIELDS = [
  { name: 'id', dataTypeID: 23 },
  { name: 'doc', dataTypeID: 25 },
];
function makePgFake(rows: unknown[], opts: { error?: Error; rowCount?: number; fields?: typeof PG_FIELDS } = {}) {
  const fields = opts.fields ?? PG_FIELDS;
  const client = {
    destroyed: 0,
    released: 0,
    query(q: { emit: (event: string, ...args: unknown[]) => boolean }) {
      setImmediate(() => {
        for (const row of rows) {
          if (client.destroyed) break;
          q.emit('row', row, { fields });
        }
        if (client.destroyed) return;
        if (opts.error) q.emit('error', opts.error);
        else q.emit('end', { fields, rowCount: opts.rowCount ?? rows.length });
      });
      return q;
    },
    release(destroy?: boolean) {
      if (destroy) this.destroyed += 1;
      else this.released += 1;
    },
  };
  return client;
}
const collectPg = (driver: PostgresDriver, client: unknown, opts: Record<string, unknown>, inTx = false) =>
  (driver as unknown as { streamCollect: (...args: unknown[]) => Promise<any> }).streamCollect(
    client,
    'SELECT * FROM t',
    [],
    opts,
    Date.now(),
    inTx,
    () => {},
  );

test('pg streamCollect：行数上限截断并销毁连接（事务外）', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, doc: 'x' }));
  const client = makePgFake(rows);
  const result = await collectPg(new PostgresDriver(driverOpts), client, { maxRows: 3 });
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(client.destroyed, 1);
  assert.deepEqual(result.columns.map((c: { name: string }) => c.name), ['id', 'doc']);
  assert.deepEqual(result.rows[0], [0, 'x']);
});

test('pg streamCollect：字节上限截断，首行即使单独超预算也保留', async () => {
  const rows = [{ id: 1, doc: 'a'.repeat(65 * 1024 * 1024) }, { id: 2, doc: 'small' }];
  const client = makePgFake(rows);
  const result = await collectPg(new PostgresDriver(driverOpts), client, {});
  assert.equal(result.rows.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(client.destroyed, 1);
});

test('pg streamCollect：事务内截断不销毁连接（剩余行排空，事务继续）', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, doc: 'x' }));
  const client = makePgFake(rows);
  const result = await collectPg(new PostgresDriver(driverOpts), client, { maxRows: 1 }, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(client.destroyed, 0);
});

test('pg streamCollect：DML 无行事件，affected 取 CommandComplete 计数', async () => {
  const client = makePgFake([], { rowCount: 5, fields: [] });
  const result = await collectPg(new PostgresDriver(driverOpts), client, {});
  assert.equal(result.affected, 5);
  assert.equal(result.rows.length, 0);
  assert.equal(result.truncated, false);
});

test('pg streamCollect：零行 SELECT 仍给出列信息，正常读完不销毁连接', async () => {
  const client = makePgFake([]);
  const result = await collectPg(new PostgresDriver(driverOpts), client, {});
  assert.equal(result.rows.length, 0);
  assert.equal(result.truncated, false);
  assert.equal(client.destroyed, 0);
  assert.deepEqual(result.columns.map((c: { name: string; type: string }) => [c.name, c.type]), [
    ['id', 'integer'],
    ['doc', 'text'],
  ]);
});

test('pg streamCollect：查询错误包装成 DbError 抛出（保留 SQLSTATE 供回落判定）', async () => {
  const client = makePgFake([], { error: Object.assign(new Error('boom'), { code: '42701' }) });
  await assert.rejects(collectPg(new PostgresDriver(driverOpts), client, {}), (err: unknown) => {
    assert.ok(err instanceof DbError);
    assert.equal((err as DbError).code, '42701');
    return true;
  });
});

function fakePoolDriver(fake: ReturnType<typeof makeFake>) {
  const driver = new MysqlDriver(driverOpts);
  (driver as unknown as { pools: Map<string, unknown> }).pools.set('', {
    getConnection: async () => fake.conn,
  });
  return driver;
}

test('iterateRows：按字节切批（4MB 预算），全量读完归还连接', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i, doc: 'b'.repeat(1.5 * 1024 * 1024) }));
  const fake = makeFake(rows, FIELDS);
  const batches = [];
  for await (const batch of fakePoolDriver(fake).iterateRows('SELECT * FROM t')) batches.push(batch);
  assert.deepEqual(batches.map((b) => b.rows.length), [3, 3, 1]);
  for (const batch of batches) assert.deepEqual(batch.columns.map((c) => c.name), ['id', 'doc']);
  assert.equal(fake.conn.released, 1);
  assert.equal(fake.conn.destroyed, 0);
});

test('iterateRows：行数辅助上限 2000 行一批', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i, doc: 'x' }));
  const fake = makeFake(rows, FIELDS);
  const sizes = [];
  for await (const batch of fakePoolDriver(fake).iterateRows('SELECT * FROM t')) sizes.push(batch.rows.length);
  assert.deepEqual(sizes, [2000, 500]);
});

test('iterateRows：maxRows 提前停止时销毁连接而不是归还（报文未排空）', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, doc: 'x' }));
  const fake = makeFake(rows, FIELDS);
  let total = 0;
  for await (const batch of fakePoolDriver(fake).iterateRows('SELECT * FROM t', [], { maxRows: 5 })) total += batch.rows.length;
  assert.equal(total, 5);
  assert.equal(fake.conn.destroyed, 1);
  assert.equal(fake.conn.released, 0);
});

test('iterateRows：空表也给出带列信息的空批', async () => {
  const fake = makeFake([], FIELDS);
  const batches = [];
  for await (const batch of fakePoolDriver(fake).iterateRows('SELECT * FROM t')) batches.push(batch);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].rows.length, 0);
  assert.deepEqual(batches[0].columns.map((c) => c.name), ['id', 'doc']);
  assert.equal(fake.conn.released, 1);
});

test('iterateRows：消费方提前退出销毁连接，迟到的查询错误不炸进程', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, doc: 'c'.repeat(1.5 * 1024 * 1024) }));
  const fake = makeFake(rows, FIELDS, { end: false });
  const gen = fakePoolDriver(fake).iterateRows('SELECT * FROM t');
  const first = await gen.next();
  assert.equal(first.value.rows.length, 3);
  await gen.return(undefined);
  assert.equal(fake.conn.destroyed, 1);
  assert.equal(fake.conn.released, 0);
  assert.ok(fake.query.errorHandlers.length > 0, '提前退出后必须挂错误接收者');
  for (const handler of fake.query.errorHandlers) handler(new Error('late failure'));
});

const bigTable: TableInfo = { name: 'big', type: 'table', columns: [], indexes: [], foreignKeys: [] };
const bigRows = (count: number) => Array.from({ length: count }, (_, i) => [i, 'd'.repeat(1024 * 1024)]);
const insertCount = (text: string) => (text.match(/INSERT INTO/g) ?? []).length;

test('备份写表：流式驱动按字节切 INSERT，不再整表单条巨语句', async () => {
  const rows = bigRows(10);
  const driver = {
    engine: 'mysql',
    iterateRows: async function* () {
      yield { columns: [{ name: 'id' }, { name: 'doc' }], rows };
    },
  };
  const writes: string[] = [];
  const rowCount = await writeTableRows(async (text) => void writes.push(text), driver as any, 'mysql', bigTable, 'SELECT * FROM `big`', 'db');
  assert.equal(rowCount, 10);
  assert.deepEqual(writes.map(insertCount), [4, 4, 2]);
  for (const text of writes) assert.ok(text.length < 5 * 1024 * 1024, `单批 ${text.length} 字节，越过 4MB 预算太多`);
});

test('备份写表：非流式驱动（无主键单读）同样按字节切批', async () => {
  const rows = bigRows(10);
  const driver = {
    engine: 'mysql',
    run: async () => ({ columns: [{ name: 'id', type: 'INT' }, { name: 'doc', type: 'TEXT' }], rows, rowCount: rows.length }),
  };
  const writes: string[] = [];
  const rowCount = await writeTableRows(async (text) => void writes.push(text), driver as any, 'mysql', bigTable, 'SELECT * FROM `big`', 'db');
  assert.equal(rowCount, 10);
  assert.deepEqual(writes.map(insertCount), [4, 4, 2]);
});

const toolResult = (data: unknown): ToolResult => ({ ok: true, summary: 's', data, meta: { durationMs: 1 } });

test('capToolResult：小结果原样返回（同一引用，零拷贝）', () => {
  const result = toolResult({ rows: [[1, 'a']], totalRows: 1 });
  assert.equal(capToolResult(result, 2000), result);
});

test('capToolResult：行式结果超预算裁行并标记 truncated，保留其余字段', () => {
  const rows = Array.from({ length: 100 }, () => ['x'.repeat(100)]);
  const capped = capToolResult(toolResult({ rows, totalRows: 100 }), 2000);
  const data = capped.data as { rows: unknown[]; totalRows: number; truncated: boolean };
  assert.ok(data.rows.length > 0 && data.rows.length < 100);
  assert.equal(data.totalRows, 100);
  assert.equal(data.truncated, true);
  assert.equal(capped.meta.truncated, true);
  assert.ok(JSON.stringify(data.rows).length <= 2000);
});

test('capToolResult：单行巨大时截单元格而不是整行丢弃', () => {
  const capped = capToolResult(toolResult({ rows: [['y'.repeat(5000)]] }), 1000);
  const data = capped.data as { rows: unknown[][]; truncated: boolean };
  assert.equal(data.rows.length, 1);
  assert.ok(String(data.rows[0][0]).length <= 520);
  assert.match(String(data.rows[0][0]), /…\(truncated\)$/);
  assert.equal(data.truncated, true);
});

test('capToolResult：超长字符串结果留前缀', () => {
  const capped = capToolResult(toolResult('z'.repeat(5000)), 1000);
  assert.equal(typeof capped.data, 'string');
  assert.match(String(capped.data), /^z{1000}…\(truncated\)$/);
  assert.equal(capped.meta.truncated, true);
});

test('capToolResult：其他对象结果超预算给预览而不是整块落库', () => {
  const capped = capToolResult(toolResult({ note: 'z'.repeat(5000) }), 1000);
  const data = capped.data as { truncated: boolean; preview: string };
  assert.equal(data.truncated, true);
  assert.equal(data.preview.length, 1000);
});

test('capToolArgs：只裁超长字符串值，参数形状与小值不变', () => {
  const args = { sql: 'SELECT 1', content: 'c'.repeat(5000) };
  const capped = capToolArgs(args, 1000) as Record<string, unknown>;
  assert.equal(capped.sql, 'SELECT 1');
  assert.ok(String(capped.content).length <= 270);
  assert.match(String(capped.content), /…\(truncated\)$/);
  const small = { sql: 'SELECT 1' };
  assert.equal(capToolArgs(small, 1000), small);
});

test('端口被占用：ws 转发 error 不再炸进程，server 侧拿到 EADDRINUSE', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = (blocker.address() as AddressInfo).port;
  const home = mkdtempSync(join(tmpdir(), 'aidb-eaddr-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  const gateway = await createGateway({
    home,
    dbPath: join(home, 'aidb.db'),
    secret: 'eaddr-secret',
    token: 'eaddr-token',
    demoDir: join(home, 'demo'),
    exportDir: join(home, 'exports'),
    importDir: join(home, 'imports'),
    backupDir: join(home, 'backups'),
    staticDir: join(home, 'static-missing'),
    port: 0,
    host: '127.0.0.1',
    production: false,
  });
  try {
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      gateway.server.once('error', resolve);
      gateway.server.listen(port, '127.0.0.1');
    });
    assert.equal(err.code, 'EADDRINUSE');
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

/** 迁移路径用假 store/manager/驱动驱动真实 transferData：流式分批、限额、坏行定位、事务回滚、中止清理。 */
const transferTable: TableInfo = {
  name: 't1',
  type: 'table',
  columns: [
    { name: 'id', type: 'INT', nullable: false, defaultValue: null, primaryKey: true, autoIncrement: false },
    { name: 'doc', type: 'LONGTEXT', nullable: true, defaultValue: null, primaryKey: false, autoIncrement: false },
  ],
  indexes: [],
  foreignKeys: [],
};
const mkRows = (count: number, start = 0) => Array.from({ length: count }, (_, i) => [start + i, 'v']);

function transferHarness(opts: { batches: unknown[][][]; streamed?: boolean; failOnCall?: number; tx?: boolean }) {
  const columns = [{ name: 'id', type: 'INT' }, { name: 'doc', type: 'LONGTEXT' }];
  const allRows = opts.batches.flat();
  const history: Array<Record<string, unknown>> = [];
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const queries: string[] = [];
  const tx = { begin: 0, commit: 0, rollback: 0 };
  let closed = false;
  let iterMaxRows: number | undefined;
  let calls = 0;
  const store = {
    getConnection: (id: string) =>
      id === 's'
        ? { id: 's', name: 'src', engine: 'mysql', database: 'src', readonly: false }
        : { id: 't', name: 'dst', engine: 'mysql', database: 'dst', readonly: false },
    addHistory: (item: Record<string, unknown>) => history.push(item),
  };
  const sourceDriver: Record<string, unknown> =
    opts.streamed === false
      ? {}
      : {
          iterateRows: async function* (_sql: string, _params: unknown[], o: { maxRows?: number }) {
            iterMaxRows = o?.maxRows;
            try {
              let sent = 0;
              for (const batch of opts.batches) {
                const take = o?.maxRows ? Math.min(batch.length, o.maxRows - sent) : batch.length;
                if (take <= 0) break;
                yield { columns, rows: batch.slice(0, take) };
                sent += take;
                if (o?.maxRows && sent >= o.maxRows) break;
              }
            } finally {
              closed = true;
            }
          },
        };
  const targetDriver: Record<string, unknown> = opts.tx
    ? {
        beginTransaction: async () => undefined,
        runInTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
      }
    : {};
  const manager = {
    schema: async () => [{ database: 'x', tables: [transferTable] }],
    rawDriver: async (id: string) => (id === 's' ? sourceDriver : targetDriver),
    query: async (_id: string, sql: string) => {
      queries.push(sql);
      if (/^SELECT/i.test(sql)) return { sets: [{ columns, rows: allRows }] };
      return { sets: [] };
    },
    runParams: async (_id: string, sql: string, params: unknown[]) => {
      calls += 1;
      if (opts.failOnCall === calls) throw new Error('写入炸了');
      inserts.push({ sql, params });
      return { sets: [] };
    },
    beginTransaction: async () => {
      tx.begin += 1;
    },
    commitTransaction: async () => {
      tx.commit += 1;
    },
    rollbackTransaction: async () => {
      tx.rollback += 1;
    },
  };
  return {
    store,
    manager,
    history,
    inserts,
    queries,
    tx,
    callCount: () => calls,
    state: () => ({ closed, iterMaxRows }),
    run: (extra: Record<string, unknown> = {}, events?: TransferEvent[]) =>
      transferData(store as any, manager as any, {
        sourceId: 's',
        targetId: 't',
        ...(events ? { onEvent: (event: TransferEvent) => events.push(event) } : {}),
        ...extra,
      }),
  };
}

test('迁移：流式多批逐块写入，补记源端查询历史，进度总数未知时给 0', async () => {
  const h = transferHarness({ batches: [mkRows(250), mkRows(250, 250), mkRows(100, 500)] });
  const events: TransferEvent[] = [];
  const result = await h.run({}, events);
  assert.equal(result.totalRows, 600);
  assert.equal(result.results[0].status, 'ok');
  assert.deepEqual(h.inserts.map((i) => i.params.length / 2), [200, 50, 200, 50, 100]);
  assert.equal(h.history.length, 1);
  assert.equal(h.history[0].status, 'ok');
  assert.equal(h.history[0].rowCount, 600);
  assert.ok(h.state().closed, '源端迭代器必须被关闭');
  const progress = events.filter((e) => e.type === 'progress');
  assert.ok(progress.some((e) => e.type === 'progress' && e.totalRows === 0), '流式读完前总数未知');
  assert.equal(progress.at(-1)!.rows, 600);
});

test('迁移：limit 传到流式读取层，达到上限标记 limitReached', async () => {
  const h = transferHarness({ batches: [mkRows(250), mkRows(250, 250), mkRows(100, 500)] });
  const events: TransferEvent[] = [];
  const result = await h.run({ limit: 300 }, events);
  assert.equal(result.totalRows, 300);
  assert.equal(h.state().iterMaxRows, 300);
  const done = events.find((e) => e.type === 'table-done');
  assert.equal(done?.type === 'table-done' && done.limitReached, true);
});

test('迁移：批写入失败定位行区间，源端迭代器仍被关闭', async () => {
  const h = transferHarness({ batches: [mkRows(250), mkRows(250, 250)], failOnCall: 3 });
  const result = await h.run();
  assert.equal(result.results[0].status, 'error');
  assert.equal(result.results[0].rows, 250);
  assert.match(result.results[0].error ?? '', /251-450/);
  assert.ok(h.state().closed);
  assert.equal(h.history.length, 0, '写入失败不是读取失败，不记错误读取历史');
});

test('迁移：replace + 事务目标，中途失败回滚整表而不是清空一半', async () => {
  const h = transferHarness({ batches: [mkRows(250), mkRows(250, 250)], failOnCall: 2, tx: true });
  const result = await h.run({ mode: 'replace' });
  assert.equal(h.tx.begin, 1);
  assert.equal(h.tx.rollback, 1);
  assert.equal(h.tx.commit, 0);
  assert.equal(result.results[0].truncated, false);
  assert.ok(h.queries.some((sql) => /^DELETE\s+FROM\b/i.test(sql.trim())));
  assert.ok(h.queries.every((sql) => !/\bTRUNCATE\b/i.test(sql)), '事务替换不能使用会隐式提交的 TRUNCATE');
});

test('迁移：replace + 事务目标，成功时提交且标记已清空', async () => {
  const h = transferHarness({ batches: [mkRows(250), mkRows(250, 250)], tx: true });
  const result = await h.run({ mode: 'replace' });
  assert.equal(result.totalRows, 500);
  assert.equal(h.tx.commit, 1);
  assert.equal(h.tx.rollback, 0);
  assert.equal(result.results[0].truncated, true);
});

test('迁移：用户中止抛 TransferAbortedError，源端连接不泄漏', async () => {
  const h = transferHarness({ batches: [mkRows(250), mkRows(250, 250)] });
  await assert.rejects(h.run({ shouldAbort: () => h.callCount() >= 1 }), (err: unknown) => err instanceof TransferAbortedError);
  assert.ok(h.state().closed);
});

test('迁移：AbortSignal 在首批写入后中止，不写下一批且事务目标回滚', async () => {
  const h = transferHarness({ batches: [mkRows(250), mkRows(250, 250)], tx: true });
  const controller = new AbortController();
  const runParams = h.manager.runParams;
  h.manager.runParams = async (...args: Parameters<typeof runParams>) => {
    const result = await runParams(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(h.run({ mode: 'replace', signal: controller.signal }), (err: unknown) => err instanceof TransferAbortedError);
  assert.equal(h.inserts.length, 1, '取消后不能继续第二批 INSERT');
  assert.equal(h.tx.commit, 0);
  assert.equal(h.tx.rollback, 1, 'replace 事务必须回滚，不能留下半张表');
  assert.ok(h.state().closed);
});

test('迁移：非流式驱动走整批读老路径，历史由 manager.query 记录', async () => {
  const h = transferHarness({ batches: [mkRows(600)], streamed: false });
  const events: TransferEvent[] = [];
  const result = await h.run({}, events);
  assert.equal(result.totalRows, 600);
  assert.deepEqual(h.inserts.map((i) => i.params.length / 2), [200, 200, 200]);
  assert.equal(h.history.length, 0);
  const progress = events.filter((e) => e.type === 'progress');
  assert.ok(progress.some((e) => e.type === 'progress' && e.totalRows === 600), '整批读时总数已知');
});