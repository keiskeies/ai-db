import test from 'node:test';
import assert from 'node:assert/strict';
import { JobScheduler } from '../src/scheduler';
import { SCHEDULER_TASK_TIMEOUT_MS, type ConnectionManager } from '../src/manager';
import type { Store } from '../src/store';
import type { GatewayConfig } from '../src/config';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture(job: Record<string, unknown>) {
  const marks: Array<{ status: string; error?: string }> = [];
  const audits: Array<{ status: string; tool: string }> = [];
  const store = {
    getJob: () => job,
    markJobRun: (_id: string, status: string, error?: string) => marks.push({ status, error }),
    addAudit: (entry: { status: string; tool: string }) => audits.push(entry),
    getSettings: () => ({ defaultLimit: 100, autoLimit: true, queryTimeoutMs: 30_000 }),
  } as unknown as Store;
  const canceled: string[] = [];
  const released: string[] = [];
  const manager = {
    cancelExecution: (id: string) => canceled.push(id),
    releaseExecution: (id: string) => released.push(id),
  } as unknown as ConnectionManager;
  return { store, manager, marks, audits, canceled, released };
}

test('query 超时传播取消，底层未收尾时保留任务槽且迟到成功不写回', async (t) => {
  const pending = deferred<any>();
  let options: any;
  const base = fixture({ id: 'job-1', name: '慢查询', type: 'query', connectionId: 'sqlite-1', sql: 'SELECT 1', enabled: true });
  (base.manager as any).query = (_connectionId: string, _sql: string, opts: any) => {
    options = opts;
    return pending.promise;
  };
  const scheduler = new JobScheduler(base.store, base.manager, {} as GatewayConfig);
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });

  let settled = false;
  const running = scheduler.runJob('job-1').then((result) => {
    settled = true;
    return result;
  });
  t.mock.timers.tick(SCHEDULER_TASK_TIMEOUT_MS);
  await flush();

  assert.equal(settled, false, '超时不能早于忽略取消的底层查询结算');
  assert.equal(options.signal.aborted, true);
  assert.equal(base.canceled.length, 1);
  assert.equal(base.canceled[0], options.executionId);
  assert.equal(scheduler.isRunning('job-1'), true);
  await assert.rejects(() => scheduler.runJob('job-1'), /正在运行/);
  assert.deepEqual(base.marks.map((mark) => mark.status), ['running']);

  pending.resolve({ sets: [{ rowCount: 1 }] });
  const result = await running;

  assert.equal(result.ok, false);
  assert.match(result.message, /超时/);
  assert.equal(scheduler.isRunning('job-1'), false);
  assert.deepEqual(base.marks.map((mark) => mark.status), ['running', 'error']);
  assert.deepEqual(base.audits.map((audit) => audit.status), ['error']);
  assert.deepEqual(base.released, [options.executionId]);
});

test('artifact 超时后继续隔离同一产物，取消信号到达 runner', async (t) => {
  const pending = deferred<{ ok: boolean; message: string }>();
  const marks: Array<{ status: string; error?: string }> = [];
  let calls = 0;
  let signal: AbortSignal | undefined;
  const store = {
    listJobs: () => [],
    listArtifactSchedules: () => [{ artifactId: 'artifact-1', enabled: true, intervalSeconds: 60, notifyChannels: [] }],
    markArtifactScheduleRun: (_id: string, status: string, error?: string) => marks.push({ status, error }),
  } as unknown as Store;
  const scheduler = new JobScheduler(store, {} as ConnectionManager, {} as GatewayConfig);
  scheduler.setArtifactRunner(async (_id, taskSignal) => {
    calls += 1;
    signal = taskSignal;
    return pending.promise;
  });
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });

  await scheduler.tick();
  t.mock.timers.tick(SCHEDULER_TASK_TIMEOUT_MS);
  await flush();
  await scheduler.tick();

  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(marks.map((mark) => mark.status), [], '底层 runner 未结算前不能写超时终态');

  pending.resolve({ ok: true, message: '迟到成功' });
  await flush();
  assert.deepEqual(marks.map((mark) => mark.status), ['error']);
  await scheduler.tick();
  await flush();

  assert.equal(calls, 2);
  assert.deepEqual(marks.map((mark) => mark.status), ['error', 'ok']);
  t.mock.timers.reset();
});

test('stop 取消并等待忽略取消的底层任务及后处理，不再接受新任务', async () => {
  const pending = deferred<{ ok: boolean; message: string }>();
  const marks: string[] = [];
  let signal: AbortSignal | undefined;
  const store = {
    listJobs: () => [],
    listArtifactSchedules: () => [{ artifactId: 'artifact-stop', enabled: true, intervalSeconds: 60, notifyChannels: [] }],
    markArtifactScheduleRun: (_id: string, status: string) => marks.push(status),
  } as unknown as Store;
  const scheduler = new JobScheduler(store, {} as ConnectionManager, {} as GatewayConfig);
  scheduler.setArtifactRunner(async (_id, taskSignal) => {
    signal = taskSignal;
    return pending.promise;
  });

  await scheduler.tick();
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(signal?.aborted, true);
  assert.equal(stopped, false, '不能在后处理可能写 store 时提前完成停机');
  await assert.rejects(() => scheduler.runJob('late-job'), /调度器已停止/);

  pending.resolve({ ok: true, message: '忽略取消但完成' });
  await stopping;
  assert.deepEqual(marks, ['ok'], 'stop 必须等到 markArtifactScheduleRun 后处理结束');
  await scheduler.tick();
  assert.deepEqual(marks, ['ok'], '停机后不能再次触发定时任务');
});

test('dashboard 超时后保留刷新槽，迟到结果不能覆盖失败状态', async (t) => {
  const pending = deferred<{ ok: boolean; message: string }>();
  const marks: string[] = [];
  let calls = 0;
  let signal: AbortSignal | undefined;
  const store = {
    listJobs: () => [],
    listDashboardSchedules: () => [{ connectionId: 'sqlite-1', database: 'main', enabled: true, intervalSeconds: 60, notifyChannels: [] }],
    markDashboardScheduleRun: (_connectionId: string, _database: string | undefined, status: string) => marks.push(status),
  } as unknown as Store;
  const scheduler = new JobScheduler(store, {} as ConnectionManager, {} as GatewayConfig);
  scheduler.setDashboardRunner(async (_connectionId, _database, taskSignal) => {
    calls += 1;
    signal = taskSignal;
    return pending.promise;
  });
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });

  await scheduler.tick();
  t.mock.timers.tick(SCHEDULER_TASK_TIMEOUT_MS);
  await flush();
  await scheduler.tick();

  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(marks, [], '底层 runner 未结算前不能写超时终态');

  pending.resolve({ ok: true, message: '迟到成功' });
  await flush();

  assert.deepEqual(marks, ['error']);
  assert.equal(calls, 1);
  await scheduler.tick();
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(marks, ['error', 'ok']);
  t.mock.timers.reset();
});
