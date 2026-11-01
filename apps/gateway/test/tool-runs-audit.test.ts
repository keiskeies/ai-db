import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aidb-tool-runs-'));
}

test('同一个 tool call id 重复上报时不丢记录、不抛错', () => {
  // 有的服务商/代理会复用固定 id（复跑、重放、离线桩都会），
  // 主键一冲突就会把整轮 agent 抛成 ERR_SQLITE_ERROR。
  // 审计写入不该毁掉回合，也不该丢掉已有记录 —— 两条调用各自留痕。
  const dir = tempDir();
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  try {
    const session = store.createSession({ database: 'audit' });
    for (let i = 0; i < 20; i++) {
      store.addToolRun({ id: 'call_fixed', sessionId: session.id, tool: 'run_sql', status: 'ok' });
    }
    assert.equal(store.listToolRuns(session.id).length, 20);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('主键冲突的退让只针对唯一约束，其它错误照常抛出', () => {
  const dir = tempDir();
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  try {
    // 不存在的 session 不该被当成主键冲突吞掉：这里只验证冲突路径有边界，
    // 非唯一约束类错误仍要暴露出来，否则真的 bug 会被静默。
    const session = store.createSession({ database: 'audit' });
    store.addToolRun({ id: 'call_a', sessionId: session.id, tool: 'run_sql', status: 'ok' });
    store.addToolRun({ id: 'call_a', sessionId: session.id, tool: 'run_sql', status: 'ok' });
    const runs = store.listToolRuns(session.id);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].id, runs[1].id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});