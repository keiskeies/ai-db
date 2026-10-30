# AiDB Studio — 机器人通知、Inbound 问答与 MCP 插件

> 版本：v1.1 · 日期：2026-10-30 · 状态：**7 平台出站完成；飞书/OneBot inbound 已实现**
> 关联：[命令化 Agent 工作流](./11-command-workflows.md) · [AI Agent 设计](./04-ai-agent-design.md) · [数据模型与协议](./05-data-and-api.md)

## 0. 范围

出站覆盖 7 个平台：飞书、企业微信、钉钉、Slack、Discord、Telegram、QQ（OneBot）。

三步一起落地：

1. **Outbound**：定时报告 / 产物完成后推送到飞书、企业微信、QQ（OneBot HTTP）、钉钉、Slack、Discord、Telegram。
2. **Inbound**：飞书事件回调与 OneBot 消息事件触发只读 Agent 问答，原路回复。
3. **MCP 插件**：用户配置 stdio MCP Server，Agent 通过 `mcp_list_tools` / `mcp_call` 使用外部工具（如飞书 OpenAPI MCP）。

企业微信群机器人只支持 outbound；inbound 需要企业应用回调，暂未开放。个人微信没有官方机器人 API，不做支持。

## 1. 数据模型

新增两张表（`user_version = 6`）：

```sql
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_secret TEXT NOT NULL, summary TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL,
  args_json TEXT, env_secret TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

- 渠道配置（webhook、签名密钥、appSecret、OneBot token、inbound 白名单与绑定连接）整体用 `SecretBox` AES-256-GCM 加密，列表 API 只返回脱敏 `summary`。
- `artifact_schedules.notify_channels` 保存渠道 id 数组；定时运行完成后发送通知。
- MCP 的环境变量单独加密，进程启动时与 `process.env` 合并，不返回给前端。

## 2. Outbound

### 2.1 渠道配置

| 类型 | 配置 | 发送 |
|---|---|---|
| `feishu` | `webhookUrl`、可选 `secret` | 文本消息；有 secret 时按 `timestamp + "\n" + secret` 做 HmacSHA256 + Base64 签名 |
| `wecom` | `webhookUrl` | `msgtype=markdown` |
| `qq-onebot` | `endpoint`、`token?`、`targetType=group/private`、`targetId` | `POST /send_group_msg` 或 `/send_private_msg` |
| `dingtalk` | `webhookUrl`、可选 `secret` | `markdown` 消息；secret 时按钉钉规则追加 `timestamp` + `sign` |
| `slack` | `webhookUrl` | `{ text }` |
| `discord` | `webhookUrl` | `{ content }`，按 1900 字符截断 |
| `telegram` | `botToken`、`chatId`、可选 `apiBase` | `sendMessage`；支持自托管 Bot API |

发送超时 10 秒；返回非 0 `code` / `errcode` / OneBot `failed` 视为失败。每次发送写 `audit_log`（`notification.send`）。

### 2.2 定时报告

`artifact_schedules.notify_channels` 绑定多个渠道。调度器执行完产物后：

1. 根据产物类型生成摘要：报告/对比提取章节指标，diff/recon/fix 提取汇总；
2. 逐渠道发送；
3. 单个渠道失败不影响其他渠道，也不改变定时任务本身的执行状态；
4. 失败原因写入审计，UI 可重新测试。

报告标题优先使用 ReportSpec 的 `title`（用户主题），而不是产物默认标题。

### 2.3 UI

设置 → 通知：

- 选平台（飞书 / 企微 / 钉钉 / Slack / Discord / Telegram / QQ OneBot）→ 填 Webhook（QQ 填 HTTP endpoint、目标群号）→「保存并发送测试」；
- 飞书签名密钥直接显示；飞书应用凭据与 inbound 白名单收在“高级”折叠项里；
- 已配置列表每个渠道有 `ON/OFF` 和启用/停用、测试、删除；
- 产物命令面板的定时设置中勾选通知渠道。

> 飞书 / 企微 / 钉钉 / Slack / Discord / Telegram / QQ 是 AiDB 的原生通知渠道，**不需要安装 MCP**；MCP 用于接入任意外部工具，把它们包成 MCP 只会多一层进程与凭据。
>
> 仍需一次性 Webhook 的原因：Webhook / 机器人身份由用户所在飞书、企微、QQ 群生成。AiDB 是本地/自托管工具，不能代替用户在平台上注册机器人；其他“打开开关就能用”的软件通常自带官方机器人或托管 OAuth 应用。保存后日常使用就只剩开关。

## 3. Inbound

### 3.1 入口

`POST /api/bots/:channelId/events`，公开路由但按渠道配置校验：

| 平台 | 校验 | 事件 |
|---|---|---|
| 飞书 | `verificationToken` 匹配 | `url_verification` challenge；`im.message.receive_v1` 文本消息 |
| OneBot | `Authorization: Bearer <token>`（配置了 token 时） | `post_type=message`，群/私聊 |
| 企业微信 | 暂不支持 inbound | — |

白名单 `allowedChats` 为空表示允许所有会话；建议配置具体 chat_id / `group:123`。飞书忽略 `sender_type=app/bot`，OneBot 忽略 `self_id`，避免机器人互相回复。

### 3.2 只读 Agent

- 每条消息创建独立 Agent 会话，`permissionMode=readonly`，绑定渠道配置的 `connectionId` / `database`。
- 复用 `AgentHost.startTurn`，收集 `text_delta` 作为回复；写操作在 readonly 模式被拒绝。
- 同一渠道+会话有并发锁，重复消息回复“上一条还在处理中”。
- 回复截断 1800 字符；审计记录 `bot.message`（成功/失败、耗时、sessionId）。
- 飞书使用 `tenant_access_token` + `im/v1/messages` 回复；OneBot 使用 `send_group_msg` / `send_private_msg`。

### 3.3 飞书应用要求

- 创建企业自建应用，开启机器人能力；
- 事件订阅地址填 `https://<bridge>/api/bots/<channelId>/events`；
- 订阅 `im.message.receive_v1`；
- 申请 `im:message`（发送消息）与接收消息权限；
- 将 App ID / App Secret / Verification Token 填入渠道配置。

## 4. MCP 插件

### 4.1 客户端

- stdio JSON-RPC（换行分隔），流程：`initialize` → `notifications/initialized` → `tools/list` → `tools/call`。
- 每台 Server 懒启动、进程复用；配置签名（命令+参数）变化时重启；Gateway 关闭时统一 `kill`。
- 初始化超时 30 秒，工具调用超时 20 秒；stderr 保留最后 4KB 用于错误提示。
- Windows 下通过 shell 启动 `npx`/`npx.cmd`；命令由用户显式配置，属于本机可信执行。

### 4.2 Agent 工具

新增全局工具（总数 51）：

| 工具 | 风险 | 作用 |
|---|---|---|
| `mcp_list_tools` | read | 列出一个 MCP Server 的工具与 JSON Schema |
| `mcp_call` | write | 调用指定工具，参数透传；默认需要审批 |

Agent 的调用路径：先 `mcp_list_tools` 发现工具，再 `mcp_call`；`mcp_call` 在 `ask` 模式触发审批，`readonly` 模式拒绝。结果文本作为工具摘要返回，完整结果保留在 `data`。

### 4.3 飞书 MCP 示例

在设置 → MCP 添加：

```text
名称：feishu
命令：npx
参数：-y @larksuiteoapi/lark-mcp ...
环境变量：{"APP_ID":"...","APP_SECRET":"..."}
```

具体参数以所用 MCP Server 的 README 为准；AiDB 不预置任何第三方包。配置后点击“发现工具”，Agent 即可在 `/ask` 中通过 `mcp_list_tools` / `mcp_call` 使用。

### 4.4 AiDB 作为 MCP Server（出站）

`scripts/aidb-mcp-server.mjs` 是 stdio MCP Server，把 AiDB 的只读工具暴露给 Claude Desktop / Cursor 等外部 MCP 客户端。先启动网关，再在客户端配置：

```json
{
  "mcpServers": {
    "aidb": {
      "command": "node",
      "args": ["<AiDB 安装目录>/scripts/aidb-mcp-server.mjs"],
      "env": { "AIDB_URL": "http://127.0.0.1:8787", "AIDB_TOKEN": "<网关 token>" }
    }
  }
}
```

- `tools/list` 只返回 `read` 与 `dynamic` 工具；`tools/call` 走 `POST /agent/tools/:name`，服务端再次按风险过滤，写工具返回 `TOOL_READ_ONLY`。
- 适合外部 Agent 让 AiDB 查结构、跑只读 SQL、做统计；写库仍必须回到 AiDB 内走审批。
- 外部客户端拿到的结果文本含完整工具结果；token 只从环境变量读取，不写日志。

## 5. API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/POST | `/notifications/channels` | 渠道列表 / 新增 |
| PUT/DELETE | `/notifications/channels/:id` | 更新 / 删除 |
| POST | `/notifications/channels/:id/test` | 发送测试消息 |
| POST | `/bots/:id/events` | 平台回调（公开，按渠道配置校验） |
| GET/POST | `/mcp/servers` | MCP Server 列表 / 新增 |
| PUT/DELETE | `/mcp/servers/:id` | 更新 / 删除 |
| GET | `/mcp/servers/:id/tools` | 启动并列出工具 |
| POST | `/agent/tools/:name` | 只读工具执行桥（MCP Server 出站使用） |

## 6. 安全边界

- 通知配置 / MCP 环境变量加密存储，列表不返回秘密。
- Inbound 默认关闭，必须显式 `inbound: true`；建议配置白名单。
- 机器人只读：即使群成员要求写库，readonly 模式也会拒绝。
- MCP 命令是本机执行；只允许用户手动配置，不提供远程下发配置。
- `mcp_call` 默认审批；不要给不受信任的 MCP Server 配置高权限环境变量。
- 出站 MCP Server 只执行只读工具；写操作在服务端按风险拒绝，不依赖客户端自律。
- 发送/接收均写审计；失败不会静默。

## 7. 验证

- `notifications.test.ts`：飞书/企微/OneBot/钉钉/Slack/Discord/Telegram payload、签名、定时报告投递、飞书 challenge、飞书 inbound、OneBot inbound（4 个测试）。
- `notification-migration.test.ts`：旧版 `CHECK(type IN ...)` 表结构迁移后可写入新平台类型（1 个测试）。
- `mcp.test.ts`：stdio MCP Server 配置、工具发现、`mcp_list_tools` / `mcp_call` 执行（1 个测试）。
- `mcp-server.test.ts`：AiDB 作为 stdio MCP Server 的 initialize / tools/list / 只读 tools/call（1 个测试）。
- `npm run verify` 全绿：docs 329/329、core 149/149、gateway 133/198、E2E 139/139。
- E2E 覆盖：设置内通知渠道/MCP/Skills 面板、数据库工具箱不含 Agent 能力、工具数 51、报告命令、AI PPT 面板、移动端命令。

## 8. 暂不支持

- 企业微信 inbound（需要企业应用回调 AES 解密）。
- 钉钉 / Slack / Discord inbound（需要各自的事件订阅/网关；当前仅 outbound）。
- Telegram inbound（可用 webhook 方案，后续接入）。
- 飞书加密事件（`encrypt` 字段）。
- MCP SSE / Streamable HTTP transport（当前仅 stdio）。
- 出站 MCP Server 暂只暴露只读工具；审批式写工具出站尚未设计。
- 机器人多轮会话映射（当前每条消息独立会话）。
- 个人微信。
