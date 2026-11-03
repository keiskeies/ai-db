import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type {
  AgentMessage,
  AgentSessionMeta,
  AppSettings,
  ArtifactRunInfo,
  CommandDefinition,
  CommandRunInfo,
  CommandRunInput,
  ConnectionConfig,
  DatabaseSchema,
  DeviceInfo,
  Memory,
  PermissionMode,
  QueryBatchResult,
} from '@aidb/core';

export interface BridgeConfig {
  baseUrl: string;
  token: string;
}

export interface BootstrapData {
  version: string;
  platform: string;
  bridgeHost: string;
  bridgePort: number;
  connections: ConnectionConfig[];
  settings: AppSettings;
  sessions: AgentSessionMeta[];
  tools: Array<{ name: string; description: string; risk: string }>;
}

export interface SessionDetail {
  session: AgentSessionMeta;
  messages: AgentMessage[];
}

export interface DataPage {
  batch: QueryBatchResult;
  table: string;
  total: number;
  limit: number;
  offset: number;
  sql: string;
}

const KEY = 'aidb.bridge.v1';

export async function loadBridgeConfig(): Promise<BridgeConfig | null> {
  try {
    if (Platform.OS === 'web') {
      const raw = globalThis.localStorage?.getItem(KEY);
      return raw ? (JSON.parse(raw) as BridgeConfig) : null;
    }
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as BridgeConfig) : null;
  } catch {
    return null;
  }
}

export async function saveBridgeConfig(config: BridgeConfig): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(config));
      return;
    }
    await SecureStore.setItemAsync(KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

export async function clearBridgeConfig(): Promise<void> {
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.removeItem(KEY);
    else await SecureStore.deleteItemAsync(KEY);
  } catch {
    /* ignore */
  }
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export class BridgeError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'BRIDGE_ERROR', status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class BridgeClient {
  constructor(public config: BridgeConfig) {}

  get wsUrl(): string {
    return `${this.config.baseUrl.replace(/^http/i, 'ws')}/ws?token=${encodeURIComponent(this.config.token)}`;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}/api${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.token}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!res.ok) {
      throw new BridgeError(payload?.error?.message ?? `请求失败（${res.status}）`, payload?.error?.code ?? 'BRIDGE_HTTP', res.status);
    }
    return payload as T;
  }

  health() {
    return this.request<{ ok: boolean; version: string; demoReady: boolean }>('/health');
  }

  bootstrap() {
    return this.request<BootstrapData>('/bootstrap');
  }

  sessions() {
    return this.request<{ sessions: AgentSessionMeta[] }>('/agent/sessions');
  }

  updateSettings(patch: Partial<AppSettings>) {
    return this.request<{ settings: AppSettings }>('/settings', { method: 'PUT', body: JSON.stringify(patch) });
  }

  renameSession(id: string, title: string) {
    return this.request<{ session: AgentSessionMeta }>(`/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
  }

  session(id: string) {
    return this.request<SessionDetail>(`/agent/sessions/${id}`);
  }

  createSession(body: { connectionId?: string; database?: string; permissionMode?: PermissionMode; title?: string }) {
    return this.request<{ session: AgentSessionMeta }>('/agent/sessions', { method: 'POST', body: JSON.stringify(body) });
  }

  deleteSession(id: string) {
    return this.request<void>(`/agent/sessions/${id}`, { method: 'DELETE' });
  }

  databases(connectionId: string) {
    return this.request<{ databases: string[] }>(`/connections/${connectionId}/databases`);
  }

  schema(connectionId: string, database?: string) {
    const query = database ? `?database=${encodeURIComponent(database)}` : '';
    return this.request<{ schemas: DatabaseSchema[] }>(`/connections/${connectionId}/schema${query}`);
  }

  monitor(connectionId: string) {
    return this.request<{ monitor: { engine: string; version?: string; sections: Array<{ title: string; items: Array<{ label: string; value: string }>; error?: string }> } }>(`/monitor?connectionId=${encodeURIComponent(connectionId)}`);
  }

  commands() {
    return this.request<{ commands: CommandDefinition[] }>('/commands');
  }

  startCommand(id: string, input: CommandRunInput, saveAs?: { title?: string }) {
    return this.request<{ run: CommandRunInfo }>(`/commands/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input, saveAs }),
    });
  }

  commandRun(id: string) {
    return this.request<{ run: CommandRunInfo }>(`/commands/runs/${encodeURIComponent(id)}`);
  }

  artifactRuns(id: string, limit = 1) {
    return this.request<{ runs: ArtifactRunInfo[] }>(`/artifacts/${encodeURIComponent(id)}/runs?limit=${limit}`);
  }

  data(connectionId: string, table: string, limit = 50, offset = 0, database?: string) {
    const params = new URLSearchParams({ connectionId, table, limit: String(limit), offset: String(offset) });
    if (database) params.set('database', database);
    return this.request<DataPage>(`/data?${params.toString()}`);
  }

  query(connectionId: string, sql: string, database?: string, allowMulti = false, limit?: number) {
    return this.request<{ batch: QueryBatchResult }>('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId, sql, database, allowMulti, ...(limit ? { limit } : {}) }),
    });
  }

  rows(connectionId: string, table: string, op: 'insert' | 'insertMany' | 'update' | 'delete' | 'deleteMany', body: Record<string, unknown>, database?: string) {
    return this.request<{ result: { affected?: number; lastInsertId?: number } }>('/rows', {
      method: 'POST',
      body: JSON.stringify({ connectionId, table, op, database, ...body }),
    });
  }

  execDdl(connectionId: string, sql: string, database?: string) {
    return this.request<{ batch: QueryBatchResult }>('/ddl/execute', { method: 'POST', body: JSON.stringify({ connectionId, database, statements: [sql] }) });
  }

  tableOp(connectionId: string, table: string, op: string, extra: Record<string, unknown> = {}, database?: string) {
    return this.request<{ statements?: string[]; batch?: QueryBatchResult; message?: string }>('/tables/ops', {
      method: 'POST',
      body: JSON.stringify({ connectionId, table, op, database, ...extra }),
    });
  }

  importCsv(connectionId: string, table: string, csv: string, database?: string) {
    return this.request<{ result: { inserted: number; skipped: number; errors: string[] } }>('/import', {
      method: 'POST',
      body: JSON.stringify({ connectionId, table, csv, hasHeader: true, database }),
    });
  }

  exportInline(body: { connectionId: string; format: string; sql?: string; table?: string; database?: string; limit?: number }) {
    return this.request<{ file: { path: string; bytes: number; rows: number }; format: string; content: string; encoding: 'base64' }>('/export', {
      method: 'POST',
      body: JSON.stringify({ ...body, inline: true }),
    });
  }

  backups(connectionId: string) {
    return this.request<{ backups: Array<{ id: string; path: string; bytes: number; label?: string; createdAt: string; format: string }> }>(`/backups?connectionId=${encodeURIComponent(connectionId)}`);
  }

  createBackup(connectionId: string, label?: string, database?: string) {
    return this.request<{ backup: { id: string; path: string; bytes: number; tables: number; rows: number } }>('/backups', {
      method: 'POST',
      body: JSON.stringify({ connectionId, label, database }),
    });
  }

  restoreBackup(id: string) {
    return this.request<{ batch: QueryBatchResult }>(`/backups/${id}/restore`, { method: 'POST' });
  }

  dashboardCards(connectionId: string, database?: string) {
    const params = new URLSearchParams({ connectionId });
    if (database) params.set('database', database);
    return this.request<{ supported: boolean; cards: Array<{ id: string; title: string; sql: string; chartType: string; span: number }> }>(`/dashboards/cards?${params.toString()}`);
  }

  createDashboardCard(body: { connectionId: string; database?: string; title: string; sql: string; chartType?: string }) {
    return this.request<{ card: { id: string } }>('/dashboards/cards', { method: 'POST', body: JSON.stringify(body) });
  }

  deleteDashboardCard(id: string) {
    return this.request<{ cards: unknown[] }>(`/dashboards/cards/${id}`, { method: 'DELETE' });
  }

  refreshDashboards(connectionId: string, database?: string) {
    return this.request<{ results: Array<{ cardId: string; status: 'ok' | 'error'; columns: Array<{ name: string }>; rows: unknown[][]; error?: string }> }>('/dashboards/refresh', {
      method: 'POST',
      body: JSON.stringify({ connectionId, database }),
    });
  }

  skills(includeDisabled = true) {
    return this.request<{ skills: Array<{ id: string; name: string; description: string; enabled: boolean; version?: string; builtin?: boolean }> }>(`/skills?includeDisabled=${includeDisabled ? 1 : 0}`);
  }

  toggleSkill(id: string, enabled: boolean) {
    return this.request<{ skill: unknown }>(`/skills/${id}/enable`, { method: 'POST', body: JSON.stringify({ enabled }) });
  }

  mcpServers() {
    return this.request<{ servers: Array<{ id: string; name: string; command: string; enabled: boolean; builtin?: boolean }> }>('/mcp/servers');
  }

  toggleMcp(id: string, enabled: boolean) {
    return this.request<{ server: unknown }>(`/mcp/servers/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
  }

  uploadAttachment(base64: string, mime: string) {
    return this.request<{ attachment: { id: string; mime: string; bytes: number } }>('/agent/attachments', { method: 'POST', body: JSON.stringify({ base64, mime }) });
  }

  search(connectionId: string, query: string, scope: 'objects' | 'data' | 'all', database?: string) {
    return this.request<{ query: string; scope: string; objects: Array<{ kind: string; table: string; column?: string; detail?: string }>; data: Array<{ table: string; columns: string[]; rows: unknown[][] }>; scannedTables?: number }>('/search', {
      method: 'POST',
      body: JSON.stringify({ connectionId, query, scope, database }),
    });
  }

  dictionary(connectionId: string, database?: string) {
    const params = new URLSearchParams({ connectionId });
    if (database) params.set('database', database);
    return this.request<{ dictionary: { tableCount: number; columnCount: number; markdown: string } }>(`/dictionary?${params.toString()}`);
  }

  memories(q = '') {
    return this.request<{ memories: Memory[] }>(`/agent/memories?q=${encodeURIComponent(q)}&limit=100`);
  }

  updateMemory(id: string, patch: Record<string, unknown>) {
    return this.request<{ memory: Memory }>(`/agent/memories/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
  }

  createMemory(body: { kind: string; title: string; content: string }) {
    return this.request<{ memory: Memory }>('/agent/memories', { method: 'POST', body: JSON.stringify(body) });
  }

  deleteMemory(id: string) {
    return this.request<void>(`/agent/memories/${id}`, { method: 'DELETE' });
  }

  approve(id: string, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') {
    return this.request<{ ok: boolean }>(`/agent/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision, scope }) });
  }

  abort(sessionId: string) {
    return this.request<{ ok: boolean }>(`/agent/sessions/${sessionId}/abort`, { method: 'POST' });
  }

  devices() {
    return this.request<{ devices: DeviceInfo[] }>('/devices');
  }
}

export async function claimPairing(baseUrl: string, code: string, platform: string): Promise<{ token: string; bridge: { host: string; port: number; version: string } }> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'AiDB Mobile', platform }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new BridgeError(payload?.error?.message ?? '配对失败', payload?.error?.code ?? 'PAIR_FAILED', res.status);
  return payload;
}
