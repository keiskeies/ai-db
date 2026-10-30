import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';

test('旧版通知渠道 CHECK 约束会迁移，允许新平台类型', () => {
  const home = mkdtempSync(join(tmpdir(), 'aidb-notify-migrate-'));
  const dbPath = join(home, 'old.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE notification_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('feishu','wecom','qq-onebot')),
    config_secret TEXT NOT NULL,
    summary TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  old.exec('PRAGMA user_version = 6');
  old.close();
  const store = new Store(dbPath, 'migration-secret');
  try {
    const channel = store.createNotificationChannel({
      name: 'Slack',
      type: 'slack',
      config: { webhookUrl: 'https://example.com/hook' },
    });
    assert.equal(channel.type, 'slack');
    assert.equal(store.listNotificationChannels().length, 1);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
