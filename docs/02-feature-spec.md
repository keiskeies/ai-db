# AiDB Studio — 功能设计规格

> 版本：v0.4-dev · 关联：[架构](./01-tech-architecture.md) · [UI/UX](./03-ui-ux-design.md) · [Agent](./04-ai-agent-design.md)

## 1. 功能全景（Navicat 对标矩阵）

| 能力域 | Navicat 对应 | AiDB v0.3 | 说明 / 差异 |
|---|---|---|---|
| 连接管理 | Connection | ✅ | 11 种关系型（含达梦 DM8、DuckDB、TimescaleDB）+ TDengine/InfluxDB + MongoDB + Redis + Cassandra/ScyllaDB + Neo4j/Memgraph/FalkorDB/ArangoDB + Qdrant/Milvus/Weaviate + Elasticsearch/OpenSearch + 15 种国产协议别名；颜色、只读、SSH 隧道、测试连接 |
| 对象浏览器 | 导航窗格 | ✅ | 库→表/视图→列/索引/外键；搜索、右键、刷新、懒加载 |
| 数据网格 | 表数据查看器 | ✅ | 分页/排序/过滤/编辑/增删行/复制/导出；虚拟滚动 |
| SQL 编辑器 | 查询编辑器 | ✅ | 多标签、高亮、执行选区、多结果集、历史、EXPLAIN、格式化 |
| 表设计器 | 设计表 | ✅ | 可视化列/索引编辑，DDL 预览后执行；外键查看 |
| 导入导出 | 导入/导出向导 | ✅（CSV/JSON/SQL/XML） | CSV 映射预览；移动端仅导出分享 |
| 备份/还原 | 备份 | ✅ | 逻辑 dump、列表、恢复、定时备份；MySQL/PG 基础 dump |
| 结构对比/同步 | Schema Diff | ✅ | 新增/删除表、列变更、索引差异，目标方言 DDL，一键同步 |
| 用户与权限 | 用户管理 | ✅（按引擎） | MySQL/PG/SQL Server/Oracle/ClickHouse 列表、创建、删除、授权；需管理员权限 |
| 服务器监控 | Monitor | ✅（按引擎） | 指标卡 + 会话列表 + 终止会话 |
| 定时任务 | Scheduler | ✅ | 定时 SQL / 备份，启停、立即执行、状态 |
| ER 图 | 模型 | ✅ 只读 + SVG | 外键关系卡片 + 连线 + SVG 导出；可视化建模仍为后续 |
| 查询构建器 | Query Builder | ✅ | 两表连接、列选择、WHERE、排序、LIMIT → SQL |
| 数据库搜索 | Find in Database | ✅ | 表/列/注释 + 文本列数据命中 |
| 数据传输 | Data Transfer | ✅ | 跨连接复制结构+数据，追加/替换，自动建表 |
| 数据对比 | Data Sync | ✅（基础） | 行数 + 主键指纹对比；差异表替换同步 |
| 数据生成 | Data Generation | ✅ | 按列语义/类型 + 外键生成测试数据 |
| 数据字典 | Data Dictionary | ✅ | Markdown / DDL / JSON 导出 |
| 高级对象 | Objects | ✅ 查看 | 触发器 / 函数 / 序列 / 事件定义 |
| SQL 片段 | Snippets | ✅ | 保存/插入/删除常用 SQL |
| SQL 文件 | Run SQL File | ✅ | 打开、保存、脚本执行 |
| 结果图表 | Charts | ✅ | 查询结果柱状/折线/饼图 |
| **AI Agent** | — | ✅ **核心差异** | 22 工具、4 权限模式、四层记忆、Claude Code 式对话 |
| **多端** | 仅桌面 | ✅ **核心差异** | 桌面 3 端 + 移动 2 端，会话/记忆同步 |

## 2. 连接管理

### 2.1 字段
| 字段 | 类型 | 说明 |
|---|---|---|
| name | string | 显示名，唯一建议 |
| engine | sqlite \| mysql \| mariadb \| postgresql \| cockroachdb \| sqlserver \| oracle \| clickhouse | 驱动类型 |
| color | 枚举 7 色 | 标签色，用于树与标题条 |
| host/port | string/number | 默认 127.0.0.1:3306/5432 |
| database | string | 默认库（SQLite 为文件路径） |
| username/password | string | 加密存储 |
| ssl | boolean + 证书路径 | MySQL/PG SSL |
| ssh | {enabled, host, port, user, authMethod(password/key), password, privateKeyPath, passphrase} | 隧道 |
| readonly | boolean | 强制只读（覆盖 Agent 权限） |
| environment | dev \| staging \| prod | 生产环境 UI 红色警示，破坏性操作强制审批 |
| group | string | 分组（默认/自定义） |

### 2.1 引擎支持

| 引擎 | 默认端口 | 连接字段 | 备注 |
|---|---|---|---|
| SQLite | — | 文件路径 | readOnly 以文件模式打开 |
| MySQL | 3306 | host/port/db/user/pass | SSH / SSL |
| MariaDB | 3306 | 同上 | MySQL 协议 |
| PostgreSQL | 5432 | 同上 | Schema 分组 |
| CockroachDB | 26257 | 同上 | PG 协议 |
| SQL Server | 1433 | 同上 | dbo schema、IDENTITY |
| Oracle | 1521 | 服务名 / SID | thin 模式，无 Instant Client |
| ClickHouse | 8123 | HTTP/HTTPS | 数据库即 schema |

### 2.2 行为
- 新建/编辑/复制/删除；删除需确认；凭据不明文回显（显示 `••••`）。
- 测试连接：10s 超时，返回版本、延迟、当前用户。
- 双击连接 → 展开对象树；首次连接写入 schema 缓存。
- 只读开关生效于 UI 与 Agent（服务端强制）。
- 生产环境：连接标签/状态栏红色；Agent `full` 模式下仍强制破坏性审批。

## 3. 对象浏览器

- 层级：Connection → Database/Schema → Tables / Views → Columns / Indexes / Foreign Keys / Triggers（只读）。
- 节点图标区分表/视图/系统表；表旁显示近似行数（缓存，可刷新）。
- 顶部搜索框：模糊过滤当前树；回车定位第一个结果。
- 右键菜单：
  - 表：打开数据、设计表、新建查询（生成 SELECT）、复制名称、导出数据、生成 DDL、AI 解释此表、AI 优化查询。
  - 库：新建查询、刷新、备份、AI 巡检。
  - 连接：连接/断开、刷新、编辑、复制、删除、只读切换。
- 拖拽表名到编辑器/Agent 输入框 → 插入引用（`@table`）。
- 状态：连接中/已连接/错误（悬浮显示错误详情）。

## 4. 数据网格

### 4.1 查看
- 默认 `SELECT * FROM t LIMIT 100 OFFSET 0`；可切换每页 50/100/200/500。
- 列头：类型徽标（int/text/json/timestamp）、排序（ASC/DESC/无）、宽度拖拽、冻结前 2 列。
- 单元格：NULL 灰斜体、二进制显示 `<BLOB n bytes>`、JSON 格式化预览、长文本悬浮全文。
- 底部状态：行数、耗时、页码。
- 过滤条：可视化条件（列/操作符/值，AND/OR）+ 直接输入 WHERE 片段；与排序一起持久化到标签页。

### 4.2 编辑
- 双击进入编辑；主键定位；提交时生成参数化 UPDATE；失败回滚单元格并提示。
- 支持新增行（空白行 + 必填校验）、删除行（二次确认，展示 WHERE）。
- 批量粘贴（从 Excel 复制的 TSV）→ 映射预览 → 批量 INSERT（事务）。
- 无主键表：只读并提示（避免误更新），可显式"强制编辑"（按 rowid/全部列匹配，需确认）。
- 类型转换在服务端完成，错误以单元格级错误提示。

### 4.3 导出
- 当前结果或整表 → CSV（UTF-8 BOM）/ JSON / SQL INSERT / XML；非 SQL 引擎导出当前语句结果（CSV/JSON/XML，不生成 INSERT），需要语句而非表名。
- 选择列、是否含表头、NULL 表示、行数上限。
- 移动端：调用系统分享。

## 5. SQL 编辑器

- CodeMirror 6；SQL 方言高亮；关键字/表名/列名补全（来自 schema 缓存）；括号匹配；多光标。
- 多标签：草稿自动保存（本地存储 + 元数据库），关闭提示未执行修改。
- 执行：`Cmd/Ctrl+Enter` 执行全部或选区；`Cmd/Ctrl+Shift+Enter` 执行当前语句；危险语句红色执行按钮。
- 结果：多结果集 Tab；消息面板（影响行数、耗时、警告）；错误定位行号。
- 查询历史：最近 200 条，按连接过滤，可搜索、收藏、插入编辑器。
- EXPLAIN：MySQL `EXPLAIN FORMAT=JSON`、PG `EXPLAIN (FORMAT JSON)`、SQLite `EXPLAIN QUERY PLAN`，结构化展示 + AI 解读按钮。
- 格式化：基础 SQL formatter（关键字换行/缩进）。
- 只读连接禁写；生产连接执行写操作弹确认。

## 6. 表设计器

- 打开表：加载列（名称/类型/长度/精度/非空/默认/自增/主键/注释）、索引、外键。
- 编辑：增删列/索引；类型下拉按方言；修改列名/类型时展示"将重建表"风险提示（SQLite）。
- DDL 预览：实时生成 ALTER/CREATE 语句，可复制；执行前确认。
- 新建表：可视化表单 + DDL 预览；创建后自动刷新树。
- 危险变更（删列、改类型）在 `ask/auto` 下需审批。

### 6.1 关系图（只读 ER）

- 入口：连接右键 / 表右键 / 侧栏关系按钮；显示当前库（或 Schema）的所有表。
- 布局：三列自动排布结构卡片（列名 + 类型 + 主键高亮 + 行数估计），画布可滚动；外键绘制贝塞尔连线，悬浮显示 `表(列) → 目标表(列)`。
- 交互：点击卡片打开数据；刷新结构；新建查询；浅/深主题适配；空库显示引导。
- 性能：布局在客户端完成，适合数十张表；>200 张表时仅展示当前 Schema 并提示。

## 7. 导入导出

- CSV 导入：选择文件 → 分隔符/编码/首行表头 → 列映射（目标表/列/类型）→ 预览前 20 行 → 事务批量插入 → 报告（成功/失败行）。
- 文档/向量/搜索集合导入：同一份 CSV 按列名生成文档，`id` 列映射主键（MongoDB 与搜索库写入 `_id`）、`vector` 列解析 `[0.1, 0.2]` 或空格分隔的数组，单批 200 条、上限 5000 行，只读连接拒绝。
- 导出：结果集或整表；格式 CSV/JSON/SQL/XML；文件路径；大表分批；MongoDB/Redis/图/向量/搜索等引擎按当前语句导出。
- 安全：导入仅允许 INSERT；类型错误行记录并跳过（可配置整批失败）。

## 8. 备份与还原

- SQLite：文件级快照（`VACUUM INTO`）+ 逻辑 SQL dump。
- MySQL：`SHOW CREATE TABLE` + 分批 SELECT 生成 INSERT dump（v0.1 基础；大库提示用原生工具）。
- PG：结构 + `COPY` 文本导出基础版。
- 备份落盘到用户目录 `AiDB/backups/<connection>/<timestamp>.sql`；列表可还原（危险操作，强制确认）。
- Agent 可在破坏性操作前调用 `backup_database` 自动快照（`auto/full` 模式默认开启"变更前快照"）。

## 8.5 AI 具体能力（v0.2）

| 能力 | 输入 | 产出 | 落地位置 |
|---|---|---|---|
| 数据库体检 | “给数据库做一次体检” / `/audit` | 缺主键、外键缺索引、重复索引、空表；按 high/medium/low 排序；每条附修复 SQL | Agent 工具卡 + 可展开 findings |
| 数据质量 | “检查 orders 的空值/重复” / `/quality` | 行数、每列空值率/空串/不同值、重复主键组；建议排查 SQL | 统计表 + findings |
| 图表分析 | “按 status 统计 orders 并画柱状图” / `/chart` | 柱状/折线/饼图，直接渲染在对话中，可打开 SQL | Chart Card（SVG / conic-gradient） |
| SQL Copilot | 编辑器选中 SQL → AI 解释 / AI 优化 | 执行计划解读、改写 SQL、精确索引 DDL、验证查询 | 一键送入 Agent |
| 修复闭环 | 体检/质量 finding | “打开到编辑器”/复制；审批后执行；写前备份 + 审计 | Agent 工具卡 / 编辑器 |

## 8.6 生产力工具（v0.3）

| 工具 | 入口 | 行为 | 安全 |
|---|---|---|---|
| 数据库搜索 | 工具箱 → 数据库搜索 | 对象名/注释 + 最多 25 张表的文本列 LIKE 搜索，返回命中行预览 | 只读 |
| 查询构建器 | 工具箱 → 查询构建器 | 选表/连接/列/WHERE/排序/行数 → SQL → 编辑器 | 只生成，不执行 |
| 结构对比同步 | 工具箱 → 结构对比同步 | 两连接 DDL diff，新增/删除/变更，生成目标方言 SQL，执行同步 | 目标只读拒绝；破坏性确认；审计 |
| 数据对比 | 工具箱 → 数据对比 | 行数 + 主键 DISTINCT/MIN/MAX 指纹；差异表替换同步 | 覆盖写入需确认 |
| 数据传输 | 工具箱 → 数据传输 | 选择源表，目标缺表自动建，追加/清空后写入，批 200 行 | 目标只读拒绝；审计 |
| 数据生成 | 工具箱 → 数据生成 / Agent | 按列语义、类型与外键生成 1–5000 行；预览/插入 | 写入需确认/审批 |
| 服务器监控 | 工具箱 → 服务器监控 | 引擎指标、会话；10s 自动刷新；终止会话 | 终止需确认；审计 |
| 自动化任务 | 工具箱 → 自动化任务 | SQL/备份任务，最小 30s 间隔，立即运行、启停、状态 | 调度器每 15s 检查；审计 |
| 用户与权限 | 工具箱 → 用户与权限 | 账户列表、创建、删除、授权 | 需管理员；审计 |
| 数据字典 | 工具箱 → 数据字典 | Markdown/DDL/JSON，下载 | 只读 |
| 高级对象 | 工具箱 → 高级对象 | 触发器/函数/序列/事件与定义 | 只读 |
| SQL 片段 | 查询 → 片段 | 保存/插入/删除 | 本地元数据 |
| SQL 文件 | 查询工具栏 | 打开/保存/多语句执行 | 多语句需显式按钮 |
| 结果图表 | 查询结果 → 图表 | 柱状/折线/饼图、X/Y 选择 | 只读 |
| ER 导出 | 关系图 → 导出 SVG | 表/列/外键的 SVG 文件 | 只读 |
| 备份恢复 | 设置 → 数据 | 执行备份 SQL 文件 | 强确认 + 审计 |

## 8.7 Navicat 布局与表 / 数据操作（v0.3 对齐）

### 8.7.1 主界面布局
- **顶部功能区**：连接、新建查询、表、视图、函数、用户、其它、查询、备份、自动运行、模型、图表 12 个入口。
- **对象树**：连接 → 数据库 / Schema → 表（数量）/ 视图（数量）分组；固定显示函数 / 存储过程、查询、备份入口。
- **数据库右键菜单**：关闭、编辑 / 新建 / 删除数据库、新建表、新建查询、命令列、运行 SQL 文件、转储 SQL、逆向到模型、在数据库中查找、刷新、复制名称。
- **表 / 视图右键菜单**：打开数据、新建查询、设计、新建表、重命名、复制（结构 / 结构+数据）、查看 DDL、维护、对象信息、设置权限、导入 / 导出向导、清空、截断、删除、逆向到模型、刷新、AI 解释 / 数据质量、复制名称。

### 8.7.2 表操作
| 操作 | 行为 | 引擎处理 |
|---|---|---|
| 新建 / 设计 | 可视化列、索引、DDL 预览与执行 | SQL 方言（含国产协议别名） |
| 重命名 | 表名迁移 | MySQL/MariaDB/ClickHouse `RENAME TABLE`；SQL Server `sp_rename`；其余 `ALTER TABLE ... RENAME` |
| 复制 | 仅结构 / 结构+数据；自增列重新生成 | 通用 |
| 查看 DDL | 从元数据还原 CREATE + 索引 + 外键 | MySQL 视图走 `SHOW CREATE VIEW` |
| 清空 / 截断 | 清空保留自增；截断重置 SQLite 自增序列 | 按引擎能力 |
| 删除 | 表 / 视图删除，UI 二次确认 | 通用 |
| 维护 | 分析、优化、检查、修复、回收空间 | 引擎支持矩阵；不支持时明确提示 |
| 对象信息 | 列、索引、外键、行数、注释 | 通用 |
| 设置权限 | 跳转用户与权限工具 | SQL 引擎（SQLite 除外） |

### 8.7.3 数据操作
- **数据网格**：行号、记录区间与页码、筛选 / 排序 / 文本视图、WHERE 输入、可视化筛选构建器。
- **编辑**：双击单元格即时更新；新增行、删除行；主键安全定位；无主键表只读。
- **批量**：行多选、复制（TSV）、粘贴（TSV / Excel）、复制行、批量删除。
- **查找替换**：按列文本查找，先预览匹配行数，再执行替换；可限定当前筛选。
- **导入导出**：CSV 导入向导（分隔符、表头、预览、列映射）；CSV / JSON / SQL / XML 导出。
- **记录导航**：`第 1-100 条记录（共 900 条）· 第 1/9 页`，每页 50/100/200/500 行。

### 8.7.4 查询窗口
- 双行工具栏：连接 / 数据库下拉 + 运行；保存、查询创建工具、美化 SQL、代码段、执行计划、AI 解释 / 优化、导出、脚本执行、SQL 文件打开。
- 结果区：多结果集、消息、历史、片段、图表页签。

### 8.7.5 数据库操作
| 操作 | 支持 |
|---|---|
| 新建数据库 | MySQL/MariaDB/PostgreSQL/CockroachDB/SQL Server/ClickHouse |
| 删除数据库 | 同上，需输入库名确认 |
| 重命名数据库 | PostgreSQL/CockroachDB/SQL Server/ClickHouse；MySQL/MariaDB 明确不支持 |
| 转储 SQL | 逻辑 dump 到备份目录 |
| 数据库内查找 | 打开全局数据库搜索 |
| 命令列 / 运行 SQL 文件 | 打开查询窗口 |

> 事务：当前编辑即时提交，尚未提供 Navicat 式“开始事务 / 提交 / 回滚”的跨请求事务模式。

## 8.8 非关系型引擎（v0.4-dev）

| 引擎 | 模型 | 对象浏览 | 查询 | 结果 | SQL 专属功能 |
|---|---|---|---|---|---|
| MongoDB | document | database → collection/view；采样 30 条推断字段（含一层嵌套字段）；右键「对象信息」显示并可管理 `$listIndexes` 读到的索引（新建：字段 / 唯一 / 稀疏 / TTL；删除需手输索引名，`_id_` 拒删） | JSON MQL：find / aggregate / count / distinct；支持 filter / pipeline / projection / sort / limit / skip；文档写入 / CSV 导入 / 按 _id 删除 | 文档行，嵌套值为 JSON 单元格 | 禁用 DDL 设计器、结构同步、数据对比、dump、审计体检、图表 |
| Redis | keyvalue | DB 索引 → keys 伪对象 + RediSearch 索引；SCAN 浏览，不执行 `KEYS *`；双击键行打开类型感知详情，详情内可删除键（UNLINK），索引节点可删除索引（FT.DROPINDEX，文档保留） | 单条命令控制台；SCAN / HGETALL / ZRANGE / FT.SEARCH 等类型化结果 | key/value、field/value、member/score、索引文档行；详情含 TTL / 规模 / 编码 | 禁用 DDL、结构同步、备份、SQL 工具；Redis Stack 模块自动识别 |
| Neo4j | graph | database → 节点标签 / 关系类型；采样 30 个节点/关系推断属性 | Cypher 控制台；支持 `$params`；`EXPLAIN` / `PROFILE` 计划以 JSON 返回 | 节点/关系/路径为 JSON 单元格，`resultKind=graph`；支持表格/图视图（力导向布局、缩放平移、拖动节点、属性面板、搜索高亮） | 禁用 SQL 工具、DDL、结构同步、备份；超大图（>140 节点）自动退回环形布局 |
| Qdrant | vector | collection → 维度 / 距离 / payload 字段；对象树菜单可新建 / 删除集合；「对象信息」列出 payload 索引并可按字段建删（keyword / integer / float / text / bool / geo） | JSON：`scroll` 浏览或 `vector` / `text` 检索；批量写入、CSV 导入与按 id 删除 | id/score/payload 行，`resultKind=vectors` | 禁用 SQL 工具与 SQL DDL 设计器；文本检索需 Embedding |
| Milvus | vector | collection → field schema / 维度 | JSON：`scroll` 查询或 `vector` / `text` 检索；批量写入与按 id 删除 | id/score/entity 行，`resultKind=vectors` | 禁用 SQL/DDL 与建集合（需要完整字段定义）；文本检索需 Embedding |
| Weaviate | vector | class → properties / vectorizer | JSON：scroll 或 nearVector 检索（GraphQL） | id/score/properties 行，`resultKind=vectors` | 禁用 SQL/DDL；文本检索需 Embedding |
| Memgraph | graph | 节点标签 / 关系类型（复用 Bolt） | Cypher 控制台 | 节点/关系 JSON 行 | 禁用 SQL/DDL；多库能力有限 |
| FalkorDB | graph | graph → 节点标签 / 关系类型；采样 30 个节点/关系推断属性 | Cypher 控制台，Redis `GRAPH.QUERY`；参数内联为 `CYPHER k=v` | 节点/关系 JSON 行，`resultKind=graph` | 禁用 SQL/DDL；暂无可视化索引管理 |
| Cassandra / ScyllaDB | widecolumn | keyspace → table；列、主键/分区键 | CQL 控制台，支持 `?` 参数；无 JOIN | 行结果 | 禁用 SQL/DDL 设计器；不支持 JOIN |
| TDengine | timeseries | database → 超级表/子表；列、TAG | SQL 控制台，REST 6041；单语句 | 行结果 | 网格编辑关闭（时序数据不支持 UPDATE 语义） |
| InfluxDB | timeseries | database → measurement；列类型来自 information_schema | SQL 控制台（InfluxDB 3 /api/v3/query_sql，DataFusion）；EXPLAIN 可用 | 行结果 | DDL 与网格编辑关闭；写入走行协议 API |
| ArangoDB | graph | database → 文档集合 / 边集合（对象树可新建与删除，`_` 系统集合除外）；采样 30 个文档推断属性 | AQL 控制台（HTTP `/_api/cursor`）；支持 `@bindVar` 与 `@@collection`；文档写入/覆盖与按 `_key` 删除走 `/_api/document`；「对象信息」列出 `/_api/index` 的索引并可建 inverted / 删除 | 文档 JSON 行；带边/路径的结果渲染图视图 | 禁用 SQL/DDL；REMOVE 无 FILTER 视为破坏性 |
| Elasticsearch / OpenSearch | search | 索引 → mapping 字段；对象树菜单可新建索引（带 mapping） | JSON `_search` DSL；批量写入、CSV 导入与按 id 删除文档 | `_id`/`_score`/`_source` 行，`resultKind=documents` | 禁用 SQL 工具与 SQL DDL 设计器；写入需非只读连接 |

协议别名：金仓 / openGauss / GaussDB / 瀚高 / Vastbase / IvorySQL 复用 PostgreSQL 驱动与方言；OceanBase / TiDB / PolarDB / TDSQL / GBase 8a / Doris / StarRocks / GreatSQL / GoldenDB 复用 MySQL 驱动与方言。openGauss/GaussDB 默认 sha256 认证需实例改为 md5 或使用兼容认证；Doris/StarRocks/GBase 8a 的 DDL 能力按 `EngineMeta.capabilities` 关闭设计器。

安全：只读连接在网关侧按语言分类拦截；MongoDB、Redis、Neo4j/Memgraph/FalkorDB、ArangoDB、Cassandra/ScyllaDB、向量检索与搜索 DSL 均有独立分类器；非 SQL 连接上的 SQL 专属 Agent 工具返回 `UNSUPPORTED_ENGINE`，并提示改用 `run_mql` / `run_redis` / `run_cypher` / `run_aql` / `run_cql` / `vector_search` / `search_index`；`manage_index` 是唯一按能力开放的例外，在 MongoDB 集合上建删索引。

## 9. AI Agent（摘要，详见 04）

- 对话式执行数据库任务；工具调用可视化；计划清单；审批；verbose 折叠；`@` 引用；斜杠命令。
- 权限四档；生产环境与破坏性操作额外防护。
- 记忆四层 + 记忆管理页；会话历史与跨端同步。
- 模型设置：Provider（Anthropic/OpenAI Compatible/Local）、Base URL、模型名、温度、最大步数、上下文压缩阈值；连接级"Agent 备注"（业务知识注入）。

## 10. 设置

| 分组 | 项 |
|---|---|
| 外观 | 主题（深/浅/跟随系统）、密度（紧凑/舒适）、语言（中文/English）、字号 |
| 编辑器 | 字体、Tab 大小、自动补全、保存草稿 |
| 查询 | 默认行数、超时、多语句开关、自动 LIMIT |
| Agent | Provider 与密钥、模型、温度、最大步数、默认权限模式、变更前自动备份、记忆开关、压缩阈值 |
| Bridge | 监听地址/端口、设备管理（配对码、吊销）、TLS 提示 |
| 数据 | 清空历史、导出审计、重置元数据库（危险） |
| 关于 | 版本、平台、开源许可 |

## 11. 快捷键

| 动作 | Win/Linux | macOS |
|---|---|---|
| 命令面板 | Ctrl+K | Cmd+K |
| 执行 SQL | Ctrl+Enter | Cmd+Enter |
| 执行当前语句 | Ctrl+Shift+Enter | Cmd+Shift+Enter |
| 新建查询 | Ctrl+T | Cmd+T |
| 关闭标签 | Ctrl+W | Cmd+W |
| 切换 AI 面板 | Ctrl+Shift+A | Cmd+Shift+A |
| 聚焦 Agent 输入 | Ctrl+L | Cmd+L |
| 格式化 SQL | Ctrl+Shift+F | Cmd+Shift+F |
| 保存查询 | Ctrl+S | Cmd+S |
| 刷新对象树 | F5 | F5 |
| 打开设置 | Ctrl+, | Cmd+, |

## 12. 非功能需求

- **可访问性**：焦点可见、对比度 ≥ 4.5:1、全键盘可达、`aria-label`、减少动效偏好。
- **i18n**：所有用户可见文案走字典（zh-CN 默认，en-US 完整）；日期/数字本地化。
- **错误处理**：统一错误对象（code/message/detail/hint）；数据库错误保留原始码；网络断线自动重连（指数退避）。
- **离线**：桌面无网络可用；Agent 可切 Local Reasoner；移动端离线可看缓存会话/记忆。
- **可观测**：Bridge 结构化日志（JSON lines）；`/api/health`；启动自检（驱动版本、元数据库可写）。
- **隐私**：默认不向任何第三方发送数据；调用云模型时 UI 明示将发送的表结构/查询内容；可关闭 schema 上下文。
