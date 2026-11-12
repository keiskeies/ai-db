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
  | 'tdengine'
  | 'falkordb'
  | 'influxdb'
  | 'arangodb'
  | 'timescale';

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
  | 'tdengine-http'
  | 'falkordb'
  | 'influxdb-http'
  | 'arangodb-http';

/** SQL 方言；协议别名（金仓、TiDB 等）复用已有方言。 */
export type DialectId = 'sqlite' | 'mysql' | 'postgres' | 'mssql' | 'oracle' | 'clickhouse' | 'dm' | 'tdengine' | 'influxdb';

export type QueryLanguage = 'sql' | 'mql' | 'redis' | 'cypher' | 'vector' | 'search' | 'cql' | 'aql';

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
  /** 加密但不校验证书链：MySQL 自签证书、内网 IP 证书、企业自签 CA 都靠它。 */
  sslInsecure?: boolean;
  /** 搜索类引擎（ES / OpenSearch）的认证方式；apikey 时密码字段存的是 API Key。 */
  authMode?: 'basic' | 'apikey';
  /** 部署形态相关的连接参数；不同引擎只用自己看得懂的字段。 */
  options?: ConnectionOptions;
  ssh?: SshConfig;
  readonly: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface ConnectionOptions {
  /** MongoDB 副本集名：Docker/Atlas 节点回内部主机名时，靠它或直连才能连上。 */
  replicaSet?: string;
  /** MongoDB 认证库（默认是目标库，用户建在 admin 时必须指定）。 */
  authSource?: string;
  /** MongoDB 单节点直连，跳过拓扑发现。 */
  directConnection?: boolean;
  /** Redis 部署形态：Cluster 下只有一个逻辑库，键分散在多个主节点。 */
  redisMode?: 'standalone' | 'cluster';
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

/** 键值引擎的键详情：类型、TTL、规模与按类型展开的取值行。 */
export interface RedisKeyDetail {
  key: string;
  type: string;
  ttl: number;
  size: number | null;
  encoding?: string;
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  note?: string;
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
  favorite?: boolean;
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

/** 仪表板卡片的图表类型；与桌面端 ChartType 是同一组字面量，可直接互转。 */
export type DashboardChartType = 'bar' | 'stacked' | 'line' | 'pie' | 'scatter' | 'heatmap' | 'radar';

export const DASHBOARD_CHART_TYPES: DashboardChartType[] = ['bar', 'stacked', 'line', 'pie', 'scatter', 'heatmap', 'radar'];

/** 单板卡片上限：再多就不再是「常用问题面板」，而是没人看的BI墙。 */
export const DASHBOARD_CARD_LIMIT = 12;

export type DashboardCardSource = 'ai' | 'favorite' | 'manual';

export interface DashboardCard {
  id: string;
  connectionId: string;
  database?: string;
  title: string;
  sql: string;
  chartType: DashboardChartType;
  /** 列名提示；缺省时由 buildChartSpec 推断 */
  x?: string;
  y?: string;
  /** 参与板级时间筛选的时间列；必须被 SQL 投影出来，否则视为不参与 */
  timeColumn?: string;
  span: 1 | 2;
  position: number;
  source: DashboardCardSource;
  /** false = AI 草稿，可被整批替换；true = 用户固定，生成不得覆盖 */
  pinned: boolean;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  /** 上次结果快照：打开即见图，随后后台重跑 */
  lastResult?: { columns: Array<{ name: string }>; rows: unknown[][] };
  schemaHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardCardInput {
  connectionId: string;
  database?: string;
  title: string;
  sql: string;
  chartType: DashboardChartType;
  x?: string;
  y?: string;
  timeColumn?: string;
  span?: 1 | 2;
  position?: number;
  source?: DashboardCardSource;
  pinned?: boolean;
  /** 生成器试跑已经跑过一次，把结果当快照带走，卡片入板即可渲染，不必再打一轮 */
  lastResult?: { columns: Array<{ name: string }>; rows: unknown[][] };
}

/** 板级时间范围：只对声明了 timeColumn 的卡片生效，用外层包裹实现。 */
export interface DashboardTimeRange {
  from?: string;
  to?: string;
}

export interface DashboardCardResult {
  cardId: string;
  status: 'ok' | 'error';
  columns: Array<{ name: string }>;
  rows: unknown[][];
  durationMs: number;
  error?: string;
  /** 时间筛选让查询失败时回退到不筛选的结果，UI 必须据此标注「筛选未生效」 */
  filterSkipped?: boolean;
}

/** 新建卡片的试跑预览：与卡片刷新同一条只读执行路径，只多一个 error 让表单内联显示。 */
export interface DashboardPreview {
  columns: Array<{ name: string }>;
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  truncated?: boolean;
  error?: string;
}

/** 一句话需求 → 单张卡片：模型返回 SQL 并已完成只读试跑。 */
export interface DashboardComposeResult {
  usedModel: boolean;
  title: string;
  sql: string;
  chartType: DashboardChartType;
  x?: string;
  y?: string;
  timeColumn?: string;
  preview: DashboardPreview;
  notes: string[];
}

/** 定时刷新默认关闭：后台默默跑查询对生产库是风险，必须逐板显式开启。 */
export interface DashboardScheduleInfo {
  connectionId: string;
  database?: string;
  intervalSeconds: number;
  enabled: boolean;
  notifyChannels: string[];
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  updatedAt: string;
}

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
 * 推理与输入模态缺省代表未知，调用方必须按最保守的行为处理（不发推理参数、不收图）；
 * 窗口与输出上限相反，缺省用 `providers/profile.ts` 的默认档位（256K/32K），
 * 与设置页输入框预填的值同一个来源。
 */
export interface ModelProfile {
  /** 上下文窗口（tokens）；没填按 DEFAULT_CONTEXT_WINDOW 算。 */
  contextWindow?: number;
  /** 单次回复的最大输出（tokens）；没填按 DEFAULT_MAX_OUTPUT_TOKENS 算。 */
  maxOutputTokens?: number;
  /** 支持的输入类型；缺省按「仅文本」处理。 */
  inputs?: ModelInputModality[];
  /** 是否支持可调档位的推理。 */
  reasoning?: boolean;
  /** 档位表；顺序即界面顺序。 */
  reasoningTiers?: ModelReasoningTier[];
}

/** 服务商下的一个模型：id 是发给接口的模型名，name 是界面展示名。 */
export interface AgentModelEntry {
  id: string;
  name?: string;
}

/** 一个可切换的模型来源（服务商连接）：同一端点 + 密钥下可以挂多个模型。 */
export interface AgentModelConfig {
  id: string;
  /** 服务商展示名；缺省显示模型名或端点。 */
  name?: string;
  provider: AgentSettings['provider'];
  preset?: string;
  baseUrl: string;
  /** 该服务商下可选的模型；顺序即列表顺序，至少一个。 */
  models: AgentModelEntry[];
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
  /** 上下文压缩阈值：占模型上下文窗口的百分比（0-100，默认 70）。超过即压缩历史。 */
  compactionThreshold: number;
  /** 按模型名保存的能力档案。 */
  modelProfiles?: Record<string, ModelProfile>;
  /** 当前模型选用的推理档位（对应 modelProfiles[model].reasoningTiers 的 level）。 */
  reasoningTier?: string;
  hasApiKey?: boolean;
  /** 可切换的模型来源列表；缺省时用当前 provider/baseUrl/model 合成一个默认连接。 */
  modelConfigs?: AgentModelConfig[];
  /** 当前使用的连接 id（对应 modelConfigs[].id）；具体模型名见 model。 */
  activeModelId?: string;
  /** 每个连接是否已保存密钥；只读，由 Bridge 在公开设置里填充。 */
  modelApiKeyStatus?: Record<string, boolean>;
  /** 提交设置时的密钥变更（连接 id → 新密钥或 __CLEAR__），只写不读。 */
  modelKeys?: Record<string, string>;
}

export interface EmbeddingSettings {
  provider: 'none' | 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
}

export interface FeatureSettings {
  /** 允许 Agent/Worker 使用 Skill 工具；关闭后已安装 Skill 仍可管理。 */
  skills: boolean;
  /** 报告产物是否显示 AI PPT / 允许 deck 生成接口。 */
  reportDeck: boolean;
  /** 允许 Agent 调用 MCP 工具；MCP Server 配置仍可管理。 */
  mcp: boolean;
  /** 数据流处理（pipeline）总开关；关闭后流水线不再被调度执行。 */
  pipelines: boolean;
  /** 允许流水线里的 JS/Python 脚本步骤。脚本以子进程执行用户代码，默认关闭。 */
  pipelineScripts: boolean;
}

export type SearchBackendId =
  | 'exa'
  | 'parallel'
  | 'bing'
  | 'duckduckgo'
  | 'searxng'
  | 'brave'
  | 'tavily'
  | 'serper'
  | 'mojeek'
  | 'deepseek'
  | 'anthropic'
  | 'openai';

export interface SearchSettings {
  enabled: SearchBackendId[];
  numResults: number;
  concurrency: number;
  timeoutMs: number;
  timeRange: 'any' | 'day' | 'week' | 'month' | 'year';
  language?: string;
  dedupe: 'url' | 'none';
  rerank: boolean;
  safeSearch: boolean;
  healthTelemetry: boolean;
  searxngBaseUrl: string;
  /** 出站代理（如 http://127.0.0.1:7890）；网关启动时注入进程环境，改动后需重启生效。 */
  proxyUrl?: string;
  anthropicModel?: string;
  openaiModel?: string;
  /** Read-only: which optional backends have a saved key. */
  keyStatus?: Record<string, boolean>;
  /** Write-only: key changes (new value or __CLEAR__). */
  searchKeys?: Record<string, string>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
  score?: number;
  sources?: string[];
}

export interface SearchBackendReport {
  id: SearchBackendId;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  backends: SearchBackendReport[];
  total: number;
  deduped: number;
}

export interface SearchBackendHealth {
  id: SearchBackendId;
  status: 'idle' | 'ok' | 'error';
  lastMs?: number;
  lastAt?: string;
  lastError?: string;
  successes: number;
  failures: number;
}

/** 界面语言。默认英语；'zh' 为旧版取值，读取时归一为 zh-CN。 */
export type AppLocale =
  | 'en'
  | 'zh-CN'
  | 'zh-TW'
  | 'ja'
  | 'ko'
  | 'de'
  | 'fr'
  | 'es'
  | 'pt-BR'
  | 'it'
  | 'ru'
  | 'ar'
  | 'hi'
  | 'id'
  | 'vi'
  | 'th'
  | 'tr'
  | 'nl'
  | 'pl'
  | 'uk';

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  locale: AppLocale;
  defaultLimit: number;
  queryTimeoutMs: number;
  historyLimit: number;
  historyRetentionDays: number;
  allowMultiStatement: boolean;
  autoLimit: boolean;
  agent: AgentSettings;
  embedding: EmbeddingSettings;
  features: FeatureSettings;
  search: SearchSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  locale: 'en',
  defaultLimit: 100,
  queryTimeoutMs: 30000,
  historyLimit: 1000,
  historyRetentionDays: 90,
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
    compactionThreshold: 70,
  },
  embedding: {
    provider: 'none',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
  },
  features: { skills: true, reportDeck: true, mcp: true, pipelines: true, pipelineScripts: false },
  search: {
    /** 只默认启用实测可达的免密钥后端；DuckDuckGo/SearXNG 需代理或自建，改为手动开启。 */
    enabled: ['exa', 'parallel', 'bing'],
    numResults: 8,
    concurrency: 6,
    timeoutMs: 30000,
    timeRange: 'any',
    language: '',
    dedupe: 'url',
    rerank: false,
    safeSearch: true,
    healthTelemetry: true,
    /** 公共实例一律禁用 format=json，只有自建实例可用，因此默认留空而不是指向一个连不上的地址。 */
    searxngBaseUrl: '',
    anthropicModel: 'claude-sonnet-4-20250514',
    openaiModel: 'gpt-5.1',
  },
};

export interface AgentPlanItem {
  id: string;
  text: string;
  status: 'todo' | 'doing' | 'done';
}

/**
 * 服务端为「没做完的回合」落检查点时记录的原因，与 buildResumeCheckpoint 的 cause 同名同义。
 *
 * 它和 AgentStopReason 不是一张表：那份说的是「模型这一行为什么停」，这份说的是
 * 「服务端留下了一份可续跑的进度」。用户点停止属于前者、不属于后者——那种回合不写检查点。
 * 'stalled' 与 'disconnected' 也必须分开：前者是模型端不回话，后者是界面那侧断开，
 * 排查方向完全相反。
 */
export type AgentResumeCause = 'stalled' | 'truncated' | 'empty' | 'disconnected' | 'max_steps';

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
  /** 会话累计完成的对话轮次。 */
  turns: number;
  /** 会话累计走过的模型步数。 */
  steps: number;
  /** 会话累计命中提示词缓存的输入 tokens；服务商不返回缓存统计时保持 0。 */
  cacheHitTokens: number;
  /** 会话累计未命中提示词缓存的输入 tokens。 */
  cacheMissTokens: number;
  /** 最近一次模型调用的输入 tokens，即重开会话时仍要显示的上下文占用。 */
  contextTokens: number;
  /**
   * 上一回合**没做完**就结束的原因；只有服务端确实落了续跑检查点时才有值。
   *
   * 存在的理由：界面上的「继续」不能只挂在 live 上。回合结束时 live 会被历史替换掉
   * （sendAgent 的 finally），而最需要这句提示的两种情况恰好都没有 live——
   * 关页面走掉的人回来时本地什么都没留下，重开会话只能看到持久化的消息。
   * 新回合一开始就清空，所以它说的永远是「最后一次回合」。
   */
  resume?: AgentResumeCause;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageBlock {
  /**
   * text / thinking 带 step 字段的是 runtime 按步交付的（见 AgentEvent.step_text）：
   * 有它们才能把「这段解释是在哪个工具之前说的」渲染回真实顺序。
   * 不带 step 的老 thinking 是整回合合并的一坨，仅为兼容旧数据保留。
   */
  type: 'tool_call' | 'tool_result' | 'plan' | 'thinking' | 'text' | 'image';
  callId?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  risk?: Risk;
  status?: string;
  items?: AgentPlanItem[];
  text?: string;
  step?: number;
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
  type: 'query' | 'backup' | 'pipeline';
  sql?: string;
  /** 数据流处理任务的载荷：按数组顺序依次运行选中的流水线。 */
  payload?: { pipelineIds: string[] };
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
  /** 'full' = mobile/full API access (default for legacy rows); 'mcp:readonly' = outbound MCP bridge only. */
  scope: 'full' | 'mcp:readonly';
}
