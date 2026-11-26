import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePermission, resolveRisk, toolSignature } from '../src/agent/policy';
import { getTool } from '../src/agent/tools';
import { rescueXmlToolCalls } from '../src/agent/xmlTools';
import { applyLimit, maskLiterals } from '../src/sql/classify';
import { AgentRuntime } from '../src/agent/runtime';
import type { LlmProvider, ProviderEvent, ProviderMessage, ProviderRequest, ToolCall } from '../src/agent/types';

const runSql = (sql: string): ToolCall => ({ id: 'c1', name: 'run_sql', args: { connectionId: 'conn1', sql } });

test('run_sql 预授权签名覆盖风险级/全部表/语句数', () => {
  const insertOrders = runSql('INSERT INTO orders VALUES (1)');
  const insertUsers = runSql('INSERT INTO users VALUES (1)');
  const updateOrders = runSql('UPDATE orders SET a = 1 WHERE id = 2');
  const twoInserts = runSql('INSERT INTO orders VALUES (1); INSERT INTO orders VALUES (2)');
  const sig = toolSignature(insertOrders);
  assert.notEqual(sig, toolSignature(insertUsers));
  assert.notEqual(sig, toolSignature(updateOrders));
  assert.notEqual(sig, toolSignature(twoInserts));
  const ctx = { mode: 'ask' as const, connectionReadonly: false, environment: 'dev' as const, sessionAllowed: new Set([sig]) };
  assert.equal(evaluatePermission('write', ctx, insertOrders), 'allow');
  assert.equal(evaluatePermission('write', ctx, insertUsers), 'ask');
  assert.equal(evaluatePermission('write', ctx, twoInserts), 'ask');
  const mixed = runSql('SELECT * FROM orders; DELETE FROM users WHERE id = 1');
  assert.equal(evaluatePermission('write', ctx, mixed), 'ask');
});

test('预授权作用域包含有效 connectionId/database，省略参数不会变成通配', () => {
  const call: ToolCall = { id: 'c1', name: 'run_sql', args: { sql: 'UPDATE orders SET active = 1' } };
  const scope = { connectionId: 'conn1', database: 'sales' };
  const sig = toolSignature(call, scope);
  assert.equal(sig, toolSignature({ ...call, args: { ...call.args, connectionId: 'conn1', database: 'sales' } }));
  const ctx = { mode: 'ask' as const, connectionReadonly: false, environment: 'dev' as const, ...scope, sessionAllowed: new Set([sig]) };
  assert.equal(evaluatePermission('write', ctx, call), 'allow');
  assert.equal(evaluatePermission('write', { ...ctx, connectionId: 'conn2' }, call), 'ask');
  assert.equal(evaluatePermission('write', { ...ctx, database: 'archive' }, call), 'ask');
  assert.equal(evaluatePermission('write', { ...ctx, connectionId: undefined, database: undefined }, call), 'ask');
  assert.notEqual(sig, toolSignature(call));
  assert.notEqual(sig, toolSignature(call, { connectionId: 'conn1' }));
});

test('SQL 签名规范化空白但保留完整字面量、WHERE 与多语句尾部', () => {
  const base = runSql("SELECT * FROM orders WHERE note = 'a  b' AND active = 1");
  const formatted = runSql("  SELECT  *\n FROM orders\n WHERE note = 'a  b'   AND active = 1;  ");
  assert.equal(toolSignature(base), toolSignature(formatted));
  assert.notEqual(toolSignature(base), toolSignature(runSql("SELECT * FROM orders WHERE note = 'a b' AND active = 1")));
  assert.notEqual(toolSignature(base), toolSignature(runSql("SELECT * FROM orders WHERE note = 'a  b' AND active = 0")));
  const prefix = 'SELECT * FROM orders WHERE note = ';
  assert.notEqual(
    toolSignature(runSql(`${prefix}'${'x'.repeat(80)}'`)),
    toolSignature(runSql(`${prefix}'${'y'.repeat(80)}'`)),
  );
});

test('SQL 行注释保留换行边界，不能复用被注释吞掉不同 WHERE 的审批', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const scoped = runSql(`INSERT INTO orders VALUES (1) -- note${newline} WHERE id = 2`);
    const unscoped = runSql('INSERT INTO orders VALUES (1) -- note WHERE id = 2');
    const sig = toolSignature(scoped);
    assert.notEqual(sig, toolSignature(unscoped), '行注释换行不能再折叠成空格');
    const ctx = { mode: 'ask' as const, connectionReadonly: false, environment: 'dev' as const, sessionAllowed: new Set([sig]) };
    assert.equal(evaluatePermission('write', ctx, unscoped), 'ask');
  }
});

test('建连与探测工具不继承会话库，显式 database 始终参与签名', () => {
  const scope = { connectionId: 'conn1', database: 'sales' };
  for (const name of ['create_connection', 'probe_engine']) {
    const omitted: ToolCall = { id: 'a', name, args: { host: 'db.internal', engine: 'mysql' } };
    const explicit: ToolCall = { id: 'b', name, args: { host: 'db.internal', engine: 'mysql', database: 'sales' } };
    assert.notEqual(toolSignature(omitted, scope), toolSignature(explicit, scope), `${name} 的 database 不能从签名里消失`);
    assert.equal(toolSignature(explicit, scope), toolSignature(explicit, { connectionId: 'other', database: 'archive' }));
    const ctx = { mode: 'ask' as const, connectionReadonly: false, environment: 'dev' as const, ...scope, sessionAllowed: new Set([toolSignature(omitted, scope)]) };
    assert.equal(evaluatePermission('write', ctx, explicit), 'ask');
  }
});

test('Cypher/CQL/AQL/MQL/Redis/MCP 签名稳定覆盖完整参数', () => {
  const scope = { connectionId: 'conn1', database: 'db1' };
  const longQuery = `MATCH (n) WHERE n.id = '${'x'.repeat(80)}' RETURN n`;
  assert.notEqual(
    toolSignature({ id: 'c', name: 'run_cypher', args: { query: longQuery } }, scope),
    toolSignature({ id: 'c', name: 'run_cypher', args: { query: longQuery.replace('x'.repeat(80), 'y'.repeat(80)) } }, scope),
  );
  assert.notEqual(
    toolSignature({ id: 'c', name: 'run_cql', args: { query: 'SELECT * FROM t WHERE id = ?', params: [1] } }, scope),
    toolSignature({ id: 'c', name: 'run_cql', args: { query: 'SELECT * FROM t WHERE id = ?', params: [2] } }, scope),
  );
  assert.notEqual(
    toolSignature({ id: 'c', name: 'run_aql', args: { query: 'FOR d IN t FILTER d.id == @id', params: { id: 1 } } }, scope),
    toolSignature({ id: 'c', name: 'run_aql', args: { query: 'FOR d IN t FILTER d.id == @id', params: { id: 2 } } }, scope),
  );
  assert.notEqual(
    toolSignature({ id: 'm', name: 'run_mql', args: { collection: 'orders', filter: { status: 'paid' } } }, scope),
    toolSignature({ id: 'm', name: 'run_mql', args: { collection: 'orders', filter: { status: 'refunded' } } }, scope),
  );
  assert.notEqual(
    toolSignature({ id: 'r', name: 'run_redis', args: { command: 'GET', args: ['key:a'] } }, scope),
    toolSignature({ id: 'r', name: 'run_redis', args: { command: 'GET', args: ['key:b'] } }, scope),
  );
  const mcpA: ToolCall = { id: 'mcp', name: 'mcp_call', args: { server: 's', tool: 'write', arguments: { path: '/x', options: { b: 2, a: 1 } } } };
  const mcpB: ToolCall = { id: 'mcp', name: 'mcp_call', args: { server: 's', tool: 'write', arguments: { options: { a: 1, b: 2 }, path: '/x' } } };
  const mcpC: ToolCall = { id: 'mcp', name: 'mcp_call', args: { server: 's', tool: 'write', arguments: { path: '/x', options: { a: 1, b: 3 } } } };
  assert.equal(toolSignature(mcpA, scope), toolSignature(mcpB, scope));
  assert.notEqual(toolSignature(mcpA, scope), toolSignature(mcpC, scope));
});

test('所有工具的预授权签名都覆盖完整写入参数与凭据，而非只覆盖目标名', () => {
  const scope = { connectionId: 'conn1', database: 'db1' };
  const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['upsert_document', { collection: 'items', document: { _id: 'a', score: 1 } }, { collection: 'items', document: { _id: 'a', score: 2 } }],
    ['import_documents', { collection: 'items', csv: 'id\n1\n' }, { collection: 'items', csv: 'id\n2\n' }],
    ['create_table', { table: 'items', columns: [{ name: 'id', type: 'int' }] }, { table: 'items', columns: [{ name: 'id', type: 'text' }] }],
    ['alter_table', { table: 'items', operations: [{ op: 'add_column', column: { name: 'a', type: 'int' } }] }, { table: 'items', operations: [{ op: 'add_column', column: { name: 'b', type: 'int' } }] }],
    ['manage_index', { table: 'items', action: 'create', index: { name: 'idx', columns: ['a'] } }, { table: 'items', action: 'create', index: { name: 'idx', columns: ['b'] } }],
    ['write_line_protocol', { lines: 'cpu value=1' }, { lines: 'cpu value=2' }],
    ['create_connection', { host: 'db.internal', password: 'first' }, { host: 'db.internal', password: 'second' }],
    ['probe_engine', { host: 'db.internal', username: 'reader' }, { host: 'db.internal', username: 'writer' }],
  ];
  for (const [name, first, second] of pairs) {
    const a: ToolCall = { id: 'a', name, args: first };
    const b: ToolCall = { id: 'b', name, args: second };
    assert.notEqual(toolSignature(a, scope), toolSignature(b, scope), `${name} 不得复用不同参数的预授权`);
    const ctx = { mode: 'ask' as const, connectionReadonly: false, environment: 'dev' as const, ...scope, sessionAllowed: new Set([toolSignature(a, scope)]) };
    assert.equal(evaluatePermission('write', ctx, b), 'ask');
  }
  const a: ToolCall = { id: 'a', name: 'upsert_document', args: { collection: 'items', document: { a: 1, b: 2 } } };
  const b: ToolCall = { id: 'b', name: 'upsert_document', args: { document: { b: 2, a: 1 }, collection: 'items' } };
  assert.equal(toolSignature(a, scope), toolSignature(b, scope), '仅属性顺序不同必须是同一个已批准操作');
});

test('full 直接放行，生产破坏性操作在非 full 仍审批', () => {
  const call = runSql('DROP TABLE orders');
  assert.equal(evaluatePermission('destructive', { mode: 'full', connectionReadonly: false, environment: 'prod' }, call), 'allow');
  assert.equal(evaluatePermission('destructive', { mode: 'auto', connectionReadonly: false, environment: 'prod', alwaysAllowed: new Set([toolSignature(call)]) }, call), 'ask');
});

test('内置 move_file 覆盖移动按破坏性审批，auto 模式不能自动执行', () => {
  const call: ToolCall = {
    id: 'move-overwrite',
    name: 'mcp_call',
    args: {
      server: 'builtin-filesystem',
      tool: 'move_file',
      arguments: { source: '/workspace/new.txt', destination: '/workspace/existing.txt', overwrite: true },
    },
  };
  const risk = resolveRisk(call, getTool('mcp_call')!);
  assert.equal(risk, 'destructive');
  assert.equal(evaluatePermission(risk, { mode: 'auto', connectionReadonly: false, environment: 'dev' }, call), 'ask');
});

test('Agent 最高风险预检：unknown 在 ask/auto/full 下都拒绝', () => {
  const call = runSql('SELEC 1');
  for (const mode of ['ask', 'auto', 'full'] as const) {
    assert.equal(
      evaluatePermission(resolveRisk(call, getTool('run_sql')!, 'sqlite'), { mode, connectionReadonly: false, environment: 'dev', engine: 'sqlite' }, call),
      'deny',
      mode,
    );
  }
  const mixed = runSql('SELECT 1; EXEC usp_rebuild_indexes');
  assert.equal(
    evaluatePermission(resolveRisk(mixed, getTool('run_sql')!, 'sqlserver'), { mode: 'full', connectionReadonly: false, environment: 'dev', engine: 'sqlserver' }, mixed),
    'deny',
    '一条 unknown 不能让整段脚本落到 ddl 自动放行',
  );
});

test('readonly 模式只允许明确 read，session 与 EXPLAIN ANALYZE 均拒绝', () => {
  const base = { mode: 'readonly' as const, connectionReadonly: false, environment: 'dev' as const, engine: 'postgresql' as const };
  const read = runSql('SELECT 1');
  const session = runSql('SET SESSION group_concat_max_len = 65535');
  const analyzed = runSql('EXPLAIN (ANALYZE) SELECT 1');
  assert.equal(evaluatePermission(resolveRisk(read, getTool('run_sql')!, base.engine), base, read), 'allow');
  assert.equal(evaluatePermission(resolveRisk(session, getTool('run_sql')!, base.engine), base, session), 'deny');
  assert.equal(evaluatePermission(resolveRisk(analyzed, getTool('run_sql')!, base.engine), base, analyzed), 'deny');
});

test('explain_sql 动态风险取原始 SQL，严格输入在审批前拒绝', () => {
  const tool = getTool('explain_sql')!;
  assert.equal(tool.risk, 'dynamic');
  const call = (sql: string): ToolCall => ({ id: 'e', name: 'explain_sql', args: { connectionId: 'c', sql } });
  const ctx = { mode: 'auto' as const, connectionReadonly: false, environment: 'dev' as const, engine: 'postgresql' as const };

  assert.equal(resolveRisk(call('SELECT 1'), tool, ctx.engine), 'read');
  assert.equal(evaluatePermission('read', ctx, call('SELECT 1')), 'allow');
  assert.equal(resolveRisk(call('SELECT 1 FROM DUAL'), tool, 'oracle'), 'write', 'Oracle 会写 PLAN_TABLE_OUTPUT');
  assert.equal(resolveRisk(call('DELETE FROM t'), tool, ctx.engine), 'destructive');
  assert.equal(resolveRisk(call('EXPLAIN (ANALYZE) DELETE FROM t'), tool, ctx.engine), 'destructive');
  assert.equal(resolveRisk(call('SELECT 1; DELETE FROM t'), tool, ctx.engine), 'destructive');

  for (const sql of [
    'SELECT 1; SELECT 2',
    'DELETE FROM t',
    'EXPLAIN (ANALYZE) SELECT 1',
    'EXPLAIN (FORMAT JSON) SELECT 1',
    'SELEC 1',
  ]) {
    assert.equal(evaluatePermission(resolveRisk(call(sql), tool, ctx.engine), ctx, call(sql)), 'deny', sql);
  }
  assert.equal(evaluatePermission('read', { ...ctx, engine: undefined }, call('SELECT 1')), 'deny', '目标方言不明时不能审批 EXPLAIN');
});

test('工具参数中的密码不会随 assistant tool_calls 再次进入模型历史', async () => {
  const provider = new Scripted([
    [{ type: 'tool_call', call: { id: 'secret', name: 'create_connection', args: { name: 'x', engine: 'mysql', host: '127.0.0.1', port: 3306, username: 'root', Password: 'plain-secret' } } }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'denied' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  let executed = false;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'sys',
    executeTool: async () => { executed = true; return { ok: true, summary: 'ok', meta: { durationMs: 1 } }; },
    requestApproval: async () => ({ decision: 'deny', scope: 'once' }),
    emit: () => {},
    generateId: () => 'id',
  });
  await runtime.run({ sessionId: 's', userText: 'create it', mode: 'ask', environment: 'dev', connectionReadonly: false, history: [], context: {}, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(executed, false);
  const second = provider.requests[1];
  assert.ok(second);
  assert.ok(!JSON.stringify(second.messages).includes('plain-secret'));
  assert.ok(JSON.stringify(second.messages).includes('***'));
});

test('runtime 不执行 unknown SQL，也不把它送进 full 模式审批', async () => {
  const call = runSql('SELEC 1');
  const provider = new Scripted([
    [{ type: 'tool_call', call }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'denied' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  let executed = 0;
  let approvals = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'sys',
    executeTool: async () => { executed += 1; return { ok: true, summary: 'should not run', meta: { durationMs: 1 } }; },
    requestApproval: async () => { approvals += 1; return { decision: 'allow', scope: 'once' }; },
    emit: () => {},
    generateId: () => 'id',
  });
  const outcome = await runtime.run({
    sessionId: 's', userText: 'q', mode: 'full', environment: 'dev', connectionReadonly: false,
    connection: { id: 'conn1', name: 'one', engine: 'sqlite', color: 'green', environment: 'dev', groupName: '', database: 'db', readonly: false, createdAt: '', updatedAt: '' },
    history: [], context: {}, sessionAllowed: new Set(), alwaysAllowed: new Set(),
  });
  assert.equal(outcome.status, 'done');
  assert.equal(executed, 0);
  assert.equal(approvals, 0);
});

test('runtime 跨连接 SQL 不沿用会话方言，按保守最高风险审批', async () => {
  // 会话是 PG，目标是 MySQL：PG 会把 /*! ... */ 当普通注释，MySQL 会执行。
  // 若错误沿用 PG 方言，这段脚本会被当成一条 read 并在 auto 下直接执行。
  const call: ToolCall = {
    id: 'cross-engine',
    name: 'run_sql',
    args: { connectionId: 'mysql-target', sql: 'SELECT 1 /*!; DELETE FROM probe */', allowMulti: true },
  };
  const provider = new Scripted([
    [{ type: 'tool_call', call }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'denied' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  let executed = 0;
  let approvals = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'sys',
    executeTool: async () => { executed += 1; return { ok: true, summary: 'should not run', meta: { durationMs: 1 } }; },
    requestApproval: async () => { approvals += 1; return { decision: 'deny', scope: 'once' }; },
    emit: () => {},
    generateId: () => 'id',
  });
  const outcome = await runtime.run({
    sessionId: 's-cross', userText: 'q', mode: 'auto', environment: 'dev', connectionReadonly: false,
    connection: { id: 'pg-session', name: 'pg', engine: 'postgresql', color: 'green', environment: 'dev', groupName: '', database: 'db', readonly: false, createdAt: '', updatedAt: '' },
    history: [], context: {}, sessionAllowed: new Set(), alwaysAllowed: new Set(),
  });
  assert.equal(outcome.status, 'done');
  assert.equal(executed, 0);
  assert.equal(approvals, 1, '保守分类应看到 DELETE 并要求审批，而不是按 read 自动执行');
});

const tag = (body: string) => '<' + body + '>';

test('XML 抢救的参数还原类型：dryRun 不再静默变成真执行', () => {
  const known = (name: string) => name === 'run_sql' || name === 'update_plan';
  const text = [
    tag('invoke name="run_sql"'),
    tag('parameter name="sql"') + 'SELECT 1' + tag('/parameter'),
    tag('parameter name="dryRun"') + 'true' + tag('/parameter'),
    tag('parameter name="allowMulti"') + 'false' + tag('/parameter'),
    tag('parameter name="maxRows"') + '50' + tag('/parameter'),
    tag('/invoke'),
  ].join('\n');
  const rescued = rescueXmlToolCalls(text, known);
  assert.equal(rescued.calls.length, 1);
  const args = rescued.calls[0].args;
  assert.equal(args.sql, 'SELECT 1');
  assert.equal(args.dryRun, true);
  assert.equal(args.allowMulti, false);
  assert.equal(args.maxRows, 50);
});

test('XML 抢救还原 JSON 数组参数', () => {
  const known = (name: string) => name === 'update_plan';
  const items = JSON.stringify([{ text: 'step', status: 'doing' }]);
  const text = tag('invoke name="update_plan"') + tag('parameter name="items"') + items + tag('/parameter') + tag('/invoke');
  const rescued = rescueXmlToolCalls(text, known);
  assert.ok(Array.isArray(rescued.calls[0].args.items));
});

test('掩码与原文等长：注释/双写引号不再让下标错位', () => {
  const samples = [
    '-- leading comment\nSELECT 1',
    '/* block comment */ SELECT 1',
    "SELECT 'it''s fine' FROM t",
    'SELECT "a\\" FROM t',
    "SELECT 'a\\' FROM t",
  ];
  for (const s of samples) {
    assert.equal(maskLiterals(s).length, s.length, s);
    assert.equal(maskLiterals(s, 'mysql').length, s.length, s);
    assert.equal(maskLiterals(s, 'postgresql').length, s.length, s);
  }
});

test('applyLimit 换行追加：尾部行注释不会吞掉 LIMIT', () => {
  const out = applyLimit('SELECT * FROM t -- note', 100);
  assert.ok(out.endsWith('\nLIMIT 100'), out);
  const mssql = applyLimit('SELECT * FROM t -- note', 100, 'sqlserver');
  assert.ok(mssql.includes('\nORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY'), mssql);
});

class Scripted implements LlmProvider {
  id = 'scripted';
  label = 'Scripted';
  requests: ProviderRequest[] = [];
  private n = 0;
  constructor(private scripts: ProviderEvent[][]) {}
  async *stream(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const script = this.scripts[Math.min(this.n, this.scripts.length - 1)];
    this.n++;
    for (const ev of script) yield ev;
  }
}

test('runtime 将 TURN_DEADLINE 中止信号区分为预算到期而非用户停止', async () => {
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('预算到期'), { code: 'TURN_DEADLINE' }));
  const events: Array<Extract<import('../src/agent/types').AgentEvent, { type: 'aborted' }>> = [];
  const provider = new Scripted([[{ type: 'text', text: '不应调用' }, { type: 'done', stopReason: 'end_turn' }]]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'sys',
    executeTool: async () => ({ ok: true, summary: 'ok', meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: (event) => { if (event.type === 'aborted') events.push(event); },
    generateId: () => 'id',
  });
  const outcome = await runtime.run({
    sessionId: 'deadline', userText: 'q', mode: 'readonly', environment: 'dev', connectionReadonly: false,
    history: [], context: {}, sessionAllowed: new Set(), alwaysAllowed: new Set(), signal: controller.signal,
  });
  assert.equal(outcome.status, 'aborted');
  assert.equal(outcome.abortCause, 'deadline');
  assert.equal(provider.requests.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].cause, 'deadline');
  assert.match(events[0].reason, /绝对时间预算/);
});

test('runtime 用会话连接与数据库审批，省略参数沿用会话作用域', async () => {
  const call: ToolCall = { id: 'a', name: 'run_sql', args: { sql: 'UPDATE orders SET active = 1 WHERE id = 1' } };
  const otherDb: ToolCall = { ...call, id: 'b', args: { ...call.args, database: 'archive' } };
  const provider = new Scripted([
    [{ type: 'tool_call', call }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'tool_call', call: { ...call, id: 'a2' } }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'tool_call', call: otherDb }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const approvals: ToolCall[] = [];
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'sys',
    executeTool: async () => ({ ok: true, summary: 'ok', meta: { durationMs: 1 } }),
    requestApproval: async (payload) => { approvals.push(payload.call); return { decision: 'allow', scope: 'session' }; },
    emit: () => {},
    generateId: () => 'id',
  });
  const outcome = await runtime.run({
    sessionId: 's', userText: 'q', mode: 'ask', environment: 'dev', connectionReadonly: false,
    connection: { id: 'conn1', name: 'one', engine: 'mysql', color: 'green', environment: 'dev', groupName: '', database: 'sales', readonly: false, createdAt: '', updatedAt: '' },
    history: [], context: {}, sessionAllowed: new Set(), alwaysAllowed: new Set(),
  });
  assert.equal(outcome.status, 'done');
  assert.equal(approvals.length, 2, '同一会话同一数据库只审批一次，换库必须重新审批');
  assert.equal(approvals[0].args.connectionId, undefined);
  assert.equal(approvals[1].args.database, 'archive');
});

test('极端压缩超过删除轮次上限时也不会保留无宿主 tool', async () => {
  const history: ProviderMessage[] = [{ role: 'user', content: 'old question' }];
  for (let i = 0; i < 201; i++) {
    history.push({ role: 'assistant', content: '', toolCalls: [{ id: `old_${i}`, name: 'run_sql', args: { sql: 'SELECT 1' } }] });
    history.push({ role: 'tool', toolCallId: `old_${i}`, name: 'run_sql', content: '{"ok":true}' });
  }
  const provider = new Scripted([
    [{ type: 'tool_call', call: { id: 'new', name: 'run_sql', args: { sql: 'SELECT 2' } } }, { type: 'usage', tokensIn: 1000, tokensOut: 1 }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'sys',
    executeTool: async () => ({ ok: true, summary: 'ok', meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => {},
    generateId: () => 'id',
    contextTokenBudget: 1,
  });
  const outcome = await runtime.run({
    sessionId: 's', userText: 'q', mode: 'auto', environment: 'dev', connectionReadonly: false,
    history, context: {}, sessionAllowed: new Set(), alwaysAllowed: new Set(),
  });
  assert.equal(outcome.status, 'done');
  const second = provider.requests[1];
  assert.ok(second);
  assert.equal(second.messages.some((message) => message.role === 'tool'), false, '极端兜底不能把末尾 tool 单独留下');
  const hosts = new Set(second.messages.flatMap((message) => message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : []));
  for (const message of second.messages) if (message.role === 'tool') assert.ok(hosts.has(message.toolCallId));
});

test('长回合压缩整组删除 assistant+tool，不产生孤儿 tool 消息', async () => {
  const callA: ToolCall = { id: 'a', name: 'run_sql', args: { connectionId: 'c', sql: 'SELECT 1' } };
  const callB: ToolCall = { id: 'b', name: 'run_sql', args: { connectionId: 'c', sql: 'SELECT 2' } };
  const provider = new Scripted([
    [{ type: 'tool_call', call: callA }, { type: 'tool_call', call: callB }, { type: 'usage', tokensIn: 9000, tokensOut: 20 }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'done' }, { type: 'usage', tokensIn: 100, tokensOut: 5 }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'sys',
    executeTool: async () => ({ ok: true, summary: 'ok', data: { rows: [{ blob: 'x'.repeat(600) }] }, meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => {},
    generateId: () => 'id' + Math.random().toString(36).slice(2),
    contextTokenBudget: 200,
  });
  const outcome = await runtime.run({
    sessionId: 's', userText: 'q', mode: 'auto', environment: 'dev', connectionReadonly: false,
    history: [], context: {}, sessionAllowed: new Set(), alwaysAllowed: new Set(),
  });
  assert.equal(outcome.status, 'done');
  const second = provider.requests[1];
  assert.ok(second, '应有第二次模型调用');
  second.messages.forEach((m, i) => {
    if (m.role === 'tool') {
      const prev = second.messages[i - 1];
      assert.ok(prev && prev.role === 'assistant' && 'toolCalls' in prev && prev.toolCalls?.length, '压缩后出现孤儿 tool 消息');
    }
  });
});