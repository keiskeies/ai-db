import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const TOKEN = 'pairing-test-token';

async function startGateway(publicUrl?: string) {
  const home = mkdtempSync(join(tmpdir(), 'aidb-pairing-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
  const gateway = await createGateway({
    home,
    dbPath: join(home, 'aidb.db'),
    secret: 'pairing-test-secret',
    token: TOKEN,
    publicUrl,
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
  await listenRandom(gateway.server);
  const port = (gateway.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, init: RequestInit = {}, token = TOKEN) => {
    const response = await fetch(`${base}/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { status: response.status, body, headers: response.headers };
  };
  return { home, gateway, api, base };
}

const primary = await startGateway('https://db.keiskei.top/');
const proxy = await startGateway();

after(async () => {
  await primary.gateway.close();
  await proxy.gateway.close();
  for (const instance of [primary, proxy]) {
    try {
      rmSync(instance.home, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放延迟 */
    }
  }
});

test('AIDB_PUBLIC_URL 决定二维码与移动端提示地址', async () => {
  const started = await primary.api('/pair/start', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.1' } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.url, 'https://db.keiskei.top');
  assert.equal(started.body.host, 'db.keiskei.top');
  assert.equal(started.body.port, 443);
  const payload = JSON.parse(started.body.qrPayload);
  assert.equal(payload.v, 1);
  assert.equal(payload.url, 'https://db.keiskei.top');
  assert.equal(payload.host, 'db.keiskei.top');
  assert.equal(payload.code, started.body.code);
});

test('反向代理头决定配对地址（X-Forwarded-Host / Proto）', async () => {
  const started = await proxy.api('/pair/start', {
    method: 'POST',
    headers: { 'x-forwarded-host': 'db.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.0.0.9' },
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.url, 'https://db.example.com');
  assert.equal(started.body.host, 'db.example.com');
  assert.equal(started.body.port, 443);
});

test('配对成功换取设备令牌，设备令牌可访问 API 且出现在设备列表', async () => {
  const started = await primary.api('/pair/start', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.2' } });
  const claimed = await primary.api('/pair/claim', {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.0.0.2' },
    body: JSON.stringify({ code: started.body.code, deviceName: '测试手机', platform: 'test' }),
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.match(claimed.body.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(claimed.body.bridge.url, 'https://db.keiskei.top');
  const withDevice = await primary.api('/connections', {}, claimed.body.token);
  assert.equal(withDevice.status, 200, JSON.stringify(withDevice.body));
  const devices = await primary.api('/devices');
  assert.ok(devices.body.devices.some((device: { id: string }) => device.id === claimed.body.device.id));
});

test('/pair/claim 对同一来源限流：10 次后返回 429', async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await proxy.api('/pair/claim', {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.0.0.3' },
      body: JSON.stringify({ code: '000000' }),
    });
    assert.equal(response.status, 401, `attempt ${attempt + 1}: ${JSON.stringify(response.body)}`);
  }
  const blocked = await proxy.api('/pair/claim', {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.0.0.3' },
    body: JSON.stringify({ code: '000000' }),
  });
  assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/);
});
