import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '@aidb/core';
import { createGateway } from '../src/server';
import { AgentHost, compactProviderHistory, providerHistory } from '../src/agentHost';
import { ToolExecutor } from '../src/executor';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-agent-lifecycle-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'lifecycle-secret',
  token: 'lifecycle-token',
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  attachmentDir: join(home, 'attachments'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
const port = await listenRandom(gateway.server);
const base = `http://127.0.0.1:${port}`;
const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

function makeHost(): AgentHost {
  return new AgentHost({ store: gateway.store, manager: gateway.manager, executor, config: gateway.config });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const api = (path: string, init: RequestInit = {}) => fetch(`${base}/api${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', authorization: 'Bearer lifecycle-token', ...(init.headers ?? {}) },
});

test('active 在第一次 await 前注册，预检失败也会释放回合', async () => {
  const host = makeHost();
  const session = gateway.store.createSession({ title: '并发占用' });
  const imageGate = deferred<never[]>();
  const originalLoadImages = (host as any).loadImages;
  (host as any).loadImages = () => imageGate.promise;
  try {
    const first = host.startTurn(session.id, { text: '第一回合' }, () => undefined);
    assert.equal(host.isRunning(session.id), true, '图片加载让出执行权时也必须已占用 active');
    await assert.rejects(
      host.startTurn(session.id, { text: '并发第二回合' }, () => undefined),
      (error: any) => error?.code === 'SESSION_BUSY',
    );
    imageGate.resolve([]);
    await first;
    assert.equal(host.isRunning(session.id), false);

    (host as any).loadImages = async () => { throw Object.assign(new Error('图片不存在'), { code: 'ATTACHMENT_NOT_FOUND' }); };
    await assert.rejects(
      host.startTurn(session.id, { text: '预检失败' }, () => undefined),
      (error: any) => error?.code === 'ATTACHMENT_NOT_FOUND',
    );
    assert.equal(host.isRunning(session.id), false, 'runtime 启动前的异常不能泄漏 active');

    (host as any).loadImages = async () => [];
    await host.startTurn(session.id, { text: '失败后仍可重试' }, () => undefined);
    assert.equal(host.isRunning(session.id), false);
  } finally {
    (host as any).loadImages = originalLoadImages;
  }
});

test('旧回合 finally 与带代次的 abort 不会清掉或中止新回合', async () => {
  const host = makeHost();
  const session = gateway.store.createSession({ title: '代次隔离' });
  const imageGate = deferred<never[]>();
  const originalLoadImages = (host as any).loadImages;
  (host as any).loadImages = () => imageGate.promise;
  try {
    const oldTurn = host.startTurn(session.id, { text: '旧回合' }, () => undefined);
    const oldTurnId = host.getTurnId(session.id);
    assert.ok(oldTurnId);

    // 模拟旧回合收尾期间已经换成新代次，直接锁住 finally 的对象身份校验。
    const replacement = (host as any).beginTurn(session.id) as { id: string; controller: AbortController; finish: () => void };
    imageGate.resolve([]);
    await oldTurn;

    assert.equal(host.getTurnId(session.id), replacement.id, '旧 finally 不能删除新 active');
    assert.equal(host.abort(session.id, 'user', oldTurnId), false, '旧 WS 的代次不能中止新回合');
    assert.equal(replacement.controller.signal.aborted, false);
    assert.equal(host.abort(session.id, 'user', replacement.id), true);
    assert.equal(replacement.controller.signal.aborted, true);
    replacement.finish();
    assert.equal(host.isRunning(session.id), false);
  } finally {
    (host as any).loadImages = originalLoadImages;
  }
});

test('历史重建保留 tool_call 参数与配对的 tool_result，并丢弃未完成调用', async () => {
  const session = gateway.store.createSession({ title: '工具历史' });
  gateway.store.appendMessage({ sessionId: session.id, role: 'user', content: '统计订单' });
  const result = { ok: true, summary: '两行', data: { rows: [['paid', 2]] }, meta: { durationMs: 3 } };
  gateway.store.appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '查询结果如下',
    blocks: [
      { type: 'tool_call', callId: 'call-1', tool: 'run_sql', args: { sql: 'SELECT status, COUNT(*) FROM orders GROUP BY status' }, risk: 'read' },
      { type: 'tool_result', callId: 'call-1', tool: 'run_sql', result, status: 'ok' },
      { type: 'tool_call', callId: 'unfinished', tool: 'run_sql', args: { sql: 'SELECT 1' }, risk: 'read' },
      { type: 'tool_result', callId: 'orphan', tool: 'run_sql', result, status: 'ok' },
    ],
  });

  const history = await providerHistory(gateway.store.listMessages(session.id), gateway.config.attachmentDir);
  assert.deepEqual(history.map((message) => message.role), ['user', 'assistant', 'tool']);
  const assistant = history[1];
  assert.equal(assistant.role, 'assistant');
  if (assistant.role !== 'assistant') assert.fail('assistant 历史丢失');
  assert.equal(assistant.toolCalls?.length, 1);
  assert.deepEqual(assistant.toolCalls?.[0].args, { sql: 'SELECT status, COUNT(*) FROM orders GROUP BY status' });
  const tool = history[2];
  assert.equal(tool.role, 'tool');
  if (tool.role !== 'tool') assert.fail('tool 历史丢失');
  assert.equal(tool.toolCallId, 'call-1');
  assert.equal(tool.name, 'run_sql');
  assert.deepEqual(JSON.parse(tool.content), result);
});

test('历史预算裁剪不会留下孤立 tool 消息或不完整的 tool_calls', () => {
  const messages: Parameters<typeof compactProviderHistory>[0] = [
    { role: 'user', content: '很早的问题' },
    { role: 'assistant', content: '先查两张表', toolCalls: [
      { id: 'call-a', name: 'run_sql', args: { sql: 'SELECT 1' } },
      { id: 'call-b', name: 'run_sql', args: { sql: 'SELECT 2' } },
    ] },
    { role: 'tool', toolCallId: 'call-a', name: 'run_sql', content: '1' },
    { role: 'tool', toolCallId: 'call-b', name: 'run_sql', content: '2' },
    { role: 'user', content: '最新问题' },
  ];
  assert.deepEqual(compactProviderHistory(messages, Number.MAX_SAFE_INTEGER), messages);
  assert.deepEqual(compactProviderHistory(messages, 1), [{ role: 'user', content: '最新问题' }]);
  assert.deepEqual(compactProviderHistory(messages.slice(1, 3), 1), [
    { role: 'assistant', content: '先查两张表' },
  ]);
});

test('审批审计失败时保留 pending，可重试且 Promise 最终结算', async () => {
  const host = makeHost();
  const session = gateway.store.createSession({ title: '审批审计' });
  const payload = {
    id: 'approval-audit',
    call: { id: 'call-1', name: 'run_sql', args: { sql: 'DELETE FROM orders' } },
    risk: 'destructive' as const,
    summary: '删除订单',
    sql: 'DELETE FROM orders',
    expiresAt: Date.now() + 60_000,
  };
  const decision = (host as any).waitApproval(payload, session.id) as Promise<any>;
  const originalAudit = gateway.store.addAudit.bind(gateway.store);
  let fail = true;
  gateway.store.addAudit = ((entry: any) => {
    if (fail) throw new Error('审计存储不可用');
    originalAudit(entry);
  }) as typeof gateway.store.addAudit;
  try {
    assert.throws(() => host.resolveApproval(payload.id, 'deny', 'once'), /审计存储不可用/);
    assert.equal((host as any).approvals.has(payload.id), true, '审计失败不能先消费审批');
    fail = false;
    assert.equal(host.resolveApproval(payload.id, 'deny', 'once'), true);
    assert.deepEqual(await decision, { decision: 'deny', scope: 'once' });
    assert.equal((host as any).approvals.has(payload.id), false);
  } finally {
    const pending = (host as any).approvals.get(payload.id);
    if (pending) {
      clearTimeout(pending.timer);
      (host as any).approvals.delete(payload.id);
      pending.resolve({ decision: 'deny', scope: 'once' });
    }
    gateway.store.addAudit = originalAudit;
  }
});

test('/init 中止后不会遗留失效标记，下一回合仍可启动', async () => {
  const host = makeHost();
  const connection = gateway.store.listConnections()[0];
  assert.ok(connection);
  const session = gateway.store.createSession({ title: '初始化中止', connectionId: connection.id });
  const schemaGate = deferred<any[]>();
  const schemaStarted = deferred<void>();
  const originalSchema = gateway.manager.schema.bind(gateway.manager);
  gateway.manager.schema = (async () => {
    schemaStarted.resolve();
    return schemaGate.promise;
  }) as typeof gateway.manager.schema;
  try {
    const turn = host.startTurn(session.id, { text: '/init' }, () => undefined);
    await schemaStarted.promise;
    assert.equal(host.abort(session.id, 'user'), true);
    schemaGate.reject(new Error('schema 已取消'));
    await turn;

    assert.equal(host.isRunning(session.id), false);
    assert.equal(gateway.store.getSession(session.id)?.status, 'aborted');
    assert.equal(gateway.store.listMessages(session.id).some((message) => message.role === 'assistant'), false);
    await host.startTurn(session.id, { text: '初始化后继续对话' }, () => undefined);
    assert.equal(host.isRunning(session.id), false);
  } finally {
    gateway.manager.schema = originalSchema;
  }
});

test('DELETE 运行中的会话先取消并等待旧回合，且期间拒绝新回合', async () => {
  const host = gateway.host;
  const session = gateway.store.createSession({ title: '删除运行回合' });
  const runtimeGate = deferred<void>();
  const runtimeStarted = deferred<void>();
  const originalRun = AgentRuntime.prototype.run;
  AgentRuntime.prototype.run = async function () {
    runtimeStarted.resolve();
    await runtimeGate.promise;
    return {
      text: '旧回合迟到结果',
      status: 'done' as const,
      usage: { tokensIn: 0, tokensOut: 0 },
      steps: 1,
      modelCalls: 1,
      contextTokens: 0,
      modelDurationMs: 0,
      toolCalls: 0,
      plan: [],
      stop: 'end_turn' as const,
    };
  };
  const originalAbort = host.abort.bind(host);
  const abortSeen = deferred<void>();
  host.abort = ((...args: Parameters<AgentHost['abort']>) => {
    const result = originalAbort(...args);
    abortSeen.resolve();
    return result;
  }) as AgentHost['abort'];
  try {
    const turnResponse = api(`/agent/sessions/${session.id}/turns`, {
      method: 'POST',
      body: JSON.stringify({ text: '删除我' }),
    });
    assert.equal((await turnResponse).status, 200);
    await runtimeStarted.promise;

    let deleted = false;
    const deleteResponse = api(`/agent/sessions/${session.id}`, { method: 'DELETE' }).then((response) => {
      deleted = true;
      return response;
    });
    await abortSeen.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deleted, false, '旧 runtime 未收尾时 DELETE 不能提前返回');
    assert.ok(gateway.store.getSession(session.id));
    await assert.rejects(
      host.startTurn(session.id, { text: '删除期间的新回合' }, () => undefined),
      (error: any) => error?.code === 'SESSION_BUSY',
    );

    runtimeGate.resolve();
    const response = await deleteResponse;
    assert.equal(response.status, 204);
    assert.equal(gateway.store.getSession(session.id), undefined);
    assert.deepEqual(gateway.store.listMessages(session.id), [], '旧回合不能在删除后重新写回消息');
    assert.equal(host.isRunning(session.id), false);
  } finally {
    AgentRuntime.prototype.run = originalRun;
    host.abort = originalAbort;
    runtimeGate.resolve();
  }
});
