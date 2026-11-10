import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';

/**
 * store 在导入时就会读 localStorage / location（api.ts 解析 token、store.ts 读 UI 偏好），
 * 所以浏览器的替身必须在 import 之前装好 —— 只能用 dynamic import。
 */
type Route = { status?: number; body?: unknown; hold?: boolean };
const installed = await (async () => {
  const calls: FetchCall[] = [];
  const pending = new Map<string, { resolve: (value: Response) => void }>();
  const routes = new Map<string, Route>();

  globalThis.location = { hash: '#token=t', pathname: '/', search: '' } as unknown as Location;
  globalThis.history = { replaceState() {} } as unknown as History;
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  } as unknown as Storage;
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  globalThis.fetch = (async (input: any, init: any) => {
    const path = String(input);
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const route = routes.get(path) ?? { status: 200, body: { ok: true } };
    calls.push({ path, status: route.status ?? 200, body: route.body });
    if (route.hold) {
      // 按住这条响应：用来模拟「SSE 已经推进到下一个 approval，HTTP 响应才回来」
      return new Promise<Response>((resolve) => pending.set(path, { resolve }));
    }
    return respond(route.status ?? 200, route.body ?? { ok: true });
  }) as unknown as typeof fetch;

  const store = await import('../src/store');
  return { store, calls, pending, routes };
})();

const { store, routes, pending } = installed;
const { useApp } = store;

const liveTurn = () => ({
  userText: '建两张表',
  text: '',
  thinking: '',
  tools: [{ callId: 'c1', tool: 'create_table', args: {}, status: 'running' as const, summary: '创建表 a' }],
  plan: [],
  memories: [],
  status: 'awaiting' as const,
  startedAt: Date.now(),
  tokensIn: 0,
  tokensOut: 0,
  steps: 1,
  modelCalls: 1,
});

const approvalEvent = (approvalId: string, table: string) => ({
  type: 'approval_required' as const,
  approvalId,
  expiresIn: 300000,
  call: { tool: 'create_table', args: { table }, risk: 'ddl' as const, summary: `创建表 ${table}` },
});

const state = () => useApp.getState();
const queueIds = () => state().approvalQueue.map((item) => item.approvalId);

beforeEach(() => {
  useApp.setState({ live: liveTurn(), approval: undefined, approvalQueue: [], toasts: [] });
  routes.clear();
});
after(() => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
});

test('连续两次审批：第二个排队，第一个结算后立刻顶上', async () => {
  state().handleAgentEvent(approvalEvent('A', 'e2e_a'));
  state().handleAgentEvent(approvalEvent('B', 'e2e_b'));
  assert.equal(state().approval?.approvalId, 'A', '当前弹窗仍是第一个');
  assert.deepEqual(queueIds(), ['B'], '后来的排队，不顶掉当前弹窗');

  // 用户点「仅此一次」：HTTP 200 回来后放下一个
  routes.set('/api/agent/approvals/A', { status: 200, body: { ok: true } });
  await state().resolveApproval('allow', 'once');
  assert.equal(state().approval?.approvalId, 'B', '结算 A 后 B 必须马上弹出来');
  assert.deepEqual(queueIds(), []);

  routes.set('/api/agent/approvals/B', { status: 200, body: { ok: true } });
  await state().resolveApproval('allow', 'once');
  assert.equal(state().approval, undefined, '队列空了才收摊');
});

test('审批 POST 在飞时 SSE 推进到下一个：迟到的响应不能抹掉下一个弹窗', async () => {
  // 这条就是「后面的提问弹窗弹不出来」的原始成因，直接在 store 层复现：
  //   1. A 的弹窗显示中，用户点「仅此一次」→ POST /approvals/A 发出但未返回；
  //   2. 等待期间 SSE 送来 B 的 approval_required；
  //   3. A 的 HTTP 响应这时才回来 —— 旧实现无条件 approval: undefined，
  //      会把已经上屏的 B 一起抹掉，B 挂到 Bridge 5 分钟超时被自动拒绝。
  // 新语义下 A 在响应回来前不算结算完，所以 B 先进队列；两条都要活着，
  // 而且响应落地后 B 必须立刻顶上 —— 这才是用户要的「前面的操作完，后面的接着弹」。
  state().handleAgentEvent(approvalEvent('A', 'e2e_a'));
  routes.set('/api/agent/approvals/A', { status: 200, body: { ok: true }, hold: true });
  const inflight = state().resolveApproval('allow', 'once');

  await new Promise((resolve) => setTimeout(resolve, 0));
  state().handleAgentEvent(approvalEvent('B', 'e2e_b'));
  assert.equal(state().approval?.approvalId, 'A', 'POST 还没回来，A 仍然挂着（没送达不假装已同意）');
  assert.deepEqual(queueIds(), ['B'], 'B 进队列，不能丢');

  pending.get('/api/agent/approvals/A')?.resolve(
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  await inflight;

  assert.equal(state().approval?.approvalId, 'B', '迟到的 A 结算不能把 B 一起抹掉');
  assert.deepEqual(queueIds(), []);
  assert.equal(state().live?.status, 'awaiting', '还有弹窗时状态不能被改成 streaming');
});

test('审批已被服务端结算（404）：按已处理收摊，不弹错误', async () => {
  state().handleAgentEvent(approvalEvent('A', 'e2e_a'));
  state().handleAgentEvent(approvalEvent('B', 'e2e_b'));
  routes.set('/api/agent/approvals/A', { status: 404, body: { error: { message: 'not found', code: 'NOPE' } } });
  await state().resolveApproval('allow', 'once');
  assert.equal(state().approval?.approvalId, 'B', '404 也要把队列里的下一个放进来');
  assert.deepEqual(state().toasts, [], '404 是正常竞态，不该弹错误提示');
});

test('其它失败（500）保留弹窗并提示，不能静默放行', async () => {
  state().handleAgentEvent(approvalEvent('A', 'e2e_a'));
  routes.set('/api/agent/approvals/A', { status: 500, body: { error: { message: '桥接挂了', code: 'BOOM' } } });
  await state().resolveApproval('allow', 'once');
  assert.equal(state().approval?.approvalId, 'A', '没送达的审批必须还挂在界面上');
  assert.equal(state().toasts.length, 1, '要告诉用户这次没生效');
  assert.equal(state().toasts[0].kind, 'error');
});

test('SSE 先结算并顶上下一个时，迟到的 HTTP 响应不能再动槽位', async () => {
  // 另一条到达顺序：用户点 A → POST 在飞；服务端先把 A 结算掉（SSE approval_resolved），
  // B 顶上弹窗；之后 A 的 HTTP 响应才回来。此时按 id 出队必须什么都不做。
  state().handleAgentEvent(approvalEvent('A', 'e2e_a'));
  state().handleAgentEvent(approvalEvent('B', 'e2e_b'));
  routes.set('/api/agent/approvals/A', { status: 200, body: { ok: true }, hold: true });
  // 点击发生在 A 还显示时 —— resolveApproval 捕获的是 A
  const inflight = state().resolveApproval('allow', 'once');
  await new Promise((resolve) => setTimeout(resolve, 0));

  state().handleAgentEvent({ type: 'approval_resolved', approvalId: 'A', decision: 'allow', scope: 'once' });
  assert.equal(state().approval?.approvalId, 'B', 'SSE 结算把 B 顶上弹窗');

  pending.get('/api/agent/approvals/A')?.resolve(
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  await inflight;
  assert.equal(state().approval?.approvalId, 'B', 'A 的迟到结算不该抹掉正在显示的 B');
  assert.equal(state().live?.status, 'awaiting');
});

test('单条审批（最常见）：结算后弹窗收摊、状态回到运行中', async () => {
  state().handleAgentEvent(approvalEvent('A', 'e2e_a'));
  assert.equal(state().live?.status, 'awaiting');
  routes.set('/api/agent/approvals/A', { status: 200, body: { ok: true } });
  await state().resolveApproval('allow', 'once');
  assert.equal(state().approval, undefined);
  assert.deepEqual(queueIds(), []);
  assert.equal(state().live?.status, 'streaming', '队列空了必须回到 streaming，不能卡在 awaiting');
});
