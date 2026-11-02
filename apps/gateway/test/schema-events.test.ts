import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { listenRandom } from './helpers';
import { GatewayEvents, type SchemaChangedEvent } from '../src/events';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

test('事件总线把事件送达每个订阅者', () => {
  const bus = new GatewayEvents();
  const first: SchemaChangedEvent[] = [];
  const second: SchemaChangedEvent[] = [];
  bus.onSchemaChanged((event) => first.push(event));
  bus.onSchemaChanged((event) => second.push(event));

  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'agent', at: '2026-11-02T00:00:00.000Z' });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].connectionId, 'c1');
  assert.equal(first[0].cause, 'agent');
});

test('取消订阅后不再收到事件', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  const off = bus.onSchemaChanged((event) => seen.push(event));
  off();
  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' });
  assert.equal(seen.length, 0);
});

test('一个监听器抛错不影响其它监听器', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  bus.onSchemaChanged(() => {
    throw new Error('boom');
  });
  bus.onSchemaChanged((event) => seen.push(event));

  assert.doesNotThrow(() =>
    bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' }),
  );
  assert.equal(seen.length, 1);
});

const home = mkdtempSync(join(tmpdir(), 'aidb-schema-events-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'schema-events-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'schema-events-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
// GatewayInstance 不暴露 executor，测试自己建一个，与其它测试文件的写法一致。
const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function connectWs(): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/** 在 fn 执行期间收集 schema_changed 事件。开头留 120ms 让订阅先就位。 */
async function collect(fn: () => Promise<void>, waitMs = 400): Promise<any[]> {
  const ws = await connectWs();
  const received: any[] = [];
  ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fn();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  ws.close();
  return received.filter((item) => item.type === 'schema_changed');
}

test('invalidate 会把 schema_changed 广播到已连接的客户端', async () => {
  const conn = gateway.store.listConnections()[0];
  const events = await collect(async () => {
    gateway.manager.invalidate(conn.id, 'agent');
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].connectionId, conn.id);
  assert.equal(events[0].cause, 'agent');
  assert.ok(typeof events[0].at === 'string' && events[0].at.length > 0);
});

test('错 token 的 ws 以 4401 被拒', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=wrong-token`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('没有在预期时间内被拒')), 5000);
    ws.once('close', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    ws.once('error', () => undefined);
  });
  assert.equal(code, 4401);
});
