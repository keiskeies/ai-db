# @aidb-studio/aidb-studio

AiDB Studio 的**只读** MCP Server：把 AiDB 的查询类工具（看连接、看表结构、跑只读 SQL、
采样数据、出图表等）通过 stdio 暴露给 Claude Code / Claude Desktop / Cursor / Cline / Zed
等 MCP 客户端。

用 **一次性配对** 换取可吊销的只读设备凭据，客户端配置里不出现网关主令牌；随时可在桌面端
**设置 → 设备** 吊销。需要 AiDB Bridge（网关）已启动——桌面端内置，或独立部署。

## 环境要求

- **Node.js ≥ 22.13**（与 AiDB Studio / Bridge 的 `node:sqlite` 最低运行时一致；本包零运行时依赖，`npx` 会自动拉取）。
- **AiDB Bridge 正在运行**，默认监听 `http://127.0.0.1:8787`；远程 Bridge 需可达且已开启
  `features.mcp`（设置 → Bridge）。
- 客户端支持 stdio 型 MCP Server（以「命令 + 参数」方式拉起）。

## 快速开始

**1) 配对**（每台机器一次）。在 AiDB 桌面端打开 **设置 → Bridge → MCP 客户端配对**，读取
6 位配对码（**60 秒**有效，界面有倒计时；这是专用入口，与「为移动端配对」的码不通用），然后：

```bash
npx -y @aidb-studio/aidb-studio pair
```

按提示输入配对码与 Bridge 地址（默认 `http://127.0.0.1:8787`）。凭据以 `0600` 写入本地文件：

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\aidb-mcp\credentials.json` |
| macOS / Linux | `$XDG_CONFIG_HOME/aidb-mcp/credentials.json`，否则 `~/.config/aidb-mcp/credentials.json` |

**2) 接入客户端**。在客户端的 MCP 配置里加一条 server（**不含任何密钥**）：

```json
{
  "mcpServers": {
    "aidb": { "command": "npx", "args": ["-y", "@aidb-studio/aidb-studio"] }
  }
}
```

- **Claude Code**：`claude mcp add aidb -- npx -y @aidb-studio/aidb-studio`
- **Claude Desktop**：`claude_desktop_config.json` 的 `mcpServers`
- **Cursor**：项目里的 `.cursor/mcp.json`
- **Cline / Windsurf**：各自 MCP 设置，用同样的 `mcpServers` 结构
- **Zed**：`settings.json` 的 `context_servers`（键名不同，字段一致）

之后每次会话由客户端自动拉起 server，无需再输码。

## CLI 命令

| 命令 | 作用 |
| --- | --- |
| `aidb-mcp pair` | 交互式一次性配对，写入只读凭据文件 |
| `aidb-mcp`（默认） | 以 stdio 运行 MCP Server，读取上一步写入的凭据 |
| `aidb-mcp serve` / `server` | 同默认（给习惯显式子命令的客户端用） |

`stdout` 只走 JSON-RPC，所有诊断信息走 `stderr`，所以可以直接被客户端管道拉起。

## 可以问什么

配对后由 AI 自动挑工具，你不用记名字。典型对话：

- 「列出我配置的所有数据库连接」→ `list_connections`
- 「order 库 users 表有哪些列、主键和外键」→ `inspect_schema`
- 「`SELECT status, count(*) FROM orders GROUP BY status`」→ `run_sql`（仅只读 SELECT）
- 「随机看 orders 表 20 行」→ `sample_rows`（敏感列默认脱敏）
- 「users.email 有多少空值、Top 取值」→ `profile_column`
- 「按月统计 2024 订单数的 max/min/avg」→ `analyze_chart`

除关系型 SQL 外还支持 MongoDB / Redis / Neo4j / Cassandra / ArangoDB / Elasticsearch 等
（见「暴露的工具」）。**任何写操作都会被拒**——见「安全边界」。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `AIDB_MCP_CREDENTIALS` | 覆盖凭据文件路径 |
| `AIDB_URL` | `pair` 时 Bridge 地址的默认值（直接回车时取它） |

Server 只读取 `pair` 写入的只读设备凭据；`AIDB_TOKEN` 网关主令牌不再作为启动凭据。

## 常见问题

- **「未找到 MCP 配对凭据」**：先跑 `npx -y @aidb-studio/aidb-studio pair`。
- **配对「无法连接 Bridge」**：确认桌面端 Bridge 在跑、地址端口对（默认 8787）。
- **配对码过期 / 失败**：码 60 秒过期、单次消费，回桌面端刷新一个再试。
- **工具报权限被拒**：凭据可能已在 设置 → 设备 吊销，重新配对即可。
- **目录 / 配对端点返回 403**：`features.mcp` 被关，到 设置 → Bridge 打开。

## 安全边界

- 配对生成的 device token 的 `scope = mcp:readonly`，网关在鉴权中间件层只允许它访问
  `GET /health`、`GET /agent/tools?for=mcp`、`POST /agent/tools/:name`。
- `/agent/tools/:name` 桥对受限凭据使用显式白名单（不只靠 `risk` 字段，因为部分会写状态的
  工具被错标为 `read`），且 `run_sql` 等仍由 `resolveRisk` 二次判定为只读才放行。
- WebSocket / Agent 会话通道拒绝该凭据；`GET /capabilities` 也不在白名单内。
- MCP 配对有**专用端点与码池**：`/pair/mcp/start`（需主令牌）+ `/pair/mcp/claim`（开放），
  服务端硬编码 `scope = mcp:readonly`，不接受调用方传 `scope`；与移动端
  `/pair/start` + `/pair/claim`（硬编码 `full`）完全隔离，码不能跨端点兑换。
- 配对限流按 TCP 远端地址计数（不可被 `X-Forwarded-For` 伪造），配对码由 `crypto.randomInt`
  生成；`features.mcp=false` 时 MCP 配对端点不可用。
- 网关只保存 token 的 SHA-256 hash；桌面端 **设置 → 设备** 可随时吊销，立即生效。
- Server 拒绝回退到 `AIDB_TOKEN` 网关主令牌；缺少配对凭据时必须先运行 `pair`，
  避免外部 MCP 客户端绕过 `mcp:readonly` 作用域。

## 暴露的工具

`tools/list` 对只读凭据返回**显式白名单**里的 21 个「读数据、无副作用」工具，不是全部
read/dynamic 工具——`backup_database`、`memory_write`、`update_plan` 等虽被标为 `read`
但会写状态或落盘，已排除；`mcp_list_servers` / `mcp_list_tools` / `mcp_call` 也排除
（本地文件系统 / Git / 网页 MCP 不允许被外部客户端借道）。

| 工具 | 作用 |
| --- | --- |
| `list_connections` | 列出连接（id / 引擎 / 环境 / 只读标志） |
| `inspect_schema` | 库表结构：列、类型、主键、索引、外键 |
| `search_objects` | 按名称 / 注释搜表与列（适合大 schema） |
| `run_sql` | 执行 SQL，仅只读 SELECT 放行 |
| `explain_sql` | 取 SQL 执行计划（EXPLAIN） |
| `sample_rows` | 取一小批样例行（敏感列默认脱敏） |
| `profile_column` | 列画像：空值率、distinct、Top 取值、min/max |
| `get_query_history` | 读最近查询历史，可按连接 / 文本过滤 |
| `analyze_chart` | 跑 SELECT 返回统计（count/sum/avg/min/max…） |
| `forecast_chart` | 时间序列 SELECT 并外推未来若干期 |
| `render_chart` | 跑 SELECT 出图表数据（视觉渲染需支持图表的宿主） |
| `schema_diff` | 比较两连接 schema，列出变更表与破坏性变更 |
| `recon_data` | 两数据源对账（SQL 表或 Redis keyspace） |
| `memory_search` | 搜索长期记忆（事实 / 偏好 / 历史调查） |
| `vector_search` | 按向量或文本搜向量集合 / 表 |
| `search_index` | 对 ES / OpenSearch 索引跑 `_search` JSON DSL |
| `run_mql` | MongoDB 结构化查询（find / aggregate / count / distinct） |
| `run_redis` | 跑一条 Redis 命令（优先 SCAN，危险命令受限） |
| `run_cypher` | Neo4j Cypher（只读连接） |
| `run_cql` | Cassandra / ScyllaDB CQL |
| `run_aql` | ArangoDB AQL |

工具清单以运行时的 `tools/list` 为准。

## 发布（维护者）

日常发布由 `.github/workflows/publish-mcp.yml` 通过 npm **可信发布（OIDC）** 完成，
仓库不存 npm token。只有**首次**需要一次性配置，其中只有第 1 步必须访问 npmjs.com 网站
（`npm` CLI 没有创建组织的命令），其余都能在任何能连通 `registry.npmjs.org` 的机器上做：

1. 在 npmjs.com 创建 **组织 `aidb-studio`**（scope 必须先存在，否则发布报 `Scope not found`）。
2. 终端登录。默认 `auth-type=web` 会打开 `auth.npmjs.org`，网络受限时走 legacy。账号开了 2FA
   后，legacy 登录会打印一个 `https://www.npmjs.com/login/<uuid>` 链接，在浏览器里用安全密钥
   确认，再把页面生成的一次性令牌粘回终端：

   ```bash
   npm login --registry=https://registry.npmjs.org --auth-type=legacy   # 账号密码 + 安全密钥
   ```

3. 发布**真实版本**（首个版本手动发，之后全走 CI；可信发布方只能建在已存在的包上）：

   ```bash
   cd packages/aidb-mcp && npm publish --access public --registry=https://registry.npmjs.org
   ```

4. 建可信发布方。`--file` 只写工作流文件名，且必须允许 `npm publish`：

   ```bash
   npm trust github @aidb-studio/aidb-studio --file publish-mcp.yml --repo keiskeies/ai-db --allow-publish
   npm trust list @aidb-studio/aidb-studio      # 核对
   ```

   **建好后必须在 2 天内跑成第一次 CI 发布**，否则该配置过期，只能删掉重建。
   所以下一步别拖太久。

5. 验证 CI 链路：升版本、打 tag，确认 registry 上出现 CI 发出版本（其 provenance 应指向本仓库）。

之后每次发布只需改 `packages/aidb-mcp/package.json` 的 `version` 并打 tag：

```bash
npm --workspace @aidb-studio/aidb-studio run test
git commit -am "chore(mcp): 版本升 x.y.z" && git tag mcp-vx.y.z && git push --follow-tags
```

CI 会校验 tag 与 `version` 一致、跑测试、核对 tarball 只含 `bin/` `README.md` `LICENSE`，
再 `npm publish` 并回查 registry。跑通后到 npm 把 token 发布关掉
（Settings → Publishing access → 要求 2FA 且禁用 token），发布权限就只剩这条流水线。

> npm 公告：绕过 2FA 的 token 正被收紧（2026-08 起影响账号操作，2027-01 起不能直接发包）。
> 这正是改用 OIDC 的理由——CI 侧不需要任何 token。

运行要求 Node.js ≥ 22.13；本包零运行时依赖。可信发布额外要求 npm ≥ 11.5.1、Node ≥ 22.14.0，CI 使用 Node.js 24。

## 许可

MIT
