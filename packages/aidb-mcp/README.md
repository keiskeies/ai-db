# @aidb-studio/aidb-studio

AiDB Studio 的只读 MCP Server，供 Claude Code / Claude Desktop / Cursor 使用。

用 **一次性配对** 换取可吊销的只读设备凭据，MCP 客户端配置里不再出现网关主令牌。
需要 AiDB Bridge 已启动（桌面端内置，或独立部署）。

## 一次性配对

1. 在 AiDB 桌面端打开 **设置 → Bridge → MCP 客户端配对**，读取 6 位配对码（**60 秒**有效，界面有倒计时）。
   这是专用入口，与「为移动端配对」的码不通用，适用于任意 MCP 客户端
   （Claude Code / Cursor / Cline / Windsurf / Zed / Continue 等）。
2. 运行：

   ```bash
   npx -y @aidb-studio/aidb-studio pair
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
       "aidb": { "command": "npx", "args": ["-y", "@aidb-studio/aidb-studio"] }
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

要求 Node.js ≥ 22.5；本包零运行时依赖。可信发布额外要求 npm ≥ 11.5.1、Node ≥ 22.14.0。

## 许可

MIT
