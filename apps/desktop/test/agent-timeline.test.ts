import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessageBlock } from '@aidb/core';
import {
  groupTools,
  turnFromBlocks,
  turnFromLive,
  type LiveTurnLike,
  type TimelineItem,
} from '../src/lib/agentTimeline';

/**
 * 时间线顺序的钉。
 *
 * 用户要读到的形状是他自己说的那句：「思考 - 输出 - sql - 思考 - 输出 - sql ... 结论」。
 * 此前的实现按类型分堆（工具卡在上面折叠、正文整段在下面），顺序只在单一来源里存在，
 * 合起来就丢了。这类 bug 肉眼只在真实数据里看得见，所以顺序必须由测试拿住：
 * 以后任何人调渲染，先得过这几条。
 */

const okResult = { ok: true as const, summary: 'ok', data: {}, meta: { durationMs: 1 } };
const chartResult = { ok: true as const, summary: 'chart', data: { chart: { type: 'bar', data: [] } }, meta: { durationMs: 1 } };

const text = (t: string, step: number): AgentMessageBlock => ({ type: 'text', text: t, step });
const thinking = (t: string, step?: number): AgentMessageBlock => ({ type: 'thinking', text: t, ...(step === undefined ? {} : { step }) });
const call = (callId: string, tool = 'run_sql'): AgentMessageBlock => ({ type: 'tool_call', callId, tool, args: { sql: 'select 1' } });
const result = (callId: string, tool = 'run_sql', res = okResult): AgentMessageBlock => ({ type: 'tool_result', callId, tool, result: res });

const kinds = (view: ReturnType<typeof turnFromBlocks>) => view.entries.map((entry) => entry.kind);

test('落库 blocks：思考/正文/工具按写入顺序交错，不按类型分堆', () => {
  const view = turnFromBlocks([
    thinking('先看清表结构', 1),
    text('我先按 status 分组统计。', 1),
    call('c1'),
    result('c1'),
    thinking('再画个图', 2),
    text('已完成 3 个状态。', 2),
    call('c2', 'generate_chart'),
    result('c2', 'generate_chart'),
    text('结论：pending 占一半。', 3),
  ]);
  assert.deepEqual(kinds(view), [
    'thinking',
    'text',
    'tool',
    'thinking',
    'text',
    'tool',
    'text',
  ]);
  assert.equal(view.stepped, true);
  // 每段文字仍带着它属于第几步，渲染才能把「这句话在哪个工具之前说」对上
  assert.deepEqual(
    view.entries.filter((e) => e.kind === 'text').map((e) => (e.kind === 'text' ? e.step : undefined)),
    [1, 2, 3],
  );
});

test('tool_result 不另占一格：一次调用在时间线上只出现一次', () => {
  const view = turnFromBlocks([text('先看', 1), call('c1'), result('c1')]);
  assert.deepEqual(kinds(view), ['text', 'tool']);
  assert.equal(view.toolCount, 1);
  const tool = view.entries[1];
  assert.equal(tool && tool.kind === 'tool' && tool.call.status, 'ok', '结果回填进调用那一格');
});

test('图表从工具卡里提出来，位置不再跟着工具走', () => {
  const view = turnFromBlocks([text('看图', 1), call('c1', 'generate_chart'), result('c1', 'generate_chart', chartResult)]);
  assert.equal(view.charts.length, 1, '图表要能被提到时间线外面渲染（它塞进 .tool-card 会被压扁）');
  const toolEntry = view.entries.find((entry) => entry.kind === 'tool');
  assert.ok(toolEntry && toolEntry.kind === 'tool' && toolEntry.call.result, '卡片本体仍在顺序上，只是内容被提走');
});

test('半路中止的调用：没有结果也要留在时间线上，并且标成失败', () => {
  const view = turnFromBlocks([text('我来建表', 1), call('c1', 'create_table')]);
  const tool = view.entries.at(-1);
  assert.equal(tool?.kind, 'tool');
  assert.equal(tool && tool.kind === 'tool' && tool.call.status, 'error', '结果永远不会来了，不能一直显示「运行中」');
});

test('旧数据（整回合一条 thinking、正文没有 step）仍走老渲染', () => {
  const view = turnFromBlocks([thinking('整回合的思考合并成一坨'), text('一整段正文', undefined as unknown as number)]);
  // 老那坨思考不进时间线（它不属于任何一步），由 legacyThinking 交给老渲染分支。
  // stepped 仍是 true：正文排得出位置（它就一格），时间线比把正文塞进折叠更贴近原样。
  assert.equal(view.stepped, true);
  assert.equal(view.legacyThinking, '整回合的思考合并成一坨', '老的那坨思考交给 legacy 通道，不混进时间线');
  assert.deepEqual(kinds(view), ['text']);
});

test('计划块留在视图上，但不占时间线的一格', () => {
  const items = [{ id: 'p1', text: '读表结构', status: 'done' }];
  const view = turnFromBlocks([{ type: 'plan', items }, text('先看表', 1), call('c1')]);
  assert.deepEqual(view.plan, items);
  assert.deepEqual(kinds(view), ['text', 'tool'], '计划卡渲染在折叠外面，不该跟着步骤滚走');
});

const live = (over: Partial<LiveTurnLike> = {}): LiveTurnLike => ({
  text: '',
  thinking: '',
  tools: [],
  timeline: [] as TimelineItem[],
  stream: '',
  streamThinking: '',
  plan: [],
  ...over,
});

test('live 回合：时间线顺序 = 事件到达顺序，正在生成的接在最后', () => {
  const view = turnFromLive(
    live({
      tools: [
        { callId: 'c1', tool: 'run_sql', args: {}, status: 'ok', result: okResult },
        { callId: 'c2', tool: 'run_sql', args: {}, status: 'running' },
      ],
      timeline: [{ kind: 'thinking', text: '先看表', step: 1 }, { kind: 'text', text: '我按 status 分组', step: 1 }, { kind: 'tool', callId: 'c1' }, { kind: 'tool', callId: 'c2' }],
      streamThinking: '下一步画图',
      stream: '已经拿到 3 行',
    }),
  );
  assert.deepEqual(kinds(view), ['thinking', 'text', 'tool', 'tool', 'thinking', 'text']);
  const tail = view.entries.at(-1);
  assert.equal(tail && tail.kind === 'text' && tail.text, '已经拿到 3 行', '还没到边界的正文挂在末尾，带打字光标');
  assert.equal(view.entries.filter((e) => e.kind === 'tool').at(-1) && view.entries.filter((e) => e.kind === 'tool').at(-1)!.kind, 'tool');
  const running = view.entries.filter((e) => e.kind === 'tool').map((e) => (e.kind === 'tool' ? e.call.status : ''));
  assert.deepEqual(running, ['ok', 'running'], '运行中的工具卡要显示成运行中，不能跟着落库消息一起变成完成');
});

test('时间线引用了不存在的工具调用时跳过它，不渲染空气泡', () => {
  const view = turnFromLive(live({ tools: [], timeline: [{ kind: 'tool', callId: 'gone' }], stream: '还在说' }));
  assert.deepEqual(kinds(view), ['text']);
});

test('连续工具折成一段，正文与思考各自独立且不参与折叠', () => {
  const view = turnFromBlocks([
    thinking('想一下', 1),
    text('我先查 A', 1),
    call('c1'),
    result('c1'),
    call('c2', 'run_sql'),
    result('c2'),
    text('再查 B', 2),
    call('c3', 'run_sql'),
    result('c3'),
  ]);
  const groups = groupTools(view.entries);
  assert.deepEqual(
    groups.map((group) => (group.kind === 'tools' ? `tools:${group.calls.length}` : group.entry.kind)),
    ['thinking', 'text', 'tools:2', 'text', 'tools:1'],
  );
  // 折叠段的起始位置就是它在时间线上的位置：折起来是「就地收成一段」，不是搬到底下。
  // （tool_result 不占格，所以第二段正文在 index 4、它的工具卡在 index 5。）
  assert.deepEqual(groups.map((g) => (g.kind === 'tools' ? g.start : g.index)), [0, 1, 2, 4, 5]);
});
