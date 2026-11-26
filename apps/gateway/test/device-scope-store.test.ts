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
    assert.equal(phone.scope, 'device');
    assert.deepEqual(phone.connectionIds, []);
    assert.equal(store.findDeviceByTokenHash('h1')?.scope, 'mcp:readonly');
    assert.equal(store.findDeviceByTokenHash('h2')?.scope, 'device');
    const listed = store.listDevices();
    assert.equal(listed.find((d) => d.id === mcp.id)?.scope, 'mcp:readonly');
    assert.equal(listed.find((d) => d.id === phone.id)?.scope, 'device');
    store.revokeDevice(mcp.id);
    assert.equal(store.findDeviceByTokenHash('h1'), undefined);
    assert.equal(store.findDeviceByTokenHash('h2')?.scope, 'device');
  } finally {
    store.close();
  }
});

test('an old devices table without scope migrates to least-privilege device access', () => {
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
    assert.equal(reopened.findDeviceByTokenHash('hOld')?.scope, 'device');
    assert.equal(reopened.listDevices()[0].scope, 'device');
    reopened.db.exec("INSERT INTO devices (id,name,platform,token_hash,paired_at,revoked) VALUES ('old2','旧手机','ios','hOld2','2026-01-01T00:00:00.000Z',0)");
    assert.equal(reopened.findDeviceByTokenHash('hOld2')?.scope, 'device', '补列后的默认值也不能赋予 admin');
  } finally {
    reopened.close();
  }
});

test('legacy full and unknown scopes migrate to device while explicit admin is preserved', () => {
  const dbPath = join(home, 'legacy-full.db');
  const initial = new Store(dbPath, 'secret');
  initial.close();
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE device_connection_permissions');
  db.exec('DROP TABLE devices');
  db.exec(`CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL,
    paired_at TEXT NOT NULL, last_seen_at TEXT, revoked INTEGER DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'full'
  )`);
  db.exec("INSERT INTO devices (id,name,platform,token_hash,paired_at,revoked,scope) VALUES ('full1','旧桌面','desktop','hFull','2026-01-01T00:00:00.000Z',0,'full')");
  db.exec("INSERT INTO devices (id,name,platform,token_hash,paired_at,revoked,scope) VALUES ('admin1','管理员','desktop','hAdmin','2026-01-01T00:00:00.000Z',0,'admin')");
  db.exec("INSERT INTO devices (id,name,platform,token_hash,paired_at,revoked,scope) VALUES ('unknown1','损坏值','desktop','hUnknown','2026-01-01T00:00:00.000Z',0,'legacy-admin')");
  db.exec('PRAGMA user_version = 9');
  db.close();

  const reopened = new Store(dbPath, 'secret');
  try {
    assert.equal(reopened.findDeviceByTokenHash('hFull')?.scope, 'device');
    assert.equal(reopened.findDeviceByTokenHash('hUnknown')?.scope, 'device');
    assert.equal(reopened.findDeviceByTokenHash('hAdmin')?.scope, 'admin');
    const raw = new DatabaseSync(dbPath);
    try {
      const rows = (raw.prepare('SELECT id, scope FROM devices ORDER BY id').all() as Array<{ id: string; scope: string }>)
        .map(({ id, scope }) => ({ id, scope }));
      assert.deepEqual(rows, [
        { id: 'admin1', scope: 'admin' },
        { id: 'full1', scope: 'device' },
        { id: 'unknown1', scope: 'device' },
      ]);
    } finally {
      raw.close();
    }
  } finally {
    reopened.close();
  }
});

test('expired or malformed device expiry fails closed without deleting surviving ACL rows', () => {
  const store = new Store(join(home, 'expiry.db'), 'secret');
  try {
    const connection = store.createConnection({ name: 'expiry ACL', engine: 'sqlite', database: ':memory:' });
    const device = store.createDevice({
      name: 'expiring phone', platform: 'ios', tokenHash: 'hExpiry', scope: 'device', connectionIds: [connection.id],
    });
    store.db.prepare("UPDATE devices SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(device.id);
    assert.equal(store.findDeviceByTokenHash('hExpiry'), undefined);
    assert.equal(store.listDevices().find((item) => item.id === device.id)?.revoked, true);
    assert.equal(store.canDeviceAccessConnection(device.id, connection.id), false);
    assert.deepEqual(store.listDeviceConnectionPermissions(device.id), [connection.id], '失效判断不能依赖 ACL 行是否残留');

    store.db.prepare("UPDATE devices SET expires_at = 'not-a-timestamp' WHERE id = ?").run(device.id);
    assert.equal(store.findDeviceByTokenHash('hExpiry'), undefined, '损坏的到期时间按失效处理');
    assert.equal(store.canDeviceAccessConnection(device.id, connection.id), false);

    store.db.prepare("UPDATE devices SET expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(device.id);
    assert.equal(store.findDeviceByTokenHash('hExpiry')?.scope, 'device');
    assert.equal(store.canDeviceAccessConnection(device.id, connection.id), true);
  } finally {
    store.close();
  }
});

test('device connection ACL is persistent, default-deny, and atomically replaceable', () => {
  const dbPath = join(home, 'acl.db');
  const store = new Store(dbPath, 'secret');
  let deviceId = '';
  try {
    const first = store.createConnection({ name: 'first', engine: 'sqlite', database: ':memory:' });
    const second = store.createConnection({ name: 'second', engine: 'sqlite', database: ':memory:' });
    const device = store.createDevice({
      name: 'phone', platform: 'ios', tokenHash: 'hAcl', scope: 'device', connectionIds: [first.id, first.id],
    });
    deviceId = device.id;
    assert.deepEqual(device.connectionIds, [first.id]);
    assert.equal(store.canDeviceAccessConnection(device.id, first.id), true);
    assert.equal(store.canDeviceAccessConnection(device.id, second.id), false);

    assert.throws(
      () => store.setDeviceConnectionPermissions(device.id, [second.id, 'missing']),
      (error: any) => error?.code === 'CONNECTION_NOT_FOUND',
    );
    assert.deepEqual(store.listDeviceConnectionPermissions(device.id), [first.id], '失败授权不能部分改写 ACL');
    assert.deepEqual(store.setDeviceConnectionPermissions(device.id, [second.id, second.id]), [second.id]);
    assert.equal(store.canDeviceAccessConnection(device.id, first.id), false);
    assert.equal(store.canDeviceAccessConnection(device.id, second.id), true);
    assert.deepEqual(store.setDeviceConnectionPermissions(device.id, []), []);
    assert.equal(store.canDeviceAccessConnection(device.id, second.id), false);
    store.setDeviceConnectionPermissions(device.id, [first.id]);
  } finally {
    store.close();
  }

  const reopened = new Store(dbPath, 'secret');
  try {
    const device = reopened.findDeviceByTokenHash('hAcl');
    assert.ok(device);
    assert.equal(device.scope, 'device');
    assert.equal(reopened.listDeviceConnectionPermissions(deviceId).length, 1);
    assert.equal(reopened.canDeviceAccessConnection(deviceId, reopened.listDeviceConnectionPermissions(deviceId)[0]), true);
  } finally {
    reopened.close();
  }
});
