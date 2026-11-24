import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { ProviderError } from '../src/agent/providers/common';
import { isUnfinishedStop } from '../src/agent/types';
import type { AgentEvent, LlmProvider, ProviderEvent, ProviderRequest, ToolResult } from '../src/agent/types';

// C7：429/5xx/网络瞬态最多重试 2 次（退避 1s/3s，429 尊重 Retry-After），
// 尊重 abort；已经吐过字节就不重试。退避用真实计时验证量级。

interface Attempt {
  events?: ProviderEvent[];
  error?: Error;
}

class FlakyProvider implements LlmProvider {
  id = 'flaky';
  label = 'Flaky';
  calls = 0;
  constructor(private script: Attempt[]) {}
  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const attempt = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    for (const ev of attempt.events ?? []) yield ev;
    if (attempt.error) throw attempt.error;
  }
}

function okResult(): ToolResult {
  return { ok: true, summary: 'ok', data: {}, meta: { durationMs: 1 } };
}

function makeRuntime(provider: LlmProvider, events: AgentEvent[] = []): AgentRuntime {
  return new AgentRuntime({
    provider,
    buildSystem: () => 'system',
    executeTool: async () => okResult(),
    requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
    emit: (event) => events.push(event),
    generateId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
  });
}

const baseInput = {
  sessionId: 's1',
  userText: 'hi',
  mode: 'auto' as const,
  environment: 'dev' as const,
  connectionReadonly: false,
  history: [],
  context: {},
};

const rateLimit = (retryAfterMs?: number): ProviderError =>
  new ProviderError('模型接口返回 429：rate limited', { code: 'PROVIDER_RATE_LIMIT', status: 429, retryable: true, retryAfterMs });
const serverError = (): ProviderError =>
  new ProviderError('模型接口返回 503：unavailable', { code: 'PROVIDER_HTTP', status: 503, retryable: true });
const doneText = (text: string): ProviderEvent[] => [{ type: 'text', text }, { type: 'done', stopReason: 'end_turn' }];

test('429 后自动重试成功：modelCalls 计入重试，退避约 1s', async () => {
  const provider = new FlakyProvider([{ error: rateLimit() }, { events: doneText(' recovered') }]);
  const events: AgentEvent[] = [];
  const started = Date.now();
  const outcome = await makeRuntime(provider, events).run(baseInput);
  const elapsed = Date.now() - started;
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.text, 'recovered');
  assert.equal(provider.calls, 2);
  assert.equal(outcome.modelCalls, 2);
  assert.ok(elapsed >= 950, `第一次退避应约 1s，实际 ${elapsed}ms`);
  assert.ok(elapsed < 2500, '不该退避更久');
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text.includes('自动重试')));
});

test('429 尊重 Retry-After：大于默认退避时按服务商给的等', async () => {
  const provider = new FlakyProvider([{ error: rateLimit(1600) }, { events: doneText('ok') }]);
  const started = Date.now();
  const outcome = await makeRuntime(provider).run(baseInput);
  const elapsed = Date.now() - started;
  assert.equal(outcome.status, 'done');
  assert.ok(elapsed >= 1550, `Retry-After=1.6s 必须被尊重，实际 ${elapsed}ms`);
});

test('5xx 连续两次失败后第三次成功：退避 1s + 3s', async () => {
  const provider = new FlakyProvider([{ error: serverError() }, { error: serverError() }, { events: doneText('third time') }]);
  const started = Date.now();
  const outcome = await makeRuntime(provider).run(baseInput);
  const elapsed = Date.now() - started;
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.text, 'third time');
  assert.equal(provider.calls, 3);
  assert.equal(outcome.modelCalls, 3);
  assert.ok(elapsed >= 3900, `两次退避合计应约 4s，实际 ${elapsed}ms`);
});

test('最多重试 2 次：第三次仍失败就如实报错', async () => {
  const provider = new FlakyProvider([{ error: serverError() }]);
  const outcome = await makeRuntime(provider).run(baseInput);
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error?.code, 'PROVIDER_HTTP');
  assert.equal(provider.calls, 3, '1 次原始调用 + 2 次重试');
  assert.equal(outcome.modelCalls, 3);
});

test('已经吐过字节就不重试：半截回复保留，直接报错', async () => {
  const provider = new FlakyProvider([
    { events: [{ type: 'text', text: '半截' }], error: serverError() },
    { events: doneText('不该发生') },
  ]);
  const events: AgentEvent[] = [];
  const outcome = await makeRuntime(provider, events).run(baseInput);
  assert.equal(outcome.status, 'error');
  assert.equal(provider.calls, 1, '吐过字节后绝不能重发');
  assert.equal(outcome.text, '半截', '已交付的半截正文要入账');
  assert.equal(outcome.stop, 'provider_incomplete');
  assert.equal(isUnfinishedStop(outcome.stop), true);
  const errorEvent = events.find((event) => event.type === 'error');
  assert.ok(errorEvent && errorEvent.type === 'error');
  assert.equal(errorEvent.retryable, true);
  assert.equal(errorEvent.stop, 'provider_incomplete');
  assert.ok(events.some((e) => e.type === 'step_text' && e.text === '半截'));
});

test('不可重试错误（400）不浪费重试，也不伪装成可继续', async () => {
  const provider = new FlakyProvider([
    { error: new ProviderError('模型接口返回 400：bad request', { code: 'PROVIDER_HTTP', status: 400, retryable: false }) },
  ]);
  const events: AgentEvent[] = [];
  const outcome = await makeRuntime(provider, events).run(baseInput);
  assert.equal(provider.calls, 1);
  assert.equal(outcome.stop, undefined);
  const errorEvent = events.find((event) => event.type === 'error');
  assert.ok(errorEvent && errorEvent.type === 'error');
  assert.equal(errorEvent.retryable, false);
  assert.equal(errorEvent.stop, undefined);
});

test('服务商未完成原因保留 provider_incomplete，且不执行半截工具调用', async () => {
  for (const reason of ['content_filter', 'pause_turn', 'model_context_window_exceeded']) {
    let executed = false;
    const provider = new FlakyProvider([{ events: [
      { type: 'text', text: 'partial' },
      { type: 'tool_call', call: { id: 'a', name: 'run_sql', args: { sql: 'DELETE FROM orders' } } },
      { type: 'done', stopReason: reason },
    ] }]);
    const runtime = new AgentRuntime({
      provider,
      buildSystem: () => 'system',
      executeTool: async () => { executed = true; return okResult(); },
      requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
      emit: () => {},
      generateId: () => 'id',
    });
    const outcome = await runtime.run(baseInput);
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.stop, 'provider_incomplete');
    assert.equal(outcome.text, 'partial');
    assert.equal(executed, false);
  }
});

test('退避期间用户中止：立即按 aborted 收尾，不再发起重试', async () => {
  const provider = new FlakyProvider([{ error: rateLimit() }, { events: doneText('不该发生') }]);
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const outcome = await makeRuntime(provider).run({ ...baseInput, signal: controller.signal });
  const elapsed = Date.now() - started;
  assert.equal(outcome.status, 'aborted');
  assert.equal(provider.calls, 1, '中止后不能再调模型');
  assert.ok(elapsed < 900, `必须在退避结束前就响应中止，实际 ${elapsed}ms`);
});

test('网络瞬态错误（PROVIDER_NETWORK）同样重试', async () => {
  const provider = new FlakyProvider([
    { error: new ProviderError('无法连接模型接口：fetch failed', { code: 'PROVIDER_NETWORK', retryable: true }) },
    { events: doneText('back online') },
  ]);
  const outcome = await makeRuntime(provider).run(baseInput);
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.text, 'back online');
  assert.equal(provider.calls, 2);
});