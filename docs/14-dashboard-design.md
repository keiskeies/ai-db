# 14 仪表板（Dashboard）设计

范围：桌面端「每个数据库一块板」的活查询卡片面板，含 AI 草稿生成、收藏 SQL 导入、板级时间筛选。
定位约束见 [00 产品总览](./00-product-overview.md) 与 [02 功能规格](./02-feature-spec.md)：AiDB Studio 是 Navicat 式数据库客户端，不是 BI 平台。仪表板因此不是「BI 画布」，而是**这个库的常用问题面板**。

相关文档：[03 UI/UX 设计](./03-ui-ux-design.md)、[04 AI Agent 设计](./04-ai-agent-design.md)、[05 数据与 API](./05-data-and-api.md)、[11 命令工作流](./11-command-workflows.md)。

## 1 设计契约

1. **板跟着库走**：作用域是 `connectionId + database`，与 `agent_context`、`database_briefs` 同一套 scope 约定（`scope_key = ${connectionId}/${database}`）。v1 不做跨库板、不做一库多板。
2. **卡片存 SQL，不存数据**：刷新 = 重新执行 SQL。这与报表（`artifacts` + `artifact_runs` 的快照语义）是两种东西，边界见 §8。
3. **AI 只能生成草稿**：卡片分 `pinned=0`（草稿，可整批丢弃或替换）与 `pinned=1`（用户固定，任何生成都不得覆盖）。不存在「重设仪表板 = 清空重来」。
4. **打开即见图**：先用落库的 `last_result_json` 秒渲染，再后台重跑；不阻塞首屏，也不因单卡失败拖垮整板。
5. **永不写目标库**：仪表板的元数据只进我们自己的 `~/.aidb`（`apps/gateway/src/store.ts`），生产库可能只读，也不该把客户端配置塞进用户数据。

## 2 非目标

- 自由拖拽网格与像素级布局（`package.json` 无任何 grid/dnd 依赖，布局手写；卡片只提供「加宽/前移/后移」）。
- 卡片内图表二次分析、下钻联动、跨源 JOIN。
- 移动端仪表板编辑器（移动端只读展示留待后续）。
- tab 持久化：当前所有 tab 重启即失，本特性不单独破坏这一一致性。

## 3 数据模型

表加进 `SCHEMA_SQL`，`migrate()` 里 `PRAGMA user_version` bump 一版；后续增量列用 `ensureColumn(table, column, type)`。

```sql
CREATE TABLE IF NOT EXISTS dashboard_cards (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,              -- `${connectionId}/${database ?? ''}`
  connection_id TEXT NOT NULL,
  database_name TEXT,
  title TEXT NOT NULL,
  sql TEXT NOT NULL,
  chart_type TEXT NOT NULL,             -- ChartType 七种之一
  series_x TEXT, series_y TEXT,         -- 列名提示，缺省时由 buildChartSpec 推断
  time_column TEXT,                     -- 参与板级时间筛选；NULL = 不参与
  span INTEGER NOT NULL DEFAULT 1,      -- 1 半宽 / 2 整宽
  position INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('ai','favorite','manual')),
  pinned INTEGER NOT NULL DEFAULT 0,    -- 0 草稿 / 1 用户固定
  last_result_json TEXT, last_run_at TEXT, last_status TEXT, last_error TEXT,
  schema_hash TEXT,                     -- 结构漂移提示
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dash_cards ON dashboard_cards(scope_key, position);
```

`store.ts` 方法（沿用 `listAgentContext / upsertAgentContextEntry / deleteAgentContext` 的写法，id 用 `randomUUID()`，时间用 `iso()`）：

- `listDashboardCards(scopeKey)` / `insertDashboardCard(input)` / `updateDashboardCard(id, patch)` / `deleteDashboardCard(id)`
- `setDraftCards(scopeKey, cards)`：事务内 `DELETE ... WHERE scope_key = ? AND pinned = 0` 再插入草稿 —— 「替换草稿不动固定卡」的唯一实现点。
- `clearDashboardScope(scopeKey)`：删库/删连接时级联清理。
- `last_result_json` 落库前行数截到 ≤ 200，列名一并存下，避免 App 存储膨胀。

核心类型 `DashboardCard` / `DashboardCardInput` 放 `packages/core/src/types.ts`，与 `QuestionSuggestion`、`Memory` 并列。

## 4 HTTP API

沿用 `routes.ts` 的 `ah / str / obj / num` 助手与 `server.ts` 的 `{ error: { code, message, hint? } }` 信封。

| 方法与路径 | 说明 |
|---|---|
| `GET /dashboards/cards?connectionId&database` | 列表（含上次快照，用于秒渲染） |
| `POST /dashboards/cards` | 新增或更新（改标题、换图表类型、pin、span、排序均走此） |
| `DELETE /dashboards/cards/:id` | 删除卡片 |
| `POST /dashboards/cards/reorder` | 批量写 `position` |
| `POST /dashboards/refresh` | `{connectionId, database, cardIds?, range?}` → 每卡 `{columns, rows, status, error, durationMs}` |
| `POST /dashboards/preview` | `{connectionId, database, sql}` → `{preview}`；与卡片刷新同一套只读 + 禁用表 + 200 行护栏，错误内联返回给表单 |
| `POST /dashboards/compose` | `{connectionId, database, prompt}` → `{usedModel, title, sql, chartType, x, y, timeColumn, preview, notes}`；一句需求生成单卡并试跑 |
| `POST /dashboards/generate` | `{connectionId, database, limit?}` AI 草稿，语义固定为只替换草稿 |
| `DELETE /dashboards/drafts` | 清空当前作用域草稿（`pinned = 1` 保留） |

「从收藏导入」不新增端点：前端读 `GET /history?connectionId` 过滤 `favorite`，逐条 `POST /dashboards/cards`。

## 5 执行护栏

执行统一走 `manager.query(connectionId, sql, opts)`，opts 与 `POST /query` 一致：`{ database, maxRows, timeoutMs: settings.queryTimeoutMs, autoLimit: settings.autoLimit, actor: 'user' }`。在此之上叠加仪表板专属闸门：

1. **只读**：`classifySql(sql).kind` 必须为 `read`，否则 400 `DASHBOARD_NOT_READ_ONLY`。仪表板永远不写库，因此只读连接也完全可用。
2. **表/列开关同源**：命中 `agentContextGuard.systemCatalogQuery(sql)` 或引用了 `disabledTables` 的卡拒绝执行，不另立权限模型。
3. **仅 SQL 系引擎**：以 `engineMeta(conn.engine).languages.includes('sql')` 为准；Mongo/Redis/Neo4j/ES 不提供仪表板入口（与 `api.suggest` 的 `suggestionsSupported` 判定一致）。
4. **成本上限**：单板卡片上限 12；批量刷新并发 2；仪表板 `maxRows` 上限 2000（图表不需要更多点）。失败卡保留上次快照并把 `last_error` 显示在卡脚。
5. **漂移检测**：刷新时对比当前 schema 与卡片的 `schema_hash`，不一致只提示「结构可能已变」并给「打开 SQL 修」，不自动改写 SQL。

## 6 前端结构

| 位置 | 改动 |
|---|---|
| `apps/desktop/src/store.ts` | `Tab` 联合类型加 `kind: 'dashboard'`；新增 `openDashboard(connectionId, database)`，tab id 去重为 `` dashboard:${connId}:${db} ``（照 `openRelations`） |
| `apps/desktop/src/components/Workspace.tsx` | 工厂 switch 加 `dashboard` 分支，`TabIcon` 用 `LayoutDashboard`；自动获得 `data-testid="tab-dashboard"` |
| `apps/desktop/src/components/DashboardView.tsx` | 新文件；本地 `useState` + 直调 `api.*`，与 `QueryView` 的历史面板写法一致；新建卡片表单含「一句话需求 → AI 生成并预览」、可编辑 SQL、图表/表格预览与单独预览按钮 |
| `apps/desktop/src/components/buildChartSpec.ts` | **新纯函数**：从 `QueryView` 的 `chartSpec` useMemo 抽出（数值列推断、x/y 回退、`extraSeries`、`sql: set.statement`），QueryView 与 DashboardView 共用，避免列推断出现两份实现 |
| `apps/desktop/src/components/QueryView.tsx` | 结果图表面板加「加入仪表板」：把 `chartSpec` 的 SQL / 类型 / X,Y 列原样存成固定卡片。`ChartView` 本身已具备 hover、导出、类型工具栏与 `chartSuitability` 门禁，卡片直接复用 |
| `apps/desktop/src/components/Sidebar.tsx`、`App.tsx` | 数据库节点右键「打开仪表板」、侧栏底栏 `data-testid="open-dashboard"` 图标、ribbon「仪表板」按钮 |
| `apps/desktop/src/styles/dashboard.css` | 卡片网格样式，复用已有 `.dash-empty`、`.panel`、`--*` 令牌，明暗自动 |
| `apps/desktop/src/i18n.ts` | 不新增 `t()` 键：`DashboardView` 与 `ChartView` / `QueryView` / `Sidebar` 一样直接写中文，避免出现「只翻译一半」的第二套约定 |

布局：CSS grid 12 轨，卡片 `span 1|2`，两列自适应流式。首屏空态给两个明确动作：「让 AI 生成草稿」「从收藏导入」。

卡片出图规则（`DashboardView` 的 `spec` 计算）：SQL 返回多个度量时尽量都画；但两个量纲相差 10 倍以上不能共用一根轴——只有一列附加度量时自动切成「柱 + 右轴折线」双轴，多列且无法协调时才舍弃附加列。整数度量不出现小数刻度，日期型轴标签（`2025-07`）不截断。

## 7 AI 草稿生成

**服务对象是业务/运营人员，不是 DBA。** 一块板子上该出现的是成交额、单量、转化率、退款、提现、Top N 商品/渠道/支付方式，以及它们的月度或每日走势——不是「某表按某列的行数」。这条决定了生成器的取舍。

关键判断：**不重新问模型业务含义**——`/init` 生成的 `AI_DB.md` 已含 `## 4. 指标口径与标准 SQL` 与 `## 7. 常见任务 Recipe`，里面就是带 SQL 的口径。实现见 `apps/gateway/src/features/dashboardGenerate.ts`，四段式：

1. **模型按业务写 SQL（首选）**：`createProvider(settings.agent)` + `provider.stream({ tools: [], temperature: 0.2, maxTokens: 6000 })`。prompt 只喂**排序后的核心表 + 业务列（金额 / 维度 / 时间，带字段备注）**，不是全库 DDL；要求模型自己写聚合 SQL，并硬约束：单条只读、必须聚合、时间必须按天/月分桶（禁止按原始时间戳分组）、有软删除列要在 WHERE 里过滤、金额优先 SUM 而非 COUNT、标题不得出现表名字段名、时间序列禁饼图。**模型只写 SQL，不执行任何写操作**，且必须过第 4 段闸门。
   `parseJsonArray()` 要能从被 `maxTokens` 截断的输出里回捞已完整的对象——实测模型明明写对了「每月成交金额与支付单量」，只因数组被截断就整批丢掉，会退化成模板垃圾图。
2. **brief 口径**：`briefCandidates()` 解析 `AI_DB.md` §4/§7 的 ```sql 代码块（人工确认过的口径优先于任何推断），带 `<占位符>` 或非只读的模板丢掉。
3. **确定性兜底**：`metricCandidates()` 按「钱 + 时间 + 维度」给每张事实表生成一条月度趋势（`COUNT(*) + SUM(金额)`，按方言用 `buildMonthlySeriesExpr` 分桶）和一条维度 Top 10。表排序用分层打分：交易事件表（order/refund/pay/withdraw/flow/trade/bill/settle）> 有金额+业务时间的表 > 其他；配置/模板/字典/日志/快照类表**倒扣分**，避免把 `xx_config`、资金余额快照当成业务趋势。维度列排除 `creator/updater/*_id/del_flag/version` 这类审计与技术列，备注超过 8 字退回列名，防止「按此次流水变动的类型的金额 Top 10」这种标题。收藏 SQL 也进候选池。
4. **试跑 + 信息量闸门**：`assertDashboardSql`（单语句只读）与 `disabledTablesTouched` → `manager.query({ maxRows: 200 })` 试跑 → `trialVerdict()` 判定：无数据、y 非数值、全 0、分类只有一个取值、单一取值占比 > 99%、趋势点 < 3、按原始时间戳分组（每个点都是 1）——**跑通了但画出来没意义的图一样不进板**。通过者把试跑结果当快照入库，入板即渲染，不再打第二轮查询。

**降级路径**：没有 `AI_DB.md` 时 `notes` 提示先跑 `/init`；`provider === 'local'` 或模型失败时跳过第 1 段，用第 2/3 段。冷启动不依赖用户先配好模型，质量降级但不报错，也绝不因为降级就吐垃圾图。

### 7.1 单卡需求生成（新建卡片表单）

整板生成解决「这块板该放什么」，但用户明确知道这一次想看什么时，不该被迫先手写 SQL。新建卡片表单因此提供：

1. **一句话需求**（`dashboard-card-prompt`）→ 「AI 生成并预览」（`dashboard-card-compose`）。
2. **按问题聚焦 Schema**：`focusTablesForQuestion()` 选相关表并补一跳关联，`compressSchema(..., 10)` 给列明细；同时注入该库的术语表、SQL 示例、相关记忆、`AI_DB.md` §3/§4/§5/§7（截断 4500 字）与启用/禁用状态。比整板 prompt 更窄，避免上百张表把模型带偏。
3. **模型写单条只读聚合 SQL**：输出 `{title, sql, chart_type, x, y, time_column}`；硬约束与整板一致（必须聚合、按天/月分桶、金额优先 SUM、只能引用 Schema、标题不出现表名列名）。
4. **只读闸门 + 试跑 + 一次自纠**：`assertDashboardSql` / `disabledTablesTouched` → `manager.query({ maxRows: 200 })`；失败时把错误摘要回喂模型重写一次，仍失败则保留 SQL 和真实错误让用户改，不静默吞掉。
5. **预览不是截图**：预览区用与卡片相同的 `buildCardSpec` 出图（多度量 / 双轴规则一致），不可出图时退回前 6 行表格；`preview.sql` 与当前 textarea 不一致时标「SQL 已修改，重新预览后为准」。
6. **保存**：`source = 'ai'`、`pinned = true`，把模型给出的 x/y/timeColumn 一并写入；保存后立即刷新这一张卡。
7. **离线兜底**：`provider === 'local'` 或模型失败时，只从 `AI_DB.md` 口径与「钱 + 时间 + 维度」指标模板里按关键词匹配；匹配不到返回 `MODEL_UNAVAILABLE` 并提示配置模型或手写 SQL，绝不猜一条错 SQL。
8. **单独预览**：手写/改过 SQL 后可只点「预览」，走 `POST /dashboards/preview`，与卡片刷新同一条只读执行路径，不新增写入口。

## 8 时间筛选与「报告」边界

板级时间范围（近 7/30/90 天、自定义、全部）只对 `time_column` 非空的卡生效，做法是**外层包裹**而非改写 SQL：

```sql
SELECT * FROM ( 原SQL ) dash_t WHERE dash_t.<time_column> >= ? AND dash_t.<time_column> < ?
```

生成阶段就强制 SQL 必须投影出该列，所以包裹安全；无法安全包裹（多语句、方言不支持派生表别名、Oracle <12 的 `ROWNUM` 陷阱一类）的卡直接标「不参与筛选」，绝不做正则改写。筛选值存前端 `localStorage`（`saveUiPrefs({ dashboardRangeByScope })`），因为卡片是跨重启的服务器数据，筛选只是视角。

与报告/报表的分工：`reportAgent` 产出 1280×720 分页 deck，`exportArtifact(id, 'pptx'|'xlsx')` 导出**最近一次 run 的快照**；仪表板是活查询、无快照语义。已实现「导出为报告」：`POST /dashboards/report` 把当前卡片的**结果快照**摊成 `ReportSpec.blocks`（deck 只认 bar/line/pie，其余类型按柱状出图），建一个 `report` artifact 并记一次 `succeeded` 的 run（导出器读的就是最近 run），前端再走现成的 `exportArtifact(id,'pptx')` + 原生保存对话框。仪表板负责日常观察，报告负责一次性汇报。

## 9 定时刷新（后置）

基建现成：`scheduler.ts` 的 `JobScheduler.tickArtifacts()` + `artifact_schedules` 表 + `server.ts` 里 `setArtifactRunner` 的注册方式 + `notifications.ts`。新增 `dashboard_schedules(scope_key, interval_seconds, enabled, last_run_at, last_status)`，沿用 60s 最小间隔与 `running` 去重。

**默认关闭**：后台默默跑 SQL 对生产库是风险，必须逐板显式开启，并只在只读连接或低风险 SQL 上建议开。

实现落点：`dashboard_schedules(scope_key PRIMARY KEY, interval_seconds, enabled, notify_channels, last_run_at, last_status, last_error)`；`JobScheduler.setDashboardRunner()` 与 `tickDashboards()` 与 artifact 定时同一套节流（60 秒下限 + 同板不并发），跑完把 `n/m 张卡片已刷新` 写进 `last_status/last_error` 并按 `notify_channels`（最多 4 个）逐个 `sendNotification`；UI 在板头一个「不定时刷新 / 每 5 分钟 / 每 30 分钟 / 每 2 小时 / 每天」的下拉里控制，`data-testid="dashboard-schedule"`。

## 10 分阶段落地

| 阶段 | 内容 | 门禁 | 状态 |
|---|---|---|---|
| P0 | 抽 `buildChartSpec` + `dashboard` tab 骨架 + 入口 | `npm run typecheck`；QueryView 图表行为不变 | 已完成 |
| P1 | 表 + CRUD + REST + 卡片渲染/刷新/pin/排序/空态 | gateway 集成测试 `apps/gateway/test/dashboards.test.ts` | 已完成（9 条测试） |
| P2 | AI 草稿三段式（brief 种子 + 结构化调用 + 试跑准入）+ 规则兜底 | 有 brief 出 ≥4 张可用卡；无 brief 不报错 | 已完成（demo 库无 brief 时生成 7 张可画图草稿，标题与类型由模型定） |
| P3 | 收藏导入 + 板级时间筛选 + 图表卡「加入仪表板」 | e2e 覆盖端到端 | 已完成 |
| P4 | 定时刷新 + 通知 + 导出为报告 | 可延后 | 已完成（`dashboard_schedules` + `tickDashboards` + 通知渠道 + `POST /dashboards/report` 出 PPTX） |

代码落点：`packages/core/src/types.ts`（`DashboardCard` 系列类型）、`apps/gateway/src/store.ts`（`dashboard_cards` 与 CRUD）、`apps/gateway/src/features/dashboards.ts`（只读/禁用表闸门、时间外层包裹、并发刷新）、`apps/gateway/src/features/dashboardGenerate.ts`（草稿生成）、`apps/gateway/src/routes.ts`（`/dashboards/*`）、`apps/desktop/src/components/DashboardView.tsx` 与 `buildChartSpec.ts`、`apps/desktop/src/store.ts`（`openDashboard` / `setDashboardRange`）、`apps/desktop/src/styles/dashboard.css`。

## 11 验证

- 纯函数：`buildChartSpec`、时间包裹 SQL、`setDraftCards` 只动 `pinned=0` —— `npx tsx -e` 断言。
- 集成：`apps/gateway/test/dashboards.test.ts` 覆盖非只读被拒、禁用表被拒、快照截断、reorder。
- E2E（`scripts/e2e.mjs` 的 `check()`）：`tab-dashboard` 打开、空态引导存在、生成后卡片 ≥1、`dashboard-refresh` 后 `[data-testid="chart-svg"]` 仍在、时间筛选只影响有 `time_column` 的卡、只读连接可建板。
- 文档契约：`npm run verify:docs` 保持全绿。

## 12 风险

1. **卡片腐坏**（表改名/删列）：靠 `schema_hash` 漂移提示 + 打开 SQL 修复，不自动改写。
2. **口径可信度**：AI 生成的 GMV 之类口径错了比不出图更糟。卡片头部常驻「查看口径」跳 `AI_DB.md` §4，SQL 一键展开；无 brief 时生成的卡保持草稿态需用户 pin 才留。
3. **查询成本**：12 张卡 × 大表。缓解为先画快照、并发 2、`autoLimit` 生效、建议指向只读副本。
4. **一库多板的需求何时出现**：真出现时再加 `board_id` 并迁移，v1 不为假设需求预留抽象。
