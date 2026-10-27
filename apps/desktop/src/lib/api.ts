import type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  AppSettings,
  AuditEntry,
  BackupInfo,
  ConnectionConfig,
  DatabaseSchema,
  DeviceInfo,
  Memory,
  QueryBatchResult,
  QueryResult,
  TableInfo,
} from '@aidb/core';

function resolveToken(): string {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const fromHash = params.get('token');
  if (fromHash) {
    try {
      localStorage.setItem('aidb.token', fromHash);
    } catch {
      /* ignore */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  try {
    return localStorage.getItem('aidb.token') || (import.meta.env.DEV ? 'dev-token' : '');
  } catch {
    return import.meta.env.DEV ? 'dev-token' : '';
  }
}

export const TOKEN = resolveToken();

export class ApiError extends Error {
  code: string;
  status: number;
  hint?: string;
  constructor(message: string, opts: { code?: string; status?: number; hint?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code ?? 'API_ERROR';
    this.status = opts.status ?? 0;
    this.hint = opts.hint;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const err = payload?.error;
    throw new ApiError(typeof err?.message === 'string' ? err.message : `请求失败（${res.status}）`, {
      code: err?.code,
      status: res.status,
      hint: err?.hint,
    });
  }
  return payload as T;
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
  startedAt: number;
}

export interface SessionDetail {
  session: AgentSessionMeta;
  messages: AgentMessage[];
  toolRuns: Array<Record<string, unknown>>;
}

export interface DataPage {
  batch: QueryBatchResult;
  table: string;
  total: number;
  limit: number;
  offset: number;
  sql: string;
}

export interface TurnPayload {
  text: string;
  mode?: string;
  attachments?: string[];
  connectionId?: string;
}

export async function streamTurn(sessionId: string, payload: TurnPayload, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `Agent 请求失败（${res.status}）`;
    let code = 'AGENT_REQUEST';
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? message;
      code = parsed?.error?.code ?? code;
    } catch {
      /* keep */
    }
    throw new ApiError(message, { code, status: res.status });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (frame && !frame.startsWith(':')) {
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) {
          try {
            onEvent(JSON.parse(data) as AgentEvent);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}

export const api = {
  health: () => request<{ ok: boolean; version: string; demoReady: boolean }>('/health'),
  bootstrap: () => request<BootstrapData>('/bootstrap'),
  tools: () => request<{ tools: any[] }>('/agent/tools'),

  connections: () => request<{ connections: ConnectionConfig[] }>('/connections'),
  createConnection: (body: Record<string, unknown>) => request<{ connection: ConnectionConfig }>('/connections', { method: 'POST', body: JSON.stringify(body) }),
  updateConnection: (id: string, body: Record<string, unknown>) => request<{ connection: ConnectionConfig }>(`/connections/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteConnection: (id: string) => request<void>(`/connections/${id}`, { method: 'DELETE' }),
  testConnection: (id: string) => request<{ result: { ok: boolean; version?: string; latencyMs: number; message?: string } }>(`/connections/${id}/test`, { method: 'POST' }),
  testDraft: (body: Record<string, unknown>) => request<{ result: { ok: boolean; version?: string; latencyMs: number; message?: string } }>('/connections/test', { method: 'POST', body: JSON.stringify(body) }),
  getSchema: (id: string, refresh = false, database?: string) =>
    request<{ schemas: DatabaseSchema[] }>(`/connections/${id}/schema?refresh=${refresh ? 1 : 0}${database ? `&database=${encodeURIComponent(database)}` : ''}`),
  getTables: (id: string, database?: string) =>
    request<{ database?: string; tables: TableInfo[] }>(`/connections/${id}/tables${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  refreshSchema: (id: string, database?: string) => request<{ schemas: DatabaseSchema[] }>(`/connections/${id}/refresh`, { method: 'POST', body: JSON.stringify({ database }) }),
  databases: (id: string) => request<{ databases: string[] }>(`/connections/${id}/databases`),

  query: (body: { connectionId: string; sql: string; database?: string; limit?: number; allowMulti?: boolean }) =>
    request<{ batch: QueryBatchResult }>('/query', { method: 'POST', body: JSON.stringify(body) }),
  data: (params: { connectionId: string; table: string; database?: string; limit?: number; offset?: number; orderBy?: string; orderDir?: string; where?: string }) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
    return request<DataPage>(`/data?${q.toString()}`);
  },
  rows: (body: Record<string, unknown>) => request<{ result: QueryResult }>('/rows', { method: 'POST', body: JSON.stringify(body) }),
  tableOps: (body: Record<string, unknown>) =>
    request<{ statements: string[]; ddl?: string; batch?: QueryBatchResult; supported?: boolean; message?: string }>('/tables/ops', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  databaseOps: (body: Record<string, unknown>) =>
    request<{ supported: boolean; statements: string[]; message?: string }>('/databases/ops', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  replaceData: (body: Record<string, unknown>) =>
    request<{ affected: number; sql: string; preview: boolean }>('/data/replace', { method: 'POST', body: JSON.stringify(body) }),
  ddlPreview: (body: Record<string, unknown>) => request<{ statements: string[]; ddl?: string }>('/ddl/preview', { method: 'POST', body: JSON.stringify(body) }),
  ddlExecute: (body: Record<string, unknown>) => request<{ batch: QueryBatchResult }>('/ddl/execute', { method: 'POST', body: JSON.stringify(body) }),
  exportData: (body: Record<string, unknown>) => request<{ file: { path: string; bytes: number; rows: number }; format: string }>('/export', { method: 'POST', body: JSON.stringify(body) }),
  importCsv: (body: Record<string, unknown>) =>
    request<{ result: { inserted: number; skipped: number; errors: string[]; columns: string[] } }>('/import', { method: 'POST', body: JSON.stringify(body) }),
  history: (params: { connectionId?: string; search?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
    return request<{ items: Array<{ id: string; sql: string; status: string; durationMs?: number; rowCount?: number; error?: string; createdAt: string }> }>(`/history?${q.toString()}`);
  },
  clearHistory: () => request<void>('/history', { method: 'DELETE' }),
  backups: (connectionId?: string) => request<{ backups: BackupInfo[] }>(`/backups${connectionId ? `?connectionId=${connectionId}` : ''}`),
  createBackup: (body: { connectionId: string; database?: string; label?: string }) => request<{ backup: BackupInfo }>('/backups', { method: 'POST', body: JSON.stringify(body) }),
  audit: (params: { limit?: number; connectionId?: string; actor?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value));
    return request<{ entries: AuditEntry[] }>(`/audit?${q.toString()}`);
  },

  sessions: () => request<{ sessions: AgentSessionMeta[] }>('/agent/sessions'),
  createSession: (body: { connectionId?: string; title?: string; permissionMode?: string }) =>
    request<{ session: AgentSessionMeta }>('/agent/sessions', { method: 'POST', body: JSON.stringify(body) }),
  getSession: (id: string) => request<SessionDetail>(`/agent/sessions/${id}`),
  updateSession: (id: string, body: Record<string, unknown>) => request<{ session: AgentSessionMeta }>(`/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSession: (id: string) => request<void>(`/agent/sessions/${id}`, { method: 'DELETE' }),
  abort: (id: string) => request<{ ok: boolean }>(`/agent/sessions/${id}/abort`, { method: 'POST' }),
  approve: (approvalId: string, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') =>
    request<{ ok: boolean }>(`/agent/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ decision, scope }) }),

  memories: (params: { q?: string; kind?: string; includeArchived?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.q) q.set('q', params.q);
    if (params.kind) q.set('kind', params.kind);
    if (params.includeArchived) q.set('includeArchived', '1');
    return request<{ memories: Memory[] }>(`/agent/memories?${q.toString()}`);
  },
  createMemory: (body: Record<string, unknown>) => request<{ memory: Memory; merged: boolean }>('/agent/memories', { method: 'POST', body: JSON.stringify(body) }),
  updateMemory: (id: string, body: Record<string, unknown>) => request<{ memory: Memory }>(`/agent/memories/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMemory: (id: string) => request<void>(`/agent/memories/${id}`, { method: 'DELETE' }),

  updateSettings: (body: Record<string, unknown>) => request<{ settings: AppSettings }>('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  searchDatabase: (body: { connectionId: string; database?: string; query: string; scope?: 'objects' | 'data' | 'all' }) =>
    request<any>('/search', { method: 'POST', body: JSON.stringify(body) }),
  compareSchemas: (body: { sourceId: string; sourceDatabase?: string; targetId: string; targetDatabase?: string }) =>
    request<{ diff: any }>('/schema/compare', { method: 'POST', body: JSON.stringify(body) }),
  syncSchema: (body: { connectionId: string; database?: string; statements: string[] }) =>
    request<{ batch: QueryBatchResult }>('/schema/sync', { method: 'POST', body: JSON.stringify(body) }),
  transfer: (body: Record<string, unknown>) => request<{ result: any }>('/transfer', { method: 'POST', body: JSON.stringify(body) }),
  generateData: (body: Record<string, unknown>) => request<{ result: any }>('/generate', { method: 'POST', body: JSON.stringify(body) }),
  monitor: (connectionId: string) => request<{ monitor: any }>(`/monitor?connectionId=${encodeURIComponent(connectionId)}`),
  killSession: (body: { connectionId: string; sessionId: string }) => request<{ result: any }>('/monitor/kill', { method: 'POST', body: JSON.stringify(body) }),
  users: (connectionId: string) => request<any>(`/users?connectionId=${encodeURIComponent(connectionId)}`),
  userAction: (body: Record<string, unknown>) => request<{ result: any }>('/users/action', { method: 'POST', body: JSON.stringify(body) }),
  objects: (connectionId: string, database?: string) =>
    request<{ objects: any }>(`/objects?connectionId=${encodeURIComponent(connectionId)}${database ? `&database=${encodeURIComponent(database)}` : ''}`),
  tableOptions: (connectionId: string, table: string, database?: string) =>
    request<{ supported: boolean; options: Array<{ label: string; value: string }>; note?: string }>(
      `/table-options?connectionId=${encodeURIComponent(connectionId)}&table=${encodeURIComponent(table)}${database ? `&database=${encodeURIComponent(database)}` : ''}`,
    ),
  agentModels: (body: { kind: string; baseUrl: string; apiKey?: string }) =>
    request<{ models: string[]; endpoint: string }>('/agent/models', { method: 'POST', body: JSON.stringify(body) }),
  compareData: (body: { sourceId: string; sourceDatabase?: string; targetId: string; targetDatabase?: string; tables?: string[] }) =>
    request<{ result: any }>('/data/compare', { method: 'POST', body: JSON.stringify(body) }),
  snippets: () => request<{ snippets: any[] }>('/snippets'),
  createSnippet: (body: { name: string; sql: string; tags?: string[] }) => request<{ snippet: any }>('/snippets', { method: 'POST', body: JSON.stringify(body) }),
  deleteSnippet: (id: string) => request<void>(`/snippets/${id}`, { method: 'DELETE' }),
  dictionary: (connectionId: string, database?: string) =>
    request<{ dictionary: any }>(`/dictionary?connectionId=${encodeURIComponent(connectionId)}${database ? `&database=${encodeURIComponent(database)}` : ''}`),
  jobs: () => request<{ jobs: any[] }>('/jobs'),
  createJob: (body: Record<string, unknown>) => request<{ job: any }>('/jobs', { method: 'POST', body: JSON.stringify(body) }),
  updateJob: (id: string, body: Record<string, unknown>) => request<{ job: any }>(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteJob: (id: string) => request<void>(`/jobs/${id}`, { method: 'DELETE' }),
  runJob: (id: string) => request<{ ok: boolean; message: string }>(`/jobs/${id}/run`, { method: 'POST' }),
  restoreBackup: (id: string) => request<{ batch: QueryBatchResult }>(`/backups/${id}/restore`, { method: 'POST' }),

  pairStart: () => request<{ code: string; expiresIn: number; qrPayload: string; host: string; port: number }>('/pair/start', { method: 'POST' }),
  devices: () => request<{ devices: DeviceInfo[] }>('/devices'),
  revokeDevice: (id: string) => request<void>(`/devices/${id}`, { method: 'DELETE' }),
};
