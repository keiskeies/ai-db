import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS,
  DASHBOARD_CARD_LIMIT,
  bundleAgentContext,
  builtinMcpKindOf,
  emptyBundle,
  isDuplicateMemory,
  looksLikeSecret,
  mergeMemoryContent,
  rankMemories,
  type AgentContextBundle,
  type AgentContextEntry,
  type AgentMessage,
  type AgentMessageBlock,
  type AgentModelConfig,
  type AgentModelEntry,
  type AgentSessionMeta,
  type AppSettings,
  type ArtifactInfo,
  type ArtifactRunInfo,
  type ArtifactScheduleInfo,
  type ArtifactSpec,
  type ArtifactType,
  type AuditEntry,
  type BackupInfo,
  type ConnectionColor,
  type ConnectionConfig,
  type ConnectionSecret,
  type DashboardCard,
  type DashboardCardInput,
  type DashboardCardSource,
  type DashboardChartType,
  type DashboardScheduleInfo,
  type DeviceInfo,
  type Engine,
  type Environment,
  type JobInfo,
  type McpServerInfo,
  type Memory,
  type MemoryCandidate,
  type NotificationChannelInfo,
  type NotificationChannelType,
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
CREATE TABLE IF NOT EXISTS database_briefs (
  scope_key TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  database_name TEXT,
  path TEXT NOT NULL,
  schema_hash TEXT,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('report','compare','diff','recon','fix')),
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('draft','ready','running','error')),
  schedule_id TEXT,
  origin_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type, updated_at DESC);
CREATE TABLE IF NOT EXISTS artifact_runs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','canceled')),
  input_json TEXT,
  steps_json TEXT,
  result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_runs ON artifact_runs(artifact_id, created_at DESC);
CREATE TABLE IF NOT EXISTS artifact_schedules (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  interval_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  refresh_narrative INTEGER NOT NULL DEFAULT 0,
  notify_channels TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_schedules ON artifact_schedules(enabled, last_run_at);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT,
  env_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_secret TEXT NOT NULL,
  summary TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_secrets (
  skill_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (skill_id, name)
);
CREATE TABLE IF NOT EXISTS dashboard_cards (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  database_name TEXT,
  title TEXT NOT NULL,
  sql TEXT NOT NULL,
  chart_type TEXT NOT NULL,
  series_x TEXT,
  series_y TEXT,
  time_column TEXT,
  span INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('ai','favorite','manual')),
  pinned INTEGER NOT NULL DEFAULT 0,
  last_result_json TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  schema_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dash_cards ON dashboard_cards(scope_key, position);
CREATE TABLE IF NOT EXISTS dashboard_schedules (
  scope_key TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  database_name TEXT,
  interval_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  notify_channels TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

interface DashboardCardRow {
  id: string;
  scope_key: string;
  connection_id: string;
  database_name: string | null;
  title: string;
  sql: string;
  chart_type: string;
  series_x: string | null;
  series_y: string | null;
  time_column: string | null;
  span: number;
  position: number;
  source: string;
  pinned: number;
  last_result_json: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  schema_hash: string | null;
  created_at: string;
  updated_at: string;
}

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

/** 快照只为「打开即见图」服务，行数必须封顶，否则 App 存储会被大结果集撑爆。 */
function trimDashboardResult(result: { columns: Array<{ name: string }>; rows: unknown[][] } | undefined) {
  if (!result) return { columns: [], rows: [] };
  return { columns: result.columns.slice(0, 64), rows: result.rows.slice(0, 200).map((row) => row.slice(0, 64)) };
}

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

const round = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

interface ArtifactRow {
  id: string;
  type: ArtifactType;
  title: string;
  spec_json: string;
  status: 'draft' | 'ready' | 'running' | 'error';
  schedule_id: string | null;
  origin_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRunRow {
  id: string;
  artifact_id: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';
  input_json: string | null;
  steps_json: string | null;
  result_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface ArtifactScheduleRow {
  id: string;
  artifact_id: string;
  interval_seconds: number;
  enabled: number;
  refresh_narrative: number;
  notify_channels: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args_json: string | null;
  env_secret: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface NotificationChannelRow {
  id: string;
  name: string;
  type: NotificationChannelType;
  config_secret: string;
  summary: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface DatabaseBriefRecord {
  scopeKey: string;
  connectionId: string;
  database?: string;
  path: string;
  schemaHash?: string;
  generatedAt: string;
  updatedAt: string;
}

const PROVIDER_KINDS = ['local', 'anthropic', 'openai', 'ollama'] as const;

/** 清洗模型来源列表；空列表时用旧版单模型字段合成一个默认连接，保证升级后行为不变。 */
function normalizeModelConfigs(
  raw: unknown,
  legacy: Pick<AgentModelConfig, 'provider' | 'preset' | 'baseUrl'> & { model: string },
): AgentModelConfig[] {
  const seen = new Set<string>();
  const list: AgentModelConfig[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const item = entry as { id?: unknown; name?: unknown; provider?: unknown; preset?: unknown; baseUrl?: unknown; models?: unknown; model?: unknown };
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const provider = PROVIDER_KINDS.find((kind) => kind === item?.provider);
    if (!id || !provider || seen.has(id)) continue;
    // 兼容早期「一条配置一个模型」的存档：没有 models 数组时读单个 model。
    const source: unknown[] = Array.isArray(item.models) ? item.models : typeof item.model === 'string' ? [item.model] : [];
    const models: AgentModelEntry[] = [];
    const seenModels = new Set<string>();
    for (const value of source) {
      const id = typeof value === 'string' ? value.trim() : typeof (value as AgentModelEntry | null)?.id === 'string' ? (value as AgentModelEntry).id.trim() : '';
      if (!id || seenModels.has(id)) continue;
      const rawName = typeof value === 'object' && value ? (value as { name?: unknown }).name : undefined;
      seenModels.add(id);
      models.push({ id, name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined });
    }
    if (!models.length) continue;
    seen.add(id);
    list.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
      provider,
      preset: typeof item.preset === 'string' && item.preset ? item.preset : undefined,
      baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
      models,
    });
  }
  if (!list.length) {
    list.push({
      id: 'default',
      provider: legacy.provider,
      preset: legacy.preset,
      baseUrl: legacy.baseUrl,
      models: [{ id: legacy.model?.trim() || 'local' }],
    });
  }
  return list;
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
    this.ensureColumn('query_history', 'favorite', 'INTEGER DEFAULT 0');
    this.ensureColumn('artifact_schedules', 'notify_channels', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_recent ON query_history(favorite, created_at DESC)');
    const channelsSql = this.one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_channels'")?.sql ?? '';
    if (channelsSql.includes('CHECK (type IN')) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('ALTER TABLE notification_channels RENAME TO notification_channels_v6');
        this.db.exec(`CREATE TABLE notification_channels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          config_secret TEXT NOT NULL,
          summary TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.db.exec(`INSERT INTO notification_channels (id,name,type,config_secret,summary,enabled,created_at,updated_at)
          SELECT id,name,type,config_secret,summary,enabled,created_at,updated_at FROM notification_channels_v6`);
        this.db.exec('DROP TABLE notification_channels_v6');
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    this.db.exec('PRAGMA user_version = 8');
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
    // 仪表板卡片是我们自己的元数据：连接没了还留着，就是指向不存在库的死配置
    this.exec('DELETE FROM dashboard_cards WHERE connection_id = ?', [id]);
  }

  touchConnection(id: string): void {
    this.exec('UPDATE connections SET last_used_at = ? WHERE id = ?', [iso(), id]);
  }

  // ---------- database briefs (AI_DB.md) ----------
  getDatabaseBrief(connectionId: string, database?: string): DatabaseBriefRecord | undefined {
    const row = this.one<Record<string, any>>('SELECT * FROM database_briefs WHERE scope_key = ?', [`${connectionId}/${database ?? ''}`]);
    if (!row) return undefined;
    return {
      scopeKey: row.scope_key,
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      path: row.path,
      schemaHash: row.schema_hash ?? undefined,
      generatedAt: row.generated_at,
      updatedAt: row.updated_at,
    };
  }

  saveDatabaseBrief(record: Omit<DatabaseBriefRecord, 'scopeKey' | 'updatedAt'>): DatabaseBriefRecord {
    const scopeKey = `${record.connectionId}/${record.database ?? ''}`;
    const now = iso();
    this.exec(
      `INSERT INTO database_briefs (scope_key,connection_id,database_name,path,schema_hash,generated_at,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(scope_key) DO UPDATE SET path=excluded.path, schema_hash=excluded.schema_hash, generated_at=excluded.generated_at, updated_at=excluded.updated_at`,
      [scopeKey, record.connectionId, record.database ?? null, record.path, record.schemaHash ?? null, record.generatedAt, now],
    );
    return this.getDatabaseBrief(record.connectionId, record.database)!;
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
      embedding: { ...DEFAULT_SETTINGS.embedding, ...(stored.embedding ?? {}) },
      features: { ...DEFAULT_SETTINGS.features, ...(stored.features ?? {}) },
      search: { ...DEFAULT_SETTINGS.search, ...(stored.search ?? {}) },
    };
    merged.historyLimit = round(merged.historyLimit, 10, 100_000, DEFAULT_SETTINGS.historyLimit);
    merged.historyRetentionDays = round(merged.historyRetentionDays, 0, 3650, DEFAULT_SETTINGS.historyRetentionDays);
    const enc = this.getSetting('agentApiKey');
    const decrypted = this.box.decrypt<{ apiKey: string }>(enc);
    const legacyKey = decrypted?.apiKey;
    // 多模型配置：列表与当前项在读取时物化成 agent 上的 provider/baseUrl/model/apiKey，
    // 让运行时（provider 创建、能力档案、会话记录）继续只认单模型字段。
    const modelConfigs = normalizeModelConfigs(merged.agent.modelConfigs, merged.agent);
    const active = modelConfigs.find((item) => item.id === merged.agent.activeModelId) ?? modelConfigs[0];
    const activeModel = active.models.some((entry) => entry.id === merged.agent.model) ? merged.agent.model : active.models[0].id;
    const modelKeys = this.readModelKeys();
    const keyOf = (id: string) => modelKeys[id] ?? (id === 'default' ? legacyKey : undefined);
    merged.agent.modelConfigs = modelConfigs;
    merged.agent.activeModelId = active.id;
    merged.agent.provider = active.provider;
    merged.agent.preset = active.preset;
    merged.agent.baseUrl = active.baseUrl;
    merged.agent.model = activeModel;
    merged.agent.apiKey = keyOf(active.id);
    delete merged.agent.modelKeys;
    merged.agent.modelApiKeyStatus = Object.fromEntries(modelConfigs.map((item) => [item.id, Boolean(keyOf(item.id))]));
    if (process.env.AIDB_API_KEY) merged.agent.apiKey = process.env.AIDB_API_KEY;
    merged.agent.hasApiKey = Boolean(merged.agent.apiKey);
    const embeddingEnc = this.getSetting('embeddingApiKey');
    const embeddingKey = this.box.decrypt<{ apiKey: string }>(embeddingEnc);
    if (embeddingKey?.apiKey) merged.embedding.apiKey = embeddingKey.apiKey;
    if (process.env.AIDB_EMBEDDING_API_KEY) merged.embedding.apiKey = process.env.AIDB_EMBEDDING_API_KEY;
    merged.embedding.hasApiKey = Boolean(merged.embedding.apiKey);
    return merged;
  }

  publicSettings(): AppSettings {
    const settings = this.getSettings();
    return {
      ...settings,
      agent: { ...settings.agent, apiKey: undefined, modelKeys: undefined, hasApiKey: Boolean(settings.agent.apiKey) },
      embedding: { ...settings.embedding, apiKey: undefined, hasApiKey: Boolean(settings.embedding.apiKey) },
      search: { ...settings.search, keyStatus: this.searchKeyStatus(), searchKeys: undefined },
    };
  }

  private readSearchKeys(): Record<string, string> {
    const decrypted = this.box.decrypt<{ keys?: Record<string, string> }>(this.getSetting('searchApiKeys'));
    return decrypted?.keys && typeof decrypted.keys === 'object' ? decrypted.keys : {};
  }

  private writeSearchKeys(keys: Record<string, string>): void {
    const entries = Object.entries(keys).filter(([, value]) => typeof value === 'string' && value.length > 0);
    if (entries.length) this.setSetting('searchApiKeys', this.box.encrypt({ keys: Object.fromEntries(entries) }));
    else this.exec("DELETE FROM settings WHERE key = 'searchApiKeys'");
  }

  getSearchApiKey(id: string): string | undefined {
    return this.readSearchKeys()[id];
  }

  searchKeyStatus(): Record<string, boolean> {
    const keys = this.readSearchKeys();
    return Object.fromEntries(['brave', 'tavily', 'serper', 'mojeek', 'deepseek', 'anthropic', 'openai', 'searxng'].map((id) => [id, Boolean(keys[id])]));
  }

  saveSearchKeys(input: Record<string, unknown> | undefined): void {
    if (!input || typeof input !== 'object') return;
    const keys = this.readSearchKeys();
    let changed = false;
    for (const [id, value] of Object.entries(input)) {
      if (!['brave', 'tavily', 'serper', 'mojeek', 'deepseek', 'anthropic', 'openai', 'searxng'].includes(id)) continue;
      if (typeof value !== 'string') continue;
      if (value === '__CLEAR__') {
        if (keys[id]) {
          delete keys[id];
          changed = true;
        }
      } else if (value.trim()) {
        keys[id] = value.trim();
        changed = true;
      }
    }
    if (changed) this.writeSearchKeys(keys);
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
    const incomingEmbeddingKey = next.embedding?.apiKey;
    let embeddingKey = current.embedding.apiKey;
    let embeddingKeyChanged = false;
    if (incomingEmbeddingKey === '__CLEAR__') {
      embeddingKey = undefined;
      embeddingKeyChanged = true;
    } else if (incomingEmbeddingKey !== undefined && incomingEmbeddingKey !== '') {
      embeddingKey = incomingEmbeddingKey;
      embeddingKeyChanged = true;
    }
    const incomingKeys = next.agent.modelKeys ?? {};
    const modelKeys = this.readModelKeys();
    let modelKeysChanged = false;
    for (const [id, value] of Object.entries(incomingKeys)) {
      if (!id || typeof value !== 'string') continue;
      if (value === '__CLEAR__') {
        if (modelKeys[id]) {
          delete modelKeys[id];
          modelKeysChanged = true;
        }
      } else if (value.trim()) {
        modelKeys[id] = value.trim();
        modelKeysChanged = true;
      }
    }
    const modelConfigs = normalizeModelConfigs(next.agent.modelConfigs, current.agent);
    const activeModelId = modelConfigs.some((item) => item.id === next.agent.activeModelId) ? next.agent.activeModelId : modelConfigs[0].id;
    // 兼容旧调用：没有切换连接时，直接改 agent.provider/baseUrl/model 视为修改当前连接；
    // 新模型名（例如旧版单模型输入框）补进当前连接的模型列表。
    const syncedConfigs =
      activeModelId === current.agent.activeModelId
        ? modelConfigs.map((item) => {
            if (item.id !== activeModelId) return item;
            const model = next.agent.model?.trim();
            return {
              ...item,
              provider: next.agent.provider,
              preset: next.agent.preset,
              baseUrl: next.agent.baseUrl,
              models: model && !item.models.some((entry) => entry.id === model) ? [...item.models, { id: model }] : item.models,
            };
          })
        : modelConfigs;
    const sanitized: AppSettings = {
      ...next,
      historyLimit: round(next.historyLimit, 10, 100_000, DEFAULT_SETTINGS.historyLimit),
      historyRetentionDays: round(next.historyRetentionDays, 0, 3650, DEFAULT_SETTINGS.historyRetentionDays),
      agent: {
        ...next.agent,
        apiKey: undefined,
        hasApiKey: Boolean(apiKey ?? process.env.AIDB_API_KEY),
        modelConfigs: syncedConfigs,
        activeModelId,
        modelKeys: undefined,
        modelApiKeyStatus: undefined,
      },
      embedding: {
        ...next.embedding,
        apiKey: undefined,
        hasApiKey: Boolean(embeddingKey ?? process.env.AIDB_EMBEDDING_API_KEY),
      },
      search: {
        ...next.search,
        keyStatus: undefined,
        searchKeys: undefined,
      },
    };
    this.setSetting('app', JSON.stringify(sanitized));
    this.saveSearchKeys(next.search?.searchKeys);
    if (keyChanged) this.setAgentApiKey(apiKey);
    if (modelKeysChanged) this.setModelKeys(modelKeys);
    if (embeddingKeyChanged) this.setEmbeddingApiKey(embeddingKey);
    return this.getSettings();
  }

  // ---------- query history ----------
  addHistory(item: Omit<QueryHistoryItem, 'id' | 'createdAt'>): QueryHistoryItem {
    const entry: QueryHistoryItem = { ...item, id: randomUUID(), createdAt: iso() };
    this.exec(
      'INSERT INTO query_history (id,connection_id,database_name,sql,status,duration_ms,row_count,error,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [entry.id, entry.connectionId ?? null, entry.database ?? null, entry.sql, entry.status, entry.durationMs ?? null, entry.rowCount ?? null, entry.error ?? null, entry.createdAt],
    );
    this.pruneHistory();
    return entry;
  }

  /** 收藏永久保留；其余按条数与天数双阈值裁剪，避免历史表无限增长。 */
  private pruneHistory(): void {
    const { historyLimit, historyRetentionDays } = this.getSettings();
    const keep = Math.min(100_000, Math.max(10, Math.floor(historyLimit)));
    if (historyRetentionDays > 0) {
      const cutoff = new Date(Date.now() - historyRetentionDays * 86_400_000).toISOString();
      this.exec('DELETE FROM query_history WHERE COALESCE(favorite, 0) = 0 AND created_at < ?', [cutoff]);
    }
    this.exec(
      `DELETE FROM query_history WHERE COALESCE(favorite, 0) = 0 AND id NOT IN (
         SELECT id FROM query_history WHERE COALESCE(favorite, 0) = 0 ORDER BY created_at DESC LIMIT ?
       )`,
      [keep],
    );
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
    return this.all<Record<string, any>>(`SELECT * FROM query_history ${where} ORDER BY COALESCE(favorite, 0) DESC, created_at DESC LIMIT ${limit}`, params).map((r) => ({
      id: r.id,
      connectionId: r.connection_id ?? undefined,
      database: r.database_name ?? undefined,
      sql: r.sql,
      status: r.status,
      durationMs: r.duration_ms ?? undefined,
      rowCount: r.row_count ?? undefined,
      error: r.error ?? undefined,
      favorite: Number(r.favorite ?? 0) === 1,
      createdAt: r.created_at,
    }));
  }

  renameGroup(from: string, to: string): number {
    return this.exec('UPDATE connections SET group_name = ?, updated_at = ? WHERE group_name = ?', [to, new Date().toISOString(), from]).changes;
  }

  deleteGroup(name: string): number {
    return this.exec("UPDATE connections SET group_name = '默认', updated_at = ? WHERE group_name = ?", [new Date().toISOString(), name]).changes;
  }

  setHistoryFavorite(id: string, favorite: boolean): boolean {
    return this.exec('UPDATE query_history SET favorite = ? WHERE id = ?', [favorite ? 1 : 0, id]).changes > 0;
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

  // ---------- dashboards ----------

  private scopeKey(connectionId: string, database?: string): string {
    return `${connectionId}/${database ?? ''}`;
  }

  private rowToDashboardCard(row: DashboardCardRow): DashboardCard {
    let lastResult: DashboardCard['lastResult'] | undefined;
    if (row.last_result_json) {
      try {
        lastResult = JSON.parse(row.last_result_json) as DashboardCard['lastResult'];
      } catch {
        lastResult = undefined;
      }
    }
    return {
      id: row.id,
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      title: row.title,
      sql: row.sql,
      chartType: row.chart_type as DashboardChartType,
      x: row.series_x ?? undefined,
      y: row.series_y ?? undefined,
      timeColumn: row.time_column ?? undefined,
      span: row.span === 2 ? 2 : 1,
      position: row.position,
      source: row.source as DashboardCardSource,
      pinned: Boolean(row.pinned),
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status === 'ok' || row.last_status === 'error' ? row.last_status : undefined,
      lastError: row.last_error ?? undefined,
      lastResult,
      schemaHash: row.schema_hash ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listDashboardCards(connectionId: string, database?: string): DashboardCard[] {
    const rows = this.all<DashboardCardRow>(
      'SELECT * FROM dashboard_cards WHERE scope_key = ? ORDER BY position, created_at',
      [this.scopeKey(connectionId, database)],
    );
    return rows.map((row) => this.rowToDashboardCard(row));
  }

  dashboardCard(id: string): DashboardCard | undefined {
    const row = this.one<DashboardCardRow>('SELECT * FROM dashboard_cards WHERE id = ?', [id]);
    return row ? this.rowToDashboardCard(row) : undefined;
  }

  insertDashboardCard(input: DashboardCardInput): DashboardCard {
    const now = iso();
    const id = randomUUID();
    const position = input.position ?? this.listDashboardCards(input.connectionId, input.database).length + 1;
    this.exec(
      `INSERT INTO dashboard_cards
       (id,scope_key,connection_id,database_name,title,sql,chart_type,series_x,series_y,time_column,span,position,source,pinned,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        this.scopeKey(input.connectionId, input.database),
        input.connectionId,
        input.database ?? null,
        input.title.trim(),
        input.sql.trim(),
        input.chartType,
        input.x ?? null,
        input.y ?? null,
        input.timeColumn ?? null,
        input.span === 2 ? 2 : 1,
        position,
        input.source ?? 'manual',
        input.pinned === false ? 0 : 1,
        now,
        now,
      ],
    );
    return this.dashboardCard(id)!;
  }

  /** 逐字段更新：undefined 表示不改，null 表示清空该字段。 */
  updateDashboardCard(
    id: string,
    patch: Omit<Partial<DashboardCardInput>, 'timeColumn'> & {
      timeColumn?: string | null;
      lastResult?: DashboardCard['lastResult'];
      lastStatus?: 'ok' | 'error';
      lastError?: string;
      schemaHash?: string | null;
    },
  ): DashboardCard | undefined {
    const existing = this.one<DashboardCardRow>('SELECT * FROM dashboard_cards WHERE id = ?', [id]);
    if (!existing) return undefined;
    const next = [
      patch.title?.trim() || existing.title,
      patch.sql?.trim() || existing.sql,
      patch.chartType ?? existing.chart_type,
      patch.x === undefined ? existing.series_x : patch.x ?? null,
      patch.y === undefined ? existing.series_y : patch.y ?? null,
      patch.timeColumn === undefined ? existing.time_column : patch.timeColumn ?? null,
      patch.span === undefined ? existing.span : patch.span === 2 ? 2 : 1,
      patch.position === undefined ? existing.position : patch.position,
      patch.pinned === undefined ? existing.pinned : patch.pinned ? 1 : 0,
      patch.source ?? existing.source,
      patch.lastResult === undefined ? existing.last_result_json : JSON.stringify(trimDashboardResult(patch.lastResult)),
      patch.lastStatus === undefined ? existing.last_status : patch.lastStatus,
      patch.lastError === undefined ? existing.last_error : patch.lastError,
      patch.schemaHash === undefined ? existing.schema_hash : patch.schemaHash,
      iso(),
      id,
    ];
    this.exec(
      `UPDATE dashboard_cards SET title=?, sql=?, chart_type=?, series_x=?, series_y=?, time_column=?, span=?, position=?, pinned=?,
       source=?, last_result_json=?, last_status=?, last_error=?, schema_hash=?, updated_at=? WHERE id=?`,
      next,
    );
    return this.dashboardCard(id);
  }

  deleteDashboardCard(id: string): void {
    this.exec('DELETE FROM dashboard_cards WHERE id = ?', [id]);
  }

  /**
   * 整批替换草稿卡片：只删 pinned = 0 的行，用户固定的卡片不受影响。
   * 生成器因此永远无法「重设」掉用户攒下的看板。
   */
  setDraftCards(connectionId: string, database: string | undefined, cards: DashboardCardInput[]): DashboardCard[] {
    const scope = this.scopeKey(connectionId, database);
    this.db.exec('BEGIN');
    try {
      this.exec('DELETE FROM dashboard_cards WHERE scope_key = ? AND pinned = 0', [scope]);
      const kept = Number(this.one<{ n: number }>('SELECT COUNT(*) AS n FROM dashboard_cards WHERE scope_key = ?', [scope])?.n ?? 0);
      const slots = Math.max(0, DASHBOARD_CARD_LIMIT - kept);
      cards.slice(0, slots).forEach((card, index) => {
        const inserted = this.insertDashboardCard({
          ...card,
          connectionId,
          database,
          source: card.source ?? 'ai',
          pinned: false,
          position: kept + index + 1,
        });
        // 生成器试跑带回来的结果直接当快照存，卡片入板就能画出来
        if (card.lastResult) this.updateDashboardCard(inserted.id, { lastResult: card.lastResult, lastStatus: 'ok' });
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.listDashboardCards(connectionId, database);
  }

  /** 丢弃当前作用域的全部草稿，保留固定卡片。 */
  discardDashboardDrafts(connectionId: string, database?: string): number {
    const result = this.exec('DELETE FROM dashboard_cards WHERE scope_key = ? AND pinned = 0', [
      this.scopeKey(connectionId, database),
    ]);
    return result.changes;
  }

  reorderDashboardCards(ids: string[]): DashboardCard[] {
    if (!ids.length) return [];
    const first = this.one<DashboardCardRow>('SELECT * FROM dashboard_cards WHERE id = ?', [ids[0]]);
    if (!first) return [];
    this.db.exec('BEGIN');
    try {
      ids.forEach((id, index) => {
        this.exec('UPDATE dashboard_cards SET position = ?, updated_at = ? WHERE id = ?', [index + 1, iso(), id]);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.listDashboardCards(first.connection_id, first.database_name ?? undefined);
  }

  removeDashboardScope(connectionId: string, database?: string): number {
    const scope = this.scopeKey(connectionId, database);
    const result = database
      ? this.exec('DELETE FROM dashboard_cards WHERE scope_key = ?', [scope])
      : this.exec('DELETE FROM dashboard_cards WHERE connection_id = ?', [connectionId]);
    this.exec('DELETE FROM dashboard_schedules WHERE scope_key = ?', [scope]);
    return result.changes;
  }

  private rowToDashboardSchedule(row: Record<string, any>): DashboardScheduleInfo {
    let channels: string[] = [];
    try {
      channels = Array.isArray(JSON.parse(row.notify_channels ?? '[]')) ? JSON.parse(row.notify_channels ?? '[]') : [];
    } catch {
      channels = [];
    }
    return {
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      intervalSeconds: Number(row.interval_seconds),
      enabled: Boolean(row.enabled),
      notifyChannels: channels,
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status === 'ok' || row.last_status === 'error' ? row.last_status : undefined,
      lastError: row.last_error ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  getDashboardSchedule(connectionId: string, database?: string): DashboardScheduleInfo | undefined {
    const row = this.one<Record<string, any>>('SELECT * FROM dashboard_schedules WHERE scope_key = ?', [
      this.scopeKey(connectionId, database),
    ]);
    return row ? this.rowToDashboardSchedule(row) : undefined;
  }

  /** 只列出启用中的定时，供调度器轮询。 */
  listDashboardSchedules(): DashboardScheduleInfo[] {
    return this.all<Record<string, any>>('SELECT * FROM dashboard_schedules WHERE enabled = 1 ORDER BY last_run_at')
      .map((row) => this.rowToDashboardSchedule(row));
  }

  setDashboardSchedule(input: {
    connectionId: string;
    database?: string;
    intervalSeconds: number;
    enabled: boolean;
    notifyChannels?: string[];
  }): DashboardScheduleInfo | undefined {
    const now = iso();
    const scope = this.scopeKey(input.connectionId, input.database);
    this.exec(
      `INSERT INTO dashboard_schedules (scope_key,connection_id,database_name,interval_seconds,enabled,notify_channels,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(scope_key) DO UPDATE SET interval_seconds = excluded.interval_seconds, enabled = excluded.enabled,
         notify_channels = excluded.notify_channels, updated_at = excluded.updated_at`,
      [
        scope,
        input.connectionId,
        input.database ?? null,
        Math.max(60, Math.floor(input.intervalSeconds)),
        input.enabled ? 1 : 0,
        JSON.stringify(input.notifyChannels ?? []),
        now,
        now,
      ],
    );
    return this.getDashboardSchedule(input.connectionId, input.database);
  }

  markDashboardScheduleRun(connectionId: string, database: string | undefined, status: 'ok' | 'error', error?: string): void {
    this.exec('UPDATE dashboard_schedules SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE scope_key = ?', [
      iso(),
      status,
      error ?? null,
      iso(),
      this.scopeKey(connectionId, database),
    ]);
  }

  removeDashboardSchedule(connectionId: string, database?: string): void {
    this.exec('DELETE FROM dashboard_schedules WHERE scope_key = ?', [this.scopeKey(connectionId, database)]);
  }

  private invalidateAgentContextCache(): void {
    this.contextCache.clear();
  }

  // ---------- artifacts ----------
  private rowToArtifact(row: ArtifactRow): ArtifactInfo {
    let spec: ArtifactSpec;
    try {
      spec = JSON.parse(row.spec_json) as ArtifactSpec;
    } catch {
      spec = { version: 1, type: row.type, title: row.title };
    }
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      spec,
      status: row.status,
      scheduleId: row.schedule_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listArtifacts(opts: { type?: ArtifactType; limit?: number; offset?: number } = {}): ArtifactInfo[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.type) {
      clauses.push('type = ?');
      params.push(opts.type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.all<ArtifactRow>(`SELECT * FROM artifacts ${where} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`, params).map((row) =>
      this.rowToArtifact(row),
    );
  }

  getArtifact(id: string): ArtifactInfo | undefined {
    const row = this.one<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', [id]);
    return row ? this.rowToArtifact(row) : undefined;
  }

  createArtifact(input: {
    type: ArtifactType;
    title: string;
    spec: ArtifactSpec;
    status?: 'draft' | 'ready' | 'running' | 'error';
    originSessionId?: string;
    scheduleId?: string;
  }): ArtifactInfo {
    const id = randomUUID();
    const now = iso();
    this.exec(
      `INSERT INTO artifacts (id,type,title,spec_json,status,schedule_id,origin_session_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.type,
        input.title,
        JSON.stringify(input.spec),
        input.status ?? 'ready',
        input.scheduleId ?? null,
        input.originSessionId ?? null,
        now,
        now,
      ],
    );
    return this.getArtifact(id)!;
  }

  updateArtifact(id: string, patch: { title?: string; spec?: ArtifactSpec; status?: 'draft' | 'ready' | 'running' | 'error'; scheduleId?: string | null }): ArtifactInfo {
    const row = this.one<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', [id]);
    if (!row) throw new Error('产物不存在');
    this.exec(
      `UPDATE artifacts SET title = ?, spec_json = ?, status = ?, schedule_id = ?, updated_at = ? WHERE id = ?`,
      [
        patch.title ?? row.title,
        patch.spec ? JSON.stringify(patch.spec) : row.spec_json,
        patch.status ?? row.status,
        patch.scheduleId === undefined ? row.schedule_id : patch.scheduleId,
        iso(),
        id,
      ],
    );
    return this.getArtifact(id)!;
  }

  deleteArtifact(id: string): void {
    this.exec('DELETE FROM artifacts WHERE id = ?', [id]);
  }

  addArtifactRun(input: {
    artifactId: string;
    status: ArtifactRunRow['status'];
    input?: unknown;
    steps?: unknown;
    result?: unknown;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  }): ArtifactRunInfo {
    const id = randomUUID();
    const startedAt = input.startedAt ?? iso();
    this.exec(
      `INSERT INTO artifact_runs (id,artifact_id,status,input_json,steps_json,result_json,error,started_at,finished_at,duration_ms,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.artifactId,
        input.status,
        input.input === undefined ? null : JSON.stringify(input.input),
        input.steps === undefined ? null : JSON.stringify(input.steps),
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error ?? null,
        startedAt,
        input.finishedAt ?? null,
        input.durationMs ?? null,
        iso(),
      ],
    );
    return this.getArtifactRun(id)!;
  }

  updateArtifactRun(
    id: string,
    patch: Partial<Pick<ArtifactRunInfo, 'status' | 'steps' | 'result' | 'error' | 'finishedAt' | 'durationMs'>>,
  ): ArtifactRunInfo {
    const row = this.one<ArtifactRunRow>('SELECT * FROM artifact_runs WHERE id = ?', [id]);
    if (!row) throw new Error('运行记录不存在');
    this.exec(
      `UPDATE artifact_runs SET status = ?, steps_json = ?, result_json = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`,
      [
        patch.status ?? row.status,
        patch.steps === undefined ? row.steps_json : JSON.stringify(patch.steps),
        patch.result === undefined ? row.result_json : JSON.stringify(patch.result),
        patch.error === undefined ? row.error : patch.error,
        patch.finishedAt === undefined ? row.finished_at : patch.finishedAt,
        patch.durationMs === undefined ? row.duration_ms : patch.durationMs,
        id,
      ],
    );
    return this.getArtifactRun(id)!;
  }

  getArtifactRun(id: string): ArtifactRunInfo | undefined {
    const row = this.one<ArtifactRunRow>('SELECT * FROM artifact_runs WHERE id = ?', [id]);
    if (!row) return undefined;
    return {
      id: row.id,
      artifactId: row.artifact_id,
      status: row.status,
      steps: row.steps_json ? JSON.parse(row.steps_json) : undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
    };
  }

  listArtifactRuns(artifactId: string, limit = 20): ArtifactRunInfo[] {
    return this.all<ArtifactRunRow>(
      'SELECT * FROM artifact_runs WHERE artifact_id = ? ORDER BY created_at DESC LIMIT ?',
      [artifactId, Math.min(100, Math.max(1, limit))],
    ).map((row) => ({
      id: row.id,
      artifactId: row.artifact_id,
      status: row.status,
      steps: row.steps_json ? JSON.parse(row.steps_json) : undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
    }));
  }

  private rowToArtifactSchedule(row: ArtifactScheduleRow): ArtifactScheduleInfo {
    return {
      id: row.id,
      artifactId: row.artifact_id,
      intervalSeconds: row.interval_seconds,
      enabled: Boolean(row.enabled),
      refreshNarrative: Boolean(row.refresh_narrative),
      notifyChannels: row.notify_channels ? (JSON.parse(row.notify_channels) as string[]) : [],
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  getArtifactSchedule(artifactId: string): ArtifactScheduleInfo | undefined {
    const row = this.one<ArtifactScheduleRow>('SELECT * FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    return row ? this.rowToArtifactSchedule(row) : undefined;
  }

  listArtifactSchedules(): ArtifactScheduleInfo[] {
    return this.all<ArtifactScheduleRow>('SELECT * FROM artifact_schedules ORDER BY created_at ASC').map((row) =>
      this.rowToArtifactSchedule(row),
    );
  }

  upsertArtifactSchedule(artifactId: string, input: { intervalSeconds: number; enabled?: boolean; refreshNarrative?: boolean }): ArtifactScheduleInfo {
    const now = iso();
    const existing = this.one<ArtifactScheduleRow>('SELECT * FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    if (existing) {
      this.exec(
        'UPDATE artifact_schedules SET interval_seconds = ?, enabled = ?, refresh_narrative = ?, updated_at = ? WHERE id = ?',
        [input.intervalSeconds, input.enabled === false ? 0 : 1, input.refreshNarrative ? 1 : 0, now, existing.id],
      );
      this.updateArtifact(artifactId, { scheduleId: existing.id });
      return this.getArtifactSchedule(artifactId)!;
    }
    const id = randomUUID();
    this.exec(
      `INSERT INTO artifact_schedules (id,artifact_id,interval_seconds,enabled,refresh_narrative,last_run_at,last_status,last_error,created_at,updated_at)
       VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?)`,
      [id, artifactId, input.intervalSeconds, input.enabled === false ? 0 : 1, input.refreshNarrative ? 1 : 0, now, now],
    );
    this.updateArtifact(artifactId, { scheduleId: id });
    return this.getArtifactSchedule(artifactId)!;
  }

  deleteArtifactSchedule(artifactId: string): void {
    this.exec('DELETE FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    this.updateArtifact(artifactId, { scheduleId: null });
  }

  setArtifactScheduleNotifyChannels(artifactId: string, channelIds: string[]): ArtifactScheduleInfo {
    const row = this.one<ArtifactScheduleRow>('SELECT * FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    if (!row) throw new Error('定时配置不存在');
    this.exec('UPDATE artifact_schedules SET notify_channels = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify([...new Set(channelIds.filter(Boolean))]),
      iso(),
      row.id,
    ]);
    return this.getArtifactSchedule(artifactId)!;
  }

  markArtifactScheduleRun(artifactId: string, status: 'ok' | 'error', error?: string): void {
    this.exec(
      'UPDATE artifact_schedules SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE artifact_id = ?',
      [iso(), status, error ?? null, iso(), artifactId],
    );
  }

  // ---------- MCP servers ----------
  private rowToMcpServer(row: McpServerRow): McpServerInfo {
    let args: string[] = [];
    try {
      args = row.args_json ? (JSON.parse(row.args_json) as string[]) : [];
    } catch {
      args = [];
    }
    return {
      id: row.id,
      name: row.name,
      command: row.command,
      args,
      enabled: Boolean(row.enabled),
      builtin: builtinMcpKindOf(row.command),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMcpServers(): McpServerInfo[] {
    return this.all<McpServerRow>('SELECT * FROM mcp_servers ORDER BY created_at ASC').map((row) => this.rowToMcpServer(row));
  }

  getMcpServer(id: string): McpServerInfo | undefined {
    const row = this.one<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    return row ? this.rowToMcpServer(row) : undefined;
  }

  getMcpServerEnv(id: string): Record<string, string> {
    const row = this.one<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    return row?.env_secret ? (this.box.decrypt<Record<string, string>>(row.env_secret) ?? {}) : {};
  }

  createMcpServer(input: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }): McpServerInfo {
    const id = randomUUID();
    const now = iso();
    this.exec(
      `INSERT INTO mcp_servers (id,name,command,args_json,env_secret,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        id,
        input.name.trim(),
        input.command.trim(),
        JSON.stringify(input.args ?? []),
        input.env && Object.keys(input.env).length ? this.box.encrypt(input.env) : null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      ],
    );
    return this.getMcpServer(id)!;
  }

  /** Seed a first-party built-in without overwriting the user's toggles or paths. */
  seedMcpServer(input: { id: string; name: string; command: string; args?: string[]; enabled?: boolean }): void {
    const now = iso();
    this.exec(
      `INSERT OR IGNORE INTO mcp_servers (id,name,command,args_json,env_secret,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [input.id, input.name, input.command, JSON.stringify(input.args ?? []), null, input.enabled === false ? 0 : 1, now, now],
    );
  }

  updateMcpServer(
    id: string,
    patch: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
  ): McpServerInfo {
    const row = this.one<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    if (!row) throw new Error('MCP Server 不存在');
    this.exec(
      'UPDATE mcp_servers SET name = ?, command = ?, args_json = ?, env_secret = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [
        patch.name?.trim() ?? row.name,
        patch.command?.trim() ?? row.command,
        patch.args ? JSON.stringify(patch.args) : row.args_json,
        patch.env ? (Object.keys(patch.env).length ? this.box.encrypt(patch.env) : null) : row.env_secret,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        iso(),
        id,
      ],
    );
    return this.getMcpServer(id)!;
  }

  deleteMcpServer(id: string): void {
    this.exec('DELETE FROM mcp_servers WHERE id = ?', [id]);
  }

  // ---------- skill secrets ----------
  listSkillSecretNames(skillId: string): string[] {
    return this.all<{ name: string }>('SELECT name FROM skill_secrets WHERE skill_id = ? ORDER BY name', [skillId]).map((row) => row.name);
  }

  getSkillSecrets(skillId: string, names: string[]): Record<string, string> {
    if (!names.length) return {};
    const rows = this.all<{ name: string; value: string }>(
      `SELECT name, value FROM skill_secrets WHERE skill_id = ? AND name IN (${names.map(() => '?').join(',')})`,
      [skillId, ...names],
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      const value = this.box.decrypt<string>(row.value);
      if (typeof value === 'string') out[row.name] = value;
    }
    return out;
  }

  setSkillSecret(skillId: string, name: string, value: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(name)) throw new Error('非法密钥名');
    this.exec(
      `INSERT INTO skill_secrets (skill_id,name,value,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(skill_id,name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [skillId, name, this.box.encrypt(value), iso()],
    );
  }

  deleteSkillSecret(skillId: string, name: string): void {
    this.exec('DELETE FROM skill_secrets WHERE skill_id = ? AND name = ?', [skillId, name]);
  }

  // ---------- notification channels ----------
  private rowToNotificationChannel(row: NotificationChannelRow): NotificationChannelInfo {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: Boolean(row.enabled),
      summary: row.summary ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listNotificationChannels(): NotificationChannelInfo[] {
    return this.all<NotificationChannelRow>('SELECT * FROM notification_channels ORDER BY created_at ASC').map((row) =>
      this.rowToNotificationChannel(row),
    );
  }

  getNotificationChannel(id: string): NotificationChannelInfo | undefined {
    const row = this.one<NotificationChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    return row ? this.rowToNotificationChannel(row) : undefined;
  }

  getNotificationChannelConfig<T = Record<string, unknown>>(id: string): T | null {
    const row = this.one<NotificationChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    return row ? this.box.decrypt<T>(row.config_secret) : null;
  }

  createNotificationChannel(input: {
    name: string;
    type: NotificationChannelType;
    config: Record<string, unknown>;
    summary?: string;
    enabled?: boolean;
  }): NotificationChannelInfo {
    const id = randomUUID();
    const now = iso();
    this.exec(
      `INSERT INTO notification_channels (id,name,type,config_secret,summary,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.name.trim(), input.type, this.box.encrypt(input.config), input.summary ?? null, input.enabled === false ? 0 : 1, now, now],
    );
    return this.getNotificationChannel(id)!;
  }

  updateNotificationChannel(
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; summary?: string; enabled?: boolean },
  ): NotificationChannelInfo {
    const row = this.one<NotificationChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    if (!row) throw new Error('通知渠道不存在');
    this.exec(
      'UPDATE notification_channels SET name = ?, config_secret = ?, summary = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [
        patch.name?.trim() ?? row.name,
        patch.config ? this.box.encrypt(patch.config) : row.config_secret,
        patch.summary === undefined ? row.summary : patch.summary,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        iso(),
        id,
      ],
    );
    return this.getNotificationChannel(id)!;
  }

  deleteNotificationChannel(id: string): void {
    this.exec('DELETE FROM notification_channels WHERE id = ?', [id]);
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

  private readModelKeys(): Record<string, string> {
    const decrypted = this.box.decrypt<{ keys?: Record<string, string> }>(this.getSetting('agentModelKeys'));
    return decrypted?.keys && typeof decrypted.keys === 'object' ? decrypted.keys : {};
  }

  private setModelKeys(keys: Record<string, string>): void {
    const entries = Object.entries(keys).filter(([id, value]) => id && value);
    if (entries.length) this.setSetting('agentModelKeys', this.box.encrypt({ keys: Object.fromEntries(entries) }));
    else this.exec("DELETE FROM settings WHERE key = 'agentModelKeys'");
  }

  /** 取某个模型配置已保存的密钥；默认配置回退到旧版单模型密钥。 */
  getModelApiKey(id: string): string | undefined {
    const key = this.readModelKeys()[id];
    if (key) return key;
    if (id !== 'default') return undefined;
    return this.box.decrypt<{ apiKey: string }>(this.getSetting('agentApiKey'))?.apiKey;
  }

  private setEmbeddingApiKey(apiKey: string | undefined): void {
    if (apiKey) this.setSetting('embeddingApiKey', this.box.encrypt({ apiKey }));
    else this.exec("DELETE FROM settings WHERE key = 'embeddingApiKey'");
  }
}
