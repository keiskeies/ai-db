# 结构变更事件（schema_changed）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让结构变更经既有 WebSocket 广播到桌面 / Web / 移动端，客户端自动重载 schema，并把清缓存从"每处记得调"收进 `manager.query()` 这个唯一咽喉。

**Architecture:** 网关新增 `GatewayEvents` 内存事件总线；`ConnectionManager` 持可选引用，在 `invalidate()`（驱动类变更）与 `query()`（SQL DDL 判定）两处发射；`server.ts` 订阅并广播到 `wss.clients`。客户端各自维护"收到事件→重载该连接 schema"的策略：桌面端回合内延迟到 `done` 合并、1s 节流、在飞去重加重放、重连补偿；移动端在飞去重加重放 + `onopen` 补偿。

**Tech Stack:** TypeScript、`ws`（已有依赖）、node:test + node:assert/strict、React 18 + zustand、React Native (Expo)、Vite、Electron

**Spec:** `docs/19-schema-change-events.md`

## Global Constraints

- 不新增第三方依赖。`ws` 已是 `apps/gateway` 依赖；桌面端用浏览器原生 `WebSocket`。
- `AgentEvent`（`packages/core/src/agent/types.ts:168`）**不得增加成员**。`schema_changed` 用网关内部类型。
- WS 鉴权沿用 `/ws?token=`，未授权以 code `4401` 关闭（`server.ts`）；客户端遇 4401 不重连。
- 事件粒度到 `connectionId`，不带 `database`。
- 文案一律中文。
- 网关测试：`node:test` + `node:assert/strict` + `mkdtempSync` 临时目录，用 `createGateway({ ... })` + `listenRandom`（`apps/gateway/test/helpers.ts`）。
- 桌面端**无单测框架**，改动靠 `npm --workspace apps/desktop run typecheck` 与手测验证。
- 不修改 `POST /query` 的请求/响应契约。
- `npm run e2e`（约 230 项断言）不得回归。

## Review Focus

- **双发**：`query()` 内新增发射后，现有 14 处"DML/DDL 之后紧跟 invalidate"会重复触发。任务 3 的「只发一次」测试是这条的看门狗。
- **事务可见性**：事务内 DDL 尚未提交，别的会话看不到。提交前不得发事件；回滚后结构可能恢复，必须发。
- **部分失败**：脚本第 3 条失败时，第 1 条 DDL 已经生效。发射判定要基于「已执行的语句」而非「整段成功」。
- **同名表作用域**：`DesignView.tsx:245` 跨全部库取首个同名表。引入"签名变了就静默重置"后，MySQL 两库同名表会互相覆盖编辑器。作用域必须先修对。
- **移动端丢弃在飞事件**：在飞请求可能早于 `invalidate` 发出、返回旧结构，丢弃事件即永久丢变更。必须 pending 重放。
- **空 token / 4401 无限重连**：生产 Web 构建无 `#token=` 时 `TOKEN` 为 `''`。必须终态化。
- **回合内事件风暴**：Agent 每改一张表间隔数秒，300ms 防抖合并不了一个回合。必须回合内延迟到 `done`。

## 关键的既有事实（实现者请先读，避免踩坑）

- `manager.query()` 的 `return` 位于 `try` 内部、`finally` 之后**没有** return。发射逻辑必须放在 `try` 里 `return` 之前，否则 `return` 先退出。
- 事务变量名是 **`txSession`**（`manager.ts:1113-1115`：`candidate` → `txSession`），不是 `session`。
- `QueryOptions.actor` 是**必填**（`manager.ts:70`），所以 `opts.actor` 直接可用，不需要 `?? 'user'`。
- `GatewayInstance` **不暴露 `executor`**（`server.ts:26-39`）。测试里要自己 `new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings())`。
- `POST /tx/begin` 要 `{ connectionId, sessionId }`；`/tx/commit`、`/tx/rollback` 只要 `{ sessionId }`；`POST /query` 接受可选 `sessionId` 走该事务。
- `classifyStatement` 已从 `@aidb/core` 导出（`packages/core/src/index.ts:7` → `export * from './sql/classify'`）。`COMMENT`、`ALTER`、`CREATE`、`DROP`、`TRUNCATE` 分别归为 `ddl` / `destructive`。

---

### Task 1: 网关事件总线

**Files:**
- Create: `apps/gateway/src/events.ts`
- Test: `apps/gateway/test/schema-events.test.ts`

**Interfaces:**
- Produces:
  - `type SchemaChangeCause = 'agent' | 'user'`
  - `interface SchemaChangedEvent { type: 'schema_changed'; connectionId: string; cause: SchemaChangeCause; at: string }`
  - `class GatewayEvents { emitSchemaChanged(event: SchemaChangedEvent): void; onSchemaChanged(listener: (event: SchemaChangedEvent) => void): () => void }`

- [ ] **Step 1: 写失败测试**

创建 `apps/gateway/test/schema-events.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayEvents, type SchemaChangedEvent } from '../src/events';

test('事件总线把事件送达每个订阅者', () => {
  const bus = new GatewayEvents();
  const first: SchemaChangedEvent[] = [];
  const second: SchemaChangedEvent[] = [];
  bus.onSchemaChanged((event) => first.push(event));
  bus.onSchemaChanged((event) => second.push(event));

  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'agent', at: '2026-11-02T00:00:00.000Z' });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].connectionId, 'c1');
  assert.equal(first[0].cause, 'agent');
});

test('取消订阅后不再收到事件', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  const off = bus.onSchemaChanged((event) => seen.push(event));
  off();
  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' });
  assert.equal(seen.length, 0);
});

test('一个监听器抛错不影响其它监听器', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  bus.onSchemaChanged(() => {
    throw new Error('boom');
  });
  bus.onSchemaChanged((event) => seen.push(event));

  assert.doesNotThrow(() =>
    bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' }),
  );
  assert.equal(seen.length, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: FAIL —— 找不到模块 `../src/events`。

- [ ] **Step 3: 实现**

创建 `apps/gateway/src/events.ts`：

```ts
/**
 * 结构变更事件总线。
 *
 * 只负责「把结构变了这个事实送到所有在线客户端」。不带变更明细（见设计文档 §2 非目标），
 * 由客户端自己重新拉一次 schema。放在网关而非 @aidb/core：只有网关生产这类事件，
 * 客户端只需要事件形状，用本地 interface 声明即可。
 */
export type SchemaChangeCause = 'agent' | 'user';

export interface SchemaChangedEvent {
  type: 'schema_changed';
  connectionId: string;
  cause: SchemaChangeCause;
  /** ISO 时间戳，仅用于日志与排障。 */
  at: string;
}

export class GatewayEvents {
  private listeners = new Set<(event: SchemaChangedEvent) => void>();

  emitSchemaChanged(event: SchemaChangedEvent): void {
    for (const listener of this.listeners) {
      // 一个坏监听不能拖垮触发它的那次 DB 操作：DB 已经改完了，事件只是通知。
      try {
        listener(event);
      } catch (err) {
        console.error('[events] schema_changed listener failed', err);
      }
    }
  }

  onSchemaChanged(listener: (event: SchemaChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: PASS，3 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/events.ts apps/gateway/test/schema-events.test.ts
git commit -m "feat(gateway): 结构变更事件总线"
```

---

### Task 2: invalidate 携带 cause 并经 WS 广播

**Files:**
- Modify: `apps/gateway/src/manager.ts`（构造函数、`invalidate`、内部 12 处调用）
- Modify: `apps/gateway/src/server.ts`（创建 bus、注入 manager、订阅并广播）
- Test: `apps/gateway/test/schema-events.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `GatewayEvents`、`SchemaChangedEvent`、`SchemaChangeCause`
- Produces:
  - `new ConnectionManager(store, config, settings, events?: GatewayEvents)`
  - `manager.invalidate(connectionId: string, cause?: SchemaChangeCause): void`（默认 `'user'`）
  - `GatewayInstance` 增加字段 `events: GatewayEvents`

- [ ] **Step 1: 写失败测试**

把 `apps/gateway/test/schema-events.test.ts` 顶部替换为下面内容（原 Task 1 的 3 个测试保留在下方）：

```ts
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { listenRandom } from './helpers';
import { GatewayEvents, type SchemaChangedEvent } from '../src/events';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

const home = mkdtempSync(join(tmpdir(), 'aidb-schema-events-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'schema-events-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'schema-events-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
// GatewayInstance 不暴露 executor，测试自己建一个，与其它测试文件的写法一致。
const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function connectWs(): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/** 在 fn 执行期间收集 schema_changed 事件。开头留 120ms 让订阅先就位。 */
async function collect(fn: () => Promise<void>, waitMs = 400): Promise<any[]> {
  const ws = await connectWs();
  const received: any[] = [];
  ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fn();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  ws.close();
  return received.filter((item) => item.type === 'schema_changed');
}

test('invalidate 会把 schema_changed 广播到已连接的客户端', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    gateway.manager.invalidate(conn.id, 'agent');
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].connectionId, conn.id);
  assert.equal(events[0].cause, 'agent');
  assert.ok(typeof events[0].at === 'string' && events[0].at.length > 0);
});

test('错 token 的 ws 以 4401 被拒', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=wrong-token`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('没有在预期时间内被拒')), 5000);
    ws.once('close', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    ws.once('error', () => undefined);
  });
  assert.equal(code, 4401);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: 第一个新测试 FAIL（`invalidate` 的第二个参数被忽略、且没订阅广播 → 0 次事件）。`4401` 那个 PASS（现状已如此）。

- [ ] **Step 3: 改 `manager.ts`**

3a. 顶部 import 加（放在现有 `import { ... } from './...'` 群中）：

```ts
import { GatewayEvents, type SchemaChangeCause } from './events';
```

3b. 构造函数加第四参（可缺省——多个测试用三参构造）：

```ts
  constructor(
    private store: Store,
    private config: GatewayConfig,
    private settings: () => AppSettings,
    private events?: GatewayEvents,
  ) {
```

3c. 替换 `invalidate` 实现（约第 1196 行）：

```ts
  invalidate(connectionId: string, cause: SchemaChangeCause = 'user'): void {
    this.store.clearSchemaCache(connectionId);
    this.events?.emitSchemaChanged({
      type: 'schema_changed',
      connectionId,
      cause,
      at: new Date().toISOString(),
    });
  }
```

3d. 内部 12 处 `this.invalidate(connectionId);` 全部透传 actor。这些方法都收 `opts: QueryOptions`，`actor` 必填：

```ts
    this.invalidate(connectionId, opts.actor);
```

行号：425 / 454 / 491 / 526 / 565 / 615 / 632 / 662 / 692 / 751 / 790 / 818。

完成后用 `grep -n "this.invalidate(" apps/gateway/src/manager.ts` 确认正好 13 行（12 处调用 + 第 1196 行的签名定义），且调用处都带 `opts.actor`。

- [ ] **Step 4: 改 `server.ts`**

4a. import：

```ts
import { GatewayEvents } from './events';
```

4b. 在 `const manager = new ConnectionManager(...)` 之前建 bus 并注入（第 51 行）：

```ts
  const events = new GatewayEvents();
  const manager = new ConnectionManager(store, config, () => store.getSettings(), events);
```

4c. `GatewayInstance` 接口加字段（第 26-39 行那块）：

```ts
  events: GatewayEvents;
```

4d. 第 221 行的返回对象加 `events`：

```ts
  return { app, server, wss, config, store, manager, events, host, skills, skillWorker, commands, scheduler, close };
```

4e. 在 `WebSocketServer` 创建与 `wss.on('connection', ...)` 之后（同一函数层级，不在回调内）加广播：

```ts
  // 结构变更广播给所有在线客户端。放在 WS 层而不是路由层：
  // 客户端可能通过 /api/query、/api/ddl/execute、Agent 工具或工具箱改结构，
  // 关心的是「结构变了」这个事实，与谁改的无关。
  events.onSchemaChanged((event) => {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(JSON.stringify(event));
    }
  });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: PASS，5 个测试全绿。

- [ ] **Step 6: 跑全量网关测试**

Run: `cd apps/gateway && npm test`

Expected: 全绿。若失败，先确认没有遗漏的 `new ConnectionManager(...)` 三参构造（可缺省，理论上不会失败）。

- [ ] **Step 7: 提交**

```bash
git add apps/gateway/src/manager.ts apps/gateway/src/server.ts apps/gateway/test/schema-events.test.ts
git commit -m "feat(gateway): invalidate 携带 cause 并广播 schema_changed"
```

---

### Task 3: 把 SQL DDL 的发射收进 `query()`，并删掉所有冗余 invalidate

**Files:**
- Modify: `apps/gateway/src/manager.ts`（`query()`）
- Modify: `apps/gateway/src/executor.ts`
- Modify: `apps/gateway/src/routes.ts`
- Modify: `apps/gateway/src/features/routes.ts`
- Modify: `apps/gateway/src/features/tableOps.ts`
- Modify: `apps/gateway/src/features/databaseOps.ts`
- Modify: `apps/gateway/src/features/transfer.ts`
- Test: `apps/gateway/test/schema-events.test.ts`（追加）

**为什么改 `query()` 而不是补路由**：`POST /query`（SQL 窗口）与 `commands/*` 现在**根本不清缓存**。逐路由补是 N 个容易再漏的点；`query()` 是所有 SQL 执行的唯一咽喉。

- [ ] **Step 1: 写失败测试**

追加：

```ts
test('SQL 窗口执行 CREATE TABLE 会发事件（本轮修掉的漏清缓存缺陷）', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    const result = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE wq_probe (id INTEGER PRIMARY KEY)' }),
    });
    assert.equal(result.status, 200);
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
  assert.equal(events[0].cause, 'user');
});

test('纯 SELECT 不发事件', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sql: 'SELECT 1' }) });
  });
  assert.equal(events.length, 0);
});

test('/ddl/execute 只发一次事件（不得与路由层重复）', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    const result = await api('/ddl/execute', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, statements: ['CREATE TABLE ddl_probe (id INTEGER PRIMARY KEY)'] }),
    });
    assert.equal(result.status, 200);
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
});

test('Agent 的 run_sql 跑 DDL 只发一次事件且 cause 为 agent', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    const result = await executor.execute(
      { id: 'call-run-sql', name: 'run_sql', args: { sql: 'CREATE TABLE agent_probe (id INTEGER PRIMARY KEY)' } } as any,
      { sessionId: 'schema-event-session', connectionId: conn.id },
    );
    assert.equal(result.ok, true);
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
  assert.equal(events[0].cause, 'agent');
});

test('工具箱改名只发一次事件（tableOps 不得与 query() 双发）', async () => {
  const conn = gateway.store.listConnections()[0];
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE toolbox_probe (id INTEGER PRIMARY KEY)' }),
  });
  const events = await collect(async () => {
    const result = await api('/tables/ops', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, table: 'toolbox_probe', op: 'rename', newName: 'toolbox_probe_renamed' }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(events.length, 1, `期望恰好 1 次，实际 ${events.length}`);
});
```

> 路由形状已核对：`POST /api/tables/ops` + `{ connectionId, table, op, newName, database?, schema? }`（`apps/gateway/src/features/routes.ts:129`）；`op` 取值 `ddl|rename|duplicate|truncate|empty|drop|maintenance`（无 `create`）。`rename` 走 `ALTER TABLE ... RENAME`，归类 `ddl`。前面的 `CREATE TABLE` 不在 `collect` 窗口内，不会污染计数。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: 第 1 个新测试 FAIL（0 次）；第 2、5 个 PASS；第 3、4 个 FAIL（2 次，双发）。

- [ ] **Step 3: 在 `query()` 内发射**

`apps/gateway/src/manager.ts` 顶部 import 补 `classifyStatement`（加进现有 `@aidb/core` 那个大 import 列表，按字母序放在 `classifySearch` 之后）：

```ts
  classifyStatement,
```

**位置很关键**：`query()` 的 `return { sets, messages, durationMs }` 在 `try` 内部（第 1138 行），`finally` 里只写历史。所以要在 `finally` 里发射，用「已执行的语句」判定，这样部分失败也能正确通知。

3a. 在 `let failure: Error | undefined;`（第 1118 行）后加一行：

```ts
    const applied: string[] = [];
```

3b. 在循环里 `sets.push(result);` 之后加：

```ts
          applied.push(statement);
```

3c. 在 `finally` 块内、现有 `if (!failure && sets.length) { ... }` **之外**（同层级，放在它后面）加：

```ts
      // 结构变更必须清 schema 缓存并广播。
      //
      // 判定放在这里而不是各个路由：/query（SQL 窗口）与 commands/* 此前根本没清缓存，
      // 建完表 30 秒内服务端一直返回旧结构，客户端刷新也没用。逐个路由补是 N 个会再漏的点，
      // 而这里是所有 SQL 执行的唯一咽喉。
      //
      // 用 applied（已执行成功并落库的语句）而不是 statements 判定：脚本第 3 条失败时
      // 第 1 条 DDL 已经生效，按整段失败跳过就等于永远不通知。
      //
      // 已经由调用方显式 invalidate 的路径必须删掉它们自己那处（见 Step 4），
      // 否则一次操作发两遍事件、客户端刷两遍全库。
      const touchesSchema = applied.some((statement) => {
        const kind = classifyStatement(statement).kind;
        return kind === 'ddl' || kind === 'destructive';
      });
      if (touchesSchema) {
        // 事务内还没提交，别的会话看不到，先记账等 COMMIT。
        if (txSession) txSession.schemaDirty = true;
        else this.invalidate(connectionId, opts.actor);
      }
```

`txSession` 是 `const`（第 1114 行），`finally` 能访问到，无需改动。

3d. `txSessions` 类型加字段（第 78 行）：

```ts
  private txSessions = new Map<
    string,
    { connectionId: string; database?: string; startedAt: number; lastUsedAt: number; schemaDirty?: boolean }
  >();
```

- [ ] **Step 4: 删除所有与 `query()` 重复的 invalidate**

规则：**紧跟 `manager.query(...)` 之后、针对同一连接的 invalidate 一律删除**（`query()` 已经发过了）；**走驱动方法（`driver.xxx` / `runParams`）的保留**。

必须删除（14 处）：

| 文件 | 行 | 上下文 |
|---|---|---|
| `executor.ts` | 387 | `case 'commit_transaction'` — **留给 Task 4 删**，本任务先跳过 |
| `executor.ts` | 394 | `case 'rollback_transaction'` — **留给 Task 4 删**，本任务先跳过 |
| `executor.ts` | 427 | `case 'run_sql'`（连同上两行注释） |
| `executor.ts` | 864 | `case 'create_table'` |
| `executor.ts` | 905 | `case 'alter_table'` |
| `executor.ts` | 925 | `case 'drop_object'` |
| `executor.ts` | 981 | `case 'manage_index'` |
| `executor.ts` | 1348 | `case 'transfer_data'`（transfer 内部的 `CREATE TABLE` 已发事件） |
| `routes.ts` | 1931 | `/ddl/execute` |
| `features/routes.ts` | 233 | `schema.sync` |
| `features/routes.ts` | 267 | `data.transfer` |
| `features/routes.ts` | 321 | `data.transfer` 流式 |
| `features/routes.ts` | 541 | 备份恢复 |
| `features/tableOps.ts` | 187 | 表操作 |
| `features/databaseOps.ts` | 88 | 库操作 |
| `features/transfer.ts` | 132 | 建表后 |

必须保留：

| 文件 | 行 | 原因 |
|---|---|---|
| `manager.ts` | 425…818（12 处） | 走 `driver.*`，不经过 `query()`。Task 2 已加 cause |
| `executor.ts` | 1029 `import_csv` | `importCsv` 内部用 `runParams`，不发事件 |
| `routes.ts` | 269 | 连接更新后关闭连接（无 `query()`） |
| `routes.ts` | 372 | `/connections/:id/refresh` 用户显式刷新（无 `query()`） |
| `routes.ts` | 1994 | `/import`（`importCsv` → `runParams`，不发事件） |
| `features/replace.ts` | 77 | `runParams`（不发事件）。数据替换本不改结构，保留是无害的既有行为 |

`executor.ts:427` 要删的完整片段（连同注释）：

```ts
        // 不能用行首正则判断 DDL：脚本以注释或空白开头是模型写 DDL 的常态，
        // 那样会漏掉建表，导致 schema 缓存不失效、下一步 inspect_schema 看到旧结构。
        if (classifySql(sql).statements.some((s) => s.kind === 'ddl' || s.kind === 'destructive')) {
          this.manager.invalidate(conn.id);
        }
```

删完后 `classifySql` 若在 `executor.ts` 里没有其它用处，`tsc` 会报未使用——保留 import 会触发 `noUnusedLocals` 的话就一并删。先跑 `npm run typecheck` 看结果再决定（`run_sql` 的 `dryRun` 分支还在用它，多半仍需要）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: PASS，10 个测试全绿。

- [ ] **Step 6: 跑全量网关测试与类型检查**

Run: `cd apps/gateway && npm test && npm run typecheck`

Expected: 全绿。若 `import_csv` / `transfer_data` / 备份恢复的旧测试失败，说明删除范围超出预期，恢复对应的那一处。

- [ ] **Step 7: 提交**

```bash
git add apps/gateway/src/manager.ts apps/gateway/src/executor.ts apps/gateway/src/routes.ts apps/gateway/src/features/
git commit -m "fix(gateway): SQL DDL 统一在 query() 清缓存并发事件，补上 /query 与命令工作流的漏清"
```

---

### Task 4: 事务内 DDL 延迟到提交

**Files:**
- Modify: `apps/gateway/src/manager.ts`（`commitTransaction`、`rollbackTransaction`）
- Modify: `apps/gateway/src/executor.ts`（删除 2 处冗余 invalidate）
- Test: `apps/gateway/test/schema-events.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的 `txSession.schemaDirty`
- Produces:
  - `commitTransaction(sessionId: string, actor?: SchemaChangeCause)`
  - `rollbackTransaction(sessionId: string, actor?: SchemaChangeCause)`

- [ ] **Step 1: 写失败测试**

追加：

```ts
test('事务内 DDL 提交前不发事件，提交后发一次', async () => {
  const conn = gateway.store.listConnections()[0];
  const sessionId = 'schema-tx-1';
  await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sessionId }) });

  const beforeCommit = await collect(async () => {
    const result = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE tx_probe (id INTEGER PRIMARY KEY)', sessionId }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(beforeCommit.length, 0, '未提交时别发事件：别的会话还看不到');

  const afterCommit = await collect(async () => {
    const result = await api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(afterCommit.length, 1, `提交后应发一次，实际 ${afterCommit.length}`);
});

test('事务内 DDL 回滚后发事件（结构可能已回退，客户端要重读）', async () => {
  const conn = gateway.store.listConnections()[0];
  const sessionId = 'schema-tx-2';
  await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sessionId }) });
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: conn.id, sql: 'CREATE TABLE tx_probe2 (id INTEGER PRIMARY KEY)', sessionId }),
  });

  const afterRollback = await collect(async () => {
    const result = await api('/tx/rollback', { method: 'POST', body: JSON.stringify({ sessionId }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
  assert.equal(afterRollback.length, 1);
});

test('没有 DDL 的事务提交不发事件', async () => {
  const conn = gateway.store.listConnections()[0];
  const sessionId = 'schema-tx-3';
  await api('/tx/begin', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sessionId }) });
  await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, sql: 'SELECT 1', sessionId }) });

  const afterCommit = await collect(async () => {
    await api('/tx/commit', { method: 'POST', body: JSON.stringify({ sessionId }) });
  });
  assert.equal(afterCommit.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: 前两个 FAIL（0 次）；第三个 PASS。

- [ ] **Step 3: 改两个事务方法**

`apps/gateway/src/manager.ts`：

3a. `commitTransaction` 签名与实现（第 1037 行起）：

```ts
  async commitTransaction(sessionId: string, actor: SchemaChangeCause = 'user'): Promise<{ sessionId: string; committed: true }> {
    const session = this.txSessions.get(sessionId);
    if (!session) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const driver = await this.driverFor(session.connectionId);
    if (!supportsTransaction(driver)) throw new DbError('驱动不再支持事务', { code: 'UNSUPPORTED_ENGINE' });
    await driver.commitTransaction(sessionId);
    this.txSessions.delete(sessionId);
    // 事务里的 DDL 到这一刻才对别的会话可见，所以事件也到这一刻才发。
    if (session.schemaDirty) this.invalidate(session.connectionId, actor);
    this.store.addHistory({
      connectionId: session.connectionId,
      database: session.database,
      sql: 'COMMIT',
      status: 'ok',
      durationMs: Date.now() - session.startedAt,
    });
    return { sessionId, committed: true };
  }
```

3b. `rollbackTransaction` 同理，`driver.rollbackTransaction(sessionId)` 之后、`delete` 之后插入同一行：

```ts
    // 回滚可能把结构改回去（DDL 是否可回滚取决于引擎），客户端必须重读，
    // 否则会一直显示一个从未提交过的表。
    if (session.schemaDirty) this.invalidate(session.connectionId, actor);
```

3c. `executor.ts` 的两个 case 改为传 actor 并删除自己的 invalidate（第 384-397 行）：

```ts
      case 'commit_transaction': {
        const conn = this.requireConnection(call, ctx);
        await this.manager.commitTransaction(agentTxKey(ctx), 'agent');
        return ok(started, '事务已提交', await this.manager.commitTransaction(agentTxKey(ctx)));
      }
```

**不要照抄上面这段** —— 它会把提交执行两次。正确写法是只提交一次、结果复用：

```ts
      case 'commit_transaction': {
        this.requireConnection(call, ctx);
        const result = await this.manager.commitTransaction(agentTxKey(ctx), 'agent');
        return ok(started, '事务已提交', result);
      }

      case 'rollback_transaction': {
        this.requireConnection(call, ctx);
        const result = await this.manager.rollbackTransaction(agentTxKey(ctx), 'agent');
        return ok(started, '事务已回滚', result);
      }
```

（原代码里 `conn` 只被 `invalidate` 用到；删掉 invalidate 后 `requireConnection` 仍要保留——它负责校验连接存在并把连接 id 补进 ctx，删了会改变错误行为。）

`routes.ts` 的 `/tx/commit`、`/tx/rollback` 不传第二参，默认 `'user'`，无需改动。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/gateway && node --import tsx --test --test-timeout=60000 test/schema-events.test.ts`

Expected: PASS，13 个测试全绿。

- [ ] **Step 5: 跑全量 + 类型检查**

Run: `cd apps/gateway && npm test && npm run typecheck`

Expected: 全绿。特别注意 `agent-transaction.test.ts`、`agent-tx-readonly.test.ts`、`tx-session-*.test.ts`。

- [ ] **Step 6: 提交**

```bash
git add apps/gateway/src/manager.ts apps/gateway/src/executor.ts apps/gateway/test/schema-events.test.ts
git commit -m "feat(gateway): 事务内 DDL 延迟到提交才发结构变更事件"
```

---

### Task 5: 桌面端 WS 客户端

**Files:**
- Create: `apps/desktop/src/lib/schemaEvents.ts`
- Modify: `apps/desktop/src/lib/api.ts`（导出 `authToken()`）

**Interfaces:**
- Consumes: Task 2 的 WS 广播
- Produces:
  - `api.ts` 新增 `export function authToken(): string`（每次调用重新解析）
  - `schemaEvents.ts` 新增 `SchemaChangedEvent` 与 `startSchemaEvents(handlers): () => void`

- [ ] **Step 1: 在 `api.ts` 导出可重新解析的 token**

`resolveToken()` 已存在（第 45 行），但 `TOKEN` 是模块级常量（第 64 行），配对或 `#token=` 之后不会变。在 `export const TOKEN = resolveToken();` 之后追加：

```ts
/**
 * 每次调用都重新解析：WS 重连时要能拿到配对之后才写入的 token，
 * 而不是页面加载时快照下来的那个空串。
 */
export function authToken(): string {
  return resolveToken();
}
```

- [ ] **Step 2: 实现 WS 客户端**

创建 `apps/desktop/src/lib/schemaEvents.ts`：

```ts
import { authToken } from './api';

export interface SchemaChangedEvent {
  type: 'schema_changed';
  connectionId: string;
  cause: 'agent' | 'user';
  at: string;
}

interface Handlers {
  /** 收到某连接的结构变更。 */
  onChange: (event: SchemaChangedEvent) => void;
  /** 重连成功——用于补偿断线期间丢失的事件。 */
  onReconnect: () => void;
}

const MAX_BACKOFF_MS = 30000;

/**
 * 订阅网关的结构变更广播。
 *
 * 只负责连接与重连，业务语义（什么时候真正去拉 schema）由调用方决定。
 * 两种"不必再试"的情形必须终态化，否则会变成安静的无限重连：
 * - 没有 token：生产 Web 构建没带 #token= 时就是这样，连了也会被 4401。
 * - 服务端 4401：令牌无效或被吊销，重试多少次都一样。
 */
export function startSchemaEvents({ onChange, onReconnect }: Handlers): () => void {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  // 首次连上不算"断线重连"：启动时本来就会加载，不必多刷一次。
  let connectedOnce = false;

  const connect = () => {
    if (disposed) return;
    const token = authToken();
    if (!token) return; // 终态：没有凭据，不自欺欺人地重试。

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      if (connectedOnce) onReconnect();
      connectedOnce = true;
    };

    ws.onmessage = (frame) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(frame.data));
      } catch {
        return;
      }
      if (parsed?.type !== 'schema_changed' || typeof parsed.connectionId !== 'string') return;
      onChange({
        type: 'schema_changed',
        connectionId: parsed.connectionId,
        cause: parsed.cause === 'agent' ? 'agent' : 'user',
        at: String(parsed.at ?? ''),
      });
    };

    ws.onclose = (event) => {
      socket = undefined;
      if (disposed) return;
      // 4401 是服务端明确的"你没资格"，重连只会得到同一个答案。
      if (event.code === 4401) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    // onerror 之后一定会跟一个 onclose，重连交给 onclose，避免同一次故障排两次队。
    ws.onerror = () => undefined;
  };

  connect();

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    const current = socket;
    socket = undefined;
    current?.close();
  };
}
```

- [ ] **Step 3: 类型检查**

Run: `npm --workspace apps/desktop run typecheck`

Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/lib/schemaEvents.ts apps/desktop/src/lib/api.ts
git commit -m "feat(desktop): 结构变更 WS 客户端，4401 与空 token 不重连"
```

---

### Task 6: 桌面端 store 的失效与合并策略

**Files:**
- Modify: `apps/desktop/src/store.ts`
- Test: 手测（本仓库无桌面单测框架）

**Interfaces:**
- Consumes: Task 5 的 `startSchemaEvents`
- Produces:
  - store action `applySchemaChange: (connectionId: string) => void`
  - store action `flushSchemaChanges: () => Promise<void>`

- [ ] **Step 1: 模块级状态与调度函数**

`apps/desktop/src/store.ts` 顶部 import 加：

```ts
import { startSchemaEvents } from './lib/schemaEvents';
```

在已有的模块级变量（`const toastTimers = ...` 附近）旁边加：

```ts
// 结构变更合并用的模块级状态。放 state 里会让每次事件都触发订阅者重渲染，
// 而这些值只被下面几个函数读。
const schemaPending = new Map<string, true>();
const schemaInFlight = new Set<string>();
const schemaLastRefresh = new Map<string, number>();
const schemaThrottle = new Map<string, ReturnType<typeof setTimeout>>();
const SCHEMA_THROTTLE_MS = 1000;
// 手动刷新后这个窗口内到达的事件跳过：用户自己刚刷过，事件是回声。
const SCHEMA_ECHO_WINDOW_MS = 1500;
let schemaEventsStop: (() => void) | undefined;

function requestSchemaReload(connectionId: string, immediate = false): void {
  const run = () => {
    schemaThrottle.delete(connectionId);
    if (schemaInFlight.has(connectionId)) {
      // 在飞请求可能早于 invalidate 发出，回来的是旧结构。丢掉这次事件就永久丢了，
      // 所以只记账，等它结束后补跑一次。
      schemaPending.set(connectionId, true);
      return;
    }
    schemaInFlight.add(connectionId);
    void useApp
      .getState()
      .loadSchema(connectionId, true)
      .catch(() => undefined)
      .finally(() => {
        schemaInFlight.delete(connectionId);
        if (schemaPending.get(connectionId)) {
          schemaPending.delete(connectionId);
          requestSchemaReload(connectionId, true);
        }
      });
  };

  if (immediate) {
    const timer = schemaThrottle.get(connectionId);
    if (timer) clearTimeout(timer);
    run();
    return;
  }
  // 尾沿合并：窗口内已有一次排队就不再加。这是节流不是防抖——
  // Agent 每 2 秒改一张表时，防抖会一直往后推、永远不刷。
  if (schemaThrottle.has(connectionId)) return;
  schemaThrottle.set(connectionId, setTimeout(run, SCHEMA_THROTTLE_MS));
}
```

> 若 `npm run typecheck` 报 `useApp` 在声明前使用（block-scoped variable used before declaration），把整个 `requestSchemaReload` 函数移到 `export const useApp = create(...)` **之后**，`applySchemaChange` 里仍然可以调用它（函数声明会提升，但为了稳妥用 `function` 声明即可，如上）。

- [ ] **Step 2: `loadSchema` 记录手动刷新时间**

在 `loadSchema` 函数体第一行（第 407 行 `const conn = ...` 之前）加：

```ts
    // 记在拉取开始而不是结束：用户点刷新到数据回来之间的这段时间到达的事件，
    // 也算"用户刚刷过"，不该再触发一次。
    if (refresh) schemaLastRefresh.set(connectionId, Date.now());
```

- [ ] **Step 3: 加两个 action**

在 store 的 interface 里（`refreshAllSchemas` 附近）声明：

```ts
  applySchemaChange: (connectionId: string) => void;
  flushSchemaChanges: () => Promise<void>;
```

在实现区（`refreshAllSchemas` 实现附近）加：

```ts
  applySchemaChange: (connectionId) => {
    const last = schemaLastRefresh.get(connectionId) ?? 0;
    if (Date.now() - last < SCHEMA_ECHO_WINDOW_MS) return;

    // 本客户端正在跑 Agent 回合：先记账，等回合收尾一次性刷新。
    // 否则 Agent 每改一张表就全量 describe 一次，一回合改 5 张就是 5 次。
    const live = get().live;
    if (live?.status === 'streaming' || live?.status === 'awaiting') {
      schemaPending.set(connectionId, true);
      return;
    }
    requestSchemaReload(connectionId);
  },

  flushSchemaChanges: async () => {
    const ids = [...schemaPending.keys()];
    schemaPending.clear();
    for (const connectionId of ids) requestSchemaReload(connectionId, true);
  },
```

`live.status` 的取值在 `store.ts:48` 是 `'streaming' | 'awaiting' | 'done' | 'aborted' | 'error'`，上面两个判断值都对得上。

- [ ] **Step 4: boot 成功后起 WS**

`boot` 的 `try` 块里，`await get().loadSchema(target.id);` 之后加：

```ts
      if (!schemaEventsStop) {
        schemaEventsStop = startSchemaEvents({
          onChange: (event) => get().applySchemaChange(event.connectionId),
          // 断线期间的事件不会补发，重连后对已知连接各刷一次。
          onReconnect: () => {
            for (const conn of get().connections) requestSchemaReload(conn.id, true);
          },
        });
      }
```

注意 `boot` 在 `if (!data.connections.length) return;` 处会提前返回 —— 把这段放在 `loadSchema` 之后即可覆盖有连接的常态；零连接时也确实没有 schema 可刷。

- [ ] **Step 5: 回合收尾时 flush**

`sendAgent` 的 `finally` 块里，`await get().refreshSessions();` 之后加：

```ts
      await get().flushSchemaChanges();
```

理由：回合内积攒的事件必须在本回合结束时一次性落地，否则用户回答完看到的结构还是旧的。

- [ ] **Step 6: 类型检查**

Run: `npm --workspace apps/desktop run typecheck`

Expected: 无错误。

- [ ] **Step 7: 手测**

1. `npm run dev`（起网关 + Web）。
2. 两个浏览器标签页都开 `http://localhost:5180`，选中同一连接。
3. 标签页 A 的 SQL 窗口执行 `ALTER TABLE <某表> COMMENT 'x'`。
4. 标签页 B **不刷新**，展开该表 → 对象树应自动更新；打开表设计 → 注释页显示 `x`。

- [ ] **Step 8: 提交**

```bash
git add apps/desktop/src/store.ts
git commit -m "feat(desktop): 结构变更自动失效，回合内合并 + 1s 节流 + 在飞重放"
```

---

### Task 7: 设计器作用域修复与冲突处理

**Files:**
- Create: `apps/desktop/src/lib/schemaSignature.ts`
- Modify: `apps/desktop/src/components/DesignView.tsx`
- Modify: `apps/desktop/src/styles/app.css`

**Interfaces:**
- Consumes: Task 6 的自动失效（`store.schemas` 会被替换）
- Produces: `export function tableSignature(info: TableInfo | undefined): string`

- [ ] **Step 1: 结构签名助手**

创建 `apps/desktop/src/lib/schemaSignature.ts`：

```ts
import type { TableInfo } from '@aidb/core';

/**
 * 表结构的确定性指纹，用于判断"这张表在别处被改过没有"。
 *
 * 字段顺序写死，不依赖对象键顺序：同样的结构在任何一次 describe 里都必须得到同一个串，
 * 否则每次 loadSchema 都会误判成"变了"，把用户正在编辑的内容反复重置掉。
 */
export function tableSignature(info: TableInfo | undefined): string {
  if (!info) return '';
  return JSON.stringify({
    name: info.name,
    type: info.type,
    kind: info.kind ?? '',
    comment: info.comment ?? '',
    columns: (info.columns ?? []).map((column) => [
      column.name,
      column.type,
      String(column.nullable),
      column.defaultValue ?? '',
      column.comment ?? '',
      String(column.primaryKey),
      String(Boolean(column.autoIncrement)),
    ]),
    indexes: (info.indexes ?? []).map((index) => [
      index.name,
      index.columns.join(','),
      String(index.unique),
      String(Boolean(index.primary)),
      index.method ?? '',
      index.comment ?? '',
    ]),
    foreignKeys: (info.foreignKeys ?? []).map((fk) => [
      fk.name ?? '',
      fk.columns.join(','),
      fk.refSchema ?? '',
      fk.refTable,
      fk.refColumns.join(','),
      fk.onDelete ?? '',
      fk.onUpdate ?? '',
    ]),
  });
}
```

- [ ] **Step 2: 修作用域查找（前置条件，先做）**

`DesignView.tsx:248` 现在是：

```ts
  const tableInfo: TableInfo | undefined = (schemas ?? []).flatMap((s) => s.tables).find((tbl) => tbl.name === tab.table);
```

替换为：

```ts
  // 必须按 tab 自己的库/模式取表：跨全部库取首个同名表时，MySQL 两库的同名 orders
  // 会取到另一张，接下来的"签名变了就静默重置"会用错结构覆盖编辑器内容，
  // apply() 还会对着错对象生成 DDL。
  const tableInfo: TableInfo | undefined = useMemo(() => {
    const all = schemas ?? [];
    if (!tab.database) return all.flatMap((item) => item.tables).find((tbl) => tbl.name === tab.table);
    // 有库名却只在别的库里找到同名表，宁可当作不存在，也不要拿错表覆盖编辑态。
    return all
      .filter((item) => item.name === tab.database)
      .flatMap((item) => item.tables)
      .find((tbl) => tbl.name === tab.table);
  }, [schemas, tab.database, tab.table]);
```

- [ ] **Step 3: 基线 state 与 `applyTableInfo`**

在 `DesignView` 现有 state 声明区（第 251-268 行）加：

```ts
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [originalIndexes, setOriginalIndexes] = useState<EditableIndex[]>([]);
  const [originalForeignKeys, setOriginalForeignKeys] = useState<EditableFk[]>([]);
  const [pendingReload, setPendingReload] = useState(false);
  const [conflictSig, setConflictSig] = useState('');
  const baselineSig = useRef<string>('');
```

在 `initializedFor` / `loadedAux` 之后加一个局部函数（把原来 effect 里那几行 set 抽出来，首次载入与静默重置共用，保证两处基线一致）：

```ts
  const applyTableInfo = (info: TableInfo) => {
    setTableName(info.name);
    setColumns((info.columns ?? []).map(toColumn));
    setIndexes((info.indexes ?? []).map(toIndex));
    setForeignKeys((info.foreignKeys ?? []).map(toFk));
    setOriginalColumns((info.columns ?? []).map(toColumn));
    setOriginalIndexes((info.indexes ?? []).map(toIndex));
    setOriginalForeignKeys((info.foreignKeys ?? []).map(toFk));
    setTableComment(info.comment ?? '');
    setOriginalComment(info.comment ?? '');
    setSelColumn(0);
    setSelIndex(0);
    setSelFk(0);
    loadedAux.current = {};
  };
```

- [ ] **Step 4: `dirty` 判定**

放在初始化 effect **之前**（effect 依赖它）：

```ts
  // 编辑态是否偏离了基线。id 是本地生成的随机值，不计入比较。
  const dirty = useMemo(() => {
    if (!tab.table || !baselineSig.current) return false;
    const shape = (items: EditableColumn[]) =>
      items.map((column) => [
        column.name,
        composeType(column),
        String(column.nullable),
        column.defaultValue,
        column.comment,
        String(column.primaryKey),
        String(column.autoIncrement),
        column.removed ? 'x' : '',
      ]);
    const shapeIndex = (items: EditableIndex[]) =>
      items.map((index) => [index.name, index.columns, String(index.unique), index.comment, index.removed ? 'x' : '']);
    const shapeFk = (items: EditableFk[]) =>
      items.map((fk) => [fk.name, fk.columns, fk.refTable, fk.refColumns, fk.onDelete, fk.onUpdate, fk.removed ? 'x' : '']);
    return (
      JSON.stringify([shape(columns), shapeIndex(indexes), shapeFk(foreignKeys), tableComment]) !==
      JSON.stringify([shape(originalColumns), shapeIndex(originalIndexes), shapeFk(originalForeignKeys), originalComment])
    );
  }, [columns, indexes, foreignKeys, tableComment, originalColumns, originalIndexes, originalForeignKeys, originalComment]);
```

- [ ] **Step 5: 重写初始化 effect（第 270-299 行）**

```ts
  useEffect(() => {
    if (!tab.table) {
      if (initializedFor.current !== `new:${tab.id}`) {
        initializedFor.current = `new:${tab.id}`;
        setTableName('');
        setColumns(defaultColumns(engine));
        setIndexes([]);
        setForeignKeys([]);
        setOriginalColumns([]);
        setOriginalIndexes([]);
        setOriginalForeignKeys([]);
        setTableComment('');
        setOriginalComment('');
        baselineSig.current = '';
        setPendingReload(false);
      }
      return;
    }
    if (!tableInfo) {
      if (!schemas) void loadSchema(tab.connectionId);
      return;
    }

    const nextSig = tableSignature(tableInfo);

    // 首次载入：直接以库里的结构建基线。
    if (initializedFor.current !== `table:${tab.table}`) {
      initializedFor.current = `table:${tab.table}`;
      baselineSig.current = nextSig;
      applyTableInfo(tableInfo);
      setPendingReload(false);
      return;
    }

    // 之后每次 tableInfo 变化（loadSchema 会替换整个数组）都比一次签名。
    if (nextSig === baselineSig.current) return;
    if (!dirty) {
      // 没改过东西：静默跟随新结构，用户看不到闪烁。
      baselineSig.current = nextSig;
      applyTableInfo(tableInfo);
      return;
    }
    // 改过但没保存：不动编辑态，只挂横幅等用户决定。
    setConflictSig(nextSig);
    setPendingReload(true);
  }, [tab.table, tab.connectionId, tab.id, tableInfo, schemas, engine, dirty]);
```

原 effect 依赖数组里有 `loadSchema`，一并保留无害；但 `dirty` 必须是依赖，否则横幅判断用旧值。

- [ ] **Step 6: 横幅与两个动作**

在 `return (<div className="view designer">` 内、`designer-toolbar` 的 `</div>` 之后插入：

```tsx
      {pendingReload ? (
        <div className="risk-banner designer-conflict" data-testid="designer-conflict">
          <span>此表已在别处被修改。</span>
          <button
            className="btn small"
            data-testid="designer-conflict-reload"
            onClick={() => {
              if (tableInfo) applyTableInfo(tableInfo);
              baselineSig.current = conflictSig;
              setPendingReload(false);
            }}
          >
            重新加载
          </button>
          <button
            className="btn small"
            data-testid="designer-conflict-keep"
            onClick={() => {
              // 把基线推进到对方的版本：同一次变更不再反复提示。
              // 代价是继续基于旧结构编辑，apply() 可能与新结构冲突——由数据库报错兜底，
              // 好过静默丢掉用户填了一半的内容。
              baselineSig.current = conflictSig;
              setPendingReload(false);
            }}
          >
            保留我的修改
          </button>
        </div>
      ) : null}
```

`apps/desktop/src/styles/app.css` 的 `.risk-banner`（第 845 行）之后加：

```css
.designer-conflict { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; }
.designer-conflict .btn { flex: none; }
```

- [ ] **Step 7: 类型检查**

Run: `npm --workspace apps/desktop run typecheck`

Expected: 无错误。

- [ ] **Step 8: 手测冲突与作用域**

1. 打开某表设计器，把某列注释改成 `draft`，不保存。
2. SQL 窗口执行 `ALTER TABLE <同一张表> COMMENT='外部改动'`。
3. 期望：顶部出现"此表已在别处被修改"横幅，编辑框里仍是 `draft`。
4. 点「保留我的修改」→ 横幅消失、内容不变；再执行一次外部 ALTER → 横幅再次出现。
5. 点「重新加载」→ 内容变为库里最新结构。
6. 同名表：MySQL 建 `db_a.orders` 与 `db_b.orders`，只改 `db_b` 的 → `db_a` 的设计器内容**不变**。
7. 未修改的 tab：外部改结构 → 静默跟随，不出现横幅。

- [ ] **Step 9: 提交**

```bash
git add apps/desktop/src/lib/schemaSignature.ts apps/desktop/src/components/DesignView.tsx apps/desktop/src/styles/app.css
git commit -m "fix(desktop): 表设计按库作用域取表，并处理结构冲突"
```

---

### Task 8: 移动端接入

**Files:**
- Modify: `apps/mobile/App.tsx`

**Interfaces:**
- Consumes: Task 2 的 WS 广播（移动端已在连同一 `/ws`）

- [ ] **Step 1: 加 `activeConnectionIdRef`**

`App.tsx:307` 已有 `const sessionIdRef = useRef<string | undefined>(undefined);` 与第 315 行的 `sessionIdRef.current = sessionId;`。照同一写法加：

```ts
  const activeConnectionIdRef = useRef<string | undefined>(undefined);
  activeConnectionIdRef.current = activeConnectionId;
```

（`activeConnectionId` 是 state，`handleWsEvent` 通过 `handlerRef.current` 每次渲染更新，但 `onopen` 回调捕获的是闭包，用 ref 才稳。）

- [ ] **Step 2: 在飞去重与重放**

把 `loadSchema`（第 339 行）改为：

```ts
  const schemaInFlightRef = useRef(false);
  const schemaPendingRef = useRef(false);

  const loadSchema = async (connectionId?: string) => {
    if (!connectionId) {
      setTables([]);
      return;
    }
    if (schemaInFlightRef.current) {
      // 在飞请求可能早于 invalidate 发出、回来的是旧结构。丢掉这次事件就永久丢了，
      // 所以只记账，等它结束后补跑一次。
      schemaPendingRef.current = true;
      return;
    }
    schemaInFlightRef.current = true;
    try {
      const result = await client.schema(connectionId);
      setTables(result.schemas.flatMap((schema) => schema.tables));
    } catch {
      setTables([]);
    } finally {
      schemaInFlightRef.current = false;
      if (schemaPendingRef.current) {
        schemaPendingRef.current = false;
        void loadSchema(connectionId);
      }
    }
  };
```

- [ ] **Step 3: 处理事件**

`handleWsEvent`（第 387 行）在 greet/ping 过滤之后加：

```ts
    if (event.type === 'schema_changed') {
      if (event.connectionId === activeConnectionIdRef.current) void loadSchema(event.connectionId);
      return;
    }
```

- [ ] **Step 4: 重连补偿**

`ws.onopen`（第 473 行 `ws.onopen = () => !disposed && setConnected(true);`）改为：

```ts
        ws.onopen = () => {
          if (disposed) return;
          setConnected(true);
          // 断线期间的事件不会补发；重连后补刷一次当前连接。
          if (activeConnectionIdRef.current) void loadSchema(activeConnectionIdRef.current);
        };
```

- [ ] **Step 5: 类型检查**

Run: `cd apps/mobile && npx tsc --noEmit`

Expected: 无错误。若该 workspace 没有 tsconfig，跳过此步并在提交说明里注明。

- [ ] **Step 6: 手测**

1. 桌面端起网关，移动端（Expo）连上。
2. 桌面 SQL 窗口 `CREATE TABLE mobile_probe (...)`。
3. 移动端对象树**不手动刷新**应出现新表。
4. 杀掉网关 10 秒再起 → 移动端重连后自动恢复表列表。

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): 接入结构变更事件，重连后补偿刷新"
```

---

### Task 9: 文档同步与全量验证

**Files:**
- Modify: `docs/05-data-and-api.md`
- Modify: `docs/02-feature-spec.md`
- Modify: `docs/19-schema-change-events.md`（状态改为已实现）

- [ ] **Step 1: 补 API 文档**

`docs/05-data-and-api.md` 的「流式事件（SSE / WebSocket 共用）」小节末尾加：

```markdown
### 结构变更广播（`/ws` 下行）

`GET /ws?token=` 除回合事件外还推送全局结构变更事件，与具体回合无关：

```ts
{ type: 'schema_changed'; connectionId: string; cause: 'agent' | 'user'; at: string }
```

- 触发：任何使 `schema_cache` 失效的操作。SQL 类在 `ConnectionManager.query()` 判定已执行语句含 ddl/destructive 后发射；事务内的 DDL 延迟到 `COMMIT`（`ROLLBACK` 时同样发一次，结构可能已回退）。
- 粒度是连接，不带库：客户端需重载该连接已加载的所有库。
- 不带变更明细；需要明细请用结构对比。
- 未鉴权连接以 code `4401` 关闭，客户端不得重试。
```

- [ ] **Step 2: 补功能说明**

`docs/02-feature-spec.md` 的「对象浏览器」条目末尾加：

```markdown
- 结构变更自动失效：任一客户端（桌面 / Web / 移动端）改动结构后，其它在线客户端经 `/ws` 收到 `schema_changed` 并自动重载，无需手动刷新。正打开的表设计器若有未保存修改，弹出「重新加载 / 保留我的修改」而不静默覆盖。
```

- [ ] **Step 3: 更新设计文档状态**

`docs/19-schema-change-events.md` 头部：

```markdown
> 状态：**已实现**（2026-11-02）
```

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck && npm test`

Expected: 全绿。

- [ ] **Step 5: e2e**

Run: `npm run e2e`

Expected: 约 230 项断言全部通过，无回归。

- [ ] **Step 6: 提交**

```bash
git add docs/05-data-and-api.md docs/02-feature-spec.md docs/19-schema-change-events.md
git commit -m "docs: 记录结构变更事件与客户端自动失效"
```

---

## 交付后回归清单

- [ ] Agent 加表注释 → 桌面端不刷新直接看表设计「注释」页可见（用户原始诉求）
- [ ] Agent 连改 3 张表 → 整个回合只发一次 `GET schema?refresh=1`
- [ ] SQL 窗口 `CREATE TABLE` → 另一标签页对象树自动出现新表
- [ ] SQL 窗口 DDL 后立刻刷新能看到新结构（原先要等 30s TTL 过期）
- [ ] 事务内建表 → 提交前别的标签页看不到，提交后自动出现
- [ ] 设计器有未保存修改 + 外部 ALTER → 出现横幅，编辑内容不丢
- [ ] MySQL 两库同名表 → 改一个不影响另一个的设计器
- [ ] 空 token（生产 Web 构建无 `#token=`）→ 不重连、不报错、其余功能正常
- [ ] 移动端不手动刷新即可看到桌面端新建的表
- [ ] 一次操作只产生一个 `schema_changed`（`/ddl/execute`、`run_sql`、工具箱建表均已覆盖）