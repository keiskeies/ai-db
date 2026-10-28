import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS,
  bundleAgentContext,
  emptyBundle,
  isDuplicateMemory,
  looksLikeSecret,
  mergeMemoryContent,
  rankMemories,
  type AgentContextBundle,
  type AgentContextEntry,
  type AgentMessage,
  type AgentMessageBlock,
  type AgentSessionMeta,
  type AppSettings,
  type AuditEntry,
  type BackupInfo,
  type ConnectionColor,
  type ConnectionConfig,
  type ConnectionSecret,
  type DeviceInfo,
  type Engine,
  type Environment,
  type JobInfo,
  type Memory,
  type MemoryCandidate,
  type MemoryKind,
  type PermissionMode,
  type QueryHistoryItem,
  type SshConfig,
} from '@aidb/core';
import { SecretBox } from './crypto';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  engine TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  environment TEXT NOT NULL DEFAULT 'dev' CHECK (environment IN ('dev','staging','prod')),
  group_name TEXT NOT NULL DEFAULT '默认',
  host TEXT, port INTEGER, database TEXT, username TEXT,
  secret TEXT, ssl INTEGER NOT NULL DEFAULT 0, ssh_json TEXT,
  readonly INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS query_history (
  id TEXT PRIMARY KEY, connection_id TEXT, database_name TEXT, sql TEXT NOT NULL,
  status TEXT NOT NULL, duration_ms INTEGER, row_count INTEGER, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_conn ON query_history(connection_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY, connection_id TEXT, database TEXT, title TEXT NOT NULL DEFAULT '新会话', summary TEXT,
  model TEXT, permission_mode TEXT NOT NULL DEFAULT 'ask', status TEXT NOT NULL DEFAULT 'idle',
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', blocks_json TEXT,
  tokens INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT, tool TEXT NOT NULL,
  args_json TEXT, result_json TEXT, status TEXT NOT NULL, risk TEXT, approval TEXT,
  duration_ms INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '*',
  kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT,
  importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
  source_session TEXT, source_message TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope_type, scope_key, archived);
CREATE INDEX IF NOT EXISTS idx_mem_kind ON memories(kind, importance DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, connection_id TEXT, database_name TEXT, tool TEXT, sql TEXT,
  risk TEXT, approval TEXT, status TEXT NOT NULL, duration_ms INTEGER, meta_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL,
  paired_at TEXT NOT NULL, last_seen_at TEXT, revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, database_name TEXT, path TEXT NOT NULL,
  format TEXT NOT NULL, bytes INTEGER, label TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_cache (
  connection_id TEXT NOT NULL, database_name TEXT NOT NULL, payload TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, database_name)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, connection_id TEXT NOT NULL, database_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('query','backup')), sql TEXT,
  interval_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, last_status TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL, tags TEXT,
  connection_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_context (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  database_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('table','column','relation')),
  table_name TEXT NOT NULL,
  column_name TEXT,
  ref_table TEXT,
  ref_column TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  alias TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_ctx ON agent_context(connection_id, database_name, kind);
`;

interface ConnectionRow {
  id: string;
  name: string;
  engine: Engine;
  color: ConnectionColor;
  environment: Environment;
  group_name: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  secret: string | null;
  ssl: number;
  ssh_json: string | null;
  readonly: number;
  note: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface SessionRow {
  id: string;
  connection_id: string | null;
  database: string | null;
  title: string;
  summary: string | null;
  model: string | null;
  permission_mode: PermissionMode;
  status: AgentSessionMeta['status'];
  tokens_in: number;
  tokens_out: number;
  created_at: string;
  updated_at: string;
  archived: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: AgentMessage['role'];
  content: string;
  blocks_json: string | null;
  tokens: number | null;
  created_at: string;
}

interface MemoryRow {
  id: string;
  scope_type: Memory['scopeType'];
  scope_key: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string | null;
  importance: number;
  confidence: number;
  source_session: string | null;
  source_message: string | null;
  pinned: number;
  archived: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentContextRow {
  id: string;
  connection_id: string;
  database_name: string;
  kind: AgentContextEntry['kind'];
  table_name: string;
  column_name: string | null;
  ref_table: string | null;
  ref_column: string | null;
  enabled: number;
  alias: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface AuditRow {
  id: string;
  actor: AuditEntry['actor'];
  connection_id: string | null;
  database_name: string | null;
  tool: string | null;
  sql: string | null;
  risk: AuditEntry['risk'] | null;
  approval: string | null;
  status: AuditEntry['status'];
  duration_ms: number | null;
  meta_json: string | null;
  created_at: string;
}

export interface ConnectionInput {
  name: string;
  engine: Engine;
  color?: ConnectionColor;
  environment?: Environment;
  groupName?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  ssl?: boolean;
  ssh?: SshConfig;
  readonly?: boolean;
  note?: string;
}

const iso = () => new Date().toISOString();

/** 业务语义类记忆：召回时走独立配额，不挤占情景记忆的 6 条名额。 */
const BUSINESS_KINDS: MemoryKind[] = ['glossary', 'sql_example'];

function filterKinds(memories: Memory[], kinds?: MemoryKind[], excludeKinds?: MemoryKind[]): Memory[] {
  if (kinds?.length) {
    const allow = new Set(kinds);
    return memories.filter((m) => allow.has(m.kind));
  }
  if (excludeKinds?.length) {
    const deny = new Set(excludeKinds);
    return memories.filter((m) => !deny.has(m.kind));
  }
  return memories;
}

export class Store {
  readonly db: DatabaseSync;
  private box: SecretBox;
  private contextCache = new Map<string, { at: number; bundle: AgentContextBundle }>();

  constructor(dbPath: string, secret: string) {
    this.db = new DatabaseSync(dbPath);
    this.box = new SecretBox(secret);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const version = Number((this.one<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0));
    const hasConnections = Boolean(this.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connections'"));
    if (version < 2 && version >= 1 && hasConnections) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('ALTER TABLE connections RENAME TO connections_v1');
        this.db.exec(SCHEMA_SQL);
        this.db.exec(`INSERT INTO connections
          (id,name,engine,color,environment,group_name,host,port,database,username,secret,ssl,ssh_json,readonly,note,created_at,updated_at,last_used_at)
          SELECT id,name,engine,color,environment,group_name,host,port,database,username,secret,ssl,ssh_json,readonly,note,created_at,updated_at,last_used_at
          FROM connections_v1`);
        this.db.exec('DROP TABLE connections_v1');
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } else {
      this.db.exec(SCHEMA_SQL);
    }
    // 连接不再要求填库名之后，会话必须自己记住选中的库，否则重开会话会悄悄跑回默认库
    this.ensureColumn('agent_sessions', 'database', 'TEXT');
    this.db.exec('PRAGMA user_version = 4');
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const exists = this.all<{ name: string }>(`PRAGMA table_info(${table})`).some((item) => item.name === column);
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  close(): void {
    this.db.close();
  }

  private all<T>(sql: string, params: unknown[] = []): T[] {
    return (this.db.prepare(sql).all as (...args: unknown[]) => unknown)(...params) as T[];
  }

  private one<T>(sql: string, params: unknown[] = []): T | undefined {
    return (this.db.prepare(sql).get as (...args: unknown[]) => unknown)(...params) as T | undefined;
  }

  private exec(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    return (this.db.prepare(sql).run as (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint })(...params);
  }

  // ---------- connections ----------
  private rowToConfig(row: ConnectionRow): ConnectionConfig {
    let ssh: SshConfig | undefined;
    if (row.ssh_json) {
      try {
        ssh = JSON.parse(row.ssh_json) as SshConfig;
      } catch {
        ssh = undefined;
      }
    }
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      color: row.color,
      environment: row.environment,
      groupName: row.group_name,
      host: row.host ?? undefined,
      port: row.port ?? undefined,
      database: row.database ?? undefined,
      username: row.username ?? undefined,
      hasPassword: Boolean(row.secret),
      ssl: Boolean(row.ssl),
      ssh,
      readonly: Boolean(row.readonly),
      note: row.note ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  listConnections(): ConnectionConfig[] {
    return this.all<ConnectionRow>('SELECT * FROM connections ORDER BY group_name, name').map((r) => this.rowToConfig(r));
  }

  getConnectionRow(id: string): ConnectionRow | undefined {
    return this.one<ConnectionRow>('SELECT * FROM connections WHERE id = ?', [id]);
  }

  getConnection(id: string): ConnectionConfig | undefined {
    const row = this.getConnectionRow(id);
    return row ? this.rowToConfig(row) : undefined;
  }

  getConnectionSecret(id: string): ConnectionSecret {
    const row = this.getConnectionRow(id);
    if (!row?.secret) return {};
    return this.box.decrypt<ConnectionSecret>(row.secret) ?? {};
  }

  createConnection(input: ConnectionInput): ConnectionConfig {
    const id = randomUUID();
    const now = iso();
    const secret: ConnectionSecret & { sshPassphrase?: string } = {};
    const sshPassword = input.sshPassword ?? input.ssh?.password;
    const sshPassphrase = input.sshPassphrase ?? input.ssh?.passphrase;
    if (input.password) secret.password = input.password;
    if (sshPassword) secret.sshPassword = sshPassword;
    if (input.sshPrivateKey) secret.sshPrivateKey = input.sshPrivateKey;
    if (sshPassphrase) secret.sshPassphrase = sshPassphrase;
    const ssh = input.ssh ? { ...input.ssh, password: undefined, passphrase: undefined } : undefined;
    this.exec(
      `INSERT INTO connections (id,name,engine,color,environment,group_name,host,port,database,username,secret,ssl,ssh_json,readonly,note,created_at,updated_at,last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [
        id,
        input.name,
        input.engine,
        input.color ?? 'blue',
        input.environment ?? 'dev',
        input.groupName ?? '默认',
        input.host ?? null,
        input.port ?? null,
        input.database ?? null,
        input.username ?? null,
        Object.keys(secret).length ? this.box.encrypt(secret) : null,
        input.ssl ? 1 : 0,
        ssh ? JSON.stringify(ssh) : null,
        input.readonly ? 1 : 0,
        input.note ?? null,
        now,
        now,
      ],
    );
    return this.getConnection(id)!;
  }

  updateConnection(id: string, patch: Partial<ConnectionInput>): ConnectionConfig {
    const row = this.getConnectionRow(id);
    if (!row) throw new Error('连接不存在');
    const existingSecret = row.secret ? this.box.decrypt<Record<string, unknown>>(row.secret) ?? {} : {};
    const secret: Record<string, unknown> = { ...existingSecret };
    const setOrClear = (key: string, value?: string) => {
      if (value === undefined) return;
      if (value === '') delete secret[key];
      else secret[key] = value;
    };
    setOrClear('password', patch.password);
    setOrClear('sshPassword', patch.sshPassword ?? patch.ssh?.password);
    setOrClear('sshPrivateKey', patch.sshPrivateKey);
    setOrClear('sshPassphrase', patch.sshPassphrase ?? patch.ssh?.passphrase);

    let ssh = row.ssh_json;
    if (patch.ssh !== undefined) {
      ssh = patch.ssh ? JSON.stringify({ ...patch.ssh, password: undefined, passphrase: undefined }) : null;
    }
    const next = {
      name: patch.name ?? row.name,
      engine: patch.engine ?? row.engine,
      color: patch.color ?? row.color,
      environment: patch.environment ?? row.environment,
      group: patch.groupName ?? row.group_name,
      host: patch.host !== undefined ? patch.host : row.host,
      port: patch.port !== undefined ? patch.port : row.port,
      database: patch.database !== undefined ? patch.database : row.database,
      username: patch.username !== undefined ? patch.username : row.username,
      ssl: patch.ssl !== undefined ? (patch.ssl ? 1 : 0) : row.ssl,
      readonly: patch.readonly !== undefined ? (patch.readonly ? 1 : 0) : row.readonly,
      note: patch.note !== undefined ? patch.note : row.note,
    };
    this.exec(
      `UPDATE connections SET name=?, engine=?, color=?, environment=?, group_name=?, host=?, port=?, database=?, username=?,
        secret=?, ssl=?, ssh_json=?, readonly=?, note=?, updated_at=? WHERE id=?`,
      [
        next.name,
        next.engine,
        next.color,
        next.environment,
        next.group,
        next.host ?? null,
        next.port ?? null,
        next.database ?? null,
        next.username ?? null,
        Object.keys(secret).length ? this.box.encrypt(secret) : null,
        next.ssl,
        ssh,
        next.readonly,
        next.note ?? null,
        iso(),
        id,
      ],
    );
    return this.getConnection(id)!;
  }

  deleteConnection(id: string): void {
    this.exec('DELETE FROM connections WHERE id = ?', [id]);
  }

  touchConnection(id: string): void {
    this.exec('UPDATE connections SET last_used_at = ? WHERE id = ?', [iso(), id]);
  }

  // ---------- settings ----------
  private getSetting(key: string): string | undefined {
    return this.one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value;
  }

  private setSetting(key: string, value: string): void {
    this.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  getSettings(): AppSettings {
    let stored: Partial<AppSettings> = {};
    const raw = this.getSetting('app');
    if (raw) {
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = {};
      }
    }
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      agent: { ...DEFAULT_SETTINGS.agent, ...(stored.agent ?? {}) },
    };
    const enc = this.getSetting('agentApiKey');
    const decrypted = this.box.decrypt<{ apiKey: string }>(enc);
    if (decrypted?.apiKey) merged.agent.apiKey = decrypted.apiKey;
    if (process.env.AIDB_API_KEY) merged.agent.apiKey = process.env.AIDB_API_KEY;
    merged.agent.hasApiKey = Boolean(merged.agent.apiKey);
    return merged;
  }

  publicSettings(): AppSettings {
    const settings = this.getSettings();
    return { ...settings, agent: { ...settings.agent, apiKey: undefined, hasApiKey: Boolean(settings.agent.apiKey) } };
  }

  saveSettings(next: AppSettings): AppSettings {
    const current = this.getSettings();
    const incomingKey = next.agent.apiKey;
    let apiKey = current.agent.apiKey;
    let keyChanged = false;
    if (incomingKey === '__CLEAR__') {
      apiKey = undefined;
      keyChanged = true;
    } else if (incomingKey !== undefined && incomingKey !== '') {
      apiKey = incomingKey;
      keyChanged = true;
    }
    const sanitized: AppSettings = {
      ...next,
      agent: { ...next.agent, apiKey: undefined, hasApiKey: Boolean(apiKey ?? process.env.AIDB_API_KEY) },
    };
    this.setSetting('app', JSON.stringify(sanitized));
    if (keyChanged) this.setAgentApiKey(apiKey);
    return this.getSettings();
  }

  // ---------- query history ----------
  addHistory(item: Omit<QueryHistoryItem, 'id' | 'createdAt'>): QueryHistoryItem {
    const entry: QueryHistoryItem = { ...item, id: randomUUID(), createdAt: iso() };
    this.exec(
      'INSERT INTO query_history (id,connection_id,database_name,sql,status,duration_ms,row_count,error,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [entry.id, entry.connectionId ?? null, entry.database ?? null, entry.sql, entry.status, entry.durationMs ?? null, entry.rowCount ?? null, entry.error ?? null, entry.createdAt],
    );
    return entry;
  }

  listHistory(opts: { connectionId?: string; search?: string; limit?: number } = {}): QueryHistoryItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.connectionId) {
      clauses.push('connection_id = ?');
      params.push(opts.connectionId);
    }
    if (opts.search) {
      clauses.push('sql LIKE ?');
      params.push(`%${opts.search}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    return this.all<Record<string, any>>(`SELECT * FROM query_history ${where} ORDER BY created_at DESC LIMIT ${limit}`, params).map((r) => ({
      id: r.id,
      connectionId: r.connection_id ?? undefined,
      database: r.database_name ?? undefined,
      sql: r.sql,
      status: r.status,
      durationMs: r.duration_ms ?? undefined,
      rowCount: r.row_count ?? undefined,
      error: r.error ?? undefined,
      createdAt: r.created_at,
    }));
  }

  clearHistory(): void {
    this.exec('DELETE FROM query_history');
  }

  // ---------- agent sessions ----------
  private rowToSession(row: SessionRow): AgentSessionMeta {
    return {
      id: row.id,
      connectionId: row.connection_id ?? undefined,
      database: row.database ?? undefined,
      title: row.title,
      summary: row.summary ?? undefined,
      model: row.model ?? undefined,
      permissionMode: row.permission_mode,
      status: row.status,
      tokensIn: row.tokens_in ?? 0,
      tokensOut: row.tokens_out ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createSession(input: { connectionId?: string; database?: string; title?: string; model?: string; permissionMode?: PermissionMode } = {}): AgentSessionMeta {
    const id = randomUUID();
    const now = iso();
    this.exec(
      'INSERT INTO agent_sessions (id,connection_id,database,title,model,permission_mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, input.connectionId ?? null, input.database ?? null, input.title ?? '新会话', input.model ?? null, input.permissionMode ?? 'ask', 'idle', now, now],
    );
    return this.getSession(id)!;
  }

  getSession(id: string): AgentSessionMeta | undefined {
    const row = this.one<SessionRow>('SELECT * FROM agent_sessions WHERE id = ?', [id]);
    return row ? this.rowToSession(row) : undefined;
  }

  listSessions(limit = 60): AgentSessionMeta[] {
    return this.all<SessionRow>(`SELECT * FROM agent_sessions WHERE archived = 0 ORDER BY updated_at DESC LIMIT ${Math.min(200, limit)}`).map((r) => this.rowToSession(r));
  }

  updateSession(
    id: string,
    patch: Partial<Pick<AgentSessionMeta, 'connectionId' | 'database' | 'title' | 'summary' | 'model' | 'permissionMode' | 'status' | 'tokensIn' | 'tokensOut'>> & { archived?: boolean },
  ): AgentSessionMeta {
    const map: Record<string, string> = {
      connectionId: 'connection_id',
      database: 'database',
      title: 'title',
      summary: 'summary',
      model: 'model',
      permissionMode: 'permission_mode',
      status: 'status',
      tokensIn: 'tokens_in',
      tokensOut: 'tokens_out',
      archived: 'archived',
    };
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [iso()];
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    params.push(id);
    this.exec(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getSession(id)!;
  }

  deleteSession(id: string): void {
    this.exec('DELETE FROM agent_sessions WHERE id = ?', [id]);
  }

  appendMessage(input: { sessionId: string; role: AgentMessage['role']; content: string; blocks?: AgentMessageBlock[]; tokens?: number }): AgentMessage {
    const seqRow = this.one<{ seq: number }>('SELECT COALESCE(MAX(seq),0) + 1 AS seq FROM messages WHERE session_id = ?', [input.sessionId]);
    const seq = seqRow?.seq ?? 1;
    const message: AgentMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      seq,
      role: input.role,
      content: input.content,
      blocks: input.blocks ?? [],
      tokens: input.tokens,
      createdAt: iso(),
    };
    this.exec('INSERT INTO messages (id,session_id,seq,role,content,blocks_json,tokens,created_at) VALUES (?,?,?,?,?,?,?,?)', [
      message.id,
      message.sessionId,
      message.seq,
      message.role,
      message.content,
      message.blocks.length ? JSON.stringify(message.blocks) : null,
      message.tokens ?? null,
      message.createdAt,
    ]);
    return message;
  }

  listMessages(sessionId: string): AgentMessage[] {
    return this.all<MessageRow>('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC', [sessionId]).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      role: r.role,
      content: r.content,
      blocks: r.blocks_json ? (JSON.parse(r.blocks_json) as AgentMessageBlock[]) : [],
      tokens: r.tokens ?? undefined,
      createdAt: r.created_at,
    }));
  }

  addToolRun(input: { id: string; sessionId: string; messageId?: string; tool: string; args?: unknown; result?: unknown; status: string; risk?: string; approval?: string; durationMs?: number }): void {
    this.exec(
      'INSERT INTO tool_runs (id,session_id,message_id,tool,args_json,result_json,status,risk,approval,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        input.id,
        input.sessionId,
        input.messageId ?? null,
        input.tool,
        input.args === undefined ? null : JSON.stringify(input.args),
        input.result === undefined ? null : JSON.stringify(input.result),
        input.status,
        input.risk ?? null,
        input.approval ?? null,
        input.durationMs ?? null,
        iso(),
      ],
    );
  }

  listToolRuns(sessionId: string): Array<Record<string, unknown>> {
    return this.all<Record<string, unknown>>('SELECT * FROM tool_runs WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);
  }

  // ---------- memories ----------
  private rowToMemory(row: MemoryRow): Memory {
    let tags: string[] = [];
    try {
      tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      kind: row.kind,
      title: row.title,
      content: row.content,
      tags,
      importance: row.importance,
      confidence: row.confidence,
      sourceSession: row.source_session ?? undefined,
      sourceMessage: row.source_message ?? undefined,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      useCount: row.use_count,
      lastUsedAt: row.last_used_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMemories(opts: { q?: string; kind?: string; scopeType?: string; includeArchived?: boolean; limit?: number } = {}): Memory[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeArchived) clauses.push('archived = 0');
    if (opts.kind) {
      clauses.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.scopeType) {
      clauses.push('scope_type = ?');
      params.push(opts.scopeType);
    }
    if (opts.q) {
      clauses.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    return this.all<MemoryRow>(`SELECT * FROM memories ${where} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ${limit}`, params).map((r) => this.rowToMemory(r));
  }

  getMemory(id: string): Memory | undefined {
    const row = this.one<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id]);
    return row ? this.rowToMemory(row) : undefined;
  }

  createMemory(candidate: MemoryCandidate, ctx: { connectionId?: string; database?: string; sessionId?: string; messageId?: string } = {}): Memory {
    if (looksLikeSecret(`${candidate.title} ${candidate.content}`)) {
      throw new Error('记忆内容疑似包含凭据或密钥，已拒绝写入');
    }
    const scopeType = candidate.scopeType ?? (ctx.database ? 'database' : ctx.connectionId ? 'connection' : 'global');
    const scopeKey =
      candidate.scopeKey ??
      (scopeType === 'connection' && ctx.connectionId
        ? ctx.connectionId
        : scopeType === 'database' && ctx.connectionId && ctx.database
          ? `${ctx.connectionId}/${ctx.database}`
          : '*');
    const now = iso();
    const id = randomUUID();
    this.exec(
      `INSERT INTO memories (id,scope_type,scope_key,kind,title,content,tags,importance,confidence,source_session,source_message,pinned,archived,use_count,last_used_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,NULL,?,?)`,
      [
        id,
        scopeType,
        scopeKey,
        candidate.kind,
        candidate.title.slice(0, 200),
        candidate.content,
        JSON.stringify(candidate.tags ?? []),
        Math.min(1, Math.max(0, candidate.importance ?? 0.5)),
        Math.min(1, Math.max(0, candidate.confidence ?? 0.7)),
        ctx.sessionId ?? null,
        ctx.messageId ?? null,
        now,
        now,
      ],
    );
    return this.getMemory(id)!;
  }

  upsertMemoryCandidate(candidate: MemoryCandidate, ctx: { connectionId?: string; database?: string; sessionId?: string; messageId?: string } = {}): { memory: Memory; merged: boolean } {
    const scopeType = candidate.scopeType ?? (ctx.database ? 'database' : ctx.connectionId ? 'connection' : 'global');
    const scopeKey =
      candidate.scopeKey ??
      (scopeType === 'connection' && ctx.connectionId
        ? ctx.connectionId
        : scopeType === 'database' && ctx.connectionId && ctx.database
          ? `${ctx.connectionId}/${ctx.database}`
          : '*');
    const existing = this.all<MemoryRow>('SELECT * FROM memories WHERE scope_type = ? AND scope_key = ? AND kind = ? AND archived = 0', [
      scopeType,
      scopeKey,
      candidate.kind,
    ]).map((r) => this.rowToMemory(r));
    const duplicate = existing.find((m) => isDuplicateMemory(candidate, m));
    if (duplicate) {
      const merged = mergeMemoryContent(duplicate, candidate);
      const tags = [...new Set([...(duplicate.tags ?? []), ...(candidate.tags ?? [])])];
      this.exec('UPDATE memories SET title=?, content=?, importance=?, tags=?, confidence=?, updated_at=? WHERE id=?', [
        merged.title,
        merged.content,
        merged.importance,
        JSON.stringify(tags),
        Math.max(duplicate.confidence, candidate.confidence ?? 0.7),
        merged.updatedAt,
        duplicate.id,
      ]);
      return { memory: this.getMemory(duplicate.id)!, merged: true };
    }
    return { memory: this.createMemory({ ...candidate, scopeType, scopeKey }, ctx), merged: false };
  }

  updateMemory(
    id: string,
    patch: Partial<Pick<Memory, 'title' | 'content' | 'kind' | 'importance' | 'confidence' | 'pinned' | 'archived' | 'tags'>>,
  ): Memory {
    const sets: string[] = [];
    const params: unknown[] = [];
    const mapping: Record<string, string> = {
      title: 'title',
      content: 'content',
      kind: 'kind',
      importance: 'importance',
      confidence: 'confidence',
      pinned: 'pinned',
      archived: 'archived',
      tags: 'tags',
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      let value = (patch as Record<string, unknown>)[key];
      if (key === 'tags') value = JSON.stringify(value ?? []);
      if (typeof value === 'boolean') value = value ? 1 : 0;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(iso(), id);
      this.exec(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    return this.getMemory(id)!;
  }

  deleteMemory(id: string): void {
    this.exec('DELETE FROM memories WHERE id = ?', [id]);
  }

  markMemoriesUsed(ids: string[]): void {
    if (!ids.length) return;
    const now = iso();
    const placeholders = ids.map(() => '?').join(',');
    this.exec(`UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id IN (${placeholders})`, [now, ...ids]);
  }

  searchMemories(
    query: string,
    ctx: { connectionId?: string; database?: string; limit?: number; kinds?: MemoryKind[]; excludeKinds?: MemoryKind[] } = {},
  ): Memory[] {
    const all = this.listMemories({ includeArchived: false, limit: 500 });
    // 作用域先硬过滤再排序：只按分数加权的话，A 库的业务口径会顶着字面相似度串到 B 库
    const memories = filterKinds(all, ctx.kinds, ctx.excludeKinds).filter((memory) => this.memoryInScope(memory, ctx));
    const limit = ctx.limit ?? 8;
    if (!query.trim()) {
      return this.uniqueMemories(
        memories.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance),
        limit,
      );
    }
    // 多取一些再按标题去重，否则同一个问题问过几次就会占满召回名额
    const ranked = rankMemories(query, memories, { connectionId: ctx.connectionId, database: ctx.database, limit: limit * 3 });
    const unique = this.uniqueMemories(ranked, limit);
    this.markMemoriesUsed(unique.map((m) => m.id));
    return unique;
  }

  /** 记忆的可见范围：global 处处可见，connection / database / table 只在本作用域内召回。 */
  private memoryInScope(memory: Memory, ctx: { connectionId?: string; database?: string }): boolean {
    if (memory.scopeType === 'global') return true;
    if (!ctx.connectionId) return false;
    if (memory.scopeType === 'connection') return memory.scopeKey === ctx.connectionId;
    if (memory.scopeType === 'database') return Boolean(ctx.database) && memory.scopeKey === `${ctx.connectionId}/${ctx.database}`;
    if (memory.scopeType === 'table') return memory.scopeKey.startsWith(`${ctx.connectionId}/`);
    return false;
  }

  /** 同一问题被反复提问会存成多条同标题的情景记忆；召回按「类型 + 标题」只留排序最前的那条。 */
  private uniqueMemories(list: Memory[], limit: number): Memory[] {
    const seen = new Set<string>();
    const out: Memory[] = [];
    for (const memory of list) {
      const key = `${memory.kind}:${(memory.title ?? '').trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(memory);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 单轮召回：业务语义（术语 / 示例 SQL）走独立配额，不与情景记忆争名额。
   * 无相关记忆时三类均为空数组，prompt 输出与未引入该机制前完全一致。
   */
  recallForTurn(query: string, ctx: { connectionId?: string; database?: string } = {}): {
    memories: Memory[];
    glossary: Memory[];
    sqlExamples: Memory[];
  } {
    const scope = { connectionId: ctx.connectionId, database: ctx.database };
    const memories = this.searchMemories(query, { ...scope, limit: 6, excludeKinds: BUSINESS_KINDS });
    // 术语与示例 SQL 是常驻业务上下文，即使与本轮问题字面不相关也应注入，故空查询时按重要度兜底。
    const glossary = this.searchMemories(query, { ...scope, limit: 20, kinds: ['glossary'] });
    const sqlExamples = this.searchMemories(query, { ...scope, limit: 3, kinds: ['sql_example'] });
    return { memories, glossary, sqlExamples };
  }

  // ---------- agent context (业务上下文覆盖) ----------
  private rowToAgentContext(row: AgentContextRow): AgentContextEntry {
    return {
      id: row.id,
      connectionId: row.connection_id,
      database: row.database_name,
      kind: row.kind,
      table: row.table_name,
      column: row.column_name ?? undefined,
      refTable: row.ref_table ?? undefined,
      refColumn: row.ref_column ?? undefined,
      enabled: Boolean(row.enabled),
      alias: row.alias ?? undefined,
      description: row.description ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 列出覆盖项。`database` 为 undefined 时返回该连接的全部库配置；
   * 传入具体库名（含空串）时精确匹配，避免把 A 库的配置套到 B 库上。
   */
  listAgentContext(connectionId: string, database?: string): AgentContextEntry[] {
    const rows =
      database === undefined
        ? this.all<AgentContextRow>('SELECT * FROM agent_context WHERE connection_id = ? ORDER BY kind, table_name, column_name', [connectionId])
        : this.all<AgentContextRow>('SELECT * FROM agent_context WHERE connection_id = ? AND database_name = ? ORDER BY kind, table_name, column_name', [
            connectionId,
            database,
          ]);
    return rows.map((r) => this.rowToAgentContext(r));
  }

  /**
   * upsert 表 / 列覆盖。定位键：connection + database + kind + table + column。
   * 传入的字段为 undefined 表示「不改」；传 null 表示「清空」。
   */
  upsertAgentContextEntry(input: {
    id?: string;
    connectionId: string;
    database?: string;
    kind: 'table' | 'column';
    table: string;
    column?: string;
    enabled?: boolean;
    alias?: string | null;
    description?: string | null;
  }): AgentContextEntry {
    if (input.kind === 'column' && !input.column?.trim()) throw new Error('列覆盖必须提供 column');
    this.invalidateAgentContextCache();
    const database = input.database ?? '';
    const table = input.table.trim();
    const column = input.kind === 'column' ? input.column!.trim() : null;
    const now = iso();
    const existing = this.one<AgentContextRow>(
      'SELECT * FROM agent_context WHERE connection_id = ? AND database_name = ? AND kind = ? AND table_name = ? AND column_name IS ?',
      [input.connectionId, database, input.kind, table, column],
    );
    if (existing) {
      this.exec(
        `UPDATE agent_context SET enabled = ?, alias = ?, description = ?, updated_at = ? WHERE id = ?`,
        [
          input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
          input.alias === undefined ? existing.alias : input.alias,
          input.description === undefined ? existing.description : input.description,
          now,
          existing.id,
        ],
      );
      return this.rowToAgentContext(this.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [existing.id])!);
    }
    const id = input.id ?? randomUUID();
    this.exec(
      `INSERT INTO agent_context (id,connection_id,database_name,kind,table_name,column_name,ref_table,ref_column,enabled,alias,description,created_at,updated_at)
       VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,?)`,
      [id, input.connectionId, database, input.kind, table, column, input.enabled === false ? 0 : 1, input.alias ?? null, input.description ?? null, now, now],
    );
    return this.rowToAgentContext(this.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [id])!);
  }

  /** upsert 手工关联关系；定位键为四元组，避免同一关系重复录入。 */
  upsertAgentRelation(input: {
    connectionId: string;
    database?: string;
    table: string;
    column: string;
    refTable: string;
    refColumn: string;
    description?: string | null;
  }): AgentContextEntry {
    const database = input.database ?? '';
    const now = iso();
    this.invalidateAgentContextCache();
    const existing = this.one<AgentContextRow>(
      `SELECT * FROM agent_context WHERE connection_id = ? AND database_name = ? AND kind = 'relation'
       AND table_name = ? AND column_name = ? AND ref_table = ? AND ref_column = ?`,
      [input.connectionId, database, input.table.trim(), input.column.trim(), input.refTable.trim(), input.refColumn.trim()],
    );
    if (existing) {
      this.exec('UPDATE agent_context SET description = ?, updated_at = ? WHERE id = ?', [
        input.description === undefined ? existing.description : input.description,
        now,
        existing.id,
      ]);
      return this.rowToAgentContext(this.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [existing.id])!);
    }
    const id = randomUUID();
    this.exec(
      `INSERT INTO agent_context (id,connection_id,database_name,kind,table_name,column_name,ref_table,ref_column,enabled,alias,description,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,NULL,?,?,?)`,
      [id, input.connectionId, database, 'relation', input.table.trim(), input.column.trim(), input.refTable.trim(), input.refColumn.trim(), input.description ?? null, now, now],
    );
    return this.rowToAgentContext(this.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [id])!);
  }

  deleteAgentContext(id: string): void {
    this.invalidateAgentContextCache();
    this.exec('DELETE FROM agent_context WHERE id = ?', [id]);
  }

  /** 清空某连接（可选某库）的全部覆盖项，使 Agent 回到未配置的默认行为。 */
  clearAgentContext(connectionId: string, database?: string): number {
    this.invalidateAgentContextCache();
    const result = database
      ? this.exec('DELETE FROM agent_context WHERE connection_id = ? AND database_name = ?', [connectionId, database])
      : this.exec('DELETE FROM agent_context WHERE connection_id = ?', [connectionId]);
    return result.changes;
  }

  /** 批量启用 / 禁用表（表管理面板的「全选 / 反选 / 仅启用勾选」）。 */
  bulkSetAgentContextTables(input: { connectionId: string; database?: string; tables: string[]; enabled: boolean }): number {
    const database = input.database ?? '';
    let touched = 0;
    this.db.exec('BEGIN');
    try {
      for (const raw of input.tables) {
        const table = String(raw).trim();
        if (!table) continue;
        this.upsertAgentContextEntry({ connectionId: input.connectionId, database, kind: 'table', table, enabled: input.enabled });
        touched++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return touched;
  }

  /**
   * 聚合为 prompt 可直接消费的结构；无任何配置时返回 inactive bundle。带 30s 缓存，写操作立即失效。
   * 未指定具体库时返回 inactive——无法判断该套用哪个库的配置，宁可退回默认行为也不误伤。
   */
  agentContextBundle(connectionId: string, database?: string): AgentContextBundle {
    if (!database) return emptyBundle({ connectionId, database: '' });
    const key = `${connectionId}\u0000${database}`;
    const now = Date.now();
    const hit = this.contextCache.get(key);
    if (hit && now - hit.at < 30_000) return hit.bundle;
    const bundle = bundleAgentContext(this.listAgentContext(connectionId, database), { connectionId, database });
    this.contextCache.set(key, { at: now, bundle });
    return bundle;
  }

  private invalidateAgentContextCache(): void {
    this.contextCache.clear();
  }

  // ---------- audit ----------
  addAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'> & { createdAt?: string }): AuditEntry {
    const full: AuditEntry = { ...entry, id: randomUUID(), createdAt: entry.createdAt ?? iso() };
    this.exec(
      'INSERT INTO audit_log (id,actor,connection_id,database_name,tool,sql,risk,approval,status,duration_ms,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        full.id,
        full.actor,
        full.connectionId ?? null,
        full.database ?? null,
        full.tool ?? null,
        full.sql ?? null,
        full.risk ?? null,
        full.approval ?? null,
        full.status,
        full.durationMs ?? null,
        full.meta ? JSON.stringify(full.meta) : null,
        full.createdAt,
      ],
    );
    return full;
  }

  listAudit(opts: { limit?: number; offset?: number; connectionId?: string; actor?: string } = {}): AuditEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.connectionId) {
      clauses.push('connection_id = ?');
      params.push(opts.connectionId);
    }
    if (opts.actor) {
      clauses.push('actor = ?');
      params.push(opts.actor);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(1000, Math.max(1, opts.limit ?? 200));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.all<AuditRow>(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params).map((r) => ({
      id: r.id,
      actor: r.actor,
      connectionId: r.connection_id ?? undefined,
      database: r.database_name ?? undefined,
      tool: r.tool ?? undefined,
      sql: r.sql ?? undefined,
      risk: r.risk ?? undefined,
      approval: r.approval ?? undefined,
      status: r.status,
      durationMs: r.duration_ms ?? undefined,
      meta: r.meta_json ? (JSON.parse(r.meta_json) as Record<string, unknown>) : undefined,
      createdAt: r.created_at,
    }));
  }

  // ---------- devices ----------
  createDevice(input: { name: string; platform: string; tokenHash: string }): DeviceInfo {
    const id = randomUUID();
    const now = iso();
    this.exec('INSERT INTO devices (id,name,platform,token_hash,paired_at,revoked) VALUES (?,?,?,?,?,0)', [id, input.name, input.platform, input.tokenHash, now]);
    return { id, name: input.name, platform: input.platform, pairedAt: now, revoked: false };
  }

  findDeviceByTokenHash(hash: string): DeviceInfo | undefined {
    const row = this.one<Record<string, any>>('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0', [hash]);
    if (!row) return undefined;
    this.exec('UPDATE devices SET last_seen_at = ? WHERE id = ?', [iso(), row.id]);
    return { id: row.id, name: row.name, platform: row.platform, pairedAt: row.paired_at, lastSeenAt: row.last_seen_at ?? undefined, revoked: false };
  }

  listDevices(): DeviceInfo[] {
    return this.all<Record<string, any>>('SELECT * FROM devices ORDER BY paired_at DESC').map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      pairedAt: r.paired_at,
      lastSeenAt: r.last_seen_at ?? undefined,
      revoked: Boolean(r.revoked),
    }));
  }

  revokeDevice(id: string): void {
    this.exec('UPDATE devices SET revoked = 1 WHERE id = ?', [id]);
  }

  // ---------- jobs ----------
  private rowToJob(row: Record<string, any>): JobInfo {
    return {
      id: row.id,
      name: row.name,
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      type: row.type,
      sql: row.sql ?? undefined,
      intervalSeconds: row.interval_seconds,
      enabled: Boolean(row.enabled),
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listJobs(): JobInfo[] {
    return this.all<Record<string, any>>('SELECT * FROM jobs ORDER BY created_at DESC').map((row) => this.rowToJob(row));
  }

  getJob(id: string): JobInfo | undefined {
    const row = this.one<Record<string, any>>('SELECT * FROM jobs WHERE id = ?', [id]);
    return row ? this.rowToJob(row) : undefined;
  }

  createJob(input: { name: string; connectionId: string; database?: string; type: 'query' | 'backup'; sql?: string; intervalSeconds: number; enabled?: boolean }): JobInfo {
    const id = randomUUID();
    const now = iso();
    this.exec(
      'INSERT INTO jobs (id,name,connection_id,database_name,type,sql,interval_seconds,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, input.name, input.connectionId, input.database ?? null, input.type, input.sql ?? null, Math.max(30, input.intervalSeconds), input.enabled === false ? 0 : 1, now, now],
    );
    return this.getJob(id)!;
  }

  updateJob(id: string, patch: Partial<Pick<JobInfo, 'name' | 'database' | 'sql' | 'intervalSeconds' | 'enabled' | 'type'>>): JobInfo {
    const row = this.getJob(id);
    if (!row) throw new Error('任务不存在');
    this.exec(
      'UPDATE jobs SET name=?, database_name=?, type=?, sql=?, interval_seconds=?, enabled=?, updated_at=? WHERE id=?',
      [
        patch.name ?? row.name,
        patch.database ?? row.database ?? null,
        patch.type ?? row.type,
        patch.sql ?? row.sql ?? null,
        Math.max(30, patch.intervalSeconds ?? row.intervalSeconds),
        (patch.enabled ?? row.enabled) ? 1 : 0,
        iso(),
        id,
      ],
    );
    return this.getJob(id)!;
  }

  deleteJob(id: string): void {
    this.exec('DELETE FROM jobs WHERE id = ?', [id]);
  }

  markJobRun(id: string, status: 'ok' | 'error' | 'running', error?: string): void {
    this.exec('UPDATE jobs SET last_status=?, last_error=?, last_run_at=?, updated_at=? WHERE id=?', [
      status,
      error ?? null,
      iso(),
      iso(),
      id,
    ]);
  }

  // ---------- backups ----------
  addBackup(input: Omit<BackupInfo, 'id' | 'createdAt'>): BackupInfo {
    const backup: BackupInfo = { ...input, id: randomUUID(), createdAt: iso() };
    this.exec('INSERT INTO backups (id,connection_id,database_name,path,format,bytes,label,created_at) VALUES (?,?,?,?,?,?,?,?)', [
      backup.id,
      backup.connectionId,
      backup.database ?? null,
      backup.path,
      backup.format,
      backup.bytes,
      backup.label ?? null,
      backup.createdAt,
    ]);
    return backup;
  }

  listBackups(connectionId?: string): BackupInfo[] {
    const rows = connectionId
      ? this.all<Record<string, any>>('SELECT * FROM backups WHERE connection_id = ? ORDER BY created_at DESC', [connectionId])
      : this.all<Record<string, any>>('SELECT * FROM backups ORDER BY created_at DESC');
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      database: r.database_name ?? undefined,
      path: r.path,
      format: r.format,
      bytes: r.bytes ?? 0,
      label: r.label ?? undefined,
      createdAt: r.created_at,
    }));
  }

  // ---------- schema cache ----------
  getSchemaCache(connectionId: string, database: string): { payload: string; fetchedAt: string } | undefined {
    const row = this.one<{ payload: string; fetched_at: string }>('SELECT payload, fetched_at FROM schema_cache WHERE connection_id = ? AND database_name = ?', [
      connectionId,
      database,
    ]);
    return row ? { payload: row.payload, fetchedAt: row.fetched_at } : undefined;
  }

  setSchemaCache(connectionId: string, database: string, payload: unknown): void {
    this.exec(
      'INSERT INTO schema_cache (connection_id,database_name,payload,fetched_at) VALUES (?,?,?,?) ON CONFLICT(connection_id,database_name) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at',
      [connectionId, database, JSON.stringify(payload), iso()],
    );
  }

  clearSchemaCache(connectionId: string): void {
    this.exec('DELETE FROM schema_cache WHERE connection_id = ?', [connectionId]);
  }

  // ---------- snippets ----------
  listSnippets(): Array<{ id: string; name: string; sql: string; tags: string[]; createdAt: string }> {
    return this.all<Record<string, any>>('SELECT * FROM snippets ORDER BY created_at DESC').map((r) => ({
      id: r.id,
      name: r.name,
      sql: r.sql,
      tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
      createdAt: r.created_at,
    }));
  }

  createSnippet(input: { name: string; sql: string; tags?: string[] }): { id: string } {
    const id = randomUUID();
    this.exec('INSERT INTO snippets (id,name,sql,tags,created_at) VALUES (?,?,?,?,?)', [id, input.name, input.sql, JSON.stringify(input.tags ?? []), iso()]);
    return { id };
  }

  deleteSnippet(id: string): void {
    this.exec('DELETE FROM snippets WHERE id = ?', [id]);
  }

  private setAgentApiKey(apiKey: string | undefined): void {
    if (apiKey) this.setSetting('agentApiKey', this.box.encrypt({ apiKey }));
    else this.exec("DELETE FROM settings WHERE key = 'agentApiKey'");
  }
}
