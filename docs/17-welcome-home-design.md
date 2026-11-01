# 17. 欢迎页改版：当前库的家

> 状态：已实现（`apps/desktop/src/components/Welcome.tsx` + `src/styles/home.css` + `src/lib/dbHome.ts`）
> 关联：`docs/03-ui-ux-design.md` §9 空状态、`docs/14-dashboard-design.md`

## 1. 为什么改

改版前的欢迎页是 6 段等权盒子的竖排堆叠：hero → 4 张功能卡 → 4 个指标 → 两对面板 → 脚注徽标 + 提示。
在真实数据下的可复现问题：

| # | 问题 | 证据 |
|---|---|---|
| 1 | 同一批数字出现三次 | 「对象 5 / 数据量 4786」同时出现在指标条、`打开示例库` 卡片副标题、脚注徽标 |
| 2 | 同一动作有三个入口 | 「AI 体检」出现在卡片、`AI 快捷能力` 面板、脚注 |
| 3 | 两个半屏大的死面板 | 新装环境里 `最近查询` 恒为 0、`最近会话` 为空，各占半屏 |
| 4 | 作用域自相矛盾 | `最近查询` 按 connectionId 过滤，`最近会话` 却是全局（59 条不分连接） |
| 5 | 多库连接聚合错误 | `schemas[conn]` 对 MySQL 只预取默认库，其余库是 `{name, tables: []}`；指标把 20+ 个库混算 |
| 6 | 空状态文案说错话 | 表未加载时显示「连接数据库后加载对象结构」，但连接是通的 |
| 7 | 标签名不符实 | 「打开示例库」实际打开当前连接的第一张表，不是示例库 |
| 8 | 无视觉层级 | 11px 标题平铺，眯眼测试（squint test）分不出主次 |

根因是两个：**一页之内混用了三种作用域**（全局 / 连接 / 库），以及**用盒子数量代替信息层级**。

## 2. 设计目标

把欢迎页变成「**当前库的家**」：回答三个问题，且只回答这三个。

1. 我现在在哪个库？（作用域）
2. 这个库里有什么？（对象）
3. 接下来能做什么？（下一步动作）

### 契约（实现必须守住）

- **单一作用域**：整页只有一个 `connectionId + database`。任何计数都必须点击后看到同源数据。
- **首屏优先**：NN/g《Scrolling and Attention》——1440×900 下 57% 的浏览时间停在首屏、74% 在前两屏。因此不设「滚动才有内容」的区块。
- **主次分明**：一张主栏 + 一张窄栏，用宽度差（1.62fr : 1fr）建立层级，而不是四等分。
- **状态三分**：加载中 / 空 / 未加载必须是三种不同表述（NN/g《Designing Empty States in Complex Applications》）。
- **颜色是信息不是装饰**：`--agent` 只用于「AI 生成的内容」；其余一律中性 token。

## 3. 布局（方案 A）

```
┌ 当前库头部 ───────────────────────────────────────────────┐
│ [库图标] Demo · Shop DB                    [新建查询][仪表板]│
│          SQLite · DEV · 5 表 · 4,786 行     [AI 体检][刷新] │
├────────────────────────────────┬─────────────────────────┤
│ 这个库里有什么          [主键齐全] │ 接下来能做什么   [打开助手] │
│  order_items ████████ 2,242 5列 │  趋势   近 12 个月…       │
│  events      ██████   1,500 5列 │  分组统计 按 status…      │
│  orders      ███        900 6列 │  Top N  users 中…        │
│  users       ▏          120 6列 │  ─────────────────────── │
│  products    ▏           24 5列 │  数据库体检 / 沉淀业务口径  │
│  ── 体检：行数已全部估算 · 主键齐全 ──────┘ │
├────────────────────────────────┴─────────────────────────┤
│ 最近跑过  ● SELECT status… 0ms  ● SELECT date… 1ms         │
└──────────────────────────────────────────────────────────┘
```

### 3.1 当前库头部

整页唯一的「你在哪」声明，把原来分散在 hero、指标条、脚注里的信息浓缩成一行：

- 连接名 + 连接色图标（复用侧栏色板，不引入新语义）
- 引擎标签、环境 pill、只读锁、库名（多库连接显示下拉切换器）
- 汇总 `N 表 · N 视图 · N 行`——**这是整页唯一一次总数出现**
- 动作区：`新建查询`（主按钮，整页唯一实心按钮）/ `仪表板` / `让 AI 体检这个库` / 刷新结构

设计取舍：
- 文件型连接的库名就是文件路径，直接展示是噪音（状态栏已有），因此只在库名不等于连接名且不像路径时显示。
- 五个动作里只有一个是 primary，避免「所有按钮都很重要」等于「没有重点」。

#### 3.1.1 「当前库」只有一个真源

首页显示哪个库，由 store 的 `agentDatabase` 决定，而不是首页自己的局部状态。因此所有能改变「我在看哪个库」的入口都写同一个字段：

| 入口 | 行为 |
|---|---|
| 左侧栏点连接 | `selectConnection` → 恢复该连接上次记住的库（`agentDatabaseByConnection`） |
| **左侧栏点库节点** | 先 `selectConnection`（若换了连接），再 `setAgentDatabase(库名)` → 首页整页换库 |
| 首页头部的库下拉 | `setAgentDatabase(库名)` |
| 首页点表行 / 点建议 | `setAgentDatabase(库名)` 后再打开目标 |

`selectConnection` 只在「连接真的变了」时才覆盖 `agentDatabase`，所以「先 select 再 set」的顺序是安全的。

选中的库在侧栏用 2px 左侧竖线 + 提亮标出（`.db-node.current`），用户能直接看出首页正在展示哪个库。

已解耦（见 `docs/18-agent-home-decoupling.md`）：左侧点库只写 `homeDatabase`，不再改写 Agent 的目标库。两边不一致时 AI 面板顶部会显示一行提示并提供「对齐到 <库>」。

### 3.2 主栏「这个库里有什么」

表清单按**行数估算降序**——首页要回答「这个库里最重的是什么」，而不是按字母序。每行：

- 表名（等宽）、行数、列数
- 行数条：横向长度表示相对规模，一眼看出分布（替代原来的一排等宽数字）
- 无主键标记（`KeyRound`）、视图标记
- 点击 → `openData(connectionId, table, database)`，即「看到的就是点进去的」

第一行略微提亮，给眼睛一个入口。超过 10 张表时给出「还有 N 张 · 让 AI 介绍全部」。

### 3.3 体检摘要

面板底部一行把「要问 AI 才知道」的库健康度直接摆出来：行数估算覆盖度、无主键表数、空表数。
这解决了原版「指标条重复三次」——数字只出现一次，且**带含义**（不是裸的 `5`，而是「5 张表里 X 张无主键」）。

### 3.4 侧栏「接下来能做什么」

数据来自 `POST /agent/suggest`（`api.suggest`），它是**真按这个库的表名、列名和最近查询算出来的**，不是写死的 prompt：

- 每条建议显示 kind 标签（趋势 / 分组统计 / Top N / 关联完整性 / 数据质量）+ 具体 prompt
- 点击 → 打开 Agent 面板并填入 prompt，同时把 `agentDatabase` 对齐到当前库
- 底部两个快捷动作：`数据库体检`、`沉淀业务口径`（写入长期记忆）

原版 4 条硬编码 prompt 且只在「存在名为 orders 的表」时分支，换任何库都是同一套文案。

### 3.5 「最近跑过」

单行芯片，替代原来占半屏的「最近查询」面板：

- 过滤掉内省噪音（`pragma` / `show tables` / `select name from sqlite_master` / 事务控制）
- 按 SQL 去重，最多 4 条
- 点击 → `openQuery` 带着这条 SQL 新开查询标签
- 历史接口只按 `connectionId` 过滤，因此客户端再按 `database` 筛一道，避免 MySQL 下看到别的库的 SQL

## 4. 状态矩阵

| 状态 | 判定 | 呈现 |
|---|---|---|
| 完全没有连接 | `connections.length === 0` | 居中门厅：新建连接（primary）/ 让 AI 帮我建 + 引擎支持说明 |
| 库结构加载中 | `schemaLoading[conn:db]` | 头部显示「正在读取库结构…」+ 主栏骨架屏 |
| 库里有表 | `tables.length > 0` | 完整布局 |
| 库是空的 | 已加载但 `tables.length === 0` | 「这个库里还没有表」+ `让 AI 建表` |
| 建议不可用 | `suggest` 失败/非 SQL 引擎 | 建议区退化为说明文案，不影响整页 |

关键：**空 ≠ 未加载**。原版两者共用一句「连接数据库后加载对象结构」，而连接明明是通的。

## 5. 响应式

工作区可用宽度 = 视口 − 连接侧栏 − AI 面板，且两者都可拖拽——同样的窗口宽度下首页可用宽度可能差出 600px。
因此用**容器查询**（`container-type: inline-size` 于 `.home`）而不是视口媒体查询：

| 容器宽度 | 变化 |
|---|---|
| ≤ 760px | 头部由横排转竖排，动作区左对齐 |
| ≤ 720px | 两栏塌成一栏（表清单在上、AI 建议在下），高度交给内容 |
| ≤ 520px | 隐藏行数条、最近跑过转为一列 |

踩过的坑：竖排后主轴变成纵向，`.home-scope { flex: 1 1 260px }` 的 flex-basis 会变成**高度**，把头部撑成 260px 的空面板。必须在竖排分支里复位为 `flex: 0 0 auto`。

## 6. 实现结构

| 文件 | 职责 |
|---|---|
| `src/lib/dbHome.ts` | 纯函数：作用域解析、按库切分 schema、派生事实（行数/主键/外键扇入）、历史去噪、建议拉取 |
| `src/components/Welcome.tsx` | 只负责渲染与交互，不再自己猜作用域 |
| `src/styles/home.css` | 全部 `.home-*` 样式，最后加载 |
| `main.tsx` | 在 `tools.css` 之后引入 `home.css` |

删除的死代码：`app.css` 的 `.welcome-card/.welcome-grid/.welcome-hero/.welcome-mark/.welcome-inner/.welcome-section` 及响应式规则、
`dashboard.css` 的 `.welcome-metrics/.metric*/.welcome-dashboard/.welcome-footnote`、
`industrial.css` 的 dense welcome 覆盖块。这些类在改版后已无任何组件引用（已用 `grep` 全仓确认）。

**保留**：`.dash-empty`（22 处引用）、`.status-led`（2 处）、`.table-chips` 等仍被其它视图复用的规则。

## 7. 可访问性与稳定性

- 所有表格行、建议项、历史芯片都是 `<button>`，键盘可达。
- 每行有 `title` 说明完整语义；AI 建议的 `reason` 作为 tooltip。
- 稳定测试钩子：`welcome-home`、`welcome-new-query`、`welcome-ask-ai`、`welcome-health`、`welcome-table-<name>`、`welcome-db-switch`、`welcome-suggest-<kind>`、`welcome-refresh`、`welcome-new-connection`。
- `scripts/e2e.mjs` 原用 `welcome-open-demo` 进入 demo 订单表；改版后该卡片不存在，改为 `openDemoTable(page)` 点击 `welcome-table-orders`，用例意图与断言（100 行 / 行号 / status 列 / 列面板）不变。

## 8. 后续

1. **回不去**：`welcome` tab 一旦被任何 open* 动作过滤掉就永久消失（`tabs.filter(t => t.id !== 'welcome')`），目前只能靠关闭全部标签恢复。作为「家」，应提供常驻入口（Ribbon 常驻按钮或连接行右键「回到库首页」），或让 welcome tab 永驻。
2. `--agent === --accent`（同为 `#45c8c3`），AI 与普通操作没有色彩信号。本版用**图标 + 底色 + 标签**区分，未擅自定义新色；是否拆成两个 token 属于设计系统决策。
3. `api.history` 不支持 database 过滤，当前靠客户端筛。数据量变大后应在网关加 `database` 参数。
4. 侧栏连接行点击同时执行 `selectConnection` + `toggleConnection`（选中并展开），语义混杂，可单独整理。
