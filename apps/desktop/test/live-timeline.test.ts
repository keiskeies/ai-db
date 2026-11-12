import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { AgentEvent } from '@aidb/core';

/**
 * 回合时间线：界面靠它把「思考-说话-工具-思考-说话-结论」按真实顺序渲染。
 *
 * 用户原话是「所有文字都挤在下面，也不知道上面在干什么，执行和解释都对应不上」。
 * 根因在状态层：正文一条道累积（live.text），工具另存一条（live.tools），
 * 两份各自有序、合起来顺序当场丢失。这里钉住修好之后的三件事：
 *   1. step_text / step_thinking / tool_call 按到达顺序进同一条 timeline；
 *   2. 正在生成的部分留在 stream，边界到来才清空（不能一边生成一边在时间线上跳）；
 *   3. text_replace（XML 兜底改写）只改当前这一步，不抹掉前面说过的话。
 */
await (async () => {
  globalThis.location = { hash: '#token=t', pathname: '/', search: '' } as unknown as Location;
  globalThis.history = { replaceState() {} } as unknown as History;
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  } as unknown as Storage;
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
})();

const { useApp } = await import('../src/store');

const state = () => useApp.getState();
const send = (event: AgentEvent) => state().handleAgentEvent(event);

const startLive = () => {
  useApp.setState({
    live: {
      userText: '按 status 统计 orders',
      text: '',
      thinking: '',
      tools: [],
      timeline: [],
      stream: '',
      streamThinking: '',
      plan: [],
      status: 'streaming' as const,
      startedAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      steps: 0,
      modelCalls: 0,
      contextTokens: 0,
      modelDurationMs: 0,
      memories: [],
    },
    approval: undefined,
    approvalQueue: [],
    toasts: [],
  });
};

const textDelta = (text: string): AgentEvent => ({ type: 'text_delta', text });
const thinkingDelta = (text: string): AgentEvent => ({ type: 'thinking_delta', text });
const stepText = (text: string, step: number): AgentEvent => ({ type: 'step_text', text, step });
const stepThinking = (text: string, step: number): AgentEvent => ({ type: 'step_thinking', text, step });
const toolCall = (callId: string, tool: string): AgentEvent => ({
  type: 'tool_call',
  callId,
  tool,
  args: {},
  risk: 'read',
  summary: tool,
});
const toolResult = (callId: string, tool: string): AgentEvent => ({
  type: 'tool_result',
  callId,
  tool,
  result: { ok: true, summary: 'ok', data: {}, meta: { durationMs: 1 } },
});

after(() => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
});

test('时间线按到达顺序排列，正文/思考/工具不再分堆', () => {
  startLive();
  send(thinkingDelta('先看有哪些表'));
  send(stepThinking('先看有哪些表', 1));
  send(textDelta('我先统计各状态的订单数。'));
  send(stepText('我先统计各状态的订单数。', 1));
  send(toolCall('c1', 'run_sql'));
  send(toolResult('c1', 'run_sql'));
  send(textDelta('已完成 3 个状态。'));
  send(stepText('已完成 3 个状态。', 2));

  const kinds = state().live!.timeline.map((item) => item.kind);
  assert.deepEqual(kinds, ['thinking', 'text', 'tool', 'text'], '顺序必须就是发生顺序');
  // 工具结果只回填状态，不再另占一格（否则一次调用在时间线上出现两次）
  assert.equal(state().live!.timeline.filter((item) => item.kind === 'tool').length, 1);
  assert.equal(state().live!.tools.find((tool) => tool.callId === 'c1')?.status, 'ok');
});

test('正在生成的部分留在 stream，步骤边界一到就交棒给时间线', () => {
  startLive();
  send(textDelta('订单数统计'));
  assert.equal(state().live!.stream, '订单数统计', '还在生成时挂在 stream，界面据此显示打字光标');
  assert.equal(state().live!.timeline.length, 0, '没到边界就不该进时间线');

  send(stepText('订单数统计', 1));
  assert.equal(state().live!.stream, '', '边界一到，stream 清空');
  assert.deepEqual(state().live!.timeline.map((item) => item.kind), ['text']);

  send(thinkingDelta('下一步画个图'));
  assert.equal(state().live!.streamThinking, '下一步画个图');
  send(stepThinking('下一步画个图', 2));
  assert.equal(state().live!.streamThinking, '');
});

test('第二步的 text_replace 不会抹掉第一步说过的话', () => {
  startLive();
  send(textDelta('第一步：先看表。'));
  send(stepText('第一步：先看表。', 1));
  send(toolCall('c1', 'run_sql'));
  send(textDelta('第二段前半'));
  // XML 兜底：模型把工具调用写进了正文，runtime 改写**当前这一步**的正文并重发
  send({ type: 'text_replace', text: '第二段改写后' } as AgentEvent);

  const live = state().live!;
  assert.equal(live.stream, '第二段改写后');
  assert.ok(live.text.includes('第一步：先看表。'), '整回合正文里第一步的话还在');
  assert.ok(live.text.includes('第二段改写后'));
  assert.ok(!live.text.includes('第二段前半'), '被改写的旧文本不该残留');
});

test('整回合的 text/thinking 累计不被分段交付破坏（老兜底与导出仍要用）', () => {
  startLive();
  send(thinkingDelta('想一下'));
  send(textDelta('甲'));
  send(stepText('甲', 1));
  send(toolCall('c1', 'run_sql'));
  send(textDelta('乙'));
  send(stepText('乙', 2));
  // 第三步触发 XML 兜底：改写只针对当前这一步
  send(textDelta('丙'));
  send({ type: 'text_replace', text: '丙（改写后）' } as AgentEvent);

  const live = state().live!;
  // live.text 仍是「整回合」：搜索、复制、会话摘要都读它
  assert.ok(live.text.includes('甲') && live.text.includes('乙'), '前面几步说过的话要留在整回合正文里');
  assert.ok(live.text.includes('丙（改写后）'));
  assert.equal(live.thinking, '想一下');
  // 这条里没有 step_thinking：thinking_delta 只进整回合累计，时间线上不该凭空多出一格
  assert.deepEqual(live.timeline.map((item) => item.kind), ['text', 'tool', 'text']);
});
