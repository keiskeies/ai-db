# 19. 结构变更事件（schema_changed）与客户端自动失效

> 状态：**已实现**（2026-11-02）
> 关联：`docs/05-data-and-api.md`（流式事件）、`docs/02-feature-spec.md`（对象浏览器 / 表设计器）
> 实施计划：`docs/superpowers/plans/2026-11-02-schema-change-events.md`

## 1. 要解决的问题

用户报告：Agent 给表加了注释，打开「表设计」看不到注释；在左侧刷新库信息之后才看得到。

排查结论（已读代码确认）：

| 事实 | 位置 | 后果 |
|---|---|---|
| 服务端有 `schema_cache`，按 `(connection_id, database_name)` 存 JSON，TTL 30s | `store.ts:2560`、`manager.ts:139-168` | 缓存本身工作正常 |
| Agent 执行 DDL 后会清缓存 | `executor.ts:426` 等 | Agent 这条路径上服务端缓存是干净的 |
| **但 `POST /query`（SQL 窗口）执行 DDL 从不清缓存** | `routes.ts:379-430`，无 `invalidate` | **第二个独立缺陷**：SQL 窗口建表/改表后，服务端 30s 内一直返回旧结构，刷新也没用（除非 TTL 过期） |
| **`/tx/commit`、`/tx/rollback` 也不清缓存** | `routes.ts:1159`、`1178` | 事务里改结构后同理 |
| **`commands/` 整个目录没有一处 `invalidate`** | `grep -rn invalidate apps/gateway/src/commands/` → 空 | 命令工作流里的 DDL 步骤不清缓存 |
| 客户端 `store.schemas[connectionId]` 是前端快照，只有 `refresh=true` 才重拉 | `apps/desktop/src/store.ts:406` | Agent 回合结束后客户端不重拉，渲染用的是回合前的快照 |
| 设计器把结构拷进组件局部 state，用 `initializedFor` 挡住重同步 | `DesignView.tsx:287` | 已打开的设计器 tab 拿到新 `tableInfo` 也不更新 |
| Agent 回合的 SSE 是**单次请求的流** | `routes.ts:2289` | 只回给发起该回合的客户端；其它标签页、移动端、SQL 窗口都收不到 |

**根因（两层，都要修）**：

1. **服务端漏清缓存**：清缓存挂在各个路由/工具上，谁忘了写谁就错。`/query`、`/tx/*`、`commands/*` 都漏了。
2. **无跨客户端传播通道**：即使清了缓存，其它客户端仍持有旧快照。

## 2. 目标 / 非目标 / 反目标

**目标**

- Agent 改完结构，任何已打开的客户端（桌面、Web、移动端）不手动刷新就能看到新结构。
- 覆盖所有结构变更来源，且**不再依赖「每处都记得调 invalidate」**。
- 多标签页、多窗口、多设备一致。
- 正在编辑且未保存的表设计 tab 不被静默覆盖。

**非目标**

- 不改 `schema_cache` 的存储方式与 TTL。
- 不做增量 diff（事件只说「这个连接的结构变了」）。
- 不做实时协同编辑。
- 不动 Agent 推理与工具调用逻辑。
- 不改 `POST /query` 的请求/响应契约。

**反目标**（做到了也算失败）

- 一次 Agent 回合改 5 张表 → 客户端发起 5 次全库 describe。
- 断线期间的事件永久丢失，客户端从此一直显示旧结构。
- 设计器里用户填了一半的列定义被无提示丢弃，或**被另一张同名表的结构覆盖**。
- 网关没起时（纯前端 dev），客户端不停弹错误提示或无限重连。
- token 为空时无限重连。

## 3. 约束

- 不新增第三方依赖（`ws` 已是网关依赖，`apps/gateway/package.json:34`；桌面端用浏览器原生 `WebSocket`）。
- `AgentEvent`（`packages/core/src/agent/types.ts:168`）**不得增加成员**——`schema_changed` 不是回合事件，塞进去会污染 `isAgentEvent` 与 SSE 解析。
- WS 鉴权沿用现状：`/ws?token=`，未授权以 `4401` 关闭（`server.ts:150`）。
- 桌面端与 Web 是同一份 `apps/desktop`；Vite 已配 `/ws` 代理（`vite.config.ts`）。
- 文案一律中文。

## 4. 方案选型

| 方案 | 结论 |
|---|---|
| A 前端自愈（`openDesign` 强制刷新 + 回合收尾启发式重拉） | 弃：盖不住别的标签页/移动端改结构，也盖不住 SQL 窗口 DDL |
| **B 事件广播（选定）** | 选定：来源无关、跨客户端、跨设备 |
| C 砍缓存（TTL=0 或版本号） | 弃：治不了「客户端快照」，且大库每次展开全量 describe |

B 的通道：

| 通道 | 结论 |
|---|---|
| **既有 WebSocket `/ws`（选定）** | 三端共用；移动端已有连接与自动重连（`apps/mobile/App.tsx:469-495`）；网关心跳鉴权现成 |
| 新增全局 SSE `/api/events` | 弃：移动端会变成 WS + SSE 两套机制 |
| 复用回合 SSE | 弃：只对发起回合的客户端可见 |

## 5. 设计

### 5.1 事件定义

新增 `apps/gateway/src/events.ts`（网关内部类型，不进 `AgentEvent`）：

```ts
export type SchemaChangeCause = 'agent' | 'user';

export interface SchemaChangedEvent {
  type: 'schema_changed';
  connectionId: string;
  cause: SchemaChangeCause;
  at: string;  // ISO，仅用于日志排障
}

export class GatewayEvents {
  emitSchemaChanged(event: SchemaChangedEvent): void;
  onSchemaChanged(listener: (event: SchemaChangedEvent) => void): () => void;  // 返回取消订阅
}
```

- **粒度是 connectionId**，不带 `database`：`clearSchemaCache` 按连接整清，带库名会诱导客户端只刷一个库。
- 不带变更明细（非目标）。
- 监听器抛异常必须被 `emitSchemaChanged` 兜住并 `console.error`：坏监听不能拖垮 DB 操作。

### 5.2 服务端：改成单一发射点

**这是与初版设计最重要的不同。** 不在 25 个 `invalidate` 调用点挂事件，而是：

1. `ConnectionManager` 增加可选构造参数 `events?: GatewayEvents`（可缺省——多个测试直接三参构造）。
2. `invalidate` 改签名：

```ts
invalidate(connectionId: string, cause: SchemaChangeCause = 'user'): void
```

仍做清缓存 + 发事件。它继续服务于**非 SQL 路径**（Redis 键、Mongo 集合索引、向量集合等，`manager.ts` 内 12 处）。

3. **`manager.query()` 内集中判定**。它已经是所有 SQL 执行的唯一咽喉（`/query`、`/ddl/execute`、`executor.run_sql`、`commands/*` 全都走它），且已 `import { splitStatements }`。执行成功后：

```ts
if (statements.some((s) => { const k = classifyStatement(s).kind; return k === 'ddl' || k === 'destructive'; })) {
  if (txSession) txSession.schemaDirty = true;   // 事务里先记账
  else this.invalidate(connectionId, opts.actor ?? 'user');
}
```

- `classifyStatement` 已是 `@aidb/core` 导出（`packages/core/src/sql/classify.ts:128`），`classifySql(sql).statements` 也直接可用，实现时二选一。
- **事务内不立刻发**：DDL 尚未提交，别的会话此刻看不到。改为在 `commitTransaction` 里检查 `schemaDirty` 才 `invalidate`；`rollbackTransaction` 只清标记。这同时消除了评审指出的「事务内事件与外部可见性不符」。
- **删除冗余显式调用**：`executor.ts:426`（run_sql 尾部）与 `routes.ts:1931`（/ddl/execute）现在的 `manager.invalidate(...)` 必须删掉，否则与 `query()` 内的发射重复。

**cause 归因**（只影响 UI 文案，不影响是否刷新）：

- `query()` 内：`opts.actor`（`manager.ts:70` 已有该字段）。
- `manager.ts` 内 12 处：`opts.actor ?? 'user'`。
- `executor.ts` 其余 8 处：`'agent'`。
- `routes.ts` / `features/*`：`'user'`。

`createGateway`（`server.ts`）创建 bus → 注入 manager → 在 `wss.on('connection')` 后订阅，向所有 `readyState === 1` 的客户端广播。

**不做服务端合并**：合并窗口会让「改完立刻断言」的测试必须 sleep；合并放客户端（5.3），一处生效。

**已知取舍（写进实现注释）**：`/query` 里跑 `CREATE DATABASE` 这类不进 `describe` 的语句也会触发一次刷新，白刷一次但不出错。

### 5.3 客户端：桌面 + Web

新增 `apps/desktop/src/lib/schemaEvents.ts`：

- 原生 `WebSocket` 连 `${location.origin.replace(/^http/, 'ws')}/ws?token=${token}`；`token` 从 `api.ts` 导出 `authToken()` 复用 `resolveToken()`。
- **终态不重连**：`onclose` 的 `code === 4401` → 标记 `terminal`，停止重连（服务端明确拒绝，重试无意义）；**`authToken()` 为空 → 根本不发起连接**。每次重连尝试前重新取 token（配对/`#token=` 之后无需刷新页面）。
- **网络类失败重连**：指数退避 1s→2s→4s→…上限 30s；`dispose()` 后不再重连。
- **失败静默**：只记 debug 日志，不 `notify`。

store 新增 `applySchemaChange(connectionId)`，规则：

1. **回合计内延迟**：若 `get().live?.status === 'streaming'`（本客户端正在跑 Agent 回合），只置 `pendingSchemaChange[connectionId] = true` 并返回；回合收尾（`sendAgent` 的 `finally` / `done` 分支）调 `flushSchemaChanges()` 一次性刷新。**这条直接消灭反目标 #1**：一回合改 5 张表只 describe 一次。
2. **手动刷新回声抑制**：`loadSchema(refresh = true)` 成功时记 `lastRefreshAt[connectionId]`；事件到达时若 `Date.now() - lastRefreshAt < 1500`，跳过（用户刚手动刷过）。
3. **节流下限**：非回合场景按 connectionId 做 1s 节流（首沿立即、尾沿合并），不是 300ms 防抖——防抖挡不住「每 2 秒改一张表」。
4. **在飞去重 + 重放**：某连接已有 `loadSchema` 在飞时不并发，只置 pending；请求结束后若有 pending 再跑一次（保证事件不被丢弃）。
5. 调 `loadSchema(connectionId, true)`（强制 refresh，不依赖 TTL）。**不再有「无已加载库就提前返回」**：库列表本身也可能变（`CREATE DATABASE`），`loadSchema(id, true)` 的非文件型路径就是先 `api.databases()` 再刷已加载库，正是需要的。

`bootstrap` 成功后启动 WS；**每次 `onopen`** 对所有已知连接调一次 `applySchemaChange` —— 断线期间的事件由此补偿（重连是低频路径，一次全量刷新可接受）。

### 5.4 客户端：移动端

`apps/mobile/App.tsx` 的 `handleWsEvent` 增 `schema_changed` 分支：

- `event.connectionId !== activeConnectionId` → 忽略。
- 否则走与桌面端同构的「在飞去重 + pending 重放」，而不是初版的「在飞就丢弃」——**在飞请求可能早于 `invalidate` 发出，返回的是旧结构，丢弃事件等于永久丢这次变更**。
- **`ws.onopen` 补偿**：重连成功后对 `activeConnectionId` 触发一次刷新（移动端本来就在 `onclose` 后 2.5s 重连）。
- 回合内不单独延迟：移动端 `turn_end` 已刷新会话，事件刷新按 1s 节流即可。

### 5.5 设计器：作用域修复 + 冲突处理

**先修作用域 bug（前置条件）**：`DesignView.tsx:245` 现在是

```ts
const tableInfo = (schemas ?? []).flatMap((s) => s.tables).find((tbl) => tbl.name === tab.table);
```

跨**所有库/模式**取首个同名表，忽略 `tab.database`。在校验「签名是否变化」之后走「静默重置」路径时，同名兄弟表的结构变化会用**错误的结构**覆盖编辑态，`apply()` 还会对错对象生成 DDL。改为参照 `DataView.tsx:96-104` 的作用域查找（先按 `tab.database` 过滤，找不到再回退全库），差异是 DesignView 还要保留 `schema` 字段供 DDL 使用。

**再做冲突处理**：

- 初始化时把 `tableInfo` 的**结构签名**存进 `baselineRef`：表注释 + 列（名/类型/可空/默认值/注释/主键/自增）+ 索引（名/列/唯一/注释）+ 外键，固定字段顺序序列化（不要依赖 `Object.keys` 顺序）。
- `dirty` = 当前编辑态序列化 ≠ 基线。
- effect 重跑时（`tableInfo` 身份会因 `loadSchema` 替换数组而变化）：
  1. 签名未变 → 不做任何事。
  2. 签名变了且**不 dirty** → 静默以新结构重置编辑态、更新基线。
  3. 签名变了且 **dirty** → 只置 `pendingReload`，不动编辑态。
- `pendingReload` 为真时顶部横幅：「此表已在别处被修改」+ **重新加载** / **保留我的修改**。
  - 重新加载：以新结构重置，清标记。
  - 保留我的修改：清标记，并把基线更新为当前签名（同一变更不反复弹）；**再次**变更仍会提示。

已知取舍：选「保留我的修改」后继续基于旧结构编辑，`apply()` 生成的 DDL 可能与新结构冲突，由数据库报错兜底——好过静默丢弃用户输入。

新建表 tab（`tab.table` 为空）无冲突逻辑。

### 5.6 客户端刷新覆盖到哪一层（明确边界）

**会刷新**：对象树、`DesignView`、任何从 `store.schemas` 派生的视图（`RelationsView`、`DashboardView`、`DataView` 的 `tableInfo` memo —— 它本就是 `useMemo([schemas, ...])`，会自动重算）。

**不会刷新**：`DataView` 的列头数组来自 `page.batch.sets[0].columns`（`DataView.tsx:177`），即**上一次数据查询的结果**，不是 schema。窗口改列后它保持旧列，直到下一次翻页/刷新数据。这是可接受的：它描述的是「当前这屏数据」，不是结构。

### 5.7 保留已有的显式刷新

`DesignView.apply()`（`DesignView.tsx:486`）、`Sidebar` 表操作后（`Sidebar.tsx:235`）、`QueryView` 提交事务后（`QueryView.tsx:275`）等现有 `loadSchema(..., true)` **保留**：用户点了保存就该立刻看到结果，不能等节流窗口。重复的一次 describe 由 5.3 第 2 条「手动刷新回声抑制」吸收。

### 5.8 涉及文件

| 文件 | 改动 |
|---|---|
| `apps/gateway/src/events.ts` | 新增 `GatewayEvents` + 事件类型 |
| `apps/gateway/src/manager.ts` | 构造参数 `events?`；`invalidate` 加 `cause`；`QueryOptions` 无关；`query()` 集中判定并发射；tx 会话 `schemaDirty` 记账；`commitTransaction` 提交时发射；12 处内部调用透传 `opts.actor` |
| `apps/gateway/src/executor.ts` | 9 处：8 处传 `'agent'`；**删除 `run_sql` 尾部那处**（`query()` 已覆盖） |
| `apps/gateway/src/routes.ts` | **删除 `/ddl/execute` 的冗余 `invalidate`**；其余 `'user'` |
| `apps/gateway/src/features/*.ts` | 传 `'user'` |
| `apps/gateway/src/server.ts` | 建 bus、注入 manager、订阅并广播到 `wss.clients` |
| `apps/desktop/src/lib/schemaEvents.ts` | 新增：WS 客户端、重连、4401 终态 |
| `apps/desktop/src/lib/api.ts` | 导出 `authToken()` |
| `apps/desktop/src/store.ts` | `applySchemaChange` / `flushSchemaChanges` / 节流去重 / `lastRefreshAt`；bootstrap 后起 WS；`onopen` 补偿 |
| `apps/desktop/src/components/DesignView.tsx` | 作用域查找修复 + 基线签名 + `dirty` + `pendingReload` 横幅 |
| `apps/mobile/App.tsx` | `schema_changed` 分支（在飞去重+重放）、`onopen` 补偿 |
| `docs/05-data-and-api.md` | §4 补 `schema_changed` 与 `/ws` 下行事件 |
| `docs/02-feature-spec.md` | 对象浏览器/表设计器补「结构变更自动失效」 |

## 6. 我做主的决定（可被否，默认按此实现）

1. 通道走既有 `/ws` —— 你已确认。
2. **发射点收进 `manager.query()`**，而不是逐个路由补 `invalidate` —— 一并修掉 `/query`、`/tx/*`、`commands/*` 漏清缓存的既有缺陷。
3. 事务内 DDL 延后到 `commit` 才发事件。
4. 事件粒度到 connectionId，不带库名。
5. **回合内延迟到 `done` 一次刷新**（取代初版的 300ms 防抖）；非回合场景 1s 节流。
6. 保留所有已有显式刷新，用「手动刷新回声抑制」去重。
7. WS 4401 / 空 token 不重连。
8. `GatewayEvents` 放网关，不进 `@aidb/core`。
9. 设计器冲突默认动作是**不动编辑态**。

## 7. 留给实现者

- 结构签名的具体序列化（建议固定字段顺序的 `JSON.stringify`）。
- 重连退避与日志级别的具体取值。
- 横幅的样式类名与位置（复用 `.designer-*` 与 `ui.tsx` 按钮）。
- 网关测试里拿 WS 帧的写法：`apps/gateway/test/integration.test.ts:807` 已有可直接照抄的模式（`new WebSocket(.../ws?token=)` + `once('message')` + 超时）。

## 8. 验证方式

1. **网关单测** `apps/gateway/test/schema-events.test.ts`：
   - `POST /api/ddl/execute` 建表 → 收到 `schema_changed`，`cause === 'user'`。
   - **`POST /api/query` 执行 `CREATE TABLE`** → 收到事件（覆盖本轮修掉的漏清缓存缺陷）。
   - 直接调 `executor.execute()` 跑 DDL → `cause === 'agent'`。
   - 纯 `SELECT` 的 `run_sql` → **不发**事件。
   - 事务内 `CREATE TABLE` → 提交前**不发**，`/tx/commit` 后**发**；回滚后不发。
   - 同一请求只发**一次**（防 `query()` 与路由双发）。
   - 错误 token → 握手被拒，无帧。
   - 非 SQL 引擎路径（如 Redis `createKey`）→ 发事件。
2. **客户端**：`npx tsc --noEmit`（仓库无桌面单测框架）。
3. **手测（桌面/Web）**：Agent 加表注释 → 不刷新直接看表设计「注释」页；另一标签页执行 `ALTER` → 第一个标签页同步更新。
4. **手测（回合合并）**：让 Agent 连改 3 张表 → 网络面板确认整个回合只发一次 `GET schema?refresh=1`。
5. **手测（设计器冲突）**：改一列不保存 → 别处 `ALTER` 该表 → 出现横幅；「保留我的修改」后编辑态不变；再 `ALTER` 一次 → 再次提示。
6. **手测（同名表）**：MySQL 两个库各建 `orders`，只改 B 库的 → A 库的设计器 tab **不被改写**。
7. **手测（移动端）**：桌面执行 DDL → 移动端对象树自动出现新表；杀网关 30s 再起 → 移动端自动恢复并刷新。
8. **回归**：`npm test`、`npm run e2e`（现有 230 项不得回归）。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 一回合多次 DDL 造成事件风暴 | 回合内延迟到 `done` + 1s 节流 + 在飞去重 |
| 断线丢事件 | 每次 `onopen` 全量补偿一次 |
| 大库 describe 慢 | 只在事件到达时刷新；重连是低频路径 |
| 设计器旧结构上继续编辑 | 已知取舍，横幅已告知，DB 报错兜底 |
| `query()` 内新增 classify 带来开销 | 只对已执行的语句做一次正则分类，与 `executor.ts:426` 现有开销同量级 |
| 事务内 DDL 标记遗漏 | `schemaDirty` 在 `query()` 唯一入口置位，`commit` 唯一出口消费 |