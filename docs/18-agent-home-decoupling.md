# 18. 首页与 Agent 解耦 · 会话按库隔离

> 状态：**已实现**（2026-11-01）
> 实现记录：`.superpowers/sdd/2026-11-01-agent-home-decoupling/progress.md`
> 关联：`docs/17-welcome-home-design.md`（首页=当前库的家）、`docs/04-ai-agent-design.md`

## 1. 要解决的四件事

1. **解耦**：左侧点库只改首页作用域，不再顺手改写 Agent 的目标库。
2. **会话按库隔离**：Agent 的历史记录区分不同库，抽屉与「最近」只显示当前库的会话。
3. **运行态互斥**：首页触发 Agent 功能前先判断是否在跑；在跑则提示「等当前回答结束」，不打断。
4. **换库自动恢复会话**：Agent 目标库变化时，自动加载该库最近的那条会话。

## 2. 现状与约束

| 事实 | 位置 | 影响 |
|---|---|---|
| `agentDatabase` 同时被当作「首页当前库」和「Agent 目标库」 | `store.ts`，6 处写 / 3 处读 | 这是要拆的那个耦合点 |
| `AgentSessionMeta` 已有 `connectionId` + `database` | `packages/core/src/types.ts` | 按库隔离的**数据基础现成**，无需迁移 |
| `listSessions(limit)` 无过滤参数，`GET /agent/sessions` 返回全部 | `gateway/src/store.ts:listSessions`、`routes.ts:2234` | 需要加按库过滤 |
| `busy = live?.status === 'streaming' \|\| 'awaiting'` 已存在 | `AgentPanel.tsx:1026` | 运行态判断现成 |
| `loadAgentSession(id)` 已能加载指定会话 | `store.ts` | 自动恢复直接复用 |
| 会话列表在**两处**渲染 | `AgentPanel.tsx` 抽屉 + `recent` 区块 | 两处都要按库过滤 |
| `setAgentDatabase` 会把库写回当前会话 | `store.ts:719` | 换库时前端与后端记录需一致 |

## 3. 目标 / 非目标

**目标**
- 一个库 = 一份会话列表；同库可保留多条历史，靠「新会话」另起。
- 首页与 Agent 各自持有"看哪个库"，互不覆盖。
- 两者不一致时界面明示，并提供一键对齐。
- Agent 在跑时，首页的 AI 入口不静默排队、不误切换。

**非目标**
- 不改会话存储引擎、不做数据迁移（`database` 字段本就存在）。
- 不改 Agent 推理与工具调用逻辑。
- 不引入跨库聚合视图（如"所有库的会话"）。抽屉仍只列当前库。

**反目标**（做到了也算失败）
- 首页看 A 库、Agent 实际答 B 库，而界面没有任何提示 —— 这比现状更糟。
- 自动恢复把正在进行的会话顶掉。
- 「新会话」按钮在运行中把正在回答的会话 abort 掉却不告知。

## 4. 方案（已选 A）

考虑过三条路：

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. 拆两个字段 + 会话按库查询**（选用） | 新增 `homeDatabase`；`agentDatabase` 归 Agent 独占；按库过滤会话；自动恢复最近一条 | 满足全部四条；代价是两个库可能不一致，需显式提示 |
| B. 一库一会话唯一约束 | 同库只允许一条，`newSession` 即清空 | 实现最简，但**丢掉多历史**，用户已否 |
| C. 首页存局部 state | 只改首页，不动 store | 改动最小，但侧栏无法驱动首页，回到要修的原点 |

选 A，因为它是唯一同时满足四条要求、且不牺牲已有数据的方案。

## 5. 字段与语义

```
homeDatabase   string   首页正在展示的库。侧栏点库、首页库下拉写它。
agentDatabase  string   Agent 的目标库。只有 Agent 顶部选择器写它。
```

**单一写者原则**：每个字段只有一个来源，避免互相覆盖。

| 入口 | 写 `homeDatabase` | 写 `agentDatabase` |
|---|---|---|
| 左侧栏点库 | ✅ | ❌ |
| 首页头部库下拉 | ✅ | ❌ |
| 首页点表行 / 建议 | ✅ | ❌ |
| Agent 顶部库选择器 | ❌ | ✅ |
| 首页「让 AI 体检」等入口 | ✅ | ✅（先对齐，见 §7） |

`agentDatabase` 的持久化仍走 `setAgentDatabase` 写回会话；`homeDatabase` 走 UI prefs（按连接记忆，复用现有 `agentDatabaseByConnection` 的形态）。

## 6. 会话按库隔离

### 6.1 网关

`GET /agent/sessions` 增加可选查询参数：

```ts
listSessions({ connectionId?, database?, limit? })
// WHERE archived = 0
//   AND (connectionId IS NULL OR connection_id = ?)
//   AND (database IS NULL OR database = ?)
```

不传参数时保持现在的"全部"，保证既有调用方与 e2e 不变。

### 6.2 前端

`api.sessions({ connectionId, database })`；store 增加派生集合：

```
sessionsForScope = sessions.filter(
  s => (!scopeConn || s.connectionId === scopeConn) &&
       (!scopeDb   || !s.database || s.database === scopeDb)
)
```

`s.database` 为空的旧会话（未绑定库）在**任何**库下都可见——它们是"还没选库"时产生的，隐藏会让用户以为记录丢了。

### 6.3 两处渲染都换成 `sessionsForScope`

- 抽屉列表
- 空消息时的「最近」区块（原 `sessions.slice(0,3)`）

抽屉标题旁标注当前库名，让"这是 friendship 的会话"这件事一直可见。

## 7. 自动恢复

**触发条件**：`agentDatabase` 发生变化（Agent 顶部下拉切换、外部对齐）。
**动作**：

```
if (busy) → 不自动恢复，保留现场，只更新目标库（见 §8 冲突处理）
else      → 拉该库最近会话
            ├ 有 → loadAgentSession(最近一条.id)
            └ 无 → 清空为空白会话（不创建后端会话，发第一条消息时才创建）
```

**不自动恢复的情形**：首页点 AI 入口时，如果目标库没变，就不恢复（避免顶掉用户正在看的会话）。

只有 `agentDatabase` **值确实变了**才触发，用 `previous !== next` 判断。

## 8. 运行态互斥

首页一切会触发 Agent 的入口（AI 体检、建议项、快捷动作）走同一个守卫：

```
if (busy) {
  notify('warn', 'Agent 正在回答，请等这一轮结束再操作')
  return            // 不改 agentDatabase、不 prefill、不 openAgent
}
否则：对齐 agentDatabase → prefill → 打开面板
```

**关键**：在跑的时候**连库都不切**。否则会出现"目标库变了但会话没换"的半截状态，用户下一次提问就答错库。

`newAgentSession` 现有的 `abortAgent` 行为保留（那是用户显式点新会话），但运行中需二次确认。

## 9. 不一致提示

`homeDatabase !== agentDatabase` 时，Agent 面板顶部显示一行轻提示：

> 首页在看 `friendship`，Agent 瞄准 `media`　[对齐到 friendship]

只做提示不做自动同步——自动同步等于把耦合又装回去。点击才对齐，对齐后 `agentDatabase = homeDatabase` 并触发 §7 的自动恢复。

## 9.5 三处必须先定死的细节

写文档时自查出的三个空档，猜错会直接做歪，这里先定下来。

**(a) 「空白会话」不等于"清空界面"**

§7 说某库无会话时"清空为空白会话"。但 `agentSessionId` 有值而 `agentMessages` 为空，与 `agentSessionId` 为 `undefined`，在 UI 上是两种状态（后者会让部分控件进入"无会话"分支）。规则定死：

- 无最近会话时：`agentSessionId = undefined`，`agentMessages = []`，`live = undefined`；
- **不调用** `createSession`。后端会话在用户发出第一条消息时才创建（`sendAgent` 里现有逻辑），避免切换库就在库里堆一堆空会话。

**(b) 自动恢复不能和"用户在抽屉里点会话"打架**

用户手动 `loadAgentSession(x)` 时，`x.database` 会写进 `agentDatabase`（现有行为）。若这正好等于"库变了"，会自动恢复逻辑再次触发，把刚点的会话又换成"最近一条"。规则定死：

- 自动恢复加一次性抑制标记（`suppressAutoRestore`），在 `loadAgentSession` 内部置位、完成后清除；
- 或者等价地：自动恢复只在**库值变化**且**当前会话不属于该库**时才动作。采用前者，判断更直白。

**(c) `homeDatabase` 缺省值从哪来**

首页首次挂载、或刚连接到新库时 `homeDatabase` 可能是空串。规则定死：

- 空串时回落到"该连接上次看的库"（新的 UI prefs 表），再回落到连接默认库，再回落到第一个库；
- 即 §12 的 prefs 不能只在写时保存，**首次进入就要能读出来**，否则重启后首页会跳回默认库，用户会以为没记住。

这三条已写进验收标准之外的实现约束，实现时按此执行，不再另做判断。

## 10. 影响面

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/store.ts` | 新增 `homeDatabase` + setter；`sessionsForScope`；自动恢复 effect 的触发点；AI 入口守卫 |
| `apps/desktop/src/components/Sidebar.tsx` | 点库写 `homeDatabase`；高亮读 `homeDatabase` |
| `apps/desktop/src/components/Welcome.tsx` | 首页作用域读 `homeDatabase`；AI 入口加守卫 |
| `apps/desktop/src/components/AgentPanel.tsx` | 两处会话列表改 `sessionsForScope`；顶部不一致提示；库选择器只写 `agentDatabase` |
| `apps/desktop/src/lib/api.ts` | `sessions()` 支持 `connectionId`/`database` |
| `apps/gateway/src/store.ts` / `routes.ts` | `listSessions` 过滤 + 路由参数 |
| `apps/desktop/src/lib/dbHome.ts` | `resolveHomeDatabase` 改读 `homeDatabase` |

**保持兼容**：`GET /agent/sessions` 不传参数时行为不变；`welcome-*` 测试钩子不变。

## 11. 验收标准

1. 左侧点 `friendship` → 首页切到 friendship；Agent 面板目标库**不变**，并出现不一致提示。
2. 抽屉里只列 friendship 的会话；media 的会话不出现。
3. Agent 在跑时点首页「让 AI 体检」→ 出现提示，且目标库、会话、输入框均未改变。
4. 把 Agent 目标库切到某库 → 自动加载该库最近一条会话；该库无会话则显示空白新会话。
5. 同库点「新会话」→ 另起一条，旧会话仍在列表里。
6. `e2e` 230 项全通过；`GET /agent/sessions` 无参数时返回数量不变。
7. 重启应用后，首页仍停在关闭前看的那个库（验证 §9.5(c)）。

## 11.5 手动验证脚本

验收标准里 §11.3（运行态互斥）和 §11.4（自动恢复）很难靠 e2e 覆盖，需手动跑一遍：

| 步骤 | 期望 |
|---|---|
| 问一个耗时问题，趁回答中点首页「让 AI 体检」 | toast 提示；目标库、会话、输入框都不变 |
| 等回答结束后再点 | 正常对齐并执行 |
| Agent 下拉切到 friendship | 自动加载 friendship 最近会话；无则空白 |
| 抽屉查看 | 只列 friendship 会话 |
| 左侧点 media | 首页换库；Agent 目标库不变；顶部出现不一致提示 |

## 12. 留给实现者的决定

- 自动恢复时如果 `sessionsForScope` 有多条，取 `updatedAt` 最新的一条（`listSessions` 已按 `updated_at DESC` 排序，取第 0 条即可）。
- 不一致提示的措辞可调，但必须同时出现**两个库名**。
- `homeDatabase` 的 UI prefs 键名沿用 `agentDatabaseByConnection` 的形态（按连接记忆每个连接上次看的库），需与旧的 `agentDatabaseByConnection` 分开存，避免旧数据把两个字段又绑回去。