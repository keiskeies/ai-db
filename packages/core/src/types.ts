export type Engine = 'sqlite' | 'mysql' | 'mariadb' | 'postgresql' | 'cockroachdb' | 'sqlserver' | 'oracle' | 'clickhouse';
export type Environment = 'dev' | 'staging' | 'prod';
export type PermissionMode = 'readonly' | 'ask' | 'auto' | 'full';
export type Risk = 'read' | 'write' | 'ddl' | 'destructive';
export type ConnectionColor = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'cyan' | 'gray';

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  authMethod: 'password' | 'key';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  engine: Engine;
  color: ConnectionColor;
  environment: Environment;
  groupName: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  hasPassword?: boolean;
  ssl?: boolean;
  ssh?: SshConfig;
  readonly: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface ConnectionSecret {
  password?: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string | null;
  primaryKey: boolean;
  autoIncrement?: boolean;
  comment?: string;
  generated?: 'virtual' | 'stored';
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary?: boolean;
  method?: string;
  comment?: string;
}

export interface ForeignKeyInfo {
  name?: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  refSchema?: string;
  onDelete?: string;
  onUpdate?: string;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view';
  schema?: string;
  rowEstimate?: number;
  columns?: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
  comment?: string;
}

export interface DatabaseSchema {
  name: string;
  tables: TableInfo[];
}

export interface ResultField {
  name: string;
  type?: string;
}

export interface QueryResult {
  columns: ResultField[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  truncated?: boolean;
  messages?: string[];
  affected?: number;
  lastInsertId?: number | string;
  statement?: string;
}

export interface QueryBatchResult {
  sets: QueryResult[];
  messages: string[];
  durationMs: number;
}

export interface QueryHistoryItem {
  id: string;
  connectionId?: string;
  database?: string;
  sql: string;
  status: 'ok' | 'error';
  durationMs?: number;
  rowCount?: number;
  error?: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actor: 'user' | 'agent';
  connectionId?: string;
  database?: string;
  tool?: string;
  sql?: string;
  risk?: Risk;
  approval?: string;
  status: 'ok' | 'denied' | 'error';
  durationMs?: number;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export type MemoryKind = 'fact' | 'preference' | 'schema' | 'episodic' | 'procedural';
export type MemoryScopeType = 'global' | 'connection' | 'database' | 'table';

export interface Memory {
  id: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  sourceSession?: string;
  sourceMessage?: string;
  pinned: boolean;
  archived: boolean;
  useCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCandidate {
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  scopeType?: MemoryScopeType;
  scopeKey?: string;
}

export type ModelInputModality = 'text' | 'image';

/** 推理档位：level 是界面标识，value 是发给服务商的参数值；value 为空表示该档不发任何参数（即「关闭思考」）。 */
export interface ModelReasoningTier {
  level: string;
  value: string;
}

/**
 * 单个模型的能力档案，按模型名存在 AgentSettings.modelProfiles 里。
 * 字段缺省代表未知，调用方必须按最保守的行为处理（不发推理参数、不收图）。
 */
export interface ModelProfile {
  /** 上下文窗口（tokens）。 */
  contextWindow?: number;
  /** 单次回复的最大输出（tokens）。 */
  maxOutputTokens?: number;
  /** 支持的输入类型；缺省按「仅文本」处理。 */
  inputs?: ModelInputModality[];
  /** 是否支持可调档位的推理。 */
  reasoning?: boolean;
  /** 档位表；顺序即界面顺序。 */
  reasoningTiers?: ModelReasoningTier[];
}

export interface AgentSettings {
  provider: 'local' | 'anthropic' | 'openai' | 'ollama';
  /** 服务商预设标识（deepseek / kimi / ollama …），用于界面回显与取模型列表。 */
  preset?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxSteps: number;
  autoMemory: boolean;
  snapshotBeforeWrite: boolean;
  compactionThreshold: number;
  /** 按模型名保存的能力档案。 */
  modelProfiles?: Record<string, ModelProfile>;
  /** 当前模型选用的推理档位（对应 modelProfiles[model].reasoningTiers 的 level）。 */
  reasoningTier?: string;
  hasApiKey?: boolean;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  density: 'compact' | 'comfortable';
  locale: 'zh' | 'en';
  defaultLimit: number;
  queryTimeoutMs: number;
  allowMultiStatement: boolean;
  autoLimit: boolean;
  agent: AgentSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  density: 'compact',
  locale: 'zh',
  defaultLimit: 100,
  queryTimeoutMs: 30000,
  allowMultiStatement: false,
  autoLimit: true,
  agent: {
    provider: 'local',
    preset: 'local',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.2,
    maxSteps: 12,
    autoMemory: true,
    snapshotBeforeWrite: true,
    compactionThreshold: 24000,
  },
};

export interface AgentPlanItem {
  id: string;
  text: string;
  status: 'todo' | 'doing' | 'done';
}

export interface AgentSessionMeta {
  id: string;
  connectionId?: string;
  title: string;
  summary?: string;
  model?: string;
  permissionMode: PermissionMode;
  status: 'idle' | 'running' | 'done' | 'error' | 'aborted';
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageBlock {
  type: 'tool_call' | 'tool_result' | 'plan' | 'thinking' | 'image';
  callId?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  risk?: Risk;
  status?: string;
  items?: AgentPlanItem[];
  text?: string;
  /** type 为 image 时指向 Bridge 本地附件。 */
  attachmentId?: string;
  mime?: string;
  bytes?: number;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  blocks: AgentMessageBlock[];
  tokens?: number;
  createdAt: string;
}

export interface JobInfo {
  id: string;
  name: string;
  connectionId: string;
  database?: string;
  type: 'query' | 'backup';
  sql?: string;
  intervalSeconds: number;
  enabled: boolean;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error' | 'running';
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackupInfo {
  id: string;
  connectionId: string;
  database?: string;
  path: string;
  format: string;
  bytes: number;
  label?: string;
  createdAt: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  pairedAt: string;
  lastSeenAt?: string;
  revoked: boolean;
}
