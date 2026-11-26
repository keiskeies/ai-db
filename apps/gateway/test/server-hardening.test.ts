import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createGateway } from '../src/server';
import { SCHEDULER_TASK_TIMEOUT_MS } from '../src/manager';
import { SqliteDriver } from '../src/drivers/sqlite';
import { hasBackupCapacity, MIN_BACKUP_FREE_BYTES } from '../src/routes/system';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-server-hardening-'));
for (const directory of ['demo', 'exports', 'imports', 'backups', 'attachments', 'static']) mkdirSync(join(home, directory), { recursive: true });
writeFileSync(join(home, 'static', 'index.html'), '<!doctype html><title>shell</title>');
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'server-hardening-secret',
  token: 'server-hardening-token',
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  attachmentDir: join(home, 'attachments'),
  staticDir: join(home, 'static'),
  publicUrl: 'https://db.example.com',
  port: 0,
  host: '127.0.0.1',
  production: true,
});
const port = await listenRandom(gateway.server);
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws?token=server-hardening-token`;
const authorization = { Authorization: 'Bearer server-hardening-token' };

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function connect(origin?: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl, origin ? { origin } : {});
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

test('CORS 只反射精确允许 Origin，无 Origin 客户端仍可访问', async () => {
  const allowed = await fetch(`${baseUrl}/api/missing`, { headers: { Origin: 'https://db.example.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://db.example.com');
  assert.match(allowed.headers.get('vary') ?? '', /Origin/);

  const denied = await fetch(`${baseUrl}/api/missing`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await denied.json() as any).error.code, 'ORIGIN_NOT_ALLOWED');

  const native = await fetch(`${baseUrl}/api/missing`, { headers: authorization });
  assert.equal(native.status, 404);
  assert.equal(native.headers.get('access-control-allow-origin'), null);
  assert.equal(gateway.app.get('trust proxy'), 'loopback');
});

test('frame-ancestors 由响应头下发，API 与静态页都拒绝被嵌入', async () => {
  for (const path of ['/api/health', '/api/missing', '/index.html']) {
    const response = await fetch(`${baseUrl}${path}`, { headers: authorization });
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
  }
});

test('公开 health 只做轻量存活检查，不触发数据库写入', async (t) => {
  const exec = t.mock.method(SqliteDriver.prototype, 'execScript', async () => {
    assert.fail('public health must not probe SQLite');
  });
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.status, 'alive');
  assert.equal(body.checks, undefined);
  assert.equal(body.demoReady, true);
  assert.equal(exec.mock.callCount(), 0);
});

test('health/ready 需鉴权并真实探测 SQLite 写入与备份目录', async () => {
  assert.equal((await fetch(`${baseUrl}/api/health/ready`)).status, 401);
  const response = await fetch(`${baseUrl}/api/health/ready`, { headers: authorization });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.ok, true);
  assert.deepEqual(body.checks, { sqlite: 'ok', backups: 'ok' });
  assert.equal(body.demoReady, true);
});

test('health/ready 的 SQLite 失败与备份目录失败均返回 503 且不泄露路径或原始错误', async (t) => {
  const originalExec = SqliteDriver.prototype.execScript;
  t.mock.method(SqliteDriver.prototype, 'execScript', async () => {
    throw new Error(`sensitive database path: ${gateway.config.dbPath}`);
  });
  try {
    const response = await fetch(`${baseUrl}/api/health/ready`, { headers: authorization });
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.equal((JSON.parse(text) as any).checks.sqlite, 'error');
    assert.ok(!text.includes(gateway.config.dbPath));
    assert.ok(!text.includes('sensitive database path'));
  } finally {
    SqliteDriver.prototype.execScript = originalExec;
  }

  const originalBackupDir = gateway.config.backupDir;
  const notDirectory = join(home, 'backup-path-is-file');
  writeFileSync(notDirectory, 'x');
  gateway.config.backupDir = notDirectory;
  try {
    const response = await fetch(`${baseUrl}/api/health/ready`, { headers: authorization });
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.equal((JSON.parse(text) as any).checks.backups, 'error');
    assert.ok(!text.includes(notDirectory));
  } finally {
    gateway.config.backupDir = originalBackupDir;
  }
});

test('备份容量阈值按文件系统块大小计算', () => {
  assert.equal(hasBackupCapacity({ bsize: 4096, bavail: Math.floor(MIN_BACKUP_FREE_BYTES / 4096) }), true);
  assert.equal(hasBackupCapacity({ bsize: 4096, bavail: Math.floor(MIN_BACKUP_FREE_BYTES / 4096) - 1 }), false);
  assert.equal(hasBackupCapacity({ bsize: 0, bavail: 100 }), false);
});

test('请求日志为结构化 JSON，保留 correlation id 且不记录 query token', async (t) => {
  const lines: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  let resolveLogged!: () => void;
  const logged = new Promise<void>((resolve) => { resolveLogged = resolve; });
  t.mock.method(process.stdout, 'write', ((chunk: unknown) => {
    const line = String(chunk);
    lines.push(line);
    if (line.includes('"event":"http_request"') && line.includes(correlationId)) resolveLogged();
    return stdoutWrite(chunk as string | Uint8Array);
  }) as typeof process.stdout.write);
  const correlationId = 'request-correlation-123';
  const response = await fetch(`${baseUrl}/api/missing?token=do-not-log`, { headers: { ...authorization, 'X-Correlation-Id': correlationId } });
  assert.equal(response.headers.get('x-correlation-id'), correlationId);
  assert.equal((await response.json() as any).error.correlationId, correlationId);
  await logged;
  const entry = lines.map((line) => {
    try { return JSON.parse(line); } catch { return undefined; }
  }).find((value) => value?.event === 'http_request' && value.path === '/api/missing');
  assert.ok(entry);
  assert.equal(entry.correlationId, correlationId);
  assert.equal(entry.path, '/api/missing');
  assert.ok(!JSON.stringify(entry).includes('do-not-log'));
});

test('JSON 解析与未预期 5xx 错误不向客户端返回原始错误', async (t) => {
  const invalid = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: '{sensitive malformed json',
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json() as any;
  assert.equal(invalidBody.error.code, 'INVALID_JSON');
  assert.ok(!JSON.stringify(invalidBody).includes('sensitive malformed json'));

  const errors: string[] = [];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', ((chunk: unknown) => {
    errors.push(String(chunk));
    return stderrWrite(chunk as string | Uint8Array);
  }) as typeof process.stderr.write);
  const originalList = gateway.store.listConnections;
  (gateway.store as any).listConnections = () => { throw new Error('secret /private/path'); };
  try {
    const response = await fetch(`${baseUrl}/api/bootstrap`, { headers: authorization });
    const body = await response.json() as any;
    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, '服务器内部错误');
    assert.ok(!JSON.stringify(body).includes('/private/path'));
    assert.equal(body.error.correlationId, response.headers.get('x-correlation-id'));
    assert.ok(errors.some((line) => line.includes('http_error')));
  } finally {
    (gateway.store as any).listConnections = originalList;
  }
});

test('WebSocket 拒绝恶意 Origin，允许无 Origin 与精确公网 Origin', async () => {
  await assert.rejects(() => connect('https://evil.example'), /403/);
  const native = await connect();
  const nativePong = new Promise<any>((resolve) => native.once('message', (raw) => resolve(JSON.parse(String(raw)))));
  native.send(JSON.stringify({ type: 'ping' }));
  assert.equal((await nativePong).type, 'pong');
  await close(native);

  const allowed = await connect('https://db.example.com');
  await close(allowed);
});

test('WebSocket maxPayload 超限关闭连接，意外异常不泄露原始 message', async () => {
  const oversized = await connect();
  oversized.on('error', () => undefined);
  const closed = new Promise<number>((resolve) => oversized.once('close', resolve));
  oversized.send(JSON.stringify({ type: 'ping', padding: 'x'.repeat(1024 * 1024) }));
  assert.equal(await closed, 1009);

  const originalStart = gateway.host.startTurn;
  (gateway.host as any).startTurn = async () => { throw new Error('secret websocket /private/path'); };
  const ws = await connect();
  try {
    const events: any[] = [];
    const finished = new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        const event = JSON.parse(String(raw));
        events.push(event);
        if (event.type === 'turn_end') resolve(event);
      });
    });
    ws.send(JSON.stringify({ type: 'turn', sessionId: 'session-error', text: 'hello' }));
    const turnEnd = await finished;
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.code, 'AGENT_ERROR');
    assert.equal(error.message, 'Agent 运行失败');
    assert.equal(error.correlationId, turnEnd.correlationId);
    assert.ok(!JSON.stringify(events).includes('/private/path'));
  } finally {
    await close(ws);
    (gateway.host as any).startTurn = originalStart;
  }
});

test('产物命令取消已终态但底层未证实时，后续定时运行保持隔离', async (t) => {
  const artifactId = 'artifact-quarantine';
  const errors: Array<string | undefined> = [];
  let starts = 0;
  let finish!: (value: any) => void;
  t.mock.method(gateway.store, 'listArtifactSchedules', () => [{
    artifactId,
    enabled: true,
    intervalSeconds: 60,
    notifyChannels: [],
  }] as any);
  t.mock.method(gateway.store, 'markArtifactScheduleRun', (_id: string, _status: string, error?: string) => errors.push(error));
  t.mock.method(gateway.commands, 'startArtifact', () => {
    starts += 1;
    return { id: 'run-quarantine' } as any;
  });
  t.mock.method(gateway.commands, 'waitForRun', () => new Promise((resolve) => { finish = resolve; }));
  let finishExecution!: () => void;
  t.mock.method(gateway.commands, 'waitForExecution', () => new Promise<void>((resolve) => { finishExecution = resolve; }));
  t.mock.method(gateway.commands, 'cancel', () => {
    finish({ status: 'canceled' });
    return true;
  });
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });

  await gateway.scheduler.tick();
  t.mock.timers.tick(SCHEDULER_TASK_TIMEOUT_MS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await gateway.scheduler.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(starts, 1);
  assert.equal(errors.length, 0, '底层执行未结算前不能提前发布超时终态');

  finishExecution();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1, '底层 execute 结算前保持隔离');
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /超时/);
  await gateway.scheduler.tick();
  assert.equal(starts, 2, '底层 execute 结算后才允许解除隔离并重试');
  finish({ status: 'succeeded' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.reset();
});

test('gateway close 等待 Agent 与调度任务真实收尾后才关闭 manager 和 store', async () => {
  const shutdownHome = mkdtempSync(join(tmpdir(), 'aidb-shutdown-order-'));
  for (const directory of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(shutdownHome, directory), { recursive: true });
  const isolated = await createGateway({
    home: shutdownHome,
    dbPath: join(shutdownHome, 'aidb.db'),
    secret: 'shutdown-order-secret',
    token: 'shutdown-order-token',
    demoDir: join(shutdownHome, 'demo'),
    exportDir: join(shutdownHome, 'exports'),
    importDir: join(shutdownHome, 'imports'),
    backupDir: join(shutdownHome, 'backups'),
    attachmentDir: join(shutdownHome, 'attachments'),
    staticDir: join(shutdownHome, 'static-missing'),
    port: 0,
    host: '127.0.0.1',
    production: false,
  });
  await listenRandom(isolated.server);

  let finishImages!: (value: never[]) => void;
  let finishQuery!: (value: any) => void;
  const imageGate = new Promise<never[]>((resolve) => { finishImages = resolve; });
  const queryGate = new Promise<any>((resolve) => { finishQuery = resolve; });
  const imageStarted = deferred();
  const queryStarted = deferred();
  (isolated.host as any).loadImages = async () => {
    imageStarted.resolve();
    const images = await imageGate;
    isolated.store.addAudit({ actor: 'agent', tool: 'late_agent_work', risk: 'read', approval: 'none', status: 'ok' });
    return images;
  };
  let querySignal: AbortSignal | undefined;
  isolated.manager.query = (async (_connectionId: string, _sql: string, options: any) => {
    querySignal = options.signal;
    queryStarted.resolve();
    return queryGate;
  }) as typeof isolated.manager.query;

  const order: string[] = [];
  const originalMark = isolated.store.markJobRun.bind(isolated.store);
  isolated.store.markJobRun = ((id: string, status: 'ok' | 'error' | 'running', error?: string) => {
    if (status === 'error') order.push('scheduler-settled');
    return originalMark(id, status, error);
  }) as typeof isolated.store.markJobRun;
  const originalAudit = isolated.store.addAudit.bind(isolated.store);
  isolated.store.addAudit = ((entry: any) => {
    if (entry.tool === 'late_agent_work') order.push('agent-settled');
    return originalAudit(entry);
  }) as typeof isolated.store.addAudit;
  const originalCloseAll = isolated.manager.closeAll.bind(isolated.manager);
  isolated.manager.closeAll = (async () => {
    order.push('manager-closed');
    await originalCloseAll();
  }) as typeof isolated.manager.closeAll;
  const originalStoreClose = isolated.store.close.bind(isolated.store);
  isolated.store.close = (() => {
    order.push('store-closed');
    return originalStoreClose();
  }) as typeof isolated.store.close;

  const session = isolated.store.createSession({ title: '停机 Agent' });
  const connection = isolated.store.listConnections()[0];
  const job = isolated.store.createJob({ name: '停机任务', connectionId: connection.id, type: 'query', sql: 'SELECT 1', intervalSeconds: 3600 });
  const agentTurn = isolated.host.startTurn(session.id, { text: '迟到 Agent 工作' }, () => undefined);
  const scheduled = isolated.scheduler.runJob(job.id);
  await imageStarted.promise;
  await queryStarted.promise;
  let closing: Promise<void> | undefined;
  try {
    closing = isolated.close();
    assert.equal(isolated.close(), closing, '重复 close 必须复用同一次有序停机');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(querySignal?.aborted, true);
    assert.equal((isolated.host as any).active.get(session.id).controller.signal.aborted, true);
    assert.equal(order.includes('manager-closed'), false);
    assert.equal(order.includes('store-closed'), false);
    await assert.rejects(
      () => isolated.host.startTurn(session.id, { text: '停机后新回合' }, () => undefined),
      (error: any) => error?.code === 'GATEWAY_SHUTDOWN',
    );

    finishQuery({ sets: [{ rowCount: 1 }] });
    assert.equal((await scheduled).ok, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(order.includes('manager-closed'), false, '调度迟到工作未收尾时不能关闭存储');

    finishImages([]);
    await agentTurn;
    await closing;
    assert.ok(order.indexOf('agent-settled') >= 0);
    assert.ok(order.indexOf('agent-settled') < order.indexOf('manager-closed'));
    assert.ok(order.indexOf('scheduler-settled') < order.indexOf('manager-closed'));
    assert.ok(order.indexOf('manager-closed') < order.indexOf('store-closed'));
  } finally {
    finishImages([]);
    finishQuery({ sets: [] });
    await agentTurn;
    await scheduled;
    if (closing) await closing;
    rmSync(shutdownHome, { recursive: true, force: true });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
