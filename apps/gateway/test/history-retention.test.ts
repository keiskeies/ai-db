import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/store';

function withStore(fn: (store: Store, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-history-'));
  const path = join(dir, 'store.sqlite');
  const store = new Store(path, 'test-secret');
  try {
    fn(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('history keeps newest N non-favorites and never prunes favorites', () => {
  withStore((store) => {
    store.saveSettings({ ...store.getSettings(), historyLimit: 10, historyRetentionDays: 0 });
    const favorite = store.addHistory({ sql: 'SELECT favorite', status: 'ok' });
    assert.equal(store.setHistoryFavorite(favorite.id, true), true);
    for (let i = 0; i < 15; i += 1) store.addHistory({ sql: `SELECT ${i}`, status: 'ok' });

    const items = store.listHistory({ limit: 500 });
    assert.equal(items.filter((item) => !item.favorite).length, 10, '只保留最近 10 条普通历史');
    assert.equal(items.filter((item) => item.favorite).length, 1, '收藏不受条数限制');
    assert.ok(items.some((item) => item.id === favorite.id && item.favorite));
  });
});

test('history drops non-favorites older than the retention window', () => {
  withStore((store, path) => {
    store.saveSettings({ ...store.getSettings(), historyLimit: 100, historyRetentionDays: 30 });
    const raw = new DatabaseSync(path);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    raw
      .prepare('INSERT INTO query_history (id,connection_id,database_name,sql,status,created_at) VALUES (?,?,?,?,?,?)')
      .run('stale', null, null, 'SELECT stale', 'ok', old);
    raw.close();

    store.addHistory({ sql: 'SELECT fresh', status: 'ok' });
    const items = store.listHistory({ limit: 500 });
    assert.equal(items.some((item) => item.sql === 'SELECT stale'), false, '超过 30 天的普通历史被清理');
    assert.equal(items.some((item) => item.sql === 'SELECT fresh'), true);
  });
});

test('history settings are clamped to sane bounds', () => {
  withStore((store) => {
    const saved = store.saveSettings({ ...store.getSettings(), historyLimit: 1, historyRetentionDays: -5 });
    assert.equal(saved.historyLimit, 10);
    assert.equal(saved.historyRetentionDays, 0);
  });
});
