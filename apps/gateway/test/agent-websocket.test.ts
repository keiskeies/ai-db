import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createGateway } from '../src/server';
import type { AgentAccessContext, AgentHost, TurnInput } from '../src/agentHost';
import { listenRandom } from './helpers';
import { hashToken } from '../src/crypto';

const home = mkdtempSync(join(tmpdir(), 'aidb-agent-ws-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'ws-lifecycle-secret',
  token: 'ws-lifecycle-token',
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
const url = `ws://127.0.0.1:${port}/ws?token=ws-lifecycle-token`;
const DEVICE_TOKEN = 'ws-device-token';
const allowedConnection = gateway.store.createConnection({ name: 'WS allowed', engine: 'sqlite', database: ':memory:' });
const deniedConnection = gateway.store.createConnection({ name: 'WS denied', engine: 'sqlite', database: ':memory:' });
const device = gateway.store.createDevice({
  name: 'WS phone',
  platform: 'ios',
  tokenHash: hashToken(DEVICE_TOKEN),
  scope: 'device',
  connectionIds: [allowedConnection.id],
});

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function connect(token?: string): Promise<WebSocket> {
  const ws = new WebSocket(token ? `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}` : url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function close(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
}

function nextClose(ws: WebSocket): Promise<number> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(0);
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

function nextMessage(ws: WebSocket, type: string, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`未收到 ${type}`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const event = JSON.parse(String(raw));
      if (event.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(event);
    };
    ws.on('message', onMessage);
  });
}

test('WebSocket turn 传递 database/images，close 按所属代次取消回合', async () => {
  const host = gateway.host;
  const originalStart = host.startTurn;
  const originalGetTurnId = host.getTurnId;
  const originalAbort = host.abort;
  const gate = deferred();
  const seen = deferred();
  const aborted = deferred();
  const inputs: Array<{ sessionId: string; input: TurnInput }> = [];
  let currentTurnId: string | undefined;
  const aborts: Array<{ sessionId: string; cause: string; turnId?: string }> = [];
  host.startTurn = (async (sessionId: string, input: TurnInput) => {
    inputs.push({ sessionId, input });
    currentTurnId = 'ws-turn-1';
    seen.resolve();
    await gate.promise;
  }) as AgentHost['startTurn'];
  host.getTurnId = () => currentTurnId;
  host.abort = ((sessionId: string, cause: 'user' | 'disconnected', turnId?: string) => {
    aborts.push({ sessionId, cause, turnId });
    aborted.resolve();
    return true;
  }) as AgentHost['abort'];
  const ws = await connect();
  try {
    ws.send(JSON.stringify({
      type: 'turn',
      sessionId: 'session-ws',
      text: '移动端回合',
      mode: 'ask',
      attachments: ['orders'],
      images: ['00000000-0000-4000-8000-000000000001.png'],
      connectionId: 'connection-ws',
      database: 'database-ws',
    }));
    await seen.promise;
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0], {
      sessionId: 'session-ws',
      input: {
        text: '移动端回合',
        mode: 'ask',
        attachments: ['orders'],
        images: ['00000000-0000-4000-8000-000000000001.png'],
        connectionId: 'connection-ws',
        database: 'database-ws',
        disableMcp: true,
      },
    });

    await close(ws);
    await Promise.race([
      aborted.promise,
      new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('服务端未取消断线回合')), 1000);
        timer.unref();
      }),
    ]);
    assert.deepEqual(aborts, [{ sessionId: 'session-ws', cause: 'disconnected', turnId: 'ws-turn-1' }]);
  } finally {
    gate.resolve();
    await close(ws);
    host.startTurn = originalStart;
    host.getTurnId = originalGetTurnId;
    host.abort = originalAbort;
  }
});

test('心跳超时会取消该连接拥有的回合，旧代次不会命中新连接', async (t) => {
  const host = gateway.host;
  const originalStart = host.startTurn;
  const originalGetTurnId = host.getTurnId;
  const originalAbort = host.abort;
  const gate = deferred();
  const seen = deferred();
  let currentTurnId: string | undefined;
  const abortCalls: string[] = [];
  host.startTurn = (async () => {
    currentTurnId = 'old-ws-turn';
    seen.resolve();
    await gate.promise;
  }) as AgentHost['startTurn'];
  host.getTurnId = () => currentTurnId;
  host.abort = ((_sessionId: string, _cause: 'user' | 'disconnected', turnId?: string) => {
    if (turnId) abortCalls.push(turnId);
    return turnId === currentTurnId;
  }) as AgentHost['abort'];
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const ws = await connect();
  try {
    ws.send(JSON.stringify({ type: 'turn', sessionId: 'session-heartbeat', text: '心跳回合' }));
    await seen.promise;
    // 模拟旧连接收尾前，同会话已在另一条连接上启动新代次。
    currentTurnId = 'new-ws-turn';
    t.mock.timers.tick(90_000);
    assert.deepEqual(abortCalls, ['old-ws-turn']);
    assert.equal(currentTurnId, 'new-ws-turn', '心跳失败只能取消旧连接拥有的代次');
  } finally {
    gate.resolve();
    host.startTurn = originalStart;
    host.getTurnId = originalGetTurnId;
    host.abort = originalAbort;
    t.mock.timers.reset();
    await close(ws);
  }
});

test('device WebSocket abort 只接受连接拥有的代次，并传递持久化设备 ACL', async (t) => {
  const host = gateway.host;
  const session = gateway.store.createSession({ title: '设备越权中止', connectionId: deniedConnection.id });
  const gate = deferred();
  const started = deferred();
  let activeTurn: { id: string; controller: AbortController; finish: () => void } | undefined;
  const originalAbort = host.abort.bind(host);
  const aborts: Array<{ sessionId: string; turnId?: string; access?: any }> = [];
  t.mock.method(host, 'startTurn', (async () => {
    activeTurn = (host as any).beginTurn(session.id);
    started.resolve();
    await gate.promise;
  }) as AgentHost['startTurn']);
  t.mock.method(host, 'abort', ((sessionId: string, cause: 'user' | 'disconnected', turnId?: string, access?: any) => {
    aborts.push({ sessionId, turnId, access });
    return originalAbort(sessionId, cause, turnId, access);
  }) as AgentHost['abort']);

  const ws = await connect(DEVICE_TOKEN);
  try {
    ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '设备回合' }));
    await started.promise;
    ws.send(JSON.stringify({ type: 'abort', sessionId: session.id }));
    assert.equal((await nextMessage(ws, 'abort_ack')).ok, false, '连接拥有的代次也必须通过设备会话 ACL');
    assert.equal(aborts.length, 1);
    assert.deepEqual(aborts[0], {
      sessionId: session.id,
      turnId: activeTurn?.id,
      access: { scope: 'device', deviceId: device.id, connectionIds: [allowedConnection.id] },
    });
    assert.equal(activeTurn?.controller.signal.aborted, false);

    ws.send(JSON.stringify({ type: 'abort', sessionId: 'known-but-not-owned' }));
    assert.equal((await nextMessage(ws, 'abort_ack')).ok, false);
    assert.equal(aborts.length, 1, '不能只凭 sessionId 中止别人的活动');
  } finally {
    activeTurn?.finish();
    gate.resolve();
    await close(ws);
  }
});

test('device WebSocket approval 必须属于本连接的当前代次，且不能绕过会话 ACL', async (t) => {
  const host = gateway.host;
  const session = gateway.store.createSession({ title: '设备越权审批', connectionId: deniedConnection.id });
  const gate = deferred();
  const started = deferred();
  let currentTurnId: string | undefined;
  t.mock.method(host, 'startTurn', (async () => {
    currentTurnId = 'approval-owner-turn';
    started.resolve();
    await gate.promise;
  }) as AgentHost['startTurn']);
  t.mock.method(host, 'getTurnId', () => currentTurnId);

  const approvalId = 'known-denied-approval';
  const timer = setTimeout(() => undefined, 60_000);
  timer.unref();
  (host as any).approvals.set(approvalId, {
    resolve: () => undefined,
    timer,
    sessionId: session.id,
    turnId: 'approval-owner-turn',
    payload: {
      id: approvalId,
      call: { id: 'call-denied', name: 'run_sql', args: { sql: 'SELECT 1', connectionId: deniedConnection.id } },
      risk: 'read',
      summary: '越权审批',
      sql: 'SELECT 1',
      expiresAt: Date.now() + 60_000,
    },
  });
  const deviceWs = await connect(DEVICE_TOKEN);
  const adminWs = await connect();
  try {
    deviceWs.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '建立所属代次' }));
    await started.promise;
    deviceWs.send(JSON.stringify({ type: 'approval', approvalId, decision: 'allow', scope: 'once' }));
    assert.equal((await nextMessage(deviceWs, 'approval_ack')).ok, false, '即使 ID 和代次匹配，设备 ACL 仍必须拒绝');
    assert.equal((host as any).approvals.has(approvalId), true, '拒绝不能消费别人的审批');

    adminWs.send(JSON.stringify({ type: 'approval', approvalId, decision: 'allow', scope: 'once' }));
    assert.equal((await nextMessage(adminWs, 'approval_ack')).ok, false, '知道 approvalId 不能跨连接取得所有权');
    assert.equal((host as any).approvals.has(approvalId), true);
  } finally {
    clearTimeout(timer);
    (host as any).approvals.delete(approvalId);
    gate.resolve();
    await close(deviceWs);
    await close(adminWs);
  }
});

test('revoked and expired device sockets cannot start another turn', async (t) => {
  const host = gateway.host;
  let starts = 0;
  t.mock.method(host, 'startTurn', (async () => { starts += 1; }) as AgentHost['startTurn']);
  const cases = ['revoked', 'expired'] as const;
  for (const state of cases) {
    const token = `ws-recheck-turn-${state}`;
    const device = gateway.store.createDevice({
      name: state, platform: 'ios', tokenHash: hashToken(token), scope: 'device', connectionIds: [allowedConnection.id],
    });
    const session = gateway.store.createSession({ title: state, connectionId: allowedConnection.id, permissionMode: 'readonly' });
    const ws = await connect(token);
    try {
      if (state === 'revoked') {
        gateway.store.revokeDevice(device.id);
      } else {
        gateway.store.db.prepare("UPDATE devices SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(device.id);
      }
      const closed = nextClose(ws);
      ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '撤销后的回合' }));
      const error = await nextMessage(ws, 'error');
      assert.equal(error.code, 'UNAUTHORIZED', state);
      assert.equal(await closed, 4401, state);
    } finally {
      await close(ws);
    }
  }
  assert.equal(starts, 0, '失效凭据不能到达 Host');
});

test('WebSocket mutations use the current scope after an admin device is downgraded', async () => {
  const token = 'ws-scope-downgrade';
  const adminDevice = gateway.store.createDevice({
    name: 'downgrade', platform: 'desktop', tokenHash: hashToken(token), scope: 'admin',
  });
  const session = gateway.store.createSession({ title: 'scope downgrade', connectionId: allowedConnection.id, permissionMode: 'readonly' });
  const ws = await connect(token);
  try {
    gateway.store.db.prepare("UPDATE devices SET scope = 'device' WHERE id = ?").run(adminDevice.id);
    gateway.store.setDeviceConnectionPermissions(adminDevice.id, [allowedConnection.id]);
    const ended = nextMessage(ws, 'turn_end');
    ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '降级后仍请求 full', mode: 'full' }));
    const error = await nextMessage(ws, 'error');
    assert.equal(error.code, 'MODE_NOT_ALLOWED', '不得沿用连接时的 admin scope');
    await ended;
    assert.equal(ws.readyState, WebSocket.OPEN, '仍有效的低权限设备可以保持连接');

    gateway.store.db.prepare("UPDATE devices SET scope = 'mcp:readonly' WHERE id = ?").run(adminDevice.id);
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ type: 'abort', sessionId: session.id }));
    assert.equal((await nextMessage(ws, 'error')).code, 'UNAUTHORIZED');
    assert.equal(await closed, 4401, '只读 MCP scope 不能继续执行 WS mutation');
  } finally {
    await close(ws);
  }
});

test('revoked device abort is rejected and only transport cleanup cancels its exact owned turn', async (t) => {
  const host = gateway.host;
  const token = 'ws-revoked-abort';
  const device = gateway.store.createDevice({
    name: 'revoked abort', platform: 'ios', tokenHash: hashToken(token), scope: 'device', connectionIds: [allowedConnection.id],
  });
  const session = gateway.store.createSession({ title: 'revoked abort', connectionId: allowedConnection.id, permissionMode: 'readonly' });
  const gate = deferred();
  const started = deferred();
  let activeTurn: { id: string; controller: AbortController; finish: () => void } | undefined;
  const originalAbort = host.abort.bind(host);
  const aborts: Array<{ cause: string; turnId?: string; access?: unknown }> = [];
  t.mock.method(host, 'startTurn', (async () => {
    activeTurn = (host as any).beginTurn(session.id);
    started.resolve();
    await gate.promise;
  }) as AgentHost['startTurn']);
  t.mock.method(host, 'abort', ((sessionId: string, cause: 'user' | 'disconnected', turnId?: string, access?: unknown) => {
    aborts.push({ cause, turnId, access });
    return originalAbort(sessionId, cause, turnId, access as AgentAccessContext | undefined);
  }) as AgentHost['abort']);

  const ws = await connect(token);
  const frames: any[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  try {
    ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '建立所属代次' }));
    await started.promise;
    gateway.store.revokeDevice(device.id);
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ type: 'abort', sessionId: session.id }));
    assert.equal((await nextMessage(ws, 'error')).code, 'UNAUTHORIZED');
    assert.equal(await closed, 4401);
    assert.deepEqual(frames.map((frame) => frame.type), ['error'], '撤销后不能产生用户 abort_ack');
    assert.deepEqual(aborts, [{ cause: 'disconnected', turnId: activeTurn?.id, access: undefined }]);
    assert.equal(activeTurn?.controller.signal.aborted, true, '传输层清理必须中止本连接拥有的旧回合');
  } finally {
    activeTurn?.finish();
    gate.resolve();
    await close(ws);
  }
});

test('device abort reloads the current ACL and keeps exact turn ownership across an ACL change', async (t) => {
  const host = gateway.host;
  const token = 'ws-acl-recheck-abort';
  const device = gateway.store.createDevice({
    name: 'ACL recheck abort', platform: 'ios', tokenHash: hashToken(token), scope: 'device', connectionIds: [allowedConnection.id],
  });
  const session = gateway.store.createSession({ title: 'ACL recheck abort', connectionId: allowedConnection.id, permissionMode: 'readonly' });
  const gate = deferred();
  const started = deferred();
  let activeTurn: { id: string; controller: AbortController; finish: () => void } | undefined;
  t.mock.method(host, 'startTurn', (async () => {
    activeTurn = (host as any).beginTurn(session.id);
    started.resolve();
    await gate.promise;
  }) as AgentHost['startTurn']);
  const ws = await connect(token);
  try {
    ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: 'ACL 变更中的所属代次' }));
    await started.promise;
    gateway.store.setDeviceConnectionPermissions(device.id, []);
    ws.send(JSON.stringify({ type: 'abort', sessionId: session.id }));
    assert.equal((await nextMessage(ws, 'abort_ack')).ok, false);
    assert.equal(activeTurn?.controller.signal.aborted, false, 'ACL 撤销后不能借旧连接上下文中止');

    gateway.store.setDeviceConnectionPermissions(device.id, [allowedConnection.id]);
    ws.send(JSON.stringify({ type: 'abort', sessionId: session.id }));
    assert.equal((await nextMessage(ws, 'abort_ack')).ok, true, 'ACL 恢复后仍只能中止本连接登记的同一代次');
    assert.equal(activeTurn?.controller.signal.aborted, true);
    assert.equal(host.getTurnId(session.id), activeTurn?.id);
  } finally {
    activeTurn?.finish();
    gate.resolve();
    await close(ws);
  }
});

test('revoked device approval is rejected without consuming the pending approval', async (t) => {
  const host = gateway.host;
  const token = 'ws-revoked-approval';
  const device = gateway.store.createDevice({
    name: 'revoked approval', platform: 'ios', tokenHash: hashToken(token), scope: 'device', connectionIds: [allowedConnection.id],
  });
  const session = gateway.store.createSession({ title: 'revoked approval', connectionId: allowedConnection.id, permissionMode: 'ask' });
  const gate = deferred();
  const started = deferred();
  let currentTurnId: string | undefined;
  let resolutions = 0;
  t.mock.method(host, 'startTurn', (async () => {
    currentTurnId = 'revoked-approval-turn';
    started.resolve();
    await gate.promise;
  }) as AgentHost['startTurn']);
  t.mock.method(host, 'getTurnId', () => currentTurnId);
  t.mock.method(host, 'resolveApproval', (() => { resolutions += 1; return true; }) as AgentHost['resolveApproval']);

  const approvalId = 'revoked-device-approval';
  const timer = setTimeout(() => undefined, 60_000);
  timer.unref();
  (host as any).approvals.set(approvalId, {
    resolve: () => undefined,
    timer,
    sessionId: session.id,
    turnId: 'revoked-approval-turn',
    payload: {
      id: approvalId,
      call: { id: 'call-revoked', name: 'run_sql', args: { sql: 'SELECT 1', connectionId: allowedConnection.id } },
      risk: 'read',
      summary: '撤销后的审批',
      sql: 'SELECT 1',
      expiresAt: Date.now() + 60_000,
    },
  });
  const ws = await connect(token);
  try {
    ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '建立审批所属代次' }));
    await started.promise;
    gateway.store.revokeDevice(device.id);
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ type: 'approval', approvalId, decision: 'allow', scope: 'once' }));
    assert.equal((await nextMessage(ws, 'error')).code, 'UNAUTHORIZED');
    assert.equal(await closed, 4401);
    assert.equal(resolutions, 0);
    assert.equal((host as any).approvals.has(approvalId), true, '拒绝授权不能消费 pending approval');
  } finally {
    clearTimeout(timer);
    (host as any).approvals.delete(approvalId);
    gate.resolve();
    await close(ws);
  }
});

test('WebSocket turns preserve Host idempotency keys', async () => {
  const session = gateway.store.createSession({ title: 'WS idempotency', permissionMode: 'readonly' });
  const ws = await connect();
  const frames: any[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  try {
    const firstEnd = nextMessage(ws, 'turn_end', 3000);
    ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '幂等回合', idempotencyKey: 'ws-idempotency-key' }));
    await firstEnd;
    assert.equal(frames.some((frame) => frame.type === 'error'), false, JSON.stringify(frames));

    const replayError = nextMessage(ws, 'error');
    const replayEnd = nextMessage(ws, 'turn_end');
    ws.send(JSON.stringify({ type: 'turn', sessionId: session.id, text: '幂等回合', idempotencyKey: 'ws-idempotency-key' }));
    assert.equal((await replayError).code, 'TURN_REPLAYED');
    await replayEnd;
    assert.equal(gateway.store.listTurns(session.id).length, 1);
  } finally {
    await close(ws);
  }
});

test('rotating the host token invalidates an existing socket before its next mutation', async (t) => {
  const host = gateway.host;
  let starts = 0;
  t.mock.method(host, 'startTurn', (async () => { starts += 1; }) as AgentHost['startTurn']);
  const ws = await connect();
  const originalToken = gateway.config.token;
  try {
    gateway.config.token = 'rotated-host-token';
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ type: 'turn', sessionId: 'any-session', text: '旧宿主令牌' }));
    assert.equal((await nextMessage(ws, 'error')).code, 'UNAUTHORIZED');
    assert.equal(await closed, 4401);
    assert.equal(starts, 0);
  } finally {
    gateway.config.token = originalToken;
    await close(ws);
  }
});
