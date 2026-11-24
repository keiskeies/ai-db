import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import type { AgentEvent, AgentSessionMeta } from '@aidb/core';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const frame = (event: AgentEvent) => `data: ${JSON.stringify(event)}\n\n`;

const session = (id: string): AgentSessionMeta => ({
  id,
  title: id,
  permissionMode: 'ask',
  status: 'idle',
  tokensIn: 0,
  tokensOut: 0,
  turns: 0,
  steps: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  contextTokens: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const installed = await (async () => {
  globalThis.location = { hash: '#token=t', pathname: '/', search: '' } as unknown as Location;
  globalThis.history = { replaceState() {} } as unknown as History;
  const mem = new Map<string, string>();
  mem.set('aidb.locale', 'zh-CN');
  globalThis.localStorage = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, String(value)),
    removeItem: (key: string) => void mem.delete(key),
    clear: () => void mem.clear(),
  } as unknown as Storage;
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const routes = new Map<string, (init?: RequestInit) => Response | Promise<Response>>();
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    const route = routes.get(path);
    if (route) return route(init);
    if (path === '/api/agent/sessions') return json({ sessions: [] });
    if (path.startsWith('/api/agent/sessions/')) {
      if (path.endsWith('/abort')) return json({ ok: true });
      const id = path.split('/')[3];
      return json({ session: session(id), messages: [], toolRuns: [] });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;
  const store = await import('../src/store');
  return { store, routes, calls };
})();

const { useApp } = installed.store;
const { routes, calls } = installed;
const state = () => useApp.getState();

function openTurn(events: AgentEvent[] = []) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const signal = { current: undefined as AbortSignal | undefined };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
      for (const event of events) controller.enqueue(new TextEncoder().encode(frame(event)));
    },
  });
  routes.set('/api/agent/sessions/s1/turns', (init) => {
    signal.current = init?.signal ?? undefined;
    init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return {
    signal,
    send(event: AgentEvent) { stream.enqueue(new TextEncoder().encode(frame(event))); },
    close() { stream.close(); },
  };
}

beforeEach(() => {
  routes.clear();
  calls.length = 0;
  globalThis.localStorage.clear();
  useApp.setState({
    agentSessionId: 's1',
    agentSessionMeta: session('s1'),
    agentMessages: [],
    agentFollowUps: [],
    agentStarting: false,
    agentStartingGeneration: undefined,
    agentStopUnconfirmed: false,
    agentSessionSwitching: false,
    live: undefined,
    approval: undefined,
    approvalQueue: [],
    toasts: [],
    activeConnectionId: undefined,
    agentDatabase: '',
  });
});

test('删除会话在飞时锁定发送，迟到的删除结果不能清掉后来加载的会话', async () => {
  const deleted = deferred<Response>();
  routes.set('/api/agent/sessions/s1', (init) => init?.method === 'DELETE' ? deleted.promise : json({ session: session('s1'), messages: [], toolRuns: [] }));
  routes.set('/api/agent/sessions/s2', () => json({ session: session('s2'), messages: [], toolRuns: [] }));
  const deleting = state().deleteAgentSession('s1');
  await tick();
  assert.equal(state().agentSessionSwitching, true);
  assert.equal(await state().sendAgent('删除期间不应发送'), false);
  assert.equal(calls.some((call) => call.path.endsWith('/turns')), false);

  assert.equal(await state().loadAgentSession('s2'), true);
  assert.equal(state().agentSessionId, 's2');
  assert.equal(state().agentSessionSwitching, false);
  deleted.resolve(json({ ok: true }));
  assert.equal(await deleting, false);
  assert.equal(state().agentSessionId, 's2');
  assert.equal(state().agentSessionMeta?.id, 's2');
});

after(() => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
});

test('创建会话期间拒绝重复发送，abort 后迟到的创建结果不能启动流', async () => {
  const created = deferred<Response>();
  let createSignal: AbortSignal | undefined;
  routes.set('/api/agent/sessions', (init) => {
    createSignal = init?.signal ?? undefined;
    return created.promise;
  });
  useApp.setState({ agentSessionId: undefined, agentSessionMeta: undefined });
  let accepted = 0;
  const sending = state().sendAgent('保留草稿', undefined, ['img-1'], () => { accepted += 1; });
  await tick();
  assert.equal(state().agentStarting, true);
  assert.equal(await state().sendAgent('重复消息'), false);
  await state().abortAgent();
  assert.equal(state().agentStarting, false);
  assert.equal(createSignal?.aborted, true, '停止必须中断创建会话的 HTTP 请求');
  created.resolve(json({ session: session('created') }, 201));
  assert.equal(await sending, false);
  assert.equal(accepted, 0);
  assert.equal(state().agentSessionId, undefined);
  assert.equal(calls.some((call) => call.path.endsWith('/turns')), false);
});

test('创建中停止立即释放 store 发送锁，迟到创建不污染紧随其后的新回合', async () => {
  const staleCreate = deferred<Response>();
  let creates = 0;
  routes.set('/api/agent/sessions', (init) => {
    if (init?.method !== 'POST') return json({ sessions: [] });
    creates += 1;
    return creates === 1 ? staleCreate.promise : json({ session: session('s1') }, 201);
  });
  useApp.setState({ agentSessionId: undefined, agentSessionMeta: undefined });
  const staleSend = state().sendAgent('已取消的草稿');
  await tick();
  assert.equal(await state().abortAgent(), false);
  assert.equal(state().agentStarting, false);

  const current = openTurn([{ type: 'start', turnId: 'turn-new', sessionId: 's1', model: 'm' }]);
  let accepted = 0;
  const currentSend = state().sendAgent('新草稿', undefined, undefined, () => { accepted += 1; });
  await tick();
  assert.equal(accepted, 1);
  assert.equal(state().agentSessionId, 's1');
  const currentLive = state().live;

  staleCreate.resolve(json({ session: session('stale') }, 201));
  assert.equal(await staleSend, false);
  assert.equal(state().agentSessionId, 's1');
  assert.equal(state().live, currentLive);
  assert.equal(calls.filter((call) => call.path.endsWith('/turns')).length, 1);

  current.close();
  await currentSend;
});

test('创建会话失败不受理，也不留下假 live', async () => {
  useApp.setState({ agentSessionId: undefined, agentSessionMeta: undefined });
  routes.set('/api/agent/sessions', () => json({ error: { message: '创建失败', code: 'CREATE_FAILED' } }, 500));
  let accepted = 0;
  assert.equal(await state().sendAgent('可恢复草稿', undefined, ['img-1'], () => { accepted += 1; }), false);
  assert.equal(accepted, 0);
  assert.equal(state().live, undefined);
  assert.equal(state().agentStarting, false);
  assert.equal(state().toasts.at(-1)?.detail, '创建失败');
});

test('stream 启动失败保留旧 live，直到服务端受理才通知组件清草稿', async () => {
  const previous = {
    generation: 0,
    userText: '上一轮',
    text: '上一轮结果',
    thinking: '',
    tools: [],
    timeline: [],
    stream: '',
    streamThinking: '',
    plan: [],
    status: 'done' as const,
    startedAt: Date.now() - 1000,
    lastEventAt: Date.now() - 1000,
    tokensIn: 0,
    tokensOut: 0,
    steps: 0,
    modelCalls: 0,
    contextTokens: 0,
    modelDurationMs: 0,
    memories: [],
  };
  useApp.setState({ live: previous });
  routes.set('/api/agent/sessions/s1/turns', () => json({ error: { message: '通道拒绝', code: 'AGENT_REQUEST' } }, 503));
  let accepted = 0;
  assert.equal(await state().sendAgent('草稿和图片', undefined, ['img-1'], () => { accepted += 1; }), false);
  assert.equal(accepted, 0);
  assert.equal(state().live, previous);
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions/s1'), false);
});

test('SSE 在 start 前报初始化错误时仍不受理，草稿不清空', async () => {
  const turn = openTurn([{ type: 'error', code: 'SESSION_BUSY', message: '会话正在运行', retryable: false }]);
  let accepted = 0;
  const sending = state().sendAgent('保留草稿', undefined, ['img-1'], () => { accepted += 1; });
  await tick();
  turn.close();
  assert.equal(await sending, false);
  assert.equal(accepted, 0);
  assert.equal(state().live, undefined);
  assert.equal(state().toasts.at(-1)?.detail, '会话正在运行');
});

test('旧回合 finally 不能清新回合的 live 或 abort controller', async () => {
  const first = openTurn([
    { type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' },
    { type: 'text_delta', text: '旧回合缓冲文本' },
  ]);
  const firstGet = deferred<Response>();
  let gets = 0;
  routes.set('/api/agent/sessions/s1', () => {
    gets += 1;
    return gets === 1 ? firstGet.promise : json({ session: session('s1'), messages: [], toolRuns: [] });
  });
  const firstSend = state().sendAgent('第一回合');
  await tick();
  await state().abortAgent();
  await tick();
  assert.equal(gets, 1, '旧回合已进入延迟历史读取');

  let secondStream!: ReadableStreamDefaultController<Uint8Array>;
  let secondSignal!: AbortSignal;
  routes.set('/api/agent/sessions/s1/turns', (init) => {
    secondSignal = init!.signal!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        secondStream = controller;
        controller.enqueue(new TextEncoder().encode(frame({ type: 'start', turnId: 'turn-2', sessionId: 's1', model: 'm' })));
      },
    });
    init?.signal?.addEventListener('abort', () => secondStream.error(new DOMException('Aborted', 'AbortError')), { once: true });
    return new Response(body, { status: 200 });
  });
  let accepted = 0;
  const secondSend = state().sendAgent('第二回合', undefined, undefined, () => { accepted += 1; });
  await tick();
  assert.equal(accepted, 1);
  const secondGeneration = state().live!.generation;

  firstGet.resolve(json({ session: session('s1'), messages: [], toolRuns: [] }));
  await firstSend;
  assert.equal(state().live?.userText, '第二回合');
  assert.equal(state().live?.generation, secondGeneration);
  assert.equal(state().live?.text.includes('旧回合缓冲文本'), false);
  assert.equal(secondSignal.aborted, false, '旧 finally 不能清掉新 controller');

  await state().abortAgent();
  await secondSend;
  assert.equal(secondSignal.aborted, true);
  assert.equal(first.signal.current?.aborted, true);
});

test('延迟 GET 跨会话返回时不能覆盖新会话', async () => {
  const turn = openTurn([{ type: 'done', turnId: 'turn-1', durationMs: 1 }]);
  const detail = deferred<Response>();
  routes.set('/api/agent/sessions/s1', () => detail.promise);
  const sending = state().sendAgent('旧会话消息');
  await tick();
  turn.close();
  await tick();
  useApp.setState({
    agentSessionId: 's2',
    agentSessionMeta: session('s2'),
    agentMessages: [],
    live: {
      generation: 999,
      userText: '新会话',
      text: '新内容',
      thinking: '',
      tools: [],
      timeline: [],
      stream: '',
      streamThinking: '',
      plan: [],
      status: 'streaming',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      steps: 0,
      modelCalls: 0,
      contextTokens: 0,
      modelDurationMs: 0,
      memories: [],
    },
  });
  detail.resolve(json({ session: session('s1'), messages: [], toolRuns: [] }));
  await sending;
  assert.equal(state().agentSessionId, 's2');
  assert.equal(state().live?.userText, '新会话');
  assert.equal(state().live?.text, '新内容');
});

test('SSE 干净 EOF 后详情仍 running：320ms 后重新 GET，不用旧详情清 live', async () => {
  const firstGet = deferred<Response>();
  const secondGet = deferred<Response>();
  const secondRequested = deferred<void>();
  let gets = 0;
  let runningReturnedAt = 0;
  routes.set('/api/agent/sessions/s1', () => {
    gets += 1;
    if (gets === 1) return firstGet.promise;
    secondRequested.resolve(undefined);
    return secondGet.promise;
  });
  const turn = openTurn([
    { type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' },
    { type: 'text_delta', text: '流已关闭但服务端仍在跑' },
  ]);
  const sending = state().sendAgent('等待服务端收尾');
  await tick();
  turn.close();
  await tick();
  assert.equal(gets, 1);

  runningReturnedAt = Date.now();
  firstGet.resolve(json({ session: { ...session('s1'), status: 'running' }, messages: [], toolRuns: [] }));
  await secondRequested.promise;
  assert.ok(Date.now() - runningReturnedAt >= 300, '第二次 GET 必须晚于第一次 running 详情');
  assert.equal(gets, 2);
  assert.equal(state().live?.status, 'streaming');
  assert.match(state().live?.text ?? '', /服务端仍在跑/);

  secondGet.resolve(json({
    session: { ...session('s1'), status: 'done' },
    messages: [{ id: 'fresh', role: 'assistant', content: '第二次详情', blocks: [] }],
    toolRuns: [],
  }));
  await sending;
  assert.equal(state().live, undefined);
  assert.equal(state().agentMessages[0]?.content, '第二次详情', '不能提交第一次 waiting 前的详情');
});

test('EOF 后两次详情都仍 running：保留 live 和可用的停止入口', async () => {
  let gets = 0;
  routes.set('/api/agent/sessions/s1', () => {
    gets += 1;
    return json({ session: { ...session('s1'), status: 'running' }, messages: [], toolRuns: [] });
  });
  const turn = openTurn([
    { type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' },
    { type: 'text_delta', text: '保留本地进度' },
  ]);
  const sending = state().sendAgent('服务端还在执行');
  await tick();
  turn.close();
  await sending;

  assert.equal(gets, 2);
  assert.equal(state().live?.status, 'streaming');
  assert.match(state().live?.text ?? '', /保留本地进度/);
  assert.equal(state().agentStopUnconfirmed, true);
  assert.equal(await state().abortAgent(), true);
  assert.equal(state().live?.status, 'aborted');
  assert.equal(state().agentStopUnconfirmed, false);
  assert.equal(calls.filter((call) => call.path === '/api/agent/sessions/s1/abort').length, 1);
});

test('abort 等待服务端确认后清理审批并落本地终态', async () => {
  const turn = openTurn();
  const confirmation = deferred<Response>();
  routes.set('/api/agent/sessions/s1/abort', () => confirmation.promise);
  const sending = state().sendAgent('执行中');
  await tick();
  state().handleAgentEvent({
    type: 'approval_required',
    approvalId: 'a1',
    expiresIn: 300000,
    call: { tool: 'create_table', args: {}, risk: 'ddl', summary: '建表' },
  });
  const stopping = state().abortAgent();
  await tick();
  assert.equal(state().live?.status, 'awaiting');
  assert.equal(state().approval?.approvalId, 'a1');
  confirmation.resolve(json({ ok: true }));
  await stopping;
  await sending;
  assert.equal(state().approval, undefined);
  assert.deepEqual(state().approvalQueue, []);
  assert.equal(turn.signal.current?.aborted, true);
});

test('已有明确终态时 abort 不再覆盖结果或重复请求服务端', async () => {
  const turn = openTurn([
    { type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' },
    { type: 'done', turnId: 'turn-1', durationMs: 1 },
  ]);
  const sending = state().sendAgent('已完成');
  await tick();
  assert.equal(state().live?.status, 'done');
  await state().abortAgent();
  assert.equal(state().live?.status, 'done');
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions/s1/abort'), false);
  assert.equal(turn.signal.current?.aborted, true);
  await sending;
  assert.equal(state().live, undefined);
});

test('abort 请求失败给提示、清审批，并保留本地失败终态', async () => {
  const turn = openTurn();
  routes.set('/api/agent/sessions/s1/abort', () => json({ error: { message: '网关不可达', code: 'NETWORK' } }, 500));
  const sending = state().sendAgent('执行中');
  await tick();
  state().handleAgentEvent({
    type: 'approval_required',
    approvalId: 'a1',
    expiresIn: 300000,
    call: { tool: 'create_table', args: {}, risk: 'ddl', summary: '建表' },
  });
  await state().abortAgent();
  await sending;
  assert.equal(turn.signal.current?.aborted, true);
  assert.equal(state().approval, undefined);
  assert.deepEqual(state().approvalQueue, []);
  assert.equal(state().live?.status, 'error');
  assert.match(state().live?.error ?? '', /未能确认服务端/);
  assert.equal(state().toasts.at(-1)?.kind, 'error');
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions/s1'), false, '确认失败时不能拉历史冒充已收尾');
  assert.equal(state().agentStopUnconfirmed, true);
  routes.set('/api/agent/sessions/s1/abort', () => json({ ok: true }));
  assert.equal(await state().abortAgent(), true, '失败后必须能重试停止');
  assert.equal(state().agentStopUnconfirmed, false);
});

test('会话仍在 creating 时新建/加载都拒绝切换，保留当前创建回合', async () => {
  const created = deferred<Response>();
  routes.set('/api/agent/sessions', (init) => init?.method === 'POST' ? created.promise : json({ sessions: [] }));
  useApp.setState({ agentSessionId: undefined, agentSessionMeta: undefined });
  const sending = state().sendAgent('创建中的草稿');
  await tick();

  assert.equal(await state().newAgentSession(), false);
  assert.equal(await state().loadAgentSession('s2'), false);
  assert.equal(state().agentStarting, true);
  assert.equal(state().agentSessionId, undefined);
  assert.equal(state().agentSessionSwitching, false);
  assert.equal(calls.filter((call) => call.path === '/api/agent/sessions' && call.init?.method === 'POST').length, 1);
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions/s2'), false);
  assert.match(state().toasts.at(-1)?.detail ?? '', /创建完成或停止/);

  assert.equal(await state().abortAgent(), false);
  created.resolve(json({ session: session('created') }, 201));
  assert.equal(await sending, false);
  assert.equal(calls.some((call) => call.path.endsWith('/turns')), false);
});

test('加载会话等待 abort 确认，确认前保留旧会话且不允许改作用域', async () => {
  const turn = openTurn([{ type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' }]);
  const confirmation = deferred<Response>();
  routes.set('/api/agent/sessions/s1/abort', () => confirmation.promise);
  useApp.setState({ activeConnectionId: 'c1', agentDatabase: 'db1' });
  const sending = state().sendAgent('执行中');
  await tick();

  const loading = state().loadAgentSession('s2');
  await tick();
  assert.equal(state().agentSessionId, 's1');
  assert.equal(state().live?.status, 'streaming');
  assert.equal(state().agentSessionSwitching, true);
  state().setActiveConnection('c2');
  await state().setAgentDatabase('db2');
  assert.equal(state().activeConnectionId, 'c1');
  assert.equal(state().agentDatabase, 'db1');
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions/s2'), false);

  confirmation.resolve(json({ ok: true }));
  assert.equal(await loading, true);
  await sending;
  assert.equal(state().agentSessionId, 's2');
  assert.equal(state().live, undefined);
  assert.equal(state().agentSessionSwitching, false);
  assert.equal(turn.signal.current?.aborted, true);
});

test('新建会话在 abort 失败后保留旧会话与作用域，重试确认后才原子切换', async () => {
  openTurn([{ type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' }]);
  routes.set('/api/agent/sessions/s1/abort', () => json({ error: { message: '网关不可达', code: 'NETWORK' } }, 500));
  useApp.setState({ activeConnectionId: 'c1', agentDatabase: 'db1' });
  const sending = state().sendAgent('执行中');
  await tick();

  assert.equal(await state().newAgentSession(), false);
  await sending;
  assert.equal(state().agentSessionId, 's1');
  assert.equal(state().agentDatabase, 'db1');
  assert.equal(state().agentStopUnconfirmed, true);
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions' && call.init?.method === 'POST'), false);
  state().setActiveConnection('c2');
  await state().setAgentDatabase('db2');
  assert.equal(state().activeConnectionId, 'c1');
  assert.equal(state().agentDatabase, 'db1');

  routes.set('/api/agent/sessions/s1/abort', () => json({ ok: true }));
  routes.set('/api/agent/sessions', (init) => init?.method === 'POST'
    ? json({ session: session('new') }, 201)
    : json({ sessions: [] }));
  assert.equal(await state().newAgentSession(), true);
  assert.equal(state().agentSessionId, 'new');
  assert.equal(state().agentDatabase, 'db1');
  assert.equal(state().live, undefined);
  assert.equal(state().agentStopUnconfirmed, false);
  assert.equal(calls.filter((call) => call.path === '/api/agent/sessions/s1/abort').length, 2);
  assert.equal(calls.filter((call) => call.path === '/api/agent/sessions' && call.init?.method === 'POST').length, 1);
});

test('加载会话在 abort 失败后不拉取目标，重试确认后才落地', async () => {
  openTurn([{ type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' }]);
  routes.set('/api/agent/sessions/s1/abort', () => json({ error: { message: '网关不可达', code: 'NETWORK' } }, 500));
  const sending = state().sendAgent('执行中');
  await tick();

  assert.equal(await state().loadAgentSession('s2'), false);
  await sending;
  assert.equal(state().agentSessionId, 's1');
  assert.equal(state().agentStopUnconfirmed, true);
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions/s2'), false);

  routes.set('/api/agent/sessions/s1/abort', () => json({ ok: true }));
  assert.equal(await state().loadAgentSession('s2'), true);
  assert.equal(state().agentSessionId, 's2');
  assert.equal(state().agentStopUnconfirmed, false);
});

test('运行中所有连接/库切换入口均被拒绝，停止确认后恢复', async () => {
  openTurn([{ type: 'start', turnId: 'turn-1', sessionId: 's1', model: 'm' }]);
  useApp.setState({ activeConnectionId: 'c1', agentDatabase: 'db1', schemas: { c2: [] } });
  const sending = state().sendAgent('执行中');
  await tick();
  const tabCount = state().tabs.length;

  state().setActiveConnection('c2');
  state().selectConnection('c2');
  state().toggleConnection('c2');
  await state().setAgentDatabase('db2');
  state().openQuery('c2', 'select 1');
  assert.equal(state().activeConnectionId, 'c1');
  assert.equal(state().agentDatabase, 'db1');
  assert.equal(state().tabs.length, tabCount);
  assert.ok(state().toasts.filter((toast) => toast.kind === 'warning').length >= 4);

  await state().abortAgent();
  await sending;
  state().setActiveConnection('c2');
  await state().setAgentDatabase('db2');
  assert.equal(state().activeConnectionId, 'c2');
  assert.equal(state().agentDatabase, 'db2');
});

test('会话详情请求在飞时锁住作用域与发送，回包只提交一次快照', async () => {
  const detail = deferred<Response>();
  routes.set('/api/agent/sessions/s2', () => detail.promise);
  useApp.setState({ activeConnectionId: 'c1', agentDatabase: 'db1', schemas: { c9: [] } });
  const loading = state().loadAgentSession('s2');
  await tick();
  assert.equal(state().agentSessionSwitching, true);
  state().setActiveConnection('c2');
  assert.equal(await state().sendAgent('不能发送'), false);
  assert.equal(state().activeConnectionId, 'c1');

  detail.resolve(json({
    session: { ...session('s2'), connectionId: 'c9', database: 'db9' },
    messages: [],
    toolRuns: [],
  }));
  assert.equal(await loading, true);
  assert.equal(state().agentSessionId, 's2');
  assert.equal(state().activeConnectionId, 'c9');
  assert.equal(state().agentDatabase, 'db9');
  assert.equal(state().agentSessionSwitching, false);
});

test('切库自动恢复从 refresh 到详情全程锁发送，原子提交目标会话', async () => {
  const refresh = deferred<Response>();
  const detail = deferred<Response>();
  routes.set('/api/agent/sessions', (init) => init?.method === 'POST' ? json({ sessions: [] }) : refresh.promise);
  routes.set('/api/agent/sessions/s2', () => detail.promise);
  useApp.setState({ activeConnectionId: 'c1', agentDatabase: 'db1' });

  const restoring = state().setAgentDatabase('db2');
  await tick();
  assert.equal(state().agentDatabase, 'db2');
  assert.equal(state().agentSessionSwitching, true, 'refresh 在飞时也必须进入切换锁');
  assert.equal(await state().sendAgent('恢复期间不应发送'), false);
  assert.equal(calls.some((call) => call.path.endsWith('/turns')), false);

  refresh.resolve(json({ sessions: [{ ...session('s2'), connectionId: 'c1', database: 'db2' }] }));
  await tick();
  assert.equal(calls.some((call) => call.path === '/api/agent/sessions/s2'), true);
  assert.equal(state().agentSessionSwitching, true, '详情在飞时不能出现解锁窗口');
  assert.equal(await state().sendAgent('详情期间不应发送'), false);

  detail.resolve(json({
    session: { ...session('s2'), connectionId: 'c1', database: 'db2' },
    messages: [],
    toolRuns: [],
  }));
  await restoring;
  assert.equal(state().agentSessionId, 's2');
  assert.equal(state().agentDatabase, 'db2');
  assert.equal(state().agentSessionSwitching, false);
});

test('旧切库恢复被新会话切换超越后，迟到空列表不能清新会话或解锁新操作', async () => {
  const refresh = deferred<Response>();
  routes.set('/api/agent/sessions', (init) => init?.method === 'POST' ? json({ sessions: [] }) : refresh.promise);
  routes.set('/api/agent/sessions/s3', () => json({
    session: { ...session('s3'), connectionId: 'c1', database: 'db3' },
    messages: [],
    toolRuns: [],
  }));
  useApp.setState({ activeConnectionId: 'c1', agentDatabase: 'db1' });

  const staleRestore = state().setAgentDatabase('db2');
  await tick();
  assert.equal(await state().loadAgentSession('s3'), true);
  assert.equal(state().agentSessionId, 's3');
  assert.equal(state().agentSessionSwitching, false);

  refresh.resolve(json({ sessions: [] }));
  await staleRestore;
  assert.equal(state().agentSessionId, 's3');
  assert.equal(state().agentSessionMeta?.id, 's3');
  assert.equal(state().agentDatabase, 'db3');
  assert.equal(state().agentSessionSwitching, false);
});

test('事件聚合拒绝跨会话 start 与跨回合 done，终态后忽略迟到 delta', () => {
  const live = {
    generation: 1,
    turnId: 'turn-1',
    userText: '当前回合',
    text: '',
    thinking: '',
    tools: [],
    timeline: [],
    stream: '',
    streamThinking: '',
    plan: [],
    status: 'streaming' as const,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    tokensIn: 0,
    tokensOut: 0,
    steps: 0,
    modelCalls: 0,
    contextTokens: 0,
    modelDurationMs: 0,
    memories: [],
  };
  useApp.setState({ agentSessionId: 's1', live });
  state().handleAgentEvent({ type: 'start', turnId: 'foreign', sessionId: 's2', model: 'm' });
  state().handleAgentEvent({ type: 'done', turnId: 'foreign', durationMs: 1 });
  state().handleAgentEvent({ type: 'text_delta', text: '旧回合' });
  assert.equal(state().live?.turnId, 'turn-1');
  assert.equal(state().live?.status, 'streaming');
  assert.equal(state().live?.text, '旧回合', '未带归属的 delta 由当前流通道的代次保护接收');

  state().handleAgentEvent({ type: 'done', turnId: 'turn-1', durationMs: 1 });
  state().handleAgentEvent({ type: 'text_delta', text: '迟到' });
  assert.equal(state().live?.text, '旧回合');
  assert.equal(state().live?.status, 'done');
});

test('AgentPanel 只在 sendAgent 受理回调里清空本次草稿和图片', () => {
  const source = readFileSync(new URL('../src/components/AgentPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  const sendDraft = async');
  const end = source.indexOf('  const send = () =>', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /sendAgent\(value, undefined, images, \(\) =>/);
  assert.ok(block.indexOf('setInput((current)') > block.indexOf('sendAgent(value'));
  assert.ok(block.indexOf('setPending((current)') > block.indexOf('sendAgent(value'));
  assert.doesNotMatch(block, /setPending\(\[\]\)/);
});

test('AgentPanel 开合不改变 hook 数量，所有 hook 都在条件 return 前', () => {
  const source = readFileSync(new URL('../src/components/AgentPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('export function AgentPanel()');
  const earlyReturn = source.indexOf('  if (!agentOpen) return null;', start);
  assert.ok(start >= 0 && earlyReturn > start);
  const body = source.slice(start);
  assert.equal((body.slice(0, earlyReturn - start).match(/\buseMemo(?:<[^>]+>)?\s*\(/g) ?? []).length, 5);
  assert.doesNotMatch(body.slice(earlyReturn - start), /\buse(?:App|Memo|Effect|Ref|State)\s*\(/, '关闭面板的早退之后不能再调用任何 hook');
});

test('AgentPanel 停止创建时取消组件等待，且旧操作收尾不能清新发送锁', () => {
  const source = readFileSync(new URL('../src/components/AgentPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  const stopAgent = () =>');
  const end = source.indexOf('  const send = () =>', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /sendRequestRef\.current\?\.abort\(\)/);
  assert.match(block, /Promise\.race\(/);
  assert.match(block, /controller\.signal/);
  assert.match(block, /operation === sendOperationSeq\.current/);
  assert.match(source, /onClick=\{stopAgent\}[^\n]*data-testid="agent-stop"/);
});

test('AgentPanel 锁住运行中作用域并提供停止未确认后的重试入口', () => {
  const source = readFileSync(new URL('../src/components/AgentPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /const scopeLocked = busy \|\| agentStopUnconfirmed \|\| agentSessionSwitching/);
  assert.ok((source.match(/disabled=\{scopeLocked\}/g) ?? []).length >= 3);
  const retry = source.indexOf('data-testid="agent-stop-retry"');
  assert.ok(retry >= 0);
  assert.match(source.slice(retry, retry + 700), /onClick=\{\(\) => void abortAgent\(\)\}/);
  assert.match(source, /\{busy \|\| agentStopUnconfirmed \? \(/);
  const clear = source.slice(source.indexOf("if (key === '/clear')"), source.indexOf("if (SLASH.some", source.indexOf("if (key === '/clear')")));
  assert.match(clear, /newAgentSession\(\)\.then/);
  assert.doesNotMatch(clear, /setInput\(''\)/);
});
