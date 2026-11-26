import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAgentEvent, isUnfinishedLiveTurn, liveTurnEndLabel } from '../src/components/chat/turnModel';
import type { LiveTurn } from '../src/types';

const startLive = (): LiveTurn => ({
  sessionId: 's1',
  generation: 0,
  turnId: 't1',
  userText: '继续分析',
  text: '',
  thinking: '',
  tools: [],
  timeline: [],
  stream: '',
  streamThinking: '',
  plan: [],
  status: 'streaming',
  pendingApprovalIds: [],
  suggestions: [],
  steps: 0,
  modelCalls: 0,
  contextTokens: 0,
  modelDurationMs: 0,
  tokensIn: 0,
  tokensOut: 0,
  startedAt: Date.now(),
  memories: [],
});

test('预算到期事件保留 deadline 原因并判为未完成', () => {
  const live = applyAgentEvent(startLive(), {
    type: 'aborted',
    turnId: 't1',
    reason: '回合已到达绝对时间预算',
    cause: 'deadline',
  });
  assert.equal(live.status, 'aborted');
  assert.equal(live.abortCause, 'deadline');
  assert.equal(live.abortReason, '回合已到达绝对时间预算');
  assert.equal(isUnfinishedLiveTurn(live), true);
  assert.equal(liveTurnEndLabel(live), '未完成');
});

test('用户主动停止不冒充预算到期，也不显示未完成', () => {
  const live = applyAgentEvent(startLive(), {
    type: 'aborted',
    turnId: 't1',
    reason: '用户中止',
    cause: 'user',
  });
  assert.equal(live.abortCause, 'user');
  assert.equal(isUnfinishedLiveTurn(live), false);
  assert.equal(liveTurnEndLabel(live), '已中止');
});
