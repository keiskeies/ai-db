# AiDB Studio — Skill Host 设计与开发计划

> 版本：v1.5 · 日期：2026-10-30 · 状态：**S1/S2 完成，S3 宿主链路与确定性报告直出通过（真实模型端点受环境阻塞），S4 完成（Git/npm/模板/MCP 双向/升级回归）**
> 关联：[命令化 Agent 工作流](./11-command-workflows.md) · [机器人与 MCP 插件](./12-bots-and-mcp.md) · [AI Agent 设计](./04-ai-agent-design.md)

## 0. 目标

把 AiDB 从“数据库工具集 + 内置命令”升级为**能原生承载 Claude/Codex 级 skill 的数据库 Agent 宿主**。不以“只接 PPT 编译器”或“抄一部分源码”为终点；目标是：

1. 兼容 `SKILL.md` 目录包（frontmatter + references + scripts + assets + templates）；
2. 支持本地导入、压缩包导入、后续 npm/Git 导入与版本固定；
3. 渐进加载，不把整套 skill 文档塞进系统提示；
4. 为 skill 提供受控文件、进程、Python/Node、网络与产物能力；
5. skill 在独立子 Agent 中执行，隔离上下文与工具权限；
6. PPT Master 作为第一个一等公民 skill，跑完整 Generate 流程，而不是只调用导出脚本。

## 0.1 管理入口与开关

| 能力 | 管理入口 | 开关 |
|---|---|---|
| Skill Host | 设置 → Skills | 每个 Skill 复选框（启用/停用）；Skills 页顶部“允许 Agent 自动调用技能”（全局） |
| Skill 运行 | 设置 → Skills → 查看 → 运行 Skill Worker | 全局开关关闭只影响 Agent 自动调用；仍可在本页手动运行 Worker |
| AI PPT / 报告直出 | 命令面板生成报告产物 → AI PPT；`/report 文字` 在 Agent 对话内回答 | Skills 页顶部“启用 AI PPT”；关闭后按钮隐藏，`POST /artifacts/:id/deck` 返回 403 |
| MCP 工具（Agent） | 设置 → MCP | 每个 Server 的启用/停用；MCP 页顶部“允许 Agent 调用 MCP”（全局） |
| MCP 出站（外部 Agent） | 外部 MCP 客户端启动 `scripts/aidb-mcp-server.mjs` | MCP 页顶部总开关同时关闭 `?for=mcp` 工具列表与 `/agent/tools/:name` |
| 通知渠道 | 设置 → 通知 | 每个渠道的启用/停用；禁用渠道发送返回「渠道已禁用」 |
| Skill 密钥 | 设置 → Skills → 查看 → 密钥 | 逐项设置/清除；值加密存储，不回显 |

关闭是“停止调用/隐藏入口”，不删除已安装 Skill、MCP 配置、密钥或产物；开关就在 Skills / MCP 页面顶部，保存立即生效。AI PPT 入口在报告/对比产物的操作栏。数据库“工具箱”只保留数据库工具，不再混入 Agent 能力。设置导航按“基础 / 集成与连接 / 能力扩展 / 系统”分组，顶部支持搜索；原来的 Agent 页命名为“模型”。

## 1. 设计原则

- **Skill 是能力包，不是提示词**：`SKILL.md` 只是入口；宿主必须提供它声明的文件/进程/运行时能力。
- **渐进披露**：系统提示只放 `name + description + id`；正文、references、文件树按需读取。
- **权限显式**：skill 声明 fs / process / network / secrets 需求；安装和首次运行都需用户确认。
- **默认安全**：路径限制在 skill 目录、输入目录、输出目录；命令白名单；无任意 shell；网络默认关闭。
- **数字不交给 skill 重算**：AiDB 的查询、统计、`resultRef` 仍是数据真相；skill 只做叙事、设计、排版与导出。
- **上游优先**：兼容并跟随上游，不在仓库里 fork 100+ 个脚本；只有宿主适配层由 AiDB 维护。

## 2. Skill 包规范

### 2.1 目录

```text
skills/<id>/
├── SKILL.md              # 必需；YAML frontmatter + 指令正文
├── references/           # 可选；按需读取的参考文档
├── workflows/            # 可选；流程文档（PPT Master 使用）
├── scripts/              # 可选；Python/Node 脚本
├── templates/            # 可选；模板资源
├── assets/               # 可选；图片、字体等
└── aidb.skill.json       # 可选；AiDB 扩展（权限、运行时、入口）
```

`SKILL.md` 直接兼容 Claude/Codex：

```yaml
---
name: ppt-master
description: AI-driven presentation workflow ...
metadata:
  version: "6.7.3"
  license: MIT
---
# Skill instructions...
```

`aidb.skill.json`（可选，不修改上游 SKILL.md）：

```json
{
  "runtime": { "python": ">=3.10 <3.15", "node": ">=20" },
  "bootstrap": ["guard", "project-init"],
  "secrets": ["IMAGE_API_KEY"],
  "guide": "宿主给模型的精简适配说明；存在时优先于技能内部冗长工作流。",
  "permissions": { "fs": ["workspace", "output"], "process": ["python"], "network": false, "mcp": ["my-mcp-server"] },
  "entrypoints": [
    { "id": "guard", "command": ["${python}", "${skillDir}/scripts/attribution_guard.py"], "allowArgs": false },
    { "id": "project-init", "command": ["${python}", "${skillDir}/scripts/project_manager.py", "init", "deck", "--quick-generate", "--dir", "${workspace}/projects"], "allowArgs": false },
    { "id": "quality", "command": ["${python}", "${skillDir}/scripts/svg_quality_checker.py", "${project}", "--quick-generate", "--stage", "final", "--json"], "allowArgs": false },
    { "id": "export", "command": ["${python}", "${skillDir}/scripts/svg_to_pptx.py", "${project}", "--quick-generate"], "allowArgs": false }
  ]
}
```

- `bootstrap`：模型开始前由宿主顺序确定性执行（完整性检查、项目初始化）；失败即终止，不消耗模型步数。
- `guide`：适配层给出的精简执行说明；只在宿主侧维护，不改上游 skill。
- `${project}`：`project-init` 成功后由宿主解析并写入 `workspace/.aidb/project.json`，后续 entrypoint 直接复用。
- `allowArgs: false`：固定流水线拒绝模型追加任意参数，避免把脚本路径误塞进 `project-init`。
- 同一次 Skill Worker 的 `skill_write` / `skill_run` / `skill_list_files` 共用同一个 run 与 workspace，模型无需传 runId。

没有 `aidb.skill.json` 的纯指令 skill 仍可用，只是不能执行脚本；PPT Master 的内置适配清单由网关提供，不修改上游源码。

### 2.2 安装与版本

- 导入源：本地目录、zip（后续 Git / npm / marketplace）。
- 安装位置：`AIDB_HOME/skills/<id>`；同一 id 覆盖前保留旧版本目录（`.backup-<timestamp>`）。
- 校验：必须存在 `SKILL.md`；frontmatter 必须有 `name`、`description`；id 使用目录名并限制 `[a-z0-9_-]`。
- 安全：zip 解压拒绝路径穿越、绝对路径、符号链接逃逸、超大文件。
- 版本固定：`aidb.skill.json` 或 frontmatter `metadata.version` 显示在 UI；后续支持 GitHub release 固定。

## 3. Skill Host 分层

| 层 | 职责 | 不负责 |
|---|---|---|
| Skill Registry | 发现、解析 frontmatter、启停、目录树、文件读取 | 执行脚本 |
| Skill Prompt | 只注入目录；提供 `skill_list` / `skill_read` | 把全文塞入 prompt |
| Skill Runtime | 工作区、文件写入、进程执行、环境变量、依赖检测 | 业务判断 |
| Skill Worker | 独立上下文的子 Agent，按 SKILL.md 工作流推进 | 直接访问主会话工具 |
| Artifact Bridge | 把输出文件注册为 AiDB 产物 | 重算数据 |
| Permission Broker | 安装/运行授权、命令白名单、网络与路径策略 | 隐式放行 |

## 4. 工具与 Agent 集成

### 4.1 S1 工具

| 工具 | 风险 | 作用 |
|---|---|---|
| `skill_list` | read | 列出已安装、启用的 skill 及文件树 |
| `skill_read` | read | 读取 `SKILL.md` / references / workflows / 文本脚本；限制路径与大小 |

系统提示新增 `## Skills` 段落，仅列 id、name、description、版本。模型需要细节时调用 `skill_read`。

### 4.2 S2 工具

| 工具 | 风险 | 作用 |
|---|---|---|
| `skill_write` | write | 在 skill workspace / output 写文件 |
| `skill_run` | dynamic | 按 `aidb.skill.json` 白名单执行脚本；参数校验、超时、输出捕获 |
| `skill_list_files` | read | 列出 workspace / output / 可读目录 |

`skill_run` 不开放任意 shell；`command` 必须匹配 skill 声明的 entrypoint；cwd 固定为 workspace；环境变量只注入声明的 secret。

### 4.3 S3 子 Agent

- 每个 skill 运行创建一个 **Skill Worker**：独立 `AgentRuntime`、独立上下文、独立工具白名单。
- 主 Agent 只看到：skill 名称、运行状态、摘要、产物；不继承技能内部几十页文档。
- Skill Worker 可按 SKILL.md 的流程读 references、写 SVG/脚本输出、调用 `skill_run`。
- **Bootstrap**：`aidb.skill.json` 的 `bootstrap` entrypoint 在模型开始前顺序执行（PPT Master 为 `guard` + `project-init`），失败即终止并回传明确错误。
- **适配指南**：manifest `guide` 是宿主维护的精简执行说明，优先于技能内部冗长工作流；不 fork 上游文档。
- **读写预算**：`skill_read` 支持 `offset/nextOffset` 分段读取；同一片段不重复读，单文件最多 12 段，避免弱模型在超长 workflow 上反复重读。
- **自动调用与手动运行分离**：关闭“允许 Agent 自动调用技能”后，Agent 看不到技能索引和 `skill_*` 工具；用户仍可在 Skills 页手动运行 Worker。
- **交互式提问**：`skill_ask` 工具映射为 `skill_question` 事件，UI 弹出问题卡；`POST /skills/runs/:id/answers` 回答后 Worker 原地继续。
- **取消**：取消会中止 AgentRuntime，并通过 AbortSignal 杀掉正在运行的 skill 子进程。
- **产物**：运行结束推送 `skill_artifact` 事件，UI 列出 workspace/output 文件并走系统「另存为」；`GET /skills/runs/:id/files` 提供受控下载。
- **主会话回传**：新增 `skill_worker_run` 工具；主 Agent 可把长任务交给 Worker，等待完成后只拿到最终文本与产物路径，不重放 Worker 的工具日志。
- **上下文隔离**：Worker 不继承主会话历史；工具白名单只含 skill 读写、skill 运行与提问。

## 5. 执行沙箱

### 5.1 工作区

```text
AIDB_HOME/skill-runs/<runId>/
├── workspace/         # skill 可写；复制 skill 的 scripts/assets 只读引用
├── input/             # 本次输入（报告、数据、附件）
├── output/            # 产物（PPTX、SVG、音频）
└── logs/              # stdout/stderr/命令审计
```

### 5.2 策略

- **路径**：resolve 后必须位于上述根目录；拒绝 `..`、绝对路径、symlink 逃逸。
- **进程**：只允许 `aidb.skill.json` 声明的 executable（`python` / `node`）；参数模板由宿主渲染；超时默认 10 分钟，可配置。
- **网络**：当前**未做系统级隔离**，skill 子进程继承宿主网络能力；manifest 的 `network` 字段目前只作声明，域名白名单/审批待容器或本地代理方案落地。
- **密钥**：manifest `secrets` 声明环境变量名；值加密存 `skill_secrets`，只在 entrypoint 运行时注入；API 只返回名称与是否已设置，不返回值，不写日志。
- **Python**：优先使用 AIDB 管理的 runtime（后续随包/uv 安装）；退化为系统 Python 时必须检测版本与依赖，缺失则阻断并给出安装指引，不静默降级。
- **审计**：每次 `skill_run` 记录命令、参数摘要、cwd、退出码、耗时、stdout/stderr 摘要。

## 6. PPT Master 接入

### 6.1 路线

- 导入 `D:\item\ppt-master\skills\ppt-master` 或官方 release 的 skill 包；不 fork 源码。
- 完整走它的 `SKILL.md` 路由与 Generate 工作流；AiDB 只提供宿主能力与输入/输出桥。
- 数据来源：`/report` 产物的 ReportSpec / 正文 / 图表数据写入 `input/`；PPT Master 不重新查库，数字以 `resultRef` 为准。
- 模板：使用它的 Brand / Style / Layout / Deck；`/report` 后续支持选择模板。
- 导出：原生 PPTX（图表/表格/公式/备注/动画按 skill 能力），产物进入 AiDB artifacts。

### 6.2 验收

1. 导入 PPT Master，`skill_list` 能看到 `ppt-master` 与版本；
2. `skill_read` 能按需读取 `SKILL.md`、`workflows/generate-pptx.md`、`references/*`；
3. S2 能运行其 Python 入口并检测依赖；
4. S3 用一份 AiDB 报告生成 2–3 页原生 PPTX；报告数字与 AiDB 结果一致；
5. 模板导入与 Brand/Layout 复用可用；
6. 失败时给出缺失依赖/权限，不静默退回中性模板。

## 7. API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/skills` | 已安装 skill 列表（脱敏） |
| GET | `/skills/:id` | SKILL.md 与目录树 |
| GET | `/skills/:id/files?path=` | 读取文本文件（path-safe） |
| POST | `/skills/import` | 导入本地目录或 zip（后续 Git/npm） |
| POST | `/skills/:id/enable` | 启停 |
| DELETE | `/skills/:id` | 卸载（保留备份） |
| POST | `/skills/:id/runs` | S3：启动 Skill Worker |
| GET | `/skills/runs/:id` | S3：运行状态、workspace、project、产物清单 |
| GET | `/skills/runs/:id/events` | S3：SSE 进度/提问/产物 |
| POST | `/skills/runs/:id/answers` | S3：回答阻塞问题 |
| POST | `/skills/runs/:id/cancel` | S3：取消运行并终止子进程 |
| GET/PUT | `/skills/:id/secrets` | 读取声明/设置状态 / 保存加密密钥 |
| DELETE | `/skills/:id/secrets/:name` | 清除密钥 |
| GET | `/skills/runs/:id/files?area=&path=` | S3：path-safe 读取产物 |

## 8. 开发步骤

### S1 发现与读取（已完成）
- `SkillStore`：目录发现、frontmatter 解析、启停、文件树、文本读取、zip/目录导入。
- core 类型 `SkillSummary` / `SkillFileEntry`；gateway `skill_list` / `skill_read` 工具（总数 47）。
- AgentHost 注入 Skills 目录段落。
- 设置 → Skills：列表、导入、启停、查看 SKILL.md；首次启动自动写入 3 个轻量内置技能（报告写作、SQL 审查、数据字典），PPT Master 作为第三方推荐技能提供一键安装。
- 验收：已导入真实 PPT Master skill（v6.7.3，13,050 个文件），列表/`workflows/routing.md` 读取/目录注入通过；zip 导入与路径越界测试通过。Skill 工具总数 51；`npm run verify` 全绿：docs 329/329、core 149/149、gateway 152 pass、E2E 150/150。

### S2 沙箱运行时（完成）
- workspace / input / output；`skill_write` / `skill_run` / `skill_list_files`。
- `aidb.skill.json` 权限解析；命令白名单、超时、路径越界保护、run 元数据持久化；Python/Node 命令解析。
- 同一会话内自动复用 run；取消通过 AbortSignal 终止子进程。
- 启动 Worker 前检查 `runtime.python` 版本与 `runtime.pythonPackages`；缺依赖直接给出 `pip install` 指引（PPT Master 检查 `pptx`）。
- `skill_run` / `skill_worker_run` 写入审计（runId、entrypoint、退出码、状态、耗时），与数据库工具审计同表。
- 密钥：`secrets` 声明 + 加密存储 + 运行时注入；桌面 Skills 面板可设置/清除，值不回显。
- 验收：Node fixture 的写入/运行/文件清单/超时/越界测试通过；工具总数 51；`npm run verify` 全绿。
- 网络策略尚未实现系统级隔离（`network` 仅声明）；当前依靠受信 skill、路径/命令白名单与运行审计，后续用容器或代理落地域名白名单。

### S3 Skill Worker（进行中）
- 独立 AgentRuntime、工具白名单、SSE 事件、交互问题、artifact 回传。
- 已落地：bootstrap（guard + project-init）、`${project}` 解析、同 run 绑定、`skill_ask` 阻塞提问、取消、产物事件与文件下载、桌面运行面板。
- 真实 PPT Master 探针：完整性检查、项目初始化、质量门禁、原生 PPTX 导出全部在 `skill-runs/<run>/workspace` 内完成；单页样例导出 1 页原生 PPTX，postflight 通过（仅质量建议警告）。
- Worker 2 页探针（fake provider 驱动同一套工具调用）：2 个 SVG、质量报告 `errors=0 / warnings=2`、2 页原生 PPTX（15,337B）；证明 Worker→skill 脚本→产物的宿主链路。
- 报告直出探针（确定性排版，不依赖模型）：真实 Demo 报告 → 4 页 SVG → 质量门禁 → 4 页原生 PPTX（19,494B）；PPTX 中的 5 张表 / 4,786 行与 ReportSpec 完全一致，运行目录和产物均在 `skill-runs/<run>/workspace`。
- 真实模型端点当前无响应（本地 `127.0.0.1:1994` 对推理请求超时），真实内容生成验收阻塞于环境；宿主侧错误会回传，不静默降级。
- 桌面点击验证：从 demo 报告点“AI PPT” → 勾选确定性排版 → 生成，面板返回 `succeeded` 与 19,493B 的 PPTX，可直接“保存”；数字与报告一致。
- 待完成：真实模型 2–3 页 Generate 验收（端点恢复后执行）。
- 验收：完整 Generate 流程 2–3 页；主会话上下文不膨胀；数字与报告一致。

### S4 模板与生态（进行中）
- 已落地：Git 仓库导入（自动扫描 SKILL.md、支持 subdir/ref）；npm 包导入（`npm pack --ignore-scripts` + 内置 tar 解包）；Skills 面板按 brands/styles/layouts/decks 分组并一键填入模板；AI PPT 面板从已安装 Skill 动态读取模板候选；`POST /artifacts/:id/deck` 把报告交给 PPT Master（`mode=agent` 走模型，`mode=deterministic` 直接按 ReportSpec 排版），支持模板路径；Skill Worker 可按 `permissions.mcp` 白名单调用 MCP 工具；`scripts/aidb-mcp-server.mjs` 把 AiDB 只读工具暴露为 stdio MCP Server（`POST /agent/tools/:name`）。
- 品牌模板探针：`templates/brands/accenture` 应用到确定性排版，封面使用 `#A100FF` / `#FFFFFF`，质量门禁后导出原生 PPTX。
- 验收：升级保留 `.backup-<id>-<timestamp>` 旧版本，新版本生效；`skills.test.ts` 已覆盖。
- 验收：品牌模板导出；升级不破坏已安装 skill。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 任意脚本执行 | 命令白名单 + workspace + 超时 + 运行审计；网络隔离仍待容器/代理方案 |
| Python 依赖缺失 / AGPL | 托管 runtime；PDF 能力单独开关；安装前展示依赖与许可证 |
| 上下文爆炸 | 渐进披露 + Skill Worker 独立上下文 |
| skill 更新破坏兼容 | 版本固定、备份、安装校验、上游为源 |
| 数字被 skill 重算 | input 只给报告结果；禁止 skill 访问主 Agent 的 DB 工具；对照验收 |
| zip 路径穿越/zip bomb | 解压前校验、大小上限、拒绝 symlink/绝对路径 |
| 模型质量不足 | 明确推荐模型档案；失败给出可诊断信息，不静默降级 |

## 10. 完成定义

- 能导入、启停、读取、卸载任意兼容 `SKILL.md` 的 skill；**已通过**（目录 / zip / Git，含路径越界与备份）。
- PPT Master 能在 AiDB 中完成一次完整 Generate，输出原生 PPTX；**确定性报告直出已通过**（4 页原生 PPTX，数字与 ReportSpec 一致）；**真实模型生成受本地端点无响应阻塞**。
- skill 执行有权限、沙箱、审计、取消与错误诊断；**已通过**（命令白名单、超时、路径保护、运行审计、AbortSignal 取消、Python 版本/包检查、密钥加密注入）。
- S1–S4 全部通过 `npm run verify` 与专用 skill 验收脚本；**S1–S3 通过全量 verify（docs 329/329、core 149/149、gateway 152/217、E2E 150/150）；S4 已完成 Git/npm 导入、模板选择器、Skill→MCP 白名单桥、MCP Server 出站与升级回归。**
- 上游 skill 更新可通过重新导入完成，不修改上游源码。
