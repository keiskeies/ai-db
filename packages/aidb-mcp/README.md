# @aidb/mcp

AiDB Studio 的只读 MCP Server，供 Claude Code / Claude Desktop / Cursor 使用。

用 **一次性配对** 换取可吊销的只读设备凭据，MCP 客户端配置里不再出现网关主令牌。
需要 AiDB Bridge 已启动（桌面端内置，或独立部署）。

## 一次性配对

1. 在 AiDB 桌面端打开 **设置 → Bridge → MCP 客户端配对**，读取 6 位配对码（**60 秒**有效，界面有倒计时）。
   这是专用入口，与「为移动端配对」的码不通用，适用于任意 MCP 客户端
   （Claude Code / Cursor / Cline / Windsurf / Zed / Continue 等）。
2. 运行：

   ```bash
   npx -y @aidb/mcp pair
   ```

   按提示输入配对码与 Bridge 地址（默认 `http://127.0.0.1:8787`）。
   凭据写入本地文件（`0600`）：

   - Windows：`%APPDATA%\aidb-mcp\credentials.json`
   - macOS / Linux：`$XDG_CONFIG_HOME/aidb-mcp/credentials.json` 或 `~/.config/aidb-mcp/credentials.json`
   - 可用 `AIDB_MCP_CREDENTIALS` 覆盖路径

3. 在 Claude Code 的 MCP 配置中（**不含任何密钥**）：

   ```json
   {
     "mcpServers": {
       "aidb": { "command": "npx", "args": ["-y", "@aidb/mcp"] }
     }
   }
   ```

之后每次会话由 Claude Code 自动拉起 server，无需再输码。

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
- 遗留用法：设置 `AIDB_URL` + `AIDB_TOKEN` 环境变量也能启动，但那是网关主令牌、
  权限不受限，**不推荐**。

## 暴露的工具

`tools/list` 只返回 `read` 与 `dynamic` 风险的第一方工具（如 `list_connections`、
`inspect_schema`、`run_sql` 只读 SELECT、`get_query_history`），并排除
`mcp_list_servers` / `mcp_list_tools` / `mcp_call`（本地文件系统 / Git / 网页 MCP
不允许被外部客户端借道）。

## 发布（维护者）

仓库根 `.npmrc` 指向 npmmirror 镜像，发布必须显式覆盖 registry：

```bash
cd packages/aidb-mcp
npm pack --dry-run --json       # 确认 tarball 只含 bin/ README.md LICENSE
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
npm view @aidb/mcp version
```

要求 Node.js ≥ 22.5；本包零运行时依赖。

## 许可

MIT
