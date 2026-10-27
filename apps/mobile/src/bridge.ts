import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type {
  AgentMessage,
  AgentSessionMeta,
  AppSettings,
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

  session(id: string) {
    return this.request<SessionDetail>(`/agent/sessions/${id}`);
  }

  createSession(body: { connectionId?: string; permissionMode?: PermissionMode; title?: string }) {
    return this.request<{ session: AgentSessionMeta }>('/agent/sessions', { method: 'POST', body: JSON.stringify(body) });
  }

  deleteSession(id: string) {
    return this.request<void>(`/agent/sessions/${id}`, { method: 'DELETE' });
  }

  schema(connectionId: string) {
    return this.request<{ schemas: DatabaseSchema[] }>(`/connections/${connectionId}/schema`);
  }

  data(connectionId: string, table: string, limit = 50, offset = 0) {
    const params = new URLSearchParams({ connectionId, table, limit: String(limit), offset: String(offset) });
    return this.request<DataPage>(`/data?${params.toString()}`);
  }

  memories(q = '') {
    return this.request<{ memories: Memory[] }>(`/agent/memories?q=${encodeURIComponent(q)}&limit=100`);
  }

  updateMemory(id: string, patch: Record<string, unknown>) {
    return this.request<{ memory: Memory }>(`/agent/memories/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
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
