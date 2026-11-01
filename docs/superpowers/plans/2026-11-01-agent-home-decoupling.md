# 首页与 Agent 解耦 · 会话按库隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆开首页作用域与 Agent 目标库，让每个库拥有自己的会话列表，并在换库时自动恢复该库最近一条会话。

**Architecture:** 在 store 里把单一 `agentDatabase` 拆成 `homeDatabase`（首页）与 `agentDatabase`（Agent），各自只有一个写者。网关 `listSessions` 增加可选 `connectionId`/`database` 过滤，前端派生 `sessionsForScope` 供抽屉与「最近」共用。自动恢复与运行态互斥集中到 store 的一个 action 里，组件只调用它。

**Tech Stack:** TypeScript、React 18、zustand、node:test、Electron+Vite、node:sqlite

**Spec:** `docs/18-agent-home-decoupling.md`

## Global Constraints

- `GET /agent/sessions` 不传参数时行为必须与现状一致（e2e 230 项不得回归）。
- 测试框架：网关用 `node:test` + `node:assert/strict` + `mkdtempSync` 临时目录；桌面端无单测框架，改动靠 `npx tsc --noEmit` 与手测脚本验证。
- 文案一律中文，与现有界面一致。
- 不改会话存储 schema（`database`/`connection_id` 列已存在）。
- 不新增第三方依赖。
- `agentDatabase` 的持久化仍走 `setAgentDatabase` → `api.updateSession`；`homeDatabase` 走 `saveUiPrefs`，两套 key 不得互相读取。

## Review Focus

- **同库多会话下的自动恢复**：用户在抽屉里点了一条旧会话，`loadAgentSession` 会把它的 `database` 写进 `agentDatabase`；若该值恰好"变了"，自动恢复会再把用户刚点的会话换成"最近一条"。必须抑制。
- **运行中切库**：Agent 正在 `streaming` 时用户切库。若只改目标库不换会话，下一次提问会在旧会话里落到新库上，答案指向错库。应拒绝切换而非静默接受。
- **旧会话无 `database`**：`database` 为空的会话在**任何**库下都应可见，否则用户会以为记录消失。
- **重启后首页回到默认库**：`homeDatabase` 只在写入时保存、首次挂载不读回，用户会认为"没记住"。
- **空白会话误建**：切换到一个没有会话的库时若调用 `createSession`，切换几次就堆几个空会话。
- **库名大小写/大小写敏感引擎**：MySQL 在 Linux 上库名大小写敏感，比较时不得做 `toLowerCase()` 归一。

---

### Task 1: 网关按库查询会话

**Files:**
- Modify: `apps/gateway/src/store.ts:1135`（`listSessions`）
- Modify: `apps/gateway/src/routes.ts:2234`
- Test: `apps/gateway/test/session-database.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `AgentSessionMeta { connectionId?, database?, updatedAt }`、`SessionRow`
- Produces: `store.listSessions(opts?: { connectionId?: string; database?: string; limit?: number }): AgentSessionMeta[]`；HTTP `GET /agent/sessions?connectionId=&database=`

- [ ] **Step 1: 写失败测试**

在 `apps/gateway/test/session-database.test.ts` 末尾追加：

```ts
test('会话可按连接与库过滤，不传参数时返回全部', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    const media = store.createSession({ connectionId: 'c1', database: 'media' });
    const friend = store.createSession({ connectionId: 'c1', database: 'friendship' });
    const other = store.createSession({ connectionId: 'c2', database: 'media' });
    const noDb = store.createSession({ connectionId: 'c1' });

    assert.equal(store.listSessions().length, 4);

    const c1 = store.listSessions({ connectionId: 'c1' }).map((s) => s.id).sort();
    assert.deepEqual(c1, [media.id, friend.id, noDb.id].sort());

    const c1media = store.listSessions({ connectionId: 'c1', database: 'media' }).map((s) => s.id);
    assert.deepEqual(c1media, [media.id]);

    // 未绑定库的旧会话在任何库下都可见
    const c1friend = store.listSessions({ connectionId: 'c1', database: 'friendship' }).map((s) => s.id).sort();
    assert.deepEqual(c1friend, [friend.id, noDb.id].sort());

    assert.equal(other.database, 'media');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --workspace apps/gateway run test -- session-database 2>&1 | tail -20`
Expected: FAIL —— `store.listSessions({...})` 的实参被忽略，`c1media` 长度 ≠ 1

- [ ] **Step 3: 实现过滤**

`apps/gateway/src/store.ts`，`listSessions` 改为（保留位置参数兼容：旧签名第一个参数是 `limit: number`）：

```ts
listSessions(opts: number | { connectionId?: string; database?: string; limit?: number } = 60): AgentSessionMeta[] {
  const o = typeof opts === 'number' ? { limit: opts } : opts;
  const where: string[] = ['archived = 0'];
  const args: (string | number)[] = [];
  if (o.connectionId) { where.push('connection_id = ?'); args.push(o.connectionId); }
  // 未绑定库的旧会话在任何库下都可见
  if (o.database) { where.push('(database IS NULL OR database = ?)'); args.push(o.database); }
  const limit = Math.min(200, o.limit ?? 60);
  return this.all<SessionRow>(
    `SELECT * FROM agent_sessions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`,
    args,
  ).map((r) => this.rowToSession(r));
}
```

路由 `apps/gateway/src/routes.ts:2234`：

```ts
router.get('/agent/sessions', (req, res) =>
  res.json({
    sessions: store.listSessions({
      connectionId: typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined,
      database: typeof req.query.database === 'string' ? req.query.database : undefined,
    }),
  }),
);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --workspace apps/gateway run test -- session-database 2>&1 | tail -20`
Expected: PASS，含原有用例

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/store.ts apps/gateway/src/routes.ts apps/gateway/test/session-database.test.ts
git commit -m "feat(gateway): 会话列表支持按连接与库过滤"
```

---

### Task 2: 前端 API 与会话作用域派生

**Files:**
- Modify: `apps/desktop/src/lib/api.ts:685`
- Modify: `apps/desktop/src/store.ts`（`refreshSessions`、新增 `sessionsForScope`）

**Interfaces:**
- Consumes: Task 1 的 `GET /agent/sessions?connectionId=&database=`
- Produces: `api.sessions(opts?: { connectionId?: string; database?: string }): Promise<{ sessions: AgentSessionMeta[] }>`；`store.sessionsForScope(connectionId?: string, database?: string): AgentSessionMeta[]`

- [ ] **Step 1: 扩展 api.sessions**

`apps/desktop/src/lib/api.ts:685` 改为按参数拼 query（无参数时 URL 与现在完全一致）：

```ts
sessions: (opts: { connectionId?: string; database?: string } = {}) => {
  const qs = new URLSearchParams();
  if (opts.connectionId) qs.set('connectionId', opts.connectionId);
  if (opts.database) qs.set('database', opts.database);
  const suffix = qs.toString() ? `?${qs}` : '';
  return request<{ sessions: AgentSessionMeta[] }>(`/agent/sessions${suffix}`);
},
```

- [ ] **Step 2: 加派生 action**

**重要**：`refreshSessions()` **保持无参**（拉全量），不要给它加作用域参数。否则全局 `sessions` 会被写成"某个库的子集"，后续任何按库过滤都建立在错误基础上——切回另一个库时会看到空列表。过滤只在前端派生层做。

`apps/desktop/src/store.ts` 在 `refreshSessions` 之后新增：

```ts
sessionsForScope: (connectionId, database) => {
  return get().sessions.filter(
    (s) =>
      (!connectionId || !s.connectionId || s.connectionId === connectionId) &&
      (!database || !s.database || s.database === database),
  );
},
```

接口声明同步：

```ts
sessionsForScope: (connectionId?: string, database?: string) => AgentSessionMeta[];
```

`refreshSessions` 的签名与实现**保持原样不动**。

注意：`sessionsForScope` 对 `s.connectionId` 为空的历史会话同样放行，理由同 `database`——不能把未绑定连接的老记录藏起来。比较不做大小写归一（MySQL 在 Linux 上库名大小写敏感）。

- [ ] **Step 3: 类型检查**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 无输出（0 错误）

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/lib/api.ts apps/desktop/src/store.ts
git commit -m "feat(desktop): 会话查询支持作用域参数并派生 sessionsForScope"
```

---

### Task 3: 拆分 homeDatabase 与 agentDatabase

**Files:**
- Modify: `apps/desktop/src/store.ts`（`UiPrefs`、初始 state、`setHomeDatabase`、`selectConnection`、`setAgentDatabase`）
- Modify: `apps/desktop/src/components/Sidebar.tsx`（点库与高亮）
- Modify: `apps/desktop/src/lib/dbHome.ts`（`resolveHomeDatabase` 入参改为 homeDatabase）

**Interfaces:**
- Consumes: 无
- Produces: `store.homeDatabase: string`；`store.setHomeDatabase(database: string): void`；`UiPrefs.homeDatabaseByConnection?: Record<string, string>`；`resolveHomeDatabase(connection, schemas, preferredHome)` 签名不变但语义改为"读 homeDatabase"

- [ ] **Step 1: 加字段与 setter**

`store.ts`：

1. `UiPrefs` 增加 `homeDatabaseByConnection?: Record<string, string>;`
2. 初始 state 增加 `homeDatabase: ''`
3. 新增 action：

```ts
setHomeDatabase: (database) => {
  const connId = get().activeConnectionId;
  const homeDatabaseByConnection = { ...(readUiPrefs().homeDatabaseByConnection ?? {}) };
  if (connId && database) homeDatabaseByConnection[connId] = database;
  else if (connId) delete homeDatabaseByConnection[connId];
  saveUiPrefs({ homeDatabaseByConnection });
  set({ homeDatabase: database });
},
```

4. `selectConnection` 换连接时同时回落首页库（§9.5(c) 的回落链）：

```ts
selectConnection: (id) => {
  const previous = get().activeConnectionId;
  if (previous === id) return void (get().schemas[id] || void get().loadSchema(id));
  const rememberedHome = readUiPrefs().homeDatabaseByConnection?.[id] ?? '';
  set({ activeConnectionId: id, agentDatabase: rememberedAgentDatabase(id), homeDatabase: rememberedHome });
  if (!get().schemas[id]) void get().loadSchema(id);
},
```

- [ ] **Step 2: 侧栏改为只写 homeDatabase**

`Sidebar.tsx` 库节点点击：把 `setAgentDatabase(schema.name)` 换成 `setHomeDatabase(schema.name)`；高亮条件里的 `agentDatabase` 换成 `homeDatabase`。

- [ ] **Step 3: 首页读 homeDatabase**

`Welcome.tsx` 与 `dbHome.ts` 的作用域来源由 `agentDatabase` 换成 `homeDatabase`。`Welcome` 里 `askAi` 仍需在**守卫通过后**对齐 `agentDatabase`（Task 5 处理），本任务只改读取来源，先让 `askAi` 保持写入 `setAgentDatabase(database)` 不变。

- [ ] **Step 4: 类型检查 + 手测**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 0 错误

手测：左侧点 `friendship` → 首页切库；Agent 顶部库**不变**。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/store.ts apps/desktop/src/components/Sidebar.tsx apps/desktop/src/components/Welcome.tsx apps/desktop/src/lib/dbHome.ts
git commit -m "refactor(desktop): 首页作用域与 Agent 目标库拆成两个字段"
```

---

### Task 4: 换库自动恢复最近会话

**Files:**
- Modify: `apps/desktop/src/store.ts`（`setAgentDatabase` 内联触发、`loadAgentSession` 抑制标记）

**Interfaces:**
- Consumes: Task 2 `sessionsForScope`、Task 3 `homeDatabase`
- Produces: `store.setAgentDatabase(database: string): Promise<void>`（由 `void` 改为可等待）；内部 `suppressAutoRestore` 模块级布尔

- [ ] **Step 1: 加抑制标记与恢复逻辑**

`store.ts` 模块顶部加 `let suppressAutoRestore = false;`。

`loadAgentSession` 首尾包一层：

```ts
loadAgentSession: async (id) => {
  suppressAutoRestore = true;
  try {
    /* 原实现不变 */
  } finally {
    suppressAutoRestore = false;
  }
},
```

`setAgentDatabase` 改为：

```ts
setAgentDatabase: async (database) => {
  const previous = get().agentDatabase;
  set({ agentDatabase: database });
  const id = get().agentSessionId;
  if (id) void api.updateSession(id, { database }).catch(() => undefined);
  if (previous === database || suppressAutoRestore) return;
  await get().restoreSessionForScope();
},
```

- [ ] **Step 2: 实现 restoreSessionForScope**

```ts
restoreSessionForScope: async () => {
  const { activeConnectionId, agentDatabase } = get();
  await get().refreshSessions();   // 全量刷新，过滤交给 sessionsForScope
  const recent = get().sessionsForScope(activeConnectionId, agentDatabase)[0];
  if (recent) return void get().loadAgentSession(recent.id);
  // 该库没有会话：清成空白，不建后端会话（首条消息时才创建）
  set({ agentSessionId: undefined, agentSessionMeta: undefined, agentMessages: [], agentFollowUps: [], live: undefined, approval: undefined });
},
```

接口声明：`restoreSessionForScope: () => Promise<void>;`，`setAgentDatabase: (database: string) => Promise<void>;`

**调用点适配**：`AgentPanel.tsx:1385` 是 `onChange={setAgentDatabase}`，改成异步后仍能通过类型检查（返回值被忽略），但语义上应显式写 `onChange={(db) => void setAgentDatabase(db)}`，避免"看起来同步、其实异步"的误读。其余调用点同样加 `void`。

**运行中不自动恢复**：`restoreSessionForScope` 开头加

```ts
const live = get().live;
if (live && (live.status === 'streaming' || live.status === 'awaiting')) return;
```

- [ ] **Step 3: 类型检查**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 4: 手测自动恢复**

1. Agent 下拉切到 `friendship` → 自动载入 friendship 最近会话（若无则空白）
2. 抽屉里手动点一条 media 会话 → 停在所点会话，**不被**自动恢复抢走
3. 重启应用 → 首页仍在关闭前那个库

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/store.ts
git commit -m "feat(desktop): 换库自动恢复该库最近会话"
```

---

### Task 5: 运行态互斥守卫

**Files:**
- Modify: `apps/desktop/src/store.ts`（新增 `requestAgentTask`）
- Modify: `apps/desktop/src/components/Welcome.tsx`（所有 AI 入口改调 action）

**Interfaces:**
- Consumes: Task 3 `setHomeDatabase`、Task 4 `setAgentDatabase`
- Produces: `store.requestAgentTask(prompt: string): boolean` —— 返回 `true` 表示已接受（已对齐库并填入 prompt），`false` 表示被运行态拒绝

- [ ] **Step 1: 实现守卫 action**

```ts
/** 首页等外部入口触发 Agent 的唯一通道：先判运行态，再对齐库，最后填词。 */
requestAgentTask: (prompt) => {
  const live = get().live;
  if (live && (live.status === 'streaming' || live.status === 'awaiting')) {
    get().notify('warn', 'Agent 正在回答，请等这一轮结束再操作');
    return false;
  }
  const target = get().homeDatabase;
  if (target && target !== get().agentDatabase) void get().setAgentDatabase(target);
  set({ agentOpen: true });
  get().prefillAgent(prompt);
  return true;
},
```

- [ ] **Step 2: 首页改用它**

`Welcome.tsx` 的 `askAi(prompt)` 改为：

```ts
const askAi = (prompt: string) => {
  requestAgentTask(prompt);
};
```

表行点击 `openTable` 里的 `setAgentDatabase(...)` 一并去掉（首页不再写 Agent 字段）。

- [ ] **Step 3: 类型检查**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 4: 手测互斥**

问一个耗时问题，趁回答中点首页「让 AI 体检」→ 出现 toast；目标库、会话、输入框均未变。回答结束后再点 → 正常执行。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/store.ts apps/desktop/src/components/Welcome.tsx
git commit -m "feat(desktop): 首页触发 Agent 前检查运行态"
```

---

### Task 6: 会话列表按库过滤 + 不一致提示

**Files:**
- Modify: `apps/desktop/src/components/AgentPanel.tsx`（抽屉、「最近」区块、顶部提示）
- Modify: `apps/desktop/src/styles/dashboard.css` 或 `app.css`（提示行样式）

**Interfaces:**
- Consumes: Task 2 `sessionsForScope`、Task 3 `homeDatabase`
- Produces: 无新接口

- [ ] **Step 1: 两处列表换作用域**

`AgentPanel.tsx:1199` 附近 `filteredSessions` 改为先取 `sessionsForScope(activeConnectionId, agentDatabase)` 再按 `sessionQuery` 过滤；`:1438` 的 `sessions.slice(0,3)` 同样改用该结果。

- [ ] **Step 2: 顶部不一致提示**

在 Agent 面板头部渲染，仅当 `homeDatabase && agentDatabase && homeDatabase !== agentDatabase`：

```tsx
<div className="agent-scope-mismatch" data-testid="agent-scope-mismatch">
  首页在看 <b>{homeDatabase}</b>，Agent 瞄准 <b>{agentDatabase}</b>
  <button className="btn ghost small" onClick={() => void setAgentDatabase(homeDatabase)}>对齐到 {homeDatabase}</button>
</div>
```

样式：单行、低对比边框、`font-size: 10.5px`，不与正文抢注意力。

- [ ] **Step 3: 类型检查**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 4: 手测**

左侧点 `media` → 首页换库、Agent 不变、顶部出现提示；点「对齐到 media」→ 提示消失且自动恢复 media 会话。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/components/AgentPanel.tsx apps/desktop/src/styles/*.css
git commit -m "feat(desktop): 会话列表按库过滤并提示作用域不一致"
```

---

### Task 7: 全量回归

**Files:** 无新增

- [ ] **Step 1: 文档契约与类型检查**

Run: `npm run verify:docs && npm run typecheck`
Expected: `ALL GREEN`，tsc 无输出

- [ ] **Step 2: 单元测试**

Run: `npm test 2>&1 | tail -12`
Expected: `fail 0`

- [ ] **Step 3: 构建并跑 e2e**

Run: `npm run build:core && npm --workspace apps/desktop run build && node scripts/e2e.mjs 2>&1 | tail -12`
Expected: `230/230 E2E checks passed`，且 `no browser console errors`

- [ ] **Step 4: 按 §11.5 手动验证脚本逐条走一遍**

- [ ] **Step 5: 更新文档**

`docs/18-agent-home-decoupling.md` 状态改为已实现；`docs/17-welcome-home-design.md` §3.1.1 的"已知副作用（有意接受）"改为"已解耦，见 18"。

- [ ] **Step 6: 提交**

```bash
git add docs/18-agent-home-decoupling.md docs/17-welcome-home-design.md
git commit -m "docs: 标记首页与 Agent 解耦已实现"
```