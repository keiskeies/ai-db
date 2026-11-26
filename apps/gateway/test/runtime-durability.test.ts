import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, CommandRunEvent } from '@aidb/core';
import { AgentHost } from '../src/agentHost';
import { CommandRunner } from '../src/commands/runner';
import { Store } from '../src/store';
import type { AgentTurnClaim } from '../src/store/runtime';

function fixture(t: { after: (callback: () => void) => void }): Store {
  const home = mkdtempSync(join(tmpdir(), 'aidb-runtime-durability-'));
  const store = new Store(join(home, 'aidb.db'), 'runtime-test-secret');
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return store;
}

function claim(store: Store, sessionId = store.createSession({ title: 'runtime' }).id): AgentTurnClaim {
  return store.claimTurn({ id: randomUUID(), sessionId, ownerId: 'owner', idempotencyKey: randomUUID() });
}

test('运行中的 claim 不参与终态回合保留裁剪', (t) => {
  const store = fixture(t);
  const running = claim(store);
  const finishedSession = store.createSession({ title: 'finished' });
  const now = new Date().toISOString();
  const insert = store.db.prepare(`INSERT INTO agent_turns
    (id,session_id,owner_id,idempotency_key,status,started_at,finished_at,created_at)
    VALUES (?,?,?,?, 'succeeded',?,?,?)`);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < 500; index += 1) {
      const id = randomUUID();
      insert.run(id, finishedSession.id, 'owner', randomUUID(), now, now, now);
    }
    store.db.exec('COMMIT');
  } catch (err) {
    store.db.exec('ROLLBACK');
    throw err;
  } finally {
    (insert as unknown as { close?: () => void }).close?.();
  }
  store.pruneRuntime();
  assert.equal(store.getTurn(running.id)?.status, 'running');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM agent_turns WHERE status != 'running'").get()?.count, 500);
});

test('Agent 事件按 UTF-8 字节封顶并保留可识别类型', (t) => {
  const store = fixture(t);
  const turn = claim(store);
  store.appendAgentEvent(turn.id, 1, { type: 'thinking_delta', text: '汉'.repeat(200_000) });
  const row = store.db.prepare('SELECT payload_json FROM agent_turn_events WHERE turn_id = ?').get(turn.id) as { payload_json: string };
  assert.ok(Buffer.byteLength(row.payload_json, 'utf8') <= 256 * 1024);
  const event = JSON.parse(row.payload_json);
  assert.equal(event.type, 'thinking_delta');
  assert.equal(event.truncated, true);
  assert.ok(Buffer.byteLength(event.preview, 'utf8') <= 32 * 1024);
});

test('终态 claim 与精确错误事件原子提交，失败时回滚', (t) => {
  const store = fixture(t);
  const turn = claim(store);
  store.appendAgentEvent(turn.id, 1, { type: 'start', turnId: turn.id, sessionId: turn.sessionId, model: 'test' });
  store.db.exec(`CREATE TRIGGER reject_terminal BEFORE INSERT ON agent_turn_events
    WHEN NEW.type = 'error' BEGIN SELECT RAISE(ABORT, 'blocked terminal'); END`);
  assert.throws(() => store.finishTurn(turn.id, turn.ownerId, 'failed', undefined, {
    type: 'error', code: 'EXACT_FAILURE', message: '精确错误', retryable: false,
  }), /blocked terminal/);
  assert.equal(store.getTurn(turn.id)?.status, 'running');
  assert.deepEqual(store.agentEvents(turn.id).events.map((item) => item.event.type), ['start']);

  store.db.exec('DROP TRIGGER reject_terminal');
  assert.equal(store.finishTurn(turn.id, turn.ownerId, 'failed', undefined, {
    type: 'error', code: 'EXACT_FAILURE', message: '精确错误', retryable: false,
  }), true);
  const replay = store.agentEvents(turn.id);
  assert.equal(store.getTurn(turn.id)?.status, 'failed');
  assert.deepEqual(replay.events.map((item) => item.event), [
    { type: 'start', turnId: turn.id, sessionId: turn.sessionId, model: 'test' },
    { type: 'error', code: 'EXACT_FAILURE', message: '精确错误', retryable: false },
  ]);
  assert.equal(store.finishTurn(turn.id, turn.ownerId, 'failed', undefined, { type: 'error', code: 'GENERIC', message: 'duplicate' }), false);
  assert.equal(store.agentEvents(turn.id).events.length, 2);
});

test('启动恢复将陈旧回合标记 interrupted 且幂等', (t) => {
  const store = fixture(t);
  const turn = claim(store);
  store.updateSession(turn.sessionId, { status: 'running' });
  const first = store.recoverInterrupted();
  assert.equal(first.turns, 1);
  assert.equal(first.sessions, 1);
  assert.deepEqual(first.interruptedTurns, [{ turnId: turn.id, sessionId: turn.sessionId }]);
  assert.equal(store.getTurn(turn.id)?.status, 'interrupted');
  assert.equal(store.getTurn(turn.id)?.abortCause, 'interrupted');
  assert.equal(store.getSession(turn.sessionId)?.resume, 'interrupted');
  const terminal = store.agentEvents(turn.id).events.at(-1)?.event;
  assert.equal(terminal?.type, 'error');
  assert.equal((terminal as Extract<AgentEvent, { type: 'error' }>).code, 'TURN_INTERRUPTED');
  const second = store.recoverInterrupted();
  assert.equal(second.turns, 0);
  assert.equal(store.agentEvents(turn.id).events.length, 1);
});

test('Agent 与命令事件在内存状态消失后仍可按 seq 回放', (t) => {
  const store = fixture(t);
  const turn = claim(store);
  store.appendAgentEvent(turn.id, 1, { type: 'start', turnId: turn.id, sessionId: turn.sessionId, model: 'test' });
  store.appendAgentEvent(turn.id, 2, { type: 'text_delta', text: '持久化' });
  const agentReplay = store.agentEvents(turn.id, 1);
  assert.deepEqual(agentReplay.events.map((item) => item.seq), [2]);
  assert.equal(agentReplay.lastSeq, 2);

  const artifact = store.createArtifact({ type: 'report', title: 'replay', spec: { version: 1, type: 'report', title: 'replay', command: 'report', sources: [], input: {} } });
  const run = store.addArtifactRun({ artifactId: artifact.id, status: 'running', input: {}, steps: [] });
  const started = { type: 'run_started', runId: run.id, command: 'report', startedAt: new Date().toISOString() } as CommandRunEvent;
  const finished = { type: 'run_finished', runId: run.id, status: 'succeeded', durationMs: 5 } as CommandRunEvent;
  store.appendCommandEvent(run.id, 1, started);
  store.appendCommandEvent(run.id, 2, finished);
  const runner = new CommandRunner(store, {} as never, undefined, undefined, undefined, undefined, () => undefined);
  assert.deepEqual(runner.events(run.id), [started, finished]);
  assert.deepEqual(runner.events(run.id, 1), [finished]);
});

test('命令事件裁剪后回放会显式披露序号缺口', (t) => {
  const store = fixture(t);
  const artifact = store.createArtifact({ type: 'report', title: 'gaps', spec: { version: 1, type: 'report', title: 'gaps', command: 'report', sources: [], input: {} } });
  const run = store.addArtifactRun({ artifactId: artifact.id, status: 'running', input: {}, steps: [] });
  for (let seq = 1; seq <= 505; seq += 1) {
    store.appendCommandEvent(run.id, seq, { type: 'step_progress', runId: run.id, stepId: 'report', message: String(seq) } as CommandRunEvent);
  }
  const replay = store.commandEventReplay(run.id);
  assert.equal(replay.events.length, 500);
  assert.equal(replay.firstSeq, 6);
  assert.equal(replay.lastSeq, 505);
  assert.equal(replay.truncated, true);
  assert.deepEqual(replay.events.map((item) => item.seq), Array.from({ length: 500 }, (_, index) => index + 6));

  const contiguous = store.commandEventReplay(run.id, 5);
  assert.equal(contiguous.truncated, false, 'after 紧邻首个保留序号时没有丢失区间');
  assert.equal(contiguous.events[0]?.seq, 6);
  const caughtUp = store.commandEventReplay(run.id, 505);
  assert.equal(caughtUp.truncated, false);
  assert.deepEqual(caughtUp.events, []);
  assert.equal(store.commandEvents(run.id).length, 500, '旧数组 API 保持兼容');
});

test('取消即使遇到存储故障也会先中止执行并结算审批', () => {
  const session = { id: 'session', connectionId: undefined };
  let turn: { controller: AbortController };
  const store = {
    getSession: () => session,
    setTurnAbortCause: () => {
      assert.equal(turn.controller.signal.aborted, true);
      throw new Error('abort storage unavailable');
    },
    updateSession: () => { throw new Error('session storage unavailable'); },
  };
  const host = new AgentHost({ store: store as never, manager: {} as never, executor: {} as never, config: { instanceId: 'owner' } as never });
  const active = (host as any).beginTurn(session.id, {
    id: 'turn', sessionId: session.id, ownerId: 'owner', idempotencyKey: 'key', status: 'running', startedAt: new Date().toISOString(),
  } satisfies AgentTurnClaim) as { controller: AbortController; finish: () => void };
  turn = active;
  let decision: unknown;
  (host as any).approvals.set('approval', {
    sessionId: session.id, turnId: 'turn', timer: setTimeout(() => undefined, 60_000),
    resolve: (value: unknown) => { decision = value; }, onAbort: () => undefined,
  });
  assert.equal(host.abort(session.id, 'user', 'turn'), true);
  assert.equal(active.controller.signal.aborted, true);
  assert.deepEqual(decision, { decision: 'deny', scope: 'once' });
  assert.equal((host as any).approvals.size, 0);
  active.finish();
});

test('终态存储与裁剪故障不会阻止 active 清理和 waiter 结算', async () => {
  const store = {
    finishTurn: () => { throw new Error('finish unavailable'); },
    pruneRuntime: () => { throw new Error('prune unavailable'); },
  };
  const host = new AgentHost({ store: store as never, manager: {} as never, executor: {} as never, config: { instanceId: 'owner' } as never, logger: () => undefined });
  const turn = (host as any).beginTurn('session', {
    id: 'turn', sessionId: 'session', ownerId: 'owner', idempotencyKey: 'key', status: 'running', startedAt: new Date().toISOString(),
  } satisfies AgentTurnClaim) as { outcome: string; finish: () => void; settled: Promise<void> };
  turn.outcome = 'failed';
  const settled = host.waitForTurn('session');
  turn.finish();
  assert.equal(host.isRunning('session'), false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('settlement timed out')), 500); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
});
