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
 *   2. 左栏（连接栏）最多 35% 可用宽：它只是导航，不该吃掉工作区；
 *   3. 右栏（AI 助手）是主功能，不再和左栏共用 35% 这条线——它的上限直接由
 *      中间地板推出：「可用宽 − 地板 − 左栏」。窗口越宽能给的越多，
 *      窄窗口自动收小，始终保证中间 ≥40%，只受自身绝对上限约束；
 *   4. 装不下时按「离自己下限还有多少余量」按比例回收，而不是先压中间；
 *   5. 窗口窄到放不下三栏时退回浮层 / 抽屉，而不是把中间压到 0。
 *
 * 单位都是 CSS px（不含原生窗口边框）。
 */

export const PANE = {
  /** 分隔条本身占的宽度 */
  splitter: 5,
  sidebar: { min: 200, max: 460, fallback: 244 },
  workspace: { min: 340 },
  /**
   * AI 助手是主功能，绝对上限给到 1200：日常真正起作用的约束是
   * 「可用宽 − 中间地板 − 左栏」这个智能上限，760 时代的封顶在 2K 屏上
   * 会让右侧白留一大片空白。
   */
  agent: { min: 320, max: 1200, fallback: 384 },
  /** 左侧连接栏最多占可用宽度的 35%（它只是导航，不该吃掉工作区） */
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

  // 左栏是导航，上限按 35% 可用宽收；右栏不设比例上限，能拿多少由「中间地板 +
  // 左栏实际宽度」推出，所以窗口越宽 AI 助手越大，且中间永远不被压过地板。
  const sidebarCap = sidebarInFlow && agentInFlow ? Math.floor(avail * PANE.sideShare) : avail - workspaceFloor;

  let sidebar = clamp(safe(input.sidebarWanted, PANE.sidebar.fallback), PANE.sidebar.min, PANE.sidebar.max);
  // 参与布局的面板先按各自上限收口；浮层 / 抽屉只保留偏好值，实际宽度由样式决定
  if (sidebarInFlow) sidebar = Math.min(sidebar, Math.max(PANE.sidebar.min, Math.min(PANE.sidebar.max, sidebarCap)));

  // 右栏上限：先扣中间地板，再扣左栏已经占掉的宽度。左栏此刻已定宽，
  // 所以这条线是确定的，不需要「先假设两侧对称再按比例回收」。
  const agentCap = avail - workspaceFloor - (sidebarInFlow ? sidebar : 0);
  let agent = clamp(safe(input.agentWanted, PANE.agent.fallback), PANE.agent.min, PANE.agent.max);
  if (agentInFlow) agent = Math.min(agent, Math.max(PANE.agent.min, Math.min(PANE.agent.max, agentCap)));

  // 展开：占到「到中间地板为止」的剩余空间，同时不超过右栏上限
  if (agentInFlow && input.agentExpanded) {
    agent = clamp(agentCap, PANE.agent.min, Math.max(PANE.agent.min, Math.min(PANE.agent.max, agentCap)));
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

  // 拖拽上限。左栏按自己那条线（35% / 460）拖，多占的宽度由右栏吸收——右栏是
  // 弹性侧，agentCap 已经按「左栏实际宽度」重算过，所以中间地板始终安全。
  // 反过来右栏的上限就是 agentCap 本身，拖到头正好停在中间地板边上。
  const sidebarMax = sidebarInFlow
    ? Math.max(PANE.sidebar.min, Math.min(PANE.sidebar.max, sidebarCap))
    : PANE.sidebar.max;
  const agentMax = agentInFlow
    ? Math.max(PANE.agent.min, Math.min(PANE.agent.max, agentCap))
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
