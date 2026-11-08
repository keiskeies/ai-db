import assert from 'node:assert/strict';
import test from 'node:test';
import { PANE, computePaneLayout, type PaneLayoutInput } from '../src/lib/layout';

const open = (viewport: number, extra: Partial<PaneLayoutInput> = {}) =>
  computePaneLayout({ viewport, sidebarOpen: true, agentOpen: true, sidebarWanted: 244, agentWanted: 384, ...extra });

test('默认宽度：中间吃掉剩余空间，两侧不被压到最小', () => {
  const l = open(1440);
  assert.equal(l.sidebar, 244);
  assert.equal(l.agent, 384);
  assert.equal(l.workspace, 1440 - 10 - 244 - 384);
  assert.ok(l.workspace >= PANE.workspace.min);
  assert.equal(l.sidebarInFlow, true);
  assert.equal(l.agentInFlow, true);
});

test('两侧各自不超过可用宽的 35%（约 1:3:2）', () => {
  const l = open(1440);
  const avail = 1440 - 10;
  assert.ok(l.sidebar <= Math.floor(avail * PANE.sideShare));
  assert.ok(l.agent <= Math.floor(avail * PANE.sideShare));
  assert.ok(l.share.workspace >= 0.4);
});

test('把 AI 面板拖到 760 会被收回，中间仍然 ≥ 40%', () => {
  const l = open(1440, { agentWanted: 760 });
  assert.ok(l.agent < 760);
  assert.ok(l.agent <= Math.floor((1440 - 10) * PANE.sideShare));
  assert.ok(l.workspace >= Math.ceil((1440 - 10) * PANE.workspaceShare));
});

test('expand：给出当前允许的最大宽度，而不是写死的 58% / 760px', () => {
  const base = open(1440);
  const expanded = open(1440, { agentExpanded: true });
  assert.ok(expanded.agent > base.agent, '展开应该比默认宽');
  assert.ok(expanded.agent <= Math.floor((1440 - 10) * PANE.sideShare));
  assert.ok(expanded.workspace >= Math.ceil((1440 - 10) * PANE.workspaceShare));
  // 1440 下 1:3:2 的理想值约为 239 : 716 : 478
  assert.ok(Math.abs(expanded.share.sidebar - 1 / 6) < 0.05);
  assert.ok(expanded.share.workspace > 0.45);
});

test('窗口变窄时先收 AI 面板，不压中间', () => {
  const wide = open(1440);
  const tight = open(1100);
  assert.equal(tight.workspace >= PANE.workspace.min, true);
  assert.ok(tight.workspace >= Math.ceil((1100 - 10) * PANE.workspaceShare));
  assert.ok(tight.agent <= wide.agent || tight.agent === PANE.agent.min);
});

test('两侧都拖到上限时按余量比例回收，且都不低于最小宽度', () => {
  const l = open(1010, { sidebarWanted: 460, agentWanted: 760 });
  const avail = 1010 - 10;
  assert.ok(l.sidebar >= PANE.sidebar.min);
  assert.ok(l.agent >= PANE.agent.min);
  assert.ok(l.workspace >= Math.ceil(avail * PANE.workspaceShare));
  assert.equal(l.sidebar + l.agent + l.workspace, avail);
});

test('拖拽上限与中间地板一致：拖到 max 也不越界', () => {
  const l = open(1440);
  const dragged = open(1440, { sidebarWanted: l.sidebarMax, agentWanted: l.agentMax });
  assert.ok(dragged.workspace >= Math.ceil((1440 - 10) * PANE.workspaceShare));
  assert.ok(dragged.sidebar <= l.sidebarMax);
  assert.ok(dragged.agent <= l.agentMax);
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

test('左侧收起后右侧可以加宽到自身上限', () => {
  const closed = computePaneLayout({ viewport: 1440, sidebarOpen: false, agentOpen: true, agentWanted: 760 });
  assert.equal(closed.sidebarInFlow, false);
  assert.equal(closed.agent, PANE.agent.max, '侧栏收起后 AI 面板应能用满 760');
  assert.ok(closed.workspace >= Math.ceil((1440 - 5) * PANE.workspaceShare));

  const stillCapped = computePaneLayout({ viewport: 1440, sidebarOpen: true, agentOpen: true, agentWanted: 760 });
  assert.ok(stillCapped.agent < PANE.agent.max, '两侧都在时仍受 35% 约束');
});

test('侧栏收起时的拖拽上限也会放宽', () => {
  const l = computePaneLayout({ viewport: 1440, sidebarOpen: false, agentOpen: true, agentWanted: 384 });
  assert.equal(l.agentMax, PANE.agent.max);
  assert.ok(1440 - PANE.splitter - l.agentMax >= Math.ceil((1440 - 5) * PANE.workspaceShare));
});

test('侧栏收起 + 展开：直接吃到 760 或中间地板，不再停在 35%', () => {
  const l = computePaneLayout({ viewport: 1280, sidebarOpen: false, agentOpen: true, agentWanted: 384, agentExpanded: true });
  assert.equal(l.agent, PANE.agent.max);
  assert.ok(l.workspace >= Math.ceil((1280 - 5) * PANE.workspaceShare));
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
