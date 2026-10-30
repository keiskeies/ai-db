# AiDB Studio — 命令化 Agent 工作流设计与开发计划

> 版本：v1.0 · 日期：2026-10-30 · 状态：**首版实施完成（M0–M6）**
> 关联：[AI Agent 设计](./04-ai-agent-design.md) · [Agent 准确率计划](./08-agent-accuracy-plan.md) · [数据模型与协议](./05-data-and-api.md) · [多引擎架构](./09-multi-engine.md)
>
> 本文是实施依据，不代表功能已完成。文中的表结构、接口、类型均为待落地设计；实现时必须同步本文与契约脚本。
>
> **变更记录**
> - v0.2（2026-10-30）：采纳评审意见。`/compose` 是笔误，统一为 `/compare`；PPT 先用中性模板；通知不引入邮件，后续接微信 / QQ / 飞书机器人；跨源明确为不同服务器连接（含 MySQL ↔ Redis 异构对账），与移动端无关；源数量上限固定 4；`/fix` 在 `full` 模式下仍强制备份 + 破坏性逐条审批；M6 增加 3 个全局对比工具（工具数 40 → 43）。
> - v0.1（2026-10-30）：初版。

## 0. 摘要

把 Agent 从“会调 51 个工具的聊天框”升级为“命令工作台”：用户输入 `/` 唤出命令面板，支持 ↑↓ 选择、Tab 补全、Enter 执行；`/report <文字>` 直接在 Agent 对话内执行并展示工具步骤与回答，回答下方提供复制与导出 PDF（含图表，浅色版式并强制保留饼图/图例配色），不再弹独立弹窗；裸 `/report` 只保留命令 token，等待补主题；命令表单仅保留在命令面板手动打开；选择功能，只填最少的参数，命令以确定性内核执行，模型只负责补歧义、写解释；结果落为可保存、可重跑、可定时、可导出的产物。

首批 5 个命令：

| 命令 | 一句话 | 是否依赖模型 |
|---|---|---|
| `/report` | 把数据变成可保存、可刷新、可导出的报告 | 生成时依赖；重跑不依赖 |
| `/compare` | 两个时间段 / 分组 / 查询 / 数据源的同口径分析对比 | 依赖 |
| `/diff` | 两个库的结构差异与目标方言 DDL | 不依赖 |
| `/recon` | 两个源的行级数据对账与差异归因（含 MySQL ↔ Redis 等异构源） | 不依赖 |
| `/fix` | 体检 → 修复计划 → 备份 / dry-run / 事务 / 验证 | 计划依赖；检查不依赖 |

核心决策：

1. **命令即功能**：斜线命令不是 prompt 快捷方式，而是带参数表单、独立执行路径和产物的任务入口。
2. **确定性优先**：对比、对账、行数、差值、合计全部在网关算；模型只决定结构、措辞和下一步。
3. **报告布局由语义决定**：分源章节、并排对比、合并总表、混合布局都是模型的运行时输出，但必须落在受限 DSL 上。
4. **跨库 / 跨连接是命令参数**：由表单声明 `sources` 数量与选择器，不是让模型猜连接。跨源指不同服务器上的连接，可以是异构引擎（如 MySQL ↔ Redis）；移动端只是客户端，不参与源模型。
5. **产物化**：报告、差异单、对账结果、修复单可保存、重跑、定时、导出、继续追问；不依赖当前会话历史。

明确不做：BI 看板平台、Agent 后台自动改库、任意脚本执行、v1 的 MCP / 插件市场。详见 §1.4。


## 0.1 实施进度（2026-10-30）

| 里程碑 | 状态 | 已交付 | 未完成 |
|---|---|---|---|
| M0 命令框架 | 完成 | core 注册表 / 校验；gateway CommandRunner / SSE / 取消；artifacts / artifact_runs / artifact_schedules；桌面包结构命令表单与运行卡 | — |
| M1 `/diff` | 完成 | 结构差异产物；差异页；同步到 B（确认 + 只读校验 + `/schema/sync` 审计） | 目标库强制备份尚未在命令内自动执行 |
| M2 `/recon` | 完成（首版） | SQL↔SQL、SQL↔Redis、Mongo/ES 文档对账；Redis 类型校验；映射表单；差异分类；Redis 修复快照 + 写回 + 复检 | 向量库适配器 |
| M3 `/report` | 完成（首版） | 确定性报告；Agent 查数 + `compose_report`（数字来源校验）；AI 解读；语义布局；保存 / 重跑 / 定时；XLSX 与中性 PPTX 导出 | 模板库；Agent 失败时的质量调优 |
| M4 `/compare` | 完成（首版） | 同口径 SQL 或默认行数对比；Agent 组两条同口径查询（可回退确定性）；差值 / 百分比；复用报告视图 | 更复杂的异动归因 |
| M5 `/fix` | 完成（首版） | 复用 audit_database；findings + 风险 + 修复计划；只读保护；dry-run 预览；勾选步骤 + 备份 + 输入 EXECUTE 后执行；支持的引擎且无 DDL 时自动事务，失败回滚；执行后自动复检；审计 | 逐条审批的完整会话记录（当前为步骤勾选 + EXECUTE） |
| M6 硬化 | 完成（首版） | 产物定时 + tick 集成测试；3 个全局对比工具 + 2 个 MCP 工具（工具数 45）；全局命令面板与工具箱入口；移动端命令面；通知渠道与 inbound/MCP 插件已落到 [机器人与 MCP 插件](./12-bots-and-mcp.md)；文档契约同步；E2E 报告/移动端/通知/MCP 冒烟 | 企业微信 inbound、个人微信、移动端异构 Redis 对账 |
| M7 `/init` | 完成（首版） | Agent 内联执行；AI_DB.md 交接文档（业务说明/核心表手册/Join/口径/性能/坑/全量清单）；模型可选注解；schema hash + 逐表指纹漂移；每次执行全量刷新自动段落；数据流/人工补充段落保留；后续回合自动注入摘要 | 模型注解质量评估；超大库的分段检索 |

当前验证：docs 契约 329/329；core 149/149；gateway 152 pass / 65 skipped（共 217 个用例）；commands 集成测试 18/18；Mongo/ES 文档适配器契约测试 1/1；Redis 写回实机测试 1/1；resultRef 校验测试 1/1；构建全绿；E2E 150/150 全通过（含七种图表类型切换、`/init` 文档落盘与 Electron 回答 PDF 真实导出校验）。`npm run verify` 全绿。

实现与本文的已知偏差：Agent 报告/对比依赖已配置模型，模型不可用时回退确定性统计；`compose_report` 当前用“数字必须出现在工具结果中”的来源校验，尚未把每个块绑定到 `resultRef`；`/fix` 已有步骤勾选 + 备份 + 确认执行 + 自动复检，但尚未提供事务回滚；移动端命令面已提供基础表单，异构 Redis 对账仍需桌面端。上述偏差作为后续迭代项（v2 / 模板库 / 通知机器人），不影响首版交付。

## 0.2 `/init`：数据库交接文档（AI_DB.md）

`/init` 是 Agent 内联命令，不经过 CommandSheet：`/init` 使用当前连接与库，`/init <目录>`（或直接给 `.md` 文件）指定写入位置。未指定时写到 `<home>/context/<connectionId>/<database>/AI_DB.md`；自定义路径按 `${connectionId}/${database}` 记录，后续重跑沿用。

文档按“新入职 DBA 的交接手册”组织，而不是数据字典：

| 章节 | 内容 | 生成方式 |
|---|---|---|
| 0 一页速览 | 引擎、环境/只读、规模、覆盖、结构指纹、生成时间 | 确定性 |
| 1 这个库是干什么的 | 业务说明、核心实体、术语 | 模型草案 / 人工补充 |
| 2 数据地图与关联 | ER 图 + Join 清单（ON、基数、来源） | 外键/人工关系确定性；模型补语义关联 |
| 3 核心表手册 | 用途、粒度、主键、关键字段、“查它时关联谁”、注意点 | 核心表按外键度/行数/查询历史/人工上下文打分选出 |
| 4 指标口径与标准 SQL | 人工确认的 glossary / sql_example、近期成功 SQL、模型草案 | 记忆 + 模型（inferred） |
| 5 数据流与新鲜度 | 上游、同步方式、延迟、归档 | 人工维护，`/init` 不覆盖 |
| 6 查询须知与性能 | 大表、无主键、外键缺索引、查询规则 | 确定性 + 模型补充 |
| 7 常见任务 Recipe | 端到端 SQL 骨架 | 模型草案 + 近期实际 SQL |
| 8 坑与已知问题 | 金额单位、软删除、多租户列、禁用表/列 | 确定性启发式 + 模型补充 |
| 9 附录全量清单 | 所有表/视图、行估算、主键、外键数、备注 + 机器清单 | 确定性，全量 |

几条硬约束：

1. **全量清单不依赖模型**：`/init` 程序化枚举当前库全部表/视图；模型只能在核心表上补充用途、粒度、Join、指标和坑，不能删表。附录 + `aidb:inventory` JSON 保证不会出现“重要表被 init 忽略”。
2. **文档不是白名单**：每回合仍注入完整 schema；提示词明确“文档里没有的表仍然存在，schema/工具结果优先”。
3. **漂移检测**：frontmatter 存整体 `schema_hash`，附录存逐表指纹；每次对话比对，发现新增/删除/改表就在提示词里标注 `STALE` 并列出表名，提示重跑 `/init`。
4. **自动内容必须保鲜**：每次 `/init` 重新读取 schema，重写全部自动段落（业务地图、核心表手册、Join、指标、性能、坑、全量清单），新增/删除表、改列、关系变化立即反映；不会因为“这段被人改过”而长期保留旧内容。需要人工长期维护的内容写在两个 manual 段落（数据流与新鲜度、人工补充），只有它们不覆盖。旧文件没有 aidb 标记时先写 `.bak-<时间戳>` 再生成。
5. **不采样数据**：只读取 schema、行数估算、外键、索引、注释与已有记忆；不查询业务行，不写凭据。
6. **模型可选**：离线/无模型时仍生成完整确定性文档，只是业务说明与 Join 建议标注为未生成；配置模型后重跑即可补齐。

当前验证：生成器单测覆盖“全量清单、核心表不丢、人工段落保留、漂移检测、路径选择”；网关集成测试覆盖 `/init` 生成与自定义目录记忆；E2E 覆盖斜杠入口、内联执行与文件落盘。`AI_DB.md` 自动加载摘要的 prompt 块在 `apps/gateway/src/features/databaseBrief.ts`。

## 1. 背景、问题与目标

### 1.1 现状

- 斜线命令目前只是把一段固定文本填进输入框（`apps/desktop/src/components/AgentPanel.tsx` 的 `SLASH`），没有参数、没有独立执行，也没有产物。
- Agent 的工具是 51 个静态定义（`packages/core/src/agent/tools.ts`），执行集中在 `apps/gateway/src/executor.ts`，风险分级与审批绑定在这份清单上。
- Agent 上下文只带一个连接（`AgentRunInput.connection`、`AgentContextData.connection`），系统提示里只有一行 `Connection:`（`packages/core/src/agent/prompt.ts`）。
- 工具箱里已经有一套确定性能力：结构对比 `apps/gateway/src/features/schemaCompare.ts`、数据对比 `apps/gateway/src/features/compareData.ts`、跨连接传输 `apps/gateway/src/features/transfer.ts`，以及定时查询 / 备份调度器 `apps/gateway/src/scheduler.ts`。但它们与 Agent、会话、产物是割裂的。
- 定时任务只有 `query` 与 `backup` 两种类型，不能保存和刷新一份报告。

### 1.2 要解决的问题

| 编号 | 问题 | 后果 |
|---|---|---|
| P1 | 每件事都要重新组织提示词 | 难发现、难复用，新用户不知道 Agent 能做什么 |
| P2 | 结果只留在对话流里 | 不能保存、重跑、定时、导出，关掉会话就丢了 |
| P3 | 跨库 / 跨连接要靠文字描述 | 模型可能选错连接，用户也无法用表单确认范围 |
| P4 | 对比和合计交给模型算 | 与现有准确率守卫冲突，存在算错和“近似估算”风险 |
| P5 | 工具箱与 Agent 是两套入口 | 同一能力两套实现、两套交互，维护成本翻倍 |
| P6 | 报告没有“对象” | 只能一次性生成，不能作为长期资产刷新与对比 |

### 1.3 目标

- **G1 独立入口**：每个能力都能从 `/`、全局命令面板、工具箱、移动端启动，不依赖会话历史。
- **G2 参数化跨源**：连接、库、表、时间范围、容差、输出格式都是表单字段；`sources` 支持 1..4。
- **G3 数字可信**：所有数字、差异、合计由网关确定性计算；模型不能重算、估算或改写。
- **G4 产物可运营**：报告 / 差异单 / 对账结果 / 修复单可保存、重跑、定时、导出、对比历史。
- **G5 共享底座**：命令与聊天共用工具执行、权限、审批、审计、记忆与业务上下文。
- **G6 可扩展**：命令注册表是未来“安装 skill”的同一套底座；外部 skill 只增加定义，不改执行器。

### 1.4 非目标

- 不做 BI 看板 / 报表设计器 / 数据大屏。报告的定位是“问题的答案”，不是拖拽式可视化平台。
- 不做后台自动写库。所有写操作必须由用户显式发起并经过审批。
- 不在 v1 执行任意 JavaScript / Python / Shell。命令内只允许声明式工具与 SQL。
- 不在 v1 做 MCP 客户端或插件市场；命令注册表为它们预留扩展位。
- 不改变现有 51 个 Agent 工具的语义与风险等级；命令私有工具独立管理（§4.6）。

### 1.5 设计原则

1. **命令是任务，不是提示词**：一个命令由入口、参数、执行计划、产物四部分组成。
2. **确定性内核 + 模型解释**：能直接算的绝不交给模型；模型负责选择、组织和解释。
3. **数字有出处**：报告与对比中的每个数字都绑定到一次真实工具结果的引用，渲染器解析，不让模型手写。
4. **语义决定布局，DSL 约束表达**：布局自由，块类型受限；模型不能自由写 HTML。
5. **权限只能收紧**：命令声明的风险上限不能被命令本身绕过；只读连接永远不能执行写操作。
6. **复用而不是复制**：结构对比、数据对比、传输、调度器、图表、审批、审计全部复用现有实现。

## 2. 命令面

### 2.1 用户旅程

**A. 周报**

1. 输入 `/report`，选择生产库与预发库两个源，填写“本周订单与履约情况”，输出选 PPT。
2. Agent 读取两个源的 schema，按语义选择“分源章节 + 末尾对比”的混合布局。
3. 每个数据块执行聚合 SQL；数字由网关计算并绑定引用；Agent 写解读。
4. 报告落为产物，用户保存为“双库订单周报”，设为每周一 09:00 刷新，导出 PPT。

**B. 跨服务器对账**

1. 输入 `/recon`，源 A 选 MySQL 的 `users` 表，源 B 选另一台服务器上的 Redis，键模式填 `user:*`，值类型选 hash。
2. 配置映射：MySQL `id` ↔ Redis 键里的数字；`name` / `email` / `status` ↔ hash 字段。
3. 网关分别读取两侧数据（Redis 用 `SCAN`，不用 `KEYS`），在网关侧比对，输出缺失 / 多余 / 改值 / 类型漂移。
4. 用户下钻到样本，确认后生成“补齐 / 更新”方案；v1 只生成方案不执行 Redis 写操作，执行是独立的第二步。

同构表对表（旧库 ↔ 新库）使用同一个命令，只是映射从“列 ↔ 列”变成“列 ↔ 列”，不需要键模式。

**C. 上线前结构检查**

1. 输入 `/diff`，A 选预发库，B 选生产库，勾选包含删除。
2. 生成目标方言 DDL 差异单，破坏性语句单独标红。
3. 同步是独立动作：备份目标库、确认、执行、验证；`/diff` 本身只读。

**D. 指标异动**

1. 输入 `/compare`，A 选“本周”，B 选“上周”，指标选订单额，按天分组。
2. 两侧使用同一口径查询；网关计算差值、占比、贡献 TopN；Agent 解读。
3. 结果可保存为对比卡，继续追问“哪个渠道贡献最大”。

**E. 体检修复**

1. 输入 `/fix`，选择连接与范围，先跑检查（缺主键、外键缺索引、重复索引、空表、空值率、重复主键）。
2. 生成修复计划：每条 SQL、风险、回滚方式、验证查询。
3. 破坏性步骤逐条审批；执行前备份；能事务的引擎在事务内执行，验证后提交。

### 2.2 命令清单

| 命令 | 别名 | 源数量 | 执行方式 | 风险上限 | 产物 | 需要模型 |
|---|---|---|---|---|---|---|
| `/report` | `/报表` | 1..4（schema 源） | 混合（Agent 规划 + 确定性取数 / 渲染） | read | report | 生成时需要；重跑不需要 |
| `/compare` | `/对比` | 1..2（可查询源） | 混合 | read | compare | 需要 |
| `/diff` | `/结构对比`、`/schema-diff` | 2（结构化源） | 确定性 | read | diff | 不需要 |
| `/recon` | `/对账`、`/data-diff` | 2（允许异构） | 确定性 | read | recon | 不需要 |
| `/fix` | `/体检`、`/修复` | 1 | 混合 | destructive | fix | 计划需要；纯检查不需要 |
| `/ask` | 无 | 0..1 | Agent | 沿用全局权限 | 无 | 需要 |

说明：

- `sources=1..2` 不等于只能跨连接：`/compare` 的 A/B 可以是同一连接的两个时间段或两个分组。
- 跨源指不同服务器上的连接，允许异构引擎：`/recon` 支持 SQL 表 ↔ Redis 键空间；`/diff` 只对可结构化的对象生效，Redis 这类无 schema 源不参与结构对比。
- `/diff` 的“同步”、`/recon` 的“修复 / 同步”、`/fix` 的“执行”都是独立动作，不包含在只读命令本身里。
- `/fix` 的 `mode` 槽位：`check`（只检查，风险 read）与 `repair`（生成并执行计划，风险 destructive）。默认 `check`。
- 源数量上限固定为 4；`/recon` 与 `/diff` 恰好 2 个源，`/fix` 1 个源。

### 2.3 入口

四处入口共享同一个命令注册表：

1. **输入框 `/`**：按分组展示命令；选中后展开参数表单，不直接发送。
2. **全局命令面板**：与现有 `CommandPalette` 合并；搜索命令名、别名、描述。
3. **工具箱**：现有确定性工具（结构对比、数据对比、传输）保留，同时提供“在 Agent 中以命令打开”。
4. **移动端**：底部弹层表单；同一套定义经 `GET /commands` 下发。

“单独使用”的判定标准：命令可以在没有会话历史、没有当前选中表、甚至没有配置模型的情况下启动（确定性命令）；执行结果有独立产物，不依赖聊天上下文。

### 2.4 交互状态机

```
idle
  → form（选择命令、填参数）
  → validating（本地校验 + 服务端校验）
  → queued
  → running
      → waiting_approval（需要审批时）
      → running
  → succeeded / failed / canceled
  → artifact（打开、保存、重跑、定时、导出、继续追问）
```

任何状态都允许取消；`waiting_approval` 取消视为拒绝；`running` 取消后保留已完成步骤的结果，状态标记 `canceled`。

### 2.5 表单槽位

| 槽位类型 | 用途 | 校验 |
|---|---|---|
| `source` | 选择一个连接（可带数据库） | 连接存在、非离线、在命令允许的数量内 |
| `sources` | 选择 1..N 个源 | 去重；数量在 `sources.min..max` 内；跨连接时每源必须有唯一标签 |
| `database` | 选择库 / schema | 属于对应连接；非关系型引擎按对象容器处理 |
| `tables` | 多选表 / 集合 | 属于对应源；上限由命令声明 |
| `text` | 主题、问题、说明 | 长度上限；不允许空 |
| `period` | 时间范围或相对区间 | 开始 ≤ 结束；时区使用连接设置 |
| `enum` | 级别、模式、输出格式 | 枚举内 |
| `number` | 容差、限额、周期数 | 范围与步长 |
| `boolean` | 包含删除、严格模式、刷新叙述 | 默认值明确 |
| `mapping` | 异构对账的键 / 字段映射（仅 `/recon`） | 键映射唯一；字段映射不重复；两侧类型可归一 |

表单规则：

- **必填最少化**：`/report` 只强制源 + 主题；表、时间、指标都可以留空由 Agent 探索。
- **上下文带入**：当前连接、当前库、当前选中表自动填入；用户可改。
- **记住上次**：按命令记住上次的源、输出格式与高级选项，不记住敏感内容。
- **高级选项**：容差、规范化、包含删除、最大行数、叙述刷新等放在折叠区，默认值可解释。
- **布局不是字段**：报告布局不由用户选择；高级区只提供“允许 Agent 自行决定 / 强制指定”这一覆盖项，默认自行决定。
- **复杂表单用专用组件**：`/recon` 的键 / 字段映射通过 `form: 'recon'` 渲染专用表单（`ReconForm`），通用槽位仍由注册表声明；不让通用表单硬塞十几种条件字段。

### 2.6 旧命令迁移

| 旧命令 | 新行为 |
|---|---|
| `/schema` | 转为 `/report`，预填主题“梳理当前库结构”，输出屏幕 |
| `/audit` | 转为 `/fix`，`mode=check` |
| `/quality` | 转为 `/fix`，`mode=check`，范围=当前表 |
| `/chart` | 转为 `/report`，预填“按当前表做分组统计图”，输出=图表 |
| `/explain`、`/optimize` | 保留为 `/ask` 的专用提示模板，不进入首批命令 |
| `/backup` | v1 保留 Agent 工具调用；后续按注册表迁移为确定性命令 |
| `/memory`、`/clear` | 保留为 UI 动作，不是业务命令 |

迁移期两套入口并存，但新命令必须有注册表定义；旧入口只做重定向，不再维护独立提示词。

### 2.7 命名与国际化

- 命令 id 使用英文短词（`report`、`compare`、`diff`、`recon`、`fix`），斜线形式 `/report`。
- 中文别名（`/报表`、`/对账`、`/体检`）与英文别名都可搜索、可执行。
- 不保留 `/compose`：评审确认它是笔误，统一使用 `/compare`。
- UI 文案走 i18n 字典；命令标题、描述、槽位标签都由注册表提供中英文字段。

## 3. 命令注册表

### 3.1 位置与导出

新增目录：

```
packages/core/src/commands/types.ts       命令类型
packages/core/src/commands/registry.ts    内置命令定义
packages/core/src/commands/validate.ts    定义校验与槽位校验
packages/core/src/commands/index.ts       导出
```

`packages/core/src/index.ts` 增加 `export * from './commands'`，桌面端、移动端、网关共用同一份定义。

### 3.2 类型

```ts
export type CommandId = 'report' | 'compare' | 'diff' | 'recon' | 'fix' | 'ask';
export type CommandExecution = 'deterministic' | 'agent' | 'hybrid';
export type CommandGroup = 'analysis' | 'compare' | 'ops' | 'general';
export type ArtifactType = 'report' | 'compare' | 'diff' | 'recon' | 'fix';

export interface CommandSourceSpec {
  min: number;
  max: number;
  /** 是否允许同一连接出现两次（例如同一连接的两个库）。 */
  allowSameConnection: boolean;
  /** 是否需要显式选择数据库。 */
  database: 'optional' | 'required' | 'none';
}

export type CommandSlotKind =
  | 'source'
  | 'sources'
  | 'database'
  | 'tables'
  | 'text'
  | 'period'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'mapping';

export interface CommandSlot {
  key: string;
  kind: CommandSlotKind;
  label: { zh: string; en: string };
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: { zh: string; en: string } }>;
  min?: number;
  max?: number;
  default?: unknown;
  /** 高级选项默认折叠。 */
  advanced?: boolean;
}

export interface CommandDefinition {
  id: CommandId;
  aliases: string[];
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  group: CommandGroup;
  icon: string;
  sources: CommandSourceSpec;
  slots: CommandSlot[];
  execution: CommandExecution;
  maxRisk: Risk;
  artifact?: ArtifactType;
  /** 自定义表单渲染器；默认 'default'，/recon 使用 'recon'。 */
  form?: 'default' | 'recon';
  /** 命令内允许调用的全局工具；缺省继承全局权限。 */
  allowedTools?: string[];
  /** 命令私有工具（只在本命令的 Agent 步骤中可见，不进入 40 工具目录）。 */
  extraTools?: string[];
  /** 生成阶段使用的系统提示片段。 */
  prompt?: string;
}
```

### 3.3 内置命令定义（摘要）

| id | group | sources | execution | maxRisk | allowedTools / extraTools |
|---|---|---|---|---|---|
| `report` | analysis | 1..4，schema 源 | hybrid | read | 只读工具 + `compose_report` |
| `compare` | analysis | 1..2，可查询源 | hybrid | read | 只读工具 + `compose_report` |
| `diff` | compare | 2，结构化源 | deterministic | read | 不进入 Agent |
| `recon` | compare | 2，跨连接、允许异构 | deterministic | read | 不进入 Agent；`form: 'recon'` |
| `fix` | ops | 1，跨连接关闭 | hybrid | destructive | 审计 / 质量 / 备份 / 事务 / 运行 SQL + `submit_fix_plan` |
| `ask` | general | 0..1 | agent | 继承全局 | 全部 40 工具 |

### 3.4 校验

模块加载时执行一次静态校验，运行时执行一次输入校验：

- id 唯一、别名唯一（大小写不敏感）。
- `sources.min >= 0`、`max >= min`、`max <= 4`。
- `slots` 的 key 唯一；`source` 槽位数量与 `sources` 声明一致。
- `execution=deterministic` 不允许声明 `extraTools`。
- `maxRisk` 不能低于 `allowedTools` 中任一工具的风险。
- 输入校验：源数量、库归属、表归属、时间范围、枚举、数字范围；错误返回结构化字段，前端定位到具体槽位。

### 3.5 UI 渲染

- 不再为每个命令写独立弹窗；`CommandSheet` 根据 `slots` 通用渲染。
- 槽位控件映射：`source` → 连接选择器；`sources` → 可增删的源卡片；`database` → `DatabaseSelect`；`tables` → 带搜索的多选；`period` → 时间范围；`enum` → 分段控件；`number` → 数字输入；`boolean` → 开关。
- 命令执行视图也由注册表驱动：`artifact` 类型决定结果渲染器（report / diff / recon / fix / compare）。
- 注册表新增字段必须同时更新本表与契约脚本，避免 UI 与执行器漂移。

### 3.6 与未来 skill 的关系

外部 skill 的形态是“命令包”：一个目录包含 `command.json`（或 `SKILL.md` frontmatter）与可选提示词、SQL 模板、工具声明，映射为 `CommandDefinition`。v1 只做内置命令；注册表字段（`extraTools`、`prompt`、`sources`）已经为它预留。安装、启停、版本与信任模型不在本计划内。

## 4. 执行引擎

### 4.1 组件关系

```
desktop / mobile
   │  POST /commands/:id/runs
   ▼
CommandRunner (gateway)
   ├─ deterministic step ──► features/schemaCompare | compareData | transfer | services
   ├─ deterministic step ──► reconcileData | reportRender | export
   ├─ agent step ─────────► AgentHost (AgentRuntime) + 命令私有工具
   ├─ artifact store ─────► artifacts / artifact_runs / artifact_schedules
   └─ SSE ────────────────► 进度、审批、结果
```

### 4.2 步骤模型

```ts
export type CommandStepKind = 'deterministic' | 'agent';

export interface CommandStepResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: { code: string; message: string; hint?: string };
  meta?: { durationMs: number; rows?: number; truncated?: boolean };
}

export interface CommandStep {
  id: string;
  label: { zh: string; en: string };
  kind: CommandStepKind;
  run(ctx: CommandContext): Promise<CommandStepResult>;
}

export interface CommandContext {
  runId: string;
  command: CommandDefinition;
  input: CommandRunInput;
  sources: CommandSource[];
  signal: AbortSignal;
  emit(event: CommandRunEvent): void;
  storeStepResult(stepId: string, result: CommandStepResult): void;
}
```

每个步骤的结果都进入 `artifact_runs.steps_json`，报告和对比通过 `resultRef` 引用，渲染器不重新查库。

### 4.3 运行状态

| 状态 | 含义 | 可取消 |
|---|---|---|
| `queued` | 已创建，等待执行 | 是 |
| `running` | 至少一个步骤执行中 | 是 |
| `waiting_approval` | 等待用户审批 | 是（视为拒绝） |
| `succeeded` | 全部步骤成功，产物已保存 | 否 |
| `failed` | 任一步骤失败且不可恢复 | 否 |
| `canceled` | 用户取消 | 否 |

### 4.4 进度与 SSE

`POST /commands/:id/runs` 返回 `{ run }` 后，客户端连接 `GET /commands/runs/:id/events`：

```ts
type CommandRunEvent =
  | { type: 'run_started'; runId: string; command: CommandId; startedAt: string }
  | { type: 'step_started'; runId: string; stepId: string; label: string; kind: CommandStepKind }
  | { type: 'step_progress'; runId: string; stepId: string; message: string; current?: number; total?: number }
  | { type: 'step_succeeded'; runId: string; stepId: string; summary: string; durationMs: number }
  | { type: 'step_failed'; runId: string; stepId: string; error: { code: string; message: string } }
  | { type: 'approval_required'; runId: string; approvalId: string; stepId: string; payload: ApprovalPayload }
  | { type: 'artifact_ready'; runId: string; artifactId: string; type: ArtifactType; title: string }
  | { type: 'run_finished'; runId: string; status: 'succeeded' | 'failed' | 'canceled'; durationMs: number }
  | { type: 'error'; runId: string; code: string; message: string };
```

约定：

- 事件带单调递增 `seq`，便于断线重连时从 `?after=seq` 恢复。
- 心跳每 15 秒一次，避免代理超时。
- 最终状态以 `run_finished` 为准；客户端断线后通过 `GET /commands/runs/:id` 对齐。
- 确定性命令不产生 `text_delta`；Agent 步骤的文本仍通过 `text_delta` / `thinking_delta` 事件，沿用现有 Agent 协议。

### 4.5 取消、超时与并发

- 每个 run 持有 `AbortController`；取消贯穿确定性查询、Agent 调用与导出。
- 单步骤默认超时 60 秒，查询类沿用 `settings.queryTimeoutMs`；对账按表分批，每批单独计时。
- 同一 artifact 同时只允许一个 run；同一命令允许有限并发（默认 2），避免打满连接池。
- 取消后释放数据库游标 / 连接；事务步骤取消时回滚。
- 进程重启后，`running` 的 run 标记为 `failed`（`process restarted`），不做自动续跑。

### 4.6 Agent 步骤与命令私有工具

Agent 步骤复用 `AgentHost` / `AgentRuntime`，但增加三项能力：

1. **工具白名单**：`AgentRuntimeDeps` 增加可选 `tools?: ProviderTool[]`，命令步骤只下发声明过的工具。现有全量模式保持默认。
2. **命令私有工具**：命令定义中的 `extraTools` 只在该命令的 Agent 步骤中注入，处理器注册在 `apps/gateway/src/commands/tools.ts`。它们不进入 `/agent/tools`、不进入 40 工具目录、不能从 `/ask` 调用。
3. **多源上下文**：见 §5。

首批命令私有工具：

| 工具 | 用途 | 风险 | 校验 |
|---|---|---|---|
| `compose_report` | 提交 ReportSpec，绑定结果引用并生成报告产物 | read | 源匹配、引用存在、数字块不含手写值、占位符可解析 |
| `submit_fix_plan` | 提交结构化修复计划 | read | 每条 SQL 有风险 / 回滚 / 验证；破坏性步骤必须标记 |

`compose_report` 失败时返回具体字段错误，Agent 可以修正后重试；最多重试 2 次，避免死循环。模型不可用时，`/report` 走确定性降级模板（§7.11），`/diff` 与 `/recon` 不受影响。

### 4.7 审计

每个步骤写一条 `audit_log`：

- `tool`: `command.<commandId>.<stepId>`；
- `risk`: 该步骤实际风险；
- `approval`: `none` / `manual` / `scheduled`；
- `meta`: `runId`、`artifactId`、`sources`、`rows`、`durationMs`；
- SQL 步骤记录完整 SQL；对账记录读取范围与限额。

审计是“命令真的执行过”的唯一依据，不能用 UI 日志替代。

### 4.8 错误模型

| code | 场景 | 用户提示 |
|---|---|---|
| `COMMAND_NOT_FOUND` | id / 别名不存在 | 命令不存在 |
| `INVALID_INPUT` | 槽位校验失败 | 定位到字段 |
| `SOURCE_UNAVAILABLE` | 连接离线 / 不存在 | 源不可用 |
| `SOURCE_READONLY` | 在只读源上执行写操作 | 目标为只读 |
| `APPROVAL_DENIED` | 用户拒绝 | 已取消 |
| `APPROVAL_TIMEOUT` | 审批超时 | 审批已过期 |
| `MODEL_REQUIRED` | 需要模型但未配置 | 配置模型或使用确定性模式 |
| `MODEL_FAILED` | 模型调用失败 | 可重试 / 降级 |
| `RECON_LIMIT` | 超出对账限额 | 缩小范围或提高限额 |
| `RECON_NO_KEY` | 无主键且未指定键 | 需要指定业务键 |
| `RECON_MAPPING_REQUIRED` | 异构源未配置键 / 字段映射 | 需要补全映射 |
| `RECON_UNSUPPORTED_TYPE` | Redis list / set / zset / stream | v1 不支持该类型 |
| `RECON_KEY_PATTERN` | 键模式无效或提取结果不唯一 | 检查 `keyPattern` / `keyExtract` |
| `RECON_SCAN_LIMIT` | 超过扫描上限 | 缩小范围或提高上限 |
| `EXPORT_FAILED` | 导出失败 | 检查路径 / 格式 |
| `CANCELED` | 用户取消 | 已取消 |

## 5. 多源上下文

### 5.1 差距

当前 `AgentRunInput`、`AgentContextData`、`buildSystemPrompt` 与 `AgentHost` 都以单连接为中心：

- 系统提示只有一行 `Connection:`；
- schema 只来自一个连接；
- 本地推理器 `LocalProvider` 也只认 `ctx.connection`。

跨源命令必须先把这层改成“命令选中的源集合”，同时保持 `/ask` 旧行为不变。

这里的“跨源”指**不同服务器上的连接**，可以是异构引擎（例如 MySQL ↔ Redis）；它与移动端无关，移动端只是命令的一个客户端。异构源是否能用 Agent 步骤，取决于该源有没有可描述的 schema：Redis / 键值源只参与确定性对账，不进入报告的多表 schema 推断。

### 5.2 类型改造（增量）

```ts
export interface AgentSourceContext {
  connection: ConnectionConfig;
  /** 该源的 schema；同一连接多个库时合并为一个数组。 */
  databases: DatabaseSchema[];
  agentContext?: AgentContextBundle;
  glossary?: Memory[];
  sqlExamples?: Memory[];
  /** 表单里的显示名，例如“生产库”“预发库”。 */
  label?: string;
}

export interface AgentContextData {
  /** 兼容旧路径：主连接。 */
  connection?: ConnectionConfig;
  databases?: DatabaseSchema[];
  /** 新增：命令选中的源；存在时优先于 connection/databases。 */
  sources?: AgentSourceContext[];
  memories?: Memory[];
  agentContext?: AgentContextBundle;
  glossary?: Memory[];
  attachmentTables?: string[];
}
```

`AgentRunInput` 保持 `connection` 字段（兼容 `AgentHost` 的旧调用），新增可选的 `sources`。`buildSystemPrompt` 在 `sources` 存在时输出多源结构；否则走原有单连接分支，确保 `/ask` 输出与改动前一致。

### 5.3 提示词结构

多源模式：

```text
## Connections (2)
- [c_prod] label=生产库 name=prod-mysql engine=mysql database=shop env=prod readonly=true
- [c_stg]  label=预发库 name=stg-pg    engine=postgresql database=shop env=staging readonly=false

## Schema
### [c_prod] database: shop
...
### [c_stg] database: shop
...
```

规则：

- 每个工具调用的 `connectionId` 必须是上面列出的 id 之一；不得使用库名、连接名或引擎名。
- 源之间不能假设可以互相 JOIN；跨源比对由命令的确定性步骤完成，模型只解释结果。
- 涉及多个源时，每个结论必须标明来源标签。
- 只读源不得生成写操作；只读模式下的写工具仍会被策略拒绝。
- 非关系型源在 `## Schema` 中使用对象 / 键空间描述（如 Redis `user:*`、Mongo 集合），不得把键空间伪装成表；无法结构化描述的源只用于确定性对账。

### 5.4 预算

- 单命令最多 4 个源，固定上限；`/ask` 仍为 1 个主连接。
- 每个源最多 15 张表带列，总计最多 120 张表名；超出时只保留表单选中的表与业务上下文标注过的表。
- 对账 / 结构对比的确定性步骤不把全量 schema 注入 prompt；只有 Agent 步骤（报告 / 对比 / 修复计划）需要。
- 多源 prompt 超出预算时按“选中的表 > 业务上下文标注的表 > 其余按字母序”截断，并在 prompt 里写明截断数量。

### 5.5 工具调用与连接归属

- `executor` 当前按调用参数中的 `connectionId` 执行；新增校验：该 id 必须属于当前命令的源集合（`/ask` 保持原有“属于当前会话”校验）。
- 跨源命令的 Agent 步骤只允许调用 `allowedTools`；写工具一律不在报告 / 对比命令的白名单里。
- 连接失效时返回 `SOURCE_UNAVAILABLE`，不自动回退到其他连接。

### 5.6 本地推理器限制

`LocalProvider` 只支持单源。使用本地推理器时：

- `/diff`、`/recon` 正常（不经过模型）；
- `/report` 走确定性模板，不生成 AI 叙述；
- `/compare` 只做确定性差值，不生成解读；
- UI 在命令表单上提示“本地推理器仅支持单源，报告叙述已降级”。

## 6. 产物模型

### 6.1 产物类型

| 类型 | 内容 | 可重跑 | 可定时 | 可导出 |
|---|---|---|---|---|
| `report` | ReportSpec + 每次运行的步骤结果 | 是（SQL 重放） | 是 | 屏幕 / XLSX / PDF / PPTX |
| `compare` | 对比规格 + 两次查询结果 + 差值 | 是 | 是（可选） | 屏幕 / XLSX |
| `diff` | 两侧源 + 结构差异 + DDL | 是 | 否 | 屏幕 / SQL |
| `recon` | 两侧源 + 对账级别 + 映射 + 差异明细（同构 / 异构） | 是 | 是（巡检） | 屏幕 / XLSX / CSV |
| `fix` | 检查结果 + 修复计划 + 执行记录 | 重跑默认回到 `check` | 否 | 屏幕 / SQL |

### 6.2 生命周期

- **draft**：Agent 正在生成 / 用户正在编辑参数，不对外可见；
- **ready**：规格已保存，可运行；
- **running**：有运行中的 run；
- **error**：最近一次运行失败，保留上次成功结果；
- 每次运行生成一个 `artifact_run`，历史保留最近 20 次；报告可对比“本次 vs 上次”。

### 6.3 数据表

新增表（SQLite，`SCHEMA_SQL` 追加，`user_version` 4 → 5）：

```sql
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('report','compare','diff','recon','fix')),
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('draft','ready','running','error')),
  schedule_id TEXT,
  origin_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type, updated_at DESC);

CREATE TABLE IF NOT EXISTS artifact_runs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','canceled')),
  input_json TEXT,
  steps_json TEXT,
  result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_runs ON artifact_runs(artifact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_schedules (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  interval_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  refresh_narrative INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_schedules ON artifact_schedules(enabled, last_run_at);
```

约定：

- `spec_json` 只存规格（源、SQL、块结构、选项），不存大结果；大结果在 `artifact_runs.steps_json`。
- `steps_json` 是 `{ [stepId]: { sql?, result, meta } }`，报告块用 `resultRef = stepId` 引用。
- 导出的文件不复制进数据库，只记录路径与时间（与现有备份 / 导出策略一致）。
- `artifact_schedules` 独立于现有 `jobs`（`jobs.type` 只有 query/backup，且 SQLite 的 CHECK 不便迁移）；调度器同时 tick 两张表。

### 6.4 产物 API

见 §13。所有产物接口都要求 `artifactId` 存在；跨源产物在 `spec_json.sources` 中记录连接 id 与标签，删除连接不级联删除产物，但重跑会返回 `SOURCE_UNAVAILABLE`。

### 6.5 清理

- 每个 artifact 保留最近 20 次运行；超出按时间删除最旧。
- 失败运行保留最近 5 次，便于排查。
- 删除 artifact 级联删除 runs 与 schedule。
- 导出文件由用户管理，不自动删除。

### 6.6 定时

- `artifact_schedules` 由 `JobScheduler` 的新 tick 分支处理，间隔沿用 15 秒检查。
- 报告重跑默认不调用模型：按 `spec_json` 中的 SQL 重新取数，占位符重新解析；叙述文本标记“生成于某次运行”，可开启 `refresh_narrative` 让模型每次重写。
- 对账巡检默认只跑 `counts` 级别，避免全量键比对拖垮生产库；升级级别必须手动。
- 定时运行失败只记录状态与错误，不自动重试；连续失败 3 次在 UI 标记，不自动停用（避免静默失效）。

## 7. `/report` 详细设计

### 7.1 输入

| 槽位 | 必填 | 说明 |
|---|---|---|
| `sources` | 是 | 1..4 个源；跨连接时每个源有显示名 |
| `topic` | 是 | 自然语言主题，例如“本周订单与履约情况” |
| `period` | 否 | 时间范围；留空由 Agent 根据数据推断并确认 |
| `tables` | 否 | 关注表；留空由 Agent 搜索 |
| `format` | 是 | `screen` / `xlsx` / `pdf` / `pptx`，默认 `screen` |

源限制：`/report` 只接受有 schema 的连接（SQL / 文档 / 搜索等可描述对象的源）；Redis 等键值源不进入多表报告，改用 `/recon` 或 `/compare` 的确定性路径。选到不支持的源时表单直接禁用并说明原因。

用户不选择“分源章节 / 合并总表”。布局由 Agent 根据语义选择；高级选项可强制覆盖。

### 7.2 语义布局

| 用户语义信号 | 布局 | 例子 |
|---|---|---|
| “分别 / 各自 / 每个库 / 按源” | `sections` | “分别看看两个库的订单情况” |
| “对比 / 相比 / 差异 / 哪个更高” | `comparison` | “对比 A 库和 B 库本月订单额” |
| “汇总 / 合计 / 一共 / 总体”且指标可加 | `merged` | “两个库加起来一共有多少订单” |
| “综合 / 全面 / 周报 / 经营情况” | `mixed` | “生成一份本周经营周报” |
| 单源 | `sections` | “给我一份订单周报” |

规则：

- 默认按上表；语义冲突时以“用户明确问的动词”为准（“对比”优先于“分别”）。
- 可加指标包括 `COUNT`、`SUM`；比率、去重计数、分位数不可直接相加，必须分源展示并说明“不可合并”。
- `merged` 布局必须包含一个“口径说明”块，列出源、时间范围、指标定义、不可合并项。
- 无法判断时只问一个问题：“你是想分别看两个库，还是合并成一个总数？”不连续追问。
- 布局判断写在命令提示词中，不写进表单；`compose_report` 只校验块结构与引用，不替模型选布局。

### 7.3 ReportSpec DSL

```ts
export type ReportLayout = 'sections' | 'comparison' | 'merged' | 'mixed';
export type ReportBlockKind = 'narrative' | 'metric' | 'chart' | 'table' | 'comparison' | 'callout';

export interface ReportSourceRef {
  key: string;              // 'a' | 'b' ...
  connectionId: string;
  connectionName: string;
  database?: string;
  engine: string;
  label: string;
}

export interface MetricRef {
  resultRef: string;        // 步骤 id / 工具调用 id
  valuePath: string;        // 结果 JSON 路径，例如 'rows.0.total'
  sourceKey?: string;
  label?: string;
}

export interface ReportBlock {
  kind: ReportBlockKind;
  title?: string;
  /** narrative：支持 {{ref:stepId.path}} 占位符，由渲染器解析。 */
  text?: string;
  tone?: 'info' | 'warning' | 'danger';
  /** metric：refs 为多源时可合并。 */
  label?: string;
  refs?: MetricRef[];
  combine?: 'sum' | 'none';
  unit?: string;
  /** chart / table 绑定一个已执行的结果引用。 */
  resultRef?: string;
  chartType?: 'bar' | 'line' | 'pie';
  x?: string;
  y?: string;
  ys?: string[];
  stacked?: boolean;
  columns?: string[];
  maxRows?: number;
  /** comparison：左右各一个指标引用。 */
  left?: MetricRef;
  right?: MetricRef;
  deltaMode?: 'absolute' | 'percent' | 'both';
}

export interface ReportSection {
  id: string;
  title: string;
  sourceKey?: string;
  blocks: ReportBlock[];
}

export interface ReportSpec {
  version: 1;
  title: string;
  subtitle?: string;
  layout: ReportLayout;
  sources: ReportSourceRef[];
  sections: ReportSection[];
  meta: {
    intent: string;
    createdAt: string;
    model?: string;
    notes?: string[];
  };
}
```

约束：

- `metric` / `chart` / `table` / `comparison` 必须引用已存在的结果；没有引用的数据块不允许进入产物。
- `metric` 的 `refs` 只允许来自已执行步骤；`combine='sum'` 只用于可加指标。
- `narrative` 中允许出现 `{{ref:...}}` 占位符；渲染时解析，解析失败即校验失败。
- 块数量上限 30；每张表最多 200 行预览；导出时按需重新取数，不把全量结果塞进 JSON。
- 模型不能输出 HTML / Markdown 表格；只有 `table` 块由渲染器生成。

### 7.4 生成流水线

1. **解析输入**：校验源、库、表、时间；把源转换为 `AgentSourceContext`。
2. **探查**：Agent 调用 `inspect_schema` / `search_objects`，确定相关表与字段；必要时调用 `sample_rows` 确认枚举值。
3. **建查询**：Agent 为每个指标 / 维度调用 `run_sql`，SQL 必须带 LIMIT 或聚合；数字型总结调用 `analyze_chart`，预测调用 `forecast_chart`。
4. **提交规格**：Agent 调用 `compose_report`，传入 `ReportSpec`；工具校验引用、占位符、数字块与源匹配。
5. **落产物**：校验通过后写入 `artifacts` + `artifact_runs`，`artifact_ready` 事件通知 UI。
6. **渲染 / 导出**：屏幕渲染由前端按 DSL 完成；导出由网关按同一 DSL 生成 XLSX / PDF / PPTX。

`compose_report` 的校验失败示例：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_REPORT_SPEC",
    "message": "2 个数据块没有有效的结果引用",
    "details": [
      { "path": "sections[0].blocks[1]", "reason": "resultRef 's9' 不存在" },
      { "path": "sections[1].blocks[0].text", "reason": "占位符 {{ref:s3.total}} 无法解析" }
    ]
  }
}
```

### 7.5 数字溯源

这是报告可信度的核心，必须同时满足：

1. **结果引用**：每个数据块 / 指标绑定 `resultRef`（工具调用 id）；`compose_report` 校验引用存在且数字来自该结果，结果快照存于 `artifact_runs.steps_json`。
2. **叙述占位符**：叙述中的数字用 `{{ref:stepId.path}}`；渲染器解析，不允许模型在文本里直接写数字。
3. **服务端算数**：合计、差值、占比、环比由 `analyze_chart` 或网关的 `computeDelta` 计算；模型只引用。
4. **重跑快照**：每次运行保存 SQL、参数、结果与时间；报告显示“数据截至”。
5. **冲突处理**：同一指标出现多个值时，报告以最新一次成功运行的结果为准，并在 `meta.notes` 中记录差异，不静默覆盖。

验收时必须核对：报告展示的每个数字都能在 `steps_json` 中找到出处；叙述占位符全部解析成功。

### 7.6 多源合并

- 每个源分别用自身方言执行聚合 SQL；不生成跨引擎 JOIN。
- 网关按维度键合并：对可加指标求和，对不可加指标分源展示并标注“不可合并”。
- `merged` 布局必须包含口径说明；报告中每个合并数字显示“由 N 个源汇总”。
- 若用户要求行级 JOIN 两个源，明确说明不能在库内完成，建议 `/recon` 或先传输到目标库；不伪造结果。
- 多源报告的源顺序按表单顺序；每源颜色 / 标签固定，图表与表格保持一致。

### 7.7 渲染

- 屏幕渲染复用现有图表组件与数据网格；报告页为独立标签页，支持滚动、打印、导出。
- 布局：标题区 + 概览指标 + 章节；每节可含叙述、指标卡、图表、表格、对比、提示。
- 报告图表块只输出柱 / 折线 / 饼（`compose_report` 的结构）；交互图表与 Agent 工具支持柱 / 堆叠 / 折线 / 饼 / 散点 / 热力 / 雷达，多系列用 `ys`。
- 表格最多 200 行预览，超过时提示“导出查看全部”。
- 响应式：桌面双栏，移动端单栏；图表在移动端保持可读的最小高度。
- 打印 / PDF：沿用现有打印通道；分页避免把图表切断。

### 7.8 导出

| 格式 | 实现 | 说明 |
|---|---|---|
| 屏幕 | 前端渲染 | 默认 |
| XLSX | 复用现有 xlsx 导出能力 | 每个表格一个 sheet，指标 / 叙述一个 sheet |
| PDF | Electron 打印 / 浏览器打印 | 不新写 PDF 库 |
| PPTX | 网关新增 `pptxgenjs` | 中性模板：封面、概览、每节一页、对比页、附录；图表先转 PNG 再嵌入；后续再扩展模板库 |

PPTX 规则：

- 不让模型决定幻灯片版式；模板由报告布局决定。
- 图表用现有 SVG→PNG 光栅化（中文标签已验证可用），嵌入 PNG。
- 标题、叙述、表格文本来自 ReportSpec；数字仍来自结果引用。
- 导出失败返回 `EXPORT_FAILED`，不影响已保存的报告。

### 7.9 定时与历史对比

- 保存报告时可创建 `artifact_schedules`；间隔、启用状态、是否刷新叙述可配置。
- 定时重跑默认只重放 SQL，不调用模型；叙述文本标记生成时间。
- 每次运行与上次成功运行对比：指标卡显示变化；报告页提供“历史运行”列表。
- 失败不自动重试；连续 3 次失败在产物卡上标记，不自动停用。
- 通知：v1 只做桌面端应用内提示，不引入邮件；后续接微信 / QQ / 飞书机器人，作为 `artifact_schedules` 的通知渠道扩展。

### 7.10 提示词与澄清

`/report` 的 Agent 提示词必须包含：

- 布局选择规则（§7.2）与“布局不是用户选项”。
- 数字守卫：禁止手算、外推、估算；合计必须来自聚合 SQL 或 `analyze_chart`。
- 多源规则：不得跨源 JOIN；每个结论标源；不可合并指标分开展示。
- 规格规则：只引用已执行结果；叙述用占位符；最多 30 块。
- 澄清规则：只问一个问题；能从 schema 推断的不问。
- 语言：跟随用户语言；专业术语保留原文。

### 7.11 降级

模型不可用或本地推理器时，`/report` 输出确定性模板：

- 按确定性规则选布局：多源 + 对比动词 → comparison；多源 + 汇总动词 → merged；否则 sections。
- 每个选中的表生成行数、空值率、Top 值图表；没有业务指标时生成“数据概览”而不是编造结论。
- 叙述由模板生成（“表 X 共 N 行，字段 Y 空值率 Z%”），不调用模型。
- 明确标注“未启用 AI 解读”。

### 7.12 限额

| 项 | 默认值 | 可配置 |
|---|---|---|
| 源数量 | 4 | 命令定义 |
| 块数量 | 30 | 命令定义 |
| 数据查询数 / 报告 | 8 | 是 |
| 表格预览行数 | 200 | 是 |
| 单次报告超时 | 120s | 是 |
| 图表数量 | 8 | 是 |

## 8. `/diff` 详细设计

### 8.1 输入

| 槽位 | 必填 | 说明 |
|---|---|---|
| `sources` | 是 | 恰好两个：源 A / 源 B |
| `database` | 否 | 每个源各自的库 / schema |
| `tables` | 否 | 限定对象；留空对比全部 |
| `includeDrops` | 否 | 是否包含删除表 / 列 / 索引，默认 false |

### 8.2 执行

复用 `apps/gateway/src/features/schemaCompare.ts` 的 `compareSchemas(store, manager, sourceId, sourceDatabase, targetId, targetDatabase)`：

- 已有：表新增 / 删除 / 变更、列、索引、外键、目标方言 DDL、破坏性标记。
- 新增命令层：把结果落为 `diff` artifact；每个变更绑定来源与目标；生成“手工处理项”列表。

### 8.3 输出

```ts
interface DiffArtifactSpec {
  sources: [ReportSourceRef, ReportSourceRef];
  options: { includeDrops: boolean; tables?: string[] };
}

interface DiffResult {
  summary: { added: number; removed: number; changed: number; statements: number; destructive: boolean };
  tables: Array<{
    name: string;
    status: 'added' | 'removed' | 'changed' | 'unchanged';
    changes: Array<{
      kind: string;
      column?: string;
      detail: string;
      sql?: string;
      destructive?: boolean;
      manual?: boolean;
      reason?: string;
    }>;
  }>;
  sql: string[];
  manual: Array<{ table: string; reason: string }>;
}
```

### 8.4 跨引擎归一化

- 类型别名：`INTEGER` / `INT` / `INT4`、`VARCHAR` / `TEXT` / `STRING`、`TIMESTAMP` / `DATETIME` 等按目标方言映射。
- 默认值、自增、字符集 / 排序规则、索引前缀长度：能表达则生成 DDL，不能表达则进入 `manual`，不静默丢弃。
- 外键与索引命名差异：同名不同义时标为变更，不按名字直接判定相同。
- 注释差异：可选忽略；默认纳入差异，但不算破坏性。
- 生成 DDL 时以目标引擎方言为准；源方言只用于理解结构。

### 8.5 同步

`/diff` 本身只读；同步是独立动作：

1. 用户选择“同步到 B”；
2. 校验目标连接非只读；
3. 强制备份目标库（`backup_database`）或在 UI 明确提示无法备份时二次确认；
4. 展示将执行的语句与破坏性项；
5. 审批后执行；MySQL 等 DDL 自动提交的引擎不支持事务回滚，必须依赖备份；
6. 执行后重新对比并展示结果；
7. 写审计 `command.diff.sync`。

### 8.6 限额

- 单次最多 500 张表 / 集合；超出时要求选择范围。
- 大 schema 分页加载；差异结果最多返回 2,000 条变更，超出提示导出。
- 超时 60 秒；跨连接 schema 读取并行，失败单独报告。

## 9. `/recon` 详细设计

> 跨源 = 不同服务器上的连接，允许异构引擎。支持“SQL 表 ↔ SQL 表”“SQL 表 ↔ Redis 键空间”以及 MongoDB / Elasticsearch / OpenSearch 文档源；向量库仍待扩展。移动端只是客户端，不影响源模型。

### 9.1 两种形态

| 形态 | 示例 | 键的来源 | 值的来源 |
|---|---|---|---|
| `table-table` | 旧库 `orders` ↔ 新库 `orders` | 主键 / 业务键 | 列 |
| `table-keyspace` | MySQL `users` ↔ Redis `user:*` | 表列 + 键正则 | 列 vs hash / string / json |
| `keyspace-keyspace` | 两台 Redis | 键正则 | hash / string / json |
| `documents-documents` | MongoDB `users` ↔ Elasticsearch `users` | `_id` / 自定义 idField | 文档字段 |
| `table-documents` / `documents-table` | MySQL 表 ↔ Mongo 集合 | 列 / `_id` | 列 vs 文档字段 |

`/diff` 只对可结构化的对象生效；Redis 这类无 schema 源不参与结构对比，由 `/recon` 负责跨模型一致性。

### 9.2 源适配器

```ts
export type ReconSourceKind = 'table' | 'keyspace';

export interface ReconSourceSpec {
  kind: ReconSourceKind;
  connectionId: string;
  database?: string;
  /** table */
  table?: string;
  keyColumns?: string[];
  /** keyspace（Redis） */
  keyPattern?: string;       // SCAN MATCH，例如 'user:*'
  keyExtract?: string;       // 从键提取逻辑键的正则，例如 '^user:(.+)$'
  valueType?: 'string' | 'hash' | 'json';
  collection?: string;
  idField?: string;
  fields?: string[];
  ttl?: 'ignore' | 'warn';
}

export interface ReconMapping {
  mode: 'table-table' | 'table-keyspace' | 'keyspace-keyspace';
  left: ReconSourceSpec;
  right: ReconSourceSpec;
  /** 键映射：左侧列 / 表达式 → 右侧提取的键或列。 */
  keyMap: { left: string; right: string };
  /** 字段映射：两侧字段名可以不同。 */
  fieldMap: Array<{
    left: string;
    right: string;
    normalize?: 'number' | 'string' | 'boolean' | 'timestamp' | 'json';
  }>;
  ignoreTtl: boolean;
  maxKeys: number;
}
```

适配器接口：

```ts
export interface ReconSourceAdapter {
  describe(): Promise<{ kind: ReconSourceKind; keyKind: 'column' | 'key'; count: number; fields: string[] }>;
  scanKeys(opts: { maxKeys: number; batchSize: number }): AsyncIterable<string[]>;
  readRecords(keys: string[]): Promise<Array<{ key: string; values: Record<string, unknown>; raw?: unknown }>>;
  normalize(value: unknown, target: 'number' | 'string' | 'boolean' | 'timestamp' | 'json'): unknown;
}
```

首批适配器：

- `TableAdapter`：SQL 表；键列有序读取；按批 `SELECT ... WHERE key IN (...)`；只读。
- `RedisAdapter`：`SCAN MATCH <pattern> COUNT 1000` 游标遍历；`TYPE` 校验；`GET` / `HGETALL` / `MGET` 读取；禁止 `KEYS`、`EVAL`、`FLUSH*`、`CONFIG`、`SHUTDOWN`；TTL 默认忽略。
- v2：`MongoAdapter`（`_id`）、`SearchAdapter`（`_id`）、向量库适配器。

映射示例（MySQL ↔ Redis）：

```text
left:  table users, keyColumns [id]
right: keyspace, keyPattern user:*, keyExtract ^user:(.+)$, valueType hash,
       fields [name, email, status]
keyMap:   left.id      → right.extracted
fieldMap: left.name    → right.name
          left.email   → right.email
          left.status  → right.status
```

说明：

- Redis 存 JSON 字符串时 `valueType=json`，`fields` 写 JSON 路径（如 `$.name`）；存单值时 `valueType=string`，`fieldMap` 写 `left.<column> → right.value`。
- 不支持的类型（list / set / zset / stream）在 v1 明确返回 `RECON_UNSUPPORTED_TYPE`，不静默跳过。
- 两侧都可以作为“基准侧”；生成修复前必须由用户选择“以哪侧为准”，默认只读、不生成写命令。

### 9.3 对账层级

| 级别 | 内容 | 成本 | 默认 |
|---|---|---|---|
| L1 存在性 / 数量 | 表存在性与 `COUNT(*)`；键空间用 `SCAN` 计数；文档源用 Mongo count / ES total | 低 | 是 |
| L2 键集合 | 主键 / 业务键 / 提取键的缺失与多余 | 中 | 是（有键时） |
| L3 字段校验 | SQL 用聚合校验（COUNT / SUM / MIN / MAX）；Redis 在限额内逐键比对 | 中高 | 可选 |
| L4 行下钻 | 按差异键取两侧样本 | 按需 | 手动 |
| L5 字段级 | 改值行的逐字段比较与分类 | 高 | 可选 |

现有 `compareData` 只做到 L1（行数与表存在性），L2+ 是新增能力，放在 `apps/gateway/src/features/reconcile.ts`，不修改旧接口语义。文档源按 collection/index + `_id` 扫描，MongoDB 使用 `find`/`count`，Elasticsearch/OpenSearch 使用 `_search`（`hits.total`）。

### 9.4 键选择

- `table-table`：优先主键（复合主键按列顺序）；无主键时要求业务键；无键且不指定只跑 L1。
- `table-keyspace`：表侧用主键 / 业务键，Redis 侧用 `keyPattern` + `keyExtract`；提取结果必须唯一。
- `keyspace-keyspace`：两侧都要 `keyPattern` + `keyExtract`；不填 `keyExtract` 时整个键作为逻辑键。
- 键归一化：数字 / 字符串、大小写、前后空白、前导零按配置归一；归一后重复的键标记 `duplicate_key`，该目标停止 L2+。
- 键列 / 键正则两侧类型不兼容时，先归一或要求用户改映射，不做隐式猜测。

### 9.5 执行算法

```text
for target in selectedTargets:
  leftDesc = left.describe()
  rightDesc = right.describe()
  emit L1(leftDesc.count, rightDesc.count)

  if !keyMap: continue

  keysL = left.scanKeys(maxKeys, batchSize)
  keysR = right.scanKeys(maxKeys, batchSize)
  for diff in mergeKeyStreams(keysL, keysR):   // 网关侧流式归并，按归一化键排序
    emit L2(diff.missingInRight, diff.extraInRight)

    for batch in diff.matchedKeys.batches(5000):
      rowsL = left.readRecords(batch)
      rowsR = right.readRecords(batch)
      compare normalized field values
      emit L5(valueChanged, typeDrift, nullMismatch)

  for sample in diff.samples(limit=20):
    emit L4(sample from both sides)
```

说明：

- 跨连接 / 跨引擎时不能依赖数据库端 JOIN；两侧分别扫描，网关归并。
- Redis `SCAN` 可能重复返回键，网关按归一化键去重；计数以完整遍历为准，不用 `DBSIZE` 代替 pattern 计数。
- 大表按主键范围或哈希桶分批；每批 5,000 键；内存中只保留当前批与摘要。
- 读取使用只读查询 / 只读 Redis 命令，自动加 LIMIT / 分页；不允许全表 `SELECT *` 或 `KEYS *`。
- 同一连接不同库可以下推反连接优化，v1 不做，保持实现简单。

### 9.6 规范化

误报主要来自类型、时区与序列化，必须显式规范化并在结果中说明：

| 维度 | 默认 | 可配置 |
|---|---|---|
| 时间 | 统一转 UTC 后比较；显示用源时区 | 是 |
| 数值 | 按较精确一侧的精度归一；浮点容差默认 1e-6 | 是 |
| 字符串 | 保留大小写与空白；可选 trim / lower | 是 |
| 空值 | `NULL`、空字符串、Redis 缺失字段不默认等价 | 是 |
| 布尔 | `0/1`、`true/false`、`t/f` 归一 | 是 |
| JSON | 解析后按稳定键排序比较 | 是 |
| 二进制 | 比较长度与哈希，不展示原值 | 否 |
| Redis TTL | 默认忽略；扫描期间过期标 `expired_during_scan` | 是 |
| Redis 数字字符串 | 与数值列比较时按数值解析 | 是 |

结果中同时给出“原始比较”和“规范化后比较”的计数，避免用户误以为数据错了。

### 9.7 差异分类

| 分类 | 含义 | 修复建议 |
|---|---|---|
| `missing_in_right` | 右侧缺少该键 | 右侧 INSERT / `HSET` / `SET` |
| `extra_in_right` | 右侧多出该键 | 右侧 DELETE / `DEL`（需确认） |
| `value_changed` | 键存在但字段值不同 | 右侧 UPDATE / `HSET` / `SET` |
| `type_drift` | 两侧类型 / 精度 / 序列化不一致 | 改结构或转换 |
| `null_mismatch` | 一侧为空 / 缺字段，一侧有值 | 按业务规则处理 |
| `duplicate_key` | 一侧键重复 | 先清重复，再做行级对账 |
| `source_missing` | 表 / 键空间 / 连接缺失 | 检查范围或建对象 |
| `expired_during_scan` | 扫描期间键过期 | 重跑或忽略 |

UI 中 `table-table` 可把 right 显示为“目标”，`table-keyspace` 显示两侧真实标签（如“MySQL 生产”“Redis 缓存”），不使用“源 / 目标”掩盖方向。

### 9.8 输出与修复方案

- 汇总：目标数、相同键数、缺失 / 多余 / 改值 / 类型漂移数量、扫描是否截断。
- 明细：按目标分组的差异行；可按状态过滤、搜索键、查看两侧样本。
- `table-table`：生成 INSERT / UPDATE / DELETE 或“传输整表”；默认只生成 SQL，不执行。
- `table-keyspace`：生成 Redis 命令计划（`HSET` / `SET` / `DEL`）；确认 `EXECUTE` 后先快照受影响键，再执行并复检；只允许这三类命令。
- 文档源：默认只读对账，不生成写命令；需要修复时请使用 MongoDB/ES 原生写入工具。
- 生成修复前必须选择“以哪侧为准”；不选则只读展示，不生成写命令。
- 执行是独立动作：备份（SQL 侧）、审批、事务（若支持）、验证、审计；执行后自动重跑同一对账规格，展示前后对比。

### 9.9 限额与性能

| 项 | 默认 |
|---|---|
| 目标数量 | 50 |
| 单目标键数（两侧分别） | 200,000 |
| Redis 单目标扫描上限 | 1,000,000 键（超出标记不完整） |
| 批大小 | 5,000 |
| Redis `SCAN COUNT` | 1,000 |
| 单目标超时 | 60s |
| 并发目标 | 2 |
| 样本行 / 目标 | 20 |
| 明细行 / 目标 | 5,000 |

生产源默认只跑 L1；升级到 L2+ 必须在表单上显式勾选“允许键级扫描”，避免误扫大库 / 大 keyspace。

### 9.10 新增错误码

| code | 场景 | 用户提示 |
|---|---|---|
| `RECON_MAPPING_REQUIRED` | 异构源未配置键 / 字段映射 | 需要补全映射 |
| `RECON_UNSUPPORTED_TYPE` | Redis list / set / zset / stream | v1 不支持该类型 |
| `RECON_KEY_PATTERN` | 键模式无效或提取结果不唯一 | 检查 `keyPattern` / `keyExtract` |
| `RECON_SCAN_LIMIT` | 超过扫描上限 | 缩小范围或提高上限 |

### 9.11 与现有数据对比的关系

- 保留工具箱现有 `数据对比`（L1）作为快速入口；`/recon` 是它的超集。
- 工具箱的“替换同步”继续可用；`/recon` 的修复方案优先走增量 SQL，避免整表替换。
- 两者共用 `compareData` 的表清单与行数逻辑，避免口径分叉；异构对账不复用 `compareData` 的 SQL 假设，走适配器。

## 10. `/compare` 详细设计

### 10.1 对比对象

A / B 两侧分别可以是：

- 同一连接的两个时间段；
- 同一连接的两个分组值（渠道、地区、状态）；
- 两个连接 / 两个库的同一指标；
- 两个已保存的查询（后续支持；v1 用表单描述）。

v1 只支持有查询语言的源（SQL 等）；Redis 等键值源不参与 `/compare`，需要一致性校验时使用 `/recon`。

### 10.2 同口径查询

- Agent 只生成“结构相同、过滤值不同”的两条 SQL：相同的 SELECT、聚合、GROUP BY、排序、LIMIT；差异只在时间范围或分组值。
- 两侧使用相同的表、相同的字段、相同的聚合函数；不允许一侧用 `SUM`、另一侧用 `AVG`。
- 生成后先展示两条 SQL 与口径说明，再执行；用户可展开查看。
- 任何一侧查询失败，整次对比失败，不返回“半边结果”。

### 10.3 差值计算

网关计算，不交给模型：

- 绝对值差 `B - A`；
- 百分比差 `(B - A) / A`（A 为 0 时返回 `null`，不显示无穷大）；
- 贡献度：按维度计算 `(B_i - A_i) / (B_total - A_total)`，用于 TopN 异动；
- 时间序列：逐点差值、峰值、谷值、变化最大的点；
- 结果保留原始精度，展示时按列格式化。

### 10.4 输出

复用报告渲染器，产物类型 `compare`：

- 概览指标卡：A、B、差值、百分比；
- 对比图：折线 / 柱状并排或同图双系列；
- 异动表：维度、A、B、差值、贡献度；
- 叙述：Agent 解读，数字通过占位符引用；
- 口径说明：时间范围、过滤条件、聚合方式、数据截至。

### 10.5 与 `/diff`、`/recon` 的边界

| 意图 | 命令 |
|---|---|
| 两个时间段 / 分组 / 指标的数值差异 | `/compare` |
| 两个库的表结构 / 索引 / 列差异 | `/diff` |
| 两个源的行级一致性、缺失、改值 | `/recon` |

`/compare` 识别到“结构 / 行级一致性”意图时，提示“这更像 `/diff` 或 `/recon`”，由用户选择，不静默切换。试错期允许命令重叠，但 UI 必须给出建议。

## 11. `/fix` 详细设计

### 11.1 检查项

v1 复用：

- `audit_database`：缺主键、外键缺索引、重复索引、空表；
- `check_data_quality`：空值率、空串、区分度、重复主键。

v2 增加（本计划不阻塞首批）：

- 外键孤儿行；
- 枚举值越界；
- 负数金额 / 时间倒挂；
- 主键重复的业务键；
- 时区不一致。

### 11.2 修复计划

```ts
interface FixPlan {
  findings: Array<{
    id: string;
    severity: 'info' | 'warning' | 'danger';
    title: string;
    detail: string;
    table?: string;
    risk: Risk;
    sql?: string;
    rollbackSql?: string;
    verificationSql?: string;
    requiresBackup: boolean;
    destructive: boolean;
  }>;
  summary: { total: number; destructive: number; requiresBackup: boolean };
  notes?: string[];
}
```

计划由 `submit_fix_plan` 提交并校验：

- 每条有 SQL 的 finding 必须有风险等级；
- destructive 必须有 `verificationSql` 与回滚说明（或明确“不可回滚，依赖备份”）；
- SQL 必须在当前连接方言下可解析（能 dry-run 的引擎先 dry-run）。

### 11.3 安全链

```
检查（只读）
  → 生成计划
  → 展示 findings / SQL / 风险
  → 备份目标（destructive 必做）
  → 逐条审批（默认）
  → 事务执行（引擎支持时）
  → 验证查询
  → 审计
  → 失败：回滚或按备份恢复
```

硬性规则：

- 只读连接：允许检查，禁止执行修复。
- 生产环境：默认要求备份 + 逐条审批；`full` 权限也不能跳过备份与审批。
- 破坏性操作（DROP / TRUNCATE / DELETE 无 WHERE）：必须重复对象名确认。
- 事务：关系型引擎优先 `begin_transaction` / `commit` / `rollback`；MySQL DDL 自动提交，不承诺回滚，必须依赖备份。
- 执行后必须跑验证查询并把结果写进产物；没有验证的修复不算完成。

### 11.4 审批粒度

- 低风险（`read` / `write` 非破坏性）：可“计划级允许”，一次审批执行整个计划。
- `ddl`：默认逐条；用户可切换为计划级，但 UI 必须列出所有语句。
- `destructive`：强制逐条，不支持计划级跳过；`full` 模式下也一样。
- 任何需要备份的步骤，备份未成功时不允许执行；`full` 模式同样不能跳过备份。
- 审批沿用现有 `ApprovalPayload` 与审批端点；命令运行记录 `runId` 与 `findingId`，便于审计追溯。

### 11.5 回滚

- 事务内执行：失败自动 `rollback`。
- 非事务 DDL：依赖备份；产物中记录备份路径与时间。
- 生成的 `rollbackSql` 只用于可逆操作（ADD COLUMN 可 DROP COLUMN 等）；DROP TABLE / DROP COLUMN 明确标记“不可逆”。
- 修复后重跑检查，展示修复前后计数；未改善的 finding 保留在产物中。

### 11.6 生产与只读行为

| 连接属性 | 检查 | 生成计划 | 执行 |
|---|---|---|---|
| 只读 | 允许 | 允许（仅展示） | 禁止 |
| 非只读 dev / staging | 允许 | 允许 | 审批后执行 |
| 非只读 prod | 允许 | 允许 | 备份 + 逐条审批 + 验证 |
| 环境未知 | 按 prod 处理 | 是 | 同上 |

## 12. UI / UX

### 12.1 斜线菜单

- 分组：分析（`/report`、`/compare`）、对比（`/diff`、`/recon`）、运维（`/fix`）、通用（`/ask`）。
- 每项显示：图标、名称、一句话描述、源数量提示（如“2 个源”）、是否确定性（“无需模型”徽标）。
- 搜索匹配 id、英文别名、中文别名、描述。
- 键盘：`↑` / `↓` 选择，`Enter` 展开表单，`Esc` 关闭；不直接发送。
- 输入 `/` 时保留当前输入的前缀，选中命令后清除命令文本，参数进表单。

### 12.2 命令表单

- 桌面端：输入框上方的内联卡片（`CommandSheet`），不遮挡对话；源选择器横向排列，高级选项折叠。
- 移动端：底部弹层，全屏高度可拖拽；源卡片纵向排列。
- 表单顶部显示命令名、说明、风险徽标；底部“运行”按钮根据校验状态禁用。
- 源卡片：连接选择 + 数据库选择 + 显示名（可选）；支持“添加源”，数量受 `sources.max` 限制。
- `tables` 多选带搜索、全选、按 schema 分组；选中数量显示在按钮上。
- 执行前展示“将要做什么”摘要：源、对象、只读 / 写、是否需要模型、预计步骤。
- 表单值持久化到本地（按命令），不保存连接凭据。

### 12.3 运行卡片

- 在对话流或命令面板中显示步骤列表：状态点、步骤名、耗时、摘要。
- 确定性步骤显示 SQL / 对象范围；Agent 步骤显示工具调用（复用现有工具卡）。
- 审批：内联审批卡，显示风险、SQL、影响范围、允许范围（一次 / 本会话 / 总是）。
- 取消：运行中可取消；取消后保留已完成步骤与部分结果。
- 失败：显示错误码、可重试步骤与建议；不自动重试破坏性步骤。

### 12.4 产物视图

- 产物卡：标题、类型、源标签、数据截至、状态、操作（打开、重跑、定时、导出、继续追问）。
- 报告页：独立标签页，左侧目录 / 右侧内容；支持打印、导出。
- 差异页：三栏（表清单 / 变更详情 / DDL 预览），复用现有结构对比视觉。
- 对账页：汇总卡 + 表清单 + 差异明细 + 样本抽屉；支持筛选、搜索、导出。
- 修复页：findings 列表 + SQL 预览 + 风险徽标 + 执行状态；执行后展示验证结果。
- 历史：报告 / 对账显示最近运行列表与“与上次对比”。

### 12.5 移动端

- 斜线菜单与表单复用同一注册表；控件换成移动端友好的选择器。
- 产物页支持滚动、图表、表格横向滚动、分享 / 导出。
- 审批卡在移动端必须显示 SQL 与风险，不允许只显示“允许 / 拒绝”。
- 长任务在移动端显示进度与取消；切后台不丢运行状态（服务端持有 run）。

### 12.6 空状态、错误与权限

- 空状态：说明命令能做什么，给出一个示例（不是空白）。
- 错误：区分“用户输入错误”“源不可用”“模型不可用”“权限拒绝”“超时”；给出下一步动作。
- 权限：只读连接在表单上就标注“只读”，写操作按钮禁用并解释原因。
- 模型缺失：`/report` / `/compare` 显示“未配置模型，将使用确定性模板”，不阻止执行。

### 12.7 i18n 与可访问性

- 命令标题、描述、槽位、错误信息全部走 i18n。
- 键盘可达：`/` 打开菜单、Tab 遍历槽位、Enter 运行、Esc 取消。
- 颜色不是唯一信息载体：风险用文字 + 图标 + 颜色。
- 图表提供表格替代视图；报告导出保留标题层级。

## 13. API 设计

所有接口挂在现有网关 `/api` 下，鉴权沿用现有令牌 / 设备配对。

### 13.1 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/commands` | 命令定义列表（注册表） |
| POST | `/commands/:id/runs` | 创建并启动一次命令运行 |
| GET | `/commands/runs/:id` | 运行快照（状态、步骤、产物） |
| GET | `/commands/runs/:id/events?after=seq` | SSE 进度 / 审批 / 结果 |
| POST | `/commands/runs/:id/cancel` | 取消运行 |
| GET | `/artifacts?type=&limit=` | 产物列表 |
| GET | `/artifacts/:id` | 产物详情（spec） |
| POST | `/artifacts` | 保存产物 |
| PUT | `/artifacts/:id` | 更新标题 / 规格 |
| DELETE | `/artifacts/:id` | 删除产物（级联 runs / schedule） |
| POST | `/artifacts/:id/runs` | 重跑产物 |
| GET | `/artifacts/:id/runs` | 运行历史 |
| GET | `/artifacts/:id/export?format=xlsx` （也支持 `pdf` / `pptx`） | 导出 |
| POST | `/artifacts/:id/schedule` | 创建 / 更新定时 |
| DELETE | `/artifacts/:id/schedule` | 删除定时 |

复用现有端点，不重复实现：

- `POST /schema/compare`、`POST /schema/sync`
- `POST /data/compare`
- `POST /transfer`
- `POST /agent/approvals/:id`（审批）
- `GET /agent/tools`（全局工具目录，不含命令私有工具）

### 13.2 创建运行

```http
POST /commands/recon/runs
Content-Type: application/json

{
  "input": {
    "mode": "table-keyspace",
    "left": {
      "kind": "table",
      "connectionId": "c_mysql",
      "database": "shop",
      "table": "users",
      "keyColumns": ["id"]
    },
    "right": {
      "kind": "keyspace",
      "connectionId": "c_redis",
      "database": "0",
      "keyPattern": "user:*",
      "keyExtract": "^user:(.+)$",
      "valueType": "hash",
      "fields": ["name", "email", "status"]
    },
    "keyMap": { "left": "id", "right": "extracted" },
    "fieldMap": [
      { "left": "name", "right": "name", "normalize": "string" },
      { "left": "email", "right": "email", "normalize": "string" },
      { "left": "status", "right": "status", "normalize": "string" }
    ],
    "level": "keys",
    "ignoreTtl": true,
    "maxKeys": 200000
  },
  "saveAs": { "title": "MySQL ↔ Redis 用户缓存对账" }
}
```

同构表对表的请求形状相同，只是右侧 `kind: "table"`、`keyColumns` 与 `table` 必填，不需要 `keyPattern` / `valueType`。

响应：

```json
{
  "run": {
    "id": "run_...",
    "command": "recon",
    "status": "queued",
    "createdAt": "2026-10-30T10:00:00.000Z"
  }
}
```

### 13.3 SSE 示例

```text
event: step_started
data: {"type":"step_started","runId":"run_...","stepId":"l1","label":"数量对比","kind":"deterministic"}

event: step_progress
data: {"type":"step_progress","runId":"run_...","stepId":"l2","message":"users / user:* 已比对 20,000 / 129,757 键","current":20000,"total":129757}

event: artifact_ready
data: {"type":"artifact_ready","runId":"run_...","artifactId":"art_...","type":"recon","title":"迁移后订单对账"}

event: run_finished
data: {"type":"run_finished","runId":"run_...","status":"succeeded","durationMs":8421}
```

### 13.4 错误返回

沿用现有 `{ error: { code, message, hint? } }`；命令槽位错误额外返回 `field`：

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "源数量必须是 2 个",
    "field": "sources"
  }
}
```

## 14. 数据模型与迁移

### 14.1 新增表

见 §6.3。所有表使用 `TEXT` 主键（UUID），时间用 ISO 字符串，与现有表一致。

### 14.2 迁移

- `SCHEMA_SQL` 增加三张表；`migrate()` 末尾把 `PRAGMA user_version` 从 4 升到 5。
- 现有表零改动；`jobs` 不扩展类型，避免重建带 CHECK 的表。
- 升级前由桌面端现有 `backupBeforeUpgrade` 备份 `aidb.db`（已有机制）。
- 回滚：应用降级时旧版本不识别新表，但不会删除；旧版本照常运行。

### 14.3 索引

- `artifacts(type, updated_at DESC)`：列表按类型过滤。
- `artifact_runs(artifact_id, created_at DESC)`：历史与清理。
- `artifact_schedules(enabled, last_run_at)`：调度器扫描。
- 不给 `steps_json` 建索引；它只按 run 读取。

### 14.4 保留与清理

- 每个 artifact 最近 20 次运行；失败运行最近 5 次。
- 超过 90 天的运行记录可清理（配置项，默认关闭）。
- 删除 artifact 级联删除 runs / schedule；导出文件不删。

## 15. 安全与权限

### 15.1 命令风险

| 命令 | 风险上限 | 说明 |
|---|---|---|
| `/report` | read | 只读查询 + 导出 |
| `/compare` | read | 只读查询 |
| `/diff` | read | 结构读取；同步是独立动作（ddl） |
| `/recon` | read | 只读对账；修复是独立动作（write） |
| `/fix` | destructive | 检查只读；修复需要审批 |

有效权限 = 全局权限模式与命令风险上限的交集：

- `readonly` 模式：`/fix` 只能检查，`/diff` 不能同步，`/recon` 不能修复。
- `ask`：写 / DDL / 破坏性操作需要审批。
- `auto`：写与 DDL 自动，破坏性仍需审批。
- `full`：仍不能跳过 `/fix` 的备份与破坏性审批。
- `/recon` 的 Redis 修复在 v1 只生成命令、不执行；即使权限为 `full` 也不写 Redis。

### 15.2 源访问

- 每个源必须存在且可连接；离线连接返回 `SOURCE_UNAVAILABLE`。
- 跨源命令不允许把 A 源的结果写到 B 源，除非用户显式执行“同步 / 修复”动作。
- 跨源指不同服务器上的连接（含 MySQL ↔ Redis 等异构引擎）；移动端只是客户端，沿用现有令牌权限，不参与源选择模型，也不在本计划里新增按设备 / 按连接的授权。

### 15.3 审批

- 复用现有审批载荷与端点；命令运行记录 `runId`、`stepId`、`findingId`。
- 审批内容必须包含：工具、风险、SQL、目标连接、影响范围、是否可回滚。
- 审批过期默认拒绝；不允许“默认允许”。

### 15.4 审计

- 每次运行、每个写步骤、每次导出都写审计。
- 审计字段包含 `runId`、`artifactId`、`sources`、`sql`、`risk`、`approval`、`status`、`durationMs`。
- 对账 / 对比读取大表时记录读取范围与限额，便于追溯性能影响。

### 15.5 提示注入与数据内容

- 数据库内容（表注释、单元格）始终视为数据，不是指令；报告叙述不得执行数据里的“指令”。
- 跨源报告中的源标签由用户 / 表单提供，不由数据内容决定。
- Agent 步骤只允许白名单工具；报告 / 对比命令没有写工具。

### 15.6 只读链路

- 只读连接在驱动层拒绝写语句；命令层再做一次校验，双重保险。
- `/diff` 的同步、`/recon` 的修复、`/fix` 的执行都检查目标连接 `readonly`。
- 只读连接上的 `backup` 允许（读取）；导出允许。

## 16. 开发计划

### 16.1 里程碑

| 里程碑 | 范围 | 主要交付 | 退出标准 | 估算 |
|---|---|---|---|---|
| M0 命令框架 | 注册表、表单、执行器骨架、产物表、SSE、取消 | core 命令类型与 5 个业务命令 + `/ask` 兜底定义；gateway `CommandRunner`；`CommandSheet`；artifact CRUD | 用 `/diff` 的只读路径做端到端冒烟：可运行、可取消、有产物、有审计（完整差异页在 M1） | 3–4d |
| M1 `/diff` | 结构对比命令、差异产物、同步独立动作 | 复用 `compareSchemas`；差异页；同步审批 | 两个 SQLite / MySQL 库的结构差异正确；同步前备份与审批 | 1–2d |
| M2 `/recon` | 同构 table-table + 异构 table-keyspace（MySQL ↔ Redis）、L1–L5、规范化、差异分类 | `reconcile.ts` + `ReconForm`；适配器；对账页；导出；修复方案生成 | SQL↔SQL 夹具 3 缺失 / 2 改值 / 1 类型漂移全部命中；MySQL↔Redis hash 夹具命中缺失 / 改值；无键时正确拒绝行级对账 | 6–8d |
| M3 `/report` | ReportSpec、语义布局、数字溯源、渲染、保存、XLSX/PDF/中性 PPTX | `compose_report`；报告页；导出；保存 / 重跑 | 4 种语义布局各 1 个验收用例；数字全部可追溯；PPTX 可打开 | 5–7d |
| M4 `/compare` | A/B 同口径查询、差值、贡献度、对比产物 | 复用报告渲染；对比页 | 两时间段 / 两连接各 1 个用例；A=0 不出现无穷大 | 2–3d |
| M5 `/fix` | 检查、计划、备份、dry-run、事务、审批、验证 | `submit_fix_plan`；修复页；执行链 | 只读连接禁止执行；破坏性逐条审批；验证结果落产物 | 3–4d |
| M6 定时与硬化 | 报告 / 对账定时、历史对比、移动端、3 个全局对比工具 + 2 个 MCP 工具、契约同步 | `artifact_schedules`；`schema_diff` / `recon_data` / `transfer_data` / `mcp_list_tools` / `mcp_call`；移动端命令面；通知与 MCP 插件；文档与测试 | 定时报告重跑不调用模型；移动端可运行并查看产物；工具数 40 → 45 的四处契约同步 | 3–4d |

合计约 23–32 人日。M0–M2 约 10–14 人日，可先验证“命令 + 跨源（含异构）+ 产物”主链，再投入报告与修复。

### 16.2 依赖顺序

```
M0 ──► M1 ──► M2
 │             └──► M5
 └──► M3 ──► M4 ──► M6
```

- M3 依赖 M0 的产物与 SSE；不依赖 M2。
- M5 依赖 M0 的审批与审计；可与 M3 并行。
- M6 依赖 M3 与 M2 的产物规格稳定。

### 16.3 契约同步

- 本文加入 `scripts/verify-docs.mjs` 的 `required` 列表，内部链接必须可解析。
- 命令定义若进入 core，新增 `commands` 目录的单元测试；`npm run typecheck` 必须绿。
- 工具数量：v1 不增加全局 40 工具；命令私有工具不计入 `/agent/tools` 与文档工具表。M6 按评审决定增加 `schema_diff` / `recon_data` / `transfer_data` 三个全局工具（工具数 40 → 43），实施时必须一次性同步四处：工具定义、executor 分发、docs/04 工具表、契约脚本；在 M6 之前不得提前改文档工具表。
- 新 API 追加到 `docs/05-data-and-api.md` 的 API 表；新数据表追加到本地元数据库章节。
- `npm run verify` 全绿（docs、typecheck、core/gateway 测试、build、e2e）。

### 16.4 定义完成

- 5 个命令均可从 `/` 独立启动，且有产物。
- `/diff`、`/recon` 在无模型配置时可用；`/recon` 至少覆盖 SQL↔SQL 与 MySQL↔Redis 两种源组合。
- 报告布局 4 种语义均通过验收；所有数字可追溯；PPT 使用中性模板。
- 跨连接 / 跨库由表单选择，不依赖模型猜；源数量上限为 4。
- 只读、审批、审计、取消、超时全部有测试。
- 文档契约、类型检查、测试、构建、E2E 全绿。

## 17. 测试与验收

### 17.1 单元测试

- 注册表：id / 别名唯一、源数量、槽位校验、风险上限。
- 输入校验：源归属、表归属、时间范围、枚举、数字范围。
- ReportSpec：引用存在、占位符解析、数字块无手写值、块数量上限。
- 对账：键匹配、缺失 / 多余 / 改值、类型漂移、空值语义、时区 / 精度规范化、无主键拒绝。
- 异构对账：Redis `SCAN` 游标 / 去重、`keyPattern` + `keyExtract`、hash / string / json 取值、TTL 忽略、不支持类型拒绝、扫描上限。
- 对比：差值、百分比、A=0、贡献度 TopN。
- 修复计划：破坏性必须验证、只读禁止、回滚说明。
- 调度：报告重跑不调用模型、失败不自动重试。

### 17.2 集成测试

- 命令运行生命周期：queued → running → succeeded；失败与取消。
- SSE：事件顺序、断线重连 `after=seq`、心跳。
- 审批：允许 / 拒绝 / 过期；命令记录审批结果。
- 产物：保存、重跑、历史、删除级联、导出。
- 审计：每个步骤都有记录。
- 权限：只读连接拒绝同步 / 修复；`full` 模式仍要求破坏性审批。
- 异构对账：Redis 只发送只读命令；扫描上限触发 `RECON_SCAN_LIMIT`；键模式错误返回 `RECON_KEY_PATTERN`。

### 17.3 端到端测试

桌面（playwright-core，沿用现有 E2E 方式）：

1. `/diff`：两个 SQLite 夹具 → 表单 → 运行 → 差异页 → 同步需审批。
2. `/recon`：构造缺失 / 改值夹具 → 对账页 → 下钻样本 → 生成修复 SQL。
3. `/recon` 异构：MySQL `users` ↔ Redis `user:*`（hash）→ 映射表单 → 缺失 / 改值命中 → 样本对比。
4. `/report`：4 个语义用例（分别 / 对比 / 合并 / 综合）→ 报告页 → 数字核对 → 导出 XLSX。
5. `/compare`：两个时间段 → 差值卡 → 图表 → 口径说明。
6. `/fix`：审计 → 计划 → 只读禁用 → 审批 → 验证。
7. 取消：长对账中途取消，状态 `canceled`，连接释放。
8. 无模型：`/report` 降级模板；`/recon` 正常。

移动端（Expo Web）：命令菜单、表单、产物查看、审批、取消。

### 17.4 真实实例验证

- 两个 SQLite 文件：确定性、可重复。
- 一个 MySQL + 一个 PostgreSQL：跨引擎结构 diff、行数对账、报告多源。
- 一个 MySQL + 一个 Redis：异构对账（表 ↔ 键空间），覆盖 hash / string / 缺键 / 改值；确认只发送 `SCAN` / `GET` / `HGETALL` / `MGET` 等只读命令。
- 真实只读 MySQL（沿用 `docs/10-real-mysql-readonly-regression.md` 的连接）：`/report`、`/recon` 不写入；审计全部为 read。
- 修复：只在临时库 / 容器执行；生产连接只验证“检查 + 计划 + 审批前拦截”。

### 17.5 验收场景

| 编号 | 场景 | 通过标准 |
|---|---|---|
| A1 | `/report`“分别看两个库的订单情况” | 生成 sections 布局；两源各自有章节；数字与 SQL 一致 |
| A2 | `/report`“对比两个库本月订单额” | comparison 布局；差值与百分比正确；口径说明存在 |
| A3 | `/report`“合并两个库的订单总额” | merged 布局；分源合计 sum；不可合并项被标注 |
| A4 | `/report` 综合周报 | mixed 布局；概览 + 分源 + 对比；PPTX 可打开 |
| A5 | `/recon` 3 缺失 / 2 改值 / 1 类型漂移 | 全部命中；样本下钻正确；修复 SQL 可执行 |
| A6 | `/recon` 无主键 | 只跑 L1，提示需要业务键，不产生错误行级差异 |
| A7 | `/diff` 结构差异 | DDL 目标方言正确；破坏性标红；同步需备份 + 审批 |
| A8 | `/compare` 两时间段 | 同口径两条 SQL；差值 / 贡献度正确；A=0 不显示无穷大 |
| A9 | `/fix` 只读连接 | 检查可跑；执行按钮禁用；后端也拒绝 |
| A10 | `/fix` 破坏性修复 | 备份成功后才允许；逐条审批；验证查询有结果 |
| A11 | 无模型 | `/diff` / `/recon` 正常；`/report` 降级并标注 |
| A12 | 取消 / 超时 | 状态正确；无悬挂连接；已完成步骤保留 |
| A13 | `/recon` MySQL ↔ Redis hash | 键映射 `id` ↔ `user:{id}`；缺失 / 改值命中；Redis 只读命令；TTL 默认忽略 |
| A14 | `/recon` Redis 不支持类型 / 超大 keyspace | list / set / zset 返回 `RECON_UNSUPPORTED_TYPE`；超过扫描上限标记不完整并提示 |
| A15 | 报告多源布局语义 | “分别 / 对比 / 合并 / 综合”四种措辞分别命中 sections / comparison / merged / mixed |

### 17.6 基线闸门

改动前后均须绿：

```bash
npm run verify:docs
npm run typecheck
npm test
npm run build
npm run e2e
```

对账 / 报告新增测试不得降低现有 core 49 / gateway 10 的基线；计数以实际输出为准，不在文档里写死。

## 18. 风险与回退

| 风险 | 影响 | 缓解 | 回退 |
|---|---|---|---|
| 键级对账误报 | 用户不信任结果 | 规范化 + 原始 / 规范化双计数 + 样本下钻 | 降级到 L1 行数对比 |
| 跨引擎类型 / 时区差异 | 结构和数据差异误判 | 目标方言映射 + 明确 manual 项 + 规范化配置 | 只做同引擎对比 |
| Redis keyspace 过大 / SCAN 成本 | 扫描拖慢缓存 | `SCAN` 游标 + COUNT + 键上限 + 生产默认 L1 | 只做抽样或缩小 pattern |
| Redis 键提取不一致 / TTL 过期 | 误报缺失或改值 | 显式映射 + 键归一化 + TTL 默认忽略 + `expired_during_scan` | 关闭键级对账 |
| Redis 写回语义未定 | 误改缓存 | v1 只生成命令不执行；修复需显式选择基准侧 | 只读展示 |
| 大表对账拖垮生产 | 性能 / 锁 | 只读、分批、限额、并发 2、超时 | 只跑 L1 或缩小表范围 |
| 报告数字被模型改写 | 准确率事故 | resultRef + 占位符 + compose 校验 | 关闭 AI 叙述，输出确定性模板 |
| PPT 模板单一 / 版式不可控 | 品牌适配不足、交付质量差 | v1 中性固定模板；模型只填内容；后续模板库 | 先交付 XLSX / PDF |
| 多源 prompt 超预算 | 成本 / 质量下降 | 只注入选中表；上限 4 源；截断提示 | 降为单源报告 |
| 命令与工具箱双实现 | 维护分叉 | 命令复用现有 service；工具箱保留入口 | 下线工具箱重复入口 |
| 长任务卡住 | 用户体验差 | SSE 进度、取消、超时、重启标记失败 | 手动重跑 |
| 契约漂移 | CI 红 / 文档失真 | verify-docs、类型检查、四处同步 | 回退命令定义与文档 |
| 权限绕过 | 数据事故 | 只读双重校验、审批、审计 | 关闭命令执行，仅保留检查 |

## 19. 已确认决策与剩余未决

### 19.1 已确认（2026-10-30 评审）

1. **命令命名**：统一 `/compare`；`/compose` 是笔误，不作为别名保留。
2. **PPT 模板**：v1 使用中性模板；模板库与品牌资源后续迭代。
3. **通知渠道**：v1 不引入邮件；后续接微信 / QQ / 飞书机器人。
4. **对账默认级别**：生产源默认只跑 L1，升级到键级扫描必须显式勾选。
5. **修复审批**：`/fix` 在 `full` 模式下仍强制备份 + 破坏性逐条审批。
6. **跨源定义**：跨源指不同服务器上的连接，允许 MySQL ↔ Redis 等异构引擎；与移动端无关，移动端只是客户端，不新增按设备 / 按连接的授权模型。
7. **全局工具**：M6 增加 `schema_diff` / `recon_data` / `transfer_data` 三个对比工具，后续机器人/MCP 阶段再增加 `mcp_list_tools` / `mcp_call`，工具数最终 40 → 45。
8. **源数量上限**：固定 4。

### 19.2 剩余未决

1. PPT 模板库的具体模板、品牌资源与页脚规范（后续迭代）。
2. 微信 / QQ / 飞书机器人的接入方式、凭据管理与消息格式（后续迭代）。
3. Redis 写回（`HSET` / `SET` / `DEL`）是否进入 v2，以及 TTL、原子性与基准侧语义。
4. 对账键归一化的默认规则（前导零、大小写、空白）是否按引擎预设。
5. `/recon` 对 MongoDB / Elasticsearch / 向量库的适配优先级（v2）。
6. `/fix` 是否增加孤儿外键、枚举越界、时区异常等检查项（v2）。

## 20. 文件清单

### 20.1 新增

| 文件 | 内容 |
|---|---|
| `docs/11-command-workflows.md` | 本文 |
| `packages/core/src/commands/types.ts` | 命令、槽位、源、产物类型 |
| `packages/core/src/commands/registry.ts` | 5 个业务命令 + `/ask` 兜底定义 |
| `packages/core/src/commands/validate.ts` | 定义与输入校验 |
| `packages/core/src/commands/index.ts` | 导出 |
| `apps/gateway/src/commands/runner.ts` | CommandRunner、状态机、SSE |
| `apps/gateway/src/commands/steps.ts` | 确定性步骤实现 |
| `apps/gateway/src/commands/tools.ts` | 命令私有工具（compose_report / submit_fix_plan） |
| `apps/gateway/src/commands/report.ts` | ReportSpec 校验、渲染数据准备、导出 |
| `apps/gateway/src/commands/compare.ts` | 同口径查询、差值、贡献度 |
| `apps/gateway/src/features/reconcile.ts` | 对账编排、规范化、差异分类、修复方案 |
| `apps/gateway/src/features/reconAdapters.ts` | 源适配器：TableAdapter / RedisAdapter（v2 扩展 Mongo / ES） |
| `apps/gateway/src/features/artifactStore.ts` | 产物读写（或并入 store.ts） |
| `apps/desktop/src/components/CommandSheet.tsx` | 通用命令表单 |
| `apps/desktop/src/components/ReconForm.tsx` | 异构对账的键 / 字段映射表单 |
| `apps/desktop/src/components/CommandRunCard.tsx` | 运行进度 / 审批 / 取消 |
| `apps/desktop/src/components/ArtifactView.tsx` | 产物容器与操作 |
| `apps/desktop/src/components/ReportView.tsx` | 报告渲染 |
| `apps/desktop/src/components/ReconView.tsx` | 对账结果 |
| `apps/desktop/src/components/FixView.tsx` | 修复计划与执行 |

### 20.2 修改

| 文件 | 改动 |
|---|---|
| `packages/core/src/agent/types.ts` | `AgentContextData.sources`、`AgentRunInput.sources`、工具白名单 |
| `packages/core/src/agent/prompt.ts` | 多源 Connections / Schema 段落 |
| `packages/core/src/agent/runtime.ts` | 可选工具列表透传 |
| `packages/core/src/index.ts` | 导出 commands |
| `apps/gateway/src/agentHost.ts` | 多源上下文、工具白名单、命令运行入口 |
| `apps/gateway/src/store.ts` | 三张新表、CRUD、清理 |
| `apps/gateway/src/routes.ts` | `/commands`、`/artifacts` 路由装配 |
| `apps/gateway/src/scheduler.ts` | artifact schedule tick |
| `apps/gateway/src/executor.ts` | 源集合校验（命令运行） |
| `apps/desktop/src/components/AgentPanel.tsx` | 斜线菜单改为注册表驱动 |
| `apps/desktop/src/components/tools/DataCompareTool.tsx` | 异构对账入口 / 与 `/recon` 共用结果视图 |
| `apps/desktop/src/lib/api.ts` | 命令 / 产物 API 客户端 |
| `apps/desktop/src/i18n.ts` | 命令文案 |
| `apps/desktop/src/store.ts` | 命令表单 / 产物标签页状态 |
| `apps/mobile` 对应页面 | 命令菜单、表单、产物、审批 |
| `scripts/verify-docs.mjs` | `required` 增加本文 |
| `README.md` | 文档索引增加本文 |

## 附录 A：ReportSpec 示例

```json
{
  "version": 1,
  "title": "双库订单周报",
  "layout": "mixed",
  "sources": [
    { "key": "a", "connectionId": "c_prod", "connectionName": "prod-mysql", "database": "shop", "engine": "mysql", "label": "生产库" },
    { "key": "b", "connectionId": "c_stg", "connectionName": "stg-pg", "database": "shop", "engine": "postgresql", "label": "预发库" }
  ],
  "sections": [
    {
      "id": "overview",
      "title": "概览",
      "blocks": [
        { "kind": "metric", "label": "本周订单额", "refs": [{ "resultRef": "s3", "valuePath": "rows.0.total", "sourceKey": "a" }], "combine": "none", "unit": "元" },
        { "kind": "narrative", "text": "本周生产库订单额 {{ref:s3.rows.0.total}} 元，预发库 {{ref:s6.rows.0.total}} 元。" }
      ]
    },
    {
      "id": "prod",
      "title": "生产库",
      "sourceKey": "a",
      "blocks": [
        { "kind": "chart", "resultRef": "s4", "chartType": "line", "x": "day", "y": "amount", "title": "按天订单额" },
        { "kind": "table", "resultRef": "s4", "columns": ["day", "orders", "amount"], "maxRows": 100 }
      ]
    },
    {
      "id": "compare",
      "title": "双库对比",
      "blocks": [
        { "kind": "comparison", "left": { "resultRef": "s3", "valuePath": "rows.0.total", "sourceKey": "a" }, "right": { "resultRef": "s6", "valuePath": "rows.0.total", "sourceKey": "b" }, "deltaMode": "both" },
        { "kind": "callout", "tone": "info", "text": "两库订单额分别统计，未做行级合并；口径：已支付订单，按下单时间。" }
      ]
    }
  ],
  "meta": { "intent": "分别看两个库本周订单，并做对比", "createdAt": "2026-10-30T10:00:00.000Z" }
}
```

## 附录 B：CommandDefinition 示例

```ts
export const REPORT_COMMAND: CommandDefinition = {
  id: 'report',
  aliases: ['/报表'],
  title: { zh: '生成报告', en: 'Report' },
  description: { zh: '把数据变成可保存、可刷新、可导出的报告', en: 'Turn data into a saved, refreshable report' },
  group: 'analysis',
  icon: 'file-chart',
  sources: { min: 1, max: 4, allowSameConnection: true, database: 'optional' },
  slots: [
    { key: 'sources', kind: 'sources', label: { zh: '数据源', en: 'Sources' }, required: true },
    { key: 'topic', kind: 'text', label: { zh: '报告主题', en: 'Topic' }, required: true, placeholder: '例如：本周订单与履约情况' },
    { key: 'period', kind: 'period', label: { zh: '时间范围', en: 'Period' }, advanced: false },
    { key: 'tables', kind: 'tables', label: { zh: '关注表', en: 'Tables' }, advanced: true },
    { key: 'format', kind: 'enum', label: { zh: '输出', en: 'Output' }, required: true, options: [
      { value: 'screen', label: { zh: '屏幕', en: 'Screen' } },
      { value: 'xlsx', label: { zh: 'Excel', en: 'Excel' } },
      { value: 'pdf', label: { zh: 'PDF', en: 'PDF' } },
      { value: 'pptx', label: { zh: 'PPT', en: 'PPT' } }
    ], default: 'screen' }
  ],
  execution: 'hybrid',
  maxRisk: 'read',
  artifact: 'report',
  allowedTools: ['inspect_schema', 'search_objects', 'run_sql', 'explain_sql', 'sample_rows', 'profile_column', 'analyze_chart', 'forecast_chart', 'render_chart', 'memory_search', 'update_plan'],
  extraTools: ['compose_report'],
  prompt: '按用户语义选择 sections / comparison / merged / mixed 布局；数字必须来自工具结果引用，不得手写。'
};
```

## 附录 C：对账结果示例（MySQL ↔ Redis）

```json
{
  "summary": {
    "targets": 1,
    "comparedKeys": 129757,
    "missingInRight": 3,
    "extraInRight": 1,
    "valueChanged": 2,
    "typeDrift": 1,
    "truncated": false
  },
  "targets": [
    {
      "left": "shop.users",
      "right": "redis:user:*",
      "key": "id ↔ extracted",
      "counts": { "left": 129757, "right": 129755 },
      "differences": [
        { "key": "10086", "status": "missing_in_right", "fields": ["id"] },
        {
          "key": "10087",
          "status": "value_changed",
          "fields": ["status"],
          "left": { "status": "PAID" },
          "right": { "status": "NEW" }
        },
        {
          "key": "10088",
          "status": "type_drift",
          "fields": ["created_at"],
          "detail": "MySQL DATETIME vs Redis hash string"
        }
      ],
      "samples": [
        {
          "key": "10086",
          "left": { "id": 10086, "status": "PAID", "name": "Ada" },
          "right": null
        }
      ]
    }
  ]
}
```
