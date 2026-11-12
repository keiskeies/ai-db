# 20. 表详略分档：由表的用途决定 schema 段的展开形状

> 状态：**已实现**（2026-11-11）
> 关联：`docs/04-ai-agent-design.md`（system 段构成、工具清单）、`docs/08-agent-accuracy-plan.md`（口径与枚举含义）、`docs/19-schema-change-events.md`（brief 落盘与失效）
> 前置提交：`83d133c`（schema 聚焦按窗口自动判断，去掉下拉框）、`76b7996`（压缩阈值改为窗口百分比）、`ecfa1d7`（本方案主体）、`76e7168`（省略行计数口径）

## 1. 要解决的问题

一句话：**「这张表在 prompt 里给多少字」过去是由模型窗口大小决定的，而它应该由这张表是什么决定的。**

排查结论（已读代码 + 实测确认）：

| 事实 | 位置 | 后果 |
|---|---|---|
| schema 段只有「展开列明细 / 只给表名」两种形状，切线是一张固定表数上限 | 原 `compressSchema` 的 `maxTablesWithColumns = 15` | 窗口 32K 和 1M 得到同样 15 张明细表；小窗口不够用、大窗口白白浪费 |
| 被砍掉明细的表，与「不重要」的表，在 prompt 里长得一模一样 | 同上：非明细表进 `other tables` 行 | 模型分不清「这张表很窄所以没列出来」和「这张表跟问题无关」，只能靠猜 |
| 字典/配置表（`pay_channel`、`order_status_dict`）一旦落到「只给表名」那一侧，**取值含义就消失了** | 同上 | **这是最要命的一条**：模型不知道 `status=3` 是「已退款」还是「已取消」，它不会来问，直接给一个**看起来完全正确的错数字** |
| `selectCoreTables` 用打分挑核心表，字典表分数天然低（外键少、行数小、没有历史命中） | `databaseBrief.ts:255-296` | `/init` 产物里本来就没有字典表的取值；prompt 里也没有；两处都缺，无人补 |
| 窗口大小参与决策的地方不止一处，且各自拍常数 | `profile.ts` 已有 `historyTokenBudget` / `midContextTokenBudget`，schema 侧没有对应口径 | schema + history 各自算各自的比例，**加起来可以超过窗口** |

**根因**：窗口大小是「能塞多少」的约束，不是「该塞什么」的判断。把约束当判断用，就会出现「字典表因为不重要被藏起来」这种分类错误，以及「换了个大窗口什么都能塞」这种资源错误。

## 2. 目标 / 非目标 / 反目标

**目标**

- 每张表拿到的不是「展开/不展开」的布尔，而是**一种形状**：活跃业务表给全列，字典表给「表名 + 取值含义」，桥接表给名字，冷表给名字 + 一句「它在这儿，可以查」。
- 分类**可解释、可覆盖**：每张非活跃表带一句人话理由，用户看得懂，并且在 brief 里删一行就能升档。
- 分类结果落盘、低频重算（跟 `/init`），保证 system 前缀**逐字节稳定**，吃服务商 prompt caching。
- 窗口大小降级为**护栏**（最多塞这么多），不再是**判决**（该给谁）。

**非目标**

- 不做查询值采样（要查库，属于 `/init` 执行器扩展，见 §7）。
- 不改 `selectCoreTables` 的核心表挑选逻辑，不改 `/init` 的章节结构（只在附录加一段）。
- 不做每轮重算 —— 见反目标。
- 不动 SQL 执行、审批、权限。

**反目标**（做到了也算失败）

- **每轮重算分档**：system 前缀每轮变一个样，prompt cache 全打穿，长会话成本翻倍。
- 把字典表的取值含义藏起来换 token：省下几百 token，换来一个不会被发现的错数字。
- 让模型以为某张表不存在：只要一张表从 prompt 里**彻底消失**（而不是「只给名字」），模型就会断定它不存在，而不是去 `search_objects`。
- 分类错了没法改：用户只能接受，或者去改代码里的正则。

## 3. 约束

- **不新增魔法常数来替代表属性**。本方案里参与决策的量只有：表自身可观测的属性（命名、列名、列数、行数估计、外键方向、查询历史命中、用户是否标注过）、模型档案里的 `contextWindow`/`maxOutputTokens`，以及 `profile.ts` 里**已存在**的 `PROMPT_RESERVE_TOKENS`、`DEFAULT_MAX_OUTPUT_TOKENS`（后者由原来的 `FALLBACK_MAX_OUTPUT_TOKENS` 更名而来，并升格为设置页预填的默认档位，见 `docs/04` §9.0.1）。新增的两个数（`SCHEMA_ROOM_SHARE = 0.35`、`MIN_SCHEMA_TOKENS = 1200`）与 `historyTokenBudget` 同族同类，放在同一处，并且**只当护栏用**——它们不参与「这张表是什么」的判断。
- 无 brief / 无档时，`compressSchema` 的输出必须与改动前**逐字节一致**（有单测钉住）。
- tier 模式下省略行的计数必须按「真正没渲染的表」算（`76e7168`）。
- 文案中文；prompt 内的 schema 段维持英文（与既有 system 段一致，不混语种）。

## 4. 方案选型

| 方案 | 内容 | 为什么不做 |
|---|---|---|
| A. 窗口公式定张数 | 按 `window / k` 算给多少张表展开明细 | 用户当场否掉：「你又开始写死数据了」。这仍是拿常数替代判断，只是常数会随窗口浮动 |
| B. 二档（业务表 / 其他） | 挑出核心表展开，其余只给名字 | 就是改动前的状态，字典表照样丢取值 |
| **C. 按用途分档 + 每档一种形状（已选）** | 5 档，各自固定形状；分类信号全部来自表可观测属性 | — |
| D. 每轮按问题做语义匹配 | 每轮 embedding/关键词决定展开谁 | system 前缀每轮变，缓存全废；且匹配错了静默失败 |
| E. 全量塞进去，靠大窗口硬扛 | 不做压缩 | 800 张表的库实测 ~40k+ tokens 纯 schema，且把「什么重要」的信号成本也一并丢掉了 |

C 的关键取舍：**「不动」不等于「简单掠过」**。字典/配置表是静态的，但它的语义权重极高 —— 所以它单独成档，给的是「表名 + 取值含义」这种**为它定制的形状**，而不是归到低频一侧。

## 5. 设计

### 5.1 五档与它们的形状

| 档 | 判定语汇 | prompt 里的形状 | 目的 |
|---|---|---|---|
| `active` 活跃业务表 | 业务命名 / 含业务时间列 / 有查询历史 / 用户标注过 | `- table orders (…)` + `columns: …` 全列 | 正常明细 |
| `config` 字典/配置 | 命名含 dict/config/status/region…，或**小体量 + 被 ≥3 张表引用** | `pay_channel: 0=支付宝, 1=微信 [dict]`（名行，**不占列明细预算**） | 把取值含义送到模型眼前 |
| `bridge` 桥接 | 列几乎全是外键、无业务时间列、行数 ≤10 万 | `user_role [bridge]`（名行） | join 时知道有这条路即可 |
| `cold` 低频 | 日志/审计/备份/按日期分区命名，或小体量无时间列无引用 | 独立一行 `- low-frequency tables (present and queryable, name only — ask or call inspect_schema before using them): …` + `[low]` | **表存在**这件事不能让模型不知道 |
| `system` 系统内部 | `pg_`/`sqlite_`/`information_schema`/`flyway_` 等 | 名行 + `[sys]` | 抑制「顺手查系统表」 |

段首带图例 `TIER_GUIDE`（`schemaTiers.ts:157`），末尾钉一句：**"A table absent from the brief still exists — never conclude otherwise."**

本档**不靠标记的善意**：冷表单独成行并写明「present and queryable」，就是因为把它们并进通用的 `other tables` 行实测会让模型直接当它们不存在。

### 5.2 分类信号与规则顺序

`classifyTable`（`packages/core/src/agent/schemaTiers.ts:116`）——纯函数，无 IO，输入全是可观测事实：

```
1. SYSTEM_NAME            → system   系统/迁移内部表
2. curated（用户在业务上下文里标注过）→ active   ★紧跟系统表，兑现「用户标注过的表永不降档」
3. COLD_NAME              → cold
4. CONFIG_NAME && rows≤5000 && 出向外键≤1 → config
5. hits ≥ 2（近 30 天查询历史出现次数）→ active   团队真的在查它
6. incoming ≥ 3 && rows≤5000 && 无业务时间列 → config   命名没命中但结构上是维度表
7. 出向外键≥1 && 非主非外键列≤1 && rows≤10万 && 无时间列 → bridge
8. BUSINESS_NAME || 含时间列 || hits==1 → active
9. rows≤1000 && 列≤8 && 出向外键≤1 → cold
10. 默认 → active（理由里写明「若属误判可覆盖」）
```

顺序是有讲究的：**第 2 条必须在第 3、4 条之前**。原实现把 `curated` 放在命名规则之后，结果「用户专门写过描述的表」因为名字里有 `log` 就被降档 —— 承诺和代码互相打脸，测试逼出来的。

判不准时**一律往 `active` 靠**（第 10 条）。降档的代价是模型少看信息、可能算错；升档的代价只是多花 token。不对称，所以偏置也要不对称。

### 5.3 取值含义从哪来

`extractEnumGloss`（`schemaTiers.ts:54`）从注释里抽 `0-待支付 1-已支付` / `状态: 0=待支付, 1=已支付` / `level：1=普通 2=VIP`，统一成 `0=待支付, 1=已支付`。两个硬约束：

- 标签必须以字母/汉字**开头**，否则 `2024-01-05` 会被切成 `024=01`；
- 标签内**不能含空格**，否则 `0-待支付 1-已支付` 会吞成一条（这就是踩过的坑：`[一-鿿 A-Za-z0-9_]{1,14}` 允许空格，产出 `0=待支付 1, 2=已退款`）。

取值少于 2 个不算枚举说明，返回 `undefined`。

`tableEnumGloss`（`schemaTiers.ts:84`）**先表注释、后列注释**：真实字典表的表注释往往只有「订单状态字典」四个字，取值挂在 `status` 列注释上。实测两种都通：

```
table-comment  → 0=支付宝, 1=微信
column-comment → status: 0=待支付, 1=已支付, 2=已退款
```

多列时每列带列名前缀（`status: … | channel: …`），否则模型会把两组取值混成一谈。边界：每表最多挂 3 列（`GLOSS_COLUMNS`）、单表总长 200 字符封顶（`GLOSS_MAX_CHARS`），超了整条丢掉 —— 名行清单不能退化成注释转储。候选列还要过 `isEnumish`（小整数 / 短字符串）：**故意不含 TEXT**，自由文本列注释里的「2020:已上线」这类组合会被误读成枚举，制造出一个假含义，比没有含义更糟。

**没做的事**：不查库采样取值。采样要发 SELECT，属于 `/init` 执行器的扩展（§7），本期只读注释。

### 5.4 窗口只做护栏：`schemaTokenBudget` + `tierDetailBudget`

`schemaTokenBudget({contextWindow, maxOutputTokens})`（`providers/profile.ts:148`）：

```
room   = window - maxOutputTokens - PROMPT_RESERVE_TOKENS     // 与 historyTokenBudget 同一分母
budget = max(MIN_SCHEMA_TOKENS, floor(room * SCHEMA_ROOM_SHARE))
```

分母和 `historyTokenBudget` / `midContextTokenBudget` **共用同一套余量常量**，所以 schema 段和 history 段不可能各自算出自己的比例、加起来把窗口撑爆 —— 这是过去几处阈值各拍各的留下的真实隐患，顺手收掉了。

`tierDetailBudget`（`prompt.ts:138`）再把这个 token 上限换算成「多少张表可以展开列明细」，按**实际列数**计费（`40 + min(columns,48) * 8`），不拍平均列数：同样预算下窄表能多容纳几张，宽表少几张。名行的固定开销（`NAME_LINE_TOKENS = 12`/张）先扣掉再买明细，避免「明细买满、名行溢出」。

`compressSchema` 因此变成**两趟**：先排好每张表的归属（哪个库、是否 focus、什么档），再算明细预算 —— 因为「谁竞争预算」取决于分档结果。`candidates` 沿用排序结果，focus 命中与用户标注过的表排在最前，所以预算不够时**先砍的绝不是本轮问题要的表**。

实测（脚本测量，非估算；`length/3.6` 折算 tokens）：

| 库规模 | 窗口 | 分档后 schema 段 | 上限 | 改动前（无档） |
|---|---|---|---|---|
| 20 张（2 字典 + 2 日志） | 32K / 128K | 1.8k | 6.9k / 40.5k | 1.3k |
| 160 张（16 字典 + 16 日志） | 32K | 5.9k | 6.9k | 1.6k |
| 160 张 | 128K | 12.3k | 40.5k | 1.6k |
| 800 张（80 字典 + 80 日志） | 32K | 6.0k | 6.9k | 1.4k |
| 800 张 | 128K | 13.1k | 40.5k | 1.4k |

**每个规模、每个窗口都在上限内**，且随窗口自动缩放。改动前的数字看着更小，但那是**假小**：700 张表被折叠进 `other tables`，模型看不见它们，也就不会去查 —— 小窗口下的 6.0k 是「字典取值在场、每张表都在名册上」的 6.0k。这正是护栏存在的理由：分档让 schema 段变大是**有意的**，护栏负责让它不至于失控。

### 5.5 落盘：两层，各管各的

分档结果在 `/init` 时算一次（`computeTableTiers`，`databaseBrief.ts:303`），存两处：

1. **frontmatter `table_tiers`**（机器读，紧凑）：`name=tier:reason;…`，转义 `; = " :` 与反斜杠，逐字符扫描解析（`indexOfUnescaped`）。**只写非活跃表** —— `active` 是默认档，写出来等于把体积翻倍去买一个「没有特殊性」的事实。推论：*表不在 `table_tiers` 里 ≡ 它是活跃表、完整展开*。
2. **brief 附录 `# 9.1 表详略分档（人工可覆盖）`**（人读、人改）：三列表格 `| 表 / 视图 | 档位 | 判定理由 |`，只列非活跃表，附一句统计行。

人工段落的承诺必须是真的，所以 `mergeTierRows`（`databaseBrief.ts:426`）做的是**行级手术**而不是整段重渲染：删掉的行不复活、新增的表补进表格、只重算统计行。整段重渲染会让段落里那句「`/init` 不改写你写的文字」变成谎话。

`resolveTiers(auto, lastEmitted, manual)`（`databaseBrief.ts:397`）三方合并：

| manual 段落 | `lastEmitted` 有这行 | 含义 | 结果 |
|---|---|---|---|
| 不存在（首次 `/init` 前的旧 brief） | — | 用户还没机会表态 | 全用自动分类 |
| 存在且为空表 | — | 用户把整张表删空 = 声明「全部完整展开」 | 全部 active |
| 存在、缺这一行 | 有 | **用户删了它** → 显式升档 | active，不复活 |
| 存在、缺这一行 | 没有 | 新表，用户还没见过 | 用自动分类 |
| 存在、有这一行（改了档位列） | — | 人工改档 | 以人工为准，**理由也取人工那一列** |

`lastEmitted`（上一版 frontmatter）存在的**唯一理由**就是区分「用户删了这行」和「这是张新表」。少了它这两种情况在文本上完全同形，只能二选一错。

两个已修的坑，都在这条链路上：

- 三列行解析**必须锚定行尾**。附录全量清单是七列表格，不锚 `$` 时七列行也被当成分档行读进来，实测**每张表**都盖上「人工在 brief 的分档表里指定」，自动分类被静默清空。
- 人工行的**第三列（理由）要读出来**。早期只取表名和档位，用户在表里写的解释性文字在下一轮 `/init` 后被替换成通用文案 —— 「可解释」这个卖点当场失效。

另外 `resolveTiers` 会丢弃**已不存在的表**的行：留着的话模型会去查一张不存在的表。

### 5.6 接线

| 文件 | 改动 |
|---|---|
| `packages/core/src/agent/schemaTiers.ts` | 新增。`TableTier` / `classifyTable` / `extractEnumGloss` / `tableEnumGloss` / `TIER_GUIDE` |
| `packages/core/src/agent/prompt.ts` | `SystemPromptOptions` 加 `maxOutputTokens` / `tiers`；`compressSchema` 两趟化 + 五档形状（`:252`、tier 分支 `:351` 起）；`tierDetailBudget`（`:137`）；`schemaPreamble`（`:562`）分档模式换措辞 |
| `packages/core/src/agent/providers/profile.ts` | `schemaTokenBudget`（`:126`），与既有预算常量同处 |
| `apps/gateway/src/features/databaseBrief.ts` | `computeTableTiers` / `parseManualTierRows` / `resolveTiers` / `mergeTierRows` / `renderTierTable` / frontmatter 读写 |
| `apps/gateway/src/agentHost.ts` | `:551` 传 `tiers: brief?.meta.tiers` + `contextWindow` + `maxOutputTokens` |
| `apps/gateway/src/commands/reportAgent.ts` | `:522` 报告 Agent 也走分档：按 source 各读各的 brief（原来只有单个主库 brief 被复用，多源场景串档） |

`schemaPreamble` 值得单说一句：原来那句 "Column detail is prioritized for the tables most relevant to the question" 在分档模式下**描述的是相反的行为**（分档模式不按问题裁剪，按用途给形状），所以分档模式换成 "Each table is shown with the detail its tier deserves"。给模型写说明，说反了比不说更糟。

### 5.7 缓存

分类只在 `/init` 重算，落盘后每轮读同一份 → **system 前缀逐字节稳定**。有单测直接钉这个性质（`tier output is byte-stable across turns when the tiers are the same`）。每轮重算会把 system 段变成每轮变化的内容，prompt caching 直接失效 —— 这是 §3 第一条约束存在的原因。

## 6. 我做主的决定（可被否，默认按此实现）

- **5 档而不是 2 档**。多出来的形状各自对应一个具体失败模式（字典丢取值、冷表被当成不存在），不是为了体系好看。
- **字典表不占列明细预算**，但它必须出现在名册上并带取值。宁可为它多花 30 tokens。
- **frontmatter 只写非活跃表**。接受「表不在表里 = active」这个隐式约定，换来一半体积，并在 `BriefMeta.tiers` 的文档注释里写明。
- **`curated` 紧跟 `system` 之后**：用户标注过的表除了系统表一律不降档。
- **`SCHEMA_ROOM_SHARE = 0.35`**。它只当护栏；判决权在分档手上。如果你觉得该更保守/更激进，改这一个数即可，不影响分类。
- **列注释兜底取值**，但 TEXT 列不参与、单表 3 列 / 200 字符封顶。
- **报告 Agent 也接分档**，并顺手修掉「多源只用主库 brief」的串档问题（超出本方案范围，但是同一条链路上的真缺陷）。

## 7. 留给实现者

1. **取值采样**：`/init` 时对 `config` 档、且注释抽不出取值的表，跑 `SELECT DISTINCT <col> LIMIT 20`，把真实取值补进理由。要处理：无权限（跳过，不报错）、大表（先 `rows <= N` 才采）、结果缓存进 brief 而不是每轮查。这是本方案唯一还缺信号的地方 —— 中文库里大量表注释是空的。
2. **分档覆盖情况的可观测性**：`/init` 完成后提示「N 张表判为低频，其中 M 张无取值说明，可在 brief 9.1 里核对」。误判不可怕，看不见误判才可怕。再进一步：把本次分档与上一版 frontmatter 对比，**只报变化**（「`t_dim_zone` 由活跃改为字典，理由：新增 4 张表引用它」），并对用户手工改过的表补一句「（人工覆盖）」——否则用户改了档位、下次 `/init` 后看不出到底生没生效，就会开始不信这套机制。
3. **多库同名表**：现在按裸表名回退匹配（`tierOf`），跨库同名会共用一档。等真撞上再按 `db.table` 键化。
4. `selectCoreTables` 与分档共享信号（外键、行数、历史、标注）但目的不同（挑核心 vs 定形状）。如果将来两边理由文案开始漂移，考虑抽一层共用的信号计算。

## 8. 验证方式

```
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"   # 需要 node ≥ 22.13（node:sqlite）
npm --workspace @aidb/core run test          # 388 pass / 0 fail（含 17 条分档用例）
npm --workspace @aidb/gateway run test       # 434 pass / 2 fail（见下）
npm run typecheck && npm run verify:i18n     # 均 exit 0
```

- `packages/core/test/schema-tiers.test.ts`：规则顺序、每档形状、取值抽取与列注释兜底（含限长、TEXT 不参与）、逐字节稳定性、小窗口保名砍列、无档时输出不变、省略行计数。
- `apps/gateway/test/database-brief.test.ts`：三方合并五种情形、删行不复活、新表补入不重复表头、人工理由保留、已删表行丢弃、三列锚定不被七列附录污染、`preservedSections` 含 `tiers`。

那 2 条 gateway 失败是**本机环境问题**，不是本改动引入的：`git stash` 到干净树后跑同样 2 条，一样红（`database-brief.test.ts`「custom folder wins over the stored path」、`filesystem-paths-arg.test.ts`「read_file 收到单元素 paths…」，都是 Windows 风格路径拼接断言）。

手动验收：对真实库跑 `/init`，打开 `<库名>.AiDB.md` 看 9.1 段 → 删掉一张表的行 → 再跑 `/init` → 该表应完整展开且行不复活；问一个「按状态分组计数」的问题，回答里的状态名应与注释取值一致。

## 9. 风险

| 风险 | 现状 |
|---|---|
| **命名启发式误判**，把需要明细的表降到低频 | 三重缓冲：表名**永远**在名册上（模型知道它存在、可以问、可以 `inspect_schema`）；`inspect_schema` 任何时候都能拿到全列；brief 9.1 一行即可覆盖。最坏情况从「算出错数字」降级为「多花一轮工具调用」 |
| 字典表注释没写取值 → `config` 档退化成只给名字 | 真实存在。列注释兜底能救一部分，剩下的等 §7.1 的采样。此时与改动前**同等**（都是只给名字），不会更差 |
| 分档跟 `/init` 走，新建表在下一次 `/init` 前没有档 | 无档 = 按默认（活跃、完整展开）处理，属安全侧 |
| `SCHEMA_ROOM_SHARE` 对某些模型偏大/偏小 | 只影响列明细张数，不影响分类正确性；实测 32K~128K 都在上限内 |
| 人工段落被用户整段删掉 | 视为「全表完整展开」的显式声明，且不复活（已测） |
| 700+ 张表时名册本身变长 | 名行 12 tokens/张，800 张 ≈ 10k；受 `schemaTokenBudget` 与 120 行名册上限双重约束，实测 800 张 / 32K 为 6.0k < 6.9k |
