# 21 — SQLBot 对标特性落地设计（术语同义词 / 图表一键解读预测 / 示例库运营 / 历史推荐问 / 仪表板拖拽）

状态：实施中（本文档随实现同步更新）
日期：2026-11-15
上游调研：SQLBot（fit2cloud/DataEase，v1.10.3）产品调研，见 `docs/08-agent-accuracy-plan.md` 的准确率路线与本次调研结论。

## 1. 背景

SQLBot 的准确率 playbook 把四类失败（答非所问 / 结果不准 / 无法生成 / 术语混淆）全部归因到业务上下文缺失，
并给出四步修复：表管理、字段语义、示例 SQL、术语词典（含同义词）。它的图表卡带一键「数据分析 / 数据预测」，
推荐问基于历史问数行为，仪表板支持自由布局。

AiDB Studio 已有对应地基（见 §3），真正缺口是五处。本文档定义这五个特性的完整设计与实施顺序，
按里程碑逐步实现，每个里程碑独立可验收。

## 2. 目标与非目标

### 目标

- A（M1）术语同义词层：术语记忆携带同义词，召回、prompt、离线推理器三条路径都生效。
- B（M2）图表卡一键「解读 / 预测」：不经过模型、零 token，复用执行器 `analyze_chart` / `forecast_chart` 的权威统计。
- C（M3）示例 SQL 库运营：术语与示例的行内编辑 + CSV 导入导出（UTF-8 BOM，Excel 直接打开不乱码）。
- D（M4）基于历史问数的推荐问：最近会话里用户真实问过的问题进入「猜你想问」，带来源标识。
- E（M5）仪表板拖拽重排：HTML5 拖拽 + 实时预览，复用既有 `dashboardReorderCards` API。

### 非目标（明确不做）

- 嵌入宿主权限模型、多租户工作空间：AiDB 是本地桌面产品，形态不同，调研结论已排除。
- 行/列级权限规则组：同上，属于服务端多租户 BI 的权限体系。
- 流程图渲染（render_flow）：用户已明确否决。
- 仪表板定时刷新 / 卡片加宽 / 实时刷新：已存在（`dashboardSetSchedule`、span 切换、逐卡刷新），不重复建设。
- 新增 Agent 工具：工具目录保持 55 个不变（`verify:docs` 门禁约束）。图表解读/预测走 HTTP 端点复用既有工具，
  不新增工具定义，`docs/04-ai-agent-design.md` 工具表不动。

## 3. 现有地基（实现时直接复用，不重复造）

| 能力 | 落点 | 状态 |
| --- | --- | --- |
| 术语 / 示例记忆 | `MemoryKind` 含 `glossary`、`sql_example`；`memories` 表 + CRUD 路由 | 已有，缺同义词字段 |
| 记忆召回 | `packages/core/src/agent/memory.ts` `rankMemories`（语义类 +0.1 加成） | 已有，匹配文本缺同义词 |
| 业务上下文 prompt | `prompt.ts` `formatGlossary` / `formatAntiPatterns` / `formatSqlExamples` / `formatBusinessContext` | 已有，术语行缺同义词渲染 |
| 离线推理器 | `local/schema.ts` `rankTables` → `focusTablesForQuestion`（召回记忆正文作强信号） | 已有，匹配文本缺同义词 |
| 图表统计 / 预测 | `executor.ts` `analyzeChart`（summarize/topShare/deltas）、`forecastChart`（forecastSeries，线性回归/移动平均自动选择） | 已有，仅 Agent 工具路径可达 |
| 预测渲染 | 桌面 `ChartView` `ChartSpec.forecast`（虚线 + 区间带 + note）、移动端 `MobileChart` 同款 | 已有，缺用户触发入口 |
| 图表工具条 | `ChartToolbar` 由 `ChartView` 内部渲染，Agent / QueryView / 仪表板共用 | 已有，缺解读/预测按钮 |
| 推荐问 | `suggest.ts` 纯离线规则（trend/group/topn/quality/relation），路由 `/agent/suggest` 用最近 SQL 的表名加权 | 已有，缺「问过的问题」候选 |
| 示例库维护 UI | 工具箱「Agent 上下文」terms tab：添加 / 删除 / 搜索 | 已有，缺编辑与导入导出 |
| 仪表板重排 | `api.dashboardReorderCards` + ±1 按钮 | 已有，缺拖拽 |
| 记忆编辑 API | `PUT /agent/memories/:id`（title/content/kind/importance/pinned/archived/tags） | 已有，缺 synonyms |
| 迁移机制 | `store.ts` `ensureColumn`（幂等补列，启动即跑） | 已有 |

## 4. 特性 A（M1）：术语同义词层

### 4.1 数据模型

- `packages/core/src/types.ts`：`Memory` 与 `MemoryCandidate` 增加 `synonyms?: string[]`。
- `apps/gateway/src/store.ts`：
  - `migrate()` 追加 `this.ensureColumn('memories', 'synonyms', 'TEXT')`（JSON 数组文本，与 tags 同款）。
  - `rowToMemory` 解析 synonyms（坏 JSON 回退 `[]`，与 tags 一致）。
  - `createMemory` INSERT 写入 `JSON.stringify(candidate.synonyms ?? [])`。
  - `updateMemory` patch 映射增加 `synonyms`（JSON 序列化，与 tags 同款）。
  - `upsertMemoryCandidate` 合并重复记忆时同义词取并集（去重）。
  - `listMemories` 的 `q` 搜索条件加入 `synonyms LIKE ?`。
- 清洗规则（路由层，POST/PUT 共用）：trim、去空、去重（大小写不敏感）、每条 ≤ 40 字符、最多 12 条；
  非法输入直接丢弃该条而不是 400（同义词是锦上添花，不值得让整条记忆写入失败）。

### 4.2 召回与 prompt

- `memory.ts` `rankMemories`：文档 token 文本从 `title content tags` 扩为 `title content tags synonyms`。
  同义词命中即获得词汇分，配合既有语义类 +0.1 加成，用户问「JS 相关资产」能召回「JS = JumpServer 堡垒机（同义词：堡垒机）」」。
- `prompt.ts` `formatGlossary`：术语行渲染为 `- 术语（同义词: a / b / c） → 释义`；无同义词时保持原样。
  `formatAntiPatterns` 不变（反例是硬约束，同义词不参与）。
- `prompt.ts` `focusTablesForQuestion`：召回记忆的匹配文本 `title content` 扩为 `title content synonyms.join(' ')`，
  离线推理器（`local/schema.ts` `rankTables` 复用该函数）自动同权生效，不另写一套。
- `MemoryDrawer`：卡片标题行下展示同义词 chips（有才显示），维护入口仍指向工具箱。

### 4.3 API

- `POST /agent/memories`、`PUT /agent/memories/:id` 接受 `synonyms: string[]`，按 §4.1 清洗。
- `GET /agent/memories` 返回的 Memory 自带 synonyms（rowToMemory 已解析）。

### 4.4 UI（AgentContextTool terms tab）

- 添加术语表单增加「同义词（逗号分隔）」输入框，testid `ctx-term-synonyms`。
- 术语列表行展示同义词 chips；行内编辑在 M3 一并落地（避免同一行改两次）。
- 示例 SQL 不加同义词（示例的匹配靠问题文本相似度，同义词对它无意义）。

### 4.5 测试

- core 单测：`rankMemories` 同义词命中召回；`formatGlossary` 渲染同义词；`focusTablesForQuestion` 同义词命中表。
- gateway 单测：synonyms 落库往返（create → get → update → list 搜索）；清洗规则（去重/截断/上限）。
- E2E：工具箱添加带同义词术语 → chips 可见。

## 5. 特性 B（M2）：图表卡一键解读 / 预测

### 5.1 端点

`POST /agent/chart-insight`（apps/gateway/src/routes.ts）：

```
请求 { connectionId, database?, sql, x?, y?, mode: 'analyze' | 'forecast', periods?, method? }
响应 { result: ToolResult }   // result.data 即 analyze_chart / forecast_chart 的权威输出
```

- 实现：构造合成 ToolCall（`analyze_chart` 或 `forecast_chart`），走 `executor.execute`。
  审计自动生效（两工具都在 `DB_TOOLS`）；只读连接由 `manager.query` 强制；`chartSeries` 已有
  maxRows 500 / autoLimit / allowMulti=false 护栏。不新增工具定义。
- 校验：connectionId/sql 必填；mode 白名单；periods 1..12；method ∈ linear/moving_average/auto。
- 错误：执行器抛错（EMPTY_SERIES / FORECAST_FAILED 等）原样透传 code + message，UI 展示人话。
- 该端点不进 MCP 只读桥白名单变更（两工具本就在 `MCP_READONLY_TOOLS`，桥路径已可用）。

### 5.2 桌面

- `api.ts` 增加 `chartInsight(body)`。
- `ChartView` 新 prop `insightSource?: { connectionId: string; database?: string; sql: string; x?: string; y?: string }`。
  传入即具备一键能力；组件内部自持状态，一处实现服务所有调用方：
  - `analysis`（analyze 结果）→ 图表下方统计条 `chart-insight-strip`：合计 / 均值 / 最大（含类目）/ 最小（含类目）/
    Top 占比（前 3）/ 环比（时间序列时最近 3 期），全部来自执行器权威数字，不做前端二次统计。
  - `forecastOverlay`（forecast 结果的 chart.forecast + note）→ 合并进显示用 ChartSpec：
    `{ ...chart, type: 'line', forecast, note }`。`ChartView` 已渲染虚线 + 区间带 + note，零新渲染代码。
  - 两个按钮都是 toggle：再点一次收起统计条 / 移除预测段（aria-pressed 同步）。
  - busy 时按钮转 Loader2；失败时图表下方一行错误（`chart-insight-error`），不弹全局 toast 刷屏。
  - 放大态（zoom portal）透传 insightSource，放大图里同样可解读/预测。
- `ChartToolbar` 新 props `onAnalyze? / onForecast? / insightBusy?: 'analyze' | 'forecast' | null / analysisOn? / forecastOn?`：
  工具条右侧渲染「解读」（Sparkles）「预测」（TrendingUp）按钮，testid `chart-analyze` / `chart-forecast`。
  预测按钮仅在数据可预测时可用由后端判定（点了报错就展示错误），前端不做类型预判——
  执行器的 `isTimeSeries` / 样本量判定才是权威。
- 接线（三处，都是传一个 insightSource）：
  - `AgentPanel` `ResultView`：`chart && chartSql && connectionId` 时传 `{ connectionId, database: agentDatabase, sql: chartSql, x: chart.xLabel, y: chart.yLabel }`。
  - `QueryView` 图表页：`{ connectionId: tab.connectionId, database: tab.database, sql: chartSpec.sql, x: chartX || chartSpec.xLabel, y: chartY || chartSpec.yLabel }`。
  - `DashboardView` 卡片：`{ connectionId: card.connectionId, database: card.database, sql: card.sql, x: card.x, y: card.y }`。
- 统计条与预测段不进 PDF 导出的额外处理：它们是 DOM 的一部分，按现有 DOM 原序导出自然包含。

### 5.3 移动端 parity（不做阉割版）

- `MobileChart` 增加 `insight?: { connectionId: string; database?: string }` prop；有 insight 且 chart.sql 存在时，
  类型 chips 行尾追加「解读 / 预测」chips（testid `m-chart-analyze` / `m-chart-forecast`）。
- 移动端 client 增加 `chartInsight`；统计条用与桌面相同的字段渲染（合计/均值/最大/最小/Top 占比）；
  预测合并进 chart.forecast —— 移动端已渲染虚线 + 区间带，同样零新渲染代码。
- Agent 消息流与仪表板卡片里的 MobileChart 都传 insight（连接与库来自当前会话/卡片）。

### 5.4 测试

- gateway 路由单测：analyze 成功（demo 库真实 SQL）、forecast 成功（时间序列）、mode 非法 400、sql 缺失 400、
  空结果 EMPTY_SERIES 透传。
- E2E：QueryView 跑聚合 SQL → 图表页 → 点解读 → 统计条出现且数字与 SQL 结果一致；
  点预测（时间序列 SQL）→ `chart-forecast-line` 出现；再点 → 消失。
- 浏览器实测：真实模型会话里的图表卡同样验证一遍（Agent 路径）。

## 6. 特性 C（M3）：示例库运营 UI

### 6.1 行内编辑（AgentContextTool terms tab）

- 术语行 / 示例行增加 Pencil 按钮 → 该行切换为输入态（术语：标题/释义/同义词；示例：问题/SQL textarea），
  保存调 `api.updateMemory`，取消还原。testid `ctx-edit-term-{id}` / `ctx-edit-example-{id}`。
- 保存后 `reloadMemories()`，通知「已保存」。

### 6.2 CSV 导出

- terms tab 头部「导出 CSV」按钮（testid `ctx-export-csv`）：导出当前加载的全部术语 + 示例。
- 列：`kind,title,content,synonyms`（synonyms 用 `;` 连接）。RFC4180 转义（引号/逗号/换行）。
- UTF-8 BOM 开头（Excel 双击打开中文不乱码）；文件名 `agent-context-YYYYMMDD.csv`。
- 解析/序列化放 `apps/desktop/src/lib/csv.ts`（纯函数，可单测）：`parseCsv(text): string[][]`、`toCsv(rows): string`。

### 6.3 CSV 导入

- 「导入 CSV」按钮（testid `ctx-import-csv`）→ 隐藏 file input（accept=".csv,text/csv"）。
- 解析后逐行校验：kind ∈ glossary/sql_example；title/content 非空；synonyms 按 `;` 拆分。
  表头行自动识别跳过。坏行收集行号与原因，不中断整批。
- 好行逐条 `api.createMemory`（服务端 `upsertMemoryCandidate` 已做 jaccard 去重合并，导入天然幂等）。
- 完成后通知：`导入 N 条（合并 M 条）`，有坏行时列出前 5 条行号+原因。
- 导入导出不区分连接作用域：与 terms tab 现有加载口径一致（全量术语/示例），CSV 里不带 scope 列，
  导入按当前选中连接/库落作用域（与手工添加一致）。

### 6.4 测试

- `lib/csv.ts` 单测：引号转义、内嵌逗号/换行、BOM 剥离、空行、roundtrip。
- E2E：添加术语+示例 → 导出（验证下载内容）→ 清空 → 导入 → 行恢复。

## 7. 特性 D（M4）：基于历史问数的推荐问

### 7.1 core

- `suggest.ts`：
  - `SuggestionKind` 增加 `'recent'`；`SuggestOptions` 增加 `recentQuestions?: string[]`。
  - 候选生成：trim、长度 6..80 字符、按规范化文本去重（保留最近一次）、过滤与结构候选完全相同的 prompt；
    基础分 0.95（真实问过的问题比结构推断更贴近意图），同问题重复出现每次 +0.05（封顶 1.05）。
  - reason：`最近问过（{n} 次）` / `Asked recently ({n}×)`；table 填该问题历史关联表（无法确定时填 `''`，
    UI 不展示表名即可）；`maxPerKind` 轮转同样约束 recent（默认最多 2 条，不挤掉结构多样性）。
  - `suggestionLabel('recent')`：`问过` / `Asked`。
- 既有调用方不传 recentQuestions 时行为完全不变（纯增量）。

### 7.2 路由

- `GET /agent/suggest` 增加可选 `sessionId`（排除当前会话，避免把刚问完的问题又推回来）：
  `store.listSessions({ connectionId, limit: 8 })` → 逐会话 `listMessages` → `role === 'user'` 的 content，
  按时间倒序取最近 30 条传入 `recentQuestions`。会话/消息读取失败不阻塞推荐（try/catch 回退空数组）。

### 7.3 UI

- 桌面：推荐问 chips 已按 `suggestionLabel(kind)` 渲染徽标——`recent` 自动获得「问过」徽标；
  chip 图标对 recent 用 History（AgentPanel 与 QueryView 的推荐问渲染处各加一个分支）。
- 移动端：推荐问渲染处同样加 recent 徽标（parity）。
- `api.suggest` 增加 sessionId 参数；AgentPanel 传当前会话 id。

### 7.4 测试

- core 单测：recent 候选生成/去重/频次加分/上限/与结构候选去重/不传时行为不变。
- gateway 路由单测：有历史会话时返回 recent 建议；sessionId 排除生效。

### 7.5 手动刷新（换一换）

三端（助手面板 / 首页 / 移动端）的「猜你想问」头部各加一枚刷新按钮（RefreshCw，busy 时桌面旋转、
移动端换 Loader2）。推荐端点是确定性纯函数，同输入同输出——「换一批」不靠随机，靠排除协议。

- **刷新时读哪些数据**（路由每次请求现读，无额外缓存层）：
  - 最近真实问题：最近 8 个会话（排除当前 sessionId）的最新 30 条用户消息；
  - 查询历史：最近 50 条 SQL 涉及的表名，用于结构候选加权；
  - 业务上下文：`agentContextBundle` 注解（被注解的表加权）；
  - 结构：走 `manager.schema` 的 30s TTL 缓存——刷新**不强制重新内省**，避免每按一次
    「换一换」就打一轮内省查询；缓存过期后自然拿到最新结构。
- **排除协议**：客户端把本视图已展示过的 prompt 累积成排除集，刷新时以可重复查询参数
  `exclude` 传入（路由侧每条截断 200 字符、至多 60 条防滥用）。服务端与客户端共用
  `normalizeSuggestionPrompt`（trim + 折叠空白 + 小写）作为去重键，对全部候选（结构 + recent）
  做排除。问过的问题不进永久黑名单：回绕后仍可带着「问过」徽标被推荐。
- **回绕**：候选被排除光时回退到完整候选集——只要还有候选，刷新就不空手；客户端发现返回
  整批都已在排除集中时清空排除集重新累积。
- **按视图隔离**：排除集是各组件内的 ref，连接 / 库 / 会话（结构）变化时清空；三端视图互不影响。
- **失败语义**：请求失败或返回为空时保持原有推荐不清屏；busy 期间按钮禁用防连点。
- 测试：core 单测覆盖归一化 / 排除 / 回绕 / 空排除；gateway 路由单测覆盖 exclude 排除与回绕；
  E2E 三端各断言「换一换后新批次与旧批次零重叠」。

## 8. 特性 E（M5）：仪表板拖拽重排

- `DashboardCardView` 卡片脚增加拖拽把手（GripVertical，`draggable`，testid `dashboard-card-grip`）。
  只有把手可拖，避免与图表交互/文本选择冲突。
- 拖拽协议（HTML5 DnD）：
  - `onDragStart`（把手）：记录 draggedId，`dataTransfer.effectAllowed = 'move'`。
  - 卡片 `onDragOver`：preventDefault；按进入卡片计算目标索引，本地 state 即时重排（乐观预览）。
  - `onDrop` / `onDragEnd`：若顺序变化，调 `api.dashboardReorderCards(order)` 一次持久化；失败 notify + reload 回滚。
  - 视觉：被拖卡片 `.dragging`（降透明度），目标位置 `.drop-target`（accent 边框指示）。
- ±1 按钮保留（键盘可达性与精确微调），拖拽与按钮共用同一 reorder API 与乐观更新模式。
- 移动端仪表板是只读列表（现有形态），拖拽属于桌面布局操作，不在移动端复制（非阉割：移动端本就没有布局编辑）。

### 测试

- E2E：两张以上卡片 → 拖第二张到第一张前 → 顺序持久化（刷新后仍在）。
  Playwright 用 `dragTo` 或派发 DragEvent 序列驱动 HTML5 DnD。

## 9. 里程碑与验收

| 里程碑 | 内容 | 独立验收 |
| --- | --- | --- |
| M1 | 特性 A 全链路 | core+gateway 单测绿；工具箱加同义词术语 → chips 可见；prompt 注入含同义词 |
| M2 | 特性 B 全链路（桌面+移动） | 路由单测绿；QueryView/Agent/仪表板三处解读+预测实测；E2E 新检查绿 |
| M3 | 特性 C | csv 单测绿；编辑/导出/导入 E2E roundtrip 绿 |
| M4 | 特性 D | suggest 单测绿；历史问题出现在推荐问且带「问过」徽标 |
| M5 | 特性 E | 拖拽 E2E 绿；±1 按钮不回归 |
| 收尾 | 全量门禁 + 实测 | 见下 |

每个里程碑完成后跑：`npm run typecheck`、对应包单测、`npm run verify:i18n`。
全部完成后跑完整门禁：

```
npm run verify:docs && npm run verify:i18n && npm run typecheck && npm test && npm run build && npm run e2e
```

浏览器实测（playwright，dev 环境真实模型）：
1. 工具箱添加同义词术语 → 问一个只用同义词指代的问题 → 回答命中术语口径。
2. Agent 图表卡点解读/预测 → 统计条数字正确、预测虚线+区间带+方法说明出现。
3. 示例库编辑一条示例 → 导出 CSV → 删除 → 导入 → 恢复。
4. 问过的问题出现在推荐问（「问过」徽标）。
5. 仪表板拖拽重排 → 刷新后顺序保持。
6. 移动端（Bridge 真实配对）图表卡解读/预测与桌面一致。
7. 三端「换一换」：刷新后推荐不空手，且新批次与已展示批次零重叠（E2E 自动断言）。

## 10. i18n 与工程约束

- 新增文案一律 `tr("中文键")`，19 个 locale 文件（ar de en es fr hi id it ja ko nl pl pt-BR ru th tr uk vi zh-TW）
  全部补齐翻译；`verify:i18n --strict` 必须 0 缺失。
- CRLF worktree：多行 Edit 会失败，用单行 Edit 或 `\r\n` 归一化的 Node 补丁脚本（match-count===1 断言）， scratch 用完即删。
- E2E 跑在预构建 dist 上：改完必须 `npm run build && npm run e2e`。
- 工具目录保持 55 个；`docs/04` 工具表、`docs/16` 能力契约不动（chart-insight 是 HTTP 端点不是工具）。
- 不提交代码，除非用户明确要求。

## 11. 风险与回退

- 预测样本不足：执行器已有 FORECAST_FAILED 明确报错，UI 原样展示，不做前端假预测。
- CSV 大文件：导入上限 500 行（超出截断并提示），避免逐条 POST 风暴。
- 拖拽与卡片内图表 hover 冲突：把手独占 draggable，图表区域不响应拖拽起点。
- 同义词污染召回：同义词只进词汇匹配文本，不改变既有 scoring 权重结构；上限 12 条防滥用。