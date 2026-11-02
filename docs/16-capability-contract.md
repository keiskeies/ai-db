# AiDB Studio — 功能能力契约（Capability Contract）设计与开发计划

> 版本：v2.2 · 日期：2026-11-01 · 状态：**M1–M6 已实施（M3 覆盖 10 个端点=全部工具箱模块；M4 覆盖 5 个 UI 模块；契约在独立的「设置 → 功能能力」页可见并带明细）；渲染约定见 §12.7；其余 UI 模块有结构性障碍，见 §12.5；M4 引入的回归见 §12.6**
>
> 实施偏差见 §12。
> 关联：[功能规格](./02-feature-spec.md) · [AI Agent 设计](./04-ai-agent-design.md) · [数据模型与接口协议](./05-data-and-api.md) · [Skill Host](./13-skill-host-plan.md)
>
> 本文是实施依据，不代表功能已完成。文中的 schema、接口、行为均为待落地设计；实现时必须同步本文与 `scripts/verify-docs.mjs`。

## 0. 摘要

AiDB 工具箱现在有 13 个功能模块（报告、自动化任务、数据传输、数据对比、结构对比同步、数据生成、服务器监控、用户与权限、数据字典、高级对象、数据库搜索、查询构建器、Agent 上下文），每个模块都有：一张手写的 React 表单、一个手写的 REST 端点、一段手写的参数校验、一个进程内执行函数。

**这份契约要解决的是：同一份"这个功能需要什么参数"的知识，现在被写了三遍（UI、端点校验、Agent 工具 schema），而且互相不知道对方存在。**

本文定义 **Capability Contract（能力契约）**：每个功能模块用一份声明式 JSON 描述自己的**表单契约**——有哪些字段、什么类型、什么约束、什么状态、什么流程。这一份声明同时服务三个消费方：

| 消费方 | 用途 |
|---|---|
| **Agent** | 系统提示里的能力目录：知道有哪些功能、怎么填、返回什么状态 |
| **REST 端点** | 参数校验（替代现在手写的 `str()` / `num()` / 手写必填检查） |
| **UI 表单** | 渲染（渐进迁移，不强制） |

### 0.1 一句话目标

> Agent 使用工具箱功能的方式，和人在 UI 上填表单点保存**完全一致**——它知道有哪些功能、每个字段填什么、提交后返回什么状态；它不需要知道功能内部怎么实现。

### 0.2 非目标

- **不引入脚本执行能力**。若某功能有个字段值是一段脚本（如"上下游处理"的转换脚本），该字段的类型是 `code`，**脚本的解析、沙箱、超时、资源限制全部由该功能的执行器自己负责**，契约只声明"这里要填一段 JS、入参出参是什么"。契约层不认识"执行脚本"这件事。
- 不改动 52 个 Agent 工具的语义、风险等级与数量。
- 不新增工具（缺的 9 个工具是独立事项，见 §9.2）。
- 不重写现有 UI 表单（渐进迁移，见 §7 M4）。
- 不涉及定时任务的时间模型（独立文档）。
- 不涉及命令作用域（独立文档 `15-command-scoping.md`）。

## 1. 现状与证据

### 1.1 同一份参数知识写了三遍

以「数据传输」为例：

| 位置 | 内容 |
|---|---|
| UI 表单 | `apps/desktop/src/components/tools/TransferTool.tsx`（696 行，手写全部字段与校验） |
| REST 端点 | `apps/gateway/src/features/routes.ts:223-255`：手写 `str()` 取值 + 必填检查 |
| Agent 工具 | `packages/core/src/agent/tools.ts:1005-1023`：`transfer_data` 的 JSON Schema |

三处的字段名**已经不一致**：

| 概念 | UI / REST | Agent 工具 |
|---|---|---|
| 源连接 | `sourceId` | `sourceConnectionId` |
| 目标连接 | `targetId` | `targetConnectionId` |
| 源库 | `sourceDatabase` | `sourceDatabase` ✓ |
| 模式 | `mode: 'append' \| 'replace'` | `mode: 'append' \| 'replace'` ✓ |
| 行数上限 | `limit`（REST 有，`routes.ts:239`） | **无** |

后果：Agent 通过工具调用无法设置 `limit`；REST 调用方看到的参数名与 Agent 不同；两边的默认值语义靠人肉对齐。

### 1.2 参数校验是手写的，且各写各的

`apps/gateway/src/features/routes.ts:39-41` 只有两个 helper：

```ts
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}
```

每个端点自己拼必填检查：

```ts
// routes.ts:94
if (!connectionId || !database) throw Object.assign(new Error('connectionId 与 database 必填'), ...);
// routes.ts:139
if (!connectionId || !table || !column) throw Object.assign(new Error('connectionId / table / column 必填'), ...);
// routes.ts:181
if (!sourceId || !targetId) throw Object.assign(new Error('sourceId 与 targetId 必填'), ...);
```

重复 15 处以上，错误信息格式不统一（`与` vs `/`），字段类型（枚举、数字范围、布尔默认值）全靠 `body.mode === 'replace' ? 'replace' : 'append'` 这种写法兜。

### 1.3 只有 MCP 有能力目录，工具箱没有

`apps/gateway/src/agentHost.ts:108-126` 的 `mcpPromptBlock()` 已经做了这件事：

```ts
// :125
return `## MCP servers\nUse the exact server id for mcp_list_tools / mcp_call; never guess a server name.
For built-in tools you may omit \`server\` — it is inferred from the tool name.
Built-in read tools run directly; writes need approval in ask mode.\n${lines.join('\n')}`;
```

它把每个 server 的 id、名字、工具列表（带风险等级）、配置状态、使用注意事项**注入系统提示**，并明确写"never guess a server name"。

**工具箱的 12 个模块没有任何对应的提示块。** `agentHost.ts:380-389` 的 `extra` 数组里只有 `intent` / `brief` / `summary` / `schemaError` / `mcpPromptBlock` / `local` 六项，没有能力目录。

### 1.4 状态汇报没有协议

`ToolResult.meta`（`packages/core/src/agent/types.ts:24-29`）只有四个字段：

```ts
meta: {
  durationMs: number;
  rowsAffected?: number;
  truncated?: boolean;
  backupPath?: string;
};
```

**没有 `progress`。** 而底层其实是有进度的：

- `apps/gateway/src/features/transfer.ts:23-33` 定义了 `TransferEvent`：`start` / `table-start`（带 `index`、`total`）/ `phase-start`（带 `phase`）/ `phase-done`
- `apps/gateway/src/features/routes.ts:257` 的 `/transfer/stream` 通过 SSE 把这些事件发给前端

但 `transfer_data` 这个 **Agent 工具走的是同步调用**（`executor.ts:1318`），拿不到流式事件。所以模型只能说"传完了/失败了"，说不出"正在传第 3 张表，共 8 张"。

### 1.5 部分功能没有对应的 Agent 工具

| 工具箱模块 | REST 端点 | Agent 工具 |
|---|---|---|
| 报告 | `POST /commands/report/runs`（`runner.ts`，异步运行 + SSE） | 对话内用 `/report`（`commandIntents`）；产物导出走 `/artifacts/:id/export` |
| 数据库搜索 | `POST /search`（`routes.ts:157`） | `search_objects` 只覆盖对象名，**数据全文搜索无工具** |
| 查询构建器 | 无（纯前端拼 SQL） | 不需要（`run_sql` 等价） |
| 结构对比同步 | `POST /schema/compare`（`:175`）、`POST /schema/sync`（`:186`） | 对比有 `schema_diff`；**同步执行无工具** |
| 数据对比 | `POST /data/compare`（`:433`） | **无**（`recon_data` 是键级对账，不等价） |
| 数据传输 | `POST /transfer`（`:223`） | `transfer_data` ✓ |
| 数据生成 | `POST /generate`（`:326`） | `generate_data` ✓ |
| 服务器监控 | `GET /monitor`（`:356`）、`POST /monitor/kill`（`:365`） | **无** |
| 自动化任务 | `GET/POST /jobs`（`:452-500`） | **无** |
| 用户与权限 | `GET /users`（`:376`）、`POST /users/action`（`:385`） | **无** |
| 数据字典 | `GET /dictionary`（`:404`） | **无** |
| 高级对象 | `GET /objects`（`:413`） | **无** |
| Agent 上下文 | `GET/PUT/DELETE /agent/context*`（`routes.ts:2400-2477`） | 读取隐式注入；**写入无工具** |

## 2. 概念模型

### 2.1 三层职责

| 层 | 是什么 | 谁消费 |
|---|---|---|
| **契约层** | `capability.json`：字段、类型、约束、状态、流程 | Agent（提示）、REST（校验）、UI（渲染） |
| **执行层** | 进程内函数（如 `transferData()`） | Gateway 端点、Agent 工具 |
| **工具层** | `tools.ts` 里的 `ToolDefinition` | Agent 运行时 |

**契约层不认识"执行"**。它只描述"这个功能接受什么、返回什么"。执行层怎么实现（包括字段值是一段 SQL、一段 JS、一个正则）与契约无关。

### 2.2 与 Skill 的区别（重要边界）

| | Skill Host | Capability Contract |
|---|---|---|
| 本质 | 外部技能包（`SKILL.md` + 脚本 + 资产） | 软件自带功能 |
| 执行 | 子进程（`spawn`），工作区、超时、密钥 | 进程内函数 |
| 谁写 | 用户/第三方导入 | 产品自己 |
| 权限 | `aidb.skill.json` 声明 fs/process/network | 复用现有连接只读、审批、审计 |
| 本文关系 | **不涉及** | 本文只做契约层 |

**明确边界**：契约的 `code` 字段（如转换脚本）**不是** Skill。它只是某个功能的一个字段值，由该功能自己的执行器处理（可能用 `node:vm`、可能只做语法校验、可能根本不执行）。契约层对此**不做任何承诺**。

### 2.3 三个正交维度

一个功能在系统里有三个独立标记，**不要混淆**：

```
① 契约（capability.json）   —— 功能是什么、字段是什么    ← 本文
② 工具（tools.ts）          —— Agent 能不能调、什么风险   ← 本文只做"关联声明"
③ 权限（policy.ts）         —— 这次调用能不能执行         ← 不改
```

## 3. 需求设计

### 3.1 契约文件位置与发现

```
packages/core/src/capabilities/
├── index.ts                    # 注册表：按 id 查找、列出全部
├── types.ts                    # 类型定义
├── transfer.json               # 数据传输
├── compare-data.json           # 数据对比
├── schema-sync.json            # 结构对比同步
├── jobs.json                   # 自动化任务
├── generate.json               # 数据生成
├── monitor.json                # 服务器监控
├── users.json                  # 用户与权限
├── dictionary.json             # 数据字典
├── advanced-objects.json       # 高级对象
├── search.json                 # 数据库搜索
├── query-builder.json          # 查询构建器
├── agent-context.json          # Agent 上下文
└── reports.json                # 报告
```

**为什么放 `packages/core` 而不是 `apps/gateway`**：契约要被三个 workspace 消费——core（Agent 提示）、gateway（端点校验）、desktop（表单渲染）。放 core 是唯一三方都能 import 的位置。

**为什么用 JSON 不用 TS**：契约是数据，不是代码。JSON 可以被 `scripts/verify-docs.mjs` 直接解析校验，也可以被未来的 UI 构建脚本读取。

### 3.2 契约 schema

```ts
// packages/core/src/capabilities/types.ts

export type CapabilityFieldType =
  | 'connection'      // 连接 id，UI 渲染连接选择器，校验：连接存在
  | 'database'        // 库名，UI 渲染库选择器，依赖同表单的 connection 字段
  | 'table'           // 表名，UI 渲染表选择器，依赖 connection/database
  | 'tables'          // 表名数组
  | 'text'            // 自由文本
  | 'code'            // 代码片段（SQL / JS / 正则）；**契约只声明语言与入参出参，不承诺执行**
  | 'number'          // 数字，可带 min/max/default
  | 'boolean'         // 布尔
  | 'enum'            // 枚举，必须给 options
  | 'json'            // 结构化对象

export interface CapabilityField {
  key: string;
  type: CapabilityFieldType;
  label: { zh: string; en: string };
  required?: boolean;
  /** 默认值；不写表示无默认。 */
  default?: unknown;
  /** 当 type=number 时生效。 */
  min?: number;
  max?: number;
  /** 当 type=enum 时生效，必须非空。 */
  options?: Array<{ value: string; label: { zh: string; en: string }; risk?: 'read' | 'write' | 'ddl' | 'destructive' }>;
  /** 当 type=code 时生效：语言标识，如 'sql' | 'javascript' | 'regex'。 */
  language?: string;
  /** 当 type=code 时生效：给填写者的入参/出参说明（纯文字，契约不校验）。 */
  signature?: { input?: string; output?: string };
  /** 给 Agent 的补充说明：什么时候该填、有什么坑。 */
  hint?: string;
  /** 高级字段，UI 默认折叠。 */
  advanced?: boolean;
  /** 字段之间的可见性依赖，如 { field: 'op', equals: 'rename' } 表示只在 op=rename 时显示。 */
  showWhen?: { field: string; equals: unknown };
  /**
   * 迁移期的旧字段名。契约统一用 Agent 工具的命名（`sourceConnectionId`），
   * 历史端点用 `sourceId`；校验时先读 `key` 再回退 `legacyKey`，两侧同时可用。
   * 端点全部迁移完成后删除。
   */
  legacyKey?: string;
}

export interface CapabilityState {
  /** 状态机里的状态 id。 */
  id: string;
  label: { zh: string; en: string };
  /** 终态：不再变化。 */
  terminal?: boolean;
  /** 给 Agent 的汇报话术模板，可含 {field} 占位符。 */
  phrase: string;
}

export interface CapabilityProgress {
  /** 是否支持进度上报。false 时 Agent 不应期待 progress。 */
  supported: boolean;
  /** 进度单位，如 'table' / 'row' / 'batch'。 */
  unit?: string;
}

export interface Capability {
  /** 唯一 id，kebab-case。 */
  id: string;
  /** 与 REST 路由的对应关系，仅作说明；空表示纯前端功能。 */
  route?: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string };
  title: { zh: string; en: string };
  /** 一句话说明，会进 Agent 提示。 */
  description: string;
  /** 什么时候该用；会进 Agent 提示。 */
  whenToUse: string;
  /** 流程步骤，会进 Agent 提示；纯文字，不是可执行计划。 */
  flow: string[];
  fields: CapabilityField[];
  states: CapabilityState[];
  progress?: CapabilityProgress;
  /** 对应的 Agent 工具名；空数组表示当前无工具（Agent 只能告知用户去 UI 操作）。 */
  tools: string[];
  /** 本功能的声明风险上限，供 Agent 判断是否需要审批提示。 */
  maxRisk: 'read' | 'write' | 'ddl' | 'destructive';
  /** 引擎/权限限制说明，会进 Agent 提示。 */
  constraints?: string[];
}
```

### 3.3 契约示例：数据传输

```json
{
  "id": "transfer",
  "route": { "method": "POST", "path": "/transfer" },
  "title": { "zh": "数据传输", "en": "Data transfer" },
  "description": "跨连接复制表结构与数据，目标缺失表自动创建",
  "whenToUse": "用户要把一批表从 A 库搬到 B 库、或定期同步两张表时",
  "flow": [
    "确认源连接与目标连接（必须是两个不同的连接 id）",
    "确认要传的表；不传则传全部表",
    "确认 mode：append 追加（目标已有数据保留）或 replace 先清空",
    "确认 createMissing：目标缺表时是否自动建表",
    "执行并逐表汇报结果"
  ],
  "fields": [
    { "key": "sourceConnectionId", "type": "connection", "label": { "zh": "源连接", "en": "Source" }, "required": true },
    { "key": "sourceDatabase", "type": "database", "label": { "zh": "源库", "en": "Source database" } },
    { "key": "targetConnectionId", "type": "connection", "label": { "zh": "目标连接", "en": "Target" }, "required": true, "hint": "目标为只读连接时会被拒绝" },
    { "key": "targetDatabase", "type": "database", "label": { "zh": "目标库", "en": "Target database" } },
    { "key": "tables", "type": "tables", "label": { "zh": "限定表", "en": "Tables" }, "hint": "留空表示全部表；表多时建议限定以避免长时间运行" },
    { "key": "mode", "type": "enum", "label": { "zh": "写入方式", "en": "Mode" }, "default": "append",
      "options": [
        { "value": "append", "label": { "zh": "追加", "en": "Append" } },
        { "value": "replace", "label": { "zh": "清空后写入", "en": "Replace" }, "risk": "destructive" }
      ] },
    { "key": "createMissing", "type": "boolean", "label": { "zh": "自动建表", "en": "Create missing" }, "default": true },
    { "key": "limit", "type": "number", "label": { "zh": "每表行数上限", "en": "Row limit" }, "min": 1, "advanced": true,
      "hint": "用于试跑；不填表示全量" }
  ],
  "states": [
    { "id": "running", "label": { "zh": "进行中", "en": "Running" }, "phrase": "正在传输 {current}/{total} 张表" },
    { "id": "ok", "label": { "zh": "成功", "en": "Succeeded" }, "terminal": true, "phrase": "已传输 {tables} 张表、{rows} 行" },
    { "id": "partial", "label": { "zh": "部分成功", "en": "Partial" }, "terminal": true, "phrase": "{ok} 张成功、{failed} 张失败" },
    { "id": "failed", "label": { "zh": "失败", "en": "Failed" }, "terminal": true, "phrase": "传输失败：{error}" }
  ],
  "progress": { "supported": true, "unit": "table" },
  "tools": ["transfer_data"],
  "maxRisk": "write",
  "constraints": [
    "目标连接为只读时拒绝执行",
    "replace 模式会先清空目标表，属于破坏性操作",
    "非 SQL 引擎的表不支持结构复制"
  ]
}
```

### 3.4 契约示例：自动化任务（含 hook 通知字段的预留）

```json
{
  "id": "jobs",
  "route": { "method": "POST", "path": "/jobs" },
  "title": { "zh": "自动化任务", "en": "Automation jobs" },
  "description": "按固定节奏执行 SQL 或备份",
  "whenToUse": "用户说『每天/每周/每隔 N 分钟执行某段 SQL』『定时备份』时",
  "flow": [
    "确认连接与库",
    "确认要执行的 SQL（或选择备份类型）",
    "确认节奏：间隔秒数，或每天/每周的固定时刻",
    "可选：绑定通知渠道，任务结束推送结果",
    "保存；之后由调度器独立运行，与本次对话无关"
  ],
  "fields": [
    { "key": "name", "type": "text", "label": { "zh": "任务名", "en": "Name" }, "required": true },
    { "key": "connectionId", "type": "connection", "label": { "zh": "连接", "en": "Connection" }, "required": true },
    { "key": "database", "type": "database", "label": { "zh": "库", "en": "Database" } },
    { "key": "type", "type": "enum", "label": { "zh": "类型", "en": "Type" }, "required": true, "default": "query",
      "options": [
        { "value": "query", "label": { "zh": "执行 SQL", "en": "SQL" } },
        { "value": "backup", "label": { "zh": "备份", "en": "Backup" } }
      ] },
    { "key": "sql", "type": "code", "language": "sql", "label": { "zh": "SQL", "en": "SQL" },
      "required": true, "showWhen": { "field": "type", "equals": "query" },
      "hint": "任务在无人值守时执行；请确保语句可重复执行且不会误伤数据" },
    { "key": "intervalSeconds", "type": "number", "label": { "zh": "间隔秒数", "en": "Interval" }, "min": 30, "default": 3600 },
    { "key": "notifyChannels", "type": "tables", "label": { "zh": "通知渠道", "en": "Notify" }, "advanced": true,
      "hint": "任务结束后把结果推送到这些渠道；不填则只写审计" }
  ],
  "states": [
    { "id": "pending", "label": { "zh": "待运行", "en": "Pending" }, "phrase": "任务已保存，下次运行时间 {nextRunAt}" },
    { "id": "running", "label": { "zh": "运行中", "en": "Running" }, "phrase": "任务正在运行" },
    { "id": "ok", "label": { "zh": "成功", "en": "Succeeded" }, "terminal": true, "phrase": "任务执行成功：{message}" },
    { "id": "failed", "label": { "zh": "失败", "en": "Failed" }, "terminal": true, "phrase": "任务执行失败：{error}" }
  ],
  "progress": { "supported": false },
  "tools": [],
  "maxRisk": "write",
  "constraints": [
    "任务保存后由调度器独立运行，与创建它的对话无关",
    "最小间隔 30 秒",
    "任务执行的 SQL 会被记录到审计，approval 标记为 scheduled"
  ]
}
```

> **注意** `"tools": []`：自动化任务当前**没有** Agent 工具。契约可以先写好（让 Agent 知道有这个功能、知道怎么引导用户去 UI 操作），工具补齐后把 `tools` 填上即可，契约不变。

### 3.5 契约的三个消费方

#### 3.5.1 Agent：能力目录注入系统提示

新增 `capabilityPromptBlock()`，位置与 `mcpPromptBlock()` 并列（`apps/gateway/src/agentHost.ts:385` 之后）：

```ts
// 伪代码
function capabilityPromptBlock(): string {
  const lines = CAPABILITIES.map((c) => {
    const tools = c.tools.length ? c.tools.join(', ') : '(no agent tool — guide the user to 工具箱 → ' + c.title.zh + ')';
    return `- ${c.id} — ${c.title.zh}: ${c.description}\n  When: ${c.whenToUse}\n  Tools: ${tools}\n  Fields: ${c.fields.map((f) => `${f.key}:${f.type}${f.required ? '*' : ''}`).join(', ')}`;
  });
  return `## Capabilities (软件自带功能)\n这些是产品自带的功能，不是你发明的。用对应工具调用；没有工具的功能要引导用户到工具箱操作，不要假装能执行。\n${lines.join('\n')}`;
}
```

**Token 预算**：12 个功能 × 约 120 token ≈ 1.4k token。这是常量开销，不随会话增长。若嫌大，可用 `scopeGroups` 类似的机制按命令/场景裁剪（见 §9.3）。

**关键约束**：提示里必须明确"没有工具的功能**不要假装能执行**"，否则模型会编造参数直接发 REST 请求或谎称已完成。

#### 3.5.2 REST：参数校验

新增 `validateCapabilityInput(capability, body)` 于 `packages/core/src/capabilities/validate.ts`：

```ts
export interface CapabilityValidation {
  ok: boolean;
  /** 归一化后的参数（含默认值）。 */
  value?: Record<string, unknown>;
  errors?: Array<{ field: string; message: string }>;
}
```

规则：

| 字段类型 | 校验 |
|---|---|
| `connection` | 非空字符串；**连接是否存在由 gateway 补检**（core 不认识 store） |
| `database` / `table` / `tables` | 非空字符串（数组则每项非空） |
| `text` | 字符串；`required` 时不得为空串 |
| `code` | 字符串；`required` 时不得为空；**不做语法校验**（归执行器） |
| `number` | 有限数字；`min` / `max` 越界报错；无值时用 `default` |
| `boolean` | 布尔；`undefined` 时用 `default` |
| `enum` | 必须在 `options` 的 `value` 里 |
| `json` | 必须是对象 |

**归一化**：返回的 `value` 一定填好默认值，执行器不再写 `body.mode === 'replace' ? 'replace' : 'append'` 这种兜底。

**渐进迁移**：端点可以先调 `validateCapabilityInput()` 拿到 `value`，再转成现有执行函数的入参。**不要求一次性改完 15 个端点**（见 §7 M3）。

#### 3.5.3 UI：表单渲染（渐进）

`CapabilityField` 的每个 `type` 对应一个渲染器：

| type | 渲染器 | 现状 |
|---|---|---|
| `connection` | `DatabaseSelect` / 连接下拉 | 已有组件 |
| `database` | 库下拉，依赖 `connection` | 已有 |
| `table` / `tables` | 表选择器 | 已有 |
| `text` / `number` / `boolean` | 标准输入 | 已有 |
| `enum` | 下拉，`option.risk` 非 read 时显示风险徽标 | 新增 |
| `code` | 等宽输入框 + 语言标识；不提供语法高亮（v1） | 新增 |
| `json` | 文本域 + JSON.parse 校验 | 新增 |

**v1 不强制迁移 UI**。先让契约服务于 Agent 与校验，UI 保持手写。等契约稳定后（M4）再挑 2 个模块试迁，验证渲染器是否够用。

### 3.6 状态汇报协议

#### 3.6.1 扩展 `ToolResult.meta`

```ts
// packages/core/src/agent/types.ts:24
meta: {
  durationMs: number;
  rowsAffected?: number;
  truncated?: boolean;
  backupPath?: string;
  /** 长任务进度；只在执行过程中有值。 */
  progress?: {
    current: number;
    total: number;
    /** 进度单位，与 capability.progress.unit 对应。 */
    unit: string;
    /** 当前正在处理的对象名，如 'orders'。 */
    label?: string;
  };
  /** 终态；与 capability.states[].id 对应。 */
  state?: string;
};
```

**兼容性**：两个字段都是可选，现有 52 个工具不受影响，不需要改任何工具实现。

#### 3.6.2 谁填 `progress`

只有声明了 `progress.supported: true` 的功能对应的工具才填。当前候选：

| 工具 | 底层是否已有进度源 | 工作量 |
|---|---|---|
| `transfer_data` | ✅ `TransferEvent`（`features/transfer.ts:23`） | 把 `onEvent` 回调转成 `progress` |
| `generate_data` | ❌ 一次性生成 | 可加（按行分批） |
| `schema_diff` | ❌ | 不需要（快） |
| `recon_data` | ❌ | 可加（按键分批） |

**注意**：`transfer_data` 的 executor 分支（`executor.ts:1318`）现在是同步调用 `transferData()`。要拿进度需要传 `onEvent`，把最后一个事件存进变量，执行结束后写进 `meta.progress`。**这不是流式**——Agent 工具仍是一次调用返回一次结果，只是返回体里带了"最终进度快照"。

若要做**真正的流式进度**（模型边执行边看到"3/8"），需要 Agent 工具支持中间事件推送，这是更大的改动（`runtime.ts` 的工具执行循环要支持 `onProgress`），**不在 v1 范围**（见 §9.4）。

#### 3.6.3 模型如何用人话汇报

系统提示增加一条规则：

```
当工具结果的 meta.state 存在时，用 capability 的 states[].phrase 组织汇报；
有 meta.progress 时说明当前进度（如"正在传输 orders（3/8）"）；
不要自己编造状态名。
```

### 3.7 缺的工具与契约的关系

契约的 `tools: []` 允许"有功能、无工具"的中间态。这带来一个**明确的降级行为**：

| 契约 | 工具 | Agent 行为 |
|---|---|---|
| ✅ | ✅ | 直接调用，汇报状态 |
| ✅ | ❌ | **告知用户"这个功能在 工具箱 → X 里，我暂时不能直接操作"**，不编造 |
| ❌ | ✅ | 现状（工具存在但没有能力描述），Agent 只能靠工具 description 猜 |

第三种是当前 12 个模块之外的 40 个工具的状态。**本文不要求给全部 52 个工具都写契约**——契约只覆盖"工具箱功能"这一层。

## 4. 数据模型与接口

### 4.1 数据库

**无变更。** 契约是代码里的静态文件，不进数据库。

### 4.2 HTTP API

| 方法 | 路径 | 变更 |
|---|---|---|
| GET | `/capabilities` | **新增**：返回全部契约（脱敏，不含内部 hint 可选） |
| GET | `/capabilities/:id` | **新增**：返回单个契约 |

**为什么要这个 API**：UI 需要契约来渲染（M4），外部 MCP 客户端也可能需要知道产品有哪些功能。返回体就是 `Capability[]`，不需要额外包装。

### 4.3 事件协议

无变更。`progress` / `state` 走 `ToolResult.meta`，已包含在现有 `tool_result` 事件里（`runtime.ts` 的 `tool_result` 事件携带完整 `ToolResult`）。

## 5. 类型与校验

### 5.1 契约自身的校验（`assertCapabilities()`）

启动时执行，任何一条不合格就抛错（与 `assertCommandDefinitions()` 同风格）：

| # | 校验 |
|---|---|
| 1 | `id` 唯一且为 kebab-case |
| 2 | `title.zh` / `title.en` / `description` / `whenToUse` 非空 |
| 3 | `fields` 的 `key` 唯一且为 camelCase |
| 4 | `type: 'enum'` 必须有非空 `options` |
| 5 | `type: 'number'` 的 `min ≤ max`（若都给） |
| 6 | `type: 'code'` 必须有 `language` |
| 7 | `default` 的类型必须与 `type` 匹配 |
| 8 | `showWhen.field` 必须指向同表单内已存在的字段 |
| 9 | `tools` 里的每个名字必须存在于 `TOOL_NAMES`（`tools.ts:1027`） |
| 10 | `tools` 中工具的 `risk` 不得高于契约的 `maxRisk`（否则契约低估了风险） |
| 11 | `states` 必须至少有一个 `terminal: true` |
| 12 | `states[].phrase` 里的占位符 `{x}` 必须在 `fields` 里有对应 key（`{error}` / `{message}` 例外） |
| 13 | `route.path` 不得与另一个契约重复 |

校验 9 和 10 是**防漂移的关键**：契约写了 `tools: ['transfer_data']`，如果哪天这个工具被删或改风险，启动即失败。

### 5.2 与 `verify-docs.mjs` 的关系

新增文档契约检查：

| 检查 | 说明 |
|---|---|
| `docs/16-capability-contract.md` 存在 | `required` 数组 |
| 必需章节 | `['能力契约','字段类型','状态汇报','开发计划']` |
| 契约文件与本文示例一致 | 文档里出现的 `capability id` 必须在 `packages/core/src/capabilities/` 下有对应文件 |
| 12 个模块全覆盖 | `apps/desktop/src/components/tools/ToolsHub.tsx:33-46` 的 `TOOL_LIST` 条目数（12）= 契约文件数 |

> **注意**：不要用 `docs/02-feature-spec.md:156-172` 的表格行数做基准——那张表有 16 行，包含 SQL 片段 / SQL 文件 / 结果图表等**非工具箱模块**。真正的模块清单在 `ToolsHub.tsx` 的 `TOOL_LIST`。

## 6. 兼容与迁移

| 风险 | 处理 |
|---|---|
| 现有 15+ 个端点手写校验 | M3 只迁移 3 个高频端点（transfer / jobs / search）验证契约够用，其余保持 |
| 现有 UI 表单 | v1 不动；M4 挑 2 个试迁 |
| 现有 52 个工具 | 零改动（`meta.progress` / `meta.state` 是可选的） |
| `transfer_data` 的字段名（`sourceConnectionId`）与 REST（`sourceId`）不一致 | **契约以 Agent 工具的命名为准**（`sourceConnectionId`）；REST 端点在迁移时改名为一致，或加别名映射。**这是本次要修的实际缺陷** |
| `transfer_data` 缺 `limit` 字段 | 契约里声明 `limit`，工具 schema 补齐（`tools.ts:1017` 后加一项） |
| 12 个契约文件的维护成本 | 由 `assertCapabilities()` 的 13 条校验兜住；新增功能忘写契约时，`verify-docs` 的"覆盖检查"会失败 |

## 7. 开发计划

### M0 设计评审（本文）
- **交付**：`docs/16-capability-contract.md`。
- **验收**：人工评审通过；§3.2 的 schema 无遗漏；§3.3 / §3.4 两个示例可被未来实现直接使用。
- **工作量**：已完成。

### M1 core：类型、注册表、校验
- **文件**：
  - 新增 `packages/core/src/capabilities/types.ts`（§3.2 全部类型）
  - 新增 `packages/core/src/capabilities/index.ts`（`CAPABILITIES`、`getCapability()`、`listCapabilities()`）
  - 新增 `packages/core/src/capabilities/validate.ts`（`assertCapabilities()` 13 条 + `validateCapabilityInput()`）
  - 新增 12 个 `*.json` 契约文件
  - 改 `packages/core/src/index.ts` 导出
- **验收**：
  - `assertCapabilities()` 对 12 个契约全部通过；
  - 故意改坏一条（如 `tools: ['not_a_tool']`）能被校验 9 抓到；
  - 故意把 `maxRisk` 写成 `read` 但 `tools` 里有 `transfer_data`（write），能被校验 10 抓到；
  - core 单测新增 ≥ 20 例（§8）。
- **工作量**：1.5d（主要是 12 个 JSON 的填写）。

### M2 gateway：Agent 能力目录
- **文件**：
  - 改 `apps/gateway/src/agentHost.ts`：新增 `capabilityPromptBlock()`，在 `:385` 之后按功能开关注入
  - 改 `apps/gateway/src/routes.ts`：新增 `GET /capabilities`、`GET /capabilities/:id`
  - 改 `packages/core/src/agent/types.ts:24`：`ToolResult.meta` 加 `progress` / `state`
- **验收**：
  - 系统提示里能看到 12 条能力，格式与 §3.5.1 一致；
  - token 增量 ≤ 1.6k（用现有 token 估算函数量）；
  - `GET /capabilities` 返回 12 条。
- **工作量**：0.5d。

### M3 端点校验迁移（3 个试点）
- **文件**：
  - `apps/gateway/src/features/routes.ts:223`（transfer）、`:452`（jobs）、`:157`（search）
  - 每个端点改为 `validateCapabilityInput()` + 转现有执行函数入参
- **验收**：
  - 三个端点的错误信息格式统一（`{field, message}`）；
  - 现有集成测试全绿（`apps/gateway/test/` 里与这三条相关的用例）；
  - 参数名与契约一致（`sourceId` → `sourceConnectionId`，**需要同步改 UI 调用方**）。
- **工作量**：1d。

### M4 UI 试迁（2 个模块）
- **文件**：
  - 新增 `apps/desktop/src/components/tools/CapabilityForm.tsx`（按 `fields` 渲染）
  - 迁 `SearchTool.tsx`（3 个字段，最简单）与 `GeneratorTool.tsx`（108 行，中等）
- **验收**：
  - 两个模块的表单由契约渲染，字段数、默认值、必填标记与原手写一致；
  - E2E 里这两个模块的操作流程不变。
- **工作量**：1.5d。

### M5 状态汇报落地
- **文件**：
  - `apps/gateway/src/executor.ts:1318`（`transfer_data`）：传 `onEvent`，把最后一个事件写进 `meta.progress`，终态写 `meta.state`
  - `packages/core/src/agent/prompt.ts`：加 §3.6.3 的汇报规则
- **验收**：
  - `transfer_data` 返回体含 `meta.state`（`ok`/`partial`/`failed`）与 `meta.progress`；
  - 模型在对话里能说出"已传输 N 张表、M 行"（来自 `states[].phrase`）。
- **工作量**：0.5d。

### M6 验证与文档同步
- **执行**：`npm run verify` 全绿。
- **文档同步清单**：
  | 文件 | 改动 |
  |---|---|
  | `docs/16-capability-contract.md` | 状态改"已实施"，补偏差 |
  | `docs/02-feature-spec.md` | 工具箱表格补"契约文件"列 |
  | `docs/04-ai-agent-design.md` | §4 补"能力目录"段落 |
  | `docs/05-data-and-api.md` | 补 `GET /capabilities` |
  | `scripts/verify-docs.mjs` | `required` 加本文；新增契约覆盖检查 |
  | `README.md` | 工具箱章节补"能力契约"一句 |
- **工作量**：0.5d。

**总工作量：约 5.5 人日。**

### 7.1 里程碑依赖

```
M0（本文）──► M1（core 类型+12 契约）──► M2（Agent 目录）──► M5（状态汇报）
                                        └──► M3（端点校验 3 个试点）──► M4（UI 试迁 2 个）
                                                                        │
                                                                        └──► M6（验证+文档）
```

M1 是硬前置；M3 与 M4 可以并行；M5 只依赖 M2。

## 8. 测试计划

### 8.1 单元（`packages/core/test/capabilities.test.ts`，新增）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 12 个契约全部通过 `assertCapabilities()` | 无抛错 |
| 2 | `id` 重复 | 抛错 |
| 3 | `enum` 缺 `options` | 抛错 |
| 4 | `code` 缺 `language` | 抛错 |
| 5 | `default` 类型不匹配 | 抛错 |
| 6 | `showWhen.field` 指向不存在字段 | 抛错 |
| 7 | `tools` 里有不存在的工具 | 抛错，消息含工具名 |
| 8 | `tools` 里工具风险 > `maxRisk` | 抛错 |
| 9 | `states` 无 `terminal` | 抛错 |
| 10 | `phrase` 占位符无对应字段 | 抛错 |
| 11 | `validateCapabilityInput` 必填缺失 | `ok: false`，`errors[0].field` 正确 |
| 12 | `validateCapabilityInput` 枚举越界 | `ok: false` |
| 13 | `validateCapabilityInput` 数字超 `max` | `ok: false` |
| 14 | `validateCapabilityInput` 默认值填充 | 未传的 `mode` 返回 `'append'` |
| 15 | `validateCapabilityInput` 布尔默认 | 未传的 `createMissing` 返回 `true` |
| 16 | `validateCapabilityInput` 未知字段 | 被忽略（不报错，保持兼容） |
| 17 | `showWhen` 字段未满足时 | `required` 不生效（如 `type=backup` 时 `sql` 不要求） |
| 18 | `getCapability('transfer')` | 返回正确对象 |
| 19 | `listCapabilities()` | 返回 12 条，顺序稳定 |
| 20 | 12 个契约的 `route.path` 互不重复 | 无重复 |

### 8.2 集成（`apps/gateway/test/capability-contract.test.ts`，新增）

| # | 用例 | 断言 |
|---|---|---|
| 21 | 系统提示含能力目录 | 含 `## Capabilities` 与 12 条 |
| 22 | 提示含"不要假装能执行" | 正则匹配 |
| 23 | `GET /capabilities` | 200，12 条 |
| 24 | `GET /capabilities/transfer` | 200，`tools` 含 `transfer_data` |
| 25 | `POST /transfer` 缺 `targetConnectionId` | 400，错误含字段名 |
| 26 | `POST /transfer` 非法 `mode` | 400 |
| 27 | `POST /transfer` 正常 | 200，行为与改造前一致 |
| 28 | `transfer_data` 工具返回含 `meta.state` | `'ok'` |
| 29 | `transfer_data` 部分表失败 | `meta.state === 'partial'` |
| 30 | 契约 `tools: []` 的功能 | 提示里显示"guide the user to 工具箱" |

### 8.3 E2E（`scripts/e2e.mjs` 扩展）

| # | 用例 |
|---|---|
| 31 | 工具箱「数据库搜索」表单由契约渲染，字段与原来一致 |
| 32 | 工具箱「数据生成」表单由契约渲染，默认值正确 |
| 33 | Agent 对话里说"帮我传数据到 B 库"，模型调用 `transfer_data` 而非编造 REST |
| 34 | Agent 对话里说"每天 3 点跑这个 SQL"，模型提示去 工具箱 → 自动化任务（当前无工具） |

### 8.4 回归门槛

- `npm run verify:docs` 全绿（含新增文档与契约覆盖检查）
- `npm run typecheck` 全绿
- `npm test`：core 153 + 新增 ≥ 20；gateway 188 + 新增 ≥ 10

> 基线取自 `docs/11-command-workflows.md:51`；实施时以当次 `npm test` 输出为准。

## 9. 取舍与已知限制

### 9.1 为什么契约放 core 而不是 gateway

三个消费方分属三个 workspace：core（Agent 提示拼装）、gateway（端点校验）、desktop（表单渲染）。放 `packages/core` 是唯一都能 import 的位置，且 core 没有 Node/Electron 依赖，不会引入循环。

### 9.2 缺的 9 个工具是独立事项

契约的 `tools: []` 让 Agent 至少能正确地说"这个功能在 UI 里"。但要让 Agent 真正能操作，还需要补工具：

| 功能 | 缺的工具 | 风险 |
|---|---|---|
| 数据库搜索（数据全文） | `search_data` | read |
| 结构同步执行 | `sync_schema` | ddl |
| 数据对比 | `compare_data` | read |
| 服务器监控 | `monitor_connection` | read |
| 终止会话 | `kill_session` | destructive |
| 自动化任务 | `manage_job` | dynamic |
| 用户与权限 | `list_users`（只读部分） | read |
| 数据字典 | `build_dictionary` | read |
| 高级对象 | `list_advanced_objects` | read |

这些工具的新增会触发工具数量契约（`scripts/verify-docs.mjs` 的 `expectedTools` 与 `names.length === 52`）与 `docs/04` 工具表、`toolGroups.ts` 分组三处同步。**建议单独一批做，不要和契约混在一个 PR。**

### 9.3 能力目录的 token 成本

12 条 ≈ 1.4k token，常量开销。若后续功能增长到 30+，需要考虑：

- 按当前连接/库裁剪（只列相关的功能）
- 分两级：提示里只放 `id + title + description`（约 30 token/条），细节靠 `GET /capabilities/:id` 或新工具 `capability_read`
- 与命令作用域联动（`15-command-scoping.md` 的 `scopeGroups`）

**v1 不做**，因为 1.4k 在可接受范围。

### 9.4 真流式进度不在 v1

§3.6.2 的 `meta.progress` 是**执行结束后的快照**，不是流式。真正的流式需要 `runtime.ts` 的工具执行循环支持 `onProgress` 回调并转成 SSE 事件，属于较大的运行时改动。

**当前价值**：即便只是快照，模型也能说"已传输 8 张表、共 3 万行"，比现在的"传输完成"更有信息量。

### 9.5 脚本字段的边界（再次明确）

契约的 `type: 'code'` 只声明"这里填一段代码、什么语言、入参出参是什么"。**契约层不执行、不沙箱、不校验语法。**

若未来"上下游处理"的转换脚本需要在服务端执行，那是**该功能的执行器**要解决的问题（沙箱、超时、资源限制、网络策略），与本文无关。`docs/13-skill-host-plan.md:165` 已记录 `permissions.network` 目前只作声明、未做系统级隔离——**这是脚本执行功能落地前必须先解决的独立问题**。

### 9.6 不做的

- 不给 52 个 Agent 工具都写契约（契约只覆盖工具箱功能层）。
- 不让契约驱动权限（权限仍是 `policy.ts`，契约的 `maxRisk` 只用于校验自洽性）。
- 不做契约的运行时热加载（启动时读一次）。
- 不做多语言契约内容（`label` 只有 zh/en，与现有 `CommandDefinition` 一致）。

## 10. 后续阶段（本文只定义边界）

### 10.1 工具补齐批（见 §9.2）
契约先落地，工具随后补。补工具时只改 `capability.tools` 数组，契约结构不变。

### 10.2 定时任务（独立文档）
`jobs` 的契约（§3.4）已经预留了 `notifyChannels` 字段与"保存后与对话无关"的约束描述。定时任务的时间模型（`next_run_at`、时区、`HH:MM`）是独立设计，不在本文。

### 10.3 新功能接入流程（本文的直接收益）

新增一个功能（例如"上下游数据处理"）的完整步骤：

1. 写 `packages/core/src/capabilities/upstream-sync.json`（字段、状态、流程）
2. 写执行函数（`apps/gateway/src/features/upstreamSync.ts`）
3. 加 REST 端点（用 `validateCapabilityInput` 校验）
4. 若要让 Agent 能调：加 `ToolDefinition` 到 `tools.ts` + 在契约的 `tools` 里登记 + 补 `executor.ts` 分支
5. 若该功能有 `code` 字段（脚本）：**由执行函数自己决定怎么处理**，契约不管

**第 1 步产出物直接让 Agent 知道新功能存在**，不需要改提示词代码。

## 11. 变更记录

- v1.0（2026-11-01）：初版。定义 Capability Contract 的 schema（11 种字段类型、13 条自检）、12 个模块的契约清单、三消费方（Agent/校验/UI）用法、`ToolResult.meta` 扩展（`progress`/`state`）、M0–M6 计划（约 5.5 人日）、20+10+4 条测试。明确边界：契约不认识"执行脚本"，脚本只是某功能的字段值。
- v1.1（2026-11-01）：M1 / M2 / M5 / M6 实施完成；补 §12 实施记录与偏差。
- v1.2（2026-11-01）：M3 落地（`POST /transfer`、`POST /jobs` 改由契约校验，新增 `legacyKey` 兼容旧字段名）；补 §12.2 第 4 条偏差与 §12.4 遗留。
- v1.3（2026-11-01）：M4 落地（`CapabilityForm.tsx` 契约驱动表单渲染器，Generator / Dictionary 两个模块改由契约渲染）；M1–M6 全部实施。
- v1.4（2026-11-01）：M3 扩展——`/generate`、`/dictionary`、`/schema/sync` 三个端点接入契约校验（端点总数 2 → 5），`/schema/sync` 增加 `string[]` → DDL 文本的形状归一；补 §12.2 第 5 条偏差。同时修掉 E2E 里硬编码「11 个搜索后端」的脆弱断言。
- v1.5（2026-11-01）：M3 收尾——`/data/compare`、`/search`、`/users/action`、`/monitor`、`/objects` 五个端点接入契约，**12 个工具箱模块对应的 10 个端点全部迁移完成**（`/schema/compare` 是 `schema_diff` 的 REST 包装，无独立契约）；`/users/action` 的 `list` 动作复用只读实现。端点测试 25 → 36 例。
- v1.6（2026-11-01）：M4 扩展——`MonitorTool`、`AdvancedObjectsTool`、`SearchTool` 三个模块迁移到契约渲染，累计 5 个；补 §12.5 记录「无法由 `CapabilityForm` 渲染的模块」及其结构性障碍（引擎相关的字段联动、两阶段流程、树形编辑）。
- v1.7（2026-11-01）：**设置 → MCP 与工具**新增只读的「功能能力目录」面板，让 12 个工具箱契约在 UI 可见（此前只有 API 与提示词可见）。同时修掉 E2E 里两个选择器缺陷：`agent tool catalog` 的断言用 `.settings-content .agent-catalog-row` 全局选择，新增目录后行数被算成 64；改为限定在各自 `data-testid` 容器内。E2E 201 → 205。
- v2.2（2026-11-01）：新增 §12.8「端点字段漂移守卫」——`verify-docs.mjs` 解析 `features/routes.ts` 中每个 `capabilityBody` 调用所在端点，把它实际读取的 `input.*` 与契约声明做双向比对，抓出「端点读了未声明字段」与「契约声明但端点未读」两类静默漂移（各故意制造一次验证过守卫有效）。docs 契约 372 → 382。
- v2.1（2026-11-01）：`/transfer/stream` 接入 `transfer` 契约，消除它与 `/transfer` 的两套校验（`limit` 归一化曾经不一致）；校验放在 `writeHead()` 之前，保证入参错误返回 400 JSON 而非流内错误事件。端点测试 36 → 39 例。设置页排版调整：MCP 页把「新增 MCP Server」移到最上方并默认展开、Agent 工具目录默认展开，E2E 补 3 条布局断言。
- v2.0（2026-11-01）：把 §12.6 提到的「隐式约定」落成明文 §12.7「渲染契约」（7 条约定 + 服务端/渲染器共用有效取值 + 新模块迁移清单）。新增 core 导出 `applyCapabilityDefaults()`，5 个已迁移模块的重复默认值循环收敛为它；修掉 `TableField` 的库名推导（原先 `table` → 空串、`sourceTable` → `source`，现在正确产出 `database` / `sourceDatabase`）。core 单测新增 5 例断言「渲染器与服务端对同一取值结论一致」。
- v1.9（2026-11-01）：把 v1.7 的临时面板升级为**独立的「设置 → 功能能力」页**（导航在「能力扩展」组），并支持明细：逐条展开查看流程 / 字段表 / 状态机 / 限制，另有「展开全部字段」、多维过滤与空状态。原 MCP 页的临时面板已删除。同时**补齐 E2E 对工具箱面板的覆盖**（此前完全没有）：5 个迁移面板逐个确认表单已渲染，数据生成面板额外校验「表自动选中、按钮可点、无 label-only 空字段」——这三条正是 §12.6 的回归点。E2E 205 → 220。
- v1.8（2026-11-01）：修复 M4 迁移引入的 4 个 UI 回归，见 §12.6。

## 12. 实施记录（v1.1）

### 12.1 已交付

| 里程碑 | 交付物 | 验证 |
|---|---|---|
| M1 | `packages/core/src/capabilities/{types,validate,index}.ts` + 12 个 `*.json` + `packages/core/test/capabilities.test.ts`（28 例） | core 181 例全绿 |
| M2 | `apps/gateway/src/agentHost.ts` 的 `capabilityPromptBlock()`（1,766 字符）+ `GET /capabilities` / `GET /capabilities/:id` + `ToolResult.meta` 扩展 `progress`/`state` | `apps/gateway/test/capability-contract.test.ts`（12 例） |
| M5 | `executor.ts` 的 `transfer_data` 分支：`onEvent` 收集进度、`meta.state` 三态（ok/partial/failed）、补 `limit` 参数 | 同上 |
| M3 | `features/routes.ts` 新增 `capabilityBody()`；**8 个端点**改由契约校验（`INVALID_INPUT` + `field`）：`POST /transfer`、`POST /jobs`、`POST /generate`、`POST /schema/sync`、`POST /data/compare`、`POST /search`、`POST /users/action`、`GET /dictionary` / `GET /monitor` / `GET /objects`（后三者走 query）；`legacyKey` 支持旧字段名；`/schema/sync` 把 `string[]` 归一成 DDL 文本；`/users/action` 的 `list` 动作复用只读实现 | `apps/gateway/test/capability-endpoints.test.ts`（36 例） |
| M4 | `apps/desktop/src/components/tools/CapabilityForm.tsx`（契约驱动的表单渲染器，覆盖 connection/database/table/tables/enum/boolean/number/code/text 9 种类型）；**5 个模块**改由契约渲染：`GeneratorTool`、`DictionaryTool`、`MonitorTool`、`AdvancedObjectsTool`、`SearchTool` | desktop typecheck + 全量 build + E2E 205/205 |
| M6 | `scripts/verify-docs.mjs` 新增 4 组契约检查（文档存在、章节、模块覆盖、自检、文档覆盖）；`docs/02/04/05`、`README.md` 同步 | docs 契约 372/372 |
| M2+ | **独立设置页「设置 → 功能能力」**（`apps/desktop/src/components/tools/CapabilitiesTool.tsx`，导航项在「能力扩展」组）：12 个功能卡片，支持逐条展开查看**流程 / 字段表（字段·类型·必填·默认与约束·说明）/ 状态机 / 限制**、「展开全部字段」一键全开、按 id/标题/说明/字段名/工具名过滤、空状态；顶部统计「N 个功能 · N 个字段 · N 个有工具」。纯只读，唯一交互是展开与过滤 | E2E 新增 10 条断言 |
| M6+ | `scripts/verify-docs.mjs` 新增**端点字段漂移守卫**（详见 §12.8）：解析 `features/routes.ts` 中每个 `capabilityBody('<id>')` 所在端点，提取实际读取的 `input.*` 字段，与契约声明做**双向**比对 | docs 契约 372 → 382（+10） |

### 12.2 与设计的五处偏差

1. **`assertCapabilities(capabilities, tools)` 改为必传 `tools`**（原设计默认 `TOOLS`）。
   原因：`scripts/verify-docs.mjs` 用纯 Node 动态 import TS 校验契约，而 `validate.ts` 若在运行时 import `../agent/tools`（无扩展名）会触发 `ERR_MODULE_NOT_FOUND`。让调用方注入后，契约模块对工具表零运行时依赖，verify-docs 与单测都能直接加载。

2. **能力目录采用两级写法**（原设计每功能 5 行）。
   原方案 12 条共 3,291 字符，超出 §9.3 的 1.4k token 预算。改为：有工具的给「id/标题/描述 + Call + States + 最多 2 条 Limits」，无工具的压成单行「标题（id）：描述 → 引导用户到工具箱」。实际 1,766 字符（约 1.2k token），并有测试守住 ≤ 2000。

3. **`phrase` 占位符校验放宽为「字段 + 约定结果 token」**。
   状态话术描述的是执行结果（`{rows}`、`{tables}`、`{error}`、`{current}`），这些不是表单字段。`validate.ts` 用 `PHRASE_RESULT_TOKENS` 白名单区分：命中字段或命中白名单即通过，其余报错。

4. **字段新增 `legacyKey`，解决参数名不统一的迁移问题**（原计划「改名为一致」）。
   `transfer` 契约用 `sourceConnectionId`（对齐工具），但 `/transfer` 端点的历史调用方（`DataCompareTool.tsx:39`）传的是 `sourceId`。硬改名字会同时打破 UI 与 E2E。改为：契约声明规范名 + `legacyKey`，校验时先读规范名再回退旧名，**两侧同时可用**；端点内部只认归一化后的规范名。旧名在 M3 完成全部迁移后删除。

5. **`/schema/sync` 在进契约前做一次形状归一**（原设计假设端点参数与契约字段一一对应）。
   契约把 `statements` 声明为 `code`（一段 DDL 文本，对 Agent 最自然），但 `SchemaCompareTool.tsx:63` 传的是 `string[]`。为同时兼容两者，端点先把数组 `join(';\n')` 成文本再交给契约，校验通过后再按分号拆回语句数组。这也让 Agent 侧「给一段 DDL」与 UI 侧「给语句列表」共用同一份契约。

### 12.3 未实施（留待后续）

| 项 | 原因 |
|---|---|
| M3 剩余端点迁移（table-options / replace / databases-ops / tables-ops / schema 对比 / backups 等） | 12 个工具箱模块对应的端点已全部接入契约（10 个；`/schema/compare` 是 `schema_diff` 的 REST 包装，字段与工具一致，无独立契约）。剩余端点属于「工作台」而非「工具箱」，没有契约可依；等它们将来有契约时再迁移 |
| M4 剩余模块迁移（7 个） | `CapabilityForm` 已迁移 5 个模块（Generator / Dictionary / Monitor / AdvancedObjects / Search 待定），剩余模块各有结构性障碍，见 §12.5 |
| 脚本字段（`type: 'code'`）的执行 | 按 §9.5 边界，属各功能执行器职责；`docs/13-skill-host-plan.md:165` 的网络隔离问题未解决前不开放 |

### 12.5 无法由 `CapabilityForm` 渲染的模块（结构化障碍）

不是「还没做」，而是**当前 schema 表达不了**，强行迁移会让 UI 行为退化：

| 模块 | 障碍 | 结论 |
|---|---|---|
| `UsersTool` | `role` / `privileges` 二选一取决于**连接引擎**（MySQL 用 privileges+scope，PostgreSQL 用 role），而 `showWhen` 只能表达「字段值等于某常量」，无法表达「依赖另一个字段背后的实体属性」 | 保持手写。若要迁移，schema 需扩展 `showWhen.engine` 或引入 `dependsOn: 'connection.engine'` |
| `TransferTool`（696 行） | 依赖 `useDatabaseTables` 的懒加载 + 逐表勾选 + SSE 逐表进度 + 断开即停，字段之外的交互占主导 | 保持手写；契约已覆盖后端，UI 层收益低 |
| `SchemaCompareTool` 的 diff 预览 | 先调 `/schema/compare` 拿 diff，再决定是否执行同步——是**两阶段流程**，不是「填表 → 提交」 | 保持手写 |
| `QueryBuilderTool` | 纯前端拼 SQL，无端点、无契约 | 无需迁移 |
| `AgentContextTool`（522 行） | 表 / 列两级启停 + 别名 + 关系编辑，是树形编辑而非平铺表单 | 保持手写 |
| `DataCompareTool` / `JobsTool` | 已有自定义行内布局（逐表结果、任务列表带操作按钮），字段只占很小一部分 | 保持手写 |

### 12.4 已知遗留

- `transfer_data` 的 `meta.progress` 是**执行结束后的快照**，不是流式（§9.4）。真正的流式进度需要 `runtime.ts` 的工具循环支持 `onProgress`。
- 契约的 `route.path` 与 REST 端点仍是**两处声明**（契约里写 `POST /transfer`，端点定义在 `features/routes.ts`）。已迁移的端点通过 `capabilityBody('<id>')` 反向引用契约做校验，但路由声明本身仍在两处。
- `compare-data` 契约的字段名用 `sourceId`/`targetId`（对齐现有 REST），而 `transfer` 用 `sourceConnectionId`（对齐现有工具）。两者不统一是**现状缺陷的如实记录**；`legacyKey` 让它们互相兼容，但字段名本身待后续统一。
- ~~`/transfer/stream`（SSE 端点）仍走手写校验，未接契约~~ —— **v2.1 已修**。它与 `/transfer` 入参完全相同，两套校验必然漂（`limit` 的归一化就曾经不一致：`Number(...) || undefined` vs `typeof === 'number'`）。现在共用 `capabilityBody('transfer')`，且校验放在 `res.writeHead()` **之前**——否则 400 会被塞进 SSE 流变成错误事件，调用方拿不到正确的 HTTP 状态。

### 12.6 M4 迁移引入的 UI 回归与修复（v1.8）

这 4 个问题全部由「把表单交给 `CapabilityForm` 渲染」引入，且**自动测试全部通过却一个都没抓到**——E2E 从未覆盖工具箱面板（无 `generate-` / `monitor-` / `objects-` / `dictionary-` 断言）。靠启动 gateway + 浏览器逐面板截图才暴露。

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | **数据生成面板完全不可用**：表下拉为空、按钮全禁用 | `CapabilityForm` 用 `allowAll={!field.required}`，把「是否必填」当成「是否允许空」。`generate.database` 无 `required`，于是 `allowAll=true`；`DatabaseSelect` 在 `allowAll` 时**跳过自动选中默认库**，`database` 恒为空 | 新增 `CapabilityField.allowAll`（仅 `type=database` 有效），不再从 `required` 推导；校验器加约束「`allowAll` 不能与 `required` 并存」 |
| 2 | 表不会自动选中第一张 | 原版 `GeneratorTool` 有 `useEffect` 自动选中 `tables[0]`，重写时丢失 | 补回该 effect |
| 3 | 表单竖向堆叠、按钮换行 | `.capability-form` 是新造的 class 但 `tools.css` 从未定义，退化成 block 布局 | 加 `display: contents`，让 `.field` 直接成为外层 `.tool-row` 的 flex 子项 |
| 4 | 单库引擎留下只有标签的空字段 | `DatabaseSelect` 在 `options.length <= 1` 时返回 `null`，留下空外壳 | 库数 ≤1 时外壳 `display:none`，但**仍挂载** `DatabaseSelect`（自动选中默认库的副作用在组件内部，卸载会让表选择器永远为空） |

另有一个逻辑缺陷：**搜索面板关键词输入框位置错乱**。`query` 字段被渲染成普通 `<input>`，而原版是定制的 `.search-box`（放大镜图标 + 自动聚焦 + 回车触发）。修复：`CapabilityForm` 新增 `omit?: string[]`，调用方声明「这个字段的控件我自己提供」。

**结论性教训**：契约与表单渲染之间有一层**隐式约定**（谁负责自动选中默认值、空控件该不该渲染、哪些字段被调用方自建），这些都不在类型系统里。`CapabilityForm` 的 props 现在是 6 个，已接近需要一份「渲染契约」文档的临界点；若继续迁移剩余模块，应先把这层约定写清楚。

### 12.7 渲染契约（v2.0）

§12.6 结尾提到的「隐式约定」在这里落成明文。**迁移任何新模块前先读这一节**——违反其中任意一条都不会报错，只会静默出错。

#### 12.7.1 七条约定

| # | 约定 | 违反后的症状 |
|---|---|---|
| 1 | **默认值归调用方。** `CapabilityForm` 不会把 `field.default` 写回 `values`。初始化状态必须用 `applyCapabilityDefaults(capability, extra?)`（`packages/core/src/capabilities/validate.ts`） | `showWhen` 依赖默认值的字段被判成隐藏，但提交时服务端报「必填」——用户看到的是「明明要我必填，却没有输入框」 |
| 2 | **`showWhen` 只看 `values`。** 渲染器不替调用方补默认值再判断可见性 | 同上（约定 1 的下游后果） |
| 3 | **传了 `connectionId` 就不渲染 `connection` 字段。** 调用方若把连接固定为当前连接，`values` 里可以没有该字段；`database` / `table` 会回退到该 prop | 用户能改到一个本该固定的连接，或字段名永远填不上 |
| 4 | **`database` 控件可能是空盒子。** `DatabaseSelect` 在库数 ≤1 时返回 `null`；渲染器保留挂载、只隐藏外壳 | 卸载它 → 自动选中默认库的副作用不再执行 → 依赖它的 `table` 选择器**永远为空** |
| 5 | **`table` / `tables` 依赖同表单的 `database` 取值。** 命名约定：`table`/`tables` → `database`，`sourceTable` → `sourceDatabase` | 表下拉为空且不可用 |
| 6 | **`omit` 表示「调用方自建控件」。** 该字段仍参与 `values`，只是不渲染；调用方自建的控件必须与契约语义一致 | 字段重复渲染，或自建控件与契约的必填/枚举语义不一致 |
| 7 | **渲染器不改 `values` 的形状**，只通过 `onChange(key, value)` 通知 | 调用方拿到的对象与契约字段对不上 |

#### 12.7.2 服务端与渲染器必须共用「有效取值」

这是最容易踩的一条，已在 v2.0 修掉：

```
服务端 validateCapabilityInput()：先 apply 默认值 → 再判断 showWhen → 再校验
UI 渲染器 visible()：           只看原始 values → 判断 showWhen
```

两者对**未补默认值的输入**会给出不同结论。实测（`jobs` 契约的 `sql` 字段，依赖 `type === 'query'`）：

| 场景 | 渲染器结论 | 服务端结论 |
|---|---|---|
| `{}`（未补默认值） | `sql` **隐藏** | `sql` **必填** → 报错 |
| `applyCapabilityDefaults(jobs)` | `sql` **显示** | `sql` **必填** → 一致 ✓ |

修复方式不是让渲染器自己补默认值（那会让 `values` 与 `field.default` 两个真相源并存），而是**把补默认值这件事收敛成一个 core 导出函数**，渲染器与调用方共用：

```ts
// packages/core/src/capabilities/validate.ts
export function applyCapabilityDefaults(
  capability: Capability,
  values: Record<string, unknown> = {},
): Record<string, unknown>   // 返回新对象，不修改入参
```

5 个已迁移模块（Generator / Dictionary / Monitor / AdvancedObjects / Search）原本各写了一遍默认值循环，现已全部改为调用它。单测（`packages/core/test/capabilities.test.ts`）断言了「渲染器可见性」与「服务端校验」对同一份取值结论一致。

#### 12.7.3 新增模块的迁移清单

```
1. 契约里有 default 的字段 → 调用方用 applyCapabilityDefaults(capability, { ...固定值 })
2. 固定当前连接 → 传 connectionId prop，别在 values 里重复设置
3. 有自定义控件 → 用 omit: ['fieldKey']，并保证语义与契约一致
4. 有「默认选中第一项」这类 UI 便利 → 在模块里自己写 useEffect（契约只声明「有这个字段」，
   不声明「默认选哪个」；见 §12.6 回归 #2）
5. 跑 E2E 的面板检查（scripts/e2e.mjs 的 migratedPanels 数组），确保表单真的渲染出来
```

第 4 条是刻意保留的分工：**契约声明字段，模块决定交互便利**。把「默认选第一张表」写进契约会让契约承担 UI 职责，而它对 Agent 调用方毫无意义。

### 12.8 端点字段漂移守卫（v2.2）

`capabilityBody('<id>')` 让端点与契约在**校验**上绑定了，但绑定的是「类型与必填」，不是「字段集合」。下面两类漂移仍然能静默通过全部测试：

| 漂移 | 后果 |
|---|---|
| 端点读了契约**没声明**的字段（`input.foo`） | `foo` 永远不会被契约校验——`validateCapabilityInput` 只校验声明过的字段，所以它恒为 `undefined` 或原始值，没有类型/范围/必填保护 |
| 契约**声明**了端点不读的字段 | 白声明。更糟的是它会出现在 Agent 能力提示词里，模型照着填，但服务端根本不看，用户以为生效了 |

这类漂移不会报错、不会让测试变红，只能靠人读代码。`scripts/verify-docs.mjs` 现在每轮检查：

```
1. 找出 routes.ts 里所有 `const input = capabilityBody('<id>', ...)`
2. 按 router. 边界切出该端点所在的代码块
3. 正则提取块内出现的全部 `input.<key>`
4. 与 getCapability(id).fields 的 key 集合做双向差集
5. 任一方向非空 → 失败，并打印具体字段名
```

几个实现要点：

- **按 `router.` 切块，不按调用顺序切**。`/transfer` 与 `/transfer/stream` 共用 `transfer` 契约，如果按「下一个 capabilityBody」切，两块会互相串；按路由边界切才对，且同一契约在多处使用时读取的字段取**并集**。
- **不做跨文件分析**。端点若把 `input` 透传给别的函数（如 `transferData(..., { sourceDatabase: input.sourceDatabase })`），`input.x` 仍出现在本块内，所以能抓到；但如果有人先 `const { database } = input` 再解构使用，守卫会漏。这属于已知局限，代价是换取脚本足够简单可懂。

验证过守卫本身有效（故意制造两类漂移各一次，都被准确报出字段名）：

```
✗ endpoint monitor fields match its contract — 端点读了未声明字段: notARealField
✗ endpoint dictionary fields match its contract — 契约声明但端点未读: database
```
