import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const TOKEN = 'pair-mcp-isolation-token';

async function startGateway() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-pair-mcp-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
  const gateway = await createGateway({
    home, dbPath: join(home, 'aidb.db'), secret: 'pair-mcp-secret', token: TOKEN,
    demoDir: join(home, 'demo'), exportDir: join(home, 'exports'), importDir: join(home, 'imports'),
    backupDir: join(home, 'backups'), attachmentDir: join(home, 'attachments'),
    staticDir: join(home, 'static-missing'), port: 0, host: '127.0.0.1', production: false,
  });
  const port = await listenRandom(gateway.server);
  const base = 'http://127.0.0.1:' + port;
  const api = async (path: string, init: RequestInit = {}, token = TOKEN) => {
    const response = await fetch(base + '/api' + path, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(init.headers ?? {}) },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { status: response.status, body };
  };
  return { home, gateway, api, base };
}

const g = await startGateway();
after(async () => {
  await g.gateway.close();
  rmSync(g.home, { recursive: true, force: true });
});

const noToken = (path: string, body: unknown = {}) =>
  fetch(g.base + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('MCP start requires the main token', async () => {
  const response = await noToken('/pair/mcp/start');
  assert.equal(response.status, 401);
});

test('MCP code can only be claimed at the MCP endpoint and always yields mcp:readonly', async () => {
  const started = await g.api('/pair/mcp/start', { method: 'POST', headers: { 'x-forwarded-for': '10.40.1.1' } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.match(String(started.body.code), /^\d{6}$/);
  const code = started.body.code as string;

  // 跨池：MCP 码不能在移动端端点兑换
  const wrongPool = await g.api('/pair/claim', {
    method: 'POST', headers: { 'x-forwarded-for': '10.40.1.2' },
    body: JSON.stringify({ code, deviceName: 'evil', platform: 'evil' }),
  });
  assert.equal(wrongPool.status, 401);
  assert.equal(wrongPool.body.error?.code, 'PAIR_INVALID');

  // 伪造 scope 无效
  const claimed = await g.api('/pair/mcp/claim', {
    method: 'POST', headers: { 'x-forwarded-for': '10.40.1.3' },
    body: JSON.stringify({ code, deviceName: 'Claude Code', platform: 'claude-code', scope: 'full' }),
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.device?.scope, 'mcp:readonly');

  // 单次消费
  const again = await g.api('/pair/mcp/claim', {
    method: 'POST', headers: { 'x-forwarded-for': '10.40.1.4' }, body: JSON.stringify({ code }),
  });
  assert.equal(again.status, 401);
});

test('mobile code cannot be claimed at the MCP endpoint and /pair/claim always yields full', async () => {
  const started = await g.api('/pair/start', { method: 'POST', headers: { 'x-forwarded-for': '10.40.2.1' } });
  const code = started.body.code as string;

  const cross = await g.api('/pair/mcp/claim', {
    method: 'POST', headers: { 'x-forwarded-for': '10.40.2.2' }, body: JSON.stringify({ code }),
  });
  assert.equal(cross.status, 401);
  assert.equal(cross.body.error?.code, 'PAIR_INVALID');

  const claimed = await g.api('/pair/claim', {
    method: 'POST', headers: { 'x-forwarded-for': '10.40.2.3' },
    body: JSON.stringify({ code, deviceName: 'phone', platform: 'ios', scope: 'mcp:readonly' }),
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.device?.scope, 'full');
  // full 凭据仍可访问整个 API
  const conns = await g.api('/connections', {}, claimed.body.token as string);
  assert.equal(conns.status, 200);
});

test('features.mcp=false disables both MCP pairing endpoints', async () => {
  const saved = g.gateway.store.getSettings();
  g.gateway.store.saveSettings({ ...saved, features: { ...saved.features, mcp: false } });
  try {
    const start = await g.api('/pair/mcp/start', { method: 'POST', headers: { 'x-forwarded-for': '10.40.3.1' } });
    assert.equal(start.status, 403);
    assert.equal(start.body.error?.code, 'FEATURE_DISABLED');
    const claim = await g.api('/pair/mcp/claim', {
      method: 'POST', headers: { 'x-forwarded-for': '10.40.3.2' }, body: JSON.stringify({ code: '000000' }),
    });
    assert.equal(claim.status, 403);
    assert.equal(claim.body.error?.code, 'FEATURE_DISABLED');
  } finally {
    g.gateway.store.saveSettings(saved);
  }
});
