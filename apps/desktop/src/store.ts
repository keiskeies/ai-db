import { create } from 'zustand';
import type { ReactNode } from 'react';
import type {
  AgentEvent,
  AgentMessage,
  AgentPlanItem,
  AgentSessionMeta,
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
import { DEFAULT_SETTINGS, engineMeta } from '@aidb/core';
import { ApiError, api, streamTurn, type BootstrapData } from './lib/api';
import { translate, type I18nKey, type Locale } from './i18n';
export type Tab =
  | { id: string; kind: 'welcome'; title: string }
  | { id: string; kind: 'data'; title: string; connectionId: string; database?: string; table: string }
  | { id: string; kind: 'query'; title: string; connectionId: string; database?: string; sql: string }
  | { id: string; kind: 'design'; title: string; connectionId: string; database?: string; table?: string }
  | { id: string; kind: 'relations'; title: string; connectionId: string; database?: string };

export interface LiveTool {
  callId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  status: 'running' | 'ok' | 'error' | 'awaiting';
  summary?: string;
  result?: ToolResult;
}

export interface LiveTurn {
  userText: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  plan: AgentPlanItem[];
  status: 'streaming' | 'awaiting' | 'done' | 'aborted' | 'error';
  error?: string;
  startedAt: number;
  tokensIn: number;
  tokensOut: number;
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

function readUiPrefs(): { sidebarOpen?: boolean; sidebarWidth?: number; agentWidth?: number; groupOrder?: string[]; connectionOrder?: string[]; hiddenColumns?: Record<string, string[]>; collapsedGroups?: string[] } {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveUiPrefs(patch: { sidebarOpen?: boolean; sidebarWidth?: number; agentWidth?: number; groupOrder?: string[]; connectionOrder?: string[]; hiddenColumns?: Record<string, string[]>; collapsedGroups?: string[] }): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...readUiPrefs(), ...patch }));
  } catch {
    /* 隐私模式写不进去也不影响使用 */
  }
}

interface AppStore {
  booted: boolean;
  bootError?: string;
  connections: ConnectionConfig[];
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
  live?: LiveTurn;
  approval?: ApprovalState;
  agentPrefill?: string;
  sessionsOpen: boolean;
  memoryOpen: boolean;
  memoryQuery: string;
  memories: Memory[];
  settingsOpen: boolean;
  paletteOpen: boolean;
  toolsOpen: boolean;
  toolsActive: string;
  openTools: (tool?: string) => void;
  closeTools: () => void;
  connectionEditor?: ConnectionEditorState;
  toasts: Toast[];
  pairing?: { code: string; expiresIn: number; host: string; port: number };
  devices: DeviceInfo[];

  boot: () => Promise<void>;
  t: (key: I18nKey) => string;
  notify: (kind: Toast['kind'], message: string, detail?: string) => void;
  dismissToast: (id: string) => void;

  loadSchema: (connectionId: string, refresh?: boolean, database?: string) => Promise<void>;
  selectConnection: (id: string) => void;
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
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;

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
  setAgentDatabase: (database: string) => void;
  setSessionsOpen: (open: boolean) => void;
  newAgentSession: () => Promise<void>;
  loadAgentSession: (id: string) => Promise<void>;
  deleteAgentSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
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

  setSettingsOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  saveSettings: (patch: Record<string, unknown>) => Promise<void>;
  startPairing: () => Promise<void>;
  loadDevices: () => Promise<void>;
  revokeDevice: (id: string) => Promise<void>;

  openBackup: () => Promise<void>;
  refreshAllSchemas: () => Promise<void>;
}

const WELCOME: Tab = { id: 'welcome', kind: 'welcome', title: '欢迎' };
let tabSeq = 1;
let currentAbort: AbortController | undefined;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  settings: { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, hasApiKey: false } },
  tools: [],
  sessions: [],
  schemas: {},
  loadedDatabases: {},
  schemaLoading: {},
  expandedConnections: {},
  expandedSchemas: {},
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
  collapsedGroups: readUiPrefs().collapsedGroups ?? [],
  agentWidth: readUiPrefs().agentWidth ?? 384,
  agentMessages: [],
  agentFollowUps: [],
  agentMode: 'ask',
  agentDatabase: '',
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

  t: (key) => translate(get().settings.locale as Locale, key),

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
      set({
        booted: true,
        bootError: undefined,
        connections: data.connections,
        settings: data.settings,
        sessions: data.sessions,
        tools: data.tools,
        agentMode: (data.sessions[0]?.permissionMode as PermissionMode) ?? 'ask',
      });
      if (!data.connections.length) return;
      const demo = data.connections.find((c) => c.name.startsWith('Demo')) ?? data.connections[0];
      set({ activeConnectionId: demo.id });
      await get().loadSchema(demo.id);
    } catch (err) {
      set({ booted: false, bootError: errorText(err) });
    }
  },

  loadSchema: async (connectionId, refresh = false, database) => {
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
      if (conn && !engineMeta(conn.engine).fileBased) {
        const { databases } = await api.databases(connectionId);
        const previouslyLoaded = (get().loadedDatabases[connectionId] ?? []).filter((name) => databases.includes(name));
        const keep = refresh ? [] : previouslyLoaded;
        const byName = new Map((get().schemas[connectionId] ?? []).map((item) => [item.name, item]));
        const list = databases.map((name) => (keep.includes(name) ? byName.get(name) ?? { name, tables: [] } : { name, tables: [] }));
        set((s) => ({
          schemas: { ...s.schemas, [connectionId]: list },
          loadedDatabases: { ...s.loadedDatabases, [connectionId]: keep },
        }));
        const targets = refresh ? previouslyLoaded : conn.database && databases.includes(conn.database) ? [conn.database] : [];
        for (const name of targets) {
          if (!refresh) set((s) => ({ expandedSchemas: { ...s.expandedSchemas, [`${connectionId}:${name}`]: true } }));
          void get().loadSchema(connectionId, refresh, name);
        }
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
    set((s) => ({ activeConnectionId: id, ...(s.activeConnectionId === id ? {} : { agentDatabase: '' }) }));
    if (!get().schemas[id]) void get().loadSchema(id);
  },

  setActiveConnection: (id) => set((s) => ({ activeConnectionId: id, ...(s.activeConnectionId === id ? {} : { agentDatabase: '' }) })),

  toggleConnection: (id) => {
    const open = !get().expandedConnections[id];
    set((s) => ({ expandedConnections: { ...s.expandedConnections, [id]: open }, activeConnectionId: id }));
    if (open && !get().schemas[id]) void get().loadSchema(id);
  },

  toggleSchema: (key) => set((s) => ({ expandedSchemas: { ...s.expandedSchemas, [key]: !s.expandedSchemas[key] } })),

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
    const id = tabId('query');
    const count = get().tabs.filter((t) => t.kind === 'query').length + 1;
    const tab: Tab = {
      id,
      kind: 'query',
      title: title ?? `查询 ${count}`,
      connectionId: connId,
      database: database ?? get().connections.find((c) => c.id === connId)?.database,
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
      get().notify('warning', '该引擎不支持可视化建表', `${meta.label} 请直接执行 DDL`);
      return;
    }
    const tab: Tab = {
      id,
      kind: 'design',
      title: table ? `设计 · ${table}` : get().t('newTable'),
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
      get().notify('warning', '该引擎没有关系图', engineMeta(conn.engine).label);
      return;
    }
    const id = `relations:${connId}:${database ?? ''}`;
    const existing = get().tabs.find((tab) => tab.id === id);
    if (existing) {
      set({ activeTabId: id });
      return;
    }
    const tab: Tab = { id, kind: 'relations', title: '关系图', connectionId: connId, database };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.id !== 'welcome'), tab], activeTabId: id, activeConnectionId: connId }));
    if (!get().schemas[connId]) void get().loadSchema(connId);
    else if (database && !(get().loadedDatabases[connId] ?? []).includes(database)) void get().loadSchema(connId, false, database);
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

  openConnectionEditor: (mode, connection) => set({ connectionEditor: { mode, connection } }),
  closeConnectionEditor: () => set({ connectionEditor: undefined }),

  saveConnection: async (body) => {
    try {
      const current = get().connectionEditor;
      const result = current?.mode === 'edit' && current.connection ? await api.updateConnection(current.connection.id, body) : await api.createConnection(body);
      const { connections } = await api.connections();
      const previousActive = get().activeConnectionId;
      set({
        connections,
        connectionEditor: undefined,
        activeConnectionId: result.connection.id,
        expandedConnections: { ...get().expandedConnections, [result.connection.id]: true },
        schemas: { ...get().schemas, [result.connection.id]: get().schemas[result.connection.id] ?? [] },
        ...(previousActive !== result.connection.id ? { agentDatabase: '' } : {}),
      });
      get().notify('success', get().t('saved'));
      void get().loadSchema(result.connection.id);
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

  setAgentDatabase: (database) => {
    set({ agentDatabase: database });
    // 选完就落库：否则重开会话会退回连接默认库，历史对话和实际执行对不上
    const id = get().agentSessionId;
    if (id) void api.updateSession(id, { database }).catch(() => undefined);
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
        approval: undefined,
        agentOpen: true,
        sessionsOpen: false,
      });
      await get().refreshSessions();
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  loadAgentSession: async (id) => {
    try {
      if (get().live && (get().live!.status === 'streaming' || get().live!.status === 'awaiting')) await get().abortAgent();
      const detail = await api.getSession(id);
      set({
        agentSessionId: id,
        agentSessionMeta: detail.session,
        agentMessages: detail.messages,
        agentFollowUps: [],
        live: undefined,
        approval: undefined,
        agentOpen: true,
        sessionsOpen: false,
        agentMode: detail.session.permissionMode,
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
        ? { ...prev.live, tools: prev.live.tools.map((t) => ({ ...t })), plan: [...prev.live.plan], memories: [...prev.live.memories] }
        : undefined;
      if (!live) return {};
      switch (event.type) {
        case 'start':
          live.status = 'streaming';
          break;
        case 'text_delta':
          live.text += event.text;
          break;
        case 'text_replace':
          live.text = event.text;
          break;
        case 'thinking_delta':
          live.thinking += event.text;
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
            approval: {
              approvalId: event.approvalId,
              tool: event.call.tool,
              args: event.call.args,
              risk: event.call.risk,
              summary: event.call.summary,
              sql: event.call.sql,
            },
          };
        case 'approval_resolved':
          live.status = 'streaming';
          return { live, approval: undefined };
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
          break;
        case 'done':
          live.status = 'done';
          break;
        case 'aborted':
          live.status = 'aborted';
          break;
        case 'error':
          live.status = 'error';
          live.error = event.message;
          return { live, approval: undefined };
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
      get().notify('warning', 'Agent 正在运行，请先停止');
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
        approval: undefined,
        agentFollowUps: [],
        live: {
          userText: trimmed,
          text: '',
          thinking: '',
          tools: [],
          plan: [],
          status: 'streaming',
          startedAt: Date.now(),
          tokensIn: 0,
          tokensOut: 0,
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
        set((prev) => (prev.live ? { live: { ...prev.live, status: 'error', error: errorText(err) } } : {}));
      }
    } finally {
      currentAbort = undefined;
      const sid = get().agentSessionId;
      if (sid) {
        try {
          const detail = await api.getSession(sid);
          set({ agentSessionMeta: detail.session, agentMessages: detail.messages, live: undefined });
        } catch {
          /* keep live state */
        }
      }
      await get().refreshSessions();
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
    try {
      await api.approve(approval.approvalId, decision, scope);
      set((prev) => ({
        approval: undefined,
        live: prev.live ? { ...prev.live, status: 'streaming' } : undefined,
      }));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
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

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  openTools: (tool) => set({ toolsOpen: true, toolsActive: tool ?? get().toolsActive }),
  closeTools: () => set({ toolsOpen: false }),

  saveSettings: async (patch) => {
    try {
      const { settings } = await api.updateSettings(patch);
      set({ settings });
      get().notify('success', get().t('savedSettings'));
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  startPairing: async () => {
    try {
      const pairing = await api.pairStart();
      set({ pairing });
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
      get().notify('success', '备份完成', backup.path);
    } catch (err) {
      get().notify('error', get().t('error'), errorText(err));
    }
  },

  refreshAllSchemas: async () => {
    const conns = get().connections;
    for (const conn of conns) await get().loadSchema(conn.id, true);
    get().notify('success', get().t('refresh'));
  },
}));
