import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { DatabaseSync } from 'node:sqlite';

const home = mkdtempSync(join(tmpdir(), 'aidb-device-scope-'));
test.after(() => rmSync(home, { recursive: true, force: true }));

test('createDevice/find/list/revoke round-trip the scope', () => {
  const store = new Store(join(home, 'roundtrip.db'), 'secret');
  try {
    const mcp = store.createDevice({ name: 'mcp', platform: 'mcp', tokenHash: 'h1', scope: 'mcp:readonly' });
    assert.equal(mcp.scope, 'mcp:readonly');
    const phone = store.createDevice({ name: 'phone', platform: 'ios', tokenHash: 'h2' });
    assert.equal(phone.scope, 'full');
    assert.equal(store.findDeviceByTokenHash('h1')?.scope, 'mcp:readonly');
    assert.equal(store.findDeviceByTokenHash('h2')?.scope, 'full');
    const listed = store.listDevices();
    assert.equal(listed.find((d) => d.id === mcp.id)?.scope, 'mcp:readonly');
    assert.equal(listed.find((d) => d.id === phone.id)?.scope, 'full');
    store.revokeDevice(mcp.id);
    assert.equal(store.findDeviceByTokenHash('h1'), undefined);
    assert.equal(store.findDeviceByTokenHash('h2')?.scope, 'full');
  } finally {
    store.close();
  }
});

test('an old devices table without scope migrates to full', () => {
  const dbPath = join(home, 'legacy.db');
  const legacy = new Store(dbPath, 'secret');
  legacy.close();
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE devices');
  db.exec(`CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL,
    paired_at TEXT NOT NULL, last_seen_at TEXT, revoked INTEGER DEFAULT 0
  )`);
  db.exec("INSERT INTO devices (id,name,platform,token_hash,paired_at,revoked) VALUES ('old1','旧手机','ios','hOld','2026-01-01T00:00:00.000Z',0)");
  db.close();
  const reopened = new Store(dbPath, 'secret');
  try {
    assert.equal(reopened.findDeviceByTokenHash('hOld')?.scope, 'full');
    assert.equal(reopened.listDevices()[0].scope, 'full');
  } finally {
    reopened.close();
  }
});
