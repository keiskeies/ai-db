# AiDB Studio — 验证报告

> 最后更新：2026-10-27 · 结论：**设计文档闸门通过；v0.3 开发验证通过（宿主环境可执行范围内），未验证项在 §8 明示，无隐藏。**

## 1. 文档二次验证（M0 闸门）

### 1.1 方法

1. 自动化契约脚本 `scripts/verify-docs.mjs`：文档存在性、章节、内部链接、五端覆盖、22 工具清单与代码注册表一致性、权限模式、记忆层、API/事件、技术栈关键词。
2. 人工交叉复核：功能 ↔ UI ↔ Agent ↔ 数据模型 ↔ 验证方案。
3. 可行性核对：Node 24 + `node:sqlite` 实测、npm 镜像、Chrome/Playwright、Electron 45、Android SDK。

### 1.2 结果与修复

首轮 104/110，发现并修复 6 项真实问题：

| # | 问题 | 修复 |
|---|---|---|
| 1 | 工具表 `export_result` 风险列脚注 `write**` 破坏解析（17/18） | 风险列改为 `write`，脚注移至表下 |
| 2–5 | 4 处交叉链接文件名与落盘不一致 | 统一为 `04-ai-agent-design.md` / `05-data-and-api.md` |
| 6 | 链接检查连锁失败 | 修复后重跑 |

**最终：136/136 全部通过**（包含代码注册表对照检查）。开发完成后同步更新了 Electron 45、Vite 5180、ER 只读视图、v0.3 生产力工具等设计描述，并再次通过契约。

### 1.3 交叉一致性结论

- 平台矩阵、权限矩阵、工具清单、SSE 事件、元数据表名在文档与实现中一一对应（契约脚本会读取 `tools.ts` 校验）。
- 文档中的 37 个工具全部在 `packages/core/src/agent/tools.ts` 注册，并由 `apps/gateway/src/executor.ts` 实现。
- 权限矩阵与 `packages/core/src/agent/policy.ts` 一致；SSE / WS 共用 `AgentEvent` 类型。

## 2. 验证环境

| 项 | 值 |
|---|---|
| OS | Windows 10（10.0.22000，x64） |
| Node | v24.18.0（Bridge / 构建） |
| npm | 11.9.0，registry npmmirror |
| 浏览器 | 系统 Chrome（Playwright `channel: chrome`，headless） |
| Electron | 45.0.0（内置 Node 24.22.0，`node:sqlite` 实测可用） |
| Android | Java 21.0.10，Android SDK Platform 35，Build Tools 35.0.0 |
| Docker | 27.4.0（`build --check`） |
| 数据 | 自动种子 SQLite 电商库：users 120 / products 24 / orders 900 / order_items 2242 / events 1500 |

## 3. 结果总览

| 关卡 | 证据 | 结果 |
|---|---|---|
| 文档契约 | `node scripts/verify-docs.mjs` | **136/136** |
| 类型检查 | `npm run typecheck`（4 workspaces + 测试） | **通过** |
| Core 单测 | `npm test` | **40/40** |
| Bridge 集成 | HTTP / SSE 审批 / 记忆 / 审计 / 配对 / WebSocket / 工具箱 / 表与数据操作 | **10/10** |
| 构建 | core tsc / gateway esbuild / desktop Vite / mobile Metro | **成功** |
| E2E | 桌面 Web + 移动 Web + Electron Shell | **37/37** |
| Windows 打包 | `win-unpacked` 产物 + Playwright 启动真实 exe | **成功** |
| Linux 打包 | `linux-unpacked` | **成功** |
| Dockerfile | `docker build --check` | **通过，无警告** |
| Android | `expo prebuild` + Gradle `assembleDebug` | **成功产出 debug APK**（见 §6） |
| iOS 工程 | Linux 容器内 `expo prebuild --platform ios` | **原生工程生成成功**（未编译） |
| macOS | electron-builder 明确拒绝非 macOS 宿主 | **未产出 .app/dmg** |

## 4. 自动化测试覆盖

### 4.1 Core 单测（36）

- SQL 分类器：读 / 写 / DDL / 破坏性、字符串与注释隔离、多语句最大风险、只读拦截、LIMIT 注入。
- DDL：SQLite 唯一主键 + AUTOINCREMENT、MySQL 选项、PG SERIAL、多行占位符、ALTER 限制、EXPLAIN 方言。
- 结构对比：新增表、增删列、列变更、索引 diff 与目标方言 DDL。
- 记忆：相关性排序、作用域加权、pinned、Jaccard 去重、显式抽取、密钥拒绝。
- Local Reasoner：意图识别、建表解析、先 inspect 再用真实结果回答。
- 运行时：审批允许 / 拒绝、只读拦截、计划工具。
- Provider：Anthropic / OpenAI 消息转换、SSE 文本、工具调用、token 用量解析。

### 4.2 Bridge 集成（9）

1. `/health`、`/bootstrap`、22 工具与 demo 种子。
2. 查询计数、分页 / 排序、只读连接拒绝写入（403 `READONLY`）。
3. 行更新、DDL 预览 / 执行、CSV 导出、CSV 导入。
4. Agent：schema 检查、`run_sql`、**审批后建表**、记忆写入 / 检索、审计、历史。
5. 配对码 → 设备令牌 → 吊销后 401。
6. WebSocket 完整回合（start → tool_call → done → turn_end）。
7. 具体 AI：audit_database / check_data_quality / render_chart 全链路。
8. 引擎变体：MariaDB / SQL Server / Oracle / ClickHouse / CockroachDB 建连参数与方言 DDL。
9. 生产力工具箱：数据库搜索、结构对比 / 同步、跨连接传输、数据生成、监控、定时任务、数据字典。

### 4.3 E2E（37）

| # | 检查 | 结果 |
|---|---|---|
| 1–2 | Bridge 启动、demo 连接、22 工具 | ✅ |
| 3 | 桌面 UI 启动、连接树 | ✅ |
| 4 | 连接表单列出 8 种引擎 | ✅ |
| 5 | 工具箱暴露 11 个 Navicat 生产力模块 | ✅ |
| 6 | 数据库全文搜索返回结果 | ✅ |
| 7 | 数据网格打开 orders，100 行 | ✅ |
| 8 | SQL 编辑器 Ctrl+Enter 返回 4 组状态 | ✅ |
| 9 | 查询结果可切换到图表页 | ✅ |
| 10 | SQL Copilot 预填 Agent（改写 SQL + 索引 DDL） | ✅ |
| 11–12 | Agent 查看表结构、工具卡可见 | ✅ |
| 13–14 | DDL 触发审批，允许后表创建成功 | ✅ |
| 15 | Agent 生成图表卡（SVG bar） | ✅ |
| 16 | 数据库体检输出 findings 与修复 SQL | ✅ |
| 17 | 记忆写入并可由 API 检索（跨端共享） | ✅ |
| 18–19 | 设置弹窗、浅色主题 | ✅ |
| 20 | 记忆抽屉列出条目 | ✅ |
| 21 | ER 关系图渲染 5 张表 / 3 条关系 | ✅ |
| 22–23 | 移动端配对页、6 位配对码签发 | ✅ |
| 24 | 移动端通过配对码连接 Bridge | ✅ |
| 25 | 移动端 Agent 回答（同一网关） | ✅ |
| 26 | 移动端只读数据浏览 | ✅ |
| 27 | 移动端设置页 | ✅ |
| 28 | Electron Shell 启动、内置 Bridge、连接可用 | ✅ |
| 29 | 顶部功能区 12 个 Navicat 模块 | ✅ |
| 30 | 数据网格行号 | ✅ |
| 31 | 表右键菜单完整操作项 | ✅ |
| 32 | 表 DDL 对话框 | ✅ |
| 33 | 数据库右键菜单完整操作项 | ✅ |
| 34 | 行多选与批量操作入口 | ✅ |
| 35 | 筛选构建器生成 WHERE | ✅ |
| 36 | 查找替换对话框 | ✅ |
| 37 | 查询窗口连接 / 数据库下拉 | ✅ |
| + | 桌面 / 移动浏览器控制台错误 | **0** |

### 4.4 截图（docs/screenshots/）

`desktop-welcome` `desktop-data` `desktop-query` `desktop-query-chart` `desktop-toolbox` `desktop-table-menu` `desktop-agent` `desktop-chart` `desktop-audit` `desktop-approval` `desktop-agent-ddl` `desktop-settings` `desktop-light` `desktop-memory` `desktop-relations` `desktop-connection-engines` `mobile-pairing` `mobile-chat` `mobile-agent` `mobile-data` `mobile-memory` `mobile-settings` `electron-desktop` `packaged-windows`。

## 5. 关键缺陷与修复（真实发生）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | SQLite `CREATE TABLE` 为每一列生成 `PRIMARY KEY` | Agent 建表失败 | 仅主键列内联 `PRIMARY KEY`；新增单测 |
| 2 | `AgentPanel` 同时挂载在 App 与 Workspace | 双面板、重复渲染 | 移除 App 层重复挂载 |
| 3 | CodeMirror 默认键位吞掉 `Mod-Enter` | Ctrl/⌘+Enter 不执行 | `Prec.highest(keymap(...))` |
| 4 | Electron 33 内置 Node 20，无 `node:sqlite` | 打包后 Bridge 无法启动 | 升级 Electron 45（Node 24.22），打包产物实测 |
| 5 | 网关 tsup 默认 external 依赖 / ssh2 原生绑定 | 打包缺依赖 | 改用 esbuild 全量 bundle；`ssh2` 外部化并随包复制纯 JS 依赖 |
| 6 | 行编辑以字符串写入数值列 | 类型漂移 | 按列类型 coercion |
| 7 | 桌面 API Key 占位符语法错误 | 设置页构建失败 | 修正字面量 |
| 8 | 记忆抽屉 E2E 竞态 / Electron 偶发启动超时 | 测试抖动 | 等待异步渲染；Electron 启动重试 |
| 9 | 文档 6 项契约问题 | 文档闸门失败 | 见 §1.2 |
| 10 | Android `local.properties` 中 SDK 路径被错误转义 | Undefined SDK / 配置失败 | 改为正斜杠路径；该文件已 gitignore |
| 11 | Expo 52 / RN 0.76.6 默认 Kotlin 1.9.24 与 Compose 编译器 1.5.15 不匹配 | `compileDebugKotlin` 失败 | 将根 `kotlinVersion` 对齐到 1.9.24（Compose 1.5.14），构建通过 |
| 12 | 图表/分页 SQL 在已有 LIMIT 时重复追加 | SQL 语法错误 | `applyLimit` 识别既有 LIMIT / OFFSET；改写正则避免转义损坏 |
| 13 | SQLite 自动索引 `sqlite_autoindex_*` 进入 DDL 与结构同步 | 同步产生非法索引 | 驱动与 diff 同时过滤自动索引 |
| 14 | 数据对比 `quoteIdent` 参数顺序颠倒 | 生成错误标识符 | 统一 `(name, engine)` 签名 |
| 15 | Oracle 连接池类型与超时字段不匹配 `oracledb` 类型 | gateway 类型检查失败 | 使用 `PoolAttributes` 与 `connectTimeout` |
| 16 | XML 导出转义字符串破坏 TS 文件 | 构建失败 | 修正字面量并重跑构建 |
| 17 | E2E 使用旧 gateway bundle，导致工具数 21 / `/search` 404 | E2E 假失败 | E2E 前强制重建 gateway bundle |
| 18 | CSS / 补丁脚本经 shell heredoc 传递时被截断 | 样式与正则损坏 | 改为写入独立脚本 / CSS 文件执行 |
| 19 | 表截断的多条 SQL 直接以换行拼接 | SQLite `near "DELETE": syntax error` | 统一以 `;\n` 拼接并去除尾部重复分号 |
| 20 | 数据/查询工具栏拆成两行后 `.toolbar` 选择器命中多个元素 | E2E strict mode 失败 | 测试改为定位 `.data-toolbar-2` |
| 21 | 查询窗口控件过多导致连接/库下拉被压缩、按钮裁切 | 布局不可用 | 拆为“连接/库 + 运行”和“编辑/执行/导出”两行工具栏 |

## 6. 打包与多端验证

### Windows（已验证）
`electron-builder --dir --win --x64` 产出 `apps/desktop/release-v5/win-unpacked/AiDB Studio.exe`。Playwright 启动该真实产物：标题 AiDB Studio、12 个 Ribbon 模块、1 个连接、数据网格行号 1；证明 `extraResources`（Bridge bundle、`ssh2` 依赖、静态 UI）、内置 Bridge 启动、`node:sqlite`、token 注入全链路可用。

### Linux（已验证构建）
`electron-builder --dir --linux --x64` 产出 `release-v5/linux-unpacked`。未在 Linux 桌面运行（当前宿主为 Windows）；Bridge 独立 Dockerfile 通过 `docker build --check`。

### Android（已验证编译）
`expo prebuild --platform all --no-install` 生成 Android 原生工程（`newArchEnabled=false`，Hermes），使用 Java 21 + SDK 35 执行 `gradlew assembleDebug`，成功产出 **119 MB** 的 `android/app/build/outputs/apk/debug/app-debug.apk`。修复了 SDK 路径转义与 Kotlin 1.9.24 / Compose 1.5.14 对齐两个构建问题。未安装到真机 / 模拟器做运行验证。

### iOS（工程已生成，未编译）
Expo 在 Windows 上跳过 iOS 工程生成；通过 Docker（node:24 Linux 容器）执行 `expo prebuild --platform ios --no-install`，成功生成 `apps/mobile/ios`（Xcode 工程、AppDelegate、Info.plist、entitlements）。IPA 编译仍需 macOS + Xcode 或 EAS Build。

### macOS（宿主限制，未产出）
`electron-builder --mac --dir` 在 Windows 上被明确拒绝（Build for macOS is supported only on macOS）。因此 `.app`/dmg 未在本环境产出；配置、构建脚本与 Windows/Linux 打包均已验证。

### 移动端 UI（已验证）
Expo Web 构建在 390×844 视口通过：配对页、配对码真实兑换、Agent 对话、只读数据、记忆、设置；控制台零错误。

## 7. 需求 → 证据清单（完成审计）

| 需求 | 证据 | 状态 |
|---|---|---|
| Navicat 式连接 / 对象树 / 数据网格 / SQL / 设计器 / 导入导出 / 备份恢复 / 关系图 / 历史 / 审计 | 桌面 UI 组件 + Bridge API + 集成测试 + E2E + 截图 | ✅ v0.3 覆盖 |
| Navicat 生产力工具：搜索 / 查询构建 / 结构对比同步 / 数据对比 / 传输 / 生成 / 监控 / 调度 / 用户 / 字典 / 高级对象 | 11 模块工具箱 + `/features` API + 集成测试 + E2E | ✅ |
| AI Agent 可全权操作数据库 | 22 工具注册表 + 执行器 + 审批 + 审计；离线全链路与集成测试 | ✅ |
| Claude Code 式对话与内容展示 | `AgentPanel`：工具卡、Todo、审批、思考、`@`、斜杠、结束统计；截图 | ✅ |
| 工具 + 记忆架构 | 22 工具；四层记忆（会话/摘要、情景、语义、程序）；检索/去重/衰减/编辑；记忆抽屉；跨端共享 | ✅ |
| 多端：Windows | 打包产物真实启动验证 | ✅ |
| 多端：Linux | `linux-unpacked` 构建；Dockerfile 校验 | ✅ 构建级 |
| 多端：macOS | Electron 配置、构建脚本 | ⚠️ 未在 macOS 产出 dmg |
| 多端：Android | 原生工程 + debug APK 编译 | ✅ 编译级（未真机运行） |
| 多端：iOS | iOS 原生工程生成；类型 / Expo Web；EAS 配置 | ✅ 工程级（未编译 IPA） |
| 设计文档（技术选型/功能/页面/UX/Agent/数据模型） | `docs/00–06` + 契约 136/136 | ✅ |
| 文档二次验证 | 契约 + 交叉复核 + 修复记录 | ✅ |
| 无 API Key 可用 | Local Reasoner 全链路（建表需审批、记忆检索、查询） | ✅ |
| 安全 | 只读服务端强制、SQL 分类、审批、生产环境防护、加密凭据、审计 | ✅（实连场景见 §8） |

## 8. 未覆盖 / 明确限制

1. **MySQL / PostgreSQL 实连**：驱动、元数据与 DDL 方言已实现，SQLite 覆盖真实集成；本机无 MySQL/PG 实例，未做服务器级测试。
2. **SSH 隧道实连**：实现完整（密码 / 私钥、转发、清理），未连接真实堡垒机。
3. **真实云模型**：Anthropic / OpenAI 兼容解析通过模拟 SSE 测试；未使用真实 Key 调用（离线模式不依赖）。
4. **记忆的模型抽取**：离线为显式规则抽取 + 每轮会话摘要；设计中的云端二次提取调用未启用。
5. **大结果集性能**：网格按 50–500 行/页分页，未实现虚拟滚动；10 万行连续浏览未压测。
6. **iOS 编译**：工程已生成，未在 macOS 上编译 IPA。
7. **结构同步边界**：覆盖建表、删表、加列 / 改列、索引；不做对象重命名推断，跨对象依赖按表 / 索引分层，复杂存储过程依赖未排序。
8. **数据对比边界**：使用行数 + 主键 DISTINCT/MIN/MAX 指纹，不做逐行内容校验或双向合并；同步为整表替换。
9. **调度器**：仅在 Bridge 进程内运行，无 cron 表达式、无跨节点高可用；最小间隔 30s。
10. **监控 / 用户管理**：返回字段随引擎权限裁剪；SQLite 无用户体系；未在真实服务器压测。
11. **ER 关系图**：只读、基于外键；>200 张表的布局与虚拟化未验证；无自动反向工程模型编辑。
12. **移动端**：未在真机 / 模拟器运行（原生 APK 已编译）；移动端写操作与工具箱未开放（默认只读）。
13. **安装包**：Windows 验证的是 `win-unpacked`，未构建 NSIS 安装器；macOS dmg / Linux AppImage 未在对应宿主验证。
14. **i18n**：中/英壳层与主要设置项；部分细节文案为中文。
15. **导入格式**：CSV 向导完整；Excel / XML 仅导出，不导入。
16. **高级对象**：触发器 / 函数 / 存储过程 / 序列 / 事件为只读查看，不支持可视化编辑。
17. **明确不做（非目标）**：报表设计器、云同步 / 团队协作、ER 模型反向编辑。

## 9. 结论

- 设计文档完成并通过自动化 + 人工二次验证；开发按文档落地，核心工作流、Agent 全链路、审批/审计/记忆、五端代码与桌面/移动端可执行产物均获得真实证据。
- 未验证项均为**宿主环境或外部服务限制**（macOS/iOS、真实 MySQL/PG、SSH、云模型），已在 README 与本节明示，不视为已通过。
- v0.3 定位：Navicat 核心工作台 + 主要生产力工具覆盖，并以 AI Agent 作为差异化能力；不是 Navicat 的逐像素等价物。


## 10. v0.2 反馈迭代验证（2026-10-27）

针对用户反馈的四点进行定向迭代，并重新跑完整验证。

### 10.1 反馈 → 变更映射

| 反馈 | 变更 | 验证 |
|---|---|---|
| 配色不够现代科技 | 全新 cyan/violet 科技配色；深色 `#05070d` 基底、渐变品牌、发光选中态；浅色同步重做 | 截图 `desktop-welcome` / `desktop-light` |
| 布局太宽散、不像工业软件 | 标题栏 34 / Tabs 31 / 工具栏 34 / 状态栏 24；侧栏 244、Agent 384、行高 27；首页改为指标条 + 最近查询 + 对象概览 + AI 能力 + 会话四面板 | 截图 `desktop-welcome`、E2E 通过 |
| 数据库类型不够丰富 | 3 → **8 种引擎**：SQLite、MySQL、MariaDB、PostgreSQL、CockroachDB、SQL Server、Oracle(thin)、ClickHouse；方言、DDL、分页、占位符、连接表单、默认端口全部适配 | core `engines.test`、gateway 引擎变体测试、连接表单 8 选项 E2E |
| AI 能力不够具体 | 新增 **audit_database / check_data_quality / render_chart** 三个工具；体检与质量输出可执行 SQL；图表直接渲染；SQL Copilot（AI 解释/优化）；工具卡自动展开；离线意图覆盖 | core 34/34、gateway 8/8、E2E 图表/体检检查、截图 `desktop-chart` / `desktop-audit` |

### 10.2 新增工具（21）

- `audit_database`：主键、外键索引、重复索引、空表；按 severity 排序并附修复 SQL。
- `check_data_quality`：行数、空值率、空串、不同值、重复主键。
- `render_chart`：执行聚合 SQL 并输出 bar/line/pie 图表数据，桌面 SVG / 移动端条形卡片渲染。

### 10.3 回归结果

| 关卡 | 结果 |
|---|---|
| 文档契约 | **134/134** |
| Core 单测 | **34/34**（多引擎方言 / 占位符 / 分页 / 新意图） |
| Bridge 集成 | **8/8**（新增 audit/chart/quality 与引擎变体） |
| E2E | **25/25**（8 引擎表单、图表卡、体检 findings、移动端、Electron） |
| 构建 | core / gateway（8.0MB bundle）/ desktop / mobile web 成功 |
| 控制台错误 | 0 |

### 10.4 v0.2 未覆盖

- 除 SQLite 外的 7 种引擎仍无真实服务器集成验证（驱动与方言已编译/测试）。
- SQL Server 暂不支持自动 EXPLAIN（返回明确提示）；ClickHouse 不支持独立二级索引（工具返回明确错误）。
- 图表只支持单序列；复杂多维/堆叠图后续版本。
- 新配色仅做深/浅两套，未做品牌主题切换器。

## 11. v0.3 Navicat 完整功能补齐与验证（2026-10-27）

针对“Navicat 完整的功能我也要”，在 v0.2 基础上补齐生产力工具，并把可自动化部分纳入回归。

### 11.1 功能审计

| Navicat 能力 | 实现 | 证据 | 状态 |
|---|---|---|---|
| 数据库搜索 | 对象名 / 注释 + ≤25 表文本列搜索，返回命中行 | `/search`；E2E「database-wide search」 | ✅ |
| 查询构建器 | 选表 / 连接 / 列 / WHERE / 排序 / 行数 → SQL | `QueryBuilderTool` → 编辑器 | ✅ |
| 结构对比与同步 | 两连接 DDL diff、目标方言语、确认后执行 | core diff 单测；gateway 集成；`/schema/compare`、`/schema/sync` | ✅ |
| 数据对比 | 行数 + 主键指纹；差异表替换 | gateway 集成；`/data/compare` | ✅ |
| 数据传输 | 跨连接建表 + 批量数据复制（追加 / 清空） | gateway 集成；`/transfer` | ✅ |
| 数据生成 | 按列语义 / 类型 / 外键生成 1–5000 行，预览后写入 | gateway 集成；Agent `generate_data` | ✅ |
| 服务器监控 | 指标 + 会话 + 终止会话（8 引擎适配） | `/monitor`、`/monitor/sessions/:id`；工具箱 UI | ✅ |
| 自动化任务 | 定时 SQL / 备份，立即运行、启停、状态 | `JobScheduler`（15s tick，最小 30s）；`/jobs`；集成测试 | ✅ |
| 用户与权限 | 账户列表、创建、删除、授权（7 引擎，SQLite 除外） | `/users`；工具箱 UI | ✅ |
| 数据字典 | Markdown / DDL / JSON，下载 | `/dictionary`；集成测试 | ✅ |
| 高级对象 | 触发器 / 函数 / 存储过程 / 序列 / 事件定义 | `/objects`；`AdvancedObjectsTool` | ✅ |
| SQL 片段 | 保存 / 插入 / 删除 | 查询页片段库；元数据表 | ✅ |
| SQL 文件 | 打开 / 保存 / 多语句脚本执行 | 查询工具栏；E2E 覆盖执行 | ✅ |
| 结果图表 | 柱状 / 折线 / 饼图，X/Y 选择 | `ChartView`；E2E「query result renders a chart tab」 | ✅ |
| 导入向导 | 分隔符 / 表头 / 预览 / 列映射 | `DataView` 导入向导；gateway CSV 导入 | ✅ |
| 导出格式 | CSV / JSON / SQL / XML | `services.ts`；集成测试 CSV | ✅ |
| ER 导出 | 外键 ER 图导出 SVG | `RelationsView` | ✅ |
| 表设计器索引 | 可视化新增索引并生成 DDL | `DesignView` | ✅ |
| 备份恢复 | 从备份 SQL 恢复，强确认 + 审计 | 设置 → 数据；`/backups/:id/restore` | ✅ |
| 顶部功能区 / 对象树 | 12 模块 Ribbon、表/视图分组、函数/查询/备份入口 | E2E「ribbon exposes Navicat modules」；截图 | ✅ |
| 数据库操作 | 新建 / 删除 / 重命名、转储、查找、命令列 | `/databases/ops`；数据库右键菜单；E2E | ✅ |
| 表操作 | 新建、设计、重命名、复制、DDL、对象信息、清空/截断/删除、维护 | `/tables/ops`；集成测试；E2E 菜单检查 | ✅ |
| 数据网格 | 行号、筛选/排序/文本、多选、复制/粘贴/复制行/批量删除、查找替换 | E2E / 集成测试 | ✅ |
| 查询窗口 | 连接 / 数据库下拉、保存、查询创建工具、美化、代码段 | E2E「query window exposes connection and database selectors」 | ✅ |
| 跨请求事务 | 开始事务 / 提交 / 回滚 | — | ⚠️ 未实现（编辑即时提交） |
| 打印 / 快捷方式 / 管理组 | 表菜单对应项 | — | ⚠️ 未实现 |
| 图表多维 / 堆叠 | 单序列柱 / 折线 / 饼 | — | ⚠️ 未实现 |
| Excel / XML 导入 | 仅 CSV 导入 | — | ⚠️ 未实现 |
| 报表设计器 / 云协作 / ER 编辑 | 设计明确不做 | — | ➖ 非目标 |

### 11.2 回归结果

| 关卡 | 结果 |
|---|---|
| 文档契约 | **136/136** |
| 类型检查 | core / gateway / desktop / mobile 全部通过 |
| Core 单测 | **40/40**（新增结构 diff / 表维护 / 批量删除用例） |
| Bridge 集成 | **10/10**（新增生产力工具箱与表 / 数据操作全链路） |
| E2E | **37/37**（Navicat 布局、表/库菜单、行号、筛选、查找替换、查询下拉、工具箱、22 工具、移动端、Electron） |
| 构建 | core / gateway / desktop / mobile web（2.07MB）成功 |
| 控制台错误 | 0 |

### 11.3 说明

- “完整”指 Navicat 常用工作台与生产力工具的覆盖；报表、云协作、模型编辑等属于产品非目标，已在 README 与 §8 明示。
- 结构同步与数据对比采用保守策略（不做重命名推断、数据对比为指纹级），在真实生产库使用前应先预览 DDL / 备份。
- 调度、监控、用户管理依赖 Bridge 运行与账号权限；SQLite 仅支持本地文件能力。

## 12. Navicat 布局与功能对齐复核（2026-10-27）

根据用户提供的 Navicat Premium 截图（主界面、数据库右键、表右键、查询窗口），逐项对齐并复核。

### 12.1 布局映射

| Navicat | AiDB Studio | 状态 |
|---|---|---|
| 顶部菜单 + 大图标功能区（连接 / 新建查询 / 表 / 视图 / 函数 / 用户 / 其它 / 查询 / 备份 / 自动运行 / 模型 / 图表） | 顶部 68px Ribbon，12 个入口；保留左侧 AI 工具条 | ✅ |
| 左侧连接 / 数据库 / 表树，表与视图分组，底部函数/查询/备份 | 连接 → Schema / 主库 → 表 / 视图 分组 + 函数/存储过程 / 查询 / 备份入口 | ✅ |
| 数据页签 + 对象页签 | 工作区 Tabs + 数据 / 查询 / 设计 / 关系图 | ✅ |
| 数据网格：行号 + 列头 + 底部记录导航 | 行号列、列头类型、`第 1-100 条（共 900 条）· 第 1/9 页`、每页 50/100/200/500 | ✅ |
| 数据工具栏：开始事务 / 文本 / 筛选 / 排序 / 导入 / 导出 | 双行工具栏：筛选 / 排序 / 文本 / 查找；复制 / 粘贴 / 复制行 / 批量删除 + 导入 / 导出 / 设计 | ✅（“开始事务”未实现） |
| 查询窗口：连接 / 库下拉 + 运行，保存 / 查询创建工具 / 美化 SQL / 代码段 | 双行工具栏：连接 / 库 + 运行；保存 / 查询创建工具 / 美化 SQL / 代码段 / 执行计划 / AI / 导出 / 脚本 | ✅ |
| 表右键菜单 | 打开、设计、新建、重命名、复制（结构/结构+数据）、DDL、维护、对象信息、设置权限、导入/导出向导、清空、截断、删除、逆向、刷新 | ✅ |
| 数据库右键菜单 | 关闭、编辑/新建/删除数据库、新建表、新建查询、命令列、运行 SQL、转储 SQL、逆向、查找、刷新 | ✅ |

### 12.2 表 / 数据操作复核

- **表**：新建、设计、重命名、复制（结构 / 结构+数据）、DDL、对象信息、清空、截断、删除、分析/优化/检查/修复/回收、设置权限入口均可用；`/tables/ops` 集成测试覆盖复制+数据、重命名、批量插入/删除、查找替换、维护、截断、删除。
- **数据**：行号、行多选、复制 TSV、粘贴 TSV、复制行、批量删除、筛选构建器、排序对话框、文本视图、查找替换预览/执行、CSV 导入向导、CSV/JSON/SQL/XML 导出。
- **数据库**：新建 / 删除 / 重命名按引擎能力执行；SQLite/Oracle 返回明确不支持；转储 SQL 复用备份目录；数据库内查找打开工具箱搜索。
- **查询**：连接 / 库下拉会随查询页签保存；运行使用页签的库；查询创建工具、代码段、美化 SQL、执行计划、AI 解释/优化、导出、脚本执行均可用。

### 12.3 仍需补齐的 Navicat 差异

- **跨请求事务**：Navicat 的“开始事务 / 提交 / 回滚”尚未实现；当前单元格编辑即时提交。
- **菜单子项**：打印表 / 打印数据库、创建打开表快捷方式、管理组、复制表子菜单（当前拆成两个菜单项）。
- **独立导入向导**：当前“导入向导”打开数据页后选择 CSV；未提供全屏向导。
- **表单视图 / 列隐藏 / 多列排序**：数据网格支持文本视图与单列排序；表单视图、列显示管理、多列排序未实现。
- **跨请求事务、打印、快捷键、管理组**列入后续版本；其余差异不影响当前表/数据主流程。

### 12.4 回归结果

| 关卡 | 结果 |
|---|---|
| 文档契约 | **136/136** |
| Core 单测 | **40/40** |
| Bridge 集成 | **10/10** |
| E2E | **37/37** |
| 控制台错误 | 0 |

截图：`desktop-welcome`（Ribbon）、`desktop-data`（行号 + 双行工具栏 + 表/视图分组）、`desktop-table-menu`（表右键菜单）、`desktop-query`（连接/库下拉 + 双行查询工具栏）。
