import { DatabaseSync } from 'node:sqlite';
import { SecretBox } from '../crypto';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  engine TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  environment TEXT NOT NULL DEFAULT 'dev' CHECK (environment IN ('dev','staging','prod')),
  group_name TEXT NOT NULL DEFAULT '默认',
  host TEXT, port INTEGER, database TEXT, username TEXT,
  secret TEXT, ssl INTEGER NOT NULL DEFAULT 0, ssl_insecure INTEGER NOT NULL DEFAULT 0, auth_mode TEXT, options_json TEXT, ssh_json TEXT,
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
  paired_at TEXT NOT NULL, last_seen_at TEXT, revoked INTEGER DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'full'
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
  type TEXT NOT NULL CHECK (type IN ('query','backup','pipeline')), sql TEXT, payload TEXT,
  interval_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, last_status TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, connection_id TEXT, database_name TEXT,
  spec_json TEXT NOT NULL, state_json TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, last_status TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  trigger TEXT NOT NULL, batch_at TEXT NOT NULL,
  steps_json TEXT, message TEXT, error TEXT,
  rows_in INTEGER, rows_out INTEGER,
  started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs ON pipeline_runs(pipeline_id, created_at DESC);
CREATE TABLE IF NOT EXISTS pipeline_credentials (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT, secret TEXT NOT NULL,
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

export const iso = () => new Date().toISOString();

/** 共享数据库句柄：所有 repo 接收同一实例，禁止各自打开数据库。 */
export class StoreDb {
  readonly db: DatabaseSync;
  readonly box: SecretBox;

  constructor(dbPath: string, secret: string) {
    this.db = new DatabaseSync(dbPath);
    this.box = new SecretBox(secret);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  migrate(): void {
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
    // 「加密但不校验证书」必须落库：自签证书的库在重启后不该退回校验失败
    this.ensureColumn('connections', 'ssl_insecure', 'INTEGER NOT NULL DEFAULT 0');
    // 搜索类引擎的 API Key 认证方式同样要跨重启保留
    this.ensureColumn('connections', 'auth_mode', 'TEXT');
    // 副本集 / authSource / 直连这类部署形态参数不属于密码，但必须能持久化
    this.ensureColumn('connections', 'options_json', 'TEXT');
    // 会话累计用量：轮次/步数/缓存命中都要跨会话保留，否则重开会话状态条就空了
    this.ensureColumn('agent_sessions', 'turns', 'INTEGER DEFAULT 0');
    this.ensureColumn('agent_sessions', 'steps', 'INTEGER DEFAULT 0');
    this.ensureColumn('agent_sessions', 'cache_hit_tokens', 'INTEGER DEFAULT 0');
    this.ensureColumn('agent_sessions', 'cache_miss_tokens', 'INTEGER DEFAULT 0');
    this.ensureColumn('agent_sessions', 'context_tokens', 'INTEGER DEFAULT 0');
    // 「上一回合没做完」必须跨连接保留：界面上的「继续」过去只挂在 live 上，
    // 回合一结束 live 就被历史替换掉，关页面走掉的人回来时什么提示都看不到。
    this.ensureColumn('agent_sessions', 'resume_cause', 'TEXT');
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
    // jobs.type 的 CHECK 里没有 'pipeline'，ALTER 改不了约束，只能按新 DDL 重建后搬数据。
    const jobsSql = this.one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")?.sql ?? '';
    if (!jobsSql.includes("'pipeline'")) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('ALTER TABLE jobs RENAME TO jobs_v8');
        this.db.exec(`CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          database_name TEXT,
          type TEXT NOT NULL CHECK (type IN ('query','backup','pipeline')),
          sql TEXT,
          payload TEXT,
          interval_seconds INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          last_status TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.db.exec(`INSERT INTO jobs (id,name,connection_id,database_name,type,sql,payload,interval_seconds,enabled,last_run_at,last_status,last_error,created_at,updated_at)
          SELECT id,name,connection_id,database_name,type,sql,NULL,interval_seconds,enabled,last_run_at,last_status,last_error,created_at,updated_at FROM jobs_v8`);
        this.db.exec('DROP TABLE jobs_v8');
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    this.ensureColumn('jobs', 'payload', 'TEXT');
    // 出站 MCP 配对凭据需要受限 scope；旧库补列后默认值 'full'，移动端不受影响。
    this.ensureColumn('devices', 'scope', "TEXT NOT NULL DEFAULT 'full'");
    // 术语同义词要跨重启保留，否则召回与 prompt 的加成会静默消失
    this.ensureColumn('memories', 'synonyms', 'TEXT');
    this.db.exec('PRAGMA user_version = 9');
  }

  ensureColumn(table: string, column: string, type: string): void {
    const exists = this.all<{ name: string }>(`PRAGMA table_info(${table})`).some((item) => item.name === column);
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return (this.db.prepare(sql).all as (...args: unknown[]) => unknown)(...params) as T[];
  }

  one<T>(sql: string, params: unknown[] = []): T | undefined {
    return (this.db.prepare(sql).get as (...args: unknown[]) => unknown)(...params) as T | undefined;
  }

  exec(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    return (this.db.prepare(sql).run as (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint })(...params);
  }

  /**
   * 按 rowid 边界删最旧：LIMIT n 反向取保留集的最小 rowid，再做范围删除。
   * 相比大 NOT IN 列表，不需要把上万个 id 物化后逐行探测；rowid 随插入递增，边界即保留线。
   */
  pruneTable(table: 'audit_log' | 'tool_runs' | 'artifact_runs', keep: number): void {
    this.exec(
      `DELETE FROM ${table} WHERE rowid < COALESCE((SELECT MIN(rowid) FROM (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT ?)), 0)`,
      [keep],
    );
  }

  close(): void {
    this.db.close();
  }
}
