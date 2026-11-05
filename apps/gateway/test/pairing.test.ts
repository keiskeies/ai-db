import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';
import { pairingCode } from '../src/crypto';

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

test('MCP pairing endpoints create a read-only device', async () => {
  const started = await primary.api('/pair/mcp/start', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.20' } });
  const claimed = await primary.api('/pair/mcp/claim', {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.0.0.20' },
    body: JSON.stringify({ code: started.body.code, deviceName: 'Claude Code', platform: 'claude-code' }),
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.device.scope, 'mcp:readonly');
  const devices = await primary.api('/devices');
  assert.ok(devices.body.devices.some((device: { id: string; scope: string }) => device.id === claimed.body.device.id && device.scope === 'mcp:readonly'));
});

test('mobile pairing endpoints create a full-scope device', async () => {
  const started = await primary.api('/pair/start', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.21' } });
  const claimed = await primary.api('/pair/claim', {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.0.0.21' },
    body: JSON.stringify({ code: started.body.code, deviceName: '默认手机', platform: 'test' }),
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.device.scope, 'full');
});

test('/pair/claim 限流按真实连接地址计数，伪造 X-Forwarded-For 无法绕过', async () => {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await fetch(`${primary.base}/api/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.99.${attempt}.1` },
      body: JSON.stringify({ code: '000000' }),
    });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.ok(statuses.includes(429), `伪造 XFF 后应触发限流，实际：${statuses.join(',')}`);
});

test('配对码为 6 位数字且由 CSPRNG 生成', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const code = pairingCode();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 150, '200 次生成应有足够随机性，实际唯一值: ' + codes.size);
});

test('配对码有效期为 60 秒且两个 start 端点都返回 expiresIn=60', async () => {
  const mcp = await primary.api('/pair/mcp/start', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.30' } });
  assert.equal(mcp.status, 200, JSON.stringify(mcp.body));
  assert.equal(mcp.body.expiresIn, 60);
  const mobile = await primary.api('/pair/start', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.31' } });
  assert.equal(mobile.status, 200, JSON.stringify(mobile.body));
  assert.equal(mobile.body.expiresIn, 60);
});

test('MCP start 返回网关自身监听地址，不受请求 Host 影响', async () => {
  const res = await primary.api('/pair/mcp/start', {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.0.0.32', host: 'localhost:5180' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // 浏览器经 Vite 代理访问时 Host 是前端 5173/5180；MCP CLI 要的是网关自身端口。
  assert.doesNotMatch(String(res.body.url), /:5180|:5173/);
  const actualPort = Number(new URL(String(res.body.url)).port);
  assert.ok(actualPort > 0 && actualPort !== 5180 && actualPort !== 5173, `url=${res.body.url}`);
  assert.equal(res.body.port, actualPort);
});




