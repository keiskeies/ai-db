# AiDB Studio — 命令作用域与工具分区设计

> 版本：v1.0 · 日期：2026-11-01 · 状态：**设计待评审（未实施）**
> 关联：[命令化 Agent 工作流](./11-command-workflows.md) · [AI Agent 设计](./04-ai-agent-design.md) · [Agent 准确率计划](./08-agent-accuracy-plan.md) · [数据模型与接口协议](./05-data-and-api.md)
>
> 本文是实施依据，不代表功能已完成。文中的类型、接口、行为均为待落地设计；实现时必须同步本文与 `scripts/verify-docs.mjs`。

## 0. 摘要

AiDB 的 Agent 目前每一回合都向模型下发**全部 53 个工具**，无论用户打的是 `/report` 还是随便问一句。命令（`/report`、`/compare`、`/diff`、`/recon`、`/fix`、`/init`）只是"提示词开关"，不改变模型能看见的工具集合。

本文定义 **命令作用域（command scope）**：把命令从"提示词"升级为"工具作用域 + 提示词 + 风险上限"的三元组，并规定它在各种输入形态下的确定性解析规则。

**本文只做作用域接线，不新增任何工具，不改调度器。** 后续阶段（语义路由、`/job` 定时任务）依赖本阶段提供的底座，见 §10。

### 0.1 一句话目标

> 打 `/report` 的回合里，模型手里**不应该**有 `drop_object`；而这个判断**不依赖模型**，只依赖一张查表。

### 0.2 非目标

- 不做自然语言意图分类（属阶段二，§10.1）。
- 不新增工具、不改 `TOOLS` 数组、不改工具数量契约（保持 52）。
- 不改调度器、不改 jobs / artifacts / dashboards。
- 不改权限模式语义（`readonly` / `ask` / `auto` / `full` 保持原样，作用域是叠加在它之上的一层）。
- 不做工具懒加载 / 按需发现（v1 用静态子集；动态发现见 §9.3）。

## 1. 现状与证据

这套机制**已经写了一半，但从未接上线**。

| 位置 | 内容 | 谁在读 |
|---|---|---|
| `packages/core/src/commands/types.ts:62-65` | 声明 `allowedTools?: string[]` / `extraTools?: string[]` | 仅 `validate.ts:37` 做形状校验 |
| `packages/core/src/commands/registry.ts:46` | `/report` → `allowedTools: READ_ONLY_REPORT_TOOLS` | **无消费方** |
| `packages/core/src/commands/registry.ts:80` | `/compare` → `allowedTools: READ_ONLY_REPORT_TOOLS` | **无消费方** |
| `packages/core/src/commands/registry.ts:151` | `/fix` → `allowedTools: FIX_TOOLS` + `extraTools: ['submit_fix_plan']` | **无消费方** |
| `packages/core/src/commands/registry.ts:44,78,102,119,149,179` | 6 处 `maxRisk` | **无消费方** |
| `packages/core/src/agent/runtime.ts:269` | `tools: deps.tools ?? providerTools()` —— 注入点早就留好了 | — |
| `apps/gateway/src/agentHost.ts:356` | `const allowedTools = visibleAgentTools(settings, allowMcp)` | **永远返回全量 52** |
| `apps/gateway/src/agentHost.ts:392` | `getTool` 白名单同样用全量 | — |

`grep -rn "allowedTools\|extraTools" apps/ packages/` 在 `apps/gateway/src` 与 `apps/desktop/src` 下**零命中**；`maxRisk` 同样零命中。结论：`/report` 名义上是"只读报告"，实际模型手里有 `drop_object`、`restore_backup`（未实现）、`transfer_data`。

### 1.1 命令定义散落成四份

| 位置 | 内容 | 消费方 |
|---|---|---|
| `packages/core/src/commands/registry.ts:34-182` | 6 条命令完整定义（含 `allowedTools` / `maxRisk` / `slots` / `prompt`） | `GET /commands`（`apps/gateway/src/routes.ts:2527`）→ 桌面端 `CommandPalette.tsx:49`、`AgentPanel.tsx:890`、移动端 `apps/mobile/App.tsx:697` |
| `apps/gateway/src/commandIntents.ts:15-112` | 5 条命令的 `instruction` 提示词（与 registry 的 `prompt` 字段重复且不一致） | `agentHost.ts:381` |
| `apps/gateway/src/agentHost.ts:233` | `/init` 的独立正则 `/^\/init(?:\s+([\s\S]+))?$/i` | 单独分支 → `runInit()` |
| `apps/desktop/src/components/AgentPanel.tsx:74-110` | 10 条 `SLASH` 宏（`/init` `/schema` `/audit` `/quality` `/chart` `/explain` `/optimize` `/backup` `/memory` `/clear`），只往输入框塞 prompt | 前端自己 |

后果：`/init` 与那 10 条 SLASH 宏**不在注册表里**，拿不到作用域，永远走全量 52 工具。`commandIntents.ts:126` 的正则硬编码 `/report|compare|diff|recon|fix`，与 registry 的 `COMMAND_IDS` 是两套真相。

### 1.2 还有第四份工具清单副本

`apps/gateway/src/commands/reportAgent.ts:22` 的 `REPORT_TOOLS`（11 项）与 `packages/core/src/commands/registry.ts:3` 的 `READ_ONLY_REPORT_TOOLS`（11 项）**逐项完全相同**。同一份清单存在两处，改一处忘另一处就会让"命令作用域"与"报告生成作用域"分叉。

### 1.3 现成的分组表被当成说明书

`packages/core/src/agent/toolGroups.ts:16-50` 已把 53 个工具分成 12 组（connection 4 / sql 7 / dialect 7 / document 6 / structure 7 / analysis 5 / compare 3 / pipeline 1 / ops 1 / plan 3 / skill 6 / mcp 3），但只被"设置 → MCP 与工具"的只读目录页消费（`agentToolCatalog()`）。它是一张现成的路由表。

## 2. 概念模型

三层职责严格分离，**只有第 2 层允许用模型**：

| 层 | 输入 | 判定方式 | 用模型 | 本阶段 |
|---|---|---|---|---|
| **L1 作用域解析** | 已识别的命令 id | 查表 `COMMANDS` | 否 | ✅ 本文 |
| **L2 意图路由** | 用户原话（无斜杠） | 关键词/规则 → 命令 id | 是（弱判断，可回退） | ❌ 阶段二 |
| **L3 任务执行** | 已确定的任务 | `nextRunAt()` 等纯函数 + 调度器 | 否 | ❌ 阶段三 |

**为什么必须 L1 先做：** 没有 L1，L2 判对了也没用——判出"这是建任务"，但 job 工具不在任何作用域里，模型照样调不到。反过来 L1 先落地，即使 L2 判错（把建任务的话路由到 `/ask`），退路是 `/ask` 全量作用域，任务仍能完成，只是上下文更贵。**L1 是安全网，L2 是优化项。**

### 2.1 三个正交的闸门

一回合内模型能看到的工具 = `作用域 ∩ 功能开关 ∩ 权限模式`，三者顺序固定：

```
① 作用域（scope）        command.allowedTools 声明 → 静态子集
② 功能开关（features）    settings.features.skills / mcp + allowMcp
③ 权限（policy）          resolveRisk + evaluatePermission（运行时，逐调用）
```

- ①② 决定**工具是否出现在 `tools` 数组里**（模型看不见 = 不会调用）。
- ③ 决定**看见的工具能否执行**（`readonly` 拒绝、`ask` 审批）。
- ②③ 是既有行为，本文不改；本文只插入 ①。

## 3. 需求设计

### 3.1 命令定义单一来源（SSOT）

`packages/core/src/commands/registry.ts` 成为**唯一真相**。`CommandDefinition` 扩展字段：

```ts
export interface CommandDefinition {
  // ……既有字段保持
  id: CommandId;
  aliases: string[];

  /** 本命令可见的工具白名单。undefined = 全量（兼容期），M3 后不允许 undefined。 */
  allowedTools?: string[];
  /** 命令私有工具（不进 52 工具目录），如 compose_report。 */
  extraTools?: string[];

  /** 允许出现的最高"声明风险"；对 dynamic 工具放行但运行时再判。 */
  maxRisk: Risk;

  /**
   * 执行方式。新增 'inline'：由 AgentHost 内联确定性处理，不走 CommandRunner、不产出 artifact。
   * 现有三种语义见 §3.1.1。
   */
  execution: 'deterministic' | 'agent' | 'hybrid' | 'inline';

  /** 提示词（合并原 commandIntents 的 instruction）。 */
  instruction: string;
  /** 裸命令的默认任务。 */
  defaultTask: string;
  /** 回合超时。 */
  timeoutMs: number;

  /** 本命令归属的工具组（用于 /tool <group> 展开与 UI 徽标）。 */
  scopeGroups?: string[];
}
```

### 3.1.1 `execution` 的四种取值（`/init` 必须新增 `inline`）

现有 `CommandExecution = 'deterministic' | 'agent' | 'hybrid'`（`types.ts:4`），但 `/init` 是第四种形态：**由 `AgentHost` 内联确定性处理**（`agentHost.ts:233` → `runInit()`），既不产出 artifact（`commands/runner.ts:74` 对无 artifact 的命令直接抛 `该命令不产出产物`），也不该走模型。

因此 `execution` 增加 `'inline'`：

| execution | 谁执行 | 产出 artifact | 例子 |
|---|---|---|---|
| `deterministic` | `CommandRunner` | 是 | `/diff` `/recon` |
| `hybrid` | `CommandRunner` + 模型步骤 | 是 | `/report` `/compare` `/fix` |
| `agent` | `AgentHost` 模型回合 | 否 | `/ask` |
| **`inline`** | **`AgentHost` 内联确定性** | 否 | **`/init`** |

`AgentHost` 的分发顺序：先查 `execution === 'inline'` 的命令，命中则调该命令注册的处理函数（`/init` → `runInit`），否则进模型回合。这样 `/init` 的路径与其它命令统一由注册表驱动，`agentHost.ts:233` 的硬编码正则删除。

`commands/runner.ts:74` 的 `if (!command.artifact) throw` 保持不变——`inline` 命令不会被 `CommandRunner` 接收。

### 3.1.2 迁移清单

| 原位置 | 迁移到 | 处理 |
|---|---|---|
| `commandIntents.ts:15-112` 的 5 个 `instruction` | `registry.ts` 各命令的 `instruction` | 内容原样搬，删除 `commandIntents.ts` 里的重复定义 |
| `commandIntents.ts:126` 的正则 | 删除 | 改为从注册表动态生成（见下） |
| `agentHost.ts:233` 的 `/init` 正则 | `registry.ts` 新增 `init` 命令 | `id: 'init'`，`execution: 'inline'`，`allowedTools: ['inspect_schema', 'search_objects', 'run_sql', 'sample_rows']`（**不写 `update_plan`**，基线自动并入，见 §3.3），走 `runInit()` 确定性分支 |
| `AgentPanel.tsx:74-110` 的 10 条 SLASH | `registry.ts` 新增命令 | 见 §3.5 逐条映射 |
| `reportAgent.ts:22` 的 `REPORT_TOOLS` | 引用 `registry.ts` 的 `READ_ONLY_REPORT_TOOLS` | 删副本，改为 `import` |

正则改为从注册表生成：

```ts
// 单一真相：命令清单变了，正则自动跟着变
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokens = COMMANDS.flatMap((c) => [c.id, ...c.aliases.map((a) => a.replace(/^\//, ''))]);
const COMMAND_RE = new RegExp(`^\\/(${tokens.map(escapeRe).join('|')})(?:\\s+([\\s\\S]+))?$`, 'i');
```

> **注意别名的形态**：`registry.ts` 里的别名值自带前导斜杠（`'/报表'`、`'/schema-diff'`），而 `id` 不带。拼正则时必须统一去掉前导 `/`（上面已做）。
>
> `escapeRe` 必须做——别名里可能出现 `-`（`schema-diff`）等正则元字符。
>
> **注意**：正则捕获到的是**用户输入的那个 token**（可能是别名 `报表`），必须再经 `getCommand(token)`（`registry.ts:188`，内部做 `normalizedAlias`）映射回 `id`。实测结果：
>
> | 输入 | 捕获 token | `getCommand()` → id | argument |
> |---|---|---|---|
> | `/报表 本周` | `报表` | `report` | `本周` |
> | `/schema-diff` | `schema-diff` | `diff` | ∅ |
> | `/结构对比 a` | `结构对比` | `diff` | `a` |
> | `/foo` | — | `null`（不匹配） | — |


**`CommandId` 联合类型**（`types.ts:3`）同步扩展：`'report' | 'compare' | 'diff' | 'recon' | 'fix' | 'ask' | 'init' | 'schema' | 'audit' | 'quality' | 'chart' | 'explain' | 'optimize' | 'backup'`。

> 注：`/memory` 与 `/clear` 是**纯前端动作**（打开记忆抽屉、新建会话），不产生 Agent 回合，**不进入注册表**，继续留在 `AgentPanel.tsx` 的本地处理（`runSlash`）。

### 3.2 作用域解析：纯函数

新增于 `packages/core/src/commands/scope.ts`：

```ts
/** 风险序：不要另建一份，直接复用 classify.ts 里已有的排序。 */
export { RISK_RANK as riskRank } from '../sql/classify';   // 需先在 classify.ts:19 加 export

/** 无论什么命令都必须可见的基础设施工具。理由见 §3.3。 */
export const SCOPE_BASELINE = ['update_plan'] as const;

export interface ResolveScopeInput {
  /** 命令定义；undefined 表示无命令（自由提问）。 */
  command?: CommandDefinition;
  /** 功能开关。 */
  features: { skills: boolean; mcp: boolean };
  /** 本回合是否允许 MCP（远端/机器人回合为 false）。 */
  allowMcp: boolean;
  /** 工具定义表，注入以便单测。 */
  tools: Pick<ToolDefinition, 'name' | 'risk'>[];
}

export interface ResolvedScope {
  /** 允许下发的工具名集合。 */
  names: string[];
  /** 允许出现的最高声明风险；undefined = 不限。 */
  maxRisk?: Risk;
  /** 实际生效的组（用于 UI 徽标与审计）。 */
  groups: string[];
  /** 因作用域被裁掉的工具名（用于日志与「为什么没有 X」的解释）。 */
  dropped: string[];
}

export function resolveToolScope(input: ResolveScopeInput): ResolvedScope;
```

算法（严格按序，**纯函数、无 IO、无 Date.now**）：

```
1. 基线：candidates = command?.allowedTools ?? null（null = 全量）
2. 若 candidates 非 null：追加 SCOPE_BASELINE 与 command.extraTools
3. 若 command?.scopeGroups 存在：把该组的 tools 并入 candidates
4. 功能开关过滤（与 agentHost.ts:129-135 现有逻辑一致）：
     - features.skills === false  → 剔除 skill_* 与 skill_worker_run
     - features.mcp === false 或 allowMcp === false → 剔除 mcp_*
5. 声明风险过滤：
     - candidates 非 null 时，保留 risk ≤ command.maxRisk 的工具
     - risk === 'dynamic' 的工具**一律保留**（运行时再判，见 §3.4）
6. 输出 names（按 TOOLS 原序，保证 prompt 稳定）+ dropped（被裁掉的名字）
```

**顺序不可交换**：必须先做功能开关再做风险过滤，否则 `features.skills=false` 时 `skill_run`（risk=write）会在 `/fix`（maxRisk=destructive）下被"保留"再被开关剔除，`dropped` 列表会记错原因。

### 3.3 基础设施工具白名单

**问题：** `runtime.ts:323` 先 `getTool(call.name)` 查表，查不到就在 `:325` 返回 `UNKNOWN_TOOL`；到 `:335` 才特判 `update_plan`。所以任何子集**漏掉 `update_plan` 就会让模型的计划功能静默降级成报错**——而计划是 Agent UX 的支柱（`04-ai-agent-design.md` 的 TodoWrite 契约）。

**规则：**

| 工具 | 是否基线 | 理由 |
|---|---|---|
| `update_plan` | **是，强制** | 运行时特判依赖它存在；缺了会 UNKNOWN_TOOL |
| `memory_search` | 否，命令显式声明 | 只读，但会占 prompt；只有分析类命令需要 |
| `list_connections` | 否，命令显式声明 | 多源命令（`/diff` `/recon`）需要，单源命令不需要 |
| `memory_write` | 否 | 见 §9.4（风险声明有误，另案处理） |

`SCOPE_BASELINE` 由 `resolveToolScope` 自动并入，**命令定义里不需要也不允许重复声明**；`assertCommandDefinitions()` 增加校验：命令的 `allowedTools` 若包含 `update_plan` 不报错但会被去重，若**不包含 `update_plan` 也不报错**（基线兜底），但**必须**包含它需要的业务工具。

### 3.4 `maxRisk` 语义（最容易实现走偏的一处）

`maxRisk` 声明了 6 处却从未被读，启用时必须先钉死语义：

> **`maxRisk` 是"本命令下允许出现的最高『声明风险』"，不是"运行时允许的最高风险"。**

两条推论：

1. **对 `dynamic` 工具放行。** `run_sql`、`run_mql`、`run_redis`、`run_cypher`、`run_cql`、`run_aql`、`alter_table`、`mcp_call` 共 8 个工具声明为 `dynamic`，它们的真实风险由 `resolveRisk`（`packages/core/src/agent/policy.ts:18-44`）在调用时按参数分类。若按"声明风险 > maxRisk 就剔除"处理，`/report`（maxRisk=read）会连 `run_sql` 都拿不到，命令直接废掉。**所以 dynamic 一律保留。**

2. **但要在运行时补一道越界拒绝。** 光保留 dynamic 会让 `/report` 下模型执行 `UPDATE`——这违背"只读报告"的意图。因此在 `evaluatePermission` 之后增加一层：

```ts
// 伪代码，落在 runtime.ts 的 verdict 计算之后
if (scope.maxRisk && riskRank(resolvedRisk) > riskRank(scope.maxRisk)) {
  return toolFailed(
    `本命令（/${command.id}）不允许 ${resolvedRisk} 级操作，只允许到 ${scope.maxRisk}。` +
    `如需执行请改用 /fix 或直接提问。`,
    'OUT_OF_SCOPE',
  );
}
```

| 命令 | maxRisk | `run_sql` 分类为 read | 分类为 write | 分类为 ddl |
|---|---|---|---|---|
| `/report` | read | 执行 | **OUT_OF_SCOPE 拒绝** | **拒绝** |
| `/compare` | read | 执行 | **拒绝** | **拒绝** |
| `/diff` | read | 执行 | **拒绝** | **拒绝** |
| `/recon` | read | 执行 | **拒绝** | **拒绝** |
| `/fix` | destructive | 执行 | 审批后执行 | 审批后执行 |
| `/ask` | destructive | 执行 | 审批后执行 | 审批后执行 |

**注意**：`OUT_OF_SCOPE` 是**拒绝**，不是"转审批"。理由：如果允许转审批，用户在 `/report` 里批准一次 `DELETE`，就等于把只读命令变成了写命令，作用域失去意义。用户想写就该换命令——错误信息必须明说换成哪个命令。

**与 `readonly` 模式的关系**：`readonly` 是更强的约束，`evaluatePermission`（`policy.ts:152`）会先 deny；`OUT_OF_SCOPE` 只是在其之上再收一层。二者不冲突，错误码不同（`READONLY` vs `OUT_OF_SCOPE`），便于用户区分"连接只读"和"命令不允许"。

### 3.5 命令作用域定义表

迁移后每个命令的完整作用域。**`update_plan` 不出现在表中**（基线自动并入）。

| 命令 | maxRisk | allowedTools | 说明 |
|---|---|---|---|
| `/report` | read | `inspect_schema` `search_objects` `run_sql` `explain_sql` `sample_rows` `profile_column` `analyze_chart` `forecast_chart` `render_chart` `memory_search` | 沿用 `registry.ts:3` 现有清单，**不再重复定义**（`reportAgent.ts:22` 改为 import） |
| `/compare` | read | 同上 | 现有 `registry.ts:80` |
| `/diff` | read | `list_connections` `inspect_schema` `search_objects` `run_sql` `schema_diff` `memory_search` | **新增**（当前 undefined = 全量，是个洞） |
| `/recon` | read | `list_connections` `inspect_schema` `search_objects` `run_sql` `recon_data` `run_redis` `memory_search` | **新增** |
| `/fix` | destructive | `inspect_schema` `search_objects` `run_sql` `explain_sql` `sample_rows` `profile_column` `audit_database` `check_data_quality` `backup_database` `begin_transaction` `commit_transaction` `rollback_transaction` `memory_search` | 现有 `FIX_TOOLS`（`registry.ts:17-32`） |
| `/init` | read | `inspect_schema` `search_objects` `run_sql` `sample_rows` | **新增**，走确定性 `runInit()` |
| `/schema` | read | `inspect_schema` `search_objects` `sample_rows` | 原 SLASH 宏 |
| `/audit` | read | `inspect_schema` `search_objects` `run_sql` `audit_database` `explain_sql` | 原 SLASH 宏 |
| `/quality` | read | `inspect_schema` `sample_rows` `profile_column` `check_data_quality` `run_sql` | 原 SLASH 宏 |
| `/chart` | read | `inspect_schema` `search_objects` `run_sql` `render_chart` `analyze_chart` `forecast_chart` | 原 SLASH 宏 |
| `/explain` | read | `get_query_history` `explain_sql` `inspect_schema` `run_sql` | 原 SLASH 宏 |
| `/optimize` | **ddl** | `explain_sql` `inspect_schema` `run_sql` `manage_index`（仅 dry-run 预览） | 原 SLASH 宏；`manage_index` 声明风险是 `ddl`，故本命令 `maxRisk` 必须是 `ddl`，见下方说明 |
| `/backup` | read | `backup_database` | 原 SLASH 宏 |
| `/ask` | destructive | undefined（全量） | 自由提问，保持现状 |

> `/optimize` 的 `manage_index` 声明风险是 `ddl`，而 `maxRisk: 'read'` 会把它剔掉。因此 `/optimize` 的 `maxRisk` 设为 **`ddl`**，并在 `instruction` 中硬性要求"只输出建议索引 DDL，不执行；执行必须由用户切到 `/fix`"。这样既保留能力，又靠提示词约束；如果模型真去执行，会走审批（`ask` 模式下）。

### 3.6 用户输入矩阵（全形态）

这是本文的核心需求。**每一行都必须有确定行为，且可被单测覆盖。**

#### 3.6.1 命令识别

| # | 输入 | 解析结果 | 作用域 | 行为 |
|---|---|---|---|---|
| 1 | `/report` | id=report, argument=∅ | report | task = `defaultTask`；模型按报告流程产出。**注意**：桌面端 `AgentPanel.tsx:1091` 当前对裸 `/report` 做了"必须填主题"的拦截并提示——该拦截**保留**，因为报告必须有主题 |
| 2 | `/report 本周订单趋势` | id=report, argument=`本周订单趋势` | report | task = argument（用户话术优先于默认任务） |
| 3 | `/报表 本周订单` | 别名命中 → id=report | report | **当前是缺陷**：`registry.ts:37` 声明了别名 `/报表`，但 `commandIntents.ts:126` 的正则只匹配英文 id，实测 `/报表 本周` 返回 `null`，被当普通文本走全量。M1 并入 `commandAliases()` 后修复 |
| 4 | `/REPORT 本周订单` | 大小写不敏感（`/i`） | report | 同上 |
| 5 | `  /report  本周  ` | 前后空白 trim | report | 同上 |
| 6 | `／report`（全角斜杠） | **不识别** | 全量 | 按普通文本处理。**可选增强**：M4 增加全角归一化（`／`→`/`），单测覆盖 |
| 7 | `/report\n本周订单`（换行分隔） | 正则 `\s+` 匹配换行 → argument=`本周订单` | report | 同上 |
| 8 | `/report /diff` | argument=`/diff`（不递归解析） | report | **不嵌套**。用户误操作，按文本处理 |
| 9 | `/foo`（未知命令） | 不匹配命令与别名集合 | 全量（`/ask` 等价） | 作为普通文本发给模型，模型会解释"没有这个命令" |
| 10 | `/init` | id=init | init | 走 `runInit()` 确定性分支（`agentHost.ts:233` 现有逻辑迁入） |
| 11 | `/init ./docs` | id=init, argument=`./docs` | init | 同上，路径参数透传 |
| 12 | `/init ../../etc` | id=init, argument=`../../etc` | init | 路径校验由 `runInit()` 既有逻辑负责（写文件前 realpath 校验），**本文不改** |
| 13 | `/ask 帮我看看` | id=ask | 全量 | 显式自由提问 |
| 14 | `/schema` `/audit` `/quality` `/chart` `/explain` `/optimize` `/backup` | 各自 id | 各自子集 | 原 SLASH 宏升级为正式命令；`/backup` 会走 `backup_database`（risk=read） |
| 15 | `/memory` `/clear` | **不进入 Agent 回合** | — | 纯前端动作，`AgentPanel.tsx:1147` 本地处理，不上送 |
| 16 | 空串 / 纯空白 | `EMPTY_MESSAGE` 400 | — | `agentHost.ts:218` 现有校验 |

#### 3.6.2 无命令（自由提问）

| # | 输入 | 解析结果 | 作用域 | 行为 |
|---|---|---|---|---|
| 17 | `每天凌晨3点执行 XXX` | 无命令 | 全量 | 阶段二才路由到 `/job`；**本阶段保持全量**，模型会说明能力边界 |
| 18 | `帮我看看订单表` | 无命令 | 全量 | 现状不变 |
| 19 | `@orders 按状态统计` | 无命令 + 附件表 | 全量 | `attachments` 走既有链路（`agentHost.ts` 的 `attachmentTables`） |
| 20 | `[图片] 这张报表什么意思` | 无命令 + 图片 | 全量 | 图片链路不变；若模型无视觉能力，`MODEL_NO_VISION` 400 |

#### 3.6.3 作用域与其它闸门叠加

| # | 场景 | 组合 | 结果 |
|---|---|---|---|
| 21 | 只读连接 + `/fix` | scope=fix ∩ features ∩ mode=ask ∩ connectionReadonly | 工具可见，但任何 write 调用被 `evaluatePermission` deny（`policy.ts:152`），错误码 `READONLY` |
| 22 | 只读模式 + `/report` | mode=readonly | 工具可见（read 类），`run_sql` 若分类为 write → 先 `OUT_OF_SCOPE`（maxRisk=read 先命中），再 `READONLY`。**顺序**：scope 判在前，错误信息优先说明命令不允许 |
| 23 | `features.skills=false` + `/fix` | 开关关闭 | `skill_*` 不在任何命令作用域内，无影响；但 `/ask` 下 `skill_*` 被开关剔除 |
| 24 | 机器人 inbound + `/report` | `bots.ts:115` 传 `mode:'readonly'`, `disableMcp:true` | 作用域=report，MCP 被剔除，只读；报告可正常产出（纯 read） |
| 25 | 移动端 / WebSocket + `/chart` | `server.ts:177` 传 `disableMcp:true` | 作用域=chart，无 MCP |
| 26 | 产物重跑（无会话） | `commands/runner.ts` | **不经 `AgentHost`**，走 `generateAgentReport` 自己的 `REPORT_TOOLS`。本文统一到 `READ_ONLY_REPORT_TOOLS` 后两边一致 |
| 27 | 会话恢复后继续追问 | 历史消息里有 `/report` | 本回合按**本条消息**判定，不继承上一条命令的作用域。作用域是**回合级**，不是会话级 |
| 28 | `/ask` 后再说 `好的继续` | 无命令 | 全量。**已知取舍**：不继承，见 §9.2 |

#### 3.6.4 边界与异常

| # | 场景 | 期望 |
|---|---|---|
| 29 | 作用域内工具全部被 features 剔除（如 `/backup` + 全部开关关闭 → `backup_database` 是 read，不受开关影响） | 正常。若出现空集，仍注入 `SCOPE_BASELINE`（`update_plan`），保证 runtime 不崩 |
| 30 | 模型调用作用域外的工具（模型幻觉） | `runtime.ts:325` 返回 `UNKNOWN_TOOL`。**改进**：`getTool` 收窄后，错误信息应说明"本命令不允许该工具"，见 §3.7 |
| 31 | `extraTools`（`compose_report` / `submit_fix_plan`） | 只在对应命令回合内可见；`reportAgent.ts:68-74` 的私有注册表机制保持不变，由 `extraTools` 声明并注入 `getTool` 白名单 |
| 32 | 命令声明了不存在的工具名 | `assertCommandDefinitions()` 启动即抛错（新增校验，见 §5.1） |
| 33 | 命令的 `allowedTools` 为空数组 | 视为"只有基线"，允许但记录警告；`/backup` 这类单工具命令应是 1 项而非 0 项 |

### 3.7 越界工具的 UX

现在模型调用不存在的工具会得到 `未知工具：xxx`（`runtime.ts:325`），用户看到的是莫名其妙的技术错误。收窄作用域后这种情形会变多（模型知道"能做什么"但可能猜错名字），因此需要区分：

| 错误码 | 触发 | 提示 |
|---|---|---|
| `UNKNOWN_TOOL` | 工具名根本不存在 | `未知工具：xxx`（现状） |
| `OUT_OF_SCOPE` | 工具存在，但本命令不允许 | `本命令（/report）不允许 write 级操作。如需写入请改用 /fix。` |

实现：`getTool` 白名单收窄后，runtime 查不到时先查全量 `getTool(name)`：

```ts
const tool = (deps.getTool ?? getTool)(call.name);
if (!tool) {
  const global = getTool(call.name);          // 全量里存在？
  const res = global
    ? toolFailed(`本命令不允许 ${call.name}。${scopeHint}`, 'OUT_OF_SCOPE')
    : toolFailed(`未知工具：${call.name}`, 'UNKNOWN_TOOL');
  ...
}
```

`scopeHint` 由调用方注入（例如 `/report` → `如需写入请改用 /fix 或直接提问`）。

### 3.8 可观测性

作用域必须可审计，否则出问题无法定位"为什么模型没调 X"。

1. **审计**：`tool_runs`（`store.ts:82-86`）已有 `risk` / `approval` 列，新增写入时把 `scope` 塞进 `args_json` 之外的元信息。**最小改动**：`store.addToolRun()` 调用处（`agentHost.ts` 的 `wrappedEmit` → `case 'tool_result'`）已传 `risk`，增加 `scope: intent?.id ?? 'ask'`。
2. **会话**：`agent_sessions` 无字段变更；`messages` 的 `blocks` 里 `tool_call` 已带 `risk`，可加 `scope`（可选）。
3. **事件**：`start` 事件（`runtime.ts:244`）增加 `scope?: { commandId?: string; toolCount: number }`，UI 可显示"本命令 12 个工具"徽标。
4. **API**：`GET /commands`（`routes.ts:2527`）返回 `allowedTools` 与 `maxRisk`，UI 与调试都能看到。

## 4. 数据模型与接口

### 4.1 数据库

**无变更。** 本阶段不改任何表、不 bump `user_version`（保持 8）。

> 顺带修正：`docs/05-data-and-api.md:403` 写着"当前 3；v3 增加 jobs"，与代码 `apps/gateway/src/store.ts:610` 的 `PRAGMA user_version = 8` 不符。本文实施时一并更正该行（见 §7 文档同步）。

### 4.2 HTTP API

| 方法 | 路径 | 变更 |
|---|---|---|
| GET | `/commands` | 返回体新增 `allowedTools`、`maxRisk`、`scopeGroups`、`instruction`（后者可选，避免前端拿到大段英文） |
| POST | `/agent/sessions/:id/turns` | **无变更**（作用域在服务端由 text 解析，不接受客户端指定 scope，防止越权） |

> **安全约束**：作用域**只能由服务端从用户文本解析**，绝不能接受客户端传入的 `scope` 参数。否则客户端可以传 `scope: 'ask'` 绕过命令限制。

### 4.3 事件协议

`start` 事件新增可选字段：

```ts
{ type: 'start'; turnId: string; sessionId: string; model: string;
  scope?: { commandId?: string; toolCount: number; maxRisk?: Risk } }
```

向后兼容：旧客户端忽略未知字段。

## 5. 类型与校验

### 5.1 `assertCommandDefinitions()` 新增校验

`packages/core/src/commands/validate.ts:17-41` 扩展：

```ts
// 1. allowedTools 必须是真实存在的工具名
for (const name of command.allowedTools ?? []) {
  if (!TOOL_NAMES.includes(name) && !command.extraTools?.includes(name)) {
    throw new Error(`命令 ${command.id} 声明了不存在的工具：${name}`);
  }
}
// 2. allowedTools 不得包含被 maxRisk 剔除的工具（早失败，别等到运行期静默消失）
for (const name of command.allowedTools ?? []) {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool && tool.risk !== 'dynamic' && riskRank(tool.risk) > riskRank(command.maxRisk)) {
    throw new Error(`命令 ${command.id} 的 maxRisk=${command.maxRisk} 低于工具 ${name} 的声明风险 ${tool.risk}`);
  }
}
// 3. extraTools 不得出现在 allowedTools（避免重复注入）
// 4. M3 之后：execution === 'agent' | 'hybrid' 的命令必须有 allowedTools
```

校验 2 会立刻抓出 §3.5 里 `/optimize` 的 `manage_index`（ddl）问题——所以 `/optimize` 必须声明 `maxRisk: 'ddl'`，这是设计自洽的验证点。

### 5.2 与 `toolGroups.ts` 的关系

`scopeGroups` 允许命令按组引用：

```ts
{ id: 'chart', scopeGroups: ['analysis'], allowedTools: ['inspect_schema', 'search_objects', 'run_sql'] }
```

`resolveToolScope` 把 `scopeGroups` 对应组的 `tools` 并入候选。这样"`/tool analysis` 打开分析组"这类后续需求（§10.2）零成本实现。**本阶段可以先只定义字段、不实现 `/tool` 命令。**

## 6. 兼容与迁移

| 风险 | 处理 |
|---|---|
| 现有 `/diff` `/recon` 无 `allowedTools`（undefined = 全量） | M3 补齐；补齐前行为不变（不会更糟） |
| `commandIntents.ts` 删除后 `command-intents.test.ts` 会挂 | 测试同步改写为对 `registry.ts` 的断言；`parseCommandIntent('/init')` 的期望从 `null` 改为 `id='init'`（该断言在 `command-intents.test.ts:28`） |
| 桌面端 `AgentPanel.tsx:891` 的 `presets` 来自 `SLASH`，收编后改为从 `COMMANDS` 生成 | 保留 `kind: 'preset'` 的视觉分组，但数据源改为注册表 |
| 移动端 `apps/mobile/App.tsx:697` 遍历 `COMMANDS` | 自动获得新命令，无需改动（`filter(c => c.id !== 'ask')` 仍然正确） |
| `CommandPalette.tsx:49` 遍历 `COMMANDS` | 自动获得新命令 |
| E2E `scripts/e2e.mjs:1954-1981` 断言斜杠弹层含 `/chart` `/report` `/compare` `/init` | 全部仍在，但 `/chart` 从"preset"变成"command"，需检查断言是否依赖 DOM 结构 |
| `commands/runner.ts:183` 用 `artifact.type` 兜底 `CommandId` | 新命令不产生 artifact 的（`/schema` 等）不受影响；`/init` 也不产生 artifact |

## 7. 开发计划

### M0 设计评审（本文）
- **交付**：`docs/15-command-scoping.md`（本文）。
- **验收**：人工评审通过；§3.6 的 33 行输入矩阵无遗漏项。
- **工作量**：已完成。

### M1 core：作用域纯函数与类型
- **文件**：
  - 新增 `packages/core/src/commands/scope.ts`（`SCOPE_BASELINE`、`resolveToolScope`、`riskRank`）
  - 改 `packages/core/src/commands/types.ts`（`CommandDefinition` 扩展、`CommandId` 扩展）
  - 改 `packages/core/src/commands/registry.ts`（补 `instruction`/`defaultTask`/`timeoutMs`，补 `/diff` `/recon` 的 `allowedTools`）
  - 改 `packages/core/src/commands/validate.ts`（§5.1 四条校验）
  - 改 `packages/core/src/index.ts` 导出
- **验收**：
  - `resolveToolScope` 是纯函数（无 `Date.now`、无 IO），可被单测直接驱动；
  - `assertCommandDefinitions()` 对全部 14 条命令通过；
  - core 单测新增 ≥ 20 例（见 §8）。
- **工作量**：0.5d。

### M2 gateway：接线与越界拒绝
- **文件**：
  - 改 `apps/gateway/src/agentHost.ts:356`（按 `intent` 取 `resolveToolScope`）、`:392`（`getTool` 白名单收窄）、`:233`（`/init` 分支迁走）
  - 改 `apps/gateway/src/commandIntents.ts`（删除，或改为对 registry 的薄封装）
  - 改 `packages/core/src/agent/runtime.ts`（`OUT_OF_SCOPE` 分支；`start` 事件带 scope）
  - 改 `apps/gateway/src/routes.ts:2527`（`/commands` 返回 scope 字段）
- **验收**：
  - `/report` 回合下发的 `tools` 数组**不含** `drop_object`/`transfer_data`；
  - `/report` 下 `run_sql` 执行 `UPDATE` 返回 `OUT_OF_SCOPE`；
  - `update_plan` 在所有命令下都可见（回归 `UNKNOWN_TOOL`）；
  - 现有 188 个 gateway 测试全绿（`builtin-mcp.test.ts:402-405` 对 `visibleAgentTools` 的断言需按新签名调整）。
- **工作量**：1d。

### M3 命令收编（单一来源）
- **文件**：
  - `packages/core/src/commands/registry.ts`：新增 `init` `schema` `audit` `quality` `chart` `explain` `optimize` `backup` 共 8 条
  - `apps/gateway/src/commands/reportAgent.ts:22`：删除 `REPORT_TOOLS`，改 import
  - `apps/gateway/src/agentHost.ts`：`/init` 正则改由注册表生成；新增 `execution === 'inline'` 分发分支（§3.1.1）
- **验收**：
  - `grep -rn "allowedTools" apps/` 只剩 gateway 的读取点；
  - `grep -rn "REPORT_TOOLS" apps/` 零命中；
  - `/init` 行为与现状完全一致（回归 `database-brief` 测试）。
- **工作量**：1d。

### M4 UI 收编与徽标
- **文件**：
  - `apps/desktop/src/components/AgentPanel.tsx:74-110`（删除 `SLASH` 数组）、`:891`（`presets` 改由注册表生成）、`:1091`（裸 `/report` 拦截逻辑保留但改为通用规则）
  - `apps/desktop/src/components/CommandPalette.tsx:49`（分组显示）
  - 可选：Agent 面板显示"本命令 N 个工具"徽标
- **验收**：
  - 斜杠弹层中命令数从 6+10（两套）变为 14（一套）；
  - `/memory` `/clear` 仍在且行为不变；
  - E2E 斜杠断言全绿。
- **工作量**：0.5d。

### M5 验证与文档同步
- **执行**：`npm run verify`（docs → typecheck → test → build → e2e）全绿。
- **文档同步清单**（缺一项 `verify:docs` 会挂或文档失真）：
  | 文件 | 改动 |
  |---|---|
  | `docs/15-command-scoping.md` | 本文状态改为"已实施"，补偏差说明 |
  | `docs/04-ai-agent-design.md` | §4 工具目录加一句"命令回合只下发子集" |
  | `docs/11-command-workflows.md` | §0 摘要补命令清单（14 条）与作用域表 |
  | `docs/05-data-and-api.md:403` | `user_version` 由"当前 3"更正为 8 |
  | `docs/06-delivery-and-verification.md` | §2.1 增加作用域验收场景 |
  | `scripts/verify-docs.mjs` | `required` 增加 `docs/15-command-scoping.md`；`requiredSections` 增加 `['命令作用域','输入矩阵','开发计划']`；新增"每个 agent/hybrid/inline 命令都有 allowedTools"校验 |
  | `README.md` | 工具数量仍 52（不变），命令数量 6 → 14 |
- **工作量**：0.5d。

**总工作量：约 3.5 人日。**

### 7.1 里程碑依赖

```
M0（本文）──► M1（core 纯函数）──► M2（gateway 接线）──► M3（命令收编）──► M4（UI）──► M5（验证）
                                      │
                                      └──► 阶段二（语义路由）依赖 M2 的 resolveToolScope
                                      └──► 阶段三（/job 调度）依赖 M3 的注册表扩展点
```

M1 与 M2 之间存在**唯一一次行为变更**：`/report` 下 `run_sql` 写操作从"审批后执行"变成"拒绝"。这是刻意的，须在 M2 的 PR 说明里显著标注。

## 8. 测试计划

### 8.1 单元（`packages/core/test/scope.test.ts`，新增）

| # | 用例 | 断言 |
|---|---|---|
| 1 | `/report` 作用域 | 含 `run_sql`，不含 `drop_object`/`transfer_data`/`manage_index` |
| 2 | 基线注入 | 任何命令的 `names` 都含 `update_plan` |
| 3 | `features.skills=false` | `/ask` 全量下不含 `skill_*` |
| 4 | `allowMcp=false` | `/ask` 全量下不含 `mcp_*` |
| 5 | 顺序：先开关后风险 | `features.skills=false` + `/fix`：`dropped` 里 `skill_*` 的原因是 `feature` 不是 `risk` |
| 6 | dynamic 保留、但受 allowedTools 二次限制 | `/report`（maxRisk=read）的 `names` **含** `run_sql`（dynamic，且在白名单里），**不含** `alter_table`（不在 `/report` 白名单） |
| 7 | maxRisk 校验 | `assertCommandDefinitions()` 对"`/optimize` 声明 maxRisk=read 却列 `manage_index`"抛错 |
| 8 | 未知工具名 | 命令列了 `not_a_tool` → `assertCommandDefinitions()` 抛错 |
| 9 | 空集保护 | 假设某命令 `allowedTools` 全被裁掉，`names` 至少含 `update_plan` |
| 10 | 顺序稳定 | 两次调用的 `names` 顺序完全一致（prompt 缓存友好） |
| 11 | `scopeGroups` 展开 | `scopeGroups:['analysis']` 并入 5 个分析工具 |
| 12 | 全部命令自检 | 遍历 `COMMANDS`，每个 `agent`/`hybrid`/`inline` 命令的 `allowedTools` 非空且全部存在于 `TOOL_NAMES` |

### 8.2 集成（`apps/gateway/test/command-scope.test.ts`，新增）

| # | 用例 | 断言 |
|---|---|---|
| 13 | `/report` 回合下发工具数 | `start` 事件 `scope.toolCount` ≤ 12 且不含 `drop_object` |
| 14 | `/report` + `run_sql` UPDATE | 工具结果 `error.code === 'OUT_OF_SCOPE'`，审计 `status='error'` |
| 15 | `/report` + `run_sql` SELECT | 正常返回 |
| 16 | `/fix` + `run_sql` UPDATE（ask 模式） | 触发 `approval_required`，批准后执行成功 |
| 17 | 无命令回合 | 全量（等价 `/ask`），工具数 = 52 − features 裁剪 |
| 18 | `/init` | 仍走确定性分支，不产生工具调用，`AI_DB.md` 落盘 |
| 19 | 机器人回合 `/report` | `mode='readonly'`，MCP 不在工具列表 |
| 20 | 模型调用作用域外工具 | `OUT_OF_SCOPE`，消息含"改用 /fix" |
| 21 | `update_plan` 回归 | 所有命令下 `update_plan` 均可见，不出现 `UNKNOWN_TOOL` |

### 8.3 E2E（`scripts/e2e.mjs` 扩展）

| # | 用例 |
|---|---|
| 22 | 输入 `/report` → 弹层显示命令；发送后工具卡中**不出现** `drop_object` |
| 23 | 输入 `/` → 弹层命令数 = 14（含 `/schema` `/audit` `/backup` 等原宏） |
| 24 | `/memory` `/clear` 仍为本地动作（不产生 Agent 回合） |
| 25 | 移动端命令选择器含新增命令 |

### 8.4 回归门槛

- `npm run verify:docs` 全绿（含新增文档与"命令必须有 allowedTools"校验）
- `npm run typecheck` 全绿
- `npm test`：core 153 + 新增 ≥ 12；gateway 188 + 新增 ≥ 9

> 基线数字取自 `docs/11-command-workflows.md:51`（docs 335/335、core 153/153、gateway 188 pass / 65 skipped）；实施时以当次 `npm test` 输出为准。
- `npm run e2e` 全绿

## 9. 取舍与已知限制

### 9.1 为什么不用 `/tool <name>` 直接暴露工具箱

`/tool` 若做成"打开全部工具箱"，等于把 53 个工具换个地方，仍是全量。正确的形态是 `/tool <domain>`（`/tool analysis`、`/tool transfer`），映射到 `scopeGroups`，每个 domain 3–7 个工具。本阶段先把 `scopeGroups` 字段与展开逻辑做好，命令本身留到 §10.2。

### 9.2 作用域是回合级，不跨回合继承

`/report` 之后用户说"再画个图"，本回合无命令 → 全量。**不继承**的理由：

1. 继承会让"我换个话题"变得不可预测；
2. 作用域本质是"这次我要做这类事"，不是"这个会话只做这类事"；
3. 全量兜底不会更糟，只是上下文更贵。

**代价**：连续追问同一命令时，第二回合工具变多，可能选错工具。**缓解**：`start` 事件带 `scope`，UI 可提示"当前为自由模式，14 个命令中选一个可收窄"；阶段二的自然语言路由会让"再画个图"也命中 `/chart`。

### 9.3 为什么不做动态工具发现（tool search / lazy load）

Anthropic / OpenAI 都在推"按需发现工具"，能彻底解决工具膨胀。但：

- 需要 provider 支持 `tool_search` 类原语，当前 3 个 provider（`packages/core/src/agent/providers/`）都没有；
- 会引入"模型搜不到工具"的新失败模式，比"少几个工具"更难诊断；
- 静态子集对本仓库的规模（52 → 每个命令 3–13）已足够。

结论：v1 静态，v2 若 provider 支持再评估。

### 9.4 顺带发现的两个既有问题（不在本文范围，另案处理）

1. **`memory_write` 声明为 `risk: 'read'`**（`packages/core/src/agent/tools.ts:588`），但它是持久化写入。后果：它是唯一能在无人值守时存活、且能穿透到外部 MCP 客户端（`scripts/aidb-mcp-server.mjs:28` 只放 read+dynamic）的写工具。应改为 `write`，同时 `docs/04-ai-agent-design.md:148`（工具表第 17 行）风险列同步为 `write`（否则 `verify:docs` 的风险一致性校验会挂）。
2. **`runJob` 不复检策略**（`apps/gateway/src/scheduler.ts:96-165`）：不调用 `resolveRisk`/`evaluatePermission`，审计 `risk` 硬编码 `'write'`、`actor:'user'`、`allowMulti:true` 绕过 `run_sql` 的多语句护栏。属阶段三的前置修复。

### 9.5 不做的

- 不做命令级权限（"只有 admin 能用 `/fix`"）——现有模型里没有用户角色概念。
- 不做作用域自定义（用户自己配每个命令的工具）——配置面太重，收益低。
- 不做跨命令组合（`/diff` 里调用 `/report`）——会让作用域成为图，复杂度爆炸。

## 10. 后续阶段（本文只定义边界，不实施）

### 10.1 阶段二：自然语言意图路由（L2）

- **输入**：无斜杠的用户原话。
- **机制**：规则优先（关键词表 + 正则），命中即选命令；不命中走全量。**不上分类模型**。
- **候选信号**：定时类（`每天/每周/每月/几点/凌晨/定时/自动/跑完发`）→ 未来 `/job`；体检类（`体检/质量/健康`）→ `/audit`；结构类（`结构/字段/DDL`）→ `/schema`；对比类（`对比/差异/vs`）→ `/compare`。
- **安全**：路由错只导致"工具少几个"，模型会说明"需要 X 工具"，用户补一句即可；**绝不能**因为路由把只读命令用到了写场景（`maxRisk` 兜底）。
- **验收**：规则表覆盖 ≥ 40 条中英文样例；未命中率 ≥ 40% 时判定规则过于激进，回退阈值。

### 10.2 阶段二附带：`/tool <domain>`

- `/tool analysis` → `scopeGroups: ['analysis']`，5 个工具。
- `/tool`（无参数）→ 列出可用 domain（来自 `AGENT_TOOL_GROUPS`），**不直接展开全量**。

### 10.3 阶段三：`/job` 定时任务

依赖本文的注册表扩展点与 `resolveToolScope`。要点（详见后续文档 `16-scheduling.md`，待写）：

- 时间模型：结构化 `{kind: 'interval'|'daily'|'weekly'|'monthly', time, days, timezone}` + 存 `next_run_at`；**不用 cron**。
- 纯函数 `nextRunAt(now, schedule, tz)` 放 core，供 jobs / artifact_schedules / dashboard_schedules 三处共用（**只统一时间模型，不合并三张表**）。
- `jobs` 表补 `notify_channels`（对齐 `artifact_schedules:181`），否则"跑完发飞书"做不到。
- `manage_job` 风险 `dynamic`（按 SQL 分类），运行期复检 `approved_risk`，连续失败自停。
- 命令 `/job` 的 `allowedTools`：`manage_job` `list_jobs` `run_sql` `inspect_schema` `list_notification_channels`。

## 11. 变更记录

- v1.0（2026-11-01）：初版。定义命令作用域三层模型、33 行输入矩阵、`maxRisk` 对 dynamic 的语义、`OUT_OF_SCOPE` 拒绝而非审批、四份命令定义收编为单一来源、M0–M5 计划（约 3.5 人日）。
