import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePermission, toolSignature } from '../src/agent/policy';
import { rescueXmlToolCalls } from '../src/agent/xmlTools';
import { applyLimit, maskLiterals } from '../src/sql/classify';
import { AgentRuntime } from '../src/agent/runtime';
import type { LlmProvider, ProviderEvent, ProviderRequest, ToolCall } from '../src/agent/types';

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