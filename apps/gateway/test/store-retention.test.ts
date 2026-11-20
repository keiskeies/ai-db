import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store';

async function withStore(fn: (store: Store, path: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-retention-'));
  const path = join(dir, 'store.sqlite');
  const store = new Store(path, 'test-secret');
  try {
    await fn(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function count(store: Store, table: string): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}

// Windows 上 WAL 每次自动提交都要 fsync（单条 ~20ms），批量写入包在一个事务里，
// 既走真实 API 路径（含节流检查），又不至于让单测跑几分钟。
function batch(store: Store, fn: () => void): void {
  store.db.exec('BEGIN');
  try {
    fn();
    store.db.exec('COMMIT');
  } catch (err) {
    store.db.exec('ROLLBACK');
    throw err;
  }
}

test('audit_log / tool_runs / artifact_runs 超出上限删最旧', () => {
  withStore((store) => {
    const session = store.createSession({});
    const artifact = store.createArtifact({ type: 'report', title: 't', spec: { version: 1, type: 'report', title: 't' } });
    batch(store, () => {
      for (let i = 0; i < 5100; i += 1) store.addAudit({ actor: 'user', status: 'ok', sql: `SELECT ${i}` });
      for (let i = 0; i < 1200; i += 1) store.addToolRun({ id: `call_${i}`, sessionId: session.id, tool: 'run_sql', status: 'ok' });
      for (let i = 0; i < 600; i += 1) store.addArtifactRun({ artifactId: artifact.id, status: 'succeeded' });
    });

    // 插入都在 60s 节流窗口内，不会即时裁剪；强制一次后按上限保留。
    store.pruneNow();
    assert.equal(count(store, 'audit_log'), 5000);
    assert.equal(count(store, 'tool_runs'), 1000);
    assert.equal(count(store, 'artifact_runs'), 500);

    // 保留的是最新记录：最后插入的仍在，最早插入的已被删。
    const newestAudit = store.db.prepare('SELECT sql FROM audit_log ORDER BY rowid DESC LIMIT 1').get() as { sql: string };
    assert.equal(newestAudit.sql, 'SELECT 5099');
    const oldestAudit = store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE sql = ?').get('SELECT 0') as { n: number };
    assert.equal(Number(oldestAudit.n), 0);
    const newestTool = store.db.prepare('SELECT id FROM tool_runs ORDER BY rowid DESC LIMIT 1').get() as { id: string };
    assert.equal(newestTool.id, 'call_1199');
  });
});

test('裁剪节流：60s 窗口内跳过，窗口过期后随插入触发（延迟到请求路径外执行）', async () => {
  await withStore(async (store) => {
    const session = store.createSession({});
    batch(store, () => {
      for (let i = 0; i < 1100; i += 1) store.addToolRun({ id: `t_${i}`, sessionId: session.id, tool: 'run_sql', status: 'ok' });
    });
    // 构造时已强制裁剪过一次，后续插入都在节流窗口内 → 不裁剪。
    assert.equal(count(store, 'tool_runs'), 1100);

    // 把上次裁剪时间拨到 61s 前，下一次插入应调度裁剪；
    // 裁剪走 setImmediate 不阻塞写请求，让出一个宏任务后才落地。
    (store as unknown as { lastPruneAt: number }).lastPruneAt = Date.now() - 61_000;
    store.addToolRun({ id: 't_trigger', sessionId: session.id, tool: 'run_sql', status: 'ok' });
    assert.equal(count(store, 'tool_runs'), 1101, '触发插入本身不被裁剪阻塞');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count(store, 'tool_runs'), 1000);

    // 触发后重新进入节流窗口：继续插入不再裁剪。
    batch(store, () => {
      for (let i = 0; i < 50; i += 1) store.addToolRun({ id: `after_${i}`, sessionId: session.id, tool: 'run_sql', status: 'ok' });
    });
    assert.equal(count(store, 'tool_runs'), 1050);
  });
});

test('启动时强制裁剪一次：旧库超限记录 reopening 后即收敛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-retention-reopen-'));
  const path = join(dir, 'store.sqlite');
  const first = new Store(path, 'test-secret');
  const session = first.createSession({});
  batch(first, () => {
    for (let i = 0; i < 1300; i += 1) first.addToolRun({ id: `r_${i}`, sessionId: session.id, tool: 'run_sql', status: 'ok' });
  });
  assert.equal(count(first, 'tool_runs'), 1300);
  first.close();

  const second = new Store(path, 'test-secret');
  try {
    assert.equal(count(second, 'tool_runs'), 1000);
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listMessages 分页参数：limit 取最近一页，beforeSeq 向前翻页', () => {
  withStore((store) => {
    const session = store.createSession({});
    batch(store, () => {
      for (let i = 1; i <= 10; i += 1) store.appendMessage({ sessionId: session.id, role: 'user', content: `m${i}` });
    });

    const all = store.listMessages(session.id);
    assert.equal(all.length, 10);
    assert.deepEqual(all.map((m) => m.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const page = store.listMessages(session.id, { limit: 3 });
    assert.deepEqual(page.map((m) => m.seq), [8, 9, 10]);

    const earlier = store.listMessages(session.id, { limit: 3, beforeSeq: 8 });
    assert.deepEqual(earlier.map((m) => m.seq), [5, 6, 7]);
  });
});