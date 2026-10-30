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
