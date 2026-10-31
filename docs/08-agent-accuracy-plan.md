# AiDB Studio — Agent 问数准确率提升方案

> 版本：v0.4 草案 · 状态：**待批准，未开发** · 关联：[AI Agent 设计](./04-ai-agent-design.md) · [数据与 API](./05-data-and-api.md) · [交付与验证](./06-delivery-and-verification.md)
>
> 基准产品：SQLBot（飞致云 / DataEase 团队，基于 LLM + RAG 的智能问数系统）
> 参考页：`user_manual/smart_question_description`（Agent 能力清单）、`best_practice`（问数调优四步法）

## 0. 摘要

SQLBot 与我们不是同一类产品：它只能问数，我们有 52 个工具、能写能改能备份。**能力广度上我们领先，差距全部集中在"模型是否理解用户的业务"这一条轴上。**

SQLBot 的《最佳实践》把问数失败归为四类——答非所问、结果不准、无法生成、术语混淆——并指出根因同一个：**模型掌握 SQL 语法，但缺少特定业务与库结构的上下文**。它的解法是「做减法 + 加注解」：只保留业务表、给字段起中文别名、给枚举值写释义、手工定义 JOIN 关系、录入标准问答 SQL 做 few-shot、建术语词典。

我们目前的做法正好相反：[`compressSchema`](../packages/core/src/agent/prompt.ts) 无差别地把最多 120 张表 × 48 列塞给模型，其中 15 张带明细，**没有任何业务语义、没有任何用户可控的取舍**。表一多，模型既抓不住重点也无从理解术语。

本方案拆成 5 个工作包，按依赖顺序交付：

| 包 | 名称 | 性质 | 后端 | 前端 | 新增工具 | 依赖 |
|---|---|---|---|---|---|---|
| **P1** | 业务上下文层 | 新建能力（**核心**） | 新表 + 5 路由 + prompt 改造 | 新面板 | 0 | — |
| **P2** | 猜你想问 + 追问建议 | 新建能力 | 1 路由（纯本地规则） | 建议气泡 | 0 | 建议依赖 P1 的启用表范围 |
| **P3** | 图表与明细补齐 | 修缺陷 + 增强 | 2 工具实现 | 图表工具条 | **2** | — |
| **P4** | 执行详情面板 | 补 UI（**数据已就绪**） | 0 | 抽屉 | 0 | — |
| **P5** | 会话重命名与搜索 | 补 UI（**服务端已就绪**） | 0 | 输入框 | 0 | — |

P4、P5 是「白送」的：数据已经在库里、接口已经返回，只差渲染。P1 是唯一能实质提升准确率的投入。P3 含一个真实缺陷（图表与明细互斥）。

---

## 1. 基准对照

### 1.1 Agent 能力逐条对照

| SQLBot 能力 | AiDB Studio 现状 | 差距 |
|---|---|---|
| 自然语言提问 | ✅ 40 工具，可读写 / DDL / 备份 | **我们更强** |
| 多轮上下文理解 | ✅ `compactHistory` 保留 24 轮 + token 预算裁剪（`agentHost.ts:148`） | 持平 |
| 历史对话：查看 / 删除 / 回溯续问 | ✅ 已有 | 持平 |
| 历史对话：重命名 / 搜索 | ❌ 无 UI（**服务端 PATCH 已支持 title**） | P5 |
| 执行详情（耗时 + Tokens + 可复现） | ⚠️ 数据全在（`messages.blocks` + `agent_sessions.tokens_in/out`），**未聚合展示** | P4 |
| SQL 查询可见 | ⚠️ 有「打开 SQL」，无一键复制 | P3 |
| 查看明细数据 | ❌ **有图表时明细被隐藏**（`AgentPanel.tsx:122` 条件为 `!chart && …`） | P3（缺陷） |
| 图表类型切换 / 放大 / 导出图片 | ❌ 仅 bar/line/pie、单系列、截断 24 点 | P3 |
| 【猜你想问】推荐问题 | ❌ 9 条**硬编码**斜杠命令（`AgentPanel.tsx:42`），`/chart` 写死「按 status 统计 orders」——多数库没有这张表 | P2 |
| 追加提问建议 | ❌ 无 | P2 |
| 数据分析（一键 AI 解读） | ❌ 无专用工具 | P3 |
| 数据预测（时序、自动选方法、输出预测值 + 逻辑） | ❌ 无；但 `buildMonthlySeriesExpr`（`ddl.ts:440`）已能跨方言生成月度时间桶 | P3 |
| **业务上下文四件套** | ❌ 无 | **P1** |

### 1.2 业务上下文四件套（SQLBot 调优四步法）

| SQLBot 机制 | 作用 | 我们的对应物 |
|---|---|---|
| 表管理（表 / 字段启用禁用） | 划定模型的知识边界，剔除日志表、配置表对 RAG 的干扰 | 无 |
| 字段别名 + 表 / 字段业务描述（含枚举值释义） | 把技术命名翻译成业务语言 | 仅数据库原生 `comment`，且不可覆写 |
| 表关联关系管理 | 保证多表 JOIN 正确 | 仅 `foreignKeys`（物理外键），无外键的库完全裸奔 |
| 示例 SQL（标准问题 → 标准答案） | few-shot 校准固定统计口径 | 无 |
| 自定义术语词典 | 消除简称 / 黑话歧义 | `MemoryKind` 五类中无 `glossary` |

---

## 2. 范围

### 2.1 做

- 用户可控的 Agent 上下文范围（启用 / 禁用表与字段）
- 业务语义注入（别名、描述、枚举释义、术语、示例 SQL、手工 JOIN 关系）
- 零 LLM 成本的本地问题推荐与追问建议
- 图表 / 明细 / SQL / 执行详情的完整可见性
- 服务端确定性计算的数据分析与预测（**模型只解释，不编数**）

### 2.2 不做

严格遵守 [`docs/00-product-overview.md` §5.2](./00-product-overview.md) 的「明确不做」：

- ❌ 仪表板 / 报表设计器（BI 分发能力，非 Agent 能力）
- ❌ 小助手浮窗嵌入、页面嵌入、Web 分享链接
- ❌ 工作空间隔离、成员管理、SSO、行级数据权限
- ❌ Excel 导入导出（图表明细沿用现有 CSV / JSON / SQL / XML 通道）
- ❌ 可视化 ER 建模编辑器（P1 只做「关系列表 + 表单式增删」，不做拖拽画布）

### 2.3 兼容性红线

- **未配置任何业务上下文时，Agent 行为必须与今天完全一致**（零回归默认值）
- 不改现有表的列（`Store.migrate()` 没有 `ALTER TABLE ADD COLUMN` 机制，只有 `CREATE TABLE IF NOT EXISTS`）→ 所有新增字段一律落在**新表**
- 现有工具的签名与语义不变（新增工具见 docs/04）

---

## 3. P1 · 业务上下文层

### 3.1 数据模型

新增单表承载三类覆盖项（`apps/gateway/src/store.ts` 的 `SCHEMA_SQL`）：

```sql
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
```

设计理由：
- 三类语义（表覆盖 / 列覆盖 / 手工关系）字段高度重叠，合表可避免三次迁移
- `kind` 用 CHECK 约束而非枚举列，SQLite 侧零成本
- 新表 → `CREATE TABLE IF NOT EXISTS` 对既有库自动生效，**`PRAGMA user_version` 保持 3 不变**
- 术语库与示例 SQL **不建新表**，复用现有 `memories`（见 §3.4）

### 3.2 core 类型（`packages/core/src/types.ts`）

```ts
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

/** 按库聚合后的视图，直接喂给 prompt 构造器 */
export interface AgentContextBundle {
  connectionId: string;
  database: string;
  disabledTables: string[];
  disabledColumns: Record<string, string[]>;        // table -> columns
  tableMeta: Record<string, { alias?: string; description?: string }>;
  columnMeta: Record<string, Record<string, { alias?: string; description?: string }>>;
  relations: Array<{ leftTable: string; leftColumn: string; rightTable: string; rightColumn: string; description?: string }>;
}

export function bundleAgentContext(entries: AgentContextEntry[]): AgentContextBundle;
```

`bundleAgentContext` 放 `packages/core/src/agent/context.ts`（新文件），纯函数、可单测。

### 3.3 prompt 注入

**改动面极小**：`compressSchema` 只有一个调用者 `buildSystemPrompt`（`prompt.ts:95`），后者只有一个调用者 `agentHost.ts:209`。

`SystemPromptOptions` 增加 `context?: AgentContextBundle`；`compressSchema` 签名增加第 4 参数 `bundle?: AgentContextBundle`：

1. `bundle.disabledTables` 中的表**跳过输出**，并在末尾追加一行 `- … N tables disabled by the user (ask them to enable if needed)`
2. `bundle.disabledColumns[t]` 中的列从 `columns:` 行剔除
3. 表行输出别名与描述：`- table clue (别名 线索表) — 线索表，包含所有已创建的线索信息… (~12000 rows)`
4. 列输出别名与释义：`name:VARCHAR→客户名称, status:VARCHAR→线索状态[FOLLOWING=跟进中; NEW=新建]`
5. 启用的表**优先占用** `maxTablesWithColumns` 明细预算（当前 15），确保被用户点选的表一定带列

新增 prompt 段落（`buildSystemPrompt` 尾部，仅在 bundle 非空时输出）：

```
## Business context (authoritative — overrides your own guesses)
### Terms
- JS → JumpServer
### Join relations
- clue.organization_id = sys_organization.id  （线索归属组织）
### Example questions and their canonical SQL (match this caliber)
Q: 今年第三季度东区制造业赢单总数
```sql
SELECT COUNT(*) FROM …
```

Rules for business context:
- Only query tables listed under ## Schema. If the answer needs a table that is absent or disabled, say so instead of guessing.
- Map natural-language wording to columns via the aliases and descriptions above; enum glosses are the only valid value interpretations.
- Use the join relations exactly as given; never invent join keys.
- When a question matches an example, reuse its statistical caliber (filters, grouping, time range).
```

术语与示例 SQL 从 `memories` 按 `kind` 取，与现有召回结果分区展示——`formatMemoriesForPrompt` 拆成三个函数：`formatGlossary`、`formatSqlExamples`、`formatMemoriesForPrompt`（其余三类照旧）。

### 3.4 MemoryKind 扩展

```ts
export type MemoryKind = 'fact' | 'preference' | 'schema' | 'episodic' | 'procedural' | 'glossary' | 'sql_example';
```

可行性已核验（见 §12）：`kind` 列是 `TEXT NOT NULL` **无 CHECK 约束**；全仓仅 3 处消费 `MemoryKind`，无穷举 switch；`GET /agent/memories?kind=` 已支持按 kind 过滤 → **零迁移、零路由改动**。

召回策略调整（`packages/core/src/agent/memory.ts`）：
- `glossary` 与 `sql_example` 命中时 `importance` 权重上调（`0.15 → 0.25`），且**不参与 6 条上限的挤占**（各自独立取 top 8 / top 3），避免业务语义被情景记忆冲掉
- `extractHeuristicMemories` 增加一条规则：用户说「X 就是 Y」「X 指 Y」「X 简称 Y」→ 生成 `glossary`

UI：`MemoryDrawer.tsx:81` 的 kind 下拉当前是硬编码 `['fact','preference','schema','procedural']`（**已漏 `episodic`**）→ 改为从 core 导出的 `MEMORY_KINDS` 常量渲染，顺带修掉这个既有遗漏。

### 3.5 API（`apps/gateway/src/routes.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agent/context?connectionId=&database=` | 返回 `{ entries, bundle, stats }`；`stats` 含表总数 / 已启用数，供 UI 显示 |
| PUT | `/agent/context/entry` | upsert 表或列覆盖（按 `connectionId+database+kind+table+column` 唯一定位） |
| PUT | `/agent/context/relation` | 新增 / 更新手工关系，返回 `{ id }` |
| DELETE | `/agent/context/entry/:id` | 删除单条 |
| POST | `/agent/context/bulk` | 批量启用 / 禁用（表管理面板「全选 / 反选 / 仅启用勾选」） |

术语与示例 SQL 复用现有 `POST/PUT/DELETE /agent/memories`，**不新增路由**。

`agentHost.ts` 在构造 system prompt 前调用 `store.listAgentContext(conn.id, conn.database)` → `bundleAgentContext` → 传入 `buildSystemPrompt`。为免每轮查库，结果按 `connectionId/database` 做 30s 内存缓存（与 `schema_cache` 同思路）。

### 3.6 UI

工具箱新增一项「**Agent 上下文**」（`ToolsHub.tsx` 注册表），四个 tab：

1. **表管理**：左侧当前库表列表（复用侧边树已加载的 schema），每行 `[启用开关] [表名] [别名输入] [描述输入]`；顶部「全部启用 / 全部禁用 / 仅启用选中」；右侧显示「已启用 N / 共 M 张表」与 token 预估（复用 `estimateTokens`），让用户直观看到上下文体积
2. **字段**：选中表后列出字段，同样支持启用 / 别名 / 描述；描述框给 placeholder 提示写法：`枚举值：FOLLOWING=跟进中，NEW=新建`
3. **关系**：上半区自动列出从 `foreignKeys` 推导的关系（只读，来源标记「外键」），下半区是手工关系表格（可增删），列：左表.左列 → 右表.右列 + 备注。**不做拖拽画布**
4. **术语与示例**：两个列表，直接读写 `memories`（kind=glossary / sql_example）；示例 SQL 条目用 CodeMirror 编辑器（复用现有 `sqlFormat`）

Navicat 一致性：入口只放工具箱一处，不在侧边树 / 设置里重复开口（遵循既有 UX 准则）。

### 3.7 交付清单

- [x] `packages/core/src/types.ts`：`AgentContextKind` / `AgentContextEntry` / `AgentContextBundle` / `MEMORY_KINDS`；`MemoryKind` 扩展
- [x] `packages/core/src/agent/context.ts`（新）：`bundleAgentContext`
- [x] `packages/core/src/agent/prompt.ts`：`compressSchema` / `buildSystemPrompt` 接 bundle；三个 format 函数
- [x] `packages/core/src/agent/memory.ts`：召回权重与独立配额；`extractHeuristicMemories` 术语规则
- [x] `apps/gateway/src/store.ts`：`agent_context` 表 + CRUD 方法
- [x] `apps/gateway/src/routes.ts`：5 条路由
- [x] `apps/gateway/src/agentHost.ts`：注入 bundle + 30s 缓存
- [x] `apps/desktop/src/lib/api.ts`：客户端方法
- [x] `apps/desktop/src/components/tools/AgentContextTool.tsx`（新）+ `ToolsHub.tsx` 注册
- [x] `apps/desktop/src/components/MemoryDrawer.tsx`：kind 下拉改用 `MEMORY_KINDS`
- [x] `apps/desktop/src/i18n.ts`：中英字符串
- [x] `apps/desktop/src/styles/*.css`
- [x] `docs/04-ai-agent-design.md` §「上下文组装」+ §「记忆架构」；`docs/05-data-and-api.md` 表与 API
- [x] 单测：`bundleAgentContext`、prompt 快照（有 / 无 bundle 两份）、召回配额

---

## 4. P2 · 猜你想问 + 追加提问建议

### 4.1 本地推荐引擎（零 LLM 成本）

新增 `packages/core/src/agent/suggest.ts`：

```ts
export interface QuestionSuggestion {
  id: string;
  prompt: string;      // 填入输入框的自然语言
  reason: string;      // 为什么推荐（UI tooltip）
  kind: 'trend' | 'group' | 'topn' | 'quality' | 'relation';
}
export function suggestQuestions(schema: DatabaseSchema[], opts?: { limit?: number; history?: string[] }): QuestionSuggestion[];
```

纯函数，只吃已加载的 `DatabaseSchema`，**不发任何查询、不调模型** → 离线模式下同样可用。

列识别规则（保守、可解释）：

| 角色 | 判定 |
|---|---|
| 时间列 | 类型含 `date/time/timestamp`，或列名匹配 `/(created?|updated?|_at\|_time\|date\|day\|month\|year)$/i` |
| 度量列 | 数值类型（int/decimal/double/numeric）且非主键、非外键、非时间列 |
| 维度列 | 字符 / 枚举类型且非主键；或列名匹配 `/(status\|state\|type\|kind\|category\|level\|channel\|gender\|flag)$/i` |

生成模板（每类取置信度最高的 1–2 条，总数默认 6 条）：

1. **trend**：`近 12 个月 {表} 的 {度量} 趋势` —— 直接复用 `buildMonthlySeriesExpr`
2. **group**：`按 {维度} 统计 {表} 的 {度量} 合计`
3. **topn**：`{表A} 中 {度量} 最高的前 10 个 {表B}` —— 仅当存在外键 / 手工关系
4. **quality**：`检查 {表} 的 {维度} 空值与重复情况`
5. **relation**：`{表A} 与 {表B} 的关联数据是否一致`

P1 落地后，`suggestQuestions` 只在**已启用**的表上生成，并优先使用别名与描述措辞（推荐语直接显示业务名，如「近 12 个月 线索表 的 线索数量 趋势」）。

历史加权：把 `query_history` 里出现频次最高的表提到推荐前列（`opts.history`），对应 SQLBot「基于用户历史问数行为」。

### 4.2 追问建议

一轮回答结束后，若 `settings.agent.followUpSuggestions` 为真：
- **本地模式**：基于本轮工具调用涉及的表，用 §4.1 的模板生成 3 条（零成本）
- **云端模式**：在 system prompt 末尾追加一条规则——最终回答后用 `<followups>` 标签输出 3 条追问；`agentHost` 解析并从正文剥离，通过新 SSE 事件 `suggestions` 下发

前端渲染为输入框上方的可点气泡，点击即填入（不自动发送，避免误触发）。

### 4.3 替换硬编码斜杠命令

`AgentPanel.tsx:42` 的 9 条 `SLASH` 中，`/chart`（写死 `orders.status`）与 `/quality`（写死 `orders`）在绝大多数库里都是死路。改为：
- 保留 `/schema /audit /explain /optimize /backup /memory /clear` 这 7 条与具体表无关的
- `/chart`、`/quality` 改为**从当前连接的实表动态生成**：弹出表选择器 → 用 §4.1 模板拼 prompt

### 4.4 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agent/suggest?connectionId=&database=` | `{ suggestions: QuestionSuggestion[] }`，服务端调 `suggestQuestions`（schema 从 `schema_cache` 取，未缓存则实时加载） |

### 4.5 交付清单

- [x] `packages/core/src/agent/suggest.ts`（新）+ 单测（构造假 schema 断言各类模板）
- [x] `apps/gateway/src/routes.ts`：`/agent/suggest`
- [x] `AgentPanel.tsx`：空会话时展示推荐问题气泡；`SLASH` 动态化
- [x] `packages/core/src/agent/types.ts`：`AgentEvent` 增加 `suggestions`
- [x] `apps/gateway/src/agentHost.ts`：`suggestions` 事件下发。**方案改了**：不再解析模型输出的 `<followups>` 标签，改为 `followUps()` 从本轮 `tool_call` 的 `args.table` / `args.sql` 提取真实涉及的表，再用 `suggestFollowUps` 本地生成。理由：标签解析依赖模型服从性，离线 provider 根本不会输出，而本地规则对所有 provider 一视同仁且零 token 成本
- [x] `AppSettings.agent.followUpSuggestions`（默认 true）+ 设置面板开关
- [x] `docs/04`（§10 斜杠命令表按实现重写 + 新增 §10.1）、`docs/05`（`/agent/suggest` 路由行 + `suggestions` 事件）
- [x] e2e：断言推荐气泡出现（≤6 条）且点击后填入输入框、不自动发送；追问建议在回合结束后出现

---

## 5. P3 · 图表与明细补齐

### 5.1 缺陷修复：图表与明细互斥

`AgentPanel.tsx:116-122` 当前逻辑：

```tsx
{chart ? <ChartView … /> : null}
{!chart && data?.columns && data?.rows ? <表格/> : null}
```

`render_chart` 的返回值里**本来就同时带 `chart`、`columns`、`rows`、`chartSql`**（`executor.ts:810`），明细数据是白送的，只是被 `!chart` 挡掉了。改为 tab 切换：`图表 | 明细 | SQL`，三个 tab 共用同一份数据。

### 5.2 图表工具条

抽出共享组件 `ChartToolbar`（`ChartView.tsx` 与 `QueryView.tsx:518` 的图表面板共用）：

> 复核发现：`QueryView` 已有图表类型 / X / Y 三个下拉（`QueryView.tsx:46-50` 的 `chartType`/`chartX`/`chartY` state，tab 在 `:482`，面板在 `:518`），而 Agent 侧完全没有。共享组件必须**吸收** QueryView 现有的这三个下拉，而不是在旁边再加一套——避免同一功能出现两个入口。

| 按钮 | 实现 |
|---|---|
| 类型切换 bar/line/pie/table | 纯前端：series 已在内存，`ChartView` 增加 `typeOverride` prop |
| 复制 SQL | `CopyButton`（已存在；`AgentPanel.tsx:107` 已在 SQL 块上用过，图表块补一个） |
| 导出 PNG | 序列化 SVG → `Image` → `canvas`（2x 缩放）→ `toBlob('image/png')` → anchor 下载。**已在 headless Chrome 实测通过**（见 §12.4 探针 3），两个必须遵守的细节：① base64 必须走 `btoa(unescape(encodeURIComponent(svg)))`，直接 `btoa(svg)` 遇中文坐标轴标签会抛异常；② SVG 自身无背景，`drawImage` 前要先 `fillRect` 底色，否则导出透明图 |
| 导出 CSV | `POST /export`（已有，`format: 'csv'`）传 `chartSql` |
| 放大 | 模态框渲染同组件，`viewBox` 拉大 |

`ChartView` 的 12 点硬上限（`ChartView.tsx:17`）改为 prop `maxPoints`（默认 12，放大态 60）。

> ⚠️ 技术债提示：`ChartView` 是手写 SVG；查询图表页已支持柱/堆叠/折线/饼/散点/热力/雷达、多列对比与单附加列右轴。P3 不引入图表库；新增图形仍走手写 SVG，若要加交互式缩放/刷选需单独立项评估 echarts。本方案不涉及。

### 5.3 新增工具：`analyze_chart`

```
risk: 'read'
args: { connectionId, database?, sql, x?, y? }
```

服务端跑 SQL（maxRows 500）后**在 gateway 侧算好统计量**再交给模型：

```ts
{ rowCount, sum, avg, min, max, argmin, argmax,
  topShare: [{label, value, share}],      // 前 5 及占比
  deltas: [{label, value, delta, ratio}]  // 仅当 x 为时间序列：环比
}
```

模型只负责把这些数字写成业务解读。**prompt 增加规则**：`analyze_chart 返回的统计值是权威结果，禁止自行重算或估算数字。`

### 5.4 新增工具：`forecast_chart`

```
risk: 'read'
args: { connectionId, database?, sql, x?, y?, periods? (1-12, 默认 3), method?: 'auto'|'linear'|'moving_average' }
```

确定性算法（`packages/core/src/analysis/forecast.ts` 新文件，纯函数可单测）。**以下每条规则都由 §12.4 探针 2 实测确定，不是纸面设计**：

1. 提取 `(x, y)` 序列，**先剔除 `null` / `undefined` / `''` 再做 `Number()` 转换**——`Number(null) === 0`，直接转换会把 SQL NULL 变成 0 点、静默污染拟合结果（探针实测踩到）；再剔除非有限值，按 x 原序
2. `linear`：最小二乘 `y = a + b·t`，外推 N 期；残差标准差按 `n-2` 自由度
3. `moving_average`：窗口 `w = clamp(floor(n/2), 2, 4)`，取末窗均值平推
4. `auto`：算 Pearson r，`|r| ≥ 0.6` 用 linear，否则 moving_average
5. 区间：`value ± 1.28σ`（约 80% 区间），**明确标注为粗略区间**；σ=0 时区间自然收敛为一点，不得输出 NaN
6. 样本不足（`n < 4`）→ 返回 `ok:false` + `NOT_ENOUGH_SAMPLES` 中文提示，不硬猜
7. **预测值出现负数时，`note` 里必须提示**「若该指标为计数/金额类，实际下限应视为 0」——不静默 clamp（那是不诚实的），也不放任误读
8. `note` 必须写明所用方法、斜率或窗口、拟合度 r，让用户能判断可信度

返回结构**保留原始序列**（对齐 SQLBot「保留原始数据结构，方便接入下游」）：

```ts
{ method, r, slope?, window?, note, original: [{label, value}],
  forecast: [{label, value, lower, upper}] }
```

前端复用 `ChartView`，`forecast` 段用虚线 + 半透明区间带渲染。

### 5.5 契约同步（**必须三处一起改，否则 CI 红**）

`scripts/verify-docs.mjs` 硬编码了工具清单与数量：

1. `packages/core/src/agent/tools.ts`：追加两个 `ToolDefinition`（契约脚本按 `name: 'x'` 字面量匹配）
2. `docs/04-ai-agent-design.md` 工具表：追加两行，格式必须匹配 `^\|\s*\d+\s*\|\s*\`name\`\s*\|\s*read\s*\|`
3. `scripts/verify-docs.mjs`：`expectedTools` 追加两项；`names.length === 22` 改为 `24`，检查名同步改为 `'24 agent tools documented'`
4. `apps/gateway/src/executor.ts`：dispatch + 实现
5. `docs/02-feature-spec.md` 若提及工具数量，同步

### 5.6 交付清单

- [x] `AgentPanel.tsx`：图表 / 明细 / SQL 三 tab（`!chart &&` 互斥已删除）
- [x] `ChartToolbar.tsx`（新，共享）+ `ChartView.tsx`：`typeOverride`、`maxPoints`、预测段渲染、PNG 导出、放大模态
- [x] `QueryView.tsx`：三个下拉被 `ChartToolbar` 吸收，不再有第二套入口
- [x] `packages/core/src/analysis/forecast.ts`（新）+ 单测：精确线性（斜率/r/外推值手算对照）、移动平均、样本不足拒绝、全同值不产 NaN、NULL 不被转成 0、负值预测带告警、原始序列保留
- [x] `packages/core/src/analysis/stats.ts`（新）+ 单测（toSeries / guessAxes / summarize / topShare / deltas / pearson / linearFit / isTimeSeries）
- [x] `tools.ts` / `executor.ts` / `verify-docs.mjs` / `docs/04` 四处同步（另加 `docs/00`、`docs/06`、`docs/07`、`apps/gateway/test/integration.test.ts`、`scripts/e2e.mjs` 的工具数量）
- [x] prompt 规则：模型不得重算 `analyze_chart` / `forecast_chart` 的数值，且必须转述 forecast 的 note
- [x] `local.ts`：新增 `analyze` 意图，离线模式下直接调 stats/forecast（不调模型也能给数字）
- [x] e2e 探针：`.tools/probes/p3-ui.mjs`（25 项）、`.tools/probes/p3-queryview.mjs`（14 项）全绿

### 5.7 实施中发现并修掉的问题（原方案未列出）

1. **`render_chart` 自己也在把 NULL 画成 0**：旧实现 `Number(row[yIndex])` 对 NULL 返回 0 且 `Number.isFinite(0)` 为真，等于 §5.4 规则 1 描述的同一种污染，只是发生在画图路径上。已抽成 `chartSeries()` 共用 `toSeries()`，三个图表工具走同一套 NULL 处理。
2. **`.result-tab` 类名撞车**：`app.css:245` 已有 QueryView 的结果 tab 条（固定 31px）。新样式沿用同名类会把它压扁。已改名 `chart-result-tab(s)`，并用探针断言 tab 条高度仍为 31px。
3. **测试脚本白名单是静默跳过陷阱**：`packages/core` 与 `apps/gateway` 的 `test` 脚本逐个列文件，新增测试文件不加进去就永远不跑、CI 还是绿的。已改为 `--test "test/*.test.ts"`（core 97 → 116 项，gateway 20 → 34 项，说明此前确有遗漏）。
4. **`verify-docs.mjs` 只校验 `tools.ts`，不校验 `executor.ts`**：声明了工具却没实现，运行期只会得到「未实现的工具」，而契约脚本全绿。已补 `executor tool <name>` 检查（按 `case '<name>':` 匹配，双向：漏实现与多余分支都报）。
5. **模型把 `connectionId` 猜成数据库路径**：实测首个 `run_sql` 传的是 `sqlite / C:\...\demo-shop.sqlite`，撞 `CONNECTION_NOT_FOUND` 后再靠 `list_connections` 兜底，白扔一次工具调用。系统提示原本只写 `engine / database @ host`，从来没给过 id。已改为 `id=… name=… engine=…`，并加规则「必须用 Connection 行里的 `id=`，不要靠 list_connections 重新发现」。
6. **回合结束后 `live` 被立刻清空**：`store.ts` 的 `finally` 用持久化消息替换 `live`，挂在 `live.suggestions` 上的追问建议在事件到达后几毫秒就被销毁，用户根本来不及点（P2 探针抓到的唯一失败项）。追问建议已提升为顶层 `agentFollowUps`，与 `live` 解耦。

---

## 6. P4 · 执行详情面板

**零后端改动。** 数据已完整落库并已通过接口下发：

- `messages.blocks` 已含 `tool_call`（args + risk）与 `tool_result`（完整 result，内含 `meta.durationMs`）——见 `agentHost.ts:170-181`、`types.ts:243 AgentMessageBlock`
- `agent_sessions.tokens_in/tokens_out` 已在会话元数据里，UI 已显示总数（`AgentPanel.tsx:723`）

做法：每条 assistant 消息头部加「执行详情」按钮，展开抽屉，按 `blocks` 顺序渲染时间线：

```
① inspect_schema   read   ✓  142ms   ▸ 参数 / 结果
② run_sql          read   ✓  1.2s    ▸ SQL（可复制）/ 行数
③ render_chart     read   ✓  890ms   ▸ 图表
── 3 次调用 · 2.2s · ↑1,842 ↓316 tokens ──
```

已知限制（实现时须知）：`tool_runs.message_id` **恒为 NULL**——`agentHost.ts:182` 调 `addToolRun` 时没传 `messageId`。所以：
- 方案 A（推荐）：抽屉直接从 `message.blocks` 渲染，天然按轮分组，**不碰后端**
- 方案 B：补传 `messageId` 并在 `wrappedEmit` 外先生成 assistant message id，使 `tool_runs` 可按轮查询（供未来跨会话分析）

本方案取 A；B 列为后续可选。

- [x] `AgentPanel.tsx`：`ExecutionDetail` 组件 + 时间线（入口挂在既有的 `.turn-end` 行上，不新增第二个按钮）
- [x] `i18n.ts`（`executionDetail` / `hideExecutionDetail`）、`app.css`（`.exec-*`）
- [x] e2e：跑一轮后展开详情，断言工具条数与耗时文本（`scripts/e2e.mjs`，探针版 `.tools/probes/p4p5-ui.mjs` 逐行比对 API 里的 `tool_call` 序列）

实施补充：

- 时间线每行显示 `序号 / 工具名 / 风险标记 / ✓✗ / 耗时`，展开后给参数（SQL 类工具直接展示 SQL 原文并可复制）与结果摘要。
- 汇总行是 `N 次调用 · 总耗时 · M 次失败 · ↓tokens`。**每消息只记录了输出 tokens**（`AgentMessage.tokens` 来自 `usage.tokensOut`），输入 tokens 只存在会话级，所以这里不编造 `↑` 数字。
- 失败调用会被如实标红并计数：实测某个会话第一行就是 `render_chart ✗ 1ms`——正是 §5.7 第 5 条那个 connectionId 猜测失败留下的痕迹，这个面板本身就成了准确率问题的取证工具。

---

## 7. P5 · 会话重命名与搜索

**服务端与客户端方法均已就绪**：

- `PATCH /agent/sessions/:id` 已接受 `title`（`routes.ts:690-702`）
- `store.updateSession` 的字段映射已含 `title`（`store.ts:550-576`）
- `api.updateSession` 已存在（`api.ts:224`）

只差 UI：
- 会话列表（`AgentPanel.tsx:721` 附近）每行加「重命名」→ 行内 input，回车提交 `api.updateSession(id, { title })`
- 列表顶部加搜索框，**纯前端过滤**（`listSessions` 已返回全量，无需新接口）

- [x] `AgentPanel.tsx`：行内重命名（回车提交 / Esc 取消 / 失焦提交）+ 搜索框（`filteredSessions` 原本是 `= sessions` 的占位，现已实现）
- [x] `store.ts`：`renameAgentSession(id, title)`——同步更新 `sessions` 列表行与 `agentSessionMeta`，不必等下一次 refresh
- [x] `i18n.ts`（`searchSessions` / `rename` / `renameHint` / `renameEmpty`）、`app.css`（`.sessions-search`、`.s-rename`）
- [x] e2e：搜索命中 / 过滤到空 / 清空恢复；重命名后接口与**整页刷新**都仍在（探针 `.tools/probes/p4p5-ui.mjs`，28 项全绿）

实施补充：

- 重命名时会话行内直接变成输入框，不弹模态；空标题不落库并给出提示。
- 一个容易踩的交互耦合：**搜索框有内容时重命名，改完这一行会因为不再匹配关键字而立刻从列表消失**，看起来像「改名失败」。e2e 因此先清空搜索再断言新标题。这是过滤器的正确行为，不是 bug，但验证脚本必须知道。
- 探针必须先把目标会话改成唯一标题再定位：开发库里存在多个同名会话（都是历史探针留下的），`first()` 会命中别的会话，断言就变成抽奖。

---

## 8. 交付顺序与依赖

```
P5（0.5d，白送） ─┐
P4（1d，白送）  ──┼─→ P3（3d，含缺陷修复 + 2 工具 + 契约同步）
                  │
P1（4d，核心）  ──┴─→ P2（2d，推荐引擎依赖 P1 的启用表范围）
```

建议节奏：**先 P5 + P4**（立刻可见、零风险、建立信心）→ **P1**（准确率地基）→ **P2**（体验差距最直观）→ **P3**（工作量最大，含契约变更）。

若只能做一件：**P1**。它是 SQLBot 全部准确率的来源，也是唯一无法靠模型升级自动补齐的部分。

---

## 9. 验证方案

沿用 [`docs/06-delivery-and-verification.md`](./06-delivery-and-verification.md) 的既有闸门：

| 层 | 命令 | 新增断言 |
|---|---|---|
| core 单测 | `npm test -w @aidb/core` | `bundleAgentContext` 聚合；prompt 快照（有 / 无 bundle）；`suggestQuestions` 各模板；`forecast` 线性 / 移动平均 / 样本不足；`stats` 统计量；`MEMORY_KINDS` 完整性 |
| gateway 集成 | `npm test -w @aidb/gateway` | `agent_context` CRUD 与 upsert 幂等；`/agent/suggest` 返回结构；`analyze_chart` / `forecast_chart` 在 SQLite demo 上的端到端 |
| 类型检查 | `npm run typecheck`（4 workspace） | 无 `any` 泄漏 |
| 构建 | `npm run build` | — |
| 文档契约 | `node scripts/verify-docs.mjs` | 工具数 22 → 24；新章节存在；内部链接有效 |
| 浏览器 e2e | `npm run e2e`（**重定向到文件后 `echo $?`**，勿用 `| tail`，会吞掉退出码） | 上下文面板增删改；推荐气泡点击填入；图表三 tab；PNG 导出；执行详情抽屉；会话重命名 |
| 人工 | 真实 MySQL `media` 库 | **只读验证**：配置别名 / 描述 / 关系后问数，对比配置前后的 SQL 正确性；**不在生产库做任何写操作** |

准确率对照实验（P1 验收标准）：在 `media` 库上准备 10 个业务问题（含术语、跨表、枚举释义），分别在「无上下文」与「有上下文」两种配置下运行，记录：SQL 可执行率、表选择正确率、是否需要人工纠正。目标：可执行率与表选择正确率均提升，且**无上下文时结果与改动前完全一致**（回归零差异）。

### 9.1 对照实验怎么跑（`scripts/accuracy-bench.mjs`）

```bash
npm run bench -- --connection demo \
  --questions scripts/bench/questions.demo.json \
  --context  scripts/bench/context.demo.json          # 省略 --context 就只跑 A 组
```

- **安全**：每个回合固定 `permissionMode=readonly`，写与 DDL 会被 Agent 策略直接拒绝；脚本只读目标库，跑完自动 `DELETE /agent/context` 并删除实验期间写入的术语/示例记忆，不残留（需要保留加 `--keep`）。
- **题目文件**：`[{ "q": "上个月的成交额是多少", "expectTables": ["orders"], "allowExtraTables": true }]`。`expectTables` 缺省则该题不判表选择；`allowExtraTables` 用于「多 JOIN 一张表也算对」的题。
- **上下文文件**：`{ tables: {表: {alias, description, enabled}}, columns: {"表.列": {alias, description}}, relations: [{table, column, refTable, refColumn, description}], glossary: [{title, content}], sqlExamples: [{title, content}] }`，与 P1 面板里能填的东西一一对应。
- **指标口径**：`SQL 可执行率` 分「首次」与「最终」：首次要求本轮所有 SQL 一次通过；最终只看最后一条 SQL 是否成功，用于衡量自动修复。`答上率（严格）` 要求无任何工具失败；`答上率（含修复）` 允许 SQL 失败后被修复。`表选择（严格）` 对多余表计错，`表命中` 只要求期望表都出现。
- `--fail-on-regression` 让 B 组劣于 A 组时退出码为 1（默认只报告不判定，因为单次运行受模型随机性影响）。

demo 库上的一次实测（6 题、每题独立会话）：A 组 2 题「一条 SQL 都没产出」（`成交额`、`客单价` 这类**术语题**，schema 里没有任何列名对得上），B 组降到 1 题；表选择正确率 67% → 83%。同时观察到 B 组有一题反而没产出 SQL——**单次运行有模型随机性**，所以这个脚本是取证工具，不是 CI 闸门；正式验收要多跑几轮取多数，并且必须换成 `media` 库上的真实业务措辞。

### 9.2 真实 `media` 库的只读基线（2026-10-27 实测）

`media` 有 21 张 `m_` 前缀表，**表与列的注释全部为空**——正是 P1 要解决的场景。用 `scripts/bench/questions.media.baseline.json`（6 题，只读，`permissionMode=readonly`，跑完不残留任何配置）测 A 组：

| 指标 | 结果 |
|---|---|
| 答上率 | 6/6 = 100% |
| SQL 可执行率 | 5/5 = 100%（第 6 题走 inspect/sample，没跑 SQL） |
| 表选择正确率 | 5/5 = 100% |
| tokens | 116,616 |

**关键结论：凡是能从表名/列名推出来的问题，现在的 Agent 已经答得很好**——`库里有多少首音频` 答 11,154，`每个作者多少张专辑` 正确 JOIN `m_audio_album.author_id → m_audio_author.id`，还会主动区分「表结构里的行数是采样估算，实际以 COUNT(*) 为准」。所以 P1 的收益**不可能**在这类问题上体现，用这种题做验收会得出「提升为 0」的假结论。

两个暴露真实缺口的观察：

1. `书架里被收藏次数最多的是哪本书`：Agent 跑了 2 条 SQL 后自己推翻结论——「这个结论不成立，因为书架里总共就只有 1 行」。数据本身不足以回答，但 Agent 无从知道业务上「收藏」到底指 `m_book_shelf` 还是 `m_book_mark`。**这类同义表/同义列的歧义只有业务上下文能消除。**
2. `m_sex 这张表是存什么的`：表名与列（`height`/`size`/`sort`/`type`/`path`/`pinyin_name`）完全对不上。Agent 没有照名字瞎猜，而是查了数据后判断「表名有误导性，实际是媒体素材表」，并**推测**是成人内容素材库。inspect-first 的行为是对的，但那句推测正是缺少权威描述时的补白——配一条 `m_sex` 的表描述就能把猜测换成事实。

因此正式验收的 10 题必须包含：业务术语（库名/列名里没有的说法）、同义表歧义（收藏 = shelf 还是 mark）、枚举释义（`type` / `source_type` / `role_enum` 各取值含义）、以及跨库口径（30 个库里哪几个才是「媒体库」）。**这些只能由业务方给出，无法从 schema 反推**——这也是本节至今无法自行完成的原因。

### 9.3 真实业务库的 10 题草稿（2026-10-29）

已在 `ziyou_mall_center`（116 表、13 万订单）上确认了一份 10 题题集，覆盖术语、枚举与同义列：

- `scripts/bench/questions.ziyou-mall.json` — 10 题，含 `t_order` / `t_order_item` /
  `t_order_refund` / `t_business_condition` / `t_extension_statistics` / `t_mall_config`
- `scripts/bench/context.ziyou-mall.json` — B 组用的表/列别名、关系、术语与 SQL 示例

```bash
# A 组基线（只读；--database 指向真实业务库）
npm run bench -- --connection local3306 --database ziyou_mall_center \
  --questions scripts/bench/questions.ziyou-mall.json

# A/B 对照
npm run bench -- --connection local3306 --database ziyou_mall_center \
  --questions scripts/bench/questions.ziyou-mall.json \
  --context  scripts/bench/context.ziyou-mall.json

# 不调用模型，只核对题集/上下文里的表、列、关系是否存在于真实 schema
npm run bench -- --connection local3306 --database ziyou_mall_center \
  --questions scripts/bench/questions.ziyou-mall.json \
  --context  scripts/bench/context.ziyou-mall.json --validate-only
```

2026-10-29 校验结果：`schema=116 表；题集引用=5 表；上下文=6 表 / 13 列 / 2 关系`，
`VALIDATE OK`。

业务口径已确认：GMV = `t_order.money` 且 `status='COMPLETE'`；退款率 = 退款单数 /
已完成订单数；商户累计成交额按订单实付金额聚合（允许 JOIN `t_shop` 取商户名，也允许
只在明细里 JOIN `t_order` 过滤已完成订单）。`notes` 里保留了每道题的设计意图（术语、
枚举、同义列），便于以后替换措辞时保持区分度。

> 2026-10-29 试跑记录：`--database` 已能正确绑定到会话（此前会话固定落在连接默认库
> `media`，已修复）。题集确认后连续三次重试仍收到
> `PROVIDER_HTTP 502 · The request queue is full`，无法得到可信的 A/B 数字；bench 已加入
> 对 `PROVIDER_HTTP/5xx` 的自动重试与错误记录。单题手工验证已确认只读工具链正常
> （`run_sql` / `inspect_schema` 均落在 `ziyou_mall_center`）。

### 9.4 A/B 实测结果（2026-10-29，qwen3.8-flash-next-iq3_s）

原配置 `agnes` 持续 502/504，切换到本地代理上的 `qwen3.8-flash-next-iq3_s` 后完整跑完
10 题 × 2 组，**全程 0 个 provider 错误**，每题独立会话、`permissionMode=readonly`。

| 指标 | A 无上下文 | B 有上下文 | 变化 |
|---|---:|---:|---|
| 题目数 | 10 | 10 | — |
| 答上率 | 50% | **70%** | +20pp |
| SQL 可执行率 | 50% | **70%** | +20pp |
| 表选择正确率（严格：多选表记错） | 70% | **80%** | +10pp |
| 需人工纠正 | 6 | **4** | −2 |
| tokens 合计 | 1,671,059 | **1,257,491** | −25% |

逐题变化：

- 修复：Q1「各支付渠道 GMV」从 `t_trade_pay_flow` 改到 `t_order` 且 SQL 全通过；
  Q3 客单价、Q4 畅销商品、Q10 配送配置从「未答上」变为「答上」。
- 稳定正确：Q7 推广金额、Q8 已取消占比、Q9 活跃买家。
- **回退 1 题**：Q2「完成支付订单数」B 组仍选 `t_trade_pay_flow`，且 SQL 报错，
  上下文没有消除「支付流水 vs 订单」的混淆。
- 仍失败：Q5 退款率两组都因 SQL 报错未答上（B 组是真实 MySQL
  `ER_CANT_AGGREGATE_2COLLATIONS`，来自模型拼出的跨字符集比较）。
- Q10 按严格口径两组都因引用多张配送表记「表✗」，但 B 组 SQL 全通过且给出了分层答案；
  若放宽 `allowExtraTables`，B 的表选择正确率会更高。

**结论与边界**：在这套真实业务问法上，配置业务上下文后答上率、SQL 可执行率、表选择
正确率均有提升，且 token 消耗更低；Q2 是明确的回退项，Q5 暴露了模型生成跨字符集 SQL
的真实问题。单次运行仍有模型随机性，且本次模型是 `qwen3.8-flash-next-iq3_s`，不能直接
外推到 `agnes` 或其他模型；正式验收应固定模型后跑 3 轮取多数。

原始输出：`.tools/probes/bench-ab.log`（本地取证文件，不纳入仓库）。

### 9.5 SQL 自动修复的效果（2026-10-29）

按第 1 项优化实现了 SQL 失败自动修复（见 [Agent 设计 §3.1](./04-ai-agent-design.md)）：
`run_sql` 报错后，把错误码 + 失败 SQL 涉及表的真实列定义回灌给模型，最多自动修复 2 次。
错误文本里能解析出缺失列/表时，还会附加编辑距离 + 公共前缀匹配出的 `suggestions`
（如 `created_timestamp (t_order)`）。
同一模型、同一题集，对照 §9.4（无修复）与本次（有修复）：

| 指标 | A 无上下文（无修复 → 修复） | B 有上下文（无修复 → 修复） |
|---|---|---|
| SQL 首次可执行率 | 50% → 40%（单轮波动） | 70% → **100%** |
| SQL 最终可执行率 | 50% → **90%** | 70% → **100%** |
| 答上率（含修复） | 50% → **90%** | 70% → **100%** |
| 自动修复成功题数 | — → **5** | — → **0** |
| 表命中（忽略多余表） | 80% → **100%** | 90% → **100%** |
| 表选择（严格） | 70% → 60% | 80% → 80% |
| tokens | 1.67M → 1.96M | 1.26M → 1.42M |

结论：

- 修复对“猜列名/猜表”的场景收益最大：A 组 5 道题靠第二次 SQL 救回，最终可执行率
  40% → 90%；B 组上下文足够，首次 SQL 就 100%，修复只作为兜底（0 次触发）。
- 代价是 tokens 增加约 13%–17%（失败重试），但“需人工纠正”显著下降。
- 严格选表率仍会被“多 JOIN 一张表”扣分（A 的 q1/q2 多带 `t_trade_pay_flow`、q10 多带
  配送相关表），因此应同时看“表命中（忽略多余表）”；本次两组均为 100%。
- 单轮运行仍有随机性，严格答上率 A 从 50% 降到 40% 属于波动；稳定指标是“最终可执行率/
  含修复答上率”。建议后续固定模型跑 3 轮取多数。

原始输出：`.tools/probes/bench-ab-repair3.log`（本地取证文件，不纳入仓库）。

### 9.6 按问题检索候选表（2026-10-29）

实现见 [Agent 设计 §3.2](./04-ai-agent-design.md)：按问题 + 业务别名/术语/SQL 示例选出
候选表，补一跳关系/外键，只给候选表列明细，其余表压缩为表名。为避免回归，**默认只在
schema > 150 表或 > 2,500 列时启用**；`ziyou_mall_center`（116 表 / 1,725 列）仍走整库
明细，`nextcloud`（235 表）启用。

Schema 部分 prompt 体积（`estimateTokens`）：

| 库 / 问题 | 整库 | 候选表 | 变化 |
|---|---:|---:|---:|
| ziyou（强制开启，10 题平均） | 6,036 | 4,707 | −22% |
| nextcloud · 文件缓存 | 2,605 | 1,944 | −25% |
| nextcloud · 新闻未读 | 2,605 | 1,875 | −28% |
| nextcloud · 邮件账户 | 2,605 | 2,624 | −1% |

235 表库上的人工只读验证（2 题）：每題首条 SQL 即成功，分别命中 `oc_filecache` /
`oc_news_items`，0 错误。

为什么用阈值而不是全量开启：在 116 表题库上强制开启时，A 组「含修复答上率」从 90% 提升到
100%，但 B 组单次从 100% 降到 80%（Q7/Q10 出现额外 SQL 错误，修复后仍有 1 题失败）。
单次样本不足以判定回归，因此先只在真正的大 schema 启用；后续固定模型跑 3 轮再决定是否
下放到 100 表级。

强制开关：设置 → Agent → 「大 schema 候选表检索」（`agent.schemaFocus = auto/on/off`）。
评测脚本支持 `--focus on|off`（自动恢复原设置）、`--arms b`（只跑 B 组）、
`--out result.json`（保存逐题结果，便于 3 轮聚合）。

原始输出：`.tools/probes/bench-focus.log`、`.tools/probes/focus-size-nextcloud.mjs`（本地取证，不纳入仓库）。

### 9.7 反例上下文（2026-10-29）

在 `context.ziyou-mall.json` 增加 4 条反例（订单数不要用支付流水、退款率不要只看
`refund_flag`、推广金额先确认 `shop_*`/`user_*` 口径、配送配置不要用 `t_product` 猜）。
Prompt 会把它们渲染为独立的 `Anti-patterns (hard constraints)` 段。

两题定向验证（q2 完成支付订单数 / q10 配送配置）：

| 指标 | A 无上下文 | B 有反例 |
|---|---:|---:|
| 答上率（严格） | 50% | **100%** |
| SQL 首次/最终可执行率 | 50% / 100% | **100% / 100%** |
| 表命中（忽略多余） | 100% | 100% |

- q10 修复明显：B 不再用 `t_product` 猜配送方式，改为 `t_mall_config` +
  `t_mall_delivery_*` / `t_freight_fee_*`。
- q2 仍额外 JOIN 了 `t_trade_pay_flow`（答案仍以 `t_order` 为准），说明反例是
  **prompt 级约束、不是强制执行**；要硬隔离应在上下文里禁用 `t_trade_pay_flow`。

禁用表的执行层硬隔离已验证：禁用 `t_trade_pay_flow` 后再问订单数，第一条引用它的 SQL
返回 `TABLE_DISABLED`（未到达数据库），Agent 明确回复“该表已被业务上下文禁用，我改用
`t_order` 单表口径”并完成回答，0 provider error。实现见
`disabledTableInSql`（词边界匹配，覆盖逗号 JOIN 与 `db.table`）与 AgentHost 执行前拦截。

对象级工具同样生效：禁用后 `inspect_schema {tables:[t_trade_pay_flow]}` 返回
`TABLE_DISABLED`；`search_objects` 的结果会过滤掉禁用表（实测搜索 `trade pay` 返回 0 条，
而搜索 `pay` / `trade` 仍返回其它可用表）；`sample_rows` 等按 `table` 参数在单测中覆盖。

旁路测试（2026-10-29，实库）：

| 路径 | 结果 |
|---|---|
| `SELECT ... FROM information_schema.TABLES` | `METADATA_BLOCKED`，未执行 |
| `SHOW TABLES` / `SHOW DATABASES` | `METADATA_BLOCKED` |
| `explain_sql` / `render_chart` 等带 sql 参数的工具 | 与 `run_sql` 同一套禁用表检查 |
| `schema_diff` / `transfer_data` 不传 `tables` | `TABLE_SCOPE_REQUIRED`，禁止整库扫描 |
| `recon_data` 嵌套 `left.table` | `TABLE_DISABLED` |
| `audit_database` | 入口跳过禁用表：116 表库禁用 1 张后 `tablesChecked=115`，payload 无禁用表名 |
| 聚合结果 | 递归脱敏，findings 中带禁用表标识的对象被移除 |

原始输出：`.tools/probes/bench-anti.log`、`disabled-tools.test.ts`（本地取证/单测）。

### 9.8 3 轮固定模型对照：候选表检索是否下放到 100 表级

固定模型 `qwen3.8-flash-next-iq3_s`，B 组（已配置业务上下文）各跑 3 轮、每轮 10 题，
只切换 `schemaFocus`，其余不变；按轮均值比较：

| 指标 | focus=off（整库） | focus=on（候选表） |
|---|---:|---:|
| 答上率（含修复） | **100.0%** | 93.3% |
| SQL 首次可执行率 | 75.9% | **86.7%** |
| SQL 最终可执行率 | 100.0% | 100.0% |
| 表选择（严格） | 70.0% | **80.0%** |
| 表命中（忽略多余） | 96.7% | **100.0%** |
| 自动修复成功（均值） | 2.3 | **1.3** |
| tokens（均值） | 1,598,419 | **1,377,126（−14%）** |

逐题多数（3 轮）：focus=on 在 Q2（订单数）严格选表 2/3 vs 1/3、Q3 客单价命中 3/3 vs 2/3
更好；Q7 推广员金额只有 1/3 resolved（off 为 3/3），两次因复杂 CTE 末次 SQL 仍报错。
其余 8 题两组一致。

**决策：保持 >150 表阈值，暂不下放到 100 表级。** 预定义判据是“resolved / final SQL /
表命中均不劣于 off 5pp”，focus=on 的 resolved 低 6.7pp，未通过；尽管其首次 SQL、严格选表、
表命中与 tokens 都更好。下一步应先把 Q7 的推广口径做成 SQL 示例/反例，再重跑 3 轮；通过后
再把阈值改为 >100。

原始数据：`.tools/probes/decision.json`、`round-{off,on}-{1..3}.json`（本地取证，不纳入仓库）。

---

## 10. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| prompt 体积膨胀（别名 + 描述 + 示例 SQL） | token 成本上升、超上下文 | 表管理面板实时显示 `estimateTokens` 预估；示例 SQL 限 top 3、每条截断 600 字符；术语限 top 20；沿用 `compactHistory` 预算 |
| 用户禁用了必要的表 → 模型答不出 | 体验下降 | prompt 明确「若需要的表被禁用要说明而非瞎猜」；禁用表在 UI 里灰显可一键恢复；输出 `N tables disabled` 提示行 |
| 新 MemoryKind 影响既有召回 | 老记忆排序变化 | 配额独立（glossary / sql_example 不挤占原 6 条）；原有五类打分公式不变；单测锁定旧行为快照 |
| 契约脚本与工具表不同步 | CI 红 | §5.5 列为强制三处同改；实现时先改脚本再改代码，让红灯指路 |
| 预测被误读为承诺 | 用户信任受损 | 输出必须带 `note` 说明方法与「粗略区间」；样本 < 4 直接拒绝；UI 用虚线 + 半透明带区分实际与预测 |
| SQLite demo 与 MySQL 行为差异 | 验证不充分 | 建表 / 删表类测试只在 SQLite demo 上跑；MySQL `media` 库仅只读预览 |

回退：P1 全部数据落在新表 `agent_context` 与新 memory kind 中，**删除该表 + 回滚 prompt 改动即完全恢复原行为**，不影响任何既有数据。

---

## 11. 假设与未验证项

| # | 项 | 状态 |
|---|---|---|
| 1 | `agent_context` 用 `CREATE TABLE IF NOT EXISTS` 即可对既有库生效 | ✅ 已核验（`store.ts:222 migrate()` 两条分支都 exec `SCHEMA_SQL`） |
| 2 | `memories.kind` 无 CHECK 约束，新增 kind 不需迁移 | ✅ 已核验（`store.ts:66`） |
| 3 | 会话重命名服务端已通 | ✅ 已核验（`routes.ts:690`、`store.ts:555`、`api.ts:224`） |
| 4 | 执行详情所需数据已下发到前端 | ✅ 已核验（`SessionDetail.toolRuns` + `messages.blocks`）；`tool_runs.message_id` 恒 NULL 亦已确认 |
| 5 | `compressSchema` / `buildSystemPrompt` 各只有一个调用者 | ✅ 已核验（全仓 grep） |
| 6 | `<followups>` 标签能被 Anthropic / OpenAI / 本地三种 provider 稳定产出 | ✅ **问题已消除**（§12.6-1）：P2 改为 Bridge 侧确定性生成（`agentHost.ts:349`），不再依赖模型守格式，容错解析分支一并删除 |
| 7 | PNG 导出栅格化路径 | ✅ **两种形态均已实测**（浏览器：§12.4 探针 3；Electron：§12.6-2，1572×728 / 76,419 字节 / `state=completed`）。Electron 侧测出真实缺陷——主进程没挂 `will-download`，5 条导出路径全都弹无类型过滤器的原生另存为，已修复并纳入 `npm run e2e`。两个必踩陷阱（`btoa` 需 utf8 安全包装、需先铺底色）已写入 §5.2 |
| 8 | 各方言下 `buildMonthlySeriesExpr` 全覆盖 | ✅ **已实测**（§12.6-3）：v0.4 扩到 41 个引擎（含 MongoDB/Redis/Cassandra/ScyllaDB、Neo4j/Memgraph/FalkorDB/ArangoDB、达梦 DM8、DuckDB、TDengine/InfluxDB、Qdrant/Milvus/Weaviate、Elasticsearch/OpenSearch 与 15 个协议别名），`ddl.test` 改为按 7 个 SQL 方言断言；别名自动复用方言，非 SQL 引擎不参与月度聚合 |
| 9 | 准确率对照实验的 10 个问题集 | ✅ 已确认 10 题（`scripts/bench/questions.ziyou-mall.json` + 上下文），2026-10-29 在 `ziyou_mall_center` 完成 A/B：答上率 50%→70%、SQL 可执行率 50%→70%、表选择 70%→80%，详见 §9.3/§9.4 |
| 10 | 表管理面板在 30+ 库 / 单库 100+ 表时的渲染性能 | ✅ **已在用户真实 MySQL 上实测**（§12.6-4，只读）：最大库 235 表 / 705 控件，库加载+渲染 33ms、6 次筛选按键 88ms、整表滚动往返 33ms → 虚拟滚动与分页都不做 |
| 11 | 预测算法数值正确性 | ✅ **已实测通过**（§12.4 探针 2：17/17 断言）。过程中发现并修掉一个真实缺陷——`Number(null) === 0` 会把 SQL NULL 变成 0 数据点污染拟合，已固化为 §5.4 规则 1 与单测项 |
| 12 | `agent_context` 新表对既有库的升级安全性 | ✅ **已实测通过**（§12.4 探针 1：v3 库走 else 分支，13 → 14 张表，旧 snippets 行完好，CHECK 约束生效） |

---

## 12. 可行性核验（二次验证）

本节记录方案落笔后对仓库现状的独立复核，方法与 [`docs/07-verification-report.md`](./07-verification-report.md) 一致：**每条结论都要有代码证据，不靠记忆**。

### 12.1 已核验的关键前提

| # | 前提 | 证据 | 结论 |
|---|---|---|---|
| 1 | 新增表无需迁移框架 | `store.ts:222-244 migrate()`：`version<2` 走重建，否则直接 `exec(SCHEMA_SQL)`；两分支均含 `CREATE TABLE IF NOT EXISTS`；末尾固定 `user_version = 3` | ✅ 加 `agent_context` 安全 |
| 2 | **不能给现有表加列** | `migrate()` 无任何 `ALTER TABLE … ADD COLUMN` 分支 | ✅ 方案已规避：所有新字段落新表 |
| 3 | `memories.kind` 可扩枚举 | `store.ts:66` 定义 `kind TEXT NOT NULL`，无 CHECK；`MemoryKind` 消费点仅 `types.ts:142`、`memory.ts:131`、`MemoryDrawer.tsx:81`，无穷举 switch | ✅ 加 `glossary` / `sql_example` 零迁移 |
| 4 | prompt 注入改动面 | `compressSchema` 唯一调用者 = `buildSystemPrompt`（`prompt.ts:95`）；`buildSystemPrompt` 唯一调用者 = `agentHost.ts:209` | ✅ 2 文件即可贯通 |
| 5 | 记忆召回已有 kind 过滤通道 | `api.ts:230 memories({q, kind, includeArchived})`；`store.ts:810 searchMemories` → `rankMemories`（`memory.ts:54`，TF-IDF + scope + importance + recency + pinned） | ✅ 术语 / 示例 SQL 直接搭车 |
| 6 | 图表明细数据已存在却被丢弃 | `executor.ts:806-811` 返回 `{chart, columns, rows, chartSql}`；`AgentPanel.tsx:122` 条件 `!chart && data?.columns && data?.rows` | ✅ P3.1 是纯前端修复 |
| 7 | PNG 导出有先例 | `RelationsView.tsx:33 exportSvg()` 已做 SVG 序列化 + 下载 | ✅ 可照搬（栅格化待验，见 §11.7） |
| 8 | 会话重命名全链路已通 | `routes.ts:690 PATCH` 接受 `title`；`store.ts:550 updateSession` 字段映射含 `title`；`api.ts:224 updateSession` | ✅ P5 仅缺 UI |
| 9 | 执行详情数据已下发 | `SessionDetail.toolRuns`（`api.ts:94`）；`store.ts:640 listToolRuns`；`agentHost.ts:170-181` 已把 tool_call / tool_result 写入 `messages.blocks`；`AgentMessageBlock`（`types.ts:243`）含 args / risk / result / status | ✅ P4 零后端 |
| 10 | `tool_runs.message_id` 恒 NULL | `store.ts:621 addToolRun` 支持 `messageId?`，但 `agentHost.ts:182` 调用未传 | ✅ 已写入 §6 限制，取方案 A |
| 11 | 时间桶表达式已存在 | `ddl.ts:440 buildMonthlySeriesExpr(engine, column)`；`local.ts:700` 已在离线趋势中使用 | ✅ P2 trend 模板与 P3 预测可复用 |
| 12 | 工具契约是硬编码的 | `verify-docs.mjs:54 expectedTools`（22 项）、`:56 names.length === 22`、`:53` 表格行正则、`:88` 按 `name: 'x'` 匹配 `tools.ts` | ⚠️ 新增工具必须四处同步，已写入 §5.5 |
| 13 | 硬编码斜杠命令确实引用不存在的表 | `AgentPanel.tsx:42-53`：`/chart` = 「按 status 统计 orders 并画柱状图」，`/quality` = 「检查 orders 的空值…」 | ✅ P2.3 修复有据 |
| 14 | i18n 需双语同步 | `i18n.ts` 中 zh 块（`:55` 起）与 en 块（`:262` 起）并列 | ✅ 所有新字符串两处都加 |

### 12.2 复核中发现的既有小缺陷（顺带修）

1. `MemoryDrawer.tsx:81` 的 kind 下拉硬编码 4 项，**漏了 `episodic`** → P1 改用 `MEMORY_KINDS` 常量时一并修复
2. `tool_runs.message_id` 恒 NULL，导致该列目前是死数据 → 记入 §6 方案 B
3. 斜杠命令写死 `orders` 表 → P2.3

### 12.3 复核结论

方案的 5 个工作包中，**P4 / P5 已被证实为纯前端工作**（后端与接口层已完备），**P3.1 是纯前端缺陷修复**，P1 / P2 的新增面全部落在「新表 + 新纯函数 + 新路由」上，不触碰任何既有数据与既有工具签名。

复核中修正了初稿的 2 处行号偏差（`store.updateSession` 实为 `:550` 而非 `:555`），并补充了 1 处设计约束：`QueryView` 已有图表类型 / X / Y 下拉，共享 `ChartToolbar` 必须吸收它而非另起一套（见 §5.2）。

### 12.4 可执行探针（不靠推断，实跑取证）

三个最高风险的技术前提各写了一个一次性探针脚本实跑验证，脚本置于临时目录、**不入库**，结论如下：

**探针 1 — 新表迁移安全性（P1 的地基）**

在临时目录造一个 `user_version = 3` 且已有数据的库，按 `store.ts:222-244` 的分支逻辑用「`SCHEMA_SQL` + `agent_context`」重新打开：

| 观测项 | 结果 |
|---|---|
| migrate 读到的版本 | 3 |
| 是否走重建分支 | 否（走 `else` 直接 exec） |
| 表数量 | 13 → 14 |
| `agent_context` 创建 | ✅ |
| 旧 `snippets` 行完好 | ✅（`name`/`sql` 均未变） |
| 插入与读取（含中文别名、`enabled` 默认值） | ✅ |
| `kind` CHECK 约束拦截非法值 | ✅ |

结论：§12.1 前提 1、2 成立，P1 无需迁移框架、无需 bump `user_version`。

**探针 2 — 预测算法数值正确性（P3.4）**

按 §5.4 规格实现原型，用可手算对照的用例 + 退化输入跑 17 条断言，**全部通过**：

| 用例 | 期望 | 实测 |
|---|---|---|
| `y = 2t + 1`（1,3,5,7） | slope 2、r 1、外推 9/11/13、σ=0 区间收敛 | ✅ 完全一致 |
| 全同值（5,5,5,5,5） | 不产 NaN、auto 落 moving_average、预测 5 | ✅ |
| 无规律噪声 | `|r|<0.6` → moving_average | ✅ r=0.2825 |
| 样本 3 点 | 拒绝 + `NOT_ENOUGH_SAMPLES` | ✅ |
| 下降序列（100→20） | slope −20、外推 0/−20 | ✅，且触发负值告警 |
| 原始序列保留 | 4 点原样返回 | ✅ |

**过程中发现一个真实缺陷**：初版过滤器用 `Number.isFinite(Number(v))`，而 `Number(null) === 0`，导致 `[2,null,'4',6,'x']` 里的 NULL 被当成 0 参与拟合（输出 n=4、slope 1.6，看似正常实则错误）。修正为「先剔 nullish 再转数字」后该用例正确降级为 n=3 并拒绝。此陷阱已固化为 §5.4 规则 1 与 §5.6 单测项——**这类缺陷在纸面设计阶段不可能发现，只有实跑才会暴露。**

**探针 3 — SVG → PNG 栅格化（P3.2）**

仓库现有先例只导出 SVG **文本**（`RelationsView.tsx:33`），栅格化路径无先例。用 `playwright-core` + headless Chrome 实跑 ChartView 同构的 SVG（含 `linearGradient`、`<title>` tooltip、中文文本节点）：

| 观测项 | 结果 |
|---|---|
| SVG 原始尺寸 | 380 × 176 |
| 2x canvas | 760 × 352 |
| 输出 blob | 13,671 字节，`image/png` |
| PNG 魔数 | `137,80,78,71,13,10,26,10` ✅ |
| 中文标签 | 存活 |
| headless 下 anchor 下载 | ✅ 无页面报错 |

同时踩到并记录两个必踩陷阱：`btoa(svg)` 遇中文直接抛异常，必须 `btoa(unescape(encodeURIComponent(svg)))`；SVG 无背景会导致透明 PNG，`drawImage` 前须先 `fillRect` 底色。两条已写入 §5.2。

**首轮探针自身也有 bug**：第一次运行 `page.evaluate` 忘了传参，base64 长度只有 12（`"undefined"` 的编码），图片加载失败。这反过来说明探针必须有硬断言（魔数、字节数、尺寸），只看「没报错」会漏判。

### 12.5 基线闸门（改动前后均须绿）

本次只新增文档、并在 `scripts/verify-docs.mjs` 的 `required` 列表加入本文档（使其内部链接纳入契约校验），未改任何产品代码。实测：

| 闸门 | 命令 | 结果 |
|---|---|---|
| 文档契约 | `node scripts/verify-docs.mjs` | **143/143 全绿**（原 136，新增 1 项存在性 + 6 项链接校验） |
| 类型检查 | `npm run typecheck`（4 workspace） | exit 0 |
| core 单测 | `npm test -w @aidb/core` | **49/49**，exit 0 |
| gateway 集成 | `npm test -w @aidb/gateway` | **10/10**，exit 0 |

> 注意：工具数量契约仍是 **22**。P3 落地时必须按 §5.5 同步四处（`tools.ts`、`docs/04` 工具表、`verify-docs.mjs` 的 `expectedTools` 与 `names.length === 22`、`executor.ts`），本次未预改，避免文档先行于实现。

**实现完成后同一组闸门（2026-10-27，`npm run verify` exit 0）**：

| 闸门 | 结果 | 相对基线 |
|---|---|---|
| 文档契约 `scripts/verify-docs.mjs` | **171/171** | +28（含 §10.1 新增的 executor 派发双向校验） |
| 类型检查（4 workspace） | exit 0 | — |
| core 单测 | **119/119** | +70（analysis / forecast / 方言 / prompt 回归） |
| gateway 集成 | **34/34** | +24（`analyze_chart`、`forecast_chart`、上下文接口） |
| 构建（core / gateway / desktop / mobile） | exit 0 | — |
| 端到端 `scripts/e2e.mjs` | **64/64** | 含 Electron 桌面形态导出真 PNG（§12.6-2） |

工具数量契约已按 §5.5 同步为 **24**（新增 `analyze_chart`、`forecast_chart`），四处一致，`verify-docs.mjs` 会同时校验声明与 executor 派发。

### 12.6 剩余未验证项（实现期实测结论）

原计划列出 4 项**无法在纸面或探针中证实、实现时必须实测、不得假设通过**的风险。逐项实测的结论：1 项因设计变更而消失，1 项测出真实缺陷并已修复，2 项通过（其中 1 项的计划描述本身写错了）。

#### 1. `<followups>` 标签的 provider 遵循度 → 问题被消除，而不是被测过

P2 落地时把「让模型输出 `<followups>` 标签、Bridge 再容错解析」换成 Bridge 侧确定性生成：`apps/gateway/src/agentHost.ts:349` 的 `followUps()` 依据本轮工具调用、结果集与业务上下文直接产出建议，与 provider 无关。全仓库已无该标签字样（`grep -rn "followups>" apps packages scripts` 返回空），容错解析分支随之删除。

所以这一项的状态是**「不存在」而非「已验证」**：三种 provider 的格式遵循度无从谈起，因为格式不再由模型决定。附带收益是建议内容可复现，离线（Local Reasoner）与在线走同一条路径，也少了一处会静默失效的解析分支。

#### 2. PNG 导出在 Electron 形态 → 测出真实缺陷，已修复

浏览器形态（§12.4 探针 3）证明的只是栅格化管线；桌面形态下**下载出口完全不同**：没有浏览器下载条，`page.waitForEvent('download')` 永远不触发。实测走内嵌 Bridge + `dist`（不是 dev server），渲染进程与主进程两侧同时取证：

| 观测点 | 结果 |
|---|---|
| 渲染进程 SVG→image→canvas | `drawImage 1572x728 complete=true` |
| 渲染进程 `canvas.toBlob` | 76,419 字节 `image/png` |
| 渲染进程 anchor 下载 | `download=cnt by status.png`、`blob:` URL |
| 主进程 `will-download` | 触发，`getTotalBytes()=76419`，`state=completed` |
| 落盘文件 | PNG 魔数 `89504e47`，IHDR `1572x728` |

**缺陷**：PNG 本身没问题，问题在出口。`apps/desktop/electron/main.cjs` 原先没有注册 `will-download`，导出全部落到 Electron 默认行为——弹一个**没有文件类型过滤器**的原生「另存为」。受影响的不止图表：仓库里 5 处导出（图表 PNG、ERD SVG、审计 CSV、SQL 脚本、字典）共用同一个 anchor 下载模式，在桌面端一直是这个无过滤器弹框，此前没有任何代码对它表过态。

**修复**：`main.cjs:11-31` 增加 `EXPORT_FILTERS` 与 `registerExportDialogs()`，在 `will-download` 里按扩展名 `setSaveDialogOptions({ defaultPath, buttonLabel: '保存', filters: [对应类型, 所有文件] })`。一处主进程代码覆盖全部 5 条导出路径，渲染进程零改动，浏览器形态行为不变。

**回归**：断言已并入 `npm run e2e` 的 Electron 段（`electronPngExport()`）——从主进程侧读 `getSaveDialogOptions()` 证明过滤器生效，再用 `setSavePath` 把文件落到临时目录校验魔数与 IHDR，避免无头环境被模态框卡死。当前 **64/64 全绿**。

#### 3. `buildMonthlySeriesExpr` 的方言覆盖 → 按方言断言，别名自动复用

计划写「12 类方言」，而当时 `ENGINE_IDS` 只有 8 个引擎。v0.4 扩到 34 个引擎后，`packages/core/test/ddl.test.ts` 改为按 `DialectId` 集合（sqlite / mysql / postgres / mssql / oracle / clickhouse / dm）断言：每个 SQL 引擎解析到方言，每个方言都必须有月度表达式；新增协议别名只要映射到已有方言即可，不再需要逐个补 `MONTHLY_FN`。MongoDB/Redis/Neo4j/Memgraph/Qdrant/Milvus/Weaviate/Elasticsearch/OpenSearch 没有 SQL 方言，不参与该测试；DuckDB 复用 sqlite 方言。计划里「不支持的 engine 降级为不生成 trend 建议」的兜底在当前 7 个 SQL 方言上仍无触发对象。

#### 4. 表管理面板在真实规模下的渲染性能 → 不需要虚拟滚动

计划担心「约 30 库、单库可能 100+ 表」需要虚拟滚动或分页。直接在用户的真实 MySQL（`local3306`，30 库）上实测该实例中最大的三个库，**全程只读**：不勾选、不写业务上下文、不建任何对象，探针结束时复查 `context entries = 0`。

| 库 | 表数 | 面板控件 | 连接切换 | 库加载+渲染 | 6 次筛选按键 | 整表滚动往返 | token 徽标 |
|---|---|---|---|---|---|---|---|
| `nextcloud` | 235（1,873 列） | 705 | 13ms | 33ms | 88ms → 2 行 | 33ms | ≈1,856 |
| `ziyou_mall_center` | 116（1,725 列） | 348 | 11ms | 26ms | 122ms → 1 行 | 33ms | ≈4,000 |
| `media` | 21 | 63 | 14ms | 16ms | 97ms → 6 行 | 34ms | ≈867 |

计时口径与几个必须说清的前提：

- `库加载+渲染` 从切换库下拉开始，到顶栏徽标出现 `/N 表` 为止。**不能用「表格有行」当完成信号**——切库瞬间上一个库的行还在，会测出假的 0ms；中途也不含任何人为 sleep（第一版探针塞了 1.2s 等待，测出来三个库都是 1.25s，是探针在测自己）。
- Bridge 的内省缓存是热的（面板固定 `refresh=0`）。冷启动一次 235 表的重新内省（`refresh=1`）实测 29ms，即首次打开该库也只多几十毫秒。
- token 徽标统计的是**压缩后**真正进提示词的部分（`compressSchema` 默认只给 15 张表展开列），因此不随表数线性增长——`ziyou_mall_center` 116 表反而比 `nextcloud` 235 表高，是表名与注释长度差异，不是 bug。
- 另有同口径的合成数据一组（150 表 SQLite，`.tools/probes/p1-scale.mjs`，写路径只在临时库上跑，绝不拿用户真实库做压测）：首次渲染 62ms、450 控件、3 次按键 38ms、乐观勾选 8ms、150 表批量禁用 13ms。

**结论**：235 表 / 705 控件下所有交互都在 130ms 内，虚拟滚动与分页都不做——做了反而破坏「一屏看全库」的 Navicat 手感。这两组探针**没有**并入 `npm run e2e`：真实库那条不能进闸门（闸门不得依赖用户的 MySQL），合成那条要 dev server 加临时连接，而「是否需要虚拟滚动」是个一次性判断题，测过就该写结论，不该每轮 CI 重测。

另有 1 项依赖用户输入：**P1 验收用的 10 个业务问题集尚未准备**，需取自用户真实问法，否则准确率对照实验没有意义（详见 §9.2：schema 可推导的问题在真实 `media` 库上已是 100%/100%/100%，只有业务口径问题才能区分方案有没有效）。
