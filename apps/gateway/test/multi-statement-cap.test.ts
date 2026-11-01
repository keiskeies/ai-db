import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, describeCall, getTool, resolveRisk, type AppSettings } from '@aidb/core';
import { ConnectionManager } from '../src/manager';
import { Store } from '../src/store';
import { ToolExecutor } from '../src/executor';

/**
 * 多语句闸门的契约：拦「规模」，不拦「批量」。
 *
 * 依据是本机真实历史：2089 条 SQL 里有 22 段多语句脚本，旧闸门（含写就拒）拦下 18 段，
 * 而这 18 段全是正当工作——`CREATE TABLE` + `CREATE INDEX` 建表序列，以及 18 条
 * `ALTER TABLE … COMMENT`（补表注释的典型形状）。误报率 100%，且每次误报都要模型
 * 重试一整步。真正的权限边界是 resolveRisk（取全脚本最高风险）+ evaluatePermission，
 * 与语句条数无关，所以闸门改成按条数封顶。
 */
const MAX_SCRIPT_STATEMENTS = 200;

function setup(overrides: Partial<AppSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-multi-cap-'));
  const file = join(dir, 'cap.db');
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)');
  seed.exec("INSERT INTO probe VALUES (1, 'seed')");
  seed.close();
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  const config = {
    version: '0',
    home: dir,
    dbPath: join(dir, 'aidb.db'),
    host: '127.0.0.1',
    port: 0,
    token: 't',
    secret: 'secret',
    demoDir: join(dir, 'demo'),
    exportDir: join(dir, 'exports'),
    importDir: join(dir, 'imports'),
    backupDir: join(dir, 'backups'),
    attachmentDir: join(dir, 'attachments'),
    staticDir: join(dir, 'static'),
    production: false,
  };
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const manager = new ConnectionManager(store, config, () => settings);
  const executor = new ToolExecutor(store, manager, config, () => settings);
  const conn = store.createConnection({ name: 'cap', engine: 'sqlite', database: file });
  const readonlyConn = store.createConnection({ name: 'cap-ro', engine: 'sqlite', database: file, readonly: true });
  const runSql = (connectionId: string, args: Record<string, unknown>, id = 'call-1') =>
    executor.execute({ id, name: 'run_sql', args: { connectionId, ...args } }, { sessionId: 'sess-1', connectionId });
  return {
    manager,
    executor,
    conn,
    readonlyConn,
    runSql,
    cleanup: async () => {
      await manager.closeAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 特性测试：真实历史里被误拦的两种形状，缺省参数下必须能跑通。
 * ------------------------------------------------------------------ */

test('建表脚本（CREATE TABLE + CREATE INDEX）不传 allowMulti 也一次执行', async () => {
  const env = setup();
  try {
    // 这是历史里出现最多的形状：ORM 导出的一张表连同它的索引。
    const script = [
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, buyer TEXT);',
      'CREATE INDEX idx_orders_buyer ON orders (buyer);',
      'CREATE UNIQUE INDEX uk_orders_buyer ON orders (buyer, id);',
    ].join('\n');

    const result = await env.runSql(env.conn.id, { sql: script });
    assert.equal(result.ok, true, `建表脚本应一次执行成功：${result.error?.message ?? ''}`);
    const data = result.data as { sets?: unknown[]; multiStatement?: boolean };
    assert.equal(data.sets?.length, 3, '三条语句都应执行并逐条返回结果');
    assert.equal(data.multiStatement, true, '批量执行要在结果里标明，UI 与审计才看得见');

    const check = await env.manager.query(env.conn.id, 'SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_orders_buyer\'', {
      autoLimit: false,
      actor: 'agent',
    });
    assert.equal(check.sets[0].rows.length, 1, '索引必须真的建出来');
  } finally {
    await env.cleanup();
  }
});

test('同一张表 18 条 ADD COLUMN 不传 allowMulti 也一次执行（补注释任务的形状）', async () => {
  const env = setup();
  try {
    // kbook 补注释任务的真实形状：一次脚本里对同一张表做十几次列变更。
    // 旧闸门把它整段拦下，模型只能退回逐列改，一步一个往返，把回合预算烧光。
    await env.manager.query(env.conn.id, 'CREATE TABLE wide (id INTEGER PRIMARY KEY)', { autoLimit: false, actor: 'agent' });
    const alters = Array.from({ length: 18 }, (_, i) => `ALTER TABLE wide ADD COLUMN c${i} TEXT;`);
    const result = await env.runSql(env.conn.id, { sql: alters.join('\n') });
    assert.equal(result.ok, true, `18 条列变更应一次执行成功：${result.error?.message ?? ''}`);
    assert.equal((result.data as { sets?: unknown[] }).sets?.length, 18);

    const cols = await env.manager.query(env.conn.id, 'PRAGMA table_info(wide)', { autoLimit: false, actor: 'agent' });
    assert.equal(cols.sets[0].rows.length, 19, 'table_info 每列一行：id + 18 个新列 = 19 行');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 上限本身：规模失控的脚本仍然要被挡，且要给出可照抄的出路。
 * ------------------------------------------------------------------ */

test('超过上限的脚本默认被拒，错误码是 SCRIPT_TOO_LARGE 且 hint 给出分批与 allowMulti', async () => {
  const env = setup();
  try {
    const huge = Array.from({ length: MAX_SCRIPT_STATEMENTS + 1 }, () => 'SELECT 1').join(';');
    const denied = await env.runSql(env.conn.id, { sql: huge });
    assert.equal(denied.ok, false, '超过上限的脚本默认不应执行');
    assert.equal(denied.error?.code, 'SCRIPT_TOO_LARGE', `期望 SCRIPT_TOO_LARGE，实际 ${denied.error?.code}`);

    const hint = String(denied.error?.hint ?? '');
    assert.match(hint, /allowMulti/, 'hint 要告诉模型新增的整段执行参数');
    assert.match(hint, /允许多语句/, '既有全局开关的措辞不能被改掉');
    assert.match(hint, /非原子/, '必须提醒整段脚本非原子，中途失败时前面的语句已生效');
  } finally {
    await env.cleanup();
  }
});

test('显式 allowMulti 可越过上限整段执行', async () => {
  const env = setup();
  try {
    const huge = Array.from({ length: MAX_SCRIPT_STATEMENTS + 1 }, () => 'SELECT 1 AS a').join(';');
    const result = await env.runSql(env.conn.id, { sql: huge, allowMulti: true });
    assert.equal(result.ok, true, result.error?.message ?? '');
    assert.equal((result.data as { sets?: unknown[] }).sets?.length, MAX_SCRIPT_STATEMENTS + 1);
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 锁定测试：放宽闸门不得放宽权限。这些用例实现前后都必须是绿的。
 * ------------------------------------------------------------------ */

test('破坏性语句的风险等级与语句条数无关，混在脚本里照样判 destructive', () => {
  const tool = getTool('run_sql')!;
  const script = "ALTER TABLE probe ADD COLUMN a TEXT;\nDROP TABLE probe;";
  const risk = resolveRisk({ id: '1', name: 'run_sql', args: { connectionId: 'c', sql: script } }, tool);
  assert.equal(risk, 'destructive', 'DROP 混在脚本里必须仍是 destructive');
  assert.equal(
    resolveRisk({ id: '2', name: 'run_sql', args: { connectionId: 'c', sql: script, allowMulti: true } }, tool),
    risk,
    '批量参数不得降低风险等级',
  );
});

test('只读连接上批量写脚本仍被 READONLY 拒绝', async () => {
  const env = setup();
  try {
    const script = "INSERT INTO probe VALUES (2,'x');\nINSERT INTO probe VALUES (3,'y');";
    const result = await env.runSql(env.readonlyConn.id, { sql: script, allowMulti: true });
    assert.equal(result.ok, false, '只读连接不允许执行写脚本');
    assert.equal(result.error?.code, 'READONLY', `只读闸门必须照旧生效，实际 ${result.error?.code}`);
  } finally {
    await env.cleanup();
  }
});

test('审批摘要带上语句条数，长脚本的规模在弹窗里看得见', () => {
  const script = Array.from({ length: 18 }, (_, i) => `ALTER TABLE wide ADD COLUMN c${i} TEXT;`).join('\n');
  const described = describeCall({ id: '1', name: 'run_sql', args: { connectionId: 'c', sql: script } });
  assert.match(described.summary, /18\s*条语句/, `摘要要能看出这是 18 条语句的一段脚本，实际：${described.summary}`);
  assert.equal(described.sql, script, '完整 SQL 仍要原样带给审批与审计');
});