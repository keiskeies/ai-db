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

// ---------- 步数 / 缓存 / 上下文：底部状态条的真实数据来源 ----------

function statsRuntime(
  scripts: ProviderEvent[][],
  events: AgentEvent[],
  extra: { maxSteps?: number; now?: () => number; executeTool?: () => Promise<ToolResult> } = {},
) {
  const provider = new ScriptedProvider(scripts);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: extra.executeTool ?? (async () => result()),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: (event) => events.push(event),
    generateId: () => 'turn_1',
    ...(extra.maxSteps !== undefined ? { maxSteps: extra.maxSteps } : {}),
    ...(extra.now ? { now: extra.now } : {}),
  });
  return { provider, runtime };
}

test('runtime reports step count and a turn_usage summary', async () => {
  const events: AgentEvent[] = [];
  const { runtime } = statsRuntime(
    [
      [{ type: 'tool_call', call: writeCall() }, { type: 'usage', tokensIn: 100, tokensOut: 20 }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text', text: 'done' }, { type: 'usage', tokensIn: 300, tokensOut: 40 }, { type: 'done', stopReason: 'end_turn' }],
    ],
    events,
  );
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  // 两步工具循环 → steps=2，模型调用也是 2 次
  assert.equal(outcome.steps, 2);
  assert.equal(outcome.modelCalls, 2);
  // 单轮回答（无工具）固定是 1 步
  const summary = events.find((e) => e.type === 'turn_usage');
  assert.ok(summary && summary.type === 'turn_usage');
  assert.equal(summary.steps, 2);
  assert.equal(summary.modelCalls, 2);
  assert.equal(summary.tokensIn, 400);
  assert.equal(summary.tokensOut, 60);
  // 上下文占用取最近一次调用的输入，而不是累计输入
  assert.equal(summary.contextTokens, 300);
});

test('runtime leaves cache fields absent when the provider reports none', async () => {
  const events: AgentEvent[] = [];
  const { runtime } = statsRuntime([[{ type: 'text', text: 'hi' }, { type: 'usage', tokensIn: 50, tokensOut: 5 }, { type: 'done', stopReason: 'end_turn' }]], events);
  const outcome = await runtime.run({ ...baseInput });
  assert.equal(outcome.usage.cacheHitTokens, undefined, '不能把「服务商没报缓存」当成 0% 命中');
  const summary = events.find((e) => e.type === 'turn_usage');
  assert.ok(summary && summary.type === 'turn_usage');
  assert.equal(summary.cacheHitTokens, undefined);
});

test('runtime accumulates cache hit/miss across model calls', async () => {
  const events: AgentEvent[] = [];
  const { runtime } = statsRuntime(
    [
      [
        { type: 'tool_call', call: writeCall() },
        { type: 'usage', tokensIn: 100, tokensOut: 10, cacheHitTokens: 80, cacheMissTokens: 20 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', text: 'ok' }, { type: 'usage', tokensIn: 200, tokensOut: 15, cacheHitTokens: 190, cacheMissTokens: 10 }, { type: 'done', stopReason: 'end_turn' }],
    ],
    events,
  );
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(outcome.usage.cacheHitTokens, 270);
  assert.equal(outcome.usage.cacheMissTokens, 30);
  const summary = events.find((e) => e.type === 'turn_usage');
  assert.ok(summary && summary.type === 'turn_usage');
  assert.equal(summary.cacheHitTokens, 270);
  assert.equal(summary.cacheMissTokens, 30);
});

test('runtime measures model-only duration for tok/s', async () => {
  // 可控时钟：每次 now() 前进 100ms，用来验证耗时只统计模型调用段
  let clock = 0;
  const now = () => (clock += 100);
  const events: AgentEvent[] = [];
  const { runtime } = statsRuntime([[{ type: 'text', text: 'hi' }, { type: 'usage', tokensIn: 10, tokensOut: 50 }, { type: 'done', stopReason: 'end_turn' }]], events, { now });
  const outcome = await runtime.run({ ...baseInput });
  assert.ok(outcome.modelDurationMs > 0, 'tok/s 的分母必须被测量');
  const summary = events.find((e) => e.type === 'turn_usage');
  assert.ok(summary && summary.type === 'turn_usage');
  assert.equal(summary.modelDurationMs, outcome.modelDurationMs);
});

test('turn_usage is emitted for aborted and failed turns too', async () => {
  const abortEvents: AgentEvent[] = [];
  const controller = new AbortController();
  controller.abort();
  const { runtime: abortedRuntime } = statsRuntime([[{ type: 'text', text: 'x' }, { type: 'done', stopReason: 'end_turn' }]], abortEvents);
  const abortedOutcome = await abortedRuntime.run({ ...baseInput, signal: controller.signal });
  assert.equal(abortedOutcome.status, 'aborted');
  assert.ok(abortEvents.some((e) => e.type === 'turn_usage'), '中止的回合也要定格状态条');

  const failEvents: AgentEvent[] = [];
  const provider = new ScriptedProvider([[]]);
  provider.stream = async function* () {
    throw Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' });
  };
  const failing = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => result(),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: (event) => failEvents.push(event),
    generateId: () => 'turn_2',
  });
  const failedOutcome = await failing.run({ ...baseInput });
  assert.equal(failedOutcome.status, 'error');
  assert.ok(failEvents.some((e) => e.type === 'turn_usage'), '失败的回合也要定格状态条');
});

// ---------- 回合预算：超时软提醒 / 中止原因区分 ----------
//
// 事故背景：48 万毫秒硬上限到点 abort，runtime 一律写「用户中止」，
// 用户没点停止却看到「已中止」；模型也不知道自己在烧预算，跑到第 30 步还在慢慢读文件。

/** 造一个「每步都调一次工具、永不收敛」的脚本，用来模拟慢慢磨的长回合。 */
function grindingScripts(steps: number): ProviderEvent[][] {
  return Array.from({ length: steps }, (_, i) => [
    { type: 'tool_call', call: { id: `call_${i}`, name: 'run_sql', args: { connectionId: 'c1', sql: 'SELECT 1' } } },
    { type: 'done', stopReason: 'tool_use' },
  ]);
}

function toolMessages(provider: ScriptedProvider, requestIndex: number): string[] {
  return provider.requests[requestIndex]?.messages.filter((message) => message.role === 'tool').map((message) => String(message.content)) ?? [];
}

test('deadlineAt 触发前不追加任何提醒（无截止时间时必须零副作用）', async () => {
  const events: AgentEvent[] = [];
  const { provider, runtime } = statsRuntime(grindingScripts(2), events);
  await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  const toolContents = toolMessages(provider, 1);
  assert.equal(toolContents.length, 1);
  assert.doesNotMatch(toolContents[0], /deadline reminder/, '没传 deadlineAt 就不该有截止提醒');
});

test('过了 deadlineAt 的软提醒阈值后，在工具结果尾部追加带剩余时间与存档指令的提醒', async () => {
  const events: AgentEvent[] = [];
  // 可控时钟：每次 now() 前进 100ms；预算 1000ms，阈值 80% 即 200ms 剩余处提醒
  let clock = 0;
  const now = () => (clock += 100);
  const { provider, runtime } = statsRuntime(grindingScripts(4), events, { now, maxSteps: 4 });
  await runtime.run({
    ...baseInput,
    sessionAllowed: new Set(),
    alwaysAllowed: new Set(),
    deadlineAt: 1_000,
  });
  const allToolContents = [0, 1, 2, 3].flatMap((i) => toolMessages(provider, i + 1)).join('\n');
  assert.match(allToolContents, /\[deadline reminder\]/, '临近截止必须有提醒');
  // 提醒必须带具体剩余时间，而不是「快没时间了」这种不可执行的措辞
  assert.match(allToolContents, /约剩 \d+ 秒/);
  // 提醒必须强制模型存档：先更新计划，再把下一步写进正文
  assert.match(allToolContents, /update_plan/);
  assert.match(allToolContents, /下一步/);
});

test('距离截止还早时不打扰模型', async () => {
  const events: AgentEvent[] = [];
  // 时钟几乎不动，1000ms 预算永远用不完 80%
  const now = () => 0;
  const { provider, runtime } = statsRuntime(grindingScripts(3), events, { now, maxSteps: 3 });
  await runtime.run({
    ...baseInput,
    sessionAllowed: new Set(),
    alwaysAllowed: new Set(),
    deadlineAt: 1_000_000,
  });
  const toolContents = [0, 1, 2].flatMap((i) => toolMessages(provider, i + 1)).join('\n');
  assert.doesNotMatch(toolContents, /\[deadline reminder\]/, '预算充裕时不该刷提醒');
});

test('同一回合里提醒只追加一次，避免每一步都在刷屏', async () => {
  const events: AgentEvent[] = [];
  let clock = 0;
  const now = () => (clock += 100);
  const { provider, runtime } = statsRuntime(grindingScripts(5), events, { now, maxSteps: 5 });
  await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set(), deadlineAt: 500 });
  // 只看最后一轮请求：历史消息会带着旧提醒一起重发，跨请求累加会重复计数
  const lastRequestTools = toolMessages(provider, provider.requests.length - 1).join('\n');
  const hits = lastRequestTools.match(/\[deadline reminder\]/g) ?? [];
  assert.equal(hits.length, 1, '提醒次数必须收敛，否则每步都在烧上下文');
});

test('用户手动中止：reason 与 cause 都如实写 user', async () => {
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  controller.abort();
  const { runtime } = statsRuntime([[{ type: 'text', text: 'x' }, { type: 'done', stopReason: 'end_turn' }]], events);
  const outcome = await runtime.run({ ...baseInput, signal: controller.signal });
  const abortedEvent = events.find((e) => e.type === 'aborted');
  assert.ok(abortedEvent && abortedEvent.type === 'aborted');
  assert.equal(abortedEvent.cause, 'user');
  assert.equal(abortedEvent.reason, '用户中止');
  assert.equal(outcome.abortCause, 'user');
});

test('超时中止：reason 说出真实上限与耗时，绝不再写「用户中止」', async () => {
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  controller.abort();
  let clock = 0;
  const now = () => (clock += 100);
  const { runtime } = statsRuntime([[{ type: 'text', text: 'x' }, { type: 'done', stopReason: 'end_turn' }]], events, { now });
  const outcome = await runtime.run({
    ...baseInput,
    signal: controller.signal,
    abortCause: () => 'timeout',
    turnBudgetMs: 480_000,
  });
  const abortedEvent = events.find((e) => e.type === 'aborted');
  assert.ok(abortedEvent && abortedEvent.type === 'aborted');
  assert.equal(abortedEvent.cause, 'timeout');
  assert.notEqual(abortedEvent.reason, '用户中止', '超时不是用户中止，不能撒谎');
  assert.match(abortedEvent.reason, /上限/, '要说明是达到上限');
  assert.match(abortedEvent.reason, /8 分钟/, '要说出真实上限，8 分钟预算就该是 8 分钟');
  assert.match(abortedEvent.reason, /可继续/, '要告诉用户还能接着跑');
  assert.equal(outcome.abortCause, 'timeout', 'agentHost 事后要靠返回值判断是否写检查点');
});

/** 造一个跑一次 run_sql 就收尾的 runtime，返回喂给模型的那条 tool 消息。 */
async function toolMessageForRows(rows: unknown[], budget: (used: number) => number) {
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: { id: 'q1', name: 'run_sql', args: { connectionId: 'c1', sql: 'SELECT * FROM t' } } }, { type: 'usage', tokensIn: 100, tokensOut: 5 }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => ({ ok: true, summary: `返回 ${rows.length} 行`, data: { rows }, meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => undefined,
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
    resultCharBudget: budget,
  });
  await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  const toolMessage = provider.requests[1].messages.filter((m) => m.role === 'tool').at(-1)!;
  return String(toolMessage.content);
}

const wideRows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i, name: `row-${i}-payload`, note: 'x'.repeat(40) }));

test('工具结果按预算装箱：预算大就多给行，不再卡死 50 行', async () => {
  const roomy = await toolMessageForRows(wideRows(400), () => 120_000);
  assert.ok(!roomy.includes('[truncated]'), '预算够就不该出现截断标记');
  const parsed = JSON.parse(roomy);
  assert.equal(parsed.data.rows.length, 400, '大预算要能一次给满 400 行');
});

test('预算不足时按字符预算裁行，并告诉模型剩多少行怎么续', async () => {
  const rows = wideRows(400);
  const tight = await toolMessageForRows(rows, () => 6_000);
  assert.ok(tight.length <= 6_000, `实际 ${tight.length} 字符，越过预算`);
  assert.match(tight, /\[truncated\]/);
  assert.match(tight, /LIMIT\/OFFSET/, '要给出拿剩下的数据的办法');
  const body = JSON.parse(tight.split('\n[truncated]')[0]);
  assert.ok(body.data.rows.length > 0 && body.data.rows.length < 400);
  assert.equal(body.data.totalRows, 400, '要说清总行数，模型才知道还差多少');
  assert.equal(body.data.rowRange, `1-${body.data.rows.length}`);
  assert.equal(body.meta.truncated, true);
});

test('预算随上下文占用收缩：同一份数据后半程给得更少', async () => {
  const rows = wideRows(400);
  // 同一个 provider 回合里 contextTokens 会增长，这里用两个固定值模拟开局与后半程
  const early = await toolMessageForRows(rows, () => 120_000);
  const late = await toolMessageForRows(rows, () => 4_000);
  const earlyRows = JSON.parse(early).data.rows.length;
  assert.match(late, /\[truncated\]/);
  const lateBody = JSON.parse(late.split('\n[truncated]')[0]);
  assert.ok(lateBody.data.rows.length < earlyRows, '上下文吃紧时给得更少');
  assert.equal(lateBody.data.totalRows, earlyRows || lateBody.data.totalRows, '总行数始终要说清');
});

test('非行式结果超预算时保留前缀而不是整块丢弃', async () => {
  const longDoc = 'AI_DB 说明 '.padEnd(4000, 'x');
  const provider = new ScriptedProvider([
    [{ type: 'tool_call', call: { id: 'r1', name: 'run_sql', args: { connectionId: 'c1', sql: 'SELECT 1' } } }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => ({ ok: true, summary: '读文件', data: longDoc, meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: () => undefined,
    generateId: () => 'id_r',
    resultCharBudget: () => 1_200,
  });
  await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  const msg = String(provider.requests[1].messages.filter((m) => m.role === 'tool').at(-1)!.content);
  assert.ok(msg.length <= 1_200, `实际 ${msg.length}`);
  const body = JSON.parse(msg).data as string;
  assert.match(body, /^AI_DB 说明/, '要留下正文开头');
  assert.match(body, /…\(truncated\)/);
});

test('行式结果里首行超预算时保留该行 JSON 前缀，而不是整行丢弃（GROUP_CONCAT 场景）', async () => {
  // 单行巨大：GROUP_CONCAT 把整表列拼成一行，序列化后远超预算
  const giantRow = [Array.from({ length: 2000 }, (_, i) => `col_${i}=${'v'.repeat(40)}`).join(',')];
  const msg = await toolMessageForRows(giantRow, () => 1_500);
  assert.ok(msg.length <= 1_500, `实际 ${msg.length} 字符，越过预算`);
  assert.match(msg, /row truncated/, '要显式标注这行被截断');
  assert.match(msg, /LIMIT\/OFFSET/, '要给出怎么拿剩余数据的下一步');
  const body = JSON.parse(msg);
  assert.match(String(body.data), /^col_0=/, '要保留该行的 text 前缀（开头几个列）');
});

test('行式结果里首行超预算但空间足够放开头时，内容不是空壳 omitted', async () => {
  const giantRow = [{ name: 't_orders', cols: Array.from({ length: 3000 }, (_, i) => `c${i}`).join(',') }];
  const msg = await toolMessageForRows(giantRow, () => 2_000);
  const body = JSON.parse(msg);
  assert.match(String(body.data), /t_orders/, '要能看到表名');
  assert.match(String(body.data), /c0/, '要能看到列前缀');
});

test('maxSteps=0 表示无步数上限：跑完脚本里所有工具调用，不受步数卡停', async () => {
  const events: AgentEvent[] = [];
  // 5 步工具调用，最后跟一个真正收敛的终局脚本；若 maxSteps 是某个固定值会提前卡停
  const scripts = [
    ...Array.from({ length: 5 }, (_, i) => [
      { type: 'tool_call' as const, call: { id: `call_${i}`, name: 'run_sql', args: { connectionId: 'c1', sql: 'SELECT 1' } } },
      { type: 'done' as const, stopReason: 'tool_use' },
    ]),
    [{ type: 'text' as const, text: 'done' }, { type: 'done' as const, stopReason: 'end_turn' }],
  ];
  const { provider, runtime } = statsRuntime(scripts, events, { maxSteps: 0 });
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  assert.equal(provider.requests.length, 6, '5 个工具脚本 + 1 个最终回答 = 6 次模型调用');
  assert.equal(outcome.steps, 6, '跑完 5 个工具轮 + 1 个终止回答 = 6 步，不受固定步数卡停');
});

test('contextTokenBudget 触发时折叠最早的工具往返并加注说明', async () => {
  const events: AgentEvent[] = [];
  // 每一轮有一个 run_sql 工具调用并上报递增的 tokensIn（contextTokens 用最近一次）；
  // 最后一轮把值抬过阈值，并收敛到一个 end_turn 终局脚本。
  // 注意：压缩触发看两件事——(a) 服务商上报的 contextTokens 越过阈值（窗口压力信号），
  // (b) 本地保存的消息缓冲真的超过该预算（估计算子，单位与本预算一致）。测试用很小的
  // 缓冲预算，让「真的被折叠」这条路径被走到。
  const scripts = [
    ...Array.from({ length: 3 }, (_, i) => [
      { type: 'tool_call' as const, call: { id: `c${i}`, name: 'run_sql', args: { connectionId: 'c1', sql: `SELECT ${i}` } } },
      { type: 'usage' as const, tokensIn: 85_000 + i * 10_000, tokensOut: 10 },
      { type: 'done' as const, stopReason: 'tool_use' },
    ]),
    [{ type: 'text' as const, text: 'done' }, { type: 'done' as const, stopReason: 'end_turn' }],
  ];
  // 缓冲预算 150：contextTokens 任意一轮（≥85k）都远超它，且本地消息缓冲也超过它 → 真折叠
  const provider = new ScriptedProvider(scripts);
  const runtime = new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => ({ ok: true, summary: 'ok', data: {}, meta: { durationMs: 1 } }),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: (event) => events.push(event),
    generateId: () => 'id',
    contextTokenBudget: 150,
  });
  const outcome = await runtime.run({ ...baseInput, sessionAllowed: new Set(), alwaysAllowed: new Set() });
  // 压缩会在某一步把一条 user 占位说明插进上下文（见 compactMessages）
  const anyCompacted = events.some((e) => e.type === 'text_delta' && /上下文已随预算压缩/.test(e.text));
  assert.equal(anyCompacted, true, '超过预算后应触发中途压缩');
  assert.ok(outcome.steps >= 4, '压缩后回合仍继续跑完后续步骤，而不是被截停');
});
