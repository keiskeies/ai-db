import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';
import { hashToken } from '../src/crypto';

const home = mkdtempSync(join(tmpdir(), 'aidb-device-ws-events-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
const ADMIN_TOKEN = 'device-ws-events-admin';
const DEVICE_TOKEN = 'device-ws-events-device';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'device-ws-events-secret',
  token: ADMIN_TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  attachmentDir: join(home, 'attachments'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
const port = await listenRandom(gateway.server);
const allowed = gateway.store.createConnection({ name: 'Allowed', engine: 'sqlite', database: ':memory:' });
const denied = gateway.store.createConnection({ name: 'Denied', engine: 'sqlite', database: ':memory:' });
const device = gateway.store.createDevice({
  name: 'Restricted phone',
  platform: 'ios',
  tokenHash: hashToken(DEVICE_TOKEN),
  scope: 'device',
  connectionIds: [allowed.id],
});

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function close(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

function connectionChanged(connectionId: string) {
  gateway.events.emitConnectionsChanged({
    type: 'connections_changed',
    connectionId,
    change: 'updated',
    at: new Date().toISOString(),
  });
}

test('device WebSocket only receives connection events allowed by its current ACL', async () => {
  const admin = await connect(ADMIN_TOKEN);
  const restricted = await connect(DEVICE_TOKEN);
  const adminEvents: any[] = [];
  const deviceEvents: any[] = [];
  admin.on('message', (raw) => adminEvents.push(JSON.parse(String(raw))));
  restricted.on('message', (raw) => deviceEvents.push(JSON.parse(String(raw))));
  try {
    gateway.manager.invalidate(allowed.id, 'agent');
    connectionChanged(allowed.id);
    gateway.manager.invalidate(denied.id, 'agent');
    connectionChanged(denied.id);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.deepEqual(
      adminEvents.map(({ type, connectionId }) => ({ type, connectionId })),
      [
        { type: 'schema_changed', connectionId: allowed.id },
        { type: 'connections_changed', connectionId: allowed.id },
        { type: 'schema_changed', connectionId: denied.id },
        { type: 'connections_changed', connectionId: denied.id },
      ],
    );
    assert.deepEqual(
      deviceEvents.map(({ type, connectionId }) => ({ type, connectionId })),
      [
        { type: 'schema_changed', connectionId: allowed.id },
        { type: 'connections_changed', connectionId: allowed.id },
      ],
      '设备不能从广播得知未授权连接的结构或生命周期变化',
    );

    gateway.store.setDeviceConnectionPermissions(device.id, []);
    gateway.manager.invalidate(allowed.id, 'user');
    connectionChanged(allowed.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(deviceEvents.length, 2, '撤销 ACL 后，已连接设备也必须立即停止接收该连接事件');

    gateway.store.setDeviceConnectionPermissions(device.id, [denied.id]);
    gateway.manager.invalidate(denied.id, 'user');
    connectionChanged(denied.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      deviceEvents.slice(2).map(({ type, connectionId }) => ({ type, connectionId })),
      [
        { type: 'schema_changed', connectionId: denied.id },
        { type: 'connections_changed', connectionId: denied.id },
      ],
      '新增 ACL 后，已连接设备应收到新授权连接的事件',
    );

    gateway.store.revokeDevice(device.id);
    gateway.manager.invalidate(denied.id, 'user');
    connectionChanged(denied.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(deviceEvents.length, 4, '设备被撤销后，已建立 WebSocket 也必须停止接收连接事件');
  } finally {
    await close(restricted);
    await close(admin);
  }
});

test('broadcast authorization follows device scope downgrade and expiry on an existing socket', async () => {
  const token = 'device-ws-events-downgrade';
  const adminDevice = gateway.store.createDevice({
    name: 'Downgraded desktop', platform: 'desktop', tokenHash: hashToken(token), scope: 'admin',
  });
  const ws = await connect(token);
  const frames: any[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  try {
    connectionChanged(denied.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(frames.map((frame) => frame.connectionId), [denied.id], '明确 admin 设备初始可接收全部连接事件');

    gateway.store.db.prepare("UPDATE devices SET scope = 'device' WHERE id = ?").run(adminDevice.id);
    gateway.store.setDeviceConnectionPermissions(adminDevice.id, [allowed.id]);
    connectionChanged(denied.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames.length, 1, '降级后不得沿用连接时的 admin 广播范围');

    connectionChanged(allowed.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(frames.map((frame) => frame.connectionId), [denied.id, allowed.id]);

    gateway.store.db.prepare("UPDATE devices SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(adminDevice.id);
    connectionChanged(allowed.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames.length, 2, '到期设备即使 ACL 行仍存在也不能继续接收广播');
  } finally {
    await close(ws);
  }
});
