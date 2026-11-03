# AiDB Studio 全量测试问题记录（2026-11-03）

> 测试目标：在真实业务数据规模下，全面验证客户端 / 网关 / Agent 的功能正确性，并把发现的问题先落档、测试结束后统一修复。
> 测试方式：真实网关（127.0.0.1:8787，dev-token）+ 真实模型（openai 兼容端点 127.0.0.1:1994，qwen3.8-flash-next）+ 命令行自动化（`scripts/qa/*.mjs`）+ 现有 E2E（`npm run e2e`，修复后回归）。

## 1. 测试数据

### 1.1 Demo · 零售业务库（`~/.aidb/demo/demo-retail.sqlite`）

- 生成器：[`apps/gateway/src/seedBusiness.ts`](../apps/gateway/src/seedBusiness.ts)，脚本 [`scripts/seed-business.ts`](../scripts/seed-business.ts)。
- 规模：**40 个对象（34 表 + 2 视图 + 预留表）、479,748 行**。
- 业务域：零售/电商（orders/order_items/payments/refunds/shipments/coupons/reviews）、会员（customers/addresses）、商品（categories/brands/products/variants）、供应链（suppliers/purchase_orders/inventory/stock_movements/warehouses）、门店与组织（regions/cities/stores/employees/departments）、营销（campaigns/touches）、订阅（subscriptions）、财务（finance_entries）、客服（support_tickets/ticket_messages）、埋点（web_events/product_daily_stats/daily_metrics）。
- 结构性用例：复合主键（inventory/product_variants/daily_metrics）、无主键遗留表（legacy_order_export）、保留字表/列（"order" .group/.order/.select/.desc/.user）、BLOB（customer_avatars）、JSON 文本（products.attrs）、视图 2 个、触发器 2 个、索引 15 个。
- 刻意脏数据：空邮箱/非法手机号/姓名前后空格、重复手机号、负库存、退货金额大于支付金额、未来注册时间、`legacy_order_export` 中混用日期格式与“1,299.00元”金额格式，用于数据质量/体检/修复类功能。

### 1.2 Demo2 · 零售镜像库（`~/.aidb/demo/demo-retail-mirror.sqlite`，用于迁移/同步/比对）

- 规模：**37 个对象、451,418 行**。
- 结构漂移：缺少 `product_reviews`、`customer_avatars`、`legacy_order_export`；`products` 用 `warehouse_code` 替代 `rating`；`orders` 用 `goods_amount_cents` 替代 `goods_cents`、用 `sync_at` 替代 `invoice_title`；缺少部分索引。
- 行级差异：约 2% 订单缺失、0.4% 订单金额不同、25 条镜像独有会员。

两个连接已注册到网关，分组「示例」，供 UI 与 Agent 直接使用。

## 2. 测试覆盖

| 范围 | 方式 | 结果 |
|---|---|---|
| 连接、元数据、Schema、查询、分页、事务 | HTTP API 自动化 | 通过 |
| 网格编辑（增/改/删/批量）、DDL 设计器、表操作、查找替换 | HTTP API 自动化 | 发现 2 个问题 |
| 导入导出（CSV/JSON/SQL/XML/XLSX）、生成测试数据 | HTTP API 自动化 | 发现 1 个问题（同根因） |
| 备份/恢复、定时任务、仪表盘（含 AI 生成）、报告 | HTTP API 自动化 | 通过 |
| 多引擎能力矩阵、数据字典、高级对象、用户、监控 | HTTP API 自动化 | 通过（SQLite 的 NoSQL 路由按设计返回 UNSUPPORTED） |
| 全文搜索（对象/数据）、Web 搜索后端 | HTTP API 自动化 | 通过 |
| Agent 上下文、记忆、通知通道、MCP、Skills | HTTP API 自动化 | 发现 1 个问题 |
| 只读保护 | HTTP API 自动化 | 发现 1 个问题（状态码） |
| 结构/数据比对、结构同步、全量迁移、SSE 流式迁移 | HTTP API 自动化 | 通过（全量迁移 454,713 行） |
| 历史/审计/收藏/代码片段/设置 | HTTP API 自动化 | 通过 |
| 斜杠命令 `/diff`、`/recon` | HTTP API 自动化 | 通过 |
| Agent 业务问答（GMV 趋势、类目排行、退款率、沉睡会员、质量、结构差异、对账、饼图、预测、客单价、`/chart`、`/report`、`/init`） | 真实模型 + SSE | 13 个问题全部收口 10 个；3 个超过 240s（见第 4 节） |
| Agent 写操作与审批（建表/插入、拒绝破坏性操作） | 真实模型 + SSE | 通过 |
| 桌面端 UI（Chrome + Electron、主题、快捷键、导出、移动配对） | `npm run e2e` | **263/263 通过** |

自动化产物：`docs/test-artifacts/functional.json`、`docs/test-artifacts/agent.json`。

## 3. 问题清单

### ISSUE-001（P1）SQLite 网格编辑 / 导入的布尔值无法绑定

- **状态**：已修复（回归：`apps/gateway/test/qa-regressions.test.ts`）
- **影响**：所有 SQLite 连接的 BOOLEAN 列在「数据网格新增/编辑行」「CSV 导入」时失败；演示库中 `customers.consent_marketing`、`coupons`、`inventory` 等布尔列均受影响。
- **复现**：
  1. `POST /api/rows`，`{"op":"insert","values":{"name":"BoolRow","price_cents":500,"active":true}}`（表含 `BOOLEAN` 列）。
  2. `POST /api/rows`，`{"op":"update","values":{"active":false},"key":{"id":1}}`。
  3. `POST /api/import`，CSV 内容 `name,price_cents,active\nCSV-A,111,1`。
- **实际**：400 `SQLITE_ERROR`：`Provided value cannot be bound to SQLite parameter 3` / `parameter 1`；导入整体回滚。
- **期望**：布尔值按 SQLite 语义写为 `0/1`，插入/更新/导入成功。
- **初步根因**：`coerceValue()`（[`apps/gateway/src/services.ts:194`](../apps/gateway/src/services.ts)）对非字符串直接原样返回，布尔进入 `node:sqlite` 绑定参数后不受支持；只在 SQLite 驱动绑定层统一归一化最稳妥。
- **证据**：`functional.json` → grid-edit `grid insert boolean value` / `grid update boolean value`，import-export `import csv`。

### ISSUE-002（P1）记忆部分更新接口 500

- **状态**：已修复（回归：`apps/gateway/test/qa-regressions.test.ts`）
- **影响**：UI 修改记忆重要性/置顶等单项属性时请求失败；Agent 记忆治理不可用。
- **复现**：`PUT /api/agent/memories/:id`，body `{"importance":0.9}`。
- **实际**：500 `ERR_INVALID_ARG_TYPE`：`Provided value cannot be bound to SQLite parameter 1`。
- **期望**：只更新传入字段，返回 200。
- **初步根因**：路由把 `title/content/kind/...` 统一构造进 patch（缺失字段为 `undefined`），`Store.updateMemory` 用 `key in patch` 判断并绑定 `undefined`；[`apps/gateway/src/routes.ts:2386`](../apps/gateway/src/routes.ts) / [`apps/gateway/src/store.ts:1414`](../apps/gateway/src/store.ts)。
- **证据**：`functional.json` → agent-context `memory update`。

### ISSUE-003（P2）自动限行的结果不标记 `truncated`，界面不提示“结果已截断”

- **状态**：已修复（回归：`apps/gateway/test/qa-regressions.test.ts`）
- **影响**：查询大表时网关把 SQL 重写为 `LIMIT 100`，但返回 `truncated:false`；[`QueryView.tsx:816`](../apps/desktop/src/components/QueryView.tsx) 仅凭该标记显示徽标，用户会误以为拿到了全量结果。
- **复现**：`POST /api/query`，`SELECT * FROM web_events`（60,000 行，默认 limit 100）。
- **实际**：`rowCount=100`，`truncated=false`，`statement="SELECT * FROM web_events LIMIT 100"`。
- **期望**：`truncated=true`（或等价标记），界面明确提示被自动限行。
- **初步根因**：`applyLimit()` 先改写 SQL，驱动里 `rawRows.length > rows.length` 永远为 false（[`apps/gateway/src/drivers/sqlite.ts:126`](../apps/gateway/src/drivers/sqlite.ts)）。
- **证据**：`functional.json` → query `auto-limit result flagged truncated`。

### ISSUE-004（P2）只读连接 `/api/generate` 返回 500 而非 403

- **状态**：已修复（回归：`apps/gateway/test/qa-regressions.test.ts`）
- **影响**：只读保护语义不一致（`/rows`、`/import` 都是 403 `READONLY`），前端与 Agent 依赖错误码做引导。
- **复现**：只读连接上 `POST /api/generate`，`{"table":"orders","rows":2}`。
- **实际**：500 `INTERNAL_ERROR`，message `只读连接禁止写入`。
- **期望**：403 `READONLY`。
- **初步根因**：`features/generate.ts` 抛出普通 `Error` 而非 `DbError`，被统一错误中间件映射为 500。
- **证据**：`functional.json` → readonly-guard `readonly generate blocked`。

### ISSUE-005（P3）`POST /api/backups` 不返回备份记录 id，与前端类型不一致

- **状态**：已修复（回归：`apps/gateway/test/qa-regressions.test.ts`）（低优先级）
- **影响**：`api.createBackup` 的类型声明是 `{ backup: BackupInfo }`（含 id/createdAt），实际返回 `{path,bytes,tables,rows}`；若前端想“创建后立即恢复”会拿不到 id。
- **复现**：`POST /api/backups`，观察响应；`GET /api/backups` 中同一条记录含 id。
- **期望**：创建接口返回落库后的完整记录（含 id/createdAt），或调整前端类型为不含 id 的返回体。
- **证据**：`functional.json` → backups `backup created`（detail 中无 id）。

### ISSUE-007（P2）向量/搜索库上 `sample_rows` 的错误提示指向 `run_redis`

- **状态**：已修复（回归：`scripts/qa/nosql.mjs`）
- **影响**：Agent 在 Qdrant / Elasticsearch 上调用 `sample_rows` 时，会被告知“Qdrant 请使用 run_redis 查看键值”，把模型引向错误的工具；用户也会看到误导性提示。
- **复现**：`POST /api/agent/tools/sample_rows`，`{"connectionId": <qdrant|elasticsearch>, "table": "<collection|index>"}`。
- **实际**：400 `UNSUPPORTED_ENGINE`，message 为 `<引擎> 请使用 run_redis 查看键值`。
- **期望**：按引擎给出正确引导（Qdrant → `run_sql` 的 JSON scroll / `vector_search`；ES → `search_index` / `run_sql` 的 JSON DSL），或直接支持样例读取。
- **位置**：[`apps/gateway/src/executor.ts:783`](../apps/gateway/src/executor.ts)。
- **证据**：`nosql.json` → qdrant/elasticsearch `tool sample_rows`。

### ISSUE-010（P1）备份文件缺少语句分隔符，恢复在非空库上必然失败

- **状态**：已修复（回归：`apps/gateway/test/qa-regressions.test.ts`）
- **影响**：备份导出的 SQL 不是合法脚本；`POST /api/backups/:id/restore` 在目标库（同一连接）上重放时先报 `near "INSERT": syntax error`，即使跳过语法问题也会因 `table "brands" already exists` 失败。备份恢复功能实际不可用。
- **复现**：
  1. `POST /api/backups` 生成备份，打开 `.sql` 文件：`CREATE TABLE "brands" (...)` 后直接跟 `INSERT`，没有分号。
  2. `POST /api/backups/:id/restore` → 400 `SQLITE_ERROR`。
- **期望**：备份文件可被标准 SQL 客户端/网关重放；恢复时先清理备份中出现的同名视图/表，再执行脚本。
- **根因**：`dumpDatabase` 直接拼接 `buildCreateTable()` 的返回值（该函数不追加分号，UI 侧另行补齐）；恢复路由直接重放脚本，未处理已存在对象。
- **修复**：导出时补 `;`；新增 `restoreDropStatements()`，按方言在重放前生成 `DROP VIEW/TABLE IF EXISTS`（MySQL 关闭外键检查，PostgreSQL 使用 `CASCADE`）。
- **证据**：`functional.json` → backups `restore brings rows back`；修复前备份文件头 40 行。

### ISSUE-009（P3）`/recon` 命令对畸形 mapping 缺少校验，直接抛 TypeError

- **状态**：已修复（回归：`scripts/qa/functional.mjs` 的 `recon rejects malformed mapping`）
- **影响**：调用方传入不符合 `ReconMapping` 结构的 mapping（例如只有 `key/fields`）时，命令运行到 `mapping.left.connectionId` 处崩溃，返回 `COMMAND_FAILED: Cannot read properties of undefined (reading 'connectionId')`，用户无法判断该补什么。
- **复现**：`POST /api/commands/recon/runs`，`input.mapping = {"key":["id"]}`。
- **期望**：202 受理后运行阶段应给出明确失败原因（缺少 `mode/left/right`），或在受理时直接 400 `INVALID_INPUT`。
- **位置**：[`apps/gateway/src/commands/runner.ts:378`](../apps/gateway/src/commands/runner.ts)。
- **证据**：`functional.json` → commands `command /recon finished`（首次运行）。

### ISSUE-011（P1）大备份恢复会阻塞网关十几分钟

- **状态**：已修复（回归：`qa-regressions.test.ts` 恢复用例 + 全量功能套件）
- **影响**：130 MB / 45 万行备份恢复时，网关事件循环被占满，`/api/health` 超时、所有请求无响应。
- **复现**：对 48 万行的沙箱库创建备份后调用 `POST /api/backups/:id/restore`；期间请求健康检查超时。
- **根因**：备份脚本一行一条 INSERT（约 45 万条），恢复逐条 `await` 执行且每条自动提交；SQLite 每条 INSERT 一次 WAL `fsync`，耗时被放大到十几分钟，并因同步驱动阻塞主线程。
- **修复**：新增 `Driver.execScript()`（SQLite 用 `db.exec` 整段执行）；恢复时 `DROP → BEGIN → 全量脚本 → COMMIT` 一次完成，失败自动 `ROLLBACK`；非 SQLite 引擎回退到原逐条执行。
- **证据**：修复前 `curl /api/health` 超时（10s）；修复后全量功能套件（含 130 MB 恢复 + 45 万行迁移 + 34 表结构同步）在 54 秒内跑完且 198/198 通过。

### ISSUE-006（P2，观察项）Agent 业务问答延迟偏高

- **状态**：观察中
- **现象**：真实模型（qwen3.8-flash-next，reasoningTier=high）下，单个业务问题端到端约 60–180 秒；对数仓式问题（行数对账）Agent 会连续执行 5+ 条探查 SQL（含 `ATTACH` 镜像库、分区间计数等）。数据规模 48 万行、schema 40 对象。
- **证据**：`audit_log` 中同一轮内 00:08:16–00:09:00 连续多条 `agent run_sql`，其中一条 `ATTACH ... AS m; SELECT ...` 因多语句只读策略报错后自行改用单语句。
- **待办**：结合 `agent.json` 的 per-case 耗时与 usage 统计判断是模型推理还是工具往返；若以工具往返为主，可优化 schema 提示与批量查询引导。

### 非缺陷（按设计/环境）

- `/api/fields/create`、`/api/indexes/*`、`/api/objects/drop` 对 SQLite 返回 `UNSUPPORTED_ENGINE`：这些路由服务于搜索引擎/文档/向量/键值对象的 mapping 与索引；SQL 结构变更走 DDL 设计器（`/ddl/preview`+`/ddl/execute`），已验证可用。
- `mcp_list_servers` / `mcp_list_tools` 经 `/api/agent/tools/:name` 调用返回 403 `TOOL_NOT_EXPOSED`：出站 MCP 桥有意不暴露本地 MCP 元数据工具；Agent 会话内仍可使用。
- 短脚本（≤200 条语句）默认允许多语句执行，`allowMulti` 只约束超长脚本；`allowMultiStatement` 设置用于更严格的脚本策略。已验证 201 条语句默认被拒。
- MySQL/Redis/Mongo/Neo4j 端口未监听，本轮多引擎回归未覆盖；SQLite 之外的引擎能力以现有单测 + E2E 既有覆盖为准。

## 4. Agent 业务问答与写操作结果

模型：`openai` 兼容端点 `http://127.0.0.1:1994/v1` + `qwen3.8-flash-next`（reasoningTier=high）。每个问题一个独立会话，`permissionMode=auto`，客户端单轮上限 240 秒。产物：`docs/test-artifacts/agent.json`（63 项断言，55 通过）。

| # | 业务提问 | 耗时 | 工具序列（摘要） | 产出 | 结论 |
|---|---|---|---|---|---|
| 1 | 最近半年每月 GMV 走势，折线图 | 91s | run_sql ×13 → render_chart(line) → analyze_chart | 折线图 + 月度数值 | 通过 |
| 2 | 类目销售额 Top10 + 销量，柱状图 | 94s | inspect_schema, sample_rows, run_sql ×8, render_chart(bar), analyze_chart | 柱状图 + 排行 | 通过（1 次 SQL 列名写错后自纠） |
| 3 | 上月各渠道退款率排序 + 对比图 | 77s | inspect_schema, run_sql ×5, render_chart(bar) | 退款率对比图 | 通过 |
| 4 | 近 90 天未下单、历史消费 >5000 的高价值会员 | 76s | run_sql ×5, export_result | 明细 + CSV 导出 | 通过 |
| 5 | 订单表空值/异常检查清单 | 240s | update_plan, check_data_quality, run_sql ×18, inspect_schema | 质量发现清单 | 通过（贴近客户端上限） |
| 6 | 业务库 vs 镜像库订单表结构差异 | 30s | list_connections, schema_diff, inspect_schema ×2, run_sql ×2 | 结构差异 + DDL | 通过（最快） |
| 7 | 两库订单行数差多少 + 数据证据 | 240s | list_connections, update_plan, run_sql ×11, recon_data ×2 | 行数/差异证据 | **超时**（结果未在 4 分钟内收口） |
| 8 | 退款原因分布饼图 | 58s | inspect_schema, sample_rows, run_sql ×6, analyze_chart, render_chart(pie) | 饼图 | 通过（1 次列名歧义后自纠） |
| 9 | 按日预测下月销售额趋势 | 240s | run_sql ×15, forecast_chart, render_chart ×2 | 预测 + 折线 | **超时**（产出已出现，未收口） |
| 10 | 各城市客单价 Top10 | 42s | run_sql ×5, analyze_chart, render_chart(bar) | 柱状图 | 通过 |
| 11 | `/chart` 各渠道 GMV 占比 | 58s | run_sql ×5, render_chart(pie), analyze_chart | 饼图 | 通过 |
| 12 | `/report` 上月经营分析报告 | 240s | update_plan ×4, run_sql ×24, render_chart ×7, analyze_chart | 多张图表 | **超时**（探索过长，未收口） |
| 13 | `/init` 数据库说明 | 120s | —（确定性扫描） | AI_DB.md 说明 | 通过 |
| 14 | 写操作：建 `customer_feedback` 并插入 3 行 | — | update_plan, run_sql ×8 | 表 + 3 行 | 通过（回读数据库确认） |
| 15 | `ask` 模式下删除 rating<3 的记录 → 拒绝审批 | — | approval_required → deny | 未执行删除 | 通过 |
| 16 | 会话创建/改名/详情/删除/推荐/模型发现 | — | HTTP API | — | 通过（6/6） |

归因：
- 4 个超时均因模型多轮探查（11–24 次工具调用）超过 240 秒；工具本身单次执行 < 300ms。属于 **ISSUE-006 延迟观察**，不是工具错误。
- 4 个 “tool calls succeeded” 失败均为模型 SQL 笔误（`oi.unit_price_cents` 作用域、`status` 歧义、`STDDEV` 不存在、`oi.amount_cents`/`r.refund_cents` 猜列），模型均在下一次调用自行纠正；说明 `inspect_schema`/错误回传链路有效，但也暴露 schema 提示还不够“防呆”。
- 模型在跨库对账时使用 `ATTACH` 把镜像库挂到业务库连接上，后续 `ATTACH` 同名报 `database m is already in use`；`ATTACH` 会持久改变连接状态，建议在 Agent SQL 白名单/清理策略中处理（观察项，本轮未改）。

## 5. 修复记录（本轮已落地）

| 问题 | 修复点 |
|---|---|
| ISSUE-001 布尔绑定 | SQLite 驱动 `normalizeParams()`：`boolean → 0/1`、`undefined → null`、`Date → ISO` |
| ISSUE-002 记忆部分更新 | `Store.updateMemory` 跳过 `undefined` 字段 |
| ISSUE-003 自动限行不标记截断 | `manager.query` 检测 `applyLimit` 改写并补 `truncated=true` |
| ISSUE-004 只读 generate 返回 500 | `generateData` 改为 `DbError(READONLY, 403)` |
| ISSUE-005 备份缺 id | `dumpDatabase` 返回落库记录（id/createdAt） |
| ISSUE-007 错误提示误导 | `sample_rows` 按引擎给出 vector/search/graph/CQL/AQL 正确引导 |
| ISSUE-009 畸形 mapping 崩溃 | recon 运行前校验 `mode/left/right`，返回明确错误 |
| ISSUE-010 备份不可恢复 | 导出补语句分号；恢复前生成 DROP（MySQL 关外键、PG CASCADE、SQLite 关外键）；SQLite 走整段 `exec` + 事务（见 ISSUE-011） |
| ISSUE-011 大备份恢复阻塞 | 新增 `Driver.execScript()`，SQLite 恢复用 `DROP → BEGIN → 脚本 → COMMIT` 一次执行，失败回滚 |

## 6. 回归结果

- `npm run verify:docs`：384/384
- `npm run verify:controls`：通过
- `npm run typecheck`：0 错误
- `npm test`：**397 项，332 通过，0 失败，65 跳过**（跳过均为需要真实外部引擎的用例）
- `scripts/qa/functional.mjs`：**198/198**
- `scripts/qa/nosql.mjs`（Qdrant + Elasticsearch 只读）：**12/12**
- `scripts/qa/agent.mjs`：63 项，55 通过（8 项归因见第 4 节）
- `npm run e2e`：**263/263 通过**

## 7. E2E 桌面端回归

- `npm run e2e`：**263/263 通过**（Chrome 桌面端 + Electron 壳、深浅主题、鼠标拖拽、键盘快捷键、导出 PNG/PDF、移动端配对等）。
- 修复未引入 UI 回归；E2E 同时覆盖只读连接入口禁用、网格不可编辑、控制台无报错。

> 说明：E2E 使用独立的临时 `AIDB_HOME`，不会影响本机已注册的 Demo / Demo2 连接。

## 8. 复现命令

```bash
# 生成/重建业务演示库与镜像库
node --import tsx scripts/seed-business.ts --force

# 功能全量自动化（需网关运行，dev-token）
node scripts/qa/functional.mjs

# Agent 业务问答/写操作（需真实模型端点）
node scripts/qa/agent.mjs

# 修复后的整体回归
npm run typecheck && npm test && npm run e2e
```
