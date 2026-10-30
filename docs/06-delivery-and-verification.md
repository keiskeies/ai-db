# AiDB Studio — 开发计划与验证方案

> 版本：v0.3 · 关联：[架构](./01-tech-architecture.md)

## 1. 里程碑

| 里程碑 | 内容 | 完成标准 |
|---|---|---|
| M0 设计 | 00–06 文档、契约清单 | 文档契约脚本通过，二次评审无矛盾 |
| M1 内核 | `@aidb/core`：类型、SQL 分类/方言/DDL、Agent 运行时、工具定义、记忆引擎、Provider（含 Local） | 单测通过（分类器/记忆/Provider 解析/DDL） |
| M2 Bridge | 八引擎驱动、元数据库与迁移、REST/SSE/WS、配对、审计、demo 种子库、生产力工具 API | 集成测试通过；`/health`、CRUD、Agent 回合、工具箱可用 |
| M3 桌面 UI | 外壳、Ribbon、连接、对象树、数据网格、SQL 编辑器、设计器、导入导出、设置、11 模块工具箱、表/数据库操作 | 浏览器形态可完成核心工作流与生产力工具 |
| M4 Agent UX | 对话流、工具卡、计划、审批、记忆页、命令面板、斜杠/@、Provider 设置、图表/体检卡片 | 离线模式下评估场景通过 |
| M5 移动 | Expo App：对话、数据、连接、记忆、设置；配对 | 类型检查通过；Expo Web 冒烟；构建脚本就绪 |
| M6 打包 | Electron 三平台配置、Bridge Dockerfile、移动 EAS 配置 | 配置文件完整、命令可执行（本机验证 Windows/Linux 与 Android） |
| M7 验证 | 单元/集成/E2E/文档契约/截图，写验证报告 | 报告全绿或列明未验证项 |

## 2. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | `node:test` + `tsx` | SQL 分类器、只读校验、DDL 生成、记忆打分/去重、Provider 流解析、Local Reasoner 意图 |
| 集成 | `node:test` + 临时 SQLite + HTTP | 连接 CRUD、查询/分页、行编辑、导入、Agent 会话/SSE/审批/记忆、审计、配对 |
| E2E | Playwright（Chromium，桌面 Web 形态） | 启动 → demo 连接 → 浏览表 → 查询 → Agent 建表/查询/记忆 → 审批流 → 移动端 Web 渲染 |
| 类型 | `tsc --noEmit`（各 workspace） | 全量 |
| 文档契约 | `scripts/verify-docs.mjs` | 必需的文档/章节/链接；工具清单在 02/04 与代码一致；平台矩阵五端；API 与协议事件一致 |
| 人工 | 截图/设计走查 | 主题、空状态、响应式、移动布局 |

### 2.1 必须自动化的验收场景
1. `POST /query` 对 demo SQLite 执行 SELECT 返回正确列与行。
2. 只读连接拒绝 UPDATE（HTTP 400/403 + 明确错误码）。
3. Agent（Local Reasoner）"有哪些表" → 调用 `list_connections` + `inspect_schema`，SSE 事件序列完整（start→tool_call→tool_result→text_delta→done）。
4. Agent "创建表 partner_trials" → 产生审批（ask 模式）→ 同意 → 表存在 → 审计有记录。
5. 记忆写入后，新会话检索命中（API 层）。
6. 数据网格更新一行 → 数据库值变化；删除还原。
7. 导出 CSV 文件存在且行数正确。
8. E2E：浏览器中完成连接 → 查询 → 打开 Agent → 发送指令 → 看到工具卡与结果。
9. 移动端 Expo Web 首页渲染（无 JS 错误）。

## 3. 文档二次验证（M0 闸门）

文档写完后不直接开发，先做一次**独立复核**：
1. **契约脚本**：检查关键章节存在、内部链接有效、五端平台均出现、51 个工具在 02/04/executor 代码清单中一致、API 表包含 Agent 与配对、SSE 事件类型与协议一致。
2. **交叉一致性**：权限矩阵（04）与功能规格（02）的安全描述一致；数据模型表名与 API 字段一致；UI 的 Agent 元素与 04 的交互映射一致。
3. **可行性**：核对技术选型与仓库脚本可执行（依赖可安装、Node 版本、打包命令）。
4. **输出**：`docs/07-verification-report.md` 记录检查项、证据、发现与修复。

## 4. 交付验证命令

```bash
npm install          # 安装（npm workspaces）
npm run typecheck    # 全部 TS 检查
npm test             # core + gateway 单测/集成
npm run build        # core/gateway/desktop renderer 构建
npm run dev          # 浏览器验证形态（Bridge + Vite）
npm run e2e          # Playwright 冒烟
npm run verify:docs  # 文档契约
# 桌面
npm run build:desktop
# 移动
npm --workspace apps/mobile run start
```

## 5. 风险清单（交付层面）

| 风险 | 处理 |
|---|---|
| Electron 安装/打包体积大、下载慢 | 镜像源；打包验证可选；Web 形态保证可运行 |
| 无真实 MySQL/PG 实例 | 以 SQLite demo 覆盖核心；驱动用接口单测 + 连接失败路径测试；文档注明 |
| Expo 原生构建需 SDK/Xcode | 提供 EAS 配置与类型检查；用 Expo Web 冒烟验证 UI |
| 模型 Key 缺失 | Local Reasoner 全链路验收；Provider 解析单测 |
| 时间盒 | 优先级：M1→M2→M3→M4 必须；M5/M6 保证代码与配置完整；M7 报告真实记录 |

## 6. 定义完成（DoD）

- 文档：00–06 完成且契约脚本通过，验证报告记录二次验证结果。
- 代码：核心工作流在浏览器形态可操作；Agent 离线全链路可用；审批/审计/记忆可验证。
- 测试：`typecheck`、`test`、`build`、`e2e`、`verify:docs` 全绿。
- 多端：桌面打包配置齐全；移动工程可启动、可类型检查、核心页面可渲染；Bridge 可独立部署。
- 报告：未验证项（如真机 iOS/Android、真实云模型、SSH 隧道实连）明确列出，不隐瞒。

## 7. 实际验证结果（2026-10-27，v0.3）

| 关卡 | 命令 / 方式 | 结果 |
|---|---|---|
| 文档契约 | `npm run verify:docs` | 268/268 通过 |
| 类型检查 | `npm run typecheck`（core / gateway / desktop / mobile） | 全部通过 |
| 单元测试 | `npm test` → core | 149/149 通过 |
| 集成测试 | gateway（HTTP / SSE / WebSocket / 审批 / 配对 / 引擎方言 / 工具箱 / 表与数据操作 / 跨请求事务 / SSH 隧道 / Skill Host） | 198 个用例 · 133 通过 · 65 跳过（跳过项是需要 `AIDB_TEST_*_PORT` 的联机引擎，未配置即跳过） |
| 构建 | core、gateway（esbuild）、desktop（Vite）、mobile web（2.07MB） | 成功 |
| E2E | `npm run e2e`（桌面 Web + 移动 Web + Electron Shell + Navicat 布局 / 表与数据操作 / 工具箱 / 搜索 / 图表 / 体检 / SSH 隧道） | 139/139 通过（无联机引擎环境变量时的基线；联机引擎检查按环境追加） |
| Windows 打包 | `electron-builder --dir --win --x64` + 启动 `win-unpacked/AiDB Studio.exe` | 成功；内置 Bridge、1 个连接、Agent 面板可见、无异常 |
| Windows NSIS 安装包 | `electron-builder --win nsis --x64 --publish never` | 成功产出 `AiDB Studio-0.1.0-setup.exe`（131 MB）+ `.blockmap`；`oneClick=false`、`perMachine=false` |
| Linux 打包 | `electron-builder --dir --linux --x64` | 生成 `linux-unpacked` |
| Docker | `docker build --check -f apps/gateway/Dockerfile .` | 通过 |
| Android | `expo prebuild` + Java 21 / SDK 35 + Gradle `assembleDebug` | 成功产出 119 MB debug APK |
| macOS / iOS | — | 受宿主系统限制，未产出安装包/IPA |

详细输出、缺陷修复与未覆盖项见 [验证报告](./07-verification-report.md)。

### Windows 覆盖安装 / 升级流程

安装包使用 NSIS、按用户安装（`perMachine: false`），**同 appId + 同 productName 的新版本
setup 直接覆盖旧版本**，不需要先卸载：

1. 新版本 setup 安装到原目录，桌面 / 开始菜单快捷方式原位更新，不产生第二份安装。
2. 连接、历史、记忆、导出目录都在 `%APPDATA%/AiDB Studio`（`app.getPath('userData')`），
   安装目录只放程序文件；`deleteAppDataOnUninstall: false` 保证卸载也不删数据。
3. 首次运行新版本时，Electron 主进程在拉起 Bridge **之前**读取 `.app-version` 标记：
   发现版本变化就把 `aidb.db` + `-wal` + `-shm` 整体复制到
   `backups/upgrade-<旧版本>-to-<新版本>-<时间戳>/`，然后才让 gateway 做结构迁移。
4. Bridge 健康检查通过后才写入新版本标记；启动失败不会把旧标记覆盖掉，下次仍会备份。
5. 单实例锁保证覆盖安装后不会有两个进程同时抢同一个数据目录。

验证：`node --test apps/desktop/electron/upgrade.test.cjs`（首次安装、同版本、覆盖升级、
数据库尚未创建四种情况，以及 NSIS 配置/主进程顺序守卫）。2026-10-29 已实际构建出
NSIS 安装包验证配置可执行；**没有在本机执行安装**——测试安装会写入真实的
`%APPDATA%/AiDB Studio` 与卸载注册表项，可能碰到现有用户数据，因此「装 A → 覆盖装 B →
检查备份」仍留作发布前在隔离虚拟机执行的步骤。
