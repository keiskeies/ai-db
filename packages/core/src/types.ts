export type Engine =
  | 'sqlite'
  | 'mysql'
  | 'mariadb'
  | 'postgresql'
  | 'cockroachdb'
  | 'sqlserver'
  | 'oracle'
  | 'clickhouse'
  | 'mongodb'
  | 'redis'
  | 'neo4j'
  | 'memgraph'
  | 'dm'
  | 'qdrant'
  | 'milvus'
  | 'weaviate'
  | 'duckdb'
  | 'cassandra'
  | 'scylla'
  | 'elasticsearch'
  | 'opensearch'
  | 'kingbase'
  | 'opengauss'
  | 'gaussdb'
  | 'oceanbase'
  | 'tidb'
  | 'polardb'
  | 'tdsql'
  | 'gbase8a'
  | 'doris'
  | 'starrocks'
  | 'highgo'
  | 'vastbase'
  | 'ivorysql'
  | 'greatsql'
  | 'goldendb'
  | 'tdengine';

/** 数据模型，决定对象树、编辑器语言和结果渲染方式。 */
export type DataModel = 'relational' | 'document' | 'keyvalue' | 'vector' | 'graph' | 'widecolumn' | 'search' | 'timeseries';

/** 驱动实现所用的线协议；同一协议可以被多个产品复用。 */
export type Transport =
  | 'sqlite-file'
  | 'mysql'
  | 'postgres'
  | 'tds'
  | 'oracle'
  | 'clickhouse-http'
  | 'mongodb'
  | 'redis'
  | 'bolt'
  | 'dm'
  | 'qdrant-http'
  | 'milvus-http'
  | 'duckdb-file'
  | 'cassandra'
  | 'elasticsearch-http'
  | 'weaviate-http'
  | 'tdengine-http';

/** SQL 方言；协议别名（金仓、TiDB 等）复用已有方言。 */
export type DialectId = 'sqlite' | 'mysql' | 'postgres' | 'mssql' | 'oracle' | 'clickhouse' | 'dm' | 'tdengine';

export type QueryLanguage = 'sql' | 'mql' | 'redis' | 'cypher' | 'vector' | 'search' | 'cql';

export type DbObjectKind = 'table' | 'view' | 'collection' | 'key' | 'node_label' | 'edge_label' | 'vector_collection' | 'index';

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
  /** 非关系型对象的实际类型；缺省按 type 解释。 */
  kind?: DbObjectKind;
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
  /** 非关系型引擎的通用对象列表；关系型引擎可继续只读 tables。 */
  objects?: DbObject[];
}

export interface DbObjectStats {
  rows?: number;
  documents?: number;
  keys?: number;
  vectors?: number;
  dimension?: number;
  metric?: string;
  ttlSeconds?: number;
}

/** 跨模型的对象描述：关系型表/视图、Mongo 集合、Redis 键、图标签等。 */
export interface DbObject {
  name: string;
  kind: DbObjectKind;
  schema?: string;
  rowEstimate?: number;
  columns?: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
  comment?: string;
  stats?: DbObjectStats;
  attributes?: Record<string, string | number | boolean>;
}

export interface ResultField {
  name: string;
  type?: string;
  /** 非标量结果的前端渲染提示。 */
  kind?: 'scalar' | 'json' | 'vector' | 'geometry';
}

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
  /** 结果形态；缺省按 table 处理，非关系型引擎用它选择渲染器。 */
  resultKind?: 'table' | 'documents' | 'keys' | 'graph' | 'vectors';
  /** 图查询的可视化数据；resultKind 为 graph 时由 Neo4j/Memgraph 驱动填充。 */
  graph?: GraphData;
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

export type MemoryKind = 'fact' | 'preference' | 'schema' | 'episodic' | 'procedural' | 'glossary' | 'sql_example';
export type MemoryScopeType = 'global' | 'connection' | 'database' | 'table';

/** 顺序即 UI 展示顺序；业务语义类（glossary / sql_example）单独配额，不挤占情景记忆的召回名额。 */
export const MEMORY_KINDS: MemoryKind[] = ['fact', 'preference', 'schema', 'episodic', 'procedural', 'glossary', 'sql_example'];

export const MEMORY_KIND_LABELS: Record<MemoryKind, { zh: string; en: string }> = {
  fact: { zh: '事实', en: 'Fact' },
  preference: { zh: '偏好', en: 'Preference' },
  schema: { zh: '结构', en: 'Schema' },
  episodic: { zh: '情景', en: 'Episodic' },
  procedural: { zh: '程序', en: 'Procedural' },
  glossary: { zh: '术语', en: 'Term' },
  sql_example: { zh: '示例 SQL', en: 'SQL example' },
};

/** Agent 上下文覆盖项：表 / 列的启用状态与业务语义，或一条手工维护的表关联关系。 */
export type AgentContextKind = 'table' | 'column' | 'relation';

export interface AgentContextEntry {
  id: string;
  connectionId: string;
  database: string;
  kind: AgentContextKind;
  table: string;
  column?: string;
  refTable?: string;
  refColumn?: string;
  enabled: boolean;
  alias?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** 按库聚合后的上下文，直接喂给 prompt 构造器。 */
export interface AgentContextBundle {
  connectionId: string;
  database: string;
  /** 用户显式禁用的表；为空表示未做任何取舍，Agent 行为与未配置时一致。 */
  disabledTables: string[];
  disabledColumns: Record<string, string[]>;
  tableMeta: Record<string, { alias?: string; description?: string }>;
  columnMeta: Record<string, Record<string, { alias?: string; description?: string }>>;
  relations: Array<{ leftTable: string; leftColumn: string; rightTable: string; rightColumn: string; description?: string }>;
}

export const EMPTY_AGENT_CONTEXT_BUNDLE: AgentContextBundle = {
  connectionId: '',
  database: '',
  disabledTables: [],
  disabledColumns: {},
  tableMeta: {},
  columnMeta: {},
  relations: [],
};

/** bundle 是否含任何会改变 prompt 输出的内容；false 时必须走完全等同旧行为的路径。 */
export function isAgentContextActive(bundle?: AgentContextBundle | null): boolean {
  if (!bundle) return false;
  return Boolean(
    bundle.disabledTables.length ||
      Object.keys(bundle.disabledColumns).length ||
      Object.keys(bundle.tableMeta).length ||
      Object.keys(bundle.columnMeta).length ||
      bundle.relations.length,
  );
}

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
  /** 每轮结束后基于本轮涉及的表给出可点击的追问建议。 */
  followUpSuggestions: boolean;
  snapshotBeforeWrite: boolean;
  compactionThreshold: number;
  /** 按模型名保存的能力档案。 */
  modelProfiles?: Record<string, ModelProfile>;
  /** 当前模型选用的推理档位（对应 modelProfiles[model].reasoningTiers 的 level）。 */
  reasoningTier?: string;
  hasApiKey?: boolean;
}

export interface EmbeddingSettings {
  provider: 'none' | 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string;
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
  embedding: EmbeddingSettings;
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
    followUpSuggestions: true,
    snapshotBeforeWrite: true,
    compactionThreshold: 24000,
  },
  embedding: {
    provider: 'none',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
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
  database?: string;
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
