import assert from 'node:assert/strict';
import test from 'node:test';
import { PANE, computePaneLayout, type PaneLayoutInput } from '../src/lib/layout';

const open = (viewport: number, extra: Partial<PaneLayoutInput> = {}) =>
  computePaneLayout({ viewport, sidebarOpen: true, agentOpen: true, sidebarWanted: 244, agentWanted: 384, ...extra });

/** 中间工作区地板：40% 可用宽与 340px 取大者，任何一侧都不能吃掉它。 */
const floor = (viewport: number, splits = 2) =>
  Math.min(viewport - splits * PANE.splitter, Math.max(PANE.workspace.min, Math.ceil((viewport - splits * PANE.splitter) * PANE.workspaceShare)));

const sum = (l: ReturnType<typeof computePaneLayout>, splits: number) =>
  l.sidebar + l.agent + l.workspace + splits * PANE.splitter;

test('默认宽度：中间吃掉剩余空间，两侧不被压到最小', () => {
  const l = open(1440);
  assert.equal(l.sidebar, 244);
  assert.equal(l.agent, 384);
  assert.equal(l.workspace, 1440 - 10 - 244 - 384);
  assert.ok(l.workspace >= PANE.workspace.min);
  assert.equal(l.sidebarInFlow, true);
  assert.equal(l.agentInFlow, true);
});

test('左侧受 35% 约束，中间不受挤压（≥40%）', () => {
  const l = open(1440);
  const avail = 1440 - 10;
  assert.ok(l.sidebar <= Math.floor(avail * PANE.sideShare));
  assert.ok(l.share.workspace >= 0.4);
});

test('AI 助手不再共用 35%：拖到上限时能拿到「可用宽 − 地板 − 左栏」', () => {
  const avail = 1440 - 10;
  const l = open(1440, { agentWanted: PANE.agent.max });
  assert.ok(l.agent > Math.floor(avail * PANE.sideShare), '右栏应该突破 35% 这条线');
  assert.equal(l.agent, avail - floor(1440) - l.sidebar);
  assert.equal(l.workspace, floor(1440));
});

test('AI 助手宽度随窗口智能增长，且封顶在 PANE.agent.max', () => {
  let prev = 0;
  for (const viewport of [1100, 1280, 1440, 1920, 2560]) {
    const l = open(viewport, { agentWanted: PANE.agent.max });
    assert.ok(l.agent >= prev, `viewport=${viewport} 时右栏反而变窄了`);
    assert.ok(l.agent <= PANE.agent.max);
    assert.ok(l.workspace >= floor(viewport), `viewport=${viewport} 时中间被压过地板`);
    prev = l.agent;
  }
  // 足够宽的窗口才吃满绝对上限
  assert.equal(open(3000, { agentWanted: PANE.agent.max }).agent, PANE.agent.max);
});

test('expand：占到地板为止的剩余空间，不超过自身上限', () => {
  const base = open(1440);
  const expanded = open(1440, { agentExpanded: true });
  assert.ok(expanded.agent > base.agent, '展开应该比默认宽');
  assert.equal(expanded.agent, 1440 - 10 - floor(1440) - expanded.sidebar);
  assert.ok(expanded.workspace >= Math.ceil((1440 - 10) * PANE.workspaceShare));
});

test('窄窗口先收右栏，不压中间', () => {
  const wide = open(1440, { agentWanted: 900 });
  const tight = open(1100, { agentWanted: 900 });
  assert.equal(tight.workspace >= PANE.workspace.min, true);
  assert.ok(tight.workspace >= floor(1100));
  assert.ok(tight.agent < wide.agent);
});

test('左栏拖到上限也不越界：总和正好等于窗口宽', () => {
  const l = open(1010, { sidebarWanted: 460, agentWanted: PANE.agent.max });
  assert.ok(l.sidebar >= PANE.sidebar.min);
  assert.ok(l.agent >= PANE.agent.min);
  assert.ok(l.workspace >= floor(1010));
  assert.equal(sum(l, 2), 1010);
});

test('拖拽上限与中间地板一致：拖到 max 也不越界', () => {
  const l = open(1440);
  const dragged = open(1440, { sidebarWanted: l.sidebarMax, agentWanted: l.agentMax });
  assert.ok(dragged.workspace >= Math.ceil((1440 - 10) * PANE.workspaceShare));
  assert.ok(dragged.sidebar <= l.sidebarMax);
  assert.ok(dragged.agent <= l.agentMax);
  assert.equal(sum(dragged, 2), 1440);
});

test('右栏占到上限时，左栏还能拖到自身上限，中间仍 ≥ 地板', () => {
  const l = open(1920, { agentWanted: PANE.agent.max, sidebarWanted: PANE.sidebar.max });
  assert.ok(l.workspace >= floor(1920));
  assert.ok(l.sidebar >= PANE.sidebar.min);
  assert.equal(sum(l, 2), 1920);
});

test('窄窗口退回浮层：≤1000 收起 AI 面板，≤720 连侧栏一起收', () => {
  assert.equal(open(990).agentInFlow, false);
  assert.equal(open(1001).agentInFlow, true);
  assert.equal(open(715).sidebarInFlow, false);
  assert.equal(open(721).sidebarInFlow, true);
});

test('只剩侧栏时上限放宽到自身最大值，但仍不碰中间地板', () => {
  const l = computePaneLayout({ viewport: 1200, sidebarOpen: true, agentOpen: false, sidebarWanted: 460 });
  assert.equal(l.sidebar, 460);
  assert.ok(l.workspace >= Math.ceil((1200 - 5) * PANE.workspaceShare));
});

test('左侧收起后右侧可以加宽到自身绝对上限', () => {
  const closed = computePaneLayout({ viewport: 2400, sidebarOpen: false, agentOpen: true, agentWanted: PANE.agent.max });
  assert.equal(closed.sidebarInFlow, false);
  assert.equal(closed.agent, PANE.agent.max, '侧栏收起后 AI 面板应能用满自身上限');
  assert.ok(closed.workspace >= Math.ceil((2400 - 5) * PANE.workspaceShare));

  // 两侧都在时同样能吃满或贴近上限，差别正好是左栏占掉的宽度，且绝不越过中间地板
  const both = computePaneLayout({ viewport: 2400, sidebarOpen: true, agentOpen: true, agentWanted: PANE.agent.max });
  assert.equal(both.agent, 2400 - 10 - floor(2400) - both.sidebar);
  assert.ok(both.workspace >= floor(2400));
});

test('侧栏收起时的拖拽上限也会放宽', () => {
  const l = computePaneLayout({ viewport: 2400, sidebarOpen: false, agentOpen: true, agentWanted: 384 });
  assert.ok(l.agentMax >= 1000);
  assert.ok(2400 - PANE.splitter - l.agentMax >= Math.ceil((2400 - 5) * PANE.workspaceShare));
});

test('侧栏收起 + 展开：直接吃到自身上限或中间地板', () => {
  const l = computePaneLayout({ viewport: 2400, sidebarOpen: false, agentOpen: true, agentWanted: 384, agentExpanded: true });
  assert.equal(l.agent, PANE.agent.max);
  assert.ok(l.workspace >= Math.ceil((2400 - 5) * PANE.workspaceShare));
});

test('展开不会越过中间地板：窗口刚过浮层阈值时只给到地板为止', () => {
  const l = open(1020, { agentExpanded: true });
  assert.ok(l.workspace >= floor(1020));
  assert.ok(l.agent >= PANE.agent.min);
  assert.equal(sum(l, 2), 1020);
});

test('异常输入不会产出 NaN / 负数', () => {
  for (const viewport of [Number.NaN, Number.POSITIVE_INFINITY, -100, 0]) {
    const l = computePaneLayout({ viewport, sidebarOpen: true, agentOpen: true });
    for (const v of [l.sidebar, l.agent, l.workspace, l.sidebarMax, l.agentMax]) {
      assert.ok(Number.isFinite(v) && v >= 0, `viewport=${viewport} 时出现非法宽度 ${v}`);
    }
  }
});

test('可用宽单调性：窗口变宽，中间只会更宽', () => {
  let prev = 0;
  for (const viewport of [1001, 1100, 1280, 1440, 1600, 1920, 2560]) {
    const l = open(viewport);
    assert.ok(l.workspace >= prev, `viewport=${viewport} 时中间反而变窄了`);
    prev = l.workspace;
  }
});
