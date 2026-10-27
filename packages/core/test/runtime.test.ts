import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import type { AgentEvent, LlmProvider, ProviderEvent, ProviderRequest, ToolCall, ToolResult } from '../src/agent/types';

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
