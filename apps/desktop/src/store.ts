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
import { startSchemaEvents } from './lib/schemaEvents';
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
  abortCause?: 'stalled' | 'user';
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
  | { sep?: false; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onClick?: () => void };

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
  expandedSchemas: Record<string, boolean>;
  activeConnectionId?: string;
  tabs: Tab[];
  activeTabId: string;
  agentOpen: boolean;
  agentExpanded: boolean;
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
  setAgentExpanded: (expanded: boolean) => void;
  setAgentMode: (mode: PermissionMode) => void;
  setAgentDatabase: (database: string) => Promise<void>;
  restoreSessionForScope: () => Promise<void>;
  /** 返回 false 表示被运行态拒绝（已弹提示）。 */
  requestAgentTask: (prompt: string) => Promise<boolean>;
  setSessionsOpen: (open: boolean) => void;
  newAgentSession: () => Promise<void>;
  /** keepMode=true 时不采用会话里存的权限档位，保留用户当前的选择（自动恢复走这条）。 */
  loadAgentSession: (id: string, opts?: { keepMode?: boolean }) => Promise<void>;
  deleteAgentSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  sessionsForScope: (connectionId?: string, database?: string) => AgentSessionMeta[];
  renameAgentSession: (id: string, title: string) => Promise<void>;
  sendAgent: (text: string, mode?: PermissionMode, images?: string[]) => Promise<void>;
  abortAgent: () => Promise<void>;
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

const WELCOME: Tab = { id: 'welcome', kind: 'welcome', title: tr("欢迎") };
let tabSeq = 1;
let currentAbort: AbortController | undefined;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 结构变更合并用的模块级状态。放 state 里会让每次事件都触发订阅者重渲染，
// 而这些值只被下面几个函数读。
const schemaPending = new Map<string, true>();
const schemaInFlight = new Set<string>();
const schemaLastRefresh = new Map<string, number>();
const schemaThrottle = new Map<string, ReturnType<typeof setTimeout>>();
const SCHEMA_THROTTLE_MS = 1000;
// 手动刷新后这个窗口内到达的事件跳过：用户自己刚刷过，事件是回声。
const SCHEMA_ECHO_WINDOW_MS = 1500;
// 事件驱动的重拉不应该给 echo 窗口续期：否则重拉一开始就给自己开了一个
// 1.5s 的"丢事件"窗口，期间真到达的变更会被当成回声丢掉且永不纠正。
let schemaReloadByEvent = false;
let schemaEventsStop: (() => void) | undefined;

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
  expandedSchemas: readUiPrefs().expandedSchemas ?? {},
  tabs: [WELCOME],
  activeTabId: 'welcome',
  printRequested: false,
  agentOpen: true,
  agentExpanded: false,
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
      if (!data.connections.length) return;
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

      if (!schemaEventsStop) {
        schemaEventsStop = startSchemaEvents({
          onChange: (event) => get().applySchemaChange(event.connectionId),
          // 断线期间的事件不会补发，重连后对已知连接各刷一次。
          onReconnect: () => {
            for (const conn of get().connections) requestSchemaReload(conn.id, true);
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
    if (refresh && !schemaReloadByEvent) schemaLastRefresh.set(connectionId, Date.now());
    const conn = get().connections.find((c) => c.id === connectionId);
    if (database) {
      const key = `${connectionId}:${database}`;
      set((s) => ({ schemaLoading: { ...s.schemaLoading, [key]: true } }));
      try {
        const { schemas } = await api.getSchema(connectionId, refresh, database);
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
            schemaLoading: { ...s.schemaLoading, [key]: false },
          };
        });
      } catch (err) {
        set((s) => ({ schemaLoading: { ...s.schemaLoading, [key]: false } }));
        get().notify('error', get().t('error'), errorText(err));
      }
      return;
    }
    try {
      // conn 不在本地列表时不能直接发不带 database 的 /schema：
      // engineMeta 对未知引擎回落到 sqlite，于是这条请求对 MySQL/PG 这类
      // 「合法地没有默认库」的连接只能回 400 NO_DATABASE。先补拉一次连接列表再判引擎。
      const resolved = conn ?? (await api.connections()).connections.find((c) => c.id === connectionId);
      if (!resolved) {
        // 补拉一次连接列表仍没有它 = 已被删除（调用方拿的是删除前的快照）。
        // 静默返回：deleteConnection 已经把这条连接的 tab/schema 一起清了，
        // 没有任何东西需要刷新，弹一条错只会为一个用户已经做完的操作报错。
        return;
      }
      if (!engineMeta(resolved.engine).fileBased) {
        const { databases } = await api.databases(connectionId);
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
      set((s) => ({
        schemas: { ...s.schemas, [connectionId]: schemas },
        loadedDatabases: { ...s.loadedDatabases, [connectionId]: schemas.map((item) => item.name) },
      }));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  selectConnection: (id) => {
    const previous = get().activeConnectionId;
    if (previous === id) {
      if (!get().schemas[id]) void get().loadSchema(id);
      return;
    }
    // 换连接时首页库走回落链：该连接上次看的库 → 空（由首页再退到连接默认库/第一个库）
    const rememberedHome = readUiPrefs().homeDatabaseByConnection?.[id] ?? '';
    set({
      activeConnectionId: id,
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
    set({ activeConnectionId: id, ...(previous === id ? {} : { agentDatabase: rememberedAgentDatabase(id) }) });
  },

  toggleConnection: (id) => {
    const open = !get().expandedConnections[id];
    const expandedConnections = { ...get().expandedConnections, [id]: open };
    const previous = get().activeConnectionId;
    set({ expandedConnections, activeConnectionId: id, ...(previous === id ? {} : { agentDatabase: rememberedAgentDatabase(id) }) });
    saveUiPrefs({ expandedConnections });
    if (open && !get().schemas[id]) void get().loadSchema(id);
  },

  toggleSchema: (key) => {
    const expandedSchemas = { ...get().expandedSchemas, [key]: !get().expandedSchemas[key] };
    set({ expandedSchemas });
    saveUiPrefs({ expandedSchemas });
  },

  requestPrint: () => set({ printRequested: true }),
  consumePrint: () => set({ printRequested: false }),
  openData: (connectionId, table, database) => {
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
      const { connections } = await api.connections();
      const previousActive = get().activeConnectionId;
      const expandedConnections = { ...get().expandedConnections, [result.connection.id]: true };
      set({
        connections,
        connectionEditor: undefined,
        activeConnectionId: result.connection.id,
        expandedConnections,
        schemas: { ...get().schemas, [result.connection.id]: get().schemas[result.connection.id] ?? [] },
        ...(previousActive !== result.connection.id ? { agentDatabase: '' } : {}),
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
      const connections = get().connections.filter((c) => c.id !== id);
      const schemas = { ...get().schemas };
      delete schemas[id];
      const tabs = get().tabs.filter((tab) => !('connectionId' in tab && tab.connectionId === id));
      set({
        connections,
        schemas,
        tabs: tabs.length ? tabs : [WELCOME],
        activeTabId: tabs.some((t) => t.id === get().activeTabId) ? get().activeTabId : tabs[0]?.id ?? 'welcome',
        activeConnectionId: get().activeConnectionId === id ? connections[0]?.id : get().activeConnectionId,
      });
      get().notify('success', get().t('saved'));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  setAgentOpen: (open) => set({ agentOpen: open }),
  setAgentExpanded: (expanded) => set({ agentExpanded: expanded }),
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
    const live = get().live;
    if (live && (live.status === 'streaming' || live.status === 'awaiting')) {
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
   * 正在回答时不动作：静默换掉会话会让用户看不见自己那一轮跑到哪去了。
   */
  restoreSessionForScope: async () => {
    const live = get().live;
    if (live && (live.status === 'streaming' || live.status === 'awaiting')) return;
    const seq = ++restoreSeq;
    const { activeConnectionId, agentDatabase } = get();
    await get().refreshSessions();
    // 期间用户又切了库：这次结果已经过期，丢弃
    if (seq !== restoreSeq) return;
    const recent = get().sessionsForScope(activeConnectionId, agentDatabase || undefined)[0];
    if (recent) {
      await get().loadAgentSession(recent.id, { keepMode: true });
      return;
    }
    // 该库还没有会话：清成空白，但不建后端会话（首条消息时才创建，
    // 否则切几次库就堆几个空会话）
    set({
      agentSessionId: undefined,
      agentSessionMeta: undefined,
      agentMessages: [],
      agentFollowUps: [],
      live: undefined,
      ...NO_APPROVAL,
      agentDatabase,
    });
  },
  setSessionsOpen: (open) => set({ sessionsOpen: open }),

  refreshSessions: async () => {
    try {
      const { sessions } = await api.sessions();
      set({ sessions });
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
    try {
      if (get().live && (get().live!.status === 'streaming' || get().live!.status === 'awaiting')) await get().abortAgent();
      const { session } = await api.createSession({
        connectionId: get().activeConnectionId,
        database: get().agentDatabase || undefined,
        permissionMode: get().agentMode,
      });
      set({
        agentSessionId: session.id,
        agentSessionMeta: session,
        agentDatabase: session.database ?? get().agentDatabase,
        agentMessages: [],
        agentFollowUps: [],
        live: undefined,
        ...NO_APPROVAL,
        agentOpen: true,
        sessionsOpen: false,
      });
      await get().refreshSessions();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  loadAgentSession: async (id, opts) => {
    try {
      if (get().live && (get().live!.status === 'streaming' || get().live!.status === 'awaiting')) await get().abortAgent();
      const detail = await api.getSession(id);
      set({
        agentSessionId: id,
        agentSessionMeta: detail.session,
        agentMessages: detail.messages,
        agentFollowUps: [],
        live: undefined,
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
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  deleteAgentSession: async (id) => {
    try {
      await api.deleteSession(id);
      if (get().agentSessionId === id) set({ agentSessionId: undefined, agentSessionMeta: undefined, agentMessages: [], agentFollowUps: [], live: undefined });
      await get().refreshSessions();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  handleAgentEvent: (event) => {
    set((prev) => {
      const live = prev.live
        ? {
            ...prev.live,
            tools: prev.live.tools.map((t) => ({ ...t })),
            plan: [...prev.live.plan],
            memories: [...prev.live.memories],
            timeline: [...prev.live.timeline],
          }
        : undefined;
      if (!live) return {};
      // 每个事件都刷新「最后一次有动静」的时刻：静默多久是界面判断「该说句话了」的唯一依据。
      live.lastEventAt = Date.now();
      /** 已入账的正文，用于把 live.text 保持成「整回合」而不是「当前这一步」。 */
      const committedText = () => live.timeline.filter((item) => item.kind === 'text').map((item) => item.text).join('\n\n');
      switch (event.type) {
        case 'start':
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
          live.timeline.push({ kind: 'text', text: event.text, step: event.step });
          live.stream = '';
          break;
        case 'step_thinking':
          live.timeline.push({ kind: 'thinking', text: event.text, step: event.step });
          live.streamThinking = '';
          break;
        case 'tool_call':
          live.tools.push({
            callId: event.callId,
            tool: event.tool,
            args: event.args,
            risk: event.risk,
            status: 'running',
            summary: event.summary,
          });
          live.timeline.push({ kind: 'tool', callId: event.callId });
          break;
        case 'tool_result': {
          const tool = live.tools.find((t) => t.callId === event.callId);
          if (tool) {
            tool.status = event.result.ok ? 'ok' : 'error';
            tool.result = event.result;
          }
          live.status = 'streaming';
          break;
        }
        case 'approval_required':
          live.status = 'awaiting';
          for (const tool of live.tools) if (tool.tool === event.call.tool && tool.status === 'running') tool.status = 'awaiting';
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
          break;
        case 'aborted':
          live.status = 'aborted';
          live.abortCause = event.cause ?? 'user';
          live.endedAt = Date.now();
          break;
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

  sendAgent: async (text, mode, images) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (get().live && (get().live!.status === 'streaming' || get().live!.status === 'awaiting')) {
      get().notify('warning', tr("Agent 正在运行，请先停止"));
      return;
    }
    let sessionId = get().agentSessionId;
    try {
      if (!sessionId) {
        const { session } = await api.createSession({
          connectionId: get().activeConnectionId,
          database: get().agentDatabase || undefined,
          permissionMode: mode ?? get().agentMode,
        });
        sessionId = session.id;
        set({ agentSessionId: session.id, agentSessionMeta: session, agentMessages: [] });
        await get().refreshSessions();
      }
      const permission = mode ?? get().agentMode;
      set({
        agentMode: permission,
        ...NO_APPROVAL,
        agentFollowUps: [],
        live: {
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
      currentAbort = new AbortController();
      await streamTurn(
        sessionId,
        { text: trimmed, mode: permission, attachments, ...(images?.length ? { images } : {}), connectionId: get().activeConnectionId, database: get().agentDatabase || undefined },
        (event) => get().handleAgentEvent(event),
        currentAbort.signal,
      );
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        get().notify('error', get().t('agentError'), errorText(err));
        // 通道静默到上限（客户端自己断的）与截断同族：事没做完，要给「继续」。
        // 不认这一条的话，这条路径上只有红色的失败文案，用户照样不知道下一步做什么。
        const channelIdle = (err as { code?: string })?.code === 'TURN_CHANNEL_IDLE';
        set((prev) =>
          prev.live
            ? { live: { ...prev.live, status: 'error' as const, error: errorText(err), endedAt: Date.now(), ...(channelIdle ? { stop: 'channel_idle' as const } : {}) } }
            : {},
        );
      }
    } finally {
      currentAbort = undefined;
      const startedAt = get().live?.startedAt;
      const sid = get().agentSessionId;
      if (sid) {
        try {
          const detail = await api.getSession(sid);
          // 本地模型几十毫秒就结束，状态条会闪一下；至少展示 320ms，避免看不见也看不清。
          const remaining = startedAt ? Math.max(0, 320 - (Date.now() - startedAt)) : 0;
          if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
          // 等待期间用户可能已切到新会话/另一条会话，旧回合的收尾结果不能再写回。
          if (get().agentSessionId === sid) set({ agentSessionMeta: detail.session, agentMessages: detail.messages, live: undefined });
        } catch {
          // 拉不回历史时保留 live 是对的，但不能原样保留：status 还停在 streaming，
          // 界面就会一直转圈且没有任何解释——正是「莫名其妙停了、图标还在转」这一类。
          // 就地定稿，并把原因写成一条错误，让用户看得见也复制得走。
          const sidNow = get().agentSessionId;
          if (sidNow === sid) {
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
      await get().refreshSessions();
      // 把回合内积攒的结构变更派发出去。注意 flushSchemaChanges 里全是
      // fire-and-forget 的 loadSchema：这里 await 到的是"派发完成"，不是"拉取完成"。
      // 结构展示由 schemaLoading 状态驱动，不需要在这一行等它。
      await get().flushSchemaChanges();
    }
  },

  abortAgent: async () => {
    const sessionId = get().agentSessionId;
    if (!sessionId) return;
    try {
      await api.abort(sessionId);
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  resolveApproval: async (decision, scope) => {
    const approval = get().approval;
    if (!approval) return;
    const approvalId = approval.approvalId;
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
      const pairing = await api.pairStart();
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
