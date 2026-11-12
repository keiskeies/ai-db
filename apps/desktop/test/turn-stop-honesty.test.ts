import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@aidb/core';
import { isUnfinishedStop } from '@aidb/core';

/**
 * 「停止要说清原因」在界面这一侧的契约。
 *
 * 用户原话：「agent 总是莫名其妙就停止了，也不知道什么原因，但目标计划的 item icon
 * 还在转圈圈」。这不是一个 bug 而是三处一起在撒谎，各自都要钉住：
 *   1. `status === 'done'` 把「说完了」「被 max_tokens 截断」「跑满步数」说成一件事，
 *      于是界面一律显示「已完成」——状态层必须把 stop 原样带到 live 上；
 *   2. 计划图标只看 item.status，不看回合还在不在跑，于是任何一次停止之后那颗点
 *      都会永远转下去，读起来像「还在跑」；
 *   3. 截断耗尽重试后是以 **error** 收场的（没有 done 事件），stop 只挂在 done 上的话，
 *      最需要「继续」按钮的那一条分支恰好给不出按钮。
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
      userText: '给所有表补注释',
      text: '',
      thinking: '',
      tools: [],
      timeline: [],
      stream: '',
      streamThinking: '',
      plan: [
        { id: 'p1', text: '读取表结构', status: 'done' as const },
        { id: 'p2', text: '补表注释', status: 'doing' as const },
        { id: 'p3', text: '补列注释', status: 'todo' as const },
      ],
      status: 'streaming' as const,
      startedAt: Date.now(),
      lastEventAt: Date.now() - 45_000,
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

after(() => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
});

const here = dirname(fileURLToPath(import.meta.url));
// test/ → desktop/ → apps/ → 仓库根
const root = resolve(here, '../../..');
const source = (rel: string) => readFileSync(join(root, rel), 'utf8');
const agentPanel = source('apps/desktop/src/components/AgentPanel.tsx');
const appCss = source('apps/desktop/src/styles/app.css');

test('done 带 stop 时原样落到 live 上，界面才知道这事没做完', () => {
  startLive();
  send({ type: 'text_delta', text: '先读结构' });
  send({ type: 'done', turnId: 't1', durationMs: 1000, stop: 'max_output_tokens' });
  const live = state().live!;
  assert.equal(live.status, 'done');
  assert.equal(live.stop, 'max_output_tokens');
  assert.equal(isUnfinishedStop(live.stop), true, '截断是「没做完」，界面据此给「继续」');
});

test('老网关不带 stop 时按 end_turn 处理，不能当成没做完', () => {
  startLive();
  send({ type: 'done', turnId: 't1', durationMs: 100 });
  const live = state().live!;
  assert.equal(live.stop, 'end_turn');
  assert.equal(isUnfinishedStop(live.stop), false, '真说完了就别催用户点继续');
});

test('截断耗尽重试后以 error 收场：stop 也必须带上，否则「继续」按钮在最需要时缺席', () => {
  startLive();
  send({
    type: 'error',
    code: 'OUTPUT_TRUNCATED',
    message: '模型连续 2 次把回复写到超出输出上限，仍未写完。',
    retryable: true,
    stop: 'max_output_tokens',
  } as AgentEvent);
  const live = state().live!;
  assert.equal(live.status, 'error');
  assert.equal(live.stop, 'max_output_tokens');
  assert.equal(isUnfinishedStop(live.stop), true);
});

test('普通调用失败不填 stop：那种情况没有续跑检查点，不能给「继续」', () => {
  startLive();
  send({ type: 'error', code: 'PROVIDER_ERROR', message: '401 unauthorized', retryable: false } as AgentEvent);
  const live = state().live!;
  assert.equal(live.status, 'error');
  assert.equal(live.stop, undefined);
  assert.equal(isUnfinishedStop(live.stop), false);
});

test('每个事件都刷新 lastEventAt：静默监听只有一个输入可用', () => {
  startLive();
  const before = state().live!.lastEventAt;
  assert.ok(Date.now() - before >= 40_000, '起始值刻意摆在 45 秒前，模拟一条很久没动静的回合');
  send({ type: 'text_delta', text: '新的输出' });
  assert.ok(state().live!.lastEventAt > before, '有动静就要刷新，否则监听会把慢回合误报成卡死');
  assert.equal(state().live!.status, 'streaming', '静默多久都不改变状态：报告等待，不擅自判定失败');
});

test('停摆中止与用户停止在状态层就分得开', () => {
  startLive();
  send({ type: 'aborted', turnId: 't1', reason: '模型连接无响应（可继续）', cause: 'stalled' });
  assert.equal(state().live!.abortCause, 'stalled');

  startLive();
  send({ type: 'aborted', turnId: 't1', reason: '用户中止', cause: 'user' });
  assert.equal(state().live!.abortCause, 'user');
  assert.equal(isUnfinishedStop(state().live!.stop), false);
});

// ---------- 界面源码：转圈的图标与「已完成」那行字 ----------

test('计划卡只有在回合真的在跑时才转圈', () => {
  assert.match(
    agentPanel,
    /function PlanCard\(\{ items, running = false/,
    '计划卡必须能区分「还没打勾」与「正在进行」——前者是绝大多数停止后的真实状态',
  );
  const callSites = agentPanel.match(/<PlanCard[\s\S]{0,120}?\/>/g) ?? [];
  assert.ok(callSites.length >= 2, '计划卡有两个渲染点（状态条浮层与回合内）');
  for (const site of callSites) {
    assert.match(site, /running=\{running\}/, '两处都得把 running 传进去，漏一处就还有一处在骗人');
  }
  assert.match(
    appCss,
    /\.plan-card\.settled \.plan-item\.doing \.plan-icon::after\s*\{[^}]*animation:\s*none/,
    '回合结束后，未完成项的图标必须停下动画',
  );
});

test('没做完的回合不再写「已完成」，截断也不写「已失败」', () => {
  // 有两个 turn-end：持久化消息那个只写工具数，运行中/刚结束的那个才写状态结论。
  // lastIndexOf 取的就是后者——状态结论这一行才是会说谎的地方。
  const start = agentPanel.lastIndexOf('className="turn-end"');
  assert.ok(agentPanel.match(/className="turn-end"/g)!.length >= 2, '回合结尾行至少有两处');
  const endBlock = agentPanel.slice(start, start + 1600);
  assert.match(endBlock, /isUnfinishedStop\(live\.stop\)/, '结尾行要看 stop');
  assert.match(endBlock, /t\('stoppedUnfinished'\)/);
  // 关键顺序：isUnfinishedStop 必须排在 status==='error' 之前，否则截断会被报成执行失败
  assert.ok(
    endBlock.indexOf('isUnfinishedStop(live.stop)') < endBlock.indexOf("t('failed')"),
    '截断那类 error 要先判 stop，不能被报成「已失败」',
  );
});

test('静默中的回合要报等待多久，但不判定失败', () => {
  assert.match(agentPanel, /function quietTurnNotice/, '运行中久无事件必须有一句说明');
  const notice = agentPanel.slice(agentPanel.indexOf('function quietTurnNotice'), agentPanel.indexOf('function quietTurnNotice') + 1400);
  assert.match(notice, /live\.lastEventAt/, '等待时长按最后一个事件算，不是按回合开始算');
  assert.match(notice, /if \(!live\.lastEventAt\) return null/, '没有 lastEventAt 就闭嘴：退回 startedAt 会把「一直在出事件的长回合」报成卡死');
  assert.match(notice, /quiet < 30/, '短暂无声是常态，别为一次全表扫描喊卡死');
  assert.match(notice, /仍在等待回应|没有新进展/, '要说清在等什么');
  assert.doesNotMatch(notice, /status = 'error'|已超时|失败/, '界面只报告等待，不擅自把健康长回合判成失败');
  assert.match(agentPanel, /data-testid="agent-quiet-notice"/, '说明要渲染进状态条');
});

test('续跑入口在停摆与三种没做完时都出现', () => {
  const notice = agentPanel.slice(agentPanel.indexOf('function TurnStopNotice'), agentPanel.indexOf('function PlanCard'));
  assert.match(notice, /data-testid="turn-continue"/);
  assert.match(notice, /isUnfinishedStop\(live\.stop\)/);
  assert.match(notice, /live\.abortCause === 'stalled'/, '停摆也要能给「继续」：服务端留了检查点');
  assert.match(notice, /live\.error\s*\?\s*null/, 'runtime 已经说清原因时不再重复一句');
  assert.match(agentPanel, /onContinue=\{\(\) => void sendAgent\(tr\("继续"\)/, '点下去就是发一句「继续」，走正常回合');
});

test('通道静默（客户端自己断的）也算没做完：要给「继续」', () => {
  // 这条路径是客户端发现的：半开连接不报错也不结束，只能由 read() 的静默上限收场。
  // 服务端那边按「用户中止」处理，不会写结构化检查点，所以界面上这颗按钮是唯一的出路。
  startLive();
  send({ type: 'text_delta', text: '先读结构' });
  assert.equal(isUnfinishedStop('channel_idle'), true);
});
