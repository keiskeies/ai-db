import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aidb-session-db-'));
}

test('会话记录选中的库，并能在后续回合改写', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    const session = store.createSession({ connectionId: 'conn-1', database: 'media' });
    assert.equal(session.database, 'media');
    assert.equal(store.getSession(session.id)?.database, 'media');
    assert.equal(store.listSessions()[0]?.database, 'media');

    const updated = store.updateSession(session.id, { database: 'nextcloud' });
    assert.equal(updated.database, 'nextcloud');

    const plain = store.createSession({ connectionId: 'conn-1' });
    assert.equal(plain.database, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v3 老库升级后补出 database 列，旧会话不受影响', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'aidb.db');
  try {
    // 造一个 v3 形态的库：agent_sessions 没有 database 列，且已有一条历史会话
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, connection_id TEXT, title TEXT NOT NULL DEFAULT '新会话', summary TEXT,
      model TEXT, permission_mode TEXT NOT NULL DEFAULT 'ask', status TEXT NOT NULL DEFAULT 'idle',
      tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER DEFAULT 0
    )`);
    legacy.exec(`INSERT INTO agent_sessions (id,connection_id,title,permission_mode,status,created_at,updated_at)
      VALUES ('old-1','conn-9','历史会话','ask','idle','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
    legacy.exec('PRAGMA user_version = 3');
    legacy.close();

    const store = new Store(dbPath, 'secret');
    const old = store.getSession('old-1');
    assert.equal(old?.title, '历史会话');
    assert.equal(old?.database, undefined);

    const patched = store.updateSession('old-1', { database: 'media' });
    assert.equal(patched.database, 'media');

    const fresh = store.createSession({ connectionId: 'conn-9', database: 'nextcloud' });
    assert.equal(fresh.database, 'nextcloud');
    store.close();

    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 8);
    assert.ok(check.prepare('PRAGMA table_info(agent_sessions)').all().some((c) => (c as { name: string }).name === 'database'));
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('召回记忆按「类型+标题」去重，同一问题不会占满名额', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    const title = '近 3 个月下单人数的变化趋势';
    for (const answer of ['答案 A：按月统计', '答案 B：按周统计', '答案 C：按日统计']) {
      store.createMemory({ kind: 'episodic', title, content: `用户: ${title}\n助手: ${answer}`, scopeType: 'global', scopeKey: '*' });
    }
    const { memories } = store.recallForTurn(title, {});
    const sameTitle = memories.filter((m) => m.title === title);
    assert.equal(sameTitle.length, 1, `期望 1 条，实际 ${sameTitle.length}`);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('召回只带当前库的记忆，不跨库串味', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    store.createMemory({ kind: 'fact', title: '收藏指的是 m_book_shelf', content: 'media 库里收藏关系放在 m_book_shelf' }, { connectionId: 'c1', database: 'media' });
    store.createMemory({ kind: 'fact', title: '收藏指的是 m_star', content: 'nextcloud 库里收藏关系放在 m_star' }, { connectionId: 'c1', database: 'nextcloud' });
    store.createMemory({ kind: 'fact', title: '收藏口径全局约定', content: '所有库的收藏都先确认业务方的定义' }, { connectionId: 'c1', database: 'media' });

    const inMedia = store.recallForTurn('收藏指的是哪个表', { connectionId: 'c1', database: 'media' }).memories.map((m) => m.title);
    const inNextcloud = store.recallForTurn('收藏指的是哪个表', { connectionId: 'c1', database: 'nextcloud' }).memories.map((m) => m.title);
    assert.ok(inMedia.some((t) => t.includes('m_book_shelf')), `media 应召回本库记忆：${inMedia.join(' | ')}`);
    assert.ok(!inMedia.some((t) => t.includes('m_star')), `media 不应召回 nextcloud 的记忆：${inMedia.join(' | ')}`);
    assert.ok(inNextcloud.some((t) => t.includes('m_star')), `nextcloud 应召回本库记忆：${inNextcloud.join(' | ')}`);
    assert.ok(!inNextcloud.some((t) => t.includes('m_book_shelf')), `nextcloud 不应召回 media 的记忆：${inNextcloud.join(' | ')}`);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话累计用量：轮次/步数/缓存命中可写入并读回', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    const session = store.createSession({ connectionId: 'conn-1' });
    // 新会话的累计指标必须是 0 而不是 undefined，前端状态条直接拿来算
    assert.equal(session.turns, 0);
    assert.equal(session.steps, 0);
    assert.equal(session.cacheHitTokens, 0);
    assert.equal(session.cacheMissTokens, 0);
    assert.equal(session.contextTokens, 0);

    const updated = store.updateSession(session.id, { turns: 3, steps: 11, cacheHitTokens: 900, cacheMissTokens: 100, contextTokens: 4200 });
    assert.equal(updated.turns, 3);
    assert.equal(updated.steps, 11);
    assert.equal(updated.cacheHitTokens, 900);
    assert.equal(updated.cacheMissTokens, 100);
    assert.equal(updated.contextTokens, 4200);

    // 重开会话必须还在——这些值不该只活在内存里
    const reread = store.getSession(session.id);
    assert.deepEqual(
      { turns: reread?.turns, steps: reread?.steps, hit: reread?.cacheHitTokens, miss: reread?.cacheMissTokens, ctx: reread?.contextTokens },
      { turns: 3, steps: 11, hit: 900, miss: 100, ctx: 4200 },
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老库升级后补出轮次/步数/缓存列，历史会话归零', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'aidb.db');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, connection_id TEXT, database TEXT, title TEXT NOT NULL DEFAULT '新会话', summary TEXT,
      model TEXT, permission_mode TEXT NOT NULL DEFAULT 'ask', status TEXT NOT NULL DEFAULT 'idle',
      tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER DEFAULT 0
    )`);
    legacy.exec(`INSERT INTO agent_sessions (id,connection_id,title,permission_mode,status,tokens_in,tokens_out,created_at,updated_at)
      VALUES ('old-1','conn-1','历史会话','ask','done',500,60,'2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')`);
    legacy.close();

    const store = new Store(dbPath, 'secret');
    const old = store.getSession('old-1');
    // 老会话没有这些数据，补 0；已有 token 不能被覆盖
    assert.equal(old?.turns, 0);
    assert.equal(old?.steps, 0);
    assert.equal(old?.cacheHitTokens, 0);
    assert.equal(old?.contextTokens, 0);
    assert.equal(old?.tokensIn, 500);
    // 升级后的库还能正常写入新指标
    const patched = store.updateSession('old-1', { turns: 2, steps: 4 });
    assert.equal(patched.turns, 2);
    assert.equal(patched.steps, 4);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话可按连接与库过滤，不传参数时返回全部', () => {
  const dir = tempDir();
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  try {
    const media = store.createSession({ connectionId: 'c1', database: 'media' });
    const friend = store.createSession({ connectionId: 'c1', database: 'friendship' });
    const other = store.createSession({ connectionId: 'c2', database: 'media' });
    const noDb = store.createSession({ connectionId: 'c1' });

    assert.equal(store.listSessions().length, 4);

    const c1 = store.listSessions({ connectionId: 'c1' }).map((s) => s.id).sort();
    assert.deepEqual(c1, [media.id, friend.id, noDb.id].sort());

    // 未绑定库的旧会话也出现在 media 作用域里（见实现注释：藏起来会被当成丢数据）
    const c1media = store.listSessions({ connectionId: 'c1', database: 'media' }).map((s) => s.id).sort();
    assert.deepEqual(c1media, [media.id, noDb.id].sort());

    // 未绑定库的旧会话在任何库下都可见
    const c1friend = store.listSessions({ connectionId: 'c1', database: 'friendship' }).map((s) => s.id).sort();
    assert.deepEqual(c1friend, [friend.id, noDb.id].sort());

    assert.equal(other.database, 'media');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
