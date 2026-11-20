import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aidb-memory-syn-'));
}

test('术语同义词落库往返：create → get → update → 搜索', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    const created = store.createMemory({ kind: 'glossary', title: 'JS', content: 'JS = JumpServer 堡垒机', synonyms: ['堡垒机', '跳板机'] });
    assert.deepEqual(created.synonyms, ['堡垒机', '跳板机']);
    assert.deepEqual(store.getMemory(created.id)?.synonyms, ['堡垒机', '跳板机']);

    const updated = store.updateMemory(created.id, { synonyms: ['堡垒机'] });
    assert.deepEqual(updated.synonyms, ['堡垒机']);

    const bySynonym = store.listMemories({ q: '堡垒机' });
    assert.ok(bySynonym.some((m) => m.id === created.id), 'q 搜索覆盖 synonyms 列');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复记忆合并时同义词取并集', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    store.createMemory({ kind: 'glossary', title: 'JS', content: 'JS = JumpServer 堡垒机', synonyms: ['堡垒机'] });
    const { memory, merged } = store.upsertMemoryCandidate({ kind: 'glossary', title: 'JS', content: 'JS = JumpServer 堡垒机', synonyms: ['跳板机'] });
    assert.equal(merged, true);
    assert.deepEqual(memory.synonyms?.sort(), ['堡垒机', '跳板机'].sort());
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老库没有 synonyms 列也能启动，旧记忆读出空同义词', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'aidb.db');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '*',
      kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT,
      importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
      source_session TEXT, source_message TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      use_count INTEGER DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const now = new Date().toISOString();
    legacy.exec(`INSERT INTO memories (id,scope_type,scope_key,kind,title,content,tags,created_at,updated_at)
      VALUES ('old','global','*','glossary','JS','JS = JumpServer','[]','${now}','${now}')`);
    legacy.close();

    const store = new Store(dbPath, 'secret');
    const old = store.getMemory('old');
    assert.deepEqual(old?.synonyms, []);
    const updated = store.updateMemory('old', { synonyms: ['堡垒机'] });
    assert.deepEqual(updated.synonyms, ['堡垒机']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记忆超过 500 条后，作用域内低重要度记忆仍可召回（作用域下推 SQL）', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    // 550 条高重要度全局记忆占满旧实现的全局 top-500 名额。
    store.db.exec('BEGIN');
    for (let i = 0; i < 550; i += 1) {
      store.createMemory({ kind: 'fact', title: `全局事实 ${i}`, content: `无关内容 ${i}`, importance: 0.9 });
    }
    store.db.exec('COMMIT');
    const scoped = store.createMemory(
      { kind: 'glossary', title: '活跃口径', content: '活跃用户 = 近 7 天有登录', importance: 0.1 },
      { connectionId: 'c1', database: 'db1' },
    );

    const hit = store.searchMemories('活跃', { connectionId: 'c1', database: 'db1', kinds: ['glossary'] });
    assert.ok(hit.some((m) => m.id === scoped.id), '本库术语不该被全库前 500 条截掉');

    const otherScope = store.searchMemories('活跃', { connectionId: 'c2', database: 'db2', kinds: ['glossary'] });
    assert.ok(!otherScope.some((m) => m.id === scoped.id), 'A 库口径不能串到 B 库');

    const globals = store.searchMemories('', { limit: 8 });
    assert.ok(globals.length > 0 && globals.every((m) => m.scopeType === 'global'), '无连接上下文时只召回全局记忆');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
