# AiDB Studio — 数据模型与接口协议

> 版本：v0.4-dev · 关联：[架构](./01-tech-architecture.md) · [Agent](./04-ai-agent-design.md)

## 1. 本地元数据库（Bridge · SQLite）

数据库文件：`<userData>/aidb.db`（桌面：Electron userData；Bridge：`$AIDB_HOME/aidb.db`）。启用 `WAL`、`foreign_keys=ON`、`busy_timeout=5000`。

```sql
CREATE TABLE IF NOT EXISTS connections (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  engine        TEXT NOT NULL, -- 取值见 §2 Engine；不设 CHECK，新增协议别名无需迁移
  color         TEXT NOT NULL DEFAULT 'blue',
  environment   TEXT NOT NULL DEFAULT 'dev' CHECK (environment IN ('dev','staging','prod')),
  group_name    TEXT NOT NULL DEFAULT '默认',
  host          TEXT, port INTEGER, database TEXT,
  username      TEXT,
  secret        TEXT,              -- AES-256-GCM 加密 JSON：password / sshPassword / sshKey
  ssl           INTEGER NOT NULL DEFAULT 0,
  ssh_json      TEXT,
  readonly      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_used_at  TEXT
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS query_history (
  id TEXT PRIMARY KEY, connection_id TEXT, database_name TEXT,
  sql TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER,
  row_count INTEGER, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_history_conn ON query_history(connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY, connection_id TEXT, database TEXT,  -- database: 会话选中的库（连接不再填库名）
  title TEXT NOT NULL DEFAULT '新会话',
  summary TEXT, model TEXT, permission_mode TEXT NOT NULL DEFAULT 'ask',
  status TEXT NOT NULL DEFAULT 'idle',        -- idle|running|done|error|aborted
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL,   -- user|assistant|system
  content TEXT NOT NULL DEFAULT '', blocks_json TEXT,  -- tool_call / tool_result / plan / thinking
  tokens INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT, tool TEXT NOT NULL,
  args_json TEXT, result_json TEXT, status TEXT NOT NULL, risk TEXT,
  approval TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,                    -- global|connection|database|table
  scope_key TEXT NOT NULL DEFAULT '*',
  kind TEXT NOT NULL,                          -- fact|preference|schema|episodic|procedural
  title TEXT NOT NULL, content TEXT NOT NULL,
  tags TEXT, importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
  source_session TEXT, source_message TEXT,
  pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0, last_used_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_mem_scope ON memories(scope_type, scope_key, archived);
CREATE INDEX idx_mem_kind ON memories(kind, importance DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL,    -- user|agent
  connection_id TEXT, database_name TEXT, tool TEXT, sql TEXT,
  risk TEXT, approval TEXT, status TEXT NOT NULL,
  duration_ms INTEGER, meta_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
  token_hash TEXT NOT NULL, paired_at TEXT NOT NULL, last_seen_at TEXT,
  revoked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, database_name TEXT,
  path TEXT NOT NULL, format TEXT NOT NULL, bytes INTEGER, label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_cache (
  connection_id TEXT NOT NULL, database_name TEXT NOT NULL,
  payload TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, database_name)
);

CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL,
  tags TEXT, connection_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, connection_id TEXT NOT NULL, database_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('query','backup')), sql TEXT,
  interval_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, last_status TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Agent 业务上下文：表/列的启用状态与业务语义，以及手工维护的 JOIN 关系。
-- 三类合表存储；术语与示例 SQL 不在此表，复用 memories(kind='glossary'|'sql_example')。
CREATE TABLE IF NOT EXISTS agent_context (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  database_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('table','column','relation')),
  table_name TEXT NOT NULL,
  column_name TEXT,
  ref_table TEXT, ref_column TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  alias TEXT, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_ctx ON agent_context(connection_id, database_name, kind);
```

## 2. 领域 DTO（`@aidb/core`）

```ts
export type Engine =
  | 'sqlite' | 'mysql' | 'mariadb' | 'postgresql' | 'cockroachdb' | 'sqlserver' | 'oracle' | 'clickhouse'
  | 'mongodb' | 'redis' | 'neo4j' | 'dm' | 'qdrant' | 'milvus' | 'duckdb'
  | 'kingbase' | 'opengauss' | 'gaussdb' | 'oceanbase' | 'tidb' | 'polardb' | 'tdsql' | 'gbase8a'
  | 'doris' | 'starrocks' | 'highgo' | 'vastbase' | 'ivorysql' | 'greatsql' | 'goldendb';
export type Environment = 'dev' | 'staging' | 'prod';
export type PermissionMode = 'readonly' | 'ask' | 'auto' | 'full';
export type Risk = 'read' | 'write' | 'ddl' | 'destructive';

export interface ConnectionConfig {
  id: string; name: string; engine: Engine; color: string; environment: Environment;
  groupName: string; host?: string; port?: number; database?: string; username?: string;
  hasSecret?: boolean; ssl?: boolean; ssh?: SshConfig; readonly: boolean;
  createdAt: string; updatedAt: string; lastUsedAt?: string;
}

export interface ColumnInfo {
  name: string; type: string; nullable: boolean; defaultValue?: string | null;
  primaryKey: boolean; autoIncrement?: boolean; comment?: string;
}
export interface IndexInfo { name: string; columns: string[]; unique: boolean; primary?: boolean }
export interface ForeignKeyInfo { name?: string; columns: string[]; refTable: string; refColumns: string[]; onDelete?: string }
export interface TableInfo {
  name: string; type: 'table' | 'view'; kind?: 'table' | 'view' | 'collection' | 'key';
  schema?: string; rowEstimate?: number;
  columns?: ColumnInfo[]; indexes?: IndexInfo[]; foreignKeys?: ForeignKeyInfo[]; comment?: string;
}

export interface QueryResult {
  columns: { name: string; type?: string }[];
  rows: unknown[][];
  rowCount: number; durationMs: number; truncated?: boolean;
  messages?: string[]; affected?: number; lastInsertId?: number | string;
}
```

## 3. HTTP API（`/api`，Bearer token）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, platform, demoReady}` |
| GET | `/bootstrap` | 一次性初始化：connections、settings(脱敏)、sessions、models、demo 状态 |
| GET/POST | `/connections` | 列表 / 新建 |
| PUT/DELETE | `/connections/:id` | 更新 / 删除 |
| POST | `/connections/:id/test` | 测试连接（不落库） |
| GET | `/connections/:id/databases` | 库/Schema 列表 |
| GET | `/connections/:id/schema?database=` | 全库结构（缓存） |
| GET | `/connections/:id/tables?database=` | 表列表（轻量） |
| POST | `/connections/:id/refresh` | 刷新 schema 缓存 |
| POST | `/search` | 数据库搜索（objects/data/all） |
| POST | `/databases/ops` | `{connectionId, database, op:create|drop|rename, newName?}`；按引擎能力执行 |
| POST | `/tables/ops` | `{connectionId, database?, table, op:ddl|rename|duplicate|truncate|empty|drop|maintenance, newName?, withData?, action?}` |
| POST | `/data/replace` | `{connectionId, database?, table, column, find, replace, where?, preview?}` → `{affected, sql}` |
| GET | `/objects` | 触发器 / 函数 / 序列 / 事件 |
| POST | `/schema/compare` | 两连接结构 diff |
| POST | `/schema/sync` | 执行结构同步语句 |
| POST | `/data/compare` | 行数 + 主键指纹对比 |
| POST | `/transfer` | 跨连接复制表结构与数据 |
| POST | `/generate` | 生成测试数据（dryRun 预览） |
| GET | `/monitor` | 服务器指标与会话 |
| POST | `/monitor/kill` | 终止会话 |
| GET | `/users` · POST `/users/action` | 用户列表 / 创建 / 删除 / 授权 |
| GET | `/dictionary` | Markdown / DDL / JSON 字典 |
| GET/POST | `/jobs` · PUT/DELETE `/jobs/:id` | 自动化任务 CRUD |
| POST | `/jobs/:id/run` | 立即运行任务 |
| POST | `/backups/:id/restore` | 从备份恢复 |
| POST | `/query` | `{connectionId, database?, sql, limit?, offset?, mode?}` → QueryResult。SQL 连接执行 SQL；MongoDB 的 `sql` 为 JSON MQL（`{collection, op, filter?, pipeline?, limit?}`）；Redis 的 `sql` 为单条命令文本（如 `SCAN 0 COUNT 100`）；Qdrant/Milvus 的 `sql` 为 JSON 向量查询 |
| POST | `/vector/search` | `{connectionId, database?, collection, field?, vector?, text?, topK?, filter?}` → `{result}`；pgvector 需 field，Qdrant/Milvus 可选命名向量；text 走 Embedding |
| GET | `/data` | `?connectionId&database&table&limit&offset&orderBy&where` |
| POST | `/rows` | `{op:'insert'|'insertMany'|'update'|'delete'|'deleteMany', values?/rows?/key?/keys?}` |
| POST | `/ddl/preview` | 结构化变更 → `{statements: string[]}` |
| POST | `/ddl/execute` | 执行 DDL（审批由 Agent 层负责；手工执行由 UI 确认） |
| POST | `/export` | `{connectionId, sql|table, format, path?}` → `{path, bytes}` |
| POST | `/import` | `{connectionId, table, csv, mapping, hasHeader, delimiter}` → 报告 |
| GET/POST | `/backups` | 列表 / 创建备份 |
| GET | `/history` | 查询历史（分页/搜索） |
| GET | `/audit` | 审计日志；`?format=csv` 导出 |
| GET | `/snippets` · POST/PUT/DELETE | SQL 片段 |
| GET | `/agent/tools` | 工具清单 + JSON Schema（UI 展示） |
| GET/POST | `/agent/sessions` | 会话列表 / 新建（`{connectionId?, database?, title?, permissionMode?}`） |
| GET/DELETE | `/agent/sessions/:id` | 会话详情（messages + tool_runs）/ 删除 |
| PATCH | `/agent/sessions/:id` | 更新会话（title / connectionId / database / permissionMode / archived） |
| POST | `/agent/sessions/:id/turns` | **SSE** 发起回合（`{text, mode, attachments, images, connectionId, database}`；database 依次回退到会话记录的库、连接默认库） |
| POST | `/agent/sessions/:id/abort` | 中止 |
| POST | `/agent/approvals/:id` | `{decision, scope}` 审批结果 |
| GET | `/agent/memories` | 记忆列表/搜索（scope/kind/q/limit） |
| POST | `/agent/memories` · PUT/DELETE `/agent/memories/:id` | 记忆管理（含 `glossary` / `sql_example`） |
| POST | `/agent/models` | 按 `{kind, baseUrl, apiKey?}` 拉取服务商模型列表 → `{models, infos, endpoint}`，`infos` 带上下文窗口/输入模态/推理档位（缺省密钥时复用已存密钥） |
| POST | `/agent/attachments` | `{mime, base64}` 上传聊天图片，落盘 `~/.aidb/attachments/` → `{attachment:{id,mime,bytes}}`（JPEG/PNG/GIF/WebP，单张 ≤8MB） |
| GET | `/agent/attachments/:id` | 读取附件二进制；id 限定 `<uuid>.<ext>` 白名单，拒绝路径穿越 |
| GET | `/agent/context` | `?connectionId&database` → `{entries, bundle, active}` 业务上下文 |
| PUT | `/agent/context/entry` | upsert 表/列覆盖（enabled / alias / description） |
| PUT | `/agent/context/relation` | upsert 手工 JOIN 关系（按四元组去重） |
| POST | `/agent/context/bulk` | 批量启用/禁用表 |
| DELETE | `/agent/context/entry/:id` · DELETE `/agent/context` | 删除单条 / 清空该连接（可带 database） |
| GET | `/agent/suggest` | `?connectionId&database&limit=6` → `{suggestions}` 猜你想问；纯本地规则，不查数据、不调模型，离线模式同样可用 |
| GET/PUT | `/settings` | 设置（密钥只写不读） |
| POST | `/pair/start` | 桌面发起配对：`{code, expiresIn, qrPayload}` |
| POST | `/pair/claim` | 移动端兑换：`{code, deviceName, platform}` → `{token, bridgeId}` |
| GET | `/devices` · DELETE `/devices/:id` | 设备管理 |

### 3.1 认证
- 桌面/浏览器：Bridge 启动时生成一次性 token（`AIDB_TOKEN` 或 Electron 注入），`Authorization: Bearer`。
- 移动：配对得到的设备 token（数据库仅存 SHA-256）；桥重启仍有效；可吊销。
- 所有请求写审计（读操作仅记录 query 类）。

## 4. 流式事件（SSE / WebSocket 共用）

`POST /agent/sessions/:id/turns` 返回 `text/event-stream`；移动端用 `/ws?token=`，发送 `{type:'turn'|'approval'|'abort', ...}`，接收相同事件。

```ts
type AgentEvent =
  | { type: 'start'; turnId: string; sessionId: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text_replace'; text: string }   // 模型把工具调用当文本吐出时，用更正后的正文替换已流出的内容
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; callId: string; tool: string; args: unknown; risk: Risk }
  | { type: 'tool_result'; callId: string; result: ToolResult }
  | { type: 'approval_required'; approvalId: string; call: {tool, args, risk, summary, sql?}; expiresIn: number }
  | { type: 'approval_resolved'; approvalId: string; decision: 'allow'|'deny'; scope: 'once'|'session'|'always' }
  | { type: 'plan'; items: { id: string; text: string; status: 'todo'|'doing'|'done' }[] }
  | { type: 'memory_used'; memories: { id: string; title: string; kind: string }[] }
  | { type: 'suggestions'; items: QuestionSuggestion[] }   // 回合结束后基于本轮实际涉及的表生成的追问建议
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'done'; turnId: string; durationMs: number; summary?: string }
  | { type: 'aborted'; turnId: string; reason: string }
  | { type: 'error'; code: string; message: string; retryable?: boolean };
```

SSE 帧：具名事件 `event: <type>`，`data: <json>\n\n`；每 15s 心跳注释 `: ping`。

## 5. 权限与审批的持久化
- 会话级 Allow 规则保存在 Bridge 内存（会话结束清除），并镜像到 `settings` 中的 `agent.sessionRules.<sessionId>`（进程重启可恢复 24h）。
- 连接级 Always Allow 保存 `agent.alwaysAllow.<connectionId>`（可撤销）。
- 所有审批结果写入 `audit_log`（`approval` 字段）。

## 6. 移动端本地存储（expo-sqlite）

移动端不存数据库凭据，仅缓存：
- `cache_sessions`, `cache_messages`（最近 30 个会话，离线可读）
- `cache_memories`（当前 scope 的镜像）
- `cache_schema`（按连接）
- 设备 token 存 SecureStore。

## 7. 版本与迁移
- `PRAGMA user_version` 记录 schema 版本（当前 3；v1→v2 重建 connections 以放开引擎约束，v3 增加 jobs）。
- 迁移脚本数组顺序执行、事务包裹；失败回滚并提示备份路径。
- API 前缀 `/api`；协议版本在 `/health` 返回，UI 不兼容时提示升级。
