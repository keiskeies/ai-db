/**
 * 三栏宽度算法（左：连接栏 / 中：工作区 / 右：AI 助手）。
 *
 * 之前是三处各算一套：App 里算一次 budget，Workspace 里再算一次 agentMax，
 * `.agent-panel.expanded` 又用 CSS `width: 58%` 直接抢宽度。三者互不知情，
 * 于是「展开就把中间挤成一条缝」「拖到边界时某一块突然变窄」。
 *
 * 现在统一到这里，输出「实际宽度 + 拖拽上限」，UI 只负责渲染：
 *
 *   1. 中间工作区有地板：max(340px, 40% 可用宽)，任何一侧都不能吃掉它；
 *   2. 两侧同时打开时每侧最多 35% 可用宽，中间自然 ≥40%（左中右不超过 1:3:2）；
 *      另一侧收起后腾出来的空间归剩下那块用，只受中间地板与自身绝对上限约束，
 *      否则收起侧栏后右侧会白留一大片空白；
 *   3. 装不下时按「离自己下限还有多少余量」按比例回收，而不是先压中间；
 *   4. 窗口窄到放不下三栏时退回浮层 / 抽屉，而不是把中间压到 0。
 *
 * 单位都是 CSS px（不含原生窗口边框）。
 */

export const PANE = {
  /** 分隔条本身占的宽度 */
  splitter: 5,
  sidebar: { min: 200, max: 460, fallback: 244 },
  workspace: { min: 340 },
  agent: { min: 320, max: 760, fallback: 384 },
  /** 单侧最多占可用宽度的 35%，配合中间 40% 地板 ≈ 1:3:2 */
  sideShare: 0.35,
  /** 中间工作区的硬地板：40% 或 340px，取大者 */
  workspaceShare: 0.4,
  /** 低于这两个宽度，侧栏改抽屉、AI 面板改浮层 */
  sidebarDrawerBelow: 720,
  agentOverlayBelow: 1000,
} as const;

export interface PaneLayoutInput {
  /** 内容区宽度（window.innerWidth 或容器的 clientWidth） */
  viewport: number;
  sidebarOpen?: boolean;
  agentOpen?: boolean;
  /** 用户拖出来的偏好宽度 */
  sidebarWanted?: number;
  agentWanted?: number;
  /** expand 按钮：把 AI 面板拉到当前允许的最大宽度 */
  agentExpanded?: boolean;
}

export interface PaneLayout {
  viewport: number;
  sidebar: number;
  agent: number;
  workspace: number;
  sidebarInFlow: boolean;
  agentInFlow: boolean;
  /** 拖拽时允许的上限（已扣除另一侧与中间地板） */
  sidebarMax: number;
  agentMax: number;
  /** 实际占比，便于调试与单测断言 */
  share: { sidebar: number; workspace: number; agent: number };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 数字兜底：NaN / Infinity / 负数都收敛到合理值，避免把 NaN 写进 CSS 变量 */
const safe = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? Math.max(0, value as number) : fallback;

export function computePaneLayout(input: PaneLayoutInput): PaneLayout {
  const viewport = safe(input.viewport, 0);
  const sidebarOpen = input.sidebarOpen !== false;
  const agentOpen = input.agentOpen === true;

  // 窄窗口不硬挤三栏：先用浮层，彻底没空间才让侧栏也变成抽屉
  const sidebarInFlow = sidebarOpen && viewport > PANE.sidebarDrawerBelow;
  const agentInFlow = agentOpen && viewport > PANE.agentOverlayBelow;

  const splits = (sidebarInFlow ? 1 : 0) + (agentInFlow ? 1 : 0);
  const avail = Math.max(0, viewport - splits * PANE.splitter);

  // 同一把尺子：中间地板与两侧上限都在 avail 上算，避免各让一步后总和越界
  const workspaceFloor = Math.min(avail, Math.max(PANE.workspace.min, Math.ceil(avail * PANE.workspaceShare)));

  // 右侧收起时，左侧可以吃到「除中间地板外的全部」；两侧都在才按 35% 分摊
  const bothOpen = sidebarInFlow && agentInFlow;
  const sharedCap = Math.floor(avail * PANE.sideShare);
  const sidebarCap = bothOpen ? sharedCap : avail - workspaceFloor;
  const agentCap = bothOpen ? sharedCap : avail - workspaceFloor;

  let sidebar = clamp(safe(input.sidebarWanted, PANE.sidebar.fallback), PANE.sidebar.min, PANE.sidebar.max);
  let agent = clamp(safe(input.agentWanted, PANE.agent.fallback), PANE.agent.min, PANE.agent.max);

  // 参与布局的面板先按各自上限收口；浮层 / 抽屉只保留偏好值，实际宽度由样式决定
  if (sidebarInFlow) sidebar = Math.min(sidebar, Math.max(PANE.sidebar.min, Math.min(PANE.sidebar.max, sidebarCap)));
  if (agentInFlow) agent = Math.min(agent, Math.max(PANE.agent.min, Math.min(PANE.agent.max, agentCap)));

  // 展开：占到「到中间地板为止」的剩余空间，同时不超过侧面上限
  if (agentInFlow && input.agentExpanded) {
    const room = avail - (sidebarInFlow ? sidebar : 0) - workspaceFloor;
    agent = clamp(room, PANE.agent.min, Math.max(PANE.agent.min, Math.min(PANE.agent.max, agentCap)));
  }

  // 两侧之和仍可能超过「avail - 地板」（比如两侧都拖到上限）：按余量比例回收
  const used = () => (sidebarInFlow ? sidebar : 0) + (agentInFlow ? agent : 0);
  const over = used() - (avail - workspaceFloor);
  if (over > 0) {
    const slackSidebar = sidebarInFlow ? sidebar - PANE.sidebar.min : 0;
    const slackAgent = agentInFlow ? agent - PANE.agent.min : 0;
    const slack = slackSidebar + slackAgent;
    if (slack > 0) {
      const take = Math.min(over, slack);
      const fromSidebar = Math.min(slackSidebar, Math.round((take * slackSidebar) / slack));
      const fromAgent = Math.min(slackAgent, take - fromSidebar);
      sidebar -= fromSidebar;
      agent -= fromAgent;
      // 取整误差最多 2px，谁还有余量谁补
      let rest = used() - (avail - workspaceFloor);
      while (rest > 0 && (sidebar > PANE.sidebar.min || agent > PANE.agent.min)) {
        if (agentInFlow && agent > PANE.agent.min) agent -= 1;
        else if (sidebarInFlow && sidebar > PANE.sidebar.min) sidebar -= 1;
        rest -= 1;
      }
    }
  }

  const workspace = Math.max(0, avail - used());

  // 拖拽上限：另一侧不动的前提下，最多能拖到哪（自身上限 + 中间地板 + 是否两侧同开）
  const sidebarMax = sidebarInFlow
    ? Math.max(PANE.sidebar.min, Math.min(PANE.sidebar.max, sidebarCap, avail - (agentInFlow ? agent : 0) - workspaceFloor))
    : PANE.sidebar.max;
  const agentMax = agentInFlow
    ? Math.max(PANE.agent.min, Math.min(PANE.agent.max, agentCap, avail - (sidebarInFlow ? sidebar : 0) - workspaceFloor))
    : PANE.agent.max;

  const total = Math.max(1, used() + workspace);
  return {
    viewport,
    sidebar,
    agent,
    workspace,
    sidebarInFlow,
    agentInFlow,
    sidebarMax,
    agentMax,
    share: {
      sidebar: sidebarInFlow ? sidebar / total : 0,
      workspace: workspace / total,
      agent: agentInFlow ? agent / total : 0,
    },
  };
}
