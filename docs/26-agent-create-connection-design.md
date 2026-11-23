# 26 — Agent 建连与引擎探测设计（`probe_engine` / `create_connection`）

状态：M1（建连）与 M2（探测）已实现并验证；M3（新密码安全输入）待做
日期：2026-11-24

用户诉求：在 Agent 面板里说「192.168.1.7:3306 mysql root/123456」就把连接建出来；不告诉它是 mysql 时，先探出来再建。

## 1. 实现前现状

两条路都不通，且方向是反的。

**建连**：Agent 与连接相关的工具只有 4 个，全部 `risk: 'read'`（[toolGroups.ts:17](packages/core/src/agent/toolGroups.ts#L17)）。53 个工具中没有任何写连接的入口。唯一的建连路径是人驱动的：连接编辑器 → `api.createConnection`（[api.ts:508](apps/desktop/src/lib/api.ts#L508)）→ `POST /connections`（[routes/connections.ts:22](apps/gateway/src/routes/connections.ts#L22)）→ `store.createConnection()`（[store/connections.ts:136](apps/gateway/src/store/connections.ts#L136)）写 sqlite `connections` 表，密码经 `SecretBox` 加密落 `secret` 列。

**探测**：`engine` 是必填且必须落在 `Engine` 的 41 值枚举内，否则 `isEngine()` 直接 `INVALID_ENGINE`。全仓库无 `guessEngine`/`detectEngine`/`portToEngine` 之类符号，也无逐驱动试连循环。`engineDefaultPort()`（[engines.ts:959](packages/core/src/engines.ts#L959)）只做「选定引擎 → 补默认端口」，反向不成立：3306 被 mysql/mariadb/polardb/tdsql/greatsql/goldendb 六个引擎共用，5432 被 postgresql/opengauss/gaussdb/vastbase/ivorysql/timescale 共用。驱动侧 `createDriver` 落不到 case 就抛 `UNSUPPORTED_ENGINE`（[drivers/index.ts:279](apps/gateway/src/drivers/index.ts#L279)），无回退。

**已有的地基**（不必重写）：

- `manager.testConfig(conn, secret)`（[manager.ts:199](apps/gateway/src/manager.ts#L199)）能拿一份未落库的 draft 配置直接试连，返回 `{ ok, version, latencyMs, message }`，失败不抛错、`finally` 里关连接。这是探测的核心原语，现成可用。
- `POST /connections/test`（[routes/connections.ts:122](apps/gateway/src/routes/connections.ts#L122)）已经用同一套 draft 语义给连接编辑器做「测试连接」。
- 注册式工具框架：`defineTool()` + `executor/registry.ts` 双向对齐自检，加工具是加法而非改 switch。

## 2. 目标与非目标

### 目标

- A：Agent 能用 `host/port/username` 加既有凭据或一次性 `passwordRef` 建出一条连接，落库、侧边栏可见；全新密码由连接编辑器补。
- B：用户没说引擎时，Agent 能给出候选并试连确认，拿到引擎结论后再建。
- C：建完之后桌面侧边栏刷新列表并展开该连接，但**不切换**当前活动连接与编辑区。
- D：密码不进模型上下文、不进审批弹窗明文、不进审计与 `tool_runs` 明文。
- E：探测必须是有界并发 + 单次尝试，不能因为一个内网不可达端口把回合卡住。

### 非目标（明确不做）

- **不做被动指纹嗅探**。不裸连端口读 banner、不做 TLS 探测、不猜 payload。只按候选引擎走正式驱动认证，避免误触发目标库的 `host` 封禁（MySQL `max_connect_errors`、PG `pg_hba` 封禁）。
- **不做文件型引擎**。sqlite/duckdb 的 `database` 是本地文件路径（[drivers/index.ts:32](apps/gateway/src/drivers/index.ts#L32) 缺路径直接抛错），Agent 工具直接拒绝 `fileBased` 引擎，避免绕过文件工具目录边界读写本机数据库；这类引擎只能由用户在连接编辑器创建。
- **不做凭据字典/撞库**。一个候选最多一组凭据。
- **不做同协议变体的精确区分**。TiDB/OceanBase/TDSQL 走 mysql 协议、openGauss/GaussDB/Vastbase 走 postgres 协议；探测只能定到「协议 + 版本串」这一层。
- 不逐个启停工具（沿用现状：工具目录只读展示）；不改 `Engine`/`Transport` 枚举。

## 3. 工具设计

两个工具都进 `connection` 分组（[toolGroups.ts:17](packages/core/src/agent/toolGroups.ts#L17)）。工具总数 53 → 55，硬编码点的清单见 §8。

### 3.1 `probe_engine`（read）

```ts
{
  name: 'probe_engine',
  risk: 'read',
  inputSchema: {
    type: 'object', additionalProperties: false,
    required: ['host', 'port', 'username'],
    properties: {
      host: { type: 'string' },
      port: { type: 'integer' },
      username: { type: 'string' },
      database: { type: 'string', description: 'Optional target database; omit for engines that list databases at handshake' },
      ssl: { type: 'boolean' },
    },
  },
  summarize: (a) => `试探 ${a.host}:${a.port} 的数据库类型`,
}
```

风险定级用 `read` 是成立的，理由要在代码注释里写明：它不写 AiDB 的任何持久状态（不落库、不改设置），唯一副作用是对目标 host 发起最多 N 次认证握手——这与 `run_sql` 的一条 SELECT 同类，现有架构本来就不把「外呼外部系统」当作写。它的真正闸门不是审批，而是 §5 的 SSRF 边界与有界并发。

> 反面案例必须挡住：[routes/agent.ts:32-34](apps/gateway/src/routes/agent.ts#L32) 的注释记录过 `memory_write`/`backup_database` 被错标成 `read`，于是 MCP 只读桥被迫改用显式白名单兜底。`probe_engine` 之所以敢标 `read`，正是因为它确实不写持久状态；这条边界不能靠注释维持，由 §7 的单测锁住「probe 不产生任何 store 写入」。

**行为**：

1. 按 §4 的候选表取候选引擎（端口命中优先，否则 `PROBE_RANK`）。
2. 每个候选构造 draft `ConnectionConfig`（`id: 'probe'`、`readonly: false`，形状与 [routes/connections.ts:127](apps/gateway/src/routes/connections.ts#L127) 的 draft 一致），并发跑 `manager.testConfig(draft, { password })`，并发上限 4，单候选用 `Promise.race` 在 5 秒给出结果。超时候选直接退休、不再用该 worker 起新尝试；底层驱动继续按自身超时收尾，因此实际驱动并发不会超过 4，探测也不会被 HTTP 驱动的 30 秒超时拖住。若首轮 4 个候选全部超时，剩余候选不再尝试，返回 `unknown`。
3. 把结果分成三档：`ok` → `connected`（协议与认证都成立）；驱动报认证类错误 → `auth_failed`（协议已识别，凭据不对，版本串不可用）；其余 → `unknown`（连接拒绝、超时、协议不匹配等）。同档内再按 `PROBE_RANK` 排序。

**返回**：

```jsonc
{
  "ok": true,
  "summary": "192.168.1.7:3306 是 MySQL 8.0.36（另有 mariadb 候选可用）",
  "data": {
    "host": "192.168.1.7", "port": 3306,
    "outcome": "connected",
    "protocolMatches": [
      { "engine": "mysql", "label": "MySQL", "version": "MySQL 8.0.36", "latencyMs": 42 },
      { "engine": "mariadb", "label": "MariaDB", "version": "MySQL 8.0.36", "latencyMs": 55 }
    ],
    "recommendation": "mysql",
    "portHintEngines": ["mysql", "mariadb", "polardb", "tdsql", "greatsql", "goldendb"],
    "failures": [{ "engine": "redis", "category": "protocol_mismatch", "message": "ERR Protocol error" }]
  }
}
```

`ok` 表示探测动作本身执行完成，不代表连接成功；建连与否看 `outcome`。认证失败时返回形状相同，但 `protocolMatches` 只带 `engine`/`label`（不带伪版本），`outcome: 'auth_failed'`，`recommendation` 仍可给出协议候选。`create_connection` 只接受 `outcome === 'connected'` 的 `passwordRef`。

**认证失败也是识别信号。** 密码错误时 `driver.test()` 返回 `ok: false`，但服务端已经完成了对应协议的握手，错误码/消息足以证明协议类型。不能把它笼统归成「连不上」，要按错误类别归类：

| 驱动原始错误（示例） | 归类 | 结论 |
|---|---|---|
| MySQL `ER_ACCESS_DENIED_ERROR` / `Access denied for user` | `auth_failed` | MySQL 协议已识别，密码错误 |
| PostgreSQL `28P01` / `password authentication failed` | `auth_failed` | PostgreSQL 协议已识别，密码错误 |
| Redis `NOAUTH Authentication required` | `auth_failed` | Redis 协议已识别，需要密码 |
| MongoDB `Authentication failed` | `auth_failed` | MongoDB 协议已识别，密码错误 |
| SQL Server `Login failed for user` | `auth_failed` | TDS 协议已识别，密码错误 |
| Oracle `ORA-01017` | `auth_failed` | Oracle 协议已识别，密码错误 |
| Elasticsearch/OpenSearch `401` + `security_exception` | `auth_failed` | HTTP 搜索协议已识别，凭据错误 |
| `ECONNREFUSED` / `ETIMEDOUT` | `unreachable` | 端口未开放或网络不可达 |
| 协议解析错误、握手包不符合预期 | `protocol_mismatch` | 该候选不是目标协议，继续试下一个 |

归类器只认驱动错误码 + 明确的错误消息特征，不做模糊猜测；厂商语言差异导致的无法归类落入 `unknown`，不误报 `auth_failed`。`outcome` 的优先级是 `connected > auth_failed > unknown`：只要有候选认证成功，就以认证成功为准；没有成功但识别出协议时，明确告诉用户「协议识别成功，凭据需修正」，不得据此创建连接。

**同一个 `version` 串会横跨多个候选。** mysql 和 mariadb 的 `test()` 都拿 `SELECT VERSION()` 再拼 `engineMeta().label`（[drivers/mysql.ts:298](apps/gateway/src/drivers/mysql.ts#L298)），所以真实 MariaDB 会被 `mysql` 候选报成 `MySQL 8.0.36`，两个候选一起 `ok`。因此：

- `protocolMatches[]` 按 `PROBE_RANK` 顺序返回，把 `version` 串原样交给模型判断，工具自己不下「一定是 X」的结论；
- 真实 MariaDB 走 mysql 驱动是**功能可用**的（同协议），差异只在 label 与版本串里的 `MariaDB` 字样。summary 用「按 X 建立，版本串 Y」的措辞，不承诺识别成功；
- 出现 `ok` 且版本串里出现另一候选的特征词（`MariaDB`/`Percona`/`TiDB`/`PostgreSQL` 等）时，把该候选排到 `protocolMatches[]` 首位。

### 3.2 `create_connection`（write）

```ts
{
  name: 'create_connection',
  risk: 'write',
  inputSchema: {
    type: 'object', additionalProperties: false,
    required: ['name', 'engine', 'host', 'port', 'username'],
    properties: {
      name: { type: 'string' }, engine: { type: 'string' },
      host: { type: 'string' }, port: { type: 'integer' },
      username: { type: 'string' },
      database: { type: 'string' },
      groupName: { type: 'string' },
      environment: { type: 'string', enum: ['dev', 'staging', 'prod'] },
      color: { type: 'string', enum: ['blue','green','orange','red','purple','cyan','gray'] },
      ssl: { type: 'boolean' }, sslInsecure: { type: 'boolean' },
      readonly: { type: 'boolean' },
      note: { type: 'string' },
      passwordRef: { type: 'string', description: 'Ref returned by probe_engine. Never pass the password itself.' },
      useSavedCredential: { type: 'boolean', description: 'Reuse the password already stored on an existing connection with the same host:port:username' },
      skipProbe: { type: 'boolean', description: 'Persist without a connectivity test; only when the user insists' },
    },
  },
  summarize: (a) => `创建连接 ${a.name}（${a.engine} ${a.host}:${a.port}）`,
}
```

入参里**没有 `password` 字段**。`additionalProperties: false` 会让多传的参数在 schema 层就被拒；handler 再对 `password`/`sshPassword` 这类键做一次显式拒绝（忽略大小写并兼容下划线写法），返回 `PASSWORD_NOT_ACCEPTED` 并提示改用 `passwordRef`。理由见 §5.1。

**行为**：

1. `isEngine(engine)` 校验，非法即返回 `INVALID_ENGINE` 并附候选建议；`port` 缺省用 `engineDefaultPort()` 补。
2. 取密码：`passwordRef` 查 §5.1 的一次性缓存，命中即取；否则 `useSavedCredential` 时按 `host:port:username` 找既有连接的 `getConnectionSecret()`；都拿不到则**空密码继续**。
3. **无密码时不试连**：空密码试连大概率失败，失败即阻断会把「建一条待填密码的连接」变成不可能。所以无 `passwordRef` 时跳过试连、直接落库，summary 明说「已创建，密码未保存，请在连接编辑器里补」。
4. 有密码时先 `manager.testConfig()`（draft 带上 `ssl` 与 `sslInsecure`），并按 §3.1 的分类器判因。认证错误 → 转述「协议已识别但凭据被拒」；连接拒绝/超时 → 转述「地址或端口不可达」；协议不匹配 → 转述「用户指定的引擎与该端口不匹配」。所有失败默认**不落库**，把可行动的报错回给模型。带 `skipProbe: true` 才允许落一条连不上的连接（用户坚持「先存着」的场景）。
5. 落库前做同址判定：`host+port+username+database` 命中既有连接 → 返回 `CONNECTION_DUPLICATE` 并给出 `id`，让模型回答「这条已经存在（id=…）」而不是默默插一条重复的。同址创建在进程内串行化，避免异步试连期间两个请求同时通过检查。`store.createConnection` 现在没有任何重名校验（[store/connections.ts:136](apps/gateway/src/store/connections.ts#L136)），这道判定只加在工具路径，不改 store 语义。
6. `store.createConnection()` 落库 → `manager.invalidate(id, 'agent', false)`（清缓存但不伪造 schema 变更）→ 广播 `connections_changed`（§5.3）→ 由 executor 统一写审计（成功归到新连接，重复归到既有连接，其他失败不归到当前活动连接）。

**返回**带上新连接 id，供模型后续 `inspect_schema` 直接用：

```jsonc
{ "ok": true, "summary": "已创建连接 shop-prod（MySQL 192.168.1.7:3306），版本 MySQL 8.0.36，38ms",
  "data": { "connectionId": "…", "name": "shop-prod", "engine": "mysql", "tested": true, "version": "MySQL 8.0.36" } }
```

## 4. 候选引擎怎么定

新增纯函数 `probeCandidates(port?)`，放 [packages/core/src/engines.ts](packages/core/src/engines.ts)（与 `engineDefaultPort` 同处，纯数据、可单测）。

端口命中优先：`ENGINES.filter(e => e.defaultPort === port && !e.fileBased)`。3306 → 6 个候选，5432 → 6 个。命中不唯一时按 `PROBE_RANK` 排序。

端口没命中（用户填了非标端口）时按显式权重表探，不探全部 39 个有默认端口的引擎：

```ts
const PROBE_RANK: Engine[] = ['mysql', 'postgresql', 'mongodb', 'redis', 'sqlserver', 'clickhouse', 'oracle', 'elasticsearch', 'neo4j'];
```

排序理由：这 9 个覆盖日常绝大多数场景，且前 4 个是绝大多数非标端口部署的库。每轮最多 4 个、单候选 5 秒；快速失败时会继续消化队列，超时 worker 退休，因此整体等待上界约 15 秒，但不会为了穷举而突破并发上限。

> 端口表当前有 39 个引擎带 `defaultPort`（[engines.ts](packages/core/src/engines.ts) 全量），6379 是 redis 与 falkordb 共用、7687 是 neo4j 与 memgraph 共用、9030 是 doris 与 starrocks 共用——这些正是 `protocolMatches[]` 数组存在的意义，工具不替模型拍板。

## 5. 安全边界

### 5.1 密码不入模型上下文（硬约束）

`risk: 'read'` 直接 `allow`（[policy.ts:168](packages/core/src/agent/policy.ts#L168)），read 路径**不弹审批**，`tool_call` 事件带 `args` 原样下发（[runtime.ts:831](packages/core/src/agent/runtime.ts#L831)），`tool_runs.args_json` 原样落库（[store/agent.ts:260](apps/gateway/src/store/agent.ts#L260)），工具卡片还会 `JSON.stringify(args)` 渲染（[AgentPanel.tsx:775](apps/desktop/src/components/AgentPanel.tsx#L775)）。也就是说：**只要密码进过任何一个工具的 args，它就会出现在模型上下文、前端界面和审计库里。**

对策分三层：

1. **args 不带密码**。`probe_engine` 的密码由 handler 按 §5.2 的 `host:port:username` 从既有连接反查；查不到时模型只能走「请用户在连接编辑器里补」的路径。`create_connection` 用 `passwordRef`。
2. **一次性 ref 缓存**。`probe_engine` 反查到密码后生成 `ref = randomUUID()`，存进程内 `Map<ref, { password, host, port, username, expiresAt }>`，TTL 5 分钟、一次性（`create_connection` 取用后即删），只存内存、不落 sqlite。ref 与目标 `host:port:username` 绑定，不能拿去给另一台主机建连。这条通道唯一的存在理由是让「探到的既有凭据」能安全流到建连工具。
3. **审计、模型历史与结果脱敏**。敏感键匹配忽略大小写并兼容 `ssh_password` 这类分隔符写法。写 `tool_runs` / `addAudit` 之前递归拷贝 args，把 `password`/`sshPassword`/`sshPrivateKey`/`passphrase` 替换成 `'***'`；没有敏感键时保持原引用，避免破坏现有零拷贝断言。审批事件、工具卡片和下一轮 provider 历史中的 assistant `tool_calls` 也走同一脱敏函数，避免密码在审批被拒后仍被再次发给模型。handler 返回值的 `data` 里绝不放密码（`list_connections` 现在返回的是 `ConnectionConfig`，本身已不含明密码，[types.ts:93](packages/core/src/types.ts#L93) 只有 `hasPassword`，这个约定要继续守住）。

> 需要用户口述新密码的场景（全新库、本机没有同址凭据）留到 §10 的 M3：给 `create_connection` 加一条「密码走独立输入框」的交互，密码由前端直接 POST 网关、绕开工具 args。M1/M2 明确不做，也不假装支持。

### 5.2 内网与地址边界

工具默认允许 RFC1918/环回（这是桌面单机产品的主要用法），但守住两条：

- **拒链路本地元数据段**：`169.254.0.0/16`、IPv6 `fe80::/10`、未指定地址 `0.0.0.0`/`::`、阿里云元数据 `100.100.100.200`，以及 `metadata.google.internal` 之类主机名直接 `RESERVED_ADDRESS`。IPv6 先展开成 8 个 16 位组再判断，覆盖 `0:0:0:0:0:0:0:0` 与 `0:0:0:0:0:ffff:a9fe:a9fe`；IPv4-mapped IPv6 同样按 IPv4 判定。主机名先做 DNS 预解析，任一结果落入保留段就拒绝，并把校验后的 IP 固定给驱动，避免 DNS rebinding。需要严格校验证书的主机名 TLS 无法安全地表为 IP（会丢 SNI），Agent 工具要求改用 IP 或连接编辑器。
- 不做被动 banner 嗅探或额外端口扫描；每个候选只走正式驱动的一次认证握手。探测失败信息不回显目标 banner 原文之外的内容。

### 5.3 事件

`GatewayEvents`（[events.ts:18](apps/gateway/src/events.ts#L18)）目前只有一种事件 `schema_changed`，桌面 [schemaEvents.ts:94](apps/desktop/src/lib/schemaEvents.ts#L94) 硬过滤 `type !== 'schema_changed'` 就 return。所以「连接列表变了」必须新增事件类型，不能蹭 `schema_changed`（语义不同：后者是「某连接的结构脏了」，前者是「列表成员变了」）。新增：

```ts
export interface ConnectionsChangedEvent { type: 'connections_changed'; connectionId: string; change: 'created' | 'updated' | 'deleted'; at: string; }
```

`GatewayEvents` 加 `onConnectionsChanged`/`emitConnectionsChanged`，[server.ts:254](apps/gateway/src/server.ts#L254) 的 fan-out 与 [schemaEvents.ts:94](apps/desktop/src/lib/schemaEvents.ts#L94) 的过滤同步放宽。人工建连路径（`POST /connections`）也一并广播，这样多窗口/移动端口径一致。桌面刷新用单调代次丢弃迟到“列表快照”，但事件清理始终执行；`created` 标记为事件展开，不触发 schema 懒加载或默认库展开，`updated` 清掉旧 schema/库展开状态，`deleted` 连同 tab、loading、loadedDatabases 一起清理。人工保存参与同一代次，人工删除复用统一清理；WS 重连先全量对账连接列表，再刷新仍在线的 schema。

## 6. 权限与审批

`create_connection` 定 `risk: 'write'`，不能定 `read`——`read` 会被 [routes/agent.ts:35](apps/gateway/src/routes/agent.ts#L35) 的 `MCP_READONLY_TOOLS` 逻辑与 `evaluatePermission` 第一行无条件放行，等于 Agent 可以静默往本机塞连接。**不要**把它加进 `MCP_READONLY_TOOLS`。

各档位行为（对照 [policy.ts:167](packages/core/src/agent/policy.ts#L167)）：

| 场景 | 结果 | 说明 |
|---|---|---|
| 会话模式 `readonly` | deny | `evaluatePermission` 第 2 个分支 |
| 目标连接是只读 | 不适用 | 建连时还没有 `connectionId`，`connectionReadonly` 为 false |
| `ask`（新会话默认，[store/agent.ts:131](apps/gateway/src/store/agent.ts#L131)） | ask | 弹窗确认 |
| `auto` / `full` | allow | 写风险自动放行，符合现有档位语义 |
| 机器人回合 | deny | bots 固定 `mode: 'readonly'`（[bots.ts:115](apps/gateway/src/bots.ts#L115)），天然挡住 |
| 命令 `/report` `/fix` | 拿不到 | `allowedTools` 是显式白名单（[commands/registry.ts:43](packages/core/src/commands/registry.ts#L43)），不加 |
| 出站 MCP 桥 | 403 | 不进 `MCP_READONLY_TOOLS`；且 `resolveRisk !== 'read'` 已被拦 |

普通 Agent 回合不需要改 `visibleAgentTools()`（[agentHost.ts:330](apps/gateway/src/agentHost.ts#L330)）——它只按 `skill_`/`mcp_` 前缀过滤，新工具自动可见。`SQL_ONLY_TOOLS`（[executor.ts:72](apps/gateway/src/executor.ts#L72)）不加：这两个工具不作用于已选连接。`create_connection` 加入 `DB_TOOLS` 只是为了复用统一审计，审计的 `connectionId` 成功时取新连接 id、重复时取既有 id、其他失败不归到当前活动连接；它仍然不会触发 `requireConnection`。

`create_connection` 的「始终允许」签名覆盖 `host/port/engine/username/database`、凭据来源（ref/saved/none）、是否跳过测试、环境、读写标记以及 `ssl`/`sslInsecure`，但绝不包含密码或 ref 值，避免批准一个低权限连接后静默放行另一组更高权限参数。

### 6.1 连接只读判定的边界

`evaluatePermission` 的 `connectionReadonly` 来自会话当前连接（[agentHost.ts:722](apps/gateway/src/agentHost.ts#L722)）。建连时还没有目标 `connectionId`，该值通常为 false，因此不能用它保护「新建连接」；真正的闸门是工具的 `risk: 'write'`、会话 `readonly` 模式和审批档位。`probe_engine` 定 `read`，只读模式允许，但受 §5 的地址边界、候选上限与超时约束。

另外 `evaluatePermission` 第 2 行 `if (ctx.connectionReadonly) return 'deny'` 对**没有 connectionId 的工具**（`create_connection`、`memory_write`、`manage_pipeline`、备份）是恒 false 的假保护。新工具不依赖它兜底；是否在 handler 里对全局只读模式再加一道判断，取决于设置里是否有独立于连接的只读开关——实现时确认 [store/settings.ts:233](apps/gateway/src/store/settings.ts#L233) 的 `AppSettings` 字段后再定，有就接，没有就不假装有。

## 7. 桌面端表现（对齐已确认的偏好）

需求是「刷新 + 展开，不切换」。现有 `saveConnection`（[store.ts:899](apps/desktop/src/store.ts#L899)）会 `activeConnectionId: result.connection.id` 切过去，还会 `loadSchema()` 自动展开默认库——**Agent 路径不能复用这段**，否则违背「不自动打开默认库」的既有偏好。

新增一个动作 `syncConnectionsFromEvent(event?)`：`api.connections()` 拉列表 → 展开新连接并标记为事件展开 → `saveUiPrefs({ expandedConnections })`。**不动** `activeConnectionId`、`agentDatabase`，也不自动展开默认库；事件展开的连接不触发 Sidebar 懒加载，用户点击连接或收起再展开后才加载 schema。省略 event 的重连对账会清理断线期间已删除的连接，再刷新剩余 schema。

工具卡片：`describeCall()`（[policy.ts:94](packages/core/src/agent/policy.ts#L94)）现在落到 `default` 分支只会显示 `create_connection`，用户在审批弹窗里看不出要往哪台主机写。两个工具都加 `case`，返回带 `host:port/engine/name` 的 summary；审批弹窗的 `JSON.stringify(approval.args)`（[AgentPanel.tsx:2417](apps/desktop/src/components/AgentPanel.tsx#L2417)）仍走统一脱敏，避免模型绕过 schema 传入大小写变体的密码键。

`summarize()` 返回中文串，会被 `scripts/i18n/extract.mjs` 收进目录，需要跑 `npm run i18n:extract` + `i18n:translate` 落 19 个 locale 文件。

## 8. 落地清单（按依赖序）

**M1 建连**（不含探测）

1. `packages/core/src/agent/tools.ts`：加 `create_connection` 声明。
2. `packages/core/src/agent/toolGroups.ts:17`：`connection` 组加工具名（[tool-catalog.test.ts:9](packages/core/test/tool-catalog.test.ts#L9) 会校验每个工具都归组）。
3. `apps/gateway/src/executor/schema.ts`：`defineTool('create_connection', …)`。
4. `apps/gateway/src/executor/registry.ts`：import + push 进 `entries`（[registry.ts:76-83](apps/gateway/src/executor/registry.ts#L76) 的启动自检要求声明与注册双向对齐，漏一处启动即失败）。
5. `packages/core/src/agent/policy.ts`：`describeCall` 加 case。
6. `apps/gateway/src/events.ts` + `server.ts` + `apps/desktop/src/lib/schemaEvents.ts` + `store.ts`：`connections_changed` 链路与 `syncConnectionsFromEvent`。
7. `packages/core/src/agent/prompt.ts`：加一行工具用法指引——「没有匹配的连接时先用 `list_connections`，仍缺则用 `create_connection`；不得索要或复述密码」。
8. 契约同步：`scripts/verify-docs.mjs:60` 的 `expectedTools`、`:62` 的数量断言、`docs/04-ai-agent-design.md` 工具表新增行（列序 `# | 工具 | 风险 | 作用 | 关键参数`）。

**M2 探测**：`probe_engine` 声明+实现、`probeCandidates()`/`PROBE_RANK` 进 engines.ts、一次性 ref 缓存、§5 地址边界。

**文档计数同步（M1 就要改）**：硬编码 53 的位置不止文档——`scripts/verify-docs.mjs:62`、`scripts/e2e.mjs:270,1946`、`scripts/qa/functional.mjs:85,375`、`docs/00:26`、`docs/02:316`、`docs/04:208,210`、`docs/06:43`、`docs/08:10`、`docs/11:90,121`、`docs/12:217(×2),252`、`docs/13:215`、`docs/15:10,62`、`docs/16:31,491,528,592,790`、`docs/21:32,283`、`README.md`/`README.zh-CN.md:42,51,92,100,195,212,588`，以及 17 个语言版 README。`McpTool.tsx:305`、`SettingsScreen.tsx:86` 从 `catalog.length` 推导，无需改。能力契约（`packages/core/src/capabilities/*.json`）按模块而非按工具，**不需要**新增契约文件；`ToolsHub.tsx` 的 `TOOL_LIST` 与契约文件名数量必须保持一致，不要动。

## 9. 验收与实现结果

- 单测（新增断言随全量套件通过）：`probeCandidates(3306)` 返回 6 个 mysql 家族、`probeCandidates(1)` 返回 `PROBE_RANK`；文件型引擎永不出现在候选里；认证失败分类器把 MySQL `ER_ACCESS_DENIED_ERROR` / PG `28P01` / Redis `NOAUTH` 归为 `auth_failed`，ClickHouse 超时归为 `unreachable`；版本串 `MariaDB`/`OpenSearch` 能把推荐项排到首位；`passwordRef` 一次性且绑定端点；`create_connection` 传 `password` 或 `Password` 报 `PASSWORD_NOT_ACCEPTED`；同址重复返回 `CONNECTION_DUPLICATE`，并发同址创建只落一条；认证失败不落库；无凭据时落未测试连接并提示补密码；元数据/链路本地地址、展开 IPv6 与 IPv4-mapped IPv6 被拒绝；探测真实驱动并发不超过 4；`probe_engine` 跑完 `store` 零写入；工具 args 递归脱敏且无敏感键时保持原引用，密码不会随 assistant `tool_calls` 再次进入模型历史。
- 真实 MySQL（隔离副本，不触碰用户主库）：`probe_engine` 对现有 `local3306` 返回 `outcome: 'connected'`、`recommendation: 'mysql'`、`version: 'MySQL 8.4.13'`；`create_connection` 用返回的 ref 建连，`tested: true`，`secret` 列可解密回原密码，`connections_changed` 事件为 `created`。
- 界面（隔离网关 + 真实 Chrome）：另一页面通过 API 建连后，侧边栏出现 `Agent Event Probe`，新行 `.conn-toggle.open` 为 true，当前标题仍是 `Demo · Shop DB`，新行未获得 `.active`，没有自动加载默认库；单测另覆盖旧事件响应晚到时不能覆盖新列表。
- 回归：`npm run typecheck`、`npm run test`、`npm run build`、`node scripts/verify-docs.mjs`（400/400）、`npm run verify:i18n` 全部通过。

## 10. 未决与后续

- **M3 用户口述新密码**。当前设计下全新库必须由用户在连接编辑器补密码。彻底解法是审批弹窗里带一个受控密码输入框：密码由渲染进程直接 POST 网关、写入 ref 缓存，绕开模型 args 与 `tool_runs`。这条要单独设计（输入法/剪贴板/日志边界），不进 M1/M2。
- **连接参数缺项**。SSH 隧道、`options`（MongoDB `replicaSet`/`authSource`、Redis cluster）不放进 M1 入参；需要时让用户在编辑器里补，避免工具入参膨胀成连接编辑器的镜像。
- **引擎家族归一**。是否把 mysql 协议族（tidb/oceanbase/tdsql/…）在探测结果里合并展示，等真实用户反馈再定；现阶段把版本串交给模型，不做二次归一。
- **`probe_engine` 是否也走审批**。定 `read` 就不弹。若实际使用中出现「Agent 自己扫内网」的观感问题，最小改动是把它降成 `write` 并在 `MCP_READONLY_TOOLS` 明确排除——一行代码，不需要返工设计。
