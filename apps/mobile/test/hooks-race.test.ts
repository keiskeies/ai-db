import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import * as ts from 'typescript';
import type { AgentMessage, AgentSessionMeta, ConnectionConfig, PermissionMode, TableInfo } from '@aidb/core';
import type { AgentTurnContext, ApprovalState, LiveTurn } from '../src/types';

const require = createRequire(import.meta.url);
const notifications: Array<{ title: string; message: string }> = [];

function stubModule(id: string, exports: unknown) {
  const filename = require.resolve(id);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

stubModule('react-native', { Alert: { alert() {} }, Platform: { OS: 'web' } });
stubModule('expo-secure-store', {});
stubModule('expo-file-system', {});
stubModule('expo-sharing', {});
stubModule('../src/lib/utils.ts', {
  notify(title: string, message: string) { notifications.push({ title, message }); },
  confirmAction: async () => true,
});

const React = require('react') as typeof import('react');
const originalHooks = { useRef: React.useRef, useState: React.useState, useEffect: React.useEffect };
const originalWebSocket = globalThis.WebSocket;
const runners = new Set<HookRunner<unknown>>();
let activeRunner: HookRunner<unknown> | undefined;

type EffectCell = { deps?: readonly unknown[]; cleanup?: void | (() => void); effect: () => void | (() => void) };

class HookRunner<T> {
  private cells: any[] = [];
  private cursor = 0;
  private effects: EffectCell[] = [];
  private cleanups: Array<() => void> = [];
  value!: T;

  constructor(private readonly hook: () => T) {
    runners.add(this as HookRunner<unknown>);
  }

  ref = <V>(initial: V): { current: V } => {
    const index = this.cursor++;
    if (!this.cells[index]) this.cells[index] = { ref: { current: initial } };
    return this.cells[index].ref;
  };

  state = <V>(initial: V | (() => V)): [V, (next: V | ((prev: V) => V)) => void] => {
    const index = this.cursor++;
    if (!this.cells[index]) {
      const value = typeof initial === 'function' ? (initial as () => V)() : initial;
      this.cells[index] = { value, set: (next: V | ((prev: V) => V)) => {
        this.cells[index].value = typeof next === 'function' ? (next as (prev: V) => V)(this.cells[index].value) : next;
      } };
    }
    return [this.cells[index].value, this.cells[index].set];
  };

  effect = (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = this.cursor++;
    const previous = this.cells[index] as EffectCell | undefined;
    const changed = !deps || !previous?.deps || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps![i]));
    const cell: EffectCell = { deps, effect, cleanup: previous?.cleanup };
    this.cells[index] = cell;
    if (changed) this.effects.push(cell);
  };

  render(): T {
    activeRunner = this as HookRunner<unknown>;
    this.cursor = 0;
    this.effects = [];
    try {
      this.value = this.hook();
    } finally {
      activeRunner = undefined;
    }
    for (const cell of this.effects) {
      cell.cleanup?.();
      const cleanup = cell.effect();
      cell.cleanup = cleanup;
      if (cleanup) this.cleanups.push(cleanup);
    }
    return this.value;
  }

  unmount() {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    runners.delete(this as HookRunner<unknown>);
  }
}

React.useRef = ((initial: unknown) => activeRunner!.ref(initial)) as typeof React.useRef;
React.useState = ((initial: unknown) => activeRunner!.state(initial)) as typeof React.useState;
React.useEffect = ((effect: () => void | (() => void), deps?: readonly unknown[]) => activeRunner!.effect(effect, deps)) as typeof React.useEffect;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: any[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(raw: string) {
    if (this.readyState !== 1) throw new Error('WebSocket 未连接');
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

const { useAgentSocket } = require('../src/hooks/useAgentSocket.ts') as typeof import('../src/hooks/useAgentSocket');
const { useSessions } = require('../src/hooks/useSessions.ts') as typeof import('../src/hooks/useSessions');
const { useSchema } = require('../src/hooks/useSchema.ts') as typeof import('../src/hooks/useSchema');
const { useBootstrap } = require('../src/hooks/useBootstrap.ts') as typeof import('../src/hooks/useBootstrap');

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const now = () => new Date().toISOString();

const session = (id: string, status: AgentSessionMeta['status'] = 'idle'): AgentSessionMeta => ({
  id,
  title: id,
  permissionMode: 'ask',
  status,
  tokensIn: 0,
  tokensOut: 0,
  turns: 0,
  steps: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  contextTokens: 0,
  createdAt: now(),
  updatedAt: now(),
});

const liveTurn = (sessionId = 's1', status: LiveTurn['status'] = 'streaming', generation = 1): LiveTurn => ({
  sessionId,
  generation,
  turnId: status === 'streaming' ? undefined : 'previous-turn',
  userText: '上一轮',
  text: status === 'streaming' ? '' : '上一轮结果',
  thinking: '',
  tools: [],
  timeline: [],
  stream: '',
  streamThinking: '',
  plan: [],
  status,
  pendingApprovalIds: [],
  suggestions: [],
  startedAt: Date.now() - 1000,
  tokensIn: 0,
  tokensOut: 0,
  steps: 0,
  modelCalls: 0,
  contextTokens: 0,
  modelDurationMs: 0,
  memories: [],
});

const approval = (approvalId: string, generation = 1): ApprovalState => ({
  approvalId,
  sessionId: 's1',
  generation,
  tool: 'query',
  args: {},
  risk: 'read',
  summary: approvalId,
});

interface SocketHarnessOptions {
  client?: any;
  input?: string;
  images?: Array<{ id: string; mime: string }>;
  approvals?: ApprovalState[];
  sessionId?: string;
  live?: LiveTurn;
  turn?: AgentTurnContext;
  scopeLockedRef?: { current: boolean };
  sessionMutationLockedRef?: { current: boolean };
}

function socketHarness(options: SocketHarnessOptions = {}) {
  const state = {
    input: options.input ?? '原始草稿',
    images: options.images ?? [{ id: 'img-1', mime: 'image/png' }],
    approvals: options.approvals ?? [],
    live: options.live,
    messages: [] as AgentMessage[],
    sessionMeta: undefined as AgentSessionMeta | undefined,
    connected: false,
  };
  const sessionIdRef = { current: options.sessionId };
  const activeConnectionIdRef = { current: 'conn-1' };
  const activeDatabaseRef = { current: 'db-1' };
  const turnRef: { current?: AgentTurnContext } = { current: options.turn };
  if (!turnRef.current && state.live) {
    turnRef.current = {
      sessionId: state.live.sessionId,
      generation: state.live.generation,
      turnId: state.live.turnId,
      status: state.live.status,
    };
  }
  const sessionIdCalls: Array<string | undefined> = [];
  const update = <V>(setter: (next: V | ((prev: V) => V)) => void, value: V | ((prev: V) => V), previous: V): V =>
    typeof value === 'function' ? (value as (prev: V) => V)(previous) : value;
  const client = options.client ?? {
    createSession: async () => ({ session: session('created') }),
    abort: async () => ({ ok: true }),
  };
  const hookOptions: any = {
    live: state.live,
    mode: 'ask',
    input: state.input,
    pendingImages: state.images,
    uploadingImageRef: { current: false },
    approval: undefined,
    approvalQueue: state.approvals,
    setSessionId: (value: any) => {
      const next = update((fn: any) => fn, value, sessionIdRef.current);
      sessionIdCalls.push(next);
      sessionIdRef.current = next;
    },
    setSessionMeta: (value: any) => { state.sessionMeta = update((fn: any) => fn, value, state.sessionMeta); },
    setMessages: (value: any) => { state.messages = update((fn: any) => fn, value, state.messages); },
    setInput: (value: any) => { state.input = update((fn: any) => fn, value, state.input); },
    setPendingImages: (value: any) => { state.images = update((fn: any) => fn, value, state.images); },
    setLive: (value: any) => { state.live = update((fn: any) => fn, value, state.live); },
    setApprovalQueue: (value: any) => { state.approvals = update((fn: any) => fn, value, state.approvals); },
    setConnected: (value: boolean) => { state.connected = value; },
    loadSchema: async () => undefined,
    refreshSession: async () => undefined,
    refreshSessions: async () => undefined,
    sessionIdRef,
    activeConnectionIdRef,
    activeDatabaseRef,
    turnRef,
    scopeLockedRef: options.scopeLockedRef,
    sessionMutationLockedRef: options.sessionMutationLockedRef,
  };
  const runner = new HookRunner(() => useAgentSocket(client, hookOptions));
  runner.render();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  return {
    state,
    sessionIdRef,
    sessionIdCalls,
    turnRef,
    ws,
    runner,
    get api() { return runner.value; },
    rerender() {
      hookOptions.live = state.live;
      hookOptions.input = state.input;
      hookOptions.pendingImages = state.images;
      hookOptions.approvalQueue = state.approvals;
      return runner.render();
    },
    type(text: string) {
      hookOptions.setInput(text);
      this.rerender();
    },
    addImage(id: string) {
      hookOptions.setPendingImages((prev: typeof state.images) => [...prev, { id, mime: 'image/png' }]);
      this.rerender();
    },
    addApproval(item: ApprovalState) {
      hookOptions.setApprovalQueue((prev: ApprovalState[]) => [...prev, item]);
      this.rerender();
    },
    switchSession(id: string) {
      sessionIdRef.current = id;
      this.rerender();
    },
    switchScope(connectionId: string, database: string) {
      activeConnectionIdRef.current = connectionId;
      activeDatabaseRef.current = database;
    },
  };
}

beforeEach(() => {
  notifications.length = 0;
  FakeWebSocket.instances = [];
});

afterEach(() => {
  for (const runner of [...runners]) runner.unmount();
});

after(() => {
  React.useRef = originalHooks.useRef;
  React.useState = originalHooks.useState;
  React.useEffect = originalHooks.useEffect;
  globalThis.WebSocket = originalWebSocket;
});

test('createSession 返回前校验会话与代次快照，迟到的创建结果不能覆盖新会话或发送旧草稿', async () => {
  const created = deferred<{ session: AgentSessionMeta }>();
  const harness = socketHarness({ client: { createSession: () => created.promise } });
  const sending = harness.api.send();
  await tick();
  harness.type('等待期间的新输入');
  harness.switchSession('other-session');
  const switchedTurn: AgentTurnContext = { sessionId: 'other-session', generation: 9, status: 'done' };
  harness.turnRef.current = switchedTurn;

  created.resolve({ session: session('created') });
  await sending;

  assert.equal(harness.sessionIdRef.current, 'other-session');
  assert.equal(harness.turnRef.current, switchedTurn);
  assert.deepEqual(harness.sessionIdCalls, []);
  assert.equal(harness.state.sessionMeta, undefined);
  assert.equal(harness.state.input, '等待期间的新输入');
  assert.deepEqual(harness.ws.sent, []);
});

test('只有匹配当前 session/turn 的 start 才清本次草稿、图片和审批，等待期间的新内容保留', async () => {
  const harness = socketHarness({
    sessionId: 's1',
    input: '原始草稿',
    images: [{ id: 'img-1', mime: 'image/png' }],
    approvals: [approval('a1')],
  });
  await harness.api.send();
  assert.equal(harness.state.input, '原始草稿');
  assert.deepEqual(harness.state.images.map((item) => item.id), ['img-1']);
  assert.deepEqual(harness.state.approvals.map((item) => item.approvalId), ['a1']);

  harness.type('等待期间的新输入');
  harness.addImage('img-2');
  harness.addApproval(approval('a2'));
  harness.ws.emit({ type: 'start', sessionId: 's2', turnId: 'foreign' });
  assert.equal(harness.state.input, '等待期间的新输入');
  assert.deepEqual(harness.state.images.map((item) => item.id), ['img-1', 'img-2']);

  harness.ws.emit({ type: 'start', sessionId: 's1' });
  assert.equal(harness.state.input, '等待期间的新输入');
  assert.deepEqual(harness.state.images.map((item) => item.id), ['img-1', 'img-2']);

  harness.ws.emit({ type: 'start', sessionId: 's1', turnId: 'turn-1' });
  assert.equal(harness.state.input, '等待期间的新输入');
  assert.deepEqual(harness.state.images.map((item) => item.id), ['img-2']);
  assert.deepEqual(harness.state.approvals.map((item) => item.approvalId), ['a2']);
  assert.equal(harness.state.live?.turnId, 'turn-1');
});

test('start 前收到 SESSION_BUSY 拒绝会恢复发送快照并保留等待期间的新输入，可立即重试', async () => {
  const previousLive = liveTurn('s1', 'done');
  const previousTurn: AgentTurnContext = { sessionId: 's1', generation: 1, turnId: 'previous-turn', status: 'done' };
  const harness = socketHarness({ sessionId: 's1', live: previousLive, turn: previousTurn });
  await harness.api.send();
  harness.type('等待期间的新输入');
  harness.addImage('img-2');

  harness.ws.emit({ type: 'error', code: 'SESSION_BUSY', message: '会话正在运行' });
  assert.equal(harness.state.live, previousLive);
  assert.equal(harness.turnRef.current, previousTurn);
  assert.equal(harness.state.input, '等待期间的新输入');
  assert.deepEqual(new Set(harness.state.images.map((item) => item.id)), new Set(['img-1', 'img-2']));
  assert.equal(notifications.at(-1)?.message, '会话正在运行');

  await harness.api.send();
  assert.equal(harness.ws.sent.length, 2);
  assert.equal(harness.ws.sent[1].text, '等待期间的新输入');
});

test('abort 失败保持运行与审批，停止入口可重试；确认后才落本地中止态', async () => {
  const first = deferred<{ ok: boolean }>();
  const second = deferred<{ ok: boolean }>();
  let abortCalls = 0;
  const harness = socketHarness({
    sessionId: 's1',
    client: { abort: () => ++abortCalls === 1 ? first.promise : second.promise },
  });
  await harness.api.send();
  harness.ws.emit({ type: 'start', sessionId: 's1', turnId: 'turn-1' });
  harness.ws.emit({
    type: 'approval_required',
    sessionId: 's1',
    turnId: 'turn-1',
    approvalId: 'a1',
    call: { tool: 'query', args: {}, risk: 'read', summary: '查询' },
  });

  const stopping = harness.api.stop();
  assert.equal(harness.state.live?.status, 'awaiting');
  first.reject(new Error('网关不可达'));
  await stopping;
  assert.equal(harness.state.live?.status, 'awaiting');
  assert.equal(harness.turnRef.current?.status, 'awaiting');
  assert.deepEqual(harness.state.approvals.map((item) => item.approvalId), ['a1']);

  const retrying = harness.api.stop();
  assert.equal(abortCalls, 2);
  second.resolve({ ok: true });
  await retrying;
  assert.equal(harness.state.live?.status, 'aborted');
  assert.equal(harness.turnRef.current?.status, 'aborted');
  assert.deepEqual(harness.state.approvals, []);
});

test('abort 返回未确认和迟到成功都不能伪造或覆盖服务端终态', async () => {
  let abortCalls = 0;
  const unconfirmed = socketHarness({
    sessionId: 's1',
    client: { abort: async () => { abortCalls += 1; return { ok: false }; } },
  });
  await unconfirmed.api.send();
  unconfirmed.ws.emit({ type: 'start', sessionId: 's1', turnId: 'turn-1' });
  await unconfirmed.api.stop();
  await unconfirmed.api.stop();
  assert.equal(abortCalls, 2);
  assert.equal(unconfirmed.state.live?.status, 'streaming');

  const confirmation = deferred<{ ok: boolean }>();
  const terminal = socketHarness({ sessionId: 's1', client: { abort: () => confirmation.promise } });
  await terminal.api.send();
  terminal.ws.emit({ type: 'start', sessionId: 's1', turnId: 'turn-1' });
  const stopping = terminal.api.stop();
  terminal.ws.emit({ type: 'aborted', sessionId: 's1', turnId: 'turn-1', cause: 'stalled', reason: '服务端已停止' });
  confirmation.resolve({ ok: true });
  await stopping;
  assert.equal(terminal.state.live?.status, 'aborted');
  assert.equal(terminal.state.live?.abortCause, 'stalled');
  assert.equal(terminal.state.live?.abortReason, '服务端已停止');
});

test('createSession 在飞期间暴露 sending 锁，完成后释放', async () => {
  const created = deferred<{ session: AgentSessionMeta }>();
  const harness = socketHarness({ client: { createSession: () => created.promise } });
  const sending = harness.api.send();
  await tick();
  assert.equal(harness.rerender().sending, true);
  assert.equal(harness.state.input, '原始草稿');

  created.resolve({ session: session('created') });
  await sending;
  assert.equal(harness.rerender().sending, false);
  assert.equal(harness.sessionIdRef.current, 'created');
  assert.equal(harness.ws.sent.length, 1);
});

test('createSession 返回前切换连接或数据库不会把旧范围消息发到新会话', async () => {
  const created = deferred<{ session: AgentSessionMeta }>();
  const harness = socketHarness({ client: { createSession: () => created.promise } });
  const sending = harness.api.send();
  await tick();
  harness.switchScope('conn-2', 'db-2');
  created.resolve({ session: session('created') });
  await sending;

  assert.equal(harness.sessionIdRef.current, undefined);
  assert.deepEqual(harness.sessionIdCalls, []);
  assert.deepEqual(harness.ws.sent, []);
  assert.equal(harness.state.input, '原始草稿');
  assert.match(notifications.at(-1)?.message ?? '', /范围已切换/);
});

test('会话删除在飞时锁定切换，结束后释放且拒绝重叠操作', async () => {
  const deleted = deferred<void>();
  let sessionReads = 0;
  const mutationLockedRef = { current: false };
  const runner = new HookRunner(() => useSessions({
    deleteSession: () => deleted.promise,
    session: async () => { sessionReads += 1; return { session: session('s2'), messages: [] }; },
    sessions: async () => ({ sessions: [] }),
  } as any, {
    activeConnectionId: undefined,
    activeDatabase: undefined,
    databases: [],
    databaseReadyFor: undefined,
    setActiveConnectionId() {},
    setActiveDatabase() {},
    activeConnectionIdRef: { current: undefined },
    preferredDatabaseRef: { current: undefined },
  }, {
    mode: 'ask',
    setMode() {},
    live: undefined,
    turnRef: { current: undefined },
    setLive() {},
    setApprovalQueue() {},
    setPicker() {},
    sessionMutationLockedRef: mutationLockedRef,
  }));
  runner.render();
  runner.value.setSessionId('s1');
  runner.render();

  const deleting = runner.value.deleteSession('s1');
  await tick();
  assert.equal(mutationLockedRef.current, true);
  assert.equal(runner.render().sessionMutating, true);
  await runner.value.openSession('s2');
  assert.equal(sessionReads, 0);

  deleted.resolve();
  await deleting;
  assert.equal(mutationLockedRef.current, false);
  assert.equal(runner.render().sessionMutating, false);
  assert.equal(runner.render().sessionId, undefined);
});

test('创建会话可取消：立即释放 sending/scope 锁，递增代次并忽略迟到创建响应', async () => {
  const firstCreated = deferred<{ session: AgentSessionMeta }>();
  const signals: AbortSignal[] = [];
  let createCalls = 0;
  const scopeLockedRef = { current: false };
  const harness = socketHarness({
    scopeLockedRef,
    client: {
      createSession: (_body: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        createCalls += 1;
        return createCalls === 1 ? firstCreated.promise : Promise.resolve({ session: session('created-2') });
      },
    },
  });

  const sending = harness.api.send();
  await tick();
  assert.equal(harness.rerender().sending, true);
  assert.equal(scopeLockedRef.current, true);
  assert.equal(harness.api.cancelSend(), true);
  await sending;
  assert.equal(signals[0].aborted, true);
  assert.equal(harness.rerender().sending, false);
  assert.equal(scopeLockedRef.current, false);
  assert.equal(harness.sessionIdRef.current, undefined);

  firstCreated.resolve({ session: session('late-created') });
  await tick();
  assert.equal(harness.sessionIdRef.current, undefined);
  assert.deepEqual(harness.ws.sent, []);

  harness.type('取消后的新草稿');
  await harness.api.send();
  assert.equal(harness.sessionIdRef.current, 'created-2');
  const sent = harness.ws.sent as any[];
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '取消后的新草稿');
});

test('createSession 超时通过 AbortController 解锁，迟到响应仍不能提交', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created = deferred<{ session: AgentSessionMeta }>();
  let signal: AbortSignal | undefined;
  const harness = socketHarness({
    client: {
      createSession: (_body: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return created.promise;
      },
    },
  });
  const sending = harness.api.send();
  await tick();
  t.mock.timers.tick(15_000);
  await sending;

  assert.equal(signal?.aborted, true);
  assert.equal(harness.rerender().sending, false);
  assert.equal(harness.sessionIdRef.current, undefined);
  assert.match(notifications.at(-1)?.message ?? '', /创建会话超时/);
  created.resolve({ session: session('too-late') });
  await tick();
  assert.equal(harness.sessionIdRef.current, undefined);
  assert.deepEqual(harness.ws.sent, []);
});

test('start 前 stop 成功清 pending 并恢复草稿/图片/上一回合，迟到 start 不再清发送内容', async () => {
  const previousLive = liveTurn('s1', 'done');
  const previousTurn: AgentTurnContext = { sessionId: 's1', generation: 1, turnId: 'previous-turn', status: 'done' };
  const harness = socketHarness({
    sessionId: 's1',
    live: previousLive,
    turn: previousTurn,
    input: '待发送草稿',
    images: [{ id: 'img-1', mime: 'image/png' }],
    approvals: [approval('a1')],
  });
  await harness.api.send();
  assert.equal(harness.state.input, '待发送草稿');
  harness.ws.emit({
    type: 'approval_required',
    sessionId: 's1',
    approvalId: 'a-new',
    call: { tool: 'query', args: {}, risk: 'read', summary: 'start 前到达的审批' },
  });
  assert.deepEqual(harness.state.approvals.map((item) => item.approvalId), ['a1', 'a-new']);

  await harness.api.stop();
  assert.equal(harness.state.live, previousLive);
  assert.equal(harness.turnRef.current, previousTurn);
  assert.equal(harness.state.input, '待发送草稿');
  assert.deepEqual(harness.state.images.map((item) => item.id), ['img-1']);
  assert.deepEqual(harness.state.approvals.map((item) => item.approvalId), ['a1']);

  harness.ws.emit({ type: 'start', sessionId: 's1', turnId: 'late-turn' });
  assert.equal(harness.state.live, previousLive);
  assert.equal(harness.state.input, '待发送草稿');
  assert.deepEqual(harness.state.images.map((item) => item.id), ['img-1']);
});

test('refreshSession 遇到仍 running 的 SESSION_BUSY 会话不定稿，保留 live/turn；非 running 仍正常定稿', async () => {
  const currentLive = liveTurn('s1', 'streaming');
  const currentTurn: AgentTurnContext = { sessionId: 's1', generation: 1, status: 'streaming' };
  const turnRef: { current?: AgentTurnContext } = { current: currentTurn };
  let live = currentLive;
  let detail = { session: session('s1', 'running'), messages: [] as AgentMessage[] };
  const runner = new HookRunner(() => useSessions({ session: async () => detail } as any, {
    activeConnectionId: undefined,
    activeDatabase: undefined,
    databases: [],
    databaseReadyFor: undefined,
    setActiveConnectionId() {},
    setActiveDatabase() {},
    activeConnectionIdRef: { current: undefined },
    preferredDatabaseRef: { current: undefined },
  }, {
    mode: 'ask',
    setMode() {},
    live,
    turnRef,
    setLive: (value: any) => { live = typeof value === 'function' ? value(live) : value; },
    setApprovalQueue() {},
    setPicker() {},
  }));
  runner.render();
  runner.value.setSessionId('s1');
  runner.render();

  await runner.value.refreshSession('s1', { finalize: true });
  assert.equal(live, currentLive);
  assert.equal(turnRef.current, currentTurn);
  assert.equal(runner.render().sessionMeta?.status, 'running');
  assert.deepEqual(runner.value.messages, []);

  const persisted = { id: 'm1', role: 'user', content: '已持久化', blocks: [] } as unknown as AgentMessage;
  detail = { session: session('s1', 'idle'), messages: [persisted] };
  await runner.value.refreshSession('s1', { finalize: true });
  assert.equal(live, undefined);
  assert.equal(turnRef.current, undefined);
  assert.deepEqual(runner.render().messages, [persisted]);
});

test('refreshSession GET 失败保留 running 的 live/turn/approval 所有权，并允许随后重试', async () => {
  const failed = deferred<{ session: AgentSessionMeta; messages: AgentMessage[] }>();
  const currentLive = liveTurn('s1', 'awaiting');
  const currentTurn: AgentTurnContext = { sessionId: 's1', generation: 1, status: 'awaiting' };
  const turnRef: { current?: AgentTurnContext } = { current: currentTurn };
  let live = currentLive;
  let approvals = [approval('a1')];
  let reads = 0;
  let detail = { session: session('s1', 'running'), messages: [] as AgentMessage[] };
  const runner = new HookRunner(() => useSessions({
    session: () => ++reads === 1 ? failed.promise : Promise.resolve(detail),
  } as any, {
    activeConnectionId: undefined,
    activeDatabase: undefined,
    databases: [],
    databaseReadyFor: undefined,
    setActiveConnectionId() {},
    setActiveDatabase() {},
    activeConnectionIdRef: { current: undefined },
    preferredDatabaseRef: { current: undefined },
  }, {
    mode: 'ask',
    setMode() {},
    live,
    turnRef,
    setLive: (value: any) => { live = typeof value === 'function' ? value(live) : value; },
    setApprovalQueue: (value: any) => { approvals = typeof value === 'function' ? value(approvals) : value; },
    setPicker() {},
  }));
  runner.render();
  runner.value.setSessionId('s1');
  runner.render();

  failed.reject(new Error('Bridge 不可达'));
  await runner.value.refreshSession('s1', { finalize: true });
  assert.equal(live, currentLive);
  assert.equal(live.status, 'awaiting');
  assert.equal(turnRef.current, currentTurn);
  assert.deepEqual(approvals.map((item) => item.approvalId), ['a1']);

  await runner.value.refreshSession('s1', { finalize: true });
  assert.equal(reads, 2);
  assert.equal(live, currentLive);
  assert.equal(turnRef.current, currentTurn);

  const persisted = { id: 'm1', role: 'user', content: '已持久化', blocks: [] } as unknown as AgentMessage;
  detail = { session: session('s1', 'idle'), messages: [persisted] };
  await runner.value.refreshSession('s1', { finalize: true });
  assert.equal(live, undefined);
  assert.equal(turnRef.current, undefined);
  assert.deepEqual(runner.render().messages, [persisted]);
});

test('同连接会话库在数据库列表未加载时保留 preferred，列表返回校验后应用', async () => {
  const databaseList = deferred<{ databases: string[] }>();
  const detail = deferred<{ session: AgentSessionMeta; messages: AgentMessage[] }>();
  const connection = { id: 'conn-1', name: '连接', database: 'default-db' } as ConnectionConfig;
  const schemaRunner = new HookRunner(() => useSchema({
    databases: () => databaseList.promise,
    schema: async () => ({ schemas: [] }),
  } as any, {
    setPicker() {},
    setSelectedTable() {},
    setDataPage() {},
  }));
  let schemaApi = schemaRunner.render();
  schemaApi.setConnections([connection]);
  schemaApi.setActiveConnectionId('conn-1');
  schemaApi = schemaRunner.render();
  await tick();

  const sessionsRunner = new HookRunner(() => useSessions({ session: () => detail.promise } as any, {
    activeConnectionId: schemaRunner.value.activeConnectionId,
    activeDatabase: schemaRunner.value.activeDatabase,
    databases: schemaRunner.value.databases,
    databaseReadyFor: schemaRunner.value.databaseReadyFor,
    setActiveConnectionId: schemaRunner.value.setActiveConnectionId,
    setActiveDatabase: schemaRunner.value.setActiveDatabase,
    activeConnectionIdRef: schemaRunner.value.activeConnectionIdRef,
    preferredDatabaseRef: schemaRunner.value.preferredDatabaseRef,
  }, {
    mode: 'ask',
    setMode() {},
    live: undefined,
    turnRef: { current: undefined },
    setLive() {},
    setApprovalQueue() {},
    setPicker() {},
  }));
  sessionsRunner.render();
  const opening = sessionsRunner.value.openSession('session-db');
  await tick();
  detail.resolve({
    session: { ...session('session-db'), connectionId: 'conn-1', database: 'session-db' },
    messages: [],
  });
  await opening;
  assert.equal(schemaRunner.value.preferredDatabaseRef.current, 'session-db');
  assert.equal(schemaRunner.value.activeDatabase, undefined);

  databaseList.resolve({ databases: ['default-db', 'session-db'] });
  await tick();
  schemaRunner.render();
  assert.equal(schemaRunner.value.activeDatabase, 'session-db');
  assert.equal(schemaRunner.value.databaseReadyFor, 'conn-1');
  assert.equal(schemaRunner.value.preferredDatabaseRef.current, undefined);
});

test('active/archived 会话列表只有最新请求可以覆盖状态', async () => {
  const activeOld = deferred<{ sessions: AgentSessionMeta[] }>();
  const activeNew = deferred<{ sessions: AgentSessionMeta[] }>();
  const archivedOld = deferred<{ sessions: AgentSessionMeta[] }>();
  const archivedNew = deferred<{ sessions: AgentSessionMeta[] }>();
  let activeCalls = 0;
  let archivedCalls = 0;
  const runner = new HookRunner(() => useSessions({
    sessions: (archived: boolean) => {
      if (archived) return ++archivedCalls === 1 ? archivedOld.promise : archivedNew.promise;
      return ++activeCalls === 1 ? activeOld.promise : activeNew.promise;
    },
  } as any, {
    activeConnectionId: undefined,
    activeDatabase: undefined,
    databases: [],
    databaseReadyFor: undefined,
    setActiveConnectionId() {},
    setActiveDatabase() {},
    activeConnectionIdRef: { current: undefined },
    preferredDatabaseRef: { current: undefined },
  }, {
    mode: 'ask',
    setMode() {},
    live: undefined,
    turnRef: { current: undefined },
    setLive() {},
    setApprovalQueue() {},
    setPicker() {},
  }));
  runner.render();

  const oldActive = runner.value.refreshSessions();
  const newActive = runner.value.refreshSessions();
  activeNew.resolve({ sessions: [session('active-new')] });
  await newActive;
  activeOld.resolve({ sessions: [session('active-old')] });
  await oldActive;
  assert.deepEqual(runner.render().sessions.map((item) => item.id), ['active-new']);

  const oldArchived = runner.value.refreshArchivedSessions();
  const newArchived = runner.value.refreshArchivedSessions();
  archivedNew.resolve({ sessions: [session('archived-new')] });
  await newArchived;
  archivedOld.resolve({ sessions: [session('archived-old')] });
  await oldArchived;
  assert.deepEqual(runner.render().archivedSessions.map((item) => item.id), ['archived-new']);
});

test('归档纳入 mutation 锁，迟到响应不清后来打开的 B；归档当前会话同步清 live/turn/approval', async () => {
  const archived = deferred<{ session: AgentSessionMeta }>();
  let updateCalls = 0;
  let sessionReads = 0;
  const mutationLockedRef = { current: false };
  let live: LiveTurn | undefined;
  let approvals: ApprovalState[] = [];
  const turnRef: { current?: AgentTurnContext } = { current: undefined };
  const runner = new HookRunner(() => useSessions({
    updateSession: () => ++updateCalls === 1 ? archived.promise : Promise.resolve({ session: session('A') }),
    session: async () => { sessionReads += 1; return { session: session('B'), messages: [] }; },
    sessions: async () => ({ sessions: [] }),
  } as any, {
    activeConnectionId: undefined,
    activeDatabase: undefined,
    databases: [],
    databaseReadyFor: undefined,
    setActiveConnectionId() {},
    setActiveDatabase() {},
    activeConnectionIdRef: { current: undefined },
    preferredDatabaseRef: { current: undefined },
  }, {
    mode: 'ask',
    setMode() {},
    live,
    turnRef,
    setLive: (value: any) => { live = typeof value === 'function' ? value(live) : value; },
    setApprovalQueue: (value: any) => { approvals = typeof value === 'function' ? value(approvals) : value; },
    setPicker() {},
    sessionMutationLockedRef: mutationLockedRef,
  }));
  runner.render();
  runner.value.setSessionId('A');
  runner.value.setSessionMeta(session('A'));
  const messageB = { id: 'b-message', role: 'user', content: 'B 的消息', blocks: [] } as unknown as AgentMessage;
  runner.render();

  const archiving = runner.value.archiveSession('A', true);
  await tick();
  assert.equal(mutationLockedRef.current, true);
  assert.equal(runner.render().sessionMutating, true);
  await runner.value.openSession('B');
  assert.equal(sessionReads, 0);

  // 模拟锁释放前已经切换到 B 的外部状态提交，验证归档响应不使用点击时闭包。
  const liveB = liveTurn('B', 'done');
  const turnB: AgentTurnContext = { sessionId: 'B', generation: 1, turnId: 'previous-turn', status: 'done' };
  runner.value.setSessionId('B');
  runner.value.setSessionMeta(session('B'));
  runner.value.setMessages([messageB]);
  live = liveB;
  turnRef.current = turnB;
  approvals = [{ ...approval('b-approval'), sessionId: 'B' }];
  archived.resolve({ session: session('A') });
  await archiving;

  assert.equal(runner.render().sessionId, 'B');
  assert.equal(runner.render().sessionMeta?.id, 'B');
  assert.deepEqual(runner.render().messages, [messageB]);
  assert.equal(live, liveB);
  assert.equal(turnRef.current, turnB);
  assert.deepEqual(approvals.map((item) => item.approvalId), ['b-approval']);
  assert.equal(mutationLockedRef.current, false);

  runner.value.setSessionId('A');
  runner.value.setSessionMeta(session('A'));
  runner.value.setMessages([messageB]);
  live = liveTurn('A', 'done');
  turnRef.current = { sessionId: 'A', generation: 1, turnId: 'previous-turn', status: 'done' };
  approvals = [approval('a-approval')];
  await runner.value.archiveSession('A', true);
  assert.equal(runner.render().sessionId, undefined);
  assert.equal(runner.render().sessionMeta, undefined);
  assert.deepEqual(runner.render().messages, []);
  assert.equal(live, undefined);
  assert.equal(turnRef.current, undefined);
  assert.deepEqual(approvals, []);
});

test('会话归档请求超时会 abort 并释放 mutation 锁', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updated = deferred<{ session: AgentSessionMeta }>();
  let signal: AbortSignal | undefined;
  const mutationLockedRef = { current: false };
  const runner = new HookRunner(() => useSessions({
    updateSession: (_id: string, _patch: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return updated.promise;
    },
    sessions: async () => ({ sessions: [] }),
  } as any, {
    activeConnectionId: undefined,
    activeDatabase: undefined,
    databases: [],
    databaseReadyFor: undefined,
    setActiveConnectionId() {},
    setActiveDatabase() {},
    activeConnectionIdRef: { current: undefined },
    preferredDatabaseRef: { current: undefined },
  }, {
    mode: 'ask',
    setMode() {},
    live: undefined,
    turnRef: { current: undefined },
    setLive() {},
    setApprovalQueue() {},
    setPicker() {},
    sessionMutationLockedRef: mutationLockedRef,
  }));
  runner.render();
  const archiving = runner.value.archiveSession('A', true);
  await tick();
  t.mock.timers.tick(15_000);
  await archiving;
  assert.equal(signal?.aborted, true);
  assert.equal(mutationLockedRef.current, false);
  assert.equal(runner.render().sessionMutating, false);
  assert.match(notifications.at(-1)?.message ?? '', /归档操作超时/);
});

test('schema 跨连接/数据库并发时只有最新参数响应可以写 tables', async () => {
  const requests: Array<{ connectionId: string; database?: string; result: Deferred<any> }> = [];
  const runner = new HookRunner(() => useSchema({
    schema: (connectionId: string, database?: string) => {
      const result = deferred<any>();
      requests.push({ connectionId, database, result });
      return result.promise;
    },
  } as any, {
    setPicker() {},
    setSelectedTable() {},
    setDataPage() {},
  }));
  const api = runner.render();
  const tableA = { name: 'table_a' } as TableInfo;
  const tableB = { name: 'table_b' } as TableInfo;
  const loadingA = api.loadSchema('conn-1', 'db-a');
  const loadingB = api.loadSchema('conn-2', 'db-b');
  assert.deepEqual(requests.map(({ connectionId, database }) => ({ connectionId, database })), [
    { connectionId: 'conn-1', database: 'db-a' },
    { connectionId: 'conn-2', database: 'db-b' },
  ]);

  requests[1].result.resolve({ schemas: [{ tables: [tableB] }] });
  await loadingB;
  assert.deepEqual(runner.render().tables, [tableB]);
  requests[0].result.resolve({ schemas: [{ tables: [tableA] }] });
  await loadingA;
  assert.deepEqual(runner.render().tables, [tableB]);

  const loadingC = api.loadSchema('conn-3', 'db-c');
  api.setActiveDatabase('db-next');
  requests[2].result.resolve({ schemas: [{ tables: [tableA] }] });
  await loadingC;
  assert.deepEqual(runner.render().tables, [tableB]);
});

test('bootstrap 后续刷新不跳回首连接，运行或 mutation 锁期间不修改 scope', async () => {
  const initial = deferred<any>();
  let bootstrapCalls = 0;
  const activeConnectionIdRef = { current: undefined as string | undefined };
  const scopeLockedRef = { current: false };
  const sessionMutationLockedRef = { current: false };
  const selected: Array<string | undefined> = [];
  const modes: PermissionMode[] = [];
  const data = {
    connections: [
      { id: 'conn-a', name: 'A' },
      { id: 'conn-b', name: 'B' },
    ],
    sessions: [],
  };
  const runner = new HookRunner(() => useBootstrap({
    bootstrap: () => ++bootstrapCalls === 1 ? initial.promise : Promise.resolve(data),
  } as any, {
    setConnections() {},
    setSessions() {},
    setActiveConnectionId: (value: string | undefined | ((prev: string | undefined) => string | undefined)) => {
      const id = typeof value === 'function' ? value(activeConnectionIdRef.current) : value;
      selected.push(id);
      activeConnectionIdRef.current = id;
    },
    setMode: (value: PermissionMode | ((prev: PermissionMode) => PermissionMode)) => {
      modes.push(typeof value === 'function' ? value('readonly') : value);
    },
    activeConnectionIdRef,
    scopeLockedRef,
    sessionMutationLockedRef,
  }));
  runner.render();
  initial.resolve(data);
  await tick();
  assert.deepEqual(selected, ['conn-a']);
  assert.deepEqual(modes, ['readonly']);

  activeConnectionIdRef.current = 'conn-b';
  await runner.value.bootstrap();
  assert.deepEqual(selected, ['conn-a']);
  assert.deepEqual(modes, ['readonly']);

  activeConnectionIdRef.current = 'removed-connection';
  scopeLockedRef.current = true;
  await runner.value.bootstrap();
  assert.deepEqual(selected, ['conn-a']);

  scopeLockedRef.current = false;
  sessionMutationLockedRef.current = true;
  await runner.value.bootstrap();
  assert.deepEqual(selected, ['conn-a']);

  sessionMutationLockedRef.current = false;
  await runner.value.bootstrap();
  assert.deepEqual(selected, ['conn-a', 'conn-a']);
});

test('App openTable 的最新请求代次阻止表 A 迟到响应覆盖表 B', async () => {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'openTable') initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer, 'App.tsx 应保留 openTable');
  const compiled = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const factory = new Function(
    'client', 'activeConnectionId', 'activeDatabase', 'activeConnectionIdRef', 'activeDatabaseRef',
    'tableRequestRef', 'setSelectedTable', 'setDataLoading', 'setDataPage', 'notify',
    `return ${compiled}`,
  ) as (...args: any[]) => (table: TableInfo, offset?: number) => Promise<void>;

  const pageA = deferred<any>();
  const pageB = deferred<any>();
  const tableRequestRef = { current: 0 };
  const activeConnectionIdRef = { current: 'conn-1' };
  const activeDatabaseRef = { current: 'db-1' };
  let selectedTable: TableInfo | null = null;
  let dataPage: any = null;
  let loading = false;
  const notifications: unknown[] = [];
  const openTable = factory(
    { data: (_connection: string, table: string) => table === 'A' ? pageA.promise : pageB.promise },
    'conn-1', 'db-1', activeConnectionIdRef, activeDatabaseRef, tableRequestRef,
    (table: TableInfo | null) => { selectedTable = table; },
    (value: boolean) => { loading = value; },
    (page: any) => { dataPage = page; },
    (...args: unknown[]) => { notifications.push(args); },
  );
  const tableA = { name: 'A' } as TableInfo;
  const tableB = { name: 'B' } as TableInfo;
  const loadingA = openTable(tableA);
  const loadingB = openTable(tableB);
  assert.equal(selectedTable, tableB);
  assert.equal(loading, true);

  pageB.resolve({ table: 'B' });
  await loadingB;
  assert.equal(dataPage.table, 'B');
  assert.equal(loading, false);
  pageA.resolve({ table: 'A' });
  await loadingA;
  assert.equal(dataPage.table, 'B');
  assert.equal(selectedTable, tableB);
  assert.equal(loading, false);
  assert.deepEqual(notifications, []);
});
