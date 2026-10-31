import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import type { AgentEvent, LlmProvider, ProviderEvent, ProviderRequest, ToolCall, ToolResult } from '../src/agent/types';

class ScriptedProvider implements LlmProvider {
  id = 'scripted';
  label = 'Scripted';
  calls = 0;
  requests: ProviderRequest[] = [];
  constructor(private scripts: ProviderEvent[][]) {}
  async *stream(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
    // runtime 会原地追加消息，测试里必须快照，否则三条请求会指向同一份最终消息
    this.requests.push({ ...req, messages: req.messages.map((message) => ({ ...message })) });
    const script = this.scripts[Math.min(this.calls, this.scripts.length - 1)];
    this.calls++;
    for (const event of script) yield event;
  }
}

function result(ok = true, code = 'OK'): ToolResult {
  return ok
    ? { ok: true, summary: 'ok', data: { affected: 1 }, meta: { durationMs: 3 } }
    : { ok: false, summary: 'denied', error: { code, message: code }, meta: { durationMs: 1 } };
}

function writeCall(): ToolCall {
  return { id: 'call_1', name: 'run_sql', args: { connectionId: 'c1', sql: 'UPDATE users SET name = 1 WHERE id = 2' } };
}

const baseInput = {
  sessionId: 's1',
  userText: 'update one user',
  mode: 'ask' as const,
  environment: 'dev' as const,
  connectionReadonly: false,
  history: [],
  context: {},
};

test('runtime executes approved write and continues to a final answer', async () => {
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: writeCall() }, { type: 'usage', tokensIn: 10, tokensOut: 5 }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'updated' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const events: AgentEvent[] = [];
  let executed = 0;
  let approved = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => {
      executed++;
      return result();
    },
    requestApproval: async (payload) => {
      approved++;
      assert.equal(payload.risk, 'write');
      return { decision: 'allow', scope: 'once' };
    },
    emit: (event) => events.push(event),
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
    now: () => Date.now(),
  });
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(outcome.status, 'done');
  assert.equal(executed, 1);
  assert.equal(approved, 1);
  assert.equal(outcome.toolCalls, 1);
  assert.ok(events.some((e) => e.type === 'approval_required'));
  assert.ok(events.some((e) => e.type === 'approval_resolved' && e.decision === 'allow'));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.result.ok));
  assert.equal(outcome.text, 'updated');
});

test('runtime honors approval denial without executing', async () => {
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: writeCall() }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'not executed' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  let executed = 0;
  const events: AgentEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => {
      executed++;
      return result();
    },
    requestApproval: async () => ({ decision: 'deny', scope: 'once' }),
    emit: (event) => events.push(event),
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(outcome.status, 'done');
  assert.equal(executed, 0);
  assert.ok(events.some((e) => e.type === 'tool_result' && e.result.error?.code === 'APPROVAL_DENIED'));
});

test('readonly connections deny writes and never ask for approval', async () => {
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: writeCall() }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'blocked' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  let executed = 0;
  let approvals = 0;
  const events: AgentEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => {
      executed++;
      return result();
    },
    requestApproval: async () => {
      approvals++;
      return { decision: 'allow', scope: 'once' };
    },
    emit: (event) => events.push(event),
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
  const outcome = await runtime.run({ ...baseInput, connectionReadonly: true, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(executed, 0);
  assert.equal(approvals, 0);
  assert.ok(events.some((e) => e.type === 'tool_result' && e.result.error?.code === 'PERMISSION_DENIED'));
  assert.equal(outcome.status, 'done');
});

test('update_plan is applied in-process and emits a plan event', async () => {
  const provider = new ScriptedProvider([
    [
      {
        type: 'tool_call',
        call: {
          id: 'plan_1',
          name: 'update_plan',
          args: { items: [{ text: 'inspect schema', status: 'done' }, { text: 'run query', status: 'doing' }] },
        },
      },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [{ type: 'text', text: 'planning done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const events: AgentEvent[] = [];
  let executed = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => {
      executed++;
      return result();
    },
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: (event) => events.push(event),
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(executed, 0);
  assert.equal(outcome.plan.length, 2);
  assert.equal(outcome.plan[1].status, 'doing');
  const planEvent = events.find((e) => e.type === 'plan');
  assert.ok(planEvent && planEvent.type === 'plan' && planEvent.items.length === 2);
});

test('runtime nudges the model when a plan is not updated after tools run', async () => {
  const query = (id: string): ToolCall => ({ id, name: 'run_sql', args: { connectionId: 'c1', sql: 'SELECT 1' } });
  const provider = new ScriptedProvider([
    [
      {
        type: 'tool_call',
        call: { id: 'plan_1', name: 'update_plan', args: { items: [{ text: 'first', status: 'doing' }, { text: 'second', status: 'todo' }] } },
      },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'tool_call', call: query('q1') },
      { type: 'tool_call', call: query('q2') },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => result(),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => undefined,
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
    now: () => Date.now(),
  });
  await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  // 第三个请求（最终回答前）应能看到附着在工具结果上的计划提醒
  const toolMessages = provider.requests[2].messages.filter((message) => message.role === 'tool');
  assert.ok(toolMessages.some((message) => message.content.includes('[plan reminder]')));
});

test('runtime rescues a tool call the model wrote as XML text', async () => {
  const provider = new ScriptedProvider([
    [
      {
        type: 'text',
        text: '我先查一下结构。\n<function_calls>\n<invoke name="inspect_schema">\n<parameter name="connectionId">c1</parameter>\n</invoke>\n</function_calls>',
      },
      { type: 'done', stopReason: 'end_turn' },
    ],
    [{ type: 'text', text: '一共 3 张表。' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const events: AgentEvent[] = [];
  let executed = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => {
      executed++;
      return result();
    },
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: (event) => events.push(event),
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
    now: () => Date.now(),
  });
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(executed, 1);
  assert.equal(outcome.toolCalls, 1);
  assert.ok(events.some((e) => e.type === 'tool_call' && e.tool === 'inspect_schema'));
  assert.ok(events.some((e) => e.type === 'text_replace'));
  assert.ok(!outcome.text.includes('<invoke'), outcome.text);
  assert.match(outcome.text, /一共 3 张表/);
});

const sqlContext = {
  databases: [
    {
      name: 'ziyou_mall_center',
      tables: [
        {
          name: 't_order',
          type: 'table' as const,
          columns: [
            { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
            { name: 'created_timestamp', type: 'datetime', nullable: false, primaryKey: false },
            { name: 'money', type: 'decimal(12,2)', nullable: true, primaryKey: false },
          ],
        },
      ],
    },
  ],
};

test('SQL failure carries a column-level repair hint into the next model call', async () => {
  const badCall: ToolCall = { id: 'call_bad', name: 'run_sql', args: { connectionId: 'c1', sql: "SELECT created_at FROM t_order WHERE status = 'COMPLETE'" } };
  const fixedCall: ToolCall = { id: 'call_fix', name: 'run_sql', args: { connectionId: 'c1', sql: "SELECT created_timestamp FROM t_order WHERE status = 'COMPLETE'" } };
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: badCall }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'tool_call', call: fixedCall }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: '修正后已执行' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  let executed = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async (call) => {
      executed += 1;
      if (String(call.args.sql).includes('created_at')) {
        return { ok: false, summary: 'SQL 失败', error: { code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'created_at' in 'field list'" }, meta: { durationMs: 2 } };
      }
      return result();
    },
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => undefined,
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
  const outcome = await runtime.run({ ...baseInput, context: sqlContext, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(executed, 2);
  assert.equal(outcome.status, 'done');
  const repair = provider.requests[1]?.messages.filter((message) => message.role === 'tool').at(-1);
  assert.ok(repair, '第二次请求必须带 tool 结果');
  const content = String(repair.content);
  assert.match(content, /"repair"/);
  assert.match(content, /ER_BAD_FIELD_ERROR/);
  assert.match(content, /created_timestamp/);
  assert.match(content, /suggestions/);
  assert.match(content, /created_timestamp \(t_order\)/);
  assert.doesNotMatch(content, /exhausted/);
});

test('SQL repair stops after two attempts and tells the model to stop retrying', async () => {
  const badCall: ToolCall = { id: 'call_bad', name: 'run_sql', args: { connectionId: 'c1', sql: 'SELECT nope FROM t_order' } };
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: badCall }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'tool_call', call: badCall }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'tool_call', call: badCall }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: '这条 SQL 仍然失败' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => ({ ok: false, summary: 'SQL 失败', error: { code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'nope'" }, meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => undefined,
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
  const outcome = await runtime.run({ ...baseInput, context: sqlContext, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(outcome.toolCalls, 3);
  const exhausted = provider.requests[3]?.messages.filter((message) => message.role === 'tool').at(-1);
  assert.ok(exhausted);
  assert.match(String(exhausted.content), /"exhausted":true/);
  assert.match(String(exhausted.content), /不要再重复同一 SQL/);
});


test('runtime accepts command-scoped tools without the global catalog', async () => {
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: { id: 'scoped_1', name: 'compose_report', args: { title: 't' } } }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const compose = {
    name: 'compose_report',
    description: 'submit report',
    risk: 'read' as const,
    inputSchema: { type: 'object' as const, additionalProperties: true, properties: {} },
  };
  let executed = 0;
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    tools: [{ name: compose.name, description: compose.description, inputSchema: compose.inputSchema }],
    getTool: (name) => (name === 'compose_report' ? compose : undefined),
    executeTool: async () => {
      executed++;
      return result();
    },
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => undefined,
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
  const outcome = await runtime.run({ ...baseInput, userText: 'write a report' });
  assert.equal(outcome.status, 'done');
  assert.equal(executed, 1);
  assert.deepEqual(provider.requests[0].tools.map((tool) => tool.name), ['compose_report']);
  const toolMessage = provider.requests[1]?.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool');
  assert.match(toolMessage.content, /"resultRef":"scoped_1"/);
});

test('unknown table gets a nearest-table suggestion', async () => {
  const badCall: ToolCall = { id: 'call_t', name: 'run_sql', args: { connectionId: 'c1', sql: 'SELECT COUNT(*) FROM t_ordr' } };
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: badCall }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: '表名写错了' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => ({ ok: false, summary: 'SQL 失败', error: { code: 'ER_NO_SUCH_TABLE', message: "Table 'ziyou_mall_center.t_ordr' doesn't exist" }, meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => undefined,
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
  await runtime.run({ ...baseInput, context: sqlContext, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  const content = String(provider.requests[1]?.messages.filter((message) => message.role === 'tool').at(-1)?.content);
  assert.match(content, /"suggestions":\["t_order"\]/);
});
