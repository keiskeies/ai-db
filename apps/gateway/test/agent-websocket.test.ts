import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createGateway } from '../src/server';
import type { AgentHost, TurnInput } from '../src/agentHost';
import { listenRandom } from './helpers';

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

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(url);
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
