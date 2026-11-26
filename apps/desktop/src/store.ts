import { create } from 'zustand';
import type { ReactNode } from 'react';
import type {
  AgentEvent,
  AgentMessage,
  AgentPlanItem,
  AgentSessionMeta,
  AgentStopReason,
  AppSettings,
  ConnectionConfig,
  DatabaseSchema,
  DeviceInfo,
  Memory,
  PermissionMode,
  QuestionSuggestion,
  Risk,
  ToolResult,
} from '@aidb/core';
import { DEFAULT_SETTINGS, engineMeta, normalizeLocale } from '@aidb/core';
import { ApiError, api, streamTurn, type BootstrapData, type UnavailableEngine } from './lib/api';
import { NO_APPROVAL, enqueueApproval, settleApproval } from './lib/approvalQueue';
import type { TimelineItem } from './lib/agentTimeline';
import { startSchemaEvents, type ConnectionsChangedEvent } from './lib/schemaEvents';
import { getI18nLocale, setI18nLocale, translate, type I18nKey, type I18nVars } from './i18n';
import { t as tr } from './i18n';
export type Tab =
  | { id: string; kind: 'welcome'; title: string }
  | { id: string; kind: 'data'; title: string; connectionId: string; database?: string; table: string }
  | { id: string; kind: 'query'; title: string; connectionId: string; database?: string; sql: string }
  | { id: string; kind: 'design'; title: string; connectionId: string; database?: string; table?: string }
  | { id: string; kind: 'relations'; title: string; connectionId: string; database?: string }
  | { id: string; kind: 'dashboard'; title: string; connectionId: string; database?: string };

/** 设置页签；composer 等入口可指定打开位置。 */
export type SettingsTab = 'appearance' | 'query' | 'agent' | 'skills' | 'mcp' | 'capabilities' | 'search' | 'notify' | 'bridge' | 'data' | 'about';

export interface LiveTool {
  callId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  status: 'running' | 'ok' | 'error' | 'awaiting';
  summary?: string;
  result?: ToolResult;
}

/**
 * 一条回合时间线上的项目。顺序就是发生顺序——这是「思考-输出-sql-思考-输出-sql-结论」
 * 能渲染出来的唯一前提。
 *
 * 曾经没有这个数组：正文一条道累积到回合结束（live.text），工具另存一条（live.tools），
 * 界面只能把工具堆上、文字堆下，「哪句话在哪个工具之前说」当场丢了。
 * 用户原话：所有文字都挤在下面，也不知道上面在干什么，执行和解释都对应不上。
 *
 * 类型定义在 lib/agentTimeline（渲染侧也要它，那边不该反向依赖 store），这里只是 re-export。
 */
export type { TimelineItem } from './lib/agentTimeline';

export interface LiveTurn {
  generation: number;
  turnId?: string;
  userText: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  /** 已交付的时间线（思考/正文/工具/计划，按发生顺序）。 */
  timeline: TimelineItem[];
  /** 当前这一步还没交付的正文；step_text 一到就清空并入 timeline。 */
  stream: string;
  /** 当前这一步还没交付的思考；step_thinking 一到就清空并入 timeline。 */
  streamThinking: string;
  plan: AgentPlanItem[];
  status: 'streaming' | 'awaiting' | 'done' | 'aborted' | 'error';
  /** 中止原因：连接停摆不是用户点的停止，界面不能都说成「已中止」。 */
  abortCause?: 'stalled' | 'user' | 'deadline';
  /** 服务端给出的具体中止事由，界面不把预算到期或停摆改写成用户停止。 */
  abortReason?: string;
  /**
   * 回合结束的原因。'done' 不足以说明「做完了」：截断与跑满步数同样是 done，
   * 界面据此决定计划卡该不该继续转圈、要不要给「继续」。
   */
  stop?: AgentStopReason;
  /**
   * 最后一个事件到达的时刻。运行中的回合用它算「已经多久没动静」：
   * 一次大查询本来就可能几分钟不出事件，所以界面只报告等了多久，
   * 不擅自判定失败——但不能再什么都不说，那是「莫名其妙停止」最难查的一部分。
   */
  lastEventAt: number;
  error?: string;
  startedAt: number;
  /** 回合结束时间；流式期间缺省，状态条的 tok/s 用它定格。 */
  endedAt?: number;
  tokensIn: number;
  tokensOut: number;
  /** 本轮已走过的模型步数。 */
  steps: number;
  /** 本轮发生的模型调用次数。 */
  modelCalls: number;
  /** 本轮命中缓存的输入 tokens；服务商不返回缓存统计时缺省。 */
  cacheHitTokens?: number;
  /** 本轮未命中缓存的输入 tokens。 */
  cacheMissTokens?: number;
  /** 最近一次模型调用的输入 tokens，即当前上下文占用。 */
  contextTokens: number;
  /** 本轮模型调用累计耗时（不含工具执行），tok/s 的分母。 */
  modelDurationMs: number;
  memories: Array<{ id: string; title: string; kind: string }>;
  /** 本轮附带的图片附件 id，用于流式期间的用户气泡回显。 */
  userImages?: string[];
}

export interface ApprovalState {
  approvalId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  summary: string;
  sql?: string;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error' | 'warning';
  message: string;
  detail?: string;
}

export interface ConnectionEditorState {
  mode: 'new' | 'edit';
  connection?: ConnectionConfig;
}

export type ContextMenuItem =
  | { sep: true; label?: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onClick?: () => void }
  | { sep?: false; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onClick?: () => void; testId?: string };

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const UI_KEY = 'aidb.ui';

interface UiPrefs {
  sidebarOpen?: boolean;
  sidebarWidth?: number;
  agentWidth?: number;
  groupOrder?: string[];
  connectionOrder?: string[];
  hiddenColumns?: Record<string, string[]>;
  collapsedGroups?: string[];
  /** 上次使用的连接与每个连接各自记住的数据库 */
  activeConnectionId?: string;
  agentDatabaseByConnection?: Record<string, string>;
  /** 首页（当前库的家）按连接记住上次看的库；与 agentDatabaseByConnection 分开存，
      否则旧数据会把两个字段又绑回一起 */
  homeDatabaseByConnection?: Record<string, string>;
  /** 仪表板的时间范围视角按「连接/库」记住，切回来不用重新选 */
  dashboardRange?: Record<string, string>;
  /** 侧栏展开状态也跨刷新保留，不再每次自动展开连接默认库 */
  expandedConnections?: Record<string, boolean>;
  expandedSchemas?: Record<string, boolean>;
}

function readUiPrefs(): UiPrefs {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveUiPrefs(patch: UiPrefs): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...readUiPrefs(), ...patch }));
  } catch {
    /* 隐私模式写不进去也不影响使用 */
  }
}

function rememberedAgentDatabase(connectionId?: string): string {
  if (!connectionId) return '';
  return readUiPrefs().agentDatabaseByConnection?.[connectionId] ?? '';
}

interface AppStore {
  booted: boolean;
  bootError?: string;
  connections: ConnectionConfig[];
  /** 本机缺原生绑定、不可能连通的引擎；用于在建连接时置灰。 */
  unavailableEngines: UnavailableEngine[];
  settings: AppSettings;
  tools: BootstrapData['tools'];
  sessions: AgentSessionMeta[];
  schemas: Record<string, DatabaseSchema[]>;
  loadedDatabases: Record<string, string[]>;
  schemaLoading: Record<string, boolean>;
  expandedConnections: Record<string, boolean>;
  /** 外部事件展开的连接：只展开节点，不触发 schema 懒加载或默认库展开。 */
  eventExpandedConnections: Record<string, boolean>;
  expandedSchemas: Record<string, boolean>;
  activeConnectionId?: string;
  tabs: Tab[];
  activeTabId: string;
  agentOpen: boolean;
  agentFullscreen: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  agentWidth: number;
  groupOrder: string[];
  setGroupOrder: (order: string[]) => void;
  connectionOrder: string[];
  setConnectionOrder: (order: string[]) => void;
  hiddenColumns: Record<string, string[]>;
  dashboardRange: Record<string, string>;
  setHiddenColumns: (key: string, columns: string[]) => void;
  collapsedGroups: string[];
  setCollapsedGroups: (groups: string[]) => void;
  contextMenu?: ContextMenuState;
  agentSessionId?: string;
  agentSessionMeta?: AgentSessionMeta;
  agentMessages: AgentMessage[];
  /**
   * 追问建议独立于 live 存放：回合结束后 live 会被持久化消息替换掉，
   * 挂在 live 上的建议会随之消失，用户根本来不及点。
   */
  agentFollowUps: QuestionSuggestion[];
  agentMode: PermissionMode;
  /**
   * Agent 当前瞄准的库。连接不再填库名之后，这个值决定 schema、业务上下文
   * 和工具默认库；空串表示交给后端按会话/连接默认库兜底。
   */
  agentDatabase: string;
  /** 首页正在展示的库。与 agentDatabase 解耦，只由侧栏点库 / 首页库下拉写。 */
  homeDatabase: string;
  live?: LiveTurn;
  agentStarting: boolean;
  agentStartingGeneration?: number;
  /** 本地已断流，但服务端是否结束尚未确认；确认前禁止换会话或作用域。 */
  agentStopUnconfirmed: boolean;
  /** 新建/加载会话的请求在飞；期间scope 与发送都必须等它原子落地。 */
  agentSessionSwitching: boolean;
  approval?: ApprovalState;
  /**
   * 当前回合里排在 approval 后面的审批请求。一个回合可以连着要求多次审批
   * （建 5 张表 = 5 次 DDL），弹窗槽位却只有一个；把「最后一个事件」当成当前弹窗，
   * 就会在结算前一个时顺手抹掉后一个。队列显式建模，入队出队都按 approvalId 走。
   * 规则与单测在 lib/approvalQueue.ts。
   */
  approvalQueue: ApprovalState[];
  agentPrefill?: string;
  sessionsOpen: boolean;
  memoryOpen: boolean;
  memoryQuery: string;
  memories: Memory[];
  settingsOpen: boolean;
  /** 打开设置时定位的页签；空表示默认页。 */
  settingsTab?: SettingsTab;
  /** 从 MCP 目录错误跳转到设置时，预填到文件系统卡片的目录。 */
  mcpPathHint?: string;
  paletteOpen: boolean;
  toolsOpen: boolean;
  toolsActive: string;
  openTools: (tool?: string) => void;
  closeTools: () => void;
  connectionEditor?: ConnectionEditorState;
  toasts: Toast[];
  pairing?: { code: string; expiresIn: number; host: string; port: number; url?: string; qrPayload?: string; createdAt: number };
  mcpPairing?: { code: string; expiresIn: number; host: string; port: number; url?: string; createdAt: number };
  devices: DeviceInfo[];

  boot: () => Promise<void>;
  t: (key: I18nKey | string, vars?: I18nVars) => string;
  notify: (kind: Toast['kind'], message: string, detail?: string) => void;
  dismissToast: (id: string) => void;

  loadSchema: (connectionId: string, refresh?: boolean, database?: string) => Promise<void>;
  selectConnection: (id: string) => void;
  /** 只影响首页显示哪个库，绝不碰 Agent 的目标库。 */
  setHomeDatabase: (database: string) => void;
  setActiveConnection: (id?: string) => void;
  toggleConnection: (id: string) => void;
  syncConnectionsFromEvent: (event?: ConnectionsChangedEvent) => Promise<void>;
  toggleSchema: (key: string) => void;

  openData: (connectionId: string, table: string, database?: string) => void;
  printRequested: boolean;
  requestPrint: () => void;
  consumePrint: () => void;
  openQuery: (connectionId?: string, sql?: string, title?: string, database?: string) => void;
  openDesign: (connectionId?: string, table?: string, database?: string) => void;
  openRelations: (connectionId?: string, database?: string) => void;
  openDashboard: (connectionId?: string, database?: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  setDashboardRange: (scopeKey: string, value: string) => void;

  openConnectionEditor: (mode: 'new' | 'edit', connection?: ConnectionConfig) => void;
  closeConnectionEditor: () => void;
  saveConnection: (body: Record<string, unknown>) => Promise<ConnectionConfig | undefined>;
  deleteConnection: (id: string) => Promise<void>;

  setAgentOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setAgentWidth: (width: number, persist?: boolean) => void;
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
  closeContextMenu: () => void;
  setAgentFullscreen: (fullscreen: boolean) => void;
  setAgentMode: (mode: PermissionMode) => void;
  setAgentDatabase: (database: string) => Promise<void>;
  restoreSessionForScope: () => Promise<void>;
  /** 返回 false 表示被运行态拒绝（已弹提示）。 */
  requestAgentTask: (prompt: string) => Promise<boolean>;
  setSessionsOpen: (open: boolean) => void;
  newAgentSession: () => Promise<boolean>;
  /** keepMode=true 时不采用会话里存的权限档位，保留用户当前的选择（自动恢复走这条）。 */
  loadAgentSession: (id: string, opts?: { keepMode?: boolean }) => Promise<boolean>;
  deleteAgentSession: (id: string) => Promise<boolean>;
  refreshSessions: () => Promise<void>;
  sessionsForScope: (connectionId?: string, database?: string) => AgentSessionMeta[];
  renameAgentSession: (id: string, title: string) => Promise<void>;
  sendAgent: (text: string, mode?: PermissionMode, images?: string[], onAccepted?: () => void, signal?: AbortSignal) => Promise<boolean>;
  /** true 表示已确认服务端结束；false 表示创建中或停止结果仍不确定。 */
  abortAgent: () => Promise<boolean>;
  resolveApproval: (decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => Promise<void>;
  prefillAgent: (text: string) => void;
  clearPrefill: () => void;
  handleAgentEvent: (event: AgentEvent) => void;

  openMemory: () => void;
  closeMemory: () => void;
  loadMemories: (q?: string) => Promise<void>;
  addMemory: (body: Record<string, unknown>) => Promise<void>;
  saveMemory: (id: string, patch: Record<string, unknown>) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;

  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  setMcpPathHint: (path?: string) => void;
  setPaletteOpen: (open: boolean) => void;
  saveSettings: (patch: Record<string, unknown>) => Promise<void>;
  startPairing: () => Promise<void>;
  startMcpPairing: () => Promise<void>;
  loadDevices: () => Promise<void>;
  revokeDevice: (id: string) => Promise<void>;

  openBackup: () => Promise<void>;
  refreshAllSchemas: () => Promise<void>;
  applySchemaChange: (connectionId: string) => void;
  flushSchemaChanges: () => Promise<void>;
}

/**
 * 自动恢复的代次号。restoreSessionForScope 有 await，用户可能在它跑完之前
 * 又切了一次库：先发的那次不能覆盖后发的，否则界面会停在用户已经离开的库上。
 * 每发起一次自增，回来时只有代次仍是自己才落地。
 *
 * 注：loadAgentSession 用的是原始 set()，不会回调 setAgentDatabase，
 * 所以「手动点会话 → 再次触发恢复」这条路径本就不存在，不需要另设抑制标记。
 */
let restoreSeq = 0;
let sessionsRefreshSeq = 0;
let sessionSwitchSeq = 0;

const WELCOME: Tab = { id: 'welcome', kind: 'welcome', title: tr("欢迎") };
let tabSeq = 1;
let turnSeq = 0;
const TURN_SETTLE_GRACE_MS = 320;
interface AgentTurn {
  generation: number;
  sessionId?: string;
  controller?: AbortController;
  phase: 'creating' | 'streaming' | 'settling';
  cancelled: boolean;
  abortRequested: boolean;
  abortConfirmed?: boolean;
  abortConfirmation?: Promise<void>;
}
let currentTurn: AgentTurn | undefined;
let currentAbort: AbortController | undefined;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isCurrentTurn(turn: AgentTurn): boolean {
  return currentTurn === turn && !turn.cancelled;
}

function ownsTurnSession(turn: AgentTurn): boolean {
  return isCurrentTurn(turn) && (!turn.sessionId || useApp.getState().agentSessionId === turn.sessionId);
}

function ownsLive(turn: AgentTurn): boolean {
  const state = useApp.getState();
  return ownsTurnSession(turn) && Boolean(turn.sessionId) && state.agentSessionId === turn.sessionId && state.live?.generation === turn.generation;
}

function invalidateTurn(turn = currentTurn): void {
  if (!turn) return;
  turn.cancelled = true;
  if (currentTurn === turn) {
    currentTurn = undefined;
    useApp.setState({ agentStopUnconfirmed: false });
    if (useApp.getState().agentStartingGeneration === turn.generation) useApp.setState({ agentStarting: false, agentStartingGeneration: undefined });
  }
  if (turn.controller && currentAbort === turn.controller) currentAbort = undefined;
}

function agentScopeLocked(): boolean {
  const state = useApp.getState();
  return state.agentStarting || state.agentSessionSwitching || state.agentStopUnconfirmed || state.live?.status === 'streaming' || state.live?.status === 'awaiting';
}

/** 所有会改 Agent 作用域的用户入口共用；拒绝时必须有可见提示。 */
function allowAgentScopeChange(): boolean {
  if (!agentScopeLocked()) {
    sessionSwitchSeq += 1;
    restoreSeq += 1;
    return true;
  }
  useApp.getState().notify('warning', tr("Agent 正在运行，请先停止"), tr("停止确认后才能切换连接或数据库。"));
  return false;
}

/** 新建/加载会话前先停旧回合。创建中或 abort 未确认时绝不换走当前会话。 */
async function prepareAgentSessionSwitch(): Promise<boolean> {
  const turn = currentTurn;
  if (!turn) return true;
  if (turn.phase === 'creating' || useApp.getState().agentStarting) {
    useApp.getState().notify('warning', tr("Agent 正在创建会话"), tr("请等创建完成或停止后再切换会话。"));
    return false;
  }
  const live = useApp.getState().live;
  if ((live && (live.status === 'streaming' || live.status === 'awaiting')) || (turn.abortRequested && turn.abortConfirmed !== true)) {
    const confirmed = await useApp.getState().abortAgent();
    if (!confirmed || turn.abortConfirmed !== true) return false;
  }
  if (turn.abortConfirmed === false) return false;
  if (currentTurn === turn) invalidateTurn(turn);
  return true;
}

function canCommitSessionSwitch(seq: number, scope: { connectionId?: string; database: string }): boolean {
  const state = useApp.getState();
  return seq === sessionSwitchSeq
    && state.activeConnectionId === scope.connectionId
    && state.agentDatabase === scope.database
    && !currentTurn
    && !state.agentStarting
    && !state.agentStopUnconfirmed
    && state.live?.status !== 'streaming'
    && state.live?.status !== 'awaiting';
}

/**
 * 流式正文/思考 delta 的节流合并器。
 *
 * 模型每个 token 都发一帧 text_delta，若每帧都 set 一次 store，长回答会把整棵
 * Agent 树（含所有历史消息）每秒重渲染几十次。这里把 delta 攒起来，每 50ms 才
 * flush 一次到 handleAgentEvent；其它事件（工具/步骤边界/done…）先把攒着的 delta
 * 落地再立即转发，保证时间线顺序不乱。
 *
 * 节流放在 sendAgent 的派发层而不是 handleAgentEvent 内部：handleAgentEvent 保持
 * 同步语义（现有时间线单测直接调它并立即断言 stream），真实流式才走这条批量通道。
 */
const DELTA_FLUSH_MS = 50;
function createEventBatcher(handle: (event: AgentEvent) => void, isActive: () => boolean) {
  let text = '';
  let thinking = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (!isActive()) {
      text = '';
      thinking = '';
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (text) {
      const chunk = text;
      text = '';
      handle({ type: 'text_delta', text: chunk });
    }
    if (thinking) {
      const chunk = thinking;
      thinking = '';
      handle({ type: 'thinking_delta', text: chunk });
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, DELTA_FLUSH_MS);
  };
  return {
    dispatch(event: AgentEvent) {
      if (!isActive()) return;
      if (event.type === 'text_delta') {
        text += event.text;
        schedule();
        return;
      }
      if (event.type === 'thinking_delta') {
        thinking += event.text;
        schedule();
        return;
      }
      flush();
      if (isActive()) handle(event);
    },
    flush,
    reset() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      text = '';
      thinking = '';
    },
  };
}

// 结构变更合并用的模块级状态。放 state 里会让每次事件都触发订阅者重渲染，
// 而这些值只被下面几个函数读。
const schemaPending = new Map<string, true>();
const schemaInFlight = new Set<string>();
const schemaLastRefresh = new Map<string, number>();
const schemaThrottle = new Map<string, ReturnType<typeof setTimeout>>();
// loadSchema 按「连接 + 数据库」记代次：同连接的不同库可以并行内省，
// 各自的 loading 也由自己的请求收尾，不能因为旁边库的请求变成永久转圈。
const schemaReloadSeq = new Map<string, number>();
const schemaLoadingOwner = new Map<string, number>();
let schemaRequestSeq = 0;
const SCHEMA_THROTTLE_MS = 1000;

function schemaLoadKey(connectionId: string, database?: string): string {
  return database ? `${connectionId}:${database}` : connectionId;
}

function invalidateSchemaLoads(connectionId: string): void {
  for (const key of schemaReloadSeq.keys()) {
    if (key === connectionId || key.startsWith(`${connectionId}:`)) {
      schemaReloadSeq.set(key, (schemaReloadSeq.get(key) ?? 0) + 1);
    }
  }
  // 状态清理会删掉 loading 位；这里同时删owner，迟到的 finally 不会把位加回来。
  for (const key of schemaLoadingOwner.keys()) {
    if (key === connectionId || key.startsWith(`${connectionId}:`)) schemaLoadingOwner.delete(key);
  }
}
// 手动刷新后这个窗口内到达的事件跳过：用户自己刚刷过，事件是回声。
const SCHEMA_ECHO_WINDOW_MS = 1500;
// 事件驱动的重拉不应该给 echo 窗口续期：否则重拉一开始就给自己开了一个
// 1.5s 的"丢事件"窗口，期间真到达的变更会被当成回声丢掉且永不纠正。
let schemaReloadByEvent = false;
let schemaEventsStop: (() => void) | undefined;
let connectionsEventSeq = 0;

function requestSchemaReload(connectionId: string, immediate = false): void {
  const run = () => {
    schemaThrottle.delete(connectionId);
    if (schemaInFlight.has(connectionId)) {
      // 在飞请求可能早于 invalidate 发出，回来的是旧结构。丢掉这次事件就永久丢了，
      // 所以只记账，等它结束后补跑一次。
      schemaPending.set(connectionId, true);
      return;
    }
    schemaInFlight.add(connectionId);
    // 标记这次 loadSchema 是事件驱动的，别让它写 echo 时间戳（见 loadSchema 里那行）。
    schemaReloadByEvent = true;
    void useApp
      .getState()
      .loadSchema(connectionId, true)
      .catch(() => undefined)
      .finally(() => {
        schemaReloadByEvent = false;
        schemaInFlight.delete(connectionId);
        if (schemaPending.get(connectionId)) {
          schemaPending.delete(connectionId);
          requestSchemaReload(connectionId, true);
        }
      });
  };

  if (immediate) {
    const timer = schemaThrottle.get(connectionId);
    if (timer) clearTimeout(timer);
    run();
    return;
  }
  // 尾沿合并：窗口内已有一次排队就不再加。这是节流不是防抖——
  // Agent 每 2 秒改一张表时，防抖会一直往后推、永远不刷。
  if (schemaThrottle.has(connectionId)) return;
  schemaThrottle.set(connectionId, setTimeout(run, SCHEMA_THROTTLE_MS));
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function tabId(prefix: string): string {
  tabSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${tabSeq}`;
}

export const useApp = create<AppStore>((set, get) => ({
  booted: false,
  connections: [],
  unavailableEngines: [],
  settings: { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, hasApiKey: false } },
  tools: [],
  sessions: [],
  schemas: {},
  loadedDatabases: {},
  schemaLoading: {},
  expandedConnections: readUiPrefs().expandedConnections ?? {},
  eventExpandedConnections: {},
  expandedSchemas: readUiPrefs().expandedSchemas ?? {},
  tabs: [WELCOME],
  activeTabId: 'welcome',
  printRequested: false,
  agentOpen: true,
  agentFullscreen: false,
  sidebarOpen: readUiPrefs().sidebarOpen ?? true,
  sidebarWidth: readUiPrefs().sidebarWidth ?? 244,
  groupOrder: readUiPrefs().groupOrder ?? [],
  connectionOrder: readUiPrefs().connectionOrder ?? [],
  hiddenColumns: readUiPrefs().hiddenColumns ?? {},
  dashboardRange: readUiPrefs().dashboardRange ?? {},
  collapsedGroups: readUiPrefs().collapsedGroups ?? [],
  agentWidth: readUiPrefs().agentWidth ?? 384,
  agentMessages: [],
  agentFollowUps: [],
  agentStarting: false,
  agentStopUnconfirmed: false,
  agentSessionSwitching: false,
  approvalQueue: [],
  agentMode: 'ask',
  agentDatabase: '',
  homeDatabase: readUiPrefs().homeDatabaseByConnection?.[readUiPrefs().activeConnectionId ?? ''] ?? '',
  sessionsOpen: false,
  memoryOpen: false,
  memoryQuery: '',
  memories: [],
  settingsOpen: false,
  paletteOpen: false,
  toolsOpen: false,
  toolsActive: 'search',
  toasts: [],
  devices: [],

  t: (key, vars) => translate(get().settings.locale, key, vars),

  notify: (kind, message, detail) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, detail }].slice(-4) }));
    const timer = setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4200);
    toastTimers.set(id, timer);
  },

  dismissToast: (id) => {
    const timer = toastTimers.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  boot: async () => {
    try {
      const data = await api.bootstrap();
      const settings: AppSettings = { ...data.settings, locale: normalizeLocale(data.settings.locale) };
      // 模块级文案在 import 时按缓存语言定稿：与设置不一致就重载一次，避免中英混排。
      const cachedLocale = getI18nLocale();
      setI18nLocale(settings.locale);
      if (settings.locale !== cachedLocale) {
        window.location.reload();
        return;
      }
      set({
        booted: true,
        bootError: undefined,
        connections: data.connections,
        unavailableEngines: data.unavailableEngines ?? [],
        settings,
        sessions: data.sessions,
        tools: data.tools,
        agentMode: (data.sessions[0]?.permissionMode as PermissionMode) ?? 'ask',
      });
      if (data.connections.length) {
        const prefs = readUiPrefs();
        const preferred = prefs.activeConnectionId ? data.connections.find((c) => c.id === prefs.activeConnectionId) : undefined;
        const target = preferred ?? data.connections.find((c) => c.name.startsWith('Demo')) ?? data.connections[0];
        set({
          activeConnectionId: target.id,
          agentDatabase: rememberedAgentDatabase(target.id),
          // 重启后首页要停在关闭前看的那个库（§9.5(c)），不能退回连接默认库
          homeDatabase: prefs.homeDatabaseByConnection?.[target.id] ?? '',
        });
        await get().loadSchema(target.id);
      }

      if (!schemaEventsStop) {
        schemaEventsStop = startSchemaEvents({
          onChange: (event) => get().applySchemaChange(event.connectionId),
          onConnectionsChange: (event) => { void get().syncConnectionsFromEvent(event); },
          // 断线期间的事件不会补发，重连后对已知连接各刷一次。
          onReconnect: () => {
            void get().syncConnectionsFromEvent().then(() => {
              for (const conn of get().connections) requestSchemaReload(conn.id, true);
            });
          },
        });
      }
    } catch (err) {
      set({ booted: false, bootError: errorText(err) });
    }
  },

  loadSchema: async (connectionId, refresh = false, database) => {
    // 记在拉取开始而不是结束：用户点刷新到数据回来之间的这段时间到达的事件，
    // 也算"用户刚刷过"，不该再触发一次。
    // 但事件驱动的重拉不能记：那会让重拉给自己开一个丢事件窗口，
    // 期间到达的真变更被当回声丢掉，而且没有后续事件来纠正。
    const key = schemaLoadKey(connectionId, database);
    const seq = (schemaReloadSeq.get(key) ?? 0) + 1;
    const requestSeq = ++schemaRequestSeq;
    schemaReloadSeq.set(key, seq);
    schemaLoadingOwner.set(key, requestSeq);
    const clearLoading = () => {
      // 同 key 有更新请求时，旧请求不能把新请求的 loading 位清掉。
      if (schemaLoadingOwner.get(key) !== requestSeq) return;
      schemaLoadingOwner.delete(key);
      set((s) => s.schemaLoading[key] ? { schemaLoading: { ...s.schemaLoading, [key]: false } } : {});
    };
    if (refresh && !schemaReloadByEvent) schemaLastRefresh.set(connectionId, Date.now());
    const conn = get().connections.find((c) => c.id === connectionId);
    if (database) {
      set((s) => ({ schemaLoading: { ...s.schemaLoading, [key]: true } }));
      try {
        const { schemas } = await api.getSchema(connectionId, refresh, database);
        if (schemaReloadSeq.get(key) !== seq) {
          // 过期的请求不写结构；loading 由 finally 按 key 的安全owner清理。
          return;
        }
        set((s) => {
          const entry = schemas.find((item) => item.name === database) ?? { name: database, tables: schemas.flatMap((item) => item.tables) };
          const list = s.schemas[connectionId] ?? [];
          const loaded = s.loadedDatabases[connectionId] ?? [];
          return {
            schemas: {
              ...s.schemas,
              [connectionId]: list.some((item) => item.name === entry.name)
                ? list.map((item) => (item.name === entry.name ? entry : item))
                : [...list, entry],
            },
            loadedDatabases: { ...s.loadedDatabases, [connectionId]: loaded.includes(entry.name) ? loaded : [...loaded, entry.name] },
          };
        });
      } catch (err) {
        if (schemaReloadSeq.get(key) === seq) get().notify('error', get().t('error'), errorText(err));
      } finally {
        clearLoading();
      }
      return;
    }
    try {
      // conn 不在本地列表时不能直接发不带 database 的 /schema：
      // engineMeta 对未知引擎回落到 sqlite，于是这条请求对 MySQL/PG 这类
      // 「合法地没有默认库」的连接只能回 400 NO_DATABASE。先补拉一次连接列表再判引擎。
      // 事件驱动的重拉连本地快照也不能信：连接可能刚被外部（API/其他客户端）删掉，
      // 本地列表尚未更新，拿旧快照发 /schema 必 404，所以一律补拉列表确认仍在。
      const resolved = conn && !schemaReloadByEvent ? conn : (await api.connections()).connections.find((c) => c.id === connectionId);
      if (!resolved) {
        // 补拉一次连接列表仍没有它 = 已被删除（调用方拿的是删除前的快照）。
        // 静默返回：deleteConnection 已经把这条连接的 tab/schema 一起清了，
        // 没有任何东西需要刷新，弹一条错只会为一个用户已经做完的操作报错。
        return;
      }
      if (!engineMeta(resolved.engine).fileBased) {
        const { databases } = await api.databases(connectionId);
        if (schemaReloadSeq.get(key) !== seq) return;
        const previouslyLoaded = (get().loadedDatabases[connectionId] ?? []).filter((name) => databases.includes(name));
        const keep = refresh ? [] : previouslyLoaded;
        const byName = new Map((get().schemas[connectionId] ?? []).map((item) => [item.name, item]));
        const list = databases.map((name) => (keep.includes(name) ? byName.get(name) ?? { name, tables: [] } : { name, tables: [] }));
        set((s) => ({
          schemas: { ...s.schemas, [connectionId]: list },
          loadedDatabases: { ...s.loadedDatabases, [connectionId]: keep },
        }));
        // 单库引擎（ES/Redis/Mongo 等）没有可匹配的默认库时，直接预取唯一的库，
        // 否则用户从查询页选中连接只会看到一个未加载的空壳库节点。
        const single = databases.length === 1 ? databases : [];
        const targets = refresh
          ? previouslyLoaded.length
            ? previouslyLoaded
            : single
          : resolved.database && databases.includes(resolved.database)
            ? [resolved.database]
            : single;
        // 只预取默认库的表，不再自动展开它；展开状态由用户的点击决定并持久化
        for (const name of targets) void get().loadSchema(connectionId, refresh, name);
        return;
      }
      const { schemas } = await api.getSchema(connectionId, refresh);
      if (schemaReloadSeq.get(key) !== seq) return;
      set((s) => ({
        schemas: { ...s.schemas, [connectionId]: schemas },
        loadedDatabases: { ...s.loadedDatabases, [connectionId]: schemas.map((item) => item.name) },
      }));
    } catch (err) {
      if (schemaReloadSeq.get(key) === seq) get().notify('error', get().t('error'), errorText(err));
    } finally {
      clearLoading();
    }
  },

  selectConnection: (id) => {
    const eventExpandedConnections = { ...get().eventExpandedConnections };
    delete eventExpandedConnections[id];
    const previous = get().activeConnectionId;
    if (previous === id) {
      set({ eventExpandedConnections });
      if (!get().schemas[id]) void get().loadSchema(id);
      return;
    }
    if (!allowAgentScopeChange()) return;
    // 换连接时首页库走回落链：该连接上次看的库 → 空（由首页再退到连接默认库/第一个库）
    const rememberedHome = readUiPrefs().homeDatabaseByConnection?.[id] ?? '';
    set({
      activeConnectionId: id,
      eventExpandedConnections,
      agentDatabase: rememberedAgentDatabase(id),
      homeDatabase: rememberedHome,
    });
    if (!get().schemas[id]) void get().loadSchema(id);
  },

  setHomeDatabase: (database) => {
    const connId = get().activeConnectionId;
    if (connId) {
      const homeDatabaseByConnection = { ...(readUiPrefs().homeDatabaseByConnection ?? {}) };
      if (database) homeDatabaseByConnection[connId] = database;
      else delete homeDatabaseByConnection[connId];
      saveUiPrefs({ homeDatabaseByConnection });
    }
    set({ homeDatabase: database });
  },

  setActiveConnection: (id) => {
    const previous = get().activeConnectionId;
    if (previous === id) return;
    if (!allowAgentScopeChange()) return;
    set({ activeConnectionId: id, agentDatabase: rememberedAgentDatabase(id) });
  },

  toggleConnection: (id) => {
    const open = !get().expandedConnections[id];
    const expandedConnections = { ...get().expandedConnections, [id]: open };
    const eventExpandedConnections = { ...get().eventExpandedConnections };
    delete eventExpandedConnections[id];
    const previous = get().activeConnectionId;
    const canSelect = previous === id || allowAgentScopeChange();
    set({
      expandedConnections,
      eventExpandedConnections,
      ...(canSelect ? { activeConnectionId: id, ...(previous === id ? {} : { agentDatabase: rememberedAgentDatabase(id) }) } : {}),
    });
    saveUiPrefs({ expandedConnections });
    if (open && !get().schemas[id]) void get().loadSchema(id);
  },

  syncConnectionsFromEvent: async (event) => {
    const seq = ++connectionsEventSeq;
    try {
      const fetched = await api.connections();
      // 迟到响应只放弃“列表快照”，事件清理仍必须执行：例如删除 A 慢、创建 B 快时，
      // B 的快照已移除 A，但 A 的 tab/schema 不能因为 A 的响应过期而永久残留。
      const connections = seq === connectionsEventSeq ? fetched.connections : get().connections;
      const liveIds = new Set(connections.map((item) => item.id));
      const removedIds = get().connections.filter((item) => !liveIds.has(item.id)).map((item) => item.id);
      const invalidatedIds = new Set(removedIds);
      const deletedEventIsStale = event?.change === 'deleted' && liveIds.has(event.connectionId);
      if (event?.change === 'updated' || (event?.change === 'deleted' && !deletedEventIsStale)) invalidatedIds.add(event.connectionId);
      const removedTabIds = new Set(removedIds);
      if (event?.change === 'deleted' && !deletedEventIsStale) removedTabIds.add(event.connectionId);

      const expandedConnections = { ...get().expandedConnections };
      const eventExpandedConnections = { ...get().eventExpandedConnections };
      const schemas = { ...get().schemas };
      const loadedDatabases = { ...get().loadedDatabases };
      const schemaLoading = { ...get().schemaLoading };
      const expandedSchemas = { ...get().expandedSchemas };
      if (event?.change === 'created' && liveIds.has(event.connectionId)) {
        expandedConnections[event.connectionId] = true;
        eventExpandedConnections[event.connectionId] = true;
      }
      for (const id of invalidatedIds) {
        invalidateSchemaLoads(id);
        delete schemas[id];
        delete loadedDatabases[id];
        delete eventExpandedConnections[id];
        for (const key of Object.keys(schemaLoading)) if (key.startsWith(`${id}:`)) delete schemaLoading[key];
        for (const key of Object.keys(expandedSchemas)) if (key.startsWith(`${id}:`)) delete expandedSchemas[key];
      }
      for (const id of removedTabIds) delete expandedConnections[id];
      let tabs = get().tabs.filter((tab) => !('connectionId' in tab && removedTabIds.has(tab.connectionId)));
      if (!tabs.length) tabs = [WELCOME];
      const reloadSchema = event?.change === 'updated' && get().activeConnectionId === event.connectionId && Boolean(get().schemas[event.connectionId]);
      const activeConnectionId = get().activeConnectionId;
      const activeRemoved = activeConnectionId !== undefined && removedTabIds.has(activeConnectionId);
      set({
        connections,
        expandedConnections,
        eventExpandedConnections,
        schemas,
        loadedDatabases,
        schemaLoading,
        expandedSchemas,
        tabs,
        activeTabId: tabs.some((tab) => tab.id === get().activeTabId) ? get().activeTabId : tabs[0]?.id ?? 'welcome',
        ...(activeRemoved ? { activeConnectionId: connections[0]?.id, agentDatabase: '' } : {}),
      });
      saveUiPrefs({ expandedConnections });
      if (reloadSchema) void get().loadSchema(event.connectionId);
    } catch (err) {
      if (seq === connectionsEventSeq) get().notify('error', get().t('error'), errorText(err));
    }
  },

  toggleSchema: (key) => {
    const expandedSchemas = { ...get().expandedSchemas, [key]: !get().expandedSchemas[key] };
    set({ expandedSchemas });
    saveUiPrefs({ expandedSchemas });
  },

  requestPrint: () => set({ printRequested: true }),
  consumePrint: () => set({ printRequested: false }),
  openData: (connectionId, table, database) => {
    if (connectionId !== get().activeConnectionId && !allowAgentScopeChange()) return;
    const conn = get().connections.find((c) => c.id === connectionId);
    const model = conn ? engineMeta(conn.engine).model : 'relational';
    if (model === 'document' || model === 'keyvalue' || model === 'graph' || model === 'vector' || model === 'search' || model === 'widecolumn') {
      const sql =
        model === 'document'
          ? JSON.stringify({ collection: table, op: 'find', filter: {}, limit: 100 }, null, 2)
          : conn && engineMeta(conn.engine).languages.includes('aql')
            ? `FOR d IN ${table} LIMIT 100 RETURN d`
            : model === 'graph'
            ? 'MATCH (n) RETURN n LIMIT 100'
            : model === 'vector'
              ? JSON.stringify({ collection: table, op: 'scroll', topK: 20 }, null, 2)
              : model === 'search'
                ? JSON.stringify({ index: table, query: { match_all: {} }, size: 100 }, null, 2)
                : model === 'widecolumn'
                  ? `SELECT * FROM ${database ? `"${database}".` : ''}"${table}" LIMIT 100;`
                  : 'SCAN 0 COUNT 100';
      get().openQuery(connectionId, sql, table, database);
      return;
    }
    const id = `data:${connectionId}:${database ?? ''}:${table}`;
    const existing = get().tabs.find((tab) => tab.id === id);
    if (existing) {
      set({ activeTabId: id, activeConnectionId: connectionId });
      return;
    }
    const tab: Tab = { id, kind: 'data', title: table, connectionId, database, table };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.id !== 'welcome'), tab], activeTabId: id, activeConnectionId: connectionId }));
    if (!get().schemas[connectionId]) void get().loadSchema(connectionId);
    else if (database && !(get().loadedDatabases[connectionId] ?? []).includes(database)) void get().loadSchema(connectionId, false, database);
  },

  openQuery: (connectionId, sql, title, database) => {
    const connId = connectionId ?? get().activeConnectionId ?? get().connections[0]?.id;
    if (!connId) {
      get().openConnectionEditor('new');
      return;
    }
    if (connId !== get().activeConnectionId && !allowAgentScopeChange()) return;
    const conn = get().connections.find((c) => c.id === connId);
    // 库跟随左侧树选中：当前连接用实时 homeDatabase，其它连接用按连接记忆的首页库，再退到连接默认库
    const selectedDatabase =
      connId === get().activeConnectionId ? get().homeDatabase : readUiPrefs().homeDatabaseByConnection?.[connId];
    const id = tabId('query');
    const count = get().tabs.filter((t) => t.kind === 'query').length + 1;
    const tab: Tab = {
      id,
      kind: 'query',
      title: title ?? tr("查询 {0}", [count]),
      connectionId: connId,
      database: database ?? (selectedDatabase || conn?.database),
      sql: sql ?? '',
    };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.id !== 'welcome'), tab], activeTabId: id, activeConnectionId: connId }));
  },

  openDesign: (connectionId, table, database) => {
    const connId = connectionId ?? get().activeConnectionId;
    if (!connId) {
      get().openConnectionEditor('new');
      return;
    }
    const id = table ? `design:${connId}:${database ?? ''}:${table}` : tabId('design');
    const existing = get().tabs.find((t) => t.id === id);
    if (existing) {
      set({ activeTabId: id });
      return;
    }
    const conn = get().connections.find((c) => c.id === connId);
    const meta = conn ? engineMeta(conn.engine) : undefined;
    if (meta && !meta.capabilities.ddl) {
      get().notify('warning', tr("该引擎不支持可视化建表"), tr("{0} 请直接执行 DDL", [meta.label]));
      return;
    }
    const tab: Tab = {
      id,
      kind: 'design',
      title: table ? tr("设计 · {0}", [table]) : get().t('newTable'),
      connectionId: connId,
      database,
      table,
    };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.id !== 'welcome'), tab], activeTabId: id }));
    if (!get().schemas[connId]) void get().loadSchema(connId);
    else if (database && !(get().loadedDatabases[connId] ?? []).includes(database)) void get().loadSchema(connId, false, database);
  },

  openRelations: (connectionId, database) => {
    const connId = connectionId ?? get().activeConnectionId;
    if (!connId) {
      get().openConnectionEditor('new');
      return;
    }
    if (connId !== get().activeConnectionId && !allowAgentScopeChange()) return;
    const conn = get().connections.find((c) => c.id === connId);
    if (conn && engineMeta(conn.engine).model !== 'relational') {
      get().notify('warning', tr("该引擎没有关系图"), engineMeta(conn.engine).label);
      return;
    }
    const id = `relations:${connId}:${database ?? ''}`;
    const existing = get().tabs.find((tab) => tab.id === id);
    if (existing) {
      set({ activeTabId: id });
      return;
    }
    const tab: Tab = { id, kind: 'relations', title: tr("关系图"), connectionId: connId, database };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.id !== 'welcome'), tab], activeTabId: id, activeConnectionId: connId }));
    if (!get().schemas[connId]) void get().loadSchema(connId);
    else if (database && !(get().loadedDatabases[connId] ?? []).includes(database)) void get().loadSchema(connId, false, database);
  },

  openDashboard: (connectionId, database) => {
    const connId = connectionId ?? get().activeConnectionId;
    if (!connId) {
      get().openConnectionEditor('new');
      return;
    }
    if (connId !== get().activeConnectionId && !allowAgentScopeChange()) return;
    const conn = get().connections.find((c) => c.id === connId);
    if (conn && !engineMeta(conn.engine).languages.includes('sql')) {
      get().notify('warning', tr("该引擎没有仪表板"), tr("{0} 的查询结果不是表格图表，放不进卡片", [engineMeta(conn.engine).label]));
      return;
    }
    const db = database ?? conn?.database;
    const id = `dashboard:${connId}:${db ?? ''}`;
    if (get().tabs.find((tab) => tab.id === id)) {
      set({ activeTabId: id, activeConnectionId: connId });
      return;
    }
    const tab: Tab = { id, kind: 'dashboard', title: tr("仪表板"), connectionId: connId, database: db };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.id !== 'welcome'), tab], activeTabId: id, activeConnectionId: connId }));
    if (!get().schemas[connId]) void get().loadSchema(connId);
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    if (!next.length) {
      set({ tabs: [WELCOME], activeTabId: 'welcome' });
      return;
    }
    set({ tabs: next, activeTabId: activeTabId === id ? next[Math.max(0, index - 1)]?.id ?? next[0].id : activeTabId });
  },

  closeOtherTabs: (id) => {
    const keep = get().tabs.find((tab) => tab.id === id) ?? WELCOME;
    set({ tabs: [keep], activeTabId: keep.id });
  },

  closeAllTabs: () => set({ tabs: [WELCOME], activeTabId: 'welcome' }),

  setActiveTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && 'connectionId' in tab && tab.connectionId !== get().activeConnectionId && !allowAgentScopeChange()) return;
    set({ activeTabId: id, ...(tab && 'connectionId' in tab ? { activeConnectionId: tab.connectionId } : {}) });
  },

  updateTab: (id, patch) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? ({ ...tab, ...patch } as Tab) : tab)) }));
  },

  setDashboardRange: (scopeKey, value) => {
    const next = { ...get().dashboardRange, [scopeKey]: value };
    set({ dashboardRange: next });
    saveUiPrefs({ dashboardRange: next });
  },

  openConnectionEditor: (mode, connection) => set({ connectionEditor: { mode, connection } }),
  closeConnectionEditor: () => set({ connectionEditor: undefined }),

  saveConnection: async (body) => {
    try {
      const current = get().connectionEditor;
      const creating = !(current?.mode === 'edit' && current.connection);
      const result = current?.mode === 'edit' && current.connection ? await api.updateConnection(current.connection.id, body) : await api.createConnection(body);
      const seq = ++connectionsEventSeq;
      const fetched = await api.connections();
      const currentConnections = get().connections;
      const connections = seq === connectionsEventSeq
        ? fetched.connections
        : currentConnections.some((item) => item.id === result.connection.id)
          ? currentConnections.map((item) => item.id === result.connection.id ? result.connection : item)
          : [...currentConnections, result.connection];
      const previousActive = get().activeConnectionId;
      const canActivate = previousActive === result.connection.id || allowAgentScopeChange();
      const expandedConnections = { ...get().expandedConnections, [result.connection.id]: true };
      const eventExpandedConnections = { ...get().eventExpandedConnections };
      delete eventExpandedConnections[result.connection.id];
      set({
        connections,
        connectionEditor: undefined,
        ...(canActivate ? { activeConnectionId: result.connection.id } : {}),
        expandedConnections,
        eventExpandedConnections,
        schemas: { ...get().schemas, [result.connection.id]: get().schemas[result.connection.id] ?? [] },
        ...(canActivate && previousActive !== result.connection.id ? { agentDatabase: '' } : {}),
      });
      saveUiPrefs({ expandedConnections });
      get().notify('success', get().t('saved'));
      void get().loadSchema(result.connection.id).then(() => {
        // 只对新建连接打开一次它的默认库，方便看到表；已有连接仍尊重用户手动展开/收起
        const database = creating ? result.connection.database : undefined;
        if (!database) return;
        const key = `${result.connection.id}:${database}`;
        const expandedSchemas = { ...get().expandedSchemas, [key]: true };
        set({ expandedSchemas });
        saveUiPrefs({ expandedSchemas });
      });
      return result.connection;
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
      return undefined;
    }
  },

  deleteConnection: async (id) => {
    try {
      await api.deleteConnection(id);
      await get().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: id, change: 'deleted', at: new Date().toISOString() });
      get().notify('success', get().t('saved'));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  setAgentOpen: (open) => set({ agentOpen: open }),
  setAgentFullscreen: (fullscreen) => set({ agentFullscreen: fullscreen }),
  toggleSidebar: () => {
    const sidebarOpen = !get().sidebarOpen;
    set({ sidebarOpen });
    saveUiPrefs({ sidebarOpen });
  },

  setSidebarWidth: (width, persist) => {
    set({ sidebarWidth: width });
    if (persist) saveUiPrefs({ sidebarWidth: width });
  },

  setAgentWidth: (width, persist) => {
    set({ agentWidth: width });
    if (persist) saveUiPrefs({ agentWidth: width });
  },
  setGroupOrder: (order) => {
    set({ groupOrder: order });
    saveUiPrefs({ groupOrder: order });
  },
  setConnectionOrder: (order) => {
    set({ connectionOrder: order });
    saveUiPrefs({ connectionOrder: order });
  },
  setHiddenColumns: (key, columns) => {
    const next = { ...get().hiddenColumns, [key]: columns };
    set({ hiddenColumns: next });
    saveUiPrefs({ hiddenColumns: next });
  },
  setCollapsedGroups: (groups) => {
    set({ collapsedGroups: groups });
    saveUiPrefs({ collapsedGroups: groups });
  },

  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),

  closeContextMenu: () => set((s) => (s.contextMenu ? { contextMenu: undefined } : {})),

  setAgentMode: (mode) => set({ agentMode: mode }),

  setAgentDatabase: async (database) => {
    const previous = get().agentDatabase;
    if (previous === database) return;
    if (!allowAgentScopeChange()) return;
    set({ agentDatabase: database });
    // 选完就落库：否则重开会话会退回连接默认库，历史对话和实际执行对不上
    const id = get().agentSessionId;
    if (id) void api.updateSession(id, { database }).catch(() => undefined);
    // 换库 → 自动接上该库最近的那条会话
    await get().restoreSessionForScope();
  },

  /**
   * 首页等「外部入口」触发 Agent 的唯一通道。
   * 先判运行态：正在回答时直接拒绝，连库都不切 —— 否则会出现
   * 「目标库变了但会话没换」的半截状态，下一次提问就落到错库上。
   */
  requestAgentTask: async (prompt) => {
    if (agentScopeLocked()) {
      get().notify('warning', tr("Agent 正在回答，请等这一轮结束再操作"));
      return false;
    }
    // 先把目标库对齐、等会话真的换过去，再填词：否则用户可能在旧会话里
    // 敲下回车，而库已经是新的，这一问就落到错库上。
    const target = get().homeDatabase;
    if (target && target !== get().agentDatabase) await get().setAgentDatabase(target);
    set({ agentOpen: true });
    get().prefillAgent(prompt);
    return true;
  },

  /**
   * 把界面切到「当前库最近一条会话」。触发方只有 setAgentDatabase。
   * 从 refresh 到详情回包都占住 sessionSwitchSeq / agentSessionSwitching，
   * 发送与其它切换不能插进来；提交前再核对作用域和回合归属。
   */
  restoreSessionForScope: async () => {
    if (agentScopeLocked()) return;
    const seq = ++sessionSwitchSeq;
    restoreSeq += 1;
    set({ agentSessionSwitching: true });
    try {
      if (!await prepareAgentSessionSwitch() || seq !== sessionSwitchSeq) return;
      const scope = { connectionId: get().activeConnectionId, database: get().agentDatabase };
      await get().refreshSessions();
      if (!canCommitSessionSwitch(seq, scope)) return;
      const recent = get().sessionsForScope(scope.connectionId, scope.database || undefined)[0];
      if (recent) {
        const detail = await api.getSession(recent.id);
        if (!canCommitSessionSwitch(seq, scope)) return;
        set({
          agentSessionId: recent.id,
          agentSessionMeta: detail.session,
          agentMessages: detail.messages,
          agentFollowUps: [],
          live: undefined,
          agentStopUnconfirmed: false,
          ...NO_APPROVAL,
          agentOpen: true,
          sessionsOpen: false,
          agentDatabase: detail.session.database ?? '',
          activeConnectionId: detail.session.connectionId ?? scope.connectionId,
        });
        if (detail.session.connectionId && !get().schemas[detail.session.connectionId]) void get().loadSchema(detail.session.connectionId);
        return;
      }
      // 该库还没有会话：清成空白，但不建后端会话（首条消息时才创建，
      // 否则切几次库就堆几个空会话）。
      set({
        agentSessionId: undefined,
        agentSessionMeta: undefined,
        agentMessages: [],
        agentFollowUps: [],
        live: undefined,
        ...NO_APPROVAL,
        agentDatabase: scope.database,
      });
    } catch (err) {
      if (seq === sessionSwitchSeq) get().notify('error', get().t('error'), errorText(err));
    } finally {
      if (seq === sessionSwitchSeq) set({ agentSessionSwitching: false });
    }
  },
  setSessionsOpen: (open) => set({ sessionsOpen: open }),

  refreshSessions: async () => {
    const seq = ++sessionsRefreshSeq;
    try {
      const { sessions } = await api.sessions();
      if (seq === sessionsRefreshSeq) set({ sessions });
    } catch {
      /* ignore */
    }
  },

  /**
   * 当前作用域内的会话。过滤只在这一层做，refreshSessions 始终拉全量 ——
   * 否则全局 sessions 会被写成某个库的子集，切回别的库就变成空列表。
   * connectionId / database 为空的历史会话一律放行：藏起来会被当成丢数据。
   * 比较不做大小写归一（MySQL 在 Linux 上库名大小写敏感）。
   */
  sessionsForScope: (connectionId, database) =>
    get().sessions.filter(
      (s) =>
        (!connectionId || !s.connectionId || s.connectionId === connectionId) &&
        (!database || !s.database || s.database === database),
    ),

  renameAgentSession: async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const { session } = await api.updateSession(id, { title: trimmed });
      // 本地同步：列表行与当前会话头都要跟着改，否则得等下一次 refresh 才看得到
      set((prev) => ({
        sessions: prev.sessions.map((item) => (item.id === id ? session : item)),
        agentSessionMeta: prev.agentSessionMeta?.id === id ? session : prev.agentSessionMeta,
      }));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  newAgentSession: async () => {
    const seq = ++sessionSwitchSeq;
    restoreSeq += 1;
    set({ agentSessionSwitching: true });
    try {
      if (!await prepareAgentSessionSwitch() || seq !== sessionSwitchSeq) return false;
      // abort 确认后才取作用域快照；请求在飞时 scope/发送均被锁住，回包只做一次提交。
      const snapshot = {
        connectionId: get().activeConnectionId,
        database: get().agentDatabase || undefined,
        permissionMode: get().agentMode,
      };
      const { session } = await api.createSession(snapshot);
      if (seq !== sessionSwitchSeq) return false;
      set({
        agentSessionId: session.id,
        agentSessionMeta: session,
        agentDatabase: session.database ?? snapshot.database ?? '',
        agentMessages: [],
        agentFollowUps: [],
        live: undefined,
        agentStopUnconfirmed: false,
        ...NO_APPROVAL,
        agentOpen: true,
        sessionsOpen: false,
      });
      await get().refreshSessions();
      return true;
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
      return false;
    } finally {
      if (seq === sessionSwitchSeq) set({ agentSessionSwitching: false });
    }
  },

  loadAgentSession: async (id, opts) => {
    const seq = ++sessionSwitchSeq;
    restoreSeq += 1;
    set({ agentSessionSwitching: true });
    try {
      if (!await prepareAgentSessionSwitch() || seq !== sessionSwitchSeq) return false;
      const detail = await api.getSession(id);
      if (seq !== sessionSwitchSeq) return false;
      set({
        agentSessionId: id,
        agentSessionMeta: detail.session,
        agentMessages: detail.messages,
        agentFollowUps: [],
        live: undefined,
        agentStopUnconfirmed: false,
        ...NO_APPROVAL,
        agentOpen: true,
        sessionsOpen: false,
        // 权限档位是「当前的安全意图」，不是会话的内容属性。
        // 自动恢复换会话时不能连档位一起搬 —— 否则用户没做任何操作，
        // 权限就被一条历史 full 会话悄悄提到了全自动写入。
        ...(opts?.keepMode ? {} : { agentMode: detail.session.permissionMode }),
        agentDatabase: detail.session.database ?? '',
        activeConnectionId: detail.session.connectionId ?? get().activeConnectionId,
      });
      if (detail.session.connectionId && !get().schemas[detail.session.connectionId]) void get().loadSchema(detail.session.connectionId);
      return true;
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
      return false;
    } finally {
      if (seq === sessionSwitchSeq) set({ agentSessionSwitching: false });
    }
  },

  deleteAgentSession: async (id) => {
    const seq = ++sessionSwitchSeq;
    restoreSeq += 1;
    set({ agentSessionSwitching: true });
    try {
      if (!await prepareAgentSessionSwitch() || seq !== sessionSwitchSeq) return false;
      await api.deleteSession(id);
      if (seq !== sessionSwitchSeq) return false;
      if (get().agentSessionId === id) set({ agentSessionId: undefined, agentSessionMeta: undefined, agentMessages: [], agentFollowUps: [], live: undefined, agentStopUnconfirmed: false, ...NO_APPROVAL });
      await get().refreshSessions();
      return true;
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
      return false;
    } finally {
      if (seq === sessionSwitchSeq) set({ agentSessionSwitching: false });
    }
  },

  handleAgentEvent: (event) => {
    set((prev) => {
      if (!prev.live) return {};
      // done/aborted/error 之后不再接受迟到的事件，避免把已收尾的 live 又改回运行态。
      // 但 suggestions 是服务端在 done 之后才补发的元数据，不属于回合展示状态，
      // 必须放行，否则追问建议会被这条守卫静默吞掉。
      if (
        (prev.live.status === 'done' || prev.live.status === 'aborted' || prev.live.status === 'error') &&
        event.type !== 'suggestions'
      ) {
        return {};
      }
      if (event.type === 'start') {
        if (event.sessionId !== prev.agentSessionId) return {};
        if (prev.live.turnId && prev.live.turnId !== event.turnId) return {};
      } else if ((event.type === 'done' || event.type === 'aborted') && prev.live.turnId && prev.live.turnId !== event.turnId) {
        return {};
      }
      // 只浅拷 live 本身；tools/plan/timeline/memories 仅在对应事件真正改动时才换新引用，
      // 没变就沿用旧引用——这样流式期间 memo 化的工具卡/计划卡/历史消息不会被无谓重渲染。
      const live = { ...prev.live };
      // 每个事件都刷新「最后一次有动静」的时刻：静默多久是界面判断「该说句话了」的唯一依据。
      live.lastEventAt = Date.now();
      /** 已入账的正文，用于把 live.text 保持成「整回合」而不是「当前这一步」。 */
      const committedText = () => live.timeline.filter((item) => item.kind === 'text').map((item) => item.text).join('\n\n');
      switch (event.type) {
        case 'start':
          live.turnId = event.turnId;
          live.status = 'streaming';
          break;
        case 'text_delta':
          live.text += event.text;
          live.stream += event.text;
          break;
        case 'text_replace':
          // XML 兜底改写的是**当前这一步**的正文。以前这里直接 live.text = event.text，
          // 于是第二步触发兜底时会把第一步说过的话从屏幕上抹掉。
          live.stream = event.text;
          live.text = [committedText(), event.text].filter(Boolean).join('\n\n');
          break;
        case 'thinking_delta':
          live.thinking += event.text;
          live.streamThinking += event.text;
          break;
        // 步骤边界：这一步的正文/思考说完了，下面接它的工具。顺序即渲染顺序。
        case 'step_text':
          live.timeline = [...live.timeline, { kind: 'text', text: event.text, step: event.step }];
          live.stream = '';
          break;
        case 'step_thinking':
          live.timeline = [...live.timeline, { kind: 'thinking', text: event.text, step: event.step }];
          live.streamThinking = '';
          break;
        case 'tool_call':
          live.tools = [
            ...live.tools,
            {
              callId: event.callId,
              tool: event.tool,
              args: event.args,
              risk: event.risk,
              status: 'running',
              summary: event.summary,
            },
          ];
          live.timeline = [...live.timeline, { kind: 'tool', callId: event.callId }];
          break;
        case 'tool_result': {
          // 只换被回填的那一个工具对象，其余工具引用保持不变。
          live.tools = live.tools.map((t) => (t.callId === event.callId ? { ...t, status: event.result.ok ? 'ok' : 'error', result: event.result } : t));
          live.status = 'streaming';
          break;
        }
        case 'approval_required':
          live.status = 'awaiting';
          live.tools = live.tools.map((t) => (t.tool === event.call.tool && t.status === 'running' ? { ...t, status: 'awaiting' } : t));
          return {
            live,
            ...enqueueApproval(prev, {
              approvalId: event.approvalId,
              tool: event.call.tool,
              args: event.call.args,
              risk: event.call.risk,
              summary: event.call.summary,
              sql: event.call.sql,
            }),
          };
        case 'approval_resolved': {
          // 按 id 出队而不是整槽清空：SSE 与用户点击是两条通道，
          // 谁先把槽位改成下一条 approval 不确定，无差别清空会连带抹掉正在显示的那条
          // （它会挂到 Bridge 的 5 分钟超时被自动拒绝 = 「后面的弹窗弹不出来」）。
          const settled = settleApproval(prev, event.approvalId);
          // 提上来下一个就还是「等用户」，不能闪回 streaming，否则状态条在
          // 连续审批之间会一路乱跳。settleApproval 只有动过槽位才带 approval 键。
          const stillPending = 'approval' in settled ? settled.approval : prev.approval;
          live.status = stillPending ? 'awaiting' : 'streaming';
          return { live, ...settled };
        }
        case 'plan':
          live.plan = event.items;
          break;
        case 'memory_used':
          live.memories = event.memories;
          break;
        case 'suggestions':
          return { live, agentFollowUps: event.items };
        case 'usage':
          live.tokensIn += event.tokensIn;
          live.tokensOut += event.tokensOut;
          live.contextTokens = event.tokensIn;
          live.modelDurationMs += event.durationMs ?? 0;
          if (event.cacheHitTokens !== undefined) live.cacheHitTokens = (live.cacheHitTokens ?? 0) + event.cacheHitTokens;
          if (event.cacheMissTokens !== undefined) live.cacheMissTokens = (live.cacheMissTokens ?? 0) + event.cacheMissTokens;
          break;
        case 'turn_usage':
          live.steps = event.steps;
          live.modelCalls = event.modelCalls;
          live.tokensIn = event.tokensIn;
          live.tokensOut = event.tokensOut;
          live.contextTokens = event.contextTokens;
          live.modelDurationMs = event.modelDurationMs;
          if (event.cacheHitTokens !== undefined) live.cacheHitTokens = event.cacheHitTokens;
          if (event.cacheMissTokens !== undefined) live.cacheMissTokens = event.cacheMissTokens;
          break;
        case 'done':
          live.status = 'done';
          live.stop = event.stop ?? 'end_turn';
          live.endedAt = Date.now();
          return { live, ...NO_APPROVAL };
        case 'aborted':
          live.status = 'aborted';
          live.abortCause = event.cause ?? 'user';
          live.abortReason = event.reason;
          live.endedAt = Date.now();
          return { live, ...NO_APPROVAL };
        case 'error':
          live.status = 'error';
          live.error = event.message;
          // 截断这类错误是「没做完」而不是「做错了」：stop 一路带过来，
          // 界面才知道这里该给「继续」，而不是只给一句红色的失败。
          if (event.stop) live.stop = event.stop;
          live.endedAt = Date.now();
          return { live, ...NO_APPROVAL };
        default:
          break;
      }
      return { live };
    });
    if (event.type === 'error') get().notify('error', get().t('agentError'), event.message);
  },

  sendAgent: async (text, mode, images, onAccepted, signal) => {
    const trimmed = text.trim();
    if (!trimmed || signal?.aborted) return false;
    if (agentScopeLocked() || currentTurn?.phase === 'creating' || (currentTurn?.abortRequested && currentTurn.abortConfirmed !== true)) {
      get().notify('warning', tr("Agent 正在运行，请先停止"));
      return false;
    }
    const connectionId = get().activeConnectionId;
    const database = get().agentDatabase || undefined;
    const controller = new AbortController();
    const turn: AgentTurn = { generation: ++turnSeq, phase: 'creating', cancelled: false, abortRequested: false, controller };
    const cancelRequest = () => {
      controller.abort();
      if (!isCurrentTurn(turn)) return;
      if (turn.phase === 'creating') invalidateTurn(turn);
      else if (!turn.abortRequested) void get().abortAgent();
    };
    signal?.addEventListener('abort', cancelRequest, { once: true });
    currentTurn = turn;
    currentAbort = controller;
    if (signal?.aborted) cancelRequest();
    if (!isCurrentTurn(turn)) {
      signal?.removeEventListener('abort', cancelRequest);
      return false;
    }
    let sessionId = get().agentSessionId;
    let accepted = false;
    const previousLive = get().live;
    const batcher = createEventBatcher((event) => get().handleAgentEvent(event), () => ownsLive(turn));
    set({ agentStarting: true, agentStartingGeneration: turn.generation, agentStopUnconfirmed: false });
    try {
      if (!sessionId) {
        const { session } = await api.createSession({ connectionId, database, permissionMode: mode ?? get().agentMode }, controller.signal);
        if (!isCurrentTurn(turn) || get().activeConnectionId !== connectionId || (get().agentDatabase || undefined) !== database) return false;
        sessionId = session.id;
        turn.sessionId = sessionId;
        set({ agentSessionId: session.id, agentSessionMeta: session, agentMessages: [] });
      } else {
        turn.sessionId = sessionId;
      }
      if (!isCurrentTurn(turn) || get().agentSessionId !== sessionId) return false;
      const permission = mode ?? get().agentMode;
      turn.phase = 'streaming';
      set({
        agentMode: permission,
        agentStarting: false,
        agentStartingGeneration: undefined,
        ...NO_APPROVAL,
        agentFollowUps: [],
        live: {
          generation: turn.generation,
          userText: trimmed,
          text: '',
          thinking: '',
          tools: [],
          timeline: [],
          stream: '',
          streamThinking: '',
          plan: [],
          status: 'streaming',
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          tokensIn: 0,
          tokensOut: 0,
          steps: 0,
          modelCalls: 0,
          contextTokens: 0,
          modelDurationMs: 0,
          memories: [],
          ...(images?.length ? { userImages: images } : {}),
        },
      });
      const attachments = [...new Set([...trimmed.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
      await streamTurn(
        sessionId,
        { text: trimmed, mode: permission, attachments, ...(images?.length ? { images } : {}), connectionId, database },
        (event) => {
          if (!accepted && event.type !== 'error' && ownsLive(turn)) {
            accepted = true;
            onAccepted?.();
          }
          batcher.dispatch(event);
        },
        controller.signal,
      );
      if (!accepted && !turn.abortRequested && ownsLive(turn)) set({ live: previousLive });
      return accepted;
    } catch (err) {
      if (turn.abortConfirmation) await turn.abortConfirmation;
      if ((err as Error)?.name !== 'AbortError' && ownsTurnSession(turn)) {
        get().notify('error', get().t('agentError'), errorText(err));
        if (accepted && ownsLive(turn)) {
          const channelIdle = (err as { code?: string })?.code === 'TURN_CHANNEL_IDLE';
          set((prev) => prev.live && (prev.live.status === 'streaming' || prev.live.status === 'awaiting')
            ? { live: { ...prev.live, status: 'error', error: errorText(err), endedAt: Date.now(), ...(channelIdle ? { stop: 'channel_idle' as const } : {}) }, ...NO_APPROVAL }
            : {},
          );
        } else if (!accepted && ownsLive(turn)) {
          set({ live: previousLive });
        }
      }
      return accepted;
    } finally {
      if (turn.abortConfirmation) await turn.abortConfirmation;
      turn.phase = 'settling';
      batcher.flush();
      if (turn.controller && currentAbort === turn.controller) currentAbort = undefined;
      const startedAt = ownsLive(turn) ? get().live?.startedAt : undefined;
      if (accepted && sessionId && ownsLive(turn) && (!turn.abortRequested || turn.abortConfirmed)) {
        try {
          let detail = await api.getSession(sessionId, controller.signal);
          // SSE 干净 EOF 只说明通道关了，不代表服务端回合已结束。第一次详情仍是
          // running 就保留 live/停止入口，320ms 后重新 GET，绝不用等待前的快照收尾。
          if (detail.session.status === 'running' && !turn.abortRequested && ownsLive(turn)) {
            await new Promise((resolve) => setTimeout(resolve, TURN_SETTLE_GRACE_MS));
            if (!turn.abortRequested && ownsLive(turn)) detail = await api.getSession(sessionId, controller.signal);
          }
          // 等待期间用户点了停止但确认失败时，不能拿旧详情把错误态和重试入口清掉。
          if (ownsLive(turn) && !(turn.abortRequested && turn.abortConfirmed !== true)) {
            if (detail.session.status === 'running' && !turn.abortRequested) {
              // 本地流已断而服务端仍明确在跑：继续锁住作用域，并保留重试停止入口。
              set({ agentStopUnconfirmed: true });
            } else {
              const remaining = startedAt ? Math.max(0, TURN_SETTLE_GRACE_MS - (Date.now() - startedAt)) : 0;
              if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
              if (ownsLive(turn)) set({ agentSessionMeta: detail.session, agentMessages: detail.messages, live: undefined });
            }
          }
        } catch {
          if (ownsLive(turn)) {
            const live = get().live;
            if (live && (live.status === 'streaming' || live.status === 'awaiting')) {
              set({
                live: {
                  ...live,
                  status: 'error',
                  endedAt: Date.now(),
                  error: live.error ?? tr("本轮已结束，但历史读取失败（网络或网关异常），这里显示的是本地缓存的进度，可能与实际不完全一致。"),
                },
              });
            }
          }
        }
      }
      if (currentTurn === turn) {
        const abortUnconfirmed = turn.abortRequested && turn.abortConfirmed !== true;
        if (!abortUnconfirmed) {
          currentTurn = undefined;
          await get().refreshSessions();
          await get().flushSchemaChanges();
        }
        if (get().agentStartingGeneration === turn.generation) set({ agentStarting: false, agentStartingGeneration: undefined });
      }
      signal?.removeEventListener('abort', cancelRequest);
    }
  },

  abortAgent: async () => {
    let turn = currentTurn;
    if (!turn) {
      const state = get();
      if (!state.agentStopUnconfirmed || !state.agentSessionId || !state.live) return true;
      turn = {
        generation: state.live.generation,
        sessionId: state.agentSessionId,
        phase: 'settling',
        cancelled: false,
        abortRequested: true,
        abortConfirmed: false,
      };
      currentTurn = turn;
    }
    if (turn.phase === 'creating') {
      invalidateTurn(turn);
      turn.controller?.abort();
      return false;
    }
    if (!turn.sessionId || !ownsLive(turn)) return false;
    const retryUnconfirmed = turn.abortRequested && turn.abortConfirmed === false;
    const live = get().live;
    if (!retryUnconfirmed && live && (live.status === 'done' || live.status === 'aborted' || live.status === 'error')) {
      turn.controller?.abort();
      set({ ...NO_APPROVAL, agentStopUnconfirmed: false });
      return true;
    }
    if (!retryUnconfirmed && turn.abortRequested) {
      if (turn.abortConfirmation) await turn.abortConfirmation;
      return turn.abortConfirmed === true;
    }
    const sessionId = turn.sessionId;
    turn.abortRequested = true;
    turn.abortConfirmation = (async () => {
      try {
        await api.abort(sessionId);
        turn.abortConfirmed = true;
        const wasUnconfirmed = get().agentStopUnconfirmed;
        set((prev) => ({
          agentStopUnconfirmed: false,
          live: prev.live && (prev.live.status === 'streaming' || prev.live.status === 'awaiting' || wasUnconfirmed)
            ? { ...prev.live, status: 'aborted', abortCause: 'user', error: undefined, endedAt: Date.now() }
            : prev.live,
          ...NO_APPROVAL,
        }));
      } catch (err) {
        const current = get().live;
        const alreadySettled = ownsLive(turn) && current && (
          current.status === 'done' || current.status === 'aborted' || (current.status === 'error' && !get().agentStopUnconfirmed)
        );
        if (alreadySettled) {
          turn.abortConfirmed = true;
          set({ ...NO_APPROVAL, agentStopUnconfirmed: false });
          return;
        }
        turn.abortConfirmed = false;
        const message = tr("本地连接已停止，但未能确认服务端是否结束；请稍后重试停止。");
        if (ownsLive(turn)) {
          set((prev) => ({
            agentStopUnconfirmed: true,
            live: prev.live ? { ...prev.live, status: 'error', error: message, endedAt: Date.now() } : prev.live,
            ...NO_APPROVAL,
          }));
        } else {
          set({ agentStopUnconfirmed: true });
        }
        get().notify('error', tr("停止请求未确认"), `${message} ${errorText(err)}`);
      }
    })();
    turn.controller?.abort();
    await turn.abortConfirmation;
    const confirmed = turn.abortConfirmed === true;
    if (confirmed && turn.phase === 'settling') {
      invalidateTurn(turn);
      void get().refreshSessions();
      void get().flushSchemaChanges();
    }
    return confirmed;
  },

  resolveApproval: async (decision, scope) => {
    const approval = get().approval;
    if (!approval) return;
    const approvalId = approval.approvalId;
    const generation = get().live?.generation;
    const sessionId = get().agentSessionId;
    try {
      await api.approve(approvalId, decision, scope);
    } catch (err) {
      // 404 = Bridge 那边已经没有这个 pending 了（超时自动拒绝 / 用户中止 / 回合收尾）。
      // 弹窗继续挂着只会让人多点一次没反应的按钮，按已结算处理并放下一个进来。
      if ((err as { status?: number })?.status !== 404) {
        get().notify('error', get().t('error'), errorText(err));
        return;
      }
    }
    // 结算必须按 id 生效：POST 在飞的这段时间里 SSE 可能已经推进到下一个 approval
    // 并在弹窗显示，无差别清空会把那一个一起抹掉——它会挂到 5 分钟超时被自动拒绝，
    // 表现为「后面的提问弹窗弹不出来」。
    set((prev) => {
      if (prev.agentSessionId !== sessionId || prev.live?.generation !== generation) return {};
      const settled = settleApproval(prev, approvalId);
      // 槽位里还压着下一条（刚从队列提上来，或本来就是别的 id 挂在屏上）时，
      // 状态仍是「等用户」，不能闪回 streaming —— 与 SSE 的 approval_resolved 同一条规则，
      // 否则这里会在弹窗还开着的时候把状态条改成「运行中」。
      const stillPending = 'approval' in settled ? settled.approval : prev.approval;
      return {
        ...settled,
        live: prev.live && prev.live.status === 'awaiting' && !stillPending ? { ...prev.live, status: 'streaming' } : prev.live,
      };
    });
  },

  prefillAgent: (text) => set({ agentOpen: true, agentPrefill: text }),
  clearPrefill: () => set({ agentPrefill: undefined }),

  openMemory: () => {
    set({ memoryOpen: true });
    void get().loadMemories();
  },
  closeMemory: () => set({ memoryOpen: false }),
  loadMemories: async (q) => {
    try {
      const { memories } = await api.memories({ q: q ?? get().memoryQuery });
      set({ memories, memoryQuery: q ?? get().memoryQuery });
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },
  addMemory: async (body) => {
    try {
      await api.createMemory(body);
      await get().loadMemories();
      get().notify('success', get().t('memoryAdded'));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },
  saveMemory: async (id, patch) => {
    try {
      await api.updateMemory(id, patch);
      await get().loadMemories();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },
  removeMemory: async (id) => {
    try {
      await api.deleteMemory(id);
      await get().loadMemories();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  setSettingsOpen: (open, tab) => set({ settingsOpen: open, settingsTab: open ? tab : undefined }),
  setMcpPathHint: (path) => set({ mcpPathHint: path }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  openTools: (tool) => set({ toolsOpen: true, toolsActive: tool ?? get().toolsActive }),
  closeTools: () => set({ toolsOpen: false }),

  saveSettings: async (patch) => {
    try {
      const { settings } = await api.updateSettings(patch);
      const normalized: AppSettings = { ...settings, locale: normalizeLocale(settings.locale) };
      setI18nLocale(normalized.locale);
      set({ settings: normalized });
      get().notify('success', get().t('savedSettings'));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  startPairing: async () => {
    try {
      const connectionIds = get().connections.map((connection) => connection.id);
      const pairing = await api.pairStart(connectionIds);
      set({ pairing: { ...pairing, createdAt: Date.now() } });
      await get().loadDevices();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  startMcpPairing: async () => {
    try {
      const mcpPairing = await api.pairMcpStart();
      set({ mcpPairing: { ...mcpPairing, createdAt: Date.now() } });
      await get().loadDevices();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  loadDevices: async () => {
    try {
      const { devices } = await api.devices();
      set({ devices });
    } catch {
      /* ignore */
    }
  },

  revokeDevice: async (id) => {
    try {
      await api.revokeDevice(id);
      await get().loadDevices();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  openBackup: async () => {
    const conn = get().activeConnectionId;
    if (!conn) return;
    try {
      const { backup } = await api.createBackup({ connectionId: conn });
      get().notify('success', tr("备份完成"), backup.path);
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  refreshAllSchemas: async () => {
    const conns = get().connections;
    for (const conn of conns) await get().loadSchema(conn.id, true);
    get().notify('success', get().t('refresh'));
  },

  applySchemaChange: (connectionId) => {
    // 本客户端正在跑 Agent 回合：先记账，等回合收尾一次性刷新。
    // 否则 Agent 每改一张表就全量 describe 一次，一回合改 5 张就是 5 次。
    // 这条要排在 echo 判断之前：回合内的事件一律记账，不能因为用户刚手动
    // 刷过就把它丢掉——回合结束时那次 flush 才是它的归宿。
    const live = get().live;
    if (live?.status === 'streaming' || live?.status === 'awaiting') {
      schemaPending.set(connectionId, true);
      return;
    }

    // 有拉取在飞时同样只记账：在飞请求可能早于这次 invalidate 发出，
    // 回来的是旧结构；丢弃事件等于永久丢变更，而 pending 会在结束后补跑。
    // 这条也必须在 echo 判断之前，否则一次"用户刚刷新过"就会把它变成永久丢失。
    if (schemaInFlight.has(connectionId)) {
      schemaPending.set(connectionId, true);
      return;
    }

    // 只有在没有任何拉取在飞的情况下，才把"用户刚刚手动刷过"当作回声跳过。
    const last = schemaLastRefresh.get(connectionId) ?? 0;
    if (Date.now() - last < SCHEMA_ECHO_WINDOW_MS) return;

    requestSchemaReload(connectionId);
  },

  flushSchemaChanges: async () => {
    const ids = [...schemaPending.keys()];
    schemaPending.clear();
    for (const connectionId of ids) requestSchemaReload(connectionId, true);
  },
}));

// 连接和库选择属于会话外的 UI 状态：跨刷新记住，避免每次都退回连接默认库。
useApp.subscribe((state, previous) => {
  if (state.activeConnectionId !== previous.activeConnectionId) {
    saveUiPrefs({ activeConnectionId: state.activeConnectionId });
  }
  if (state.agentDatabase !== previous.agentDatabase && state.activeConnectionId) {
    const prefs = readUiPrefs();
    const agentDatabaseByConnection = { ...(prefs.agentDatabaseByConnection ?? {}) };
    if (state.agentDatabase) agentDatabaseByConnection[state.activeConnectionId] = state.agentDatabase;
    else delete agentDatabaseByConnection[state.activeConnectionId];
    saveUiPrefs({ agentDatabaseByConnection });
  }
});
