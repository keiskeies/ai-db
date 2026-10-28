# AiDB Studio — 产品设计总览

> 版本：v0.4-dev · 日期：2026-10-28 · 状态：多引擎扩展进行中（41 种引擎：11 种关系型，含达梦 DM8/DuckDB/TimescaleDB；时序 TDengine/InfluxDB；MongoDB/Redis；Cassandra/ScyllaDB；图 Neo4j/Memgraph/FalkorDB/ArangoDB；Qdrant/Milvus/Weaviate；Elasticsearch/OpenSearch；15 种国产协议别名）

## 1. 产品定位

AiDB Studio 是一款 **AI 原生、全平台** 的数据库连接与管理工具。界面与工作流对标 Navicat（连接管理、对象树、数据表格、SQL 编辑器、表设计器、导入导出），核心差异化是内嵌一个 **可全权操作数据库的 AI Agent**：

- 交互形态参考 Claude Code：流式对话、工具调用卡片、计划清单、权限确认、可折叠思考过程、会话与记忆。
- Agent 不是"聊天玩具"，它拥有与用户相同的数据库能力（查询、DDL、数据修改、导入导出、备份），并在权限分级与审计日志的约束下执行。
- 桌面三端（Windows / macOS / Linux）为完整形态；移动两端（Android / iOS）为"Agent 优先 + 远程连接"形态，通过安全的 Bridge 网关访问数据库（移动端也保留本地 SQLite 体验库）。

一句话：**Navicat 的完整数据库工作台 + Claude Code 式的 AI 搭档，五端同一份能力内核。**

## 2. 目标用户

| 画像 | 场景 | 关键诉求 |
|---|---|---|
| 后端/全栈工程师 | 日常查数、改数据、建表、排查线上问题 | 快、键盘流、SQL 智能补全、AI 代操作 |
| DBA / 数据工程 | 结构对比、批量维护、导出、巡检 | 安全护栏、审计、可回滚、批处理 |
| 数据分析师 | 取数、临时探索、结果导出 | 低门槛问答式取数、结果可视化 |
| 移动端值班人员 | 外出时查看库状态、跑只读查询、让 AI 排查 | 随时可用、只读安全、会话与桌面同步 |

## 3. 差异化能力（核心卖点）

1. **Agent 全权操作**：37 个数据库工具 + 计划/待办 + 权限模式（只读 / 询问 / 自动 / 全自动）+ 破坏性操作二次确认 + 完整审计。
2. **记忆架构**：工作记忆（会话内压缩）、情景记忆（会话摘要）、语义记忆（库结构/业务事实/用户偏好）、程序记忆（可复用 SQL 剧本），跨会话检索并可在 UI 中查看、编辑、遗忘。
3. **Claude Code 式体验**：`⏺ tool(args)` 工具卡、行内 diff、Todo 计划、verbose 折叠、`@table` 上下文引用、斜杠命令、Cmd/Ctrl+K 命令面板。
4. **具体可交付的 AI 结果**：数据库体检（主键/外键索引/重复索引/空表）给出修复 SQL；数据质量给出空值率/重复主键；自然语言需求直接产出柱状/折线/饼图；SQL Copilot 输出改写 SQL + 索引 DDL + 验证查询。
5. **五端一致**：核心协议与 Agent 运行时共享；移动端复用同一会话、同一记忆、同一权限模型。
6. **离线可用**：无 API Key 时内置本地推理器（Local Reasoner），演示与基础操作不依赖云模型；支持 Anthropic / OpenAI 兼容端点（含 Ollama、DeepSeek、Qwen）。
7. **安全默认**：SQL 静态分类、只读模式、LIMIT 注入、事务包裹、敏感字段脱敏、审计日志、密钥加密存储。

## 4. 平台矩阵

| 平台 | 形态 | 技术 | 能力范围 |
|---|---|---|---|
| Windows | 桌面 | Electron + React | 全功能，本地驱动直连 |
| macOS | 桌面 | Electron + React | 全功能，本地驱动直连（arm64/x64） |
| Linux | 桌面 / 无头服务 | Electron + React / Node Bridge | 全功能；Bridge 可独立部署 |
| Android | 移动 | Expo React Native | Agent 优先、远程连接（Bridge）、本地 SQLite 体验库、只读/询问模式默认 |
| iOS | 移动 | Expo React Native | 同 Android |

> 移动端默认禁用"全自动 + 破坏性"组合（可在 Bridge 侧策略中显式放开），移动端 UI 以 Agent 对话 + 结果卡片为主，不追求桌面级多窗格。

## 5. 范围

### 5.1 当前交付（v0.4-dev）
- 主界面：Navicat 式顶部 12 模块功能区、连接 / 对象树（表 / 视图 / 函数 / 查询 / 备份分组）、工作区 Tabs、AI 面板。
- 连接管理：关系型 SQLite / MySQL / MariaDB / PostgreSQL / CockroachDB / SQL Server / Oracle / ClickHouse / 达梦 DM8 / DuckDB；时序 TDengine；文档型 MongoDB；键值型 Redis；宽列 Cassandra / ScyllaDB；图数据库 Neo4j / Memgraph；向量数据库 Qdrant / Milvus / Weaviate；搜索 Elasticsearch / OpenSearch；国产协议别名 金仓 / openGauss / GaussDB / OceanBase / TiDB / PolarDB / TDSQL / GBase 8a / Doris / StarRocks / 瀚高 / Vastbase / IvorySQL / GreatSQL / GoldenDB。支持 SSH 隧道、测试连接、颜色标签、只读开关。
- 非关系型与向量基础能力：MongoDB 集合浏览与 JSON MQL；Redis DB 索引、SCAN 与命令控制台；Cassandra/ScyllaDB keyspace/table 浏览与 CQL；Neo4j / Memgraph / FalkorDB / ArangoDB 标签/集合浏览、Cypher/AQL 与交互式图视图；Qdrant / Milvus / Weaviate 集合浏览与向量检索；Elasticsearch / OpenSearch 索引/mapping 与 `_search` DSL；TDengine 超级表/子表浏览与 SQL 控制台；pgvector 关系表向量检索与 Embedding。SQL 专属功能在非 SQL 连接上明确禁用。详见 [多引擎架构](./09-multi-engine.md)。
- 对象浏览器：库/Schema → 表/视图 → 列/索引/外键，搜索过滤，刷新，完整右键菜单。
- 数据库操作：新建 / 重命名 / 删除（按引擎能力）、转储 SQL、数据库内查找、命令列、运行 SQL 文件。
- 表操作：新建、设计、重命名、复制（结构 / 结构+数据）、查看 DDL、对象信息、清空、截断、删除、维护。
- 数据网格：行号、分页、排序、可视化筛选、文本视图、单元格编辑、新增/删除行、行多选、复制 / 粘贴 / 复制行 / 批量删除、查找替换、CSV 导入、CSV/JSON/SQL/XML 导出。
- SQL 编辑器：双行工具栏、连接 / 数据库下拉、CodeMirror 6、多标签、执行选区/全部、多结果集、消息面板、查询历史、EXPLAIN、保存 / 打开 SQL 文件、查询创建工具、美化 SQL、代码段。
- 表设计器：查看/新建/修改列与索引，生成 DDL 预览并执行；外键查看。
- 备份/还原：逻辑 dump、备份列表、恢复执行、定时备份。
- 生产力工具：数据库搜索、查询构建器、结构对比/同步、数据对比、数据传输、数据生成、服务器监控、自动化任务、用户与权限、数据字典、高级对象、SQL 片段/文件、结果图表、ER SVG 导出。
- AI Agent：流式对话、37 工具、4 权限模式、计划清单、审批弹窗、会话管理、记忆四层、斜杠命令、`@` 上下文、离线推理器、Anthropic/OpenAI 兼容 Provider。
- Bridge 网关：HTTP + WebSocket、配对码、令牌、审计；移动端接入。
- 移动端：连接列表、Agent 对话、会话同步、记忆查看、只读查询、设置。
- 主题：深色/浅色；中/英 i18n（中文默认）。

### 5.2 明确不做（v0.4-dev）
- 报表设计器、可视化 ER 建模/反向工程编辑器、云协作/团队空间、HTTP Tunnel/SOCKS 代理、Excel 导入导出、行级数据 merge 同步（当前为行数/主键指纹 + 替换同步）、数据库监控历史采样、可视化编辑触发器/存储过程。
- Navicat 式跨请求事务（开始事务 / 提交 / 回滚）；当前数据编辑即时提交。
- 协同编辑、云端账号体系。
- 向量数据库已接入 Qdrant / Milvus / Weaviate 与 pgvector 能力；图数据库已接入 Neo4j / Memgraph / FalkorDB / ArangoDB 浏览、Cypher/AQL 与力导向图视图。搜索型 Elasticsearch / OpenSearch 已接入索引浏览与 `_search` DSL。
- 非关系型引擎的 DDL 设计器、结构同步、数据对比、SQL dump 备份、查询构建器与 ER 图不承诺；按 EngineMeta.capabilities 显式降级，不静默失败。

## 6. 质量目标

| 指标 | 目标 |
|---|---|
| 冷启动 | 桌面 < 2.5s 显示主界面 |
| 大结果集 | 10 万行分页浏览不卡顿（虚拟滚动） |
| Agent 首 token | 云端 < 1.5s；离线 < 300ms |
| 崩溃率 | 会话级自动恢复（未保存 SQL 草稿落盘） |
| 安全 | 破坏性操作必须经过策略判定；100% 审计落库 |
| 自动化验证 | core 单测 + 网关集成测试 + 浏览器 E2E 冒烟（桌面 Web 形态）+ 移动端类型检查/Web 冒烟 |

## 7. 术语

- **Connection**：一个数据库连接配置（含加密凭据）。
- **Bridge（网关）**：运行 Agent 与驱动的 Node 服务，桌面内置，移动远程接入。
- **Session**：一次 Agent 对话会话，跨端同步。
- **Memory**：Agent 长期记忆条目，分 fact / preference / schema / episodic / procedural。
- **Plan**：Agent 的待办清单，呈现为 Claude Code 式 Todo 列表。
- **Permission Mode**：`readonly` / `ask` / `auto` / `full`。
- **Tool Card**：对话中展示工具名、参数、耗时、结果的可折叠卡片。

## 8. 成功标准（验收）

1. 五端代码具备可构建路径：桌面可打包三平台；移动端可通过 Expo EAS 构建双平台。
2. 在无 API Key 环境下，通过 Local Reasoner 完整演示：建连接 → 浏览 → Agent 创建表 → 插入数据 → 查询 → 记忆写入 → 新会话召回。
3. 配置真实模型后，Agent 能通过原生 tool-calling 完成多步任务（含权限审批与失败重试）。
4. 文档、代码、测试三者一致：工具清单、权限矩阵、数据模型在文档与代码中一一对应。
