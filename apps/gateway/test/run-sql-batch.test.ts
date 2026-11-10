import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AgentRuntime,
  DEFAULT_SETTINGS,
  classifySql,
  countStatements,
  evaluatePermission,
  getTool,
  resolveRisk,
  type AgentEvent,
  type AppSettings,
  type LlmProvider,
  type ProviderEvent,
  type ProviderRequest,
  type ToolCall,
  type ToolResult,
} from '@aidb/core';
import { ConnectionManager } from '../src/manager';
import { Store } from '../src/store';
import { ToolExecutor } from '../src/executor';

/** 批量 DDL 脚本：SQLite 没有 MODIFY COLUMN，用 CREATE + ADD COLUMN 表达同一件事。 */
const DDL_SCRIPT = [
  'CREATE TABLE audit_a (id INTEGER PRIMARY KEY, note TEXT);',
  'ALTER TABLE audit_a ADD COLUMN extra TEXT;',
  'INSERT INTO audit_a VALUES (1, \'x\', \'y\');',
].join('\n');

function setup(overrides: Partial<AppSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-run-sql-batch-'));
  const file = join(dir, 'batch.db');
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
  const conn = store.createConnection({ name: 'batch', engine: 'sqlite', database: file });
  const readonlyConn = store.createConnection({ name: 'batch-ro', engine: 'sqlite', database: file, readonly: true });
  const runSql = (connectionId: string, args: Record<string, unknown>, id = 'call-1') =>
    executor.execute(
      { id, name: 'run_sql', args: { connectionId, ...args } },
      { sessionId: 'sess-1', connectionId },
    );
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
 * 特性测试：这些用例在实现之前必须红，实现之后转绿。
 * ------------------------------------------------------------------ */

test('run_sql 缺省即可执行上限内的多条 DDL，结果标明是批量执行', async () => {
  const env = setup();
  try {
    // 缺省（不传 allowMulti）就该跑通：建表序列是常态工作，不是危险操作。
    // 权限由 resolveRisk 按整段最高风险判定，与语句条数无关。
    const result = await env.runSql(env.conn.id, { sql: DDL_SCRIPT });
    assert.equal(result.ok, true, `批量 DDL 应一次执行成功：${result.error?.message ?? ''}`);
    const data = result.data as { sets?: unknown[]; multiStatement?: boolean };
    assert.equal(data.sets?.length, 3, '三条语句都应执行并逐条返回结果');
    assert.equal(data.multiStatement, true, '结果需要标明这是一次批量执行，UI 与审计才看得见');

    const counted = await env.manager.query(env.conn.id, 'SELECT COUNT(*) AS n FROM audit_a', { actor: 'agent' });
    assert.equal(Number(counted.sets[0].rows[0][0]), 1, '写语句的副作用应真实落库');

    // 显式传 allowMulti 依旧有效，行为不因缺省放行而改变。
    const explicit = await env.runSql(env.conn.id, { sql: 'ALTER TABLE audit_a ADD COLUMN more TEXT;', allowMulti: true }, 'call-2');
    assert.equal(explicit.ok, true, explicit.error?.message ?? '');
  } finally {
    await env.cleanup();
  }
});

test('只读连接上批量写脚本仍被 READONLY 拒绝，而不是被多语句判定抢先', async () => {
  const env = setup();
  try {
    const result = await env.runSql(env.readonlyConn.id, { sql: DDL_SCRIPT, allowMulti: true });
    assert.equal(result.ok, false, '只读连接不允许执行写脚本');
    assert.equal(
      result.error?.code,
      'READONLY',
      `只读连接必须先撞只读闸门；拿到 ${result.error?.code} 说明批量参数把只读保护顶掉了`,
    );
  } finally {
    await env.cleanup();
  }
});

test('超过上限的脚本给出 SCRIPT_TOO_LARGE 与可照抄的出路', async () => {
  const env = setup();
  try {
    const huge = Array.from({ length: 201 }, () => 'SELECT 1 AS a').join('; ');
    const denied = await env.runSql(env.conn.id, { sql: huge });
    assert.equal(denied.error?.code, 'SCRIPT_TOO_LARGE', `实际拿到 ${denied.error?.code}`);
    const hint = String(denied.error?.hint ?? '');
    assert.match(hint, /allowMulti/, 'hint 必须告诉模型新增的整段执行参数名');
    assert.match(hint, /允许多语句/, '全局开关的既有措辞不能被改掉');
    assert.match(hint, /非原子/, '必须提醒整段脚本非原子');
  } finally {
    await env.cleanup();
  }
});

test('批量 DDL 前面带注释时仍然失效 schema 缓存', async () => {
  const env = setup();
  try {
    // 先填充缓存，否则「缓存没失效」这件事根本观察不到。
    const before = await env.manager.schema(env.conn.id);
    assert.equal(before.flatMap((s) => s.tables).some((t) => t.name === 'audit_c'), false);

    // 行首注释是模型写脚本的常态；旧实现用 /^\s*(create|alter|drop|rename)/ 判断，
    // 注释开头就匹配不上，于是建完表 schema 缓存还是旧的。
    const script = "-- 给审计表补结构\nCREATE TABLE audit_c (id INTEGER PRIMARY KEY);";
    const result = await env.runSql(env.conn.id, { sql: script, allowMulti: true });
    assert.equal(result.ok, true, result.error?.message ?? '');

    const after = await env.manager.schema(env.conn.id);
    assert.equal(
      after.flatMap((s) => s.tables).some((t) => t.name === 'audit_c'),
      true,
      '批量 DDL 后必须失效 schema 缓存，否则下一步 inspect_schema 看到的是旧结构',
    );
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 锁定测试：这些用例在实现前后都必须绿。它们锁的是「不允许变」的既有行为，
 * 故意写成绿→绿——破坏性语句的审批判定不能被批量参数绕过。
 * ------------------------------------------------------------------ */

test('resolveRisk 对 run_sql 只看 sql，批量参数不改变破坏性判定', () => {
  const tool = getTool('run_sql')!;
  const destructiveScript = "ALTER TABLE probe ADD COLUMN a TEXT;\nDROP TABLE probe;";
  const plain = resolveRisk({ id: '1', name: 'run_sql', args: { connectionId: 'c', sql: destructiveScript } }, tool);
  const batched = resolveRisk(
    { id: '2', name: 'run_sql', args: { connectionId: 'c', sql: destructiveScript, allowMulti: true } },
    tool,
  );
  assert.equal(plain, 'destructive');
  assert.equal(batched, plain, '批量参数不得降低风险等级：DROP 混在脚本里仍是 destructive');

  const ddlScript = "ALTER TABLE probe ADD COLUMN b TEXT;\nALTER TABLE probe ADD COLUMN c TEXT;";
  assert.equal(resolveRisk({ id: '3', name: 'run_sql', args: { connectionId: 'c', sql: ddlScript } }, tool), 'ddl');
  assert.equal(
    resolveRisk({ id: '4', name: 'run_sql', args: { connectionId: 'c', sql: ddlScript, allowMulti: true } }, tool),
    'ddl',
  );

  // 真正危险的是「另开一条不入 sql 字段的 SQL 通道」：如果批量参数能承载 SQL，
  // DROP 就会退化成默认的 ddl 并自动放行。这里锁死参数形态只允许布尔。
  const schema = (tool.inputSchema.properties as Record<string, { type?: string }>).allowMulti;
  assert.equal(schema?.type, 'boolean', '批量参数只能是布尔标记，不能承载 SQL 文本');
});

test('evaluatePermission 对批量破坏性脚本仍要求审批', () => {
  const base = { connectionReadonly: false, environment: 'dev' as const };
  // auto 模式下 destructive 必须问，ddl 才自动放行。
  assert.equal(evaluatePermission('destructive', { ...base, mode: 'auto' }), 'ask');
  assert.equal(evaluatePermission('ddl', { ...base, mode: 'auto' }), 'allow');
  // 非 full 档下 prod 的破坏性动作恒为 ask；full 是全权委托，不再打断。
  assert.equal(evaluatePermission('destructive', { ...base, mode: 'auto', environment: 'prod' as const }), 'ask');
  assert.equal(evaluatePermission('destructive', { ...base, mode: 'ask', environment: 'prod' as const }), 'ask');
  assert.equal(evaluatePermission('destructive', { ...base, mode: 'full', environment: 'prod' as const }), 'allow');
  // 只读连接与只读模式仍然直接拒绝，与批量与否无关。
  assert.equal(evaluatePermission('ddl', { ...base, mode: 'auto', connectionReadonly: true }), 'deny');
  assert.equal(evaluatePermission('ddl', { ...base, mode: 'readonly' }), 'deny');
});

test('只读连接上批量写脚本在管理器层同样被 READONLY 拒绝', async () => {
  const env = setup();
  try {
    // 绕过工具层直接调 manager：即使调用方自己把 allowMulti 打开，
    // 只读判定也必须逐条拦住脚本里的写语句。这两层各有一道闸，缺一层都可能被绕过。
    await assert.rejects(
      () =>
        env.manager.query(env.readonlyConn.id, DDL_SCRIPT, {
          allowMulti: true,
          autoLimit: false,
          actor: 'agent',
        }),
      (err: any) => {
        assert.equal(err.code, 'READONLY', '管理器层必须自己拦只读写脚本，不能只依赖工具层的判断');
        return true;
      },
    );

    // 只读连接上的只读多语句脚本不受影响。
    const reads = await env.manager.query(env.readonlyConn.id, 'SELECT 1 AS a; SELECT 2 AS b;', {
      allowMulti: true,
      autoLimit: false,
      actor: 'agent',
    });
    assert.equal(reads.sets.length, 2, '只读脚本不该被只读保护误伤');
  } finally {
    await env.cleanup();
  }
});

test('permissionMode: readonly 下批量破坏性脚本在 runtime 层被直接拒绝，不会请求审批', async () => {
  // 这是用户可以「一票否决」的路径：模型再声明 allowMulti 也没用，
  // evaluatePermission 在 readonly 模式下对非 read 一律 deny，连审批弹窗都不弹。
  const script = "ALTER TABLE probe ADD COLUMN a TEXT;\nDROP TABLE probe;";
  const call: ToolCall = { id: 'call_1', name: 'run_sql', args: { connectionId: 'c1', sql: script, allowMulti: true } };

  class ScriptedProvider implements LlmProvider {
    id = 'scripted';
    label = 'Scripted';
    calls = 0;
    constructor(private scripts: ProviderEvent[][]) {}
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      const script = this.scripts[Math.min(this.calls, this.scripts.length - 1)];
      this.calls++;
      for (const event of script) yield event;
    }
  }

  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: '拒绝了' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const events: AgentEvent[] = [];
  let executed = 0;
  let approvals = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async (): Promise<ToolResult> => {
      executed++;
      return { ok: true, summary: 'should not run', meta: { durationMs: 1 } };
    },
    requestApproval: async () => {
      approvals++;
      return { decision: 'allow', scope: 'once' };
    },
    emit: (event) => events.push(event),
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
    now: () => Date.now(),
  });

  const outcome = await runtime.run({
    sessionId: 's-ro',
    userText: '删掉 probe 表',
    mode: 'readonly',
    environment: 'dev',
    connectionReadonly: false,
    history: [],
    context: {},
    sessionAllowed: new Set(),
    alwaysAllowed: new Set(),
  });

  assert.equal(executed, 0, 'readonly 模式下批量脚本不得执行');
  assert.equal(approvals, 0, 'readonly 模式是直接拒绝，不该走审批');
  assert.equal(outcome.status, 'done');
  const denied = events.find(
    (e) => e.type === 'tool_result' && !e.result.ok && e.result.error?.code?.includes('PERMISSION'),
  );
  assert.ok(denied, '必须回一条权限拒绝的 tool_result 给模型');

  // 反证：同一条调用在 auto 模式下会走审批——说明 deny 来自 readonly 模式，不是别的原因。
  const provider2 = new ScriptedProvider([
    [{ type: 'tool_call', call }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  let approvalsAuto = 0;
  const runtimeAuto = new AgentRuntime({
    provider: provider2,
    buildSystem: () => 'system',
    executeTool: async (): Promise<ToolResult> => ({ ok: true, summary: 'run', meta: { durationMs: 1 } }),
    requestApproval: async () => {
      approvalsAuto++;
      return { decision: 'deny', scope: 'once' };
    },
    emit: () => {},
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
    now: () => Date.now(),
  });
  await runtimeAuto.run({
    sessionId: 's-auto',
    userText: '删掉 probe 表',
    mode: 'auto',
    environment: 'dev',
    connectionReadonly: false,
    history: [],
    context: {},
    sessionAllowed: new Set(),
    alwaysAllowed: new Set(),
  });
  assert.equal(approvalsAuto, 1, 'auto 模式下破坏性批量脚本必须弹审批');
});

test('全局开关已开启时，不传批量参数也能整段执行（行为不变）', async () => {
  const env = setup({ allowMultiStatement: true });
  try {
    const result = await env.runSql(env.conn.id, { sql: DDL_SCRIPT });
    assert.equal(result.ok, true, result.error?.message ?? '');
  } finally {
    await env.cleanup();
  }
});

test('单条 ALTER 多列 MODIFY COLUMN 只算一条语句，不会被多语句闸门拦下', () => {
  // 真实 MySQL 上验证过：下面这条单语句执行成功，a、b 两个字段的注释都正确写入。
  // 它是本次场景的首选出路——一次调用改完整张表的所有列。
  const oneAlter =
    "ALTER TABLE t MODIFY COLUMN a int NOT NULL COMMENT '甲', MODIFY COLUMN b varchar(10) NULL COMMENT '乙'";
  assert.equal(countStatements(oneAlter), 1, '多列 ALTER 是一条语句，逗号不是语句分隔符');
  const classification = classifySql(oneAlter);
  assert.equal(classification.statements.length, 1);
  assert.equal(classification.risk, 'ddl');
});
