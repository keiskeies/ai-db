import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRunner } from '../src/commands/runner';
import type { CommandRunInfo } from '@aidb/core';

// C6/K2：waitForRun 可选超时（超时 reject COMMAND_WAIT_TIMEOUT，与 scheduler 的
// catch→记失败→释放槽路径对齐）；终态 run 保留窗口过后被回收，运行中的不受影响。

function makeRunner(): CommandRunner {
  const store = { updateArtifactRun: () => undefined, updateArtifact: () => undefined };
  return new CommandRunner(store as any, {} as any);
}

function injectState(runner: CommandRunner, id: string, finished = false): any {
  const info: CommandRunInfo = {
    id,
    command: 'report',
    title: 't',
    status: finished ? 'succeeded' : 'running',
    input: { sources: [] },
    steps: [],
    artifactId: `a-${id}`,
    createdAt: new Date().toISOString(),
    ...(finished ? { finishedAt: new Date().toISOString() } : {}),
  } as CommandRunInfo;
  const state = {
    info,
    artifactId: info.artifactId,
    artifactRunId: `ar-${id}`,
    events: [],
    listeners: new Set(),
    controller: new AbortController(),
    seq: 0,
    finished,
    waiters: [],
  };
  (runner as any).runs.set(id, state);
  return state;
}

test('waitForRun：未知 runId 仍 resolve undefined（旧行为不变）', async () => {
  const runner = makeRunner();
  assert.equal(await runner.waitForRun('nope'), undefined);
  assert.equal(await runner.waitForRun('nope', 50), undefined);
});

test('waitForRun：超时 reject COMMAND_WAIT_TIMEOUT，且不留下 waiter', async () => {
  const runner = makeRunner();
  const state = injectState(runner, 'r-timeout');
  await assert.rejects(
    runner.waitForRun('r-timeout', 60),
    (err: any) => {
      assert.equal(err.code, 'COMMAND_WAIT_TIMEOUT');
      assert.match(err.message, /超时/);
      return true;
    },
  );
  assert.equal(state.waiters.length, 0, '超时的 waiter 必须摘掉，不能泄漏');
});

test('waitForRun：终态先到则正常 resolve，超时定时器不再触发', async () => {
  const runner = makeRunner();
  const state = injectState(runner, 'r-finish');
  const pending = runner.waitForRun('r-finish', 5000);
  (runner as any).finish(state, 'succeeded');
  const info = await pending;
  assert.equal(info?.status, 'succeeded');
  // 再等一小段：若定时器没被清掉，这里会出现未处理拒绝或重复 resolve
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(state.waiters.length, 0);
});

test('waitForRun：已结束的 run 立即返回快照（不受超时参数影响）', async () => {
  const runner = makeRunner();
  injectState(runner, 'r-done', true);
  const info = await runner.waitForRun('r-done', 10);
  assert.equal(info?.status, 'succeeded');
});

test('不传超时：一直等到终态（旧行为不变）', async () => {
  const runner = makeRunner();
  const state = injectState(runner, 'r-legacy');
  const pending = runner.waitForRun('r-legacy');
  setTimeout(() => (runner as any).finish(state, 'failed'), 40);
  const info = await pending;
  assert.equal(info?.status, 'failed');
});

test('周期清扫：终态超过保留窗口的被回收，运行中与窗口内的保留', () => {
  const runner = makeRunner();
  const old = injectState(runner, 'r-old', true);
  old.info.finishedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const fresh = injectState(runner, 'r-fresh', true);
  void fresh;
  const running = injectState(runner, 'r-running');
  running.info.finishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  (runner as any).sweepRuns();
  assert.equal(runner.get('r-old'), undefined, '超窗终态必须回收');
  assert.ok(runner.get('r-fresh'), '窗口内的结果查询必须仍然可用');
  assert.ok(runner.get('r-running'), '运行中的绝不能被清扫');
});

test('finish 会挂延迟回收：窗口内可查，超窗后被删除', async () => {
  const runner = makeRunner();
  const state = injectState(runner, 'r-evict');
  (runner as any).finish(state, 'succeeded');
  assert.ok(runner.get('r-evict'), '结束后必须保留结果查询窗口');
  (runner as any).sweepRuns(); // 窗口内：不删
  assert.ok(runner.get('r-evict'));
  state.info.finishedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  (runner as any).sweepRuns();
  assert.equal(runner.get('r-evict'), undefined);
});