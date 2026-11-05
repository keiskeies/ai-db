import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const TOKEN = 'mcp-scope-test-token';
const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-scope-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'mcp-scope-test-secret',
  token: TOKEN,
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

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

async function claim(scope?: string): Promise<{ token: string; id: string }> {
  const started = await api('/pair/start', { method: 'POST' });
  const s = (await started.json()) as { code: string };
  const res = await api('/pair/claim', {
    method: 'POST',
    body: JSON.stringify({ code: s.code, deviceName: 'test', platform: 'test', ...(scope ? { scope } : {}) }),
  });
  const body = (await res.json()) as { token: string; device: { id: string } };
  assert.equal(res.status, 200, JSON.stringify(body));
  return { token: body.token, id: body.device.id };
}

test('mcp:readonly token can only reach the read-only MCP bridge', async () => {
  const mcp = await claim('mcp:readonly');
  // 用真实连接 id，避免把「连接不存在」的 400 误当成 scope 拒绝。
  const conns = (await (await api('/connections')).json()) as { connections: Array<{ id: string }> };
  const connectionId = conns.connections[0]?.id ?? 'demo';
  const cases: Array<[string, string, RequestInit, number, string?]> = [
    ['GET', '/health', {}, 200],
    ['GET', '/capabilities', {}, 200],
    ['GET', '/agent/tools?for=mcp', {}, 200],
    ['POST', '/agent/tools/list_connections', { body: JSON.stringify({ args: {} }) }, 200],
    ['POST', '/agent/tools/create_table', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_READ_ONLY'],
    ['GET', '/connections', {}, 403, 'SCOPE_DENIED'],
    ['GET', '/settings', {}, 403, 'SCOPE_DENIED'],
    ['POST', '/query', { body: JSON.stringify({ connectionId: 'demo', sql: 'SELECT 1' }) }, 403, 'SCOPE_DENIED'],
    ['GET', '/mcp/servers', {}, 403, 'SCOPE_DENIED'],
    // 不能靠 /agent/tools/ 前缀蒙混到别的路由。
    ['POST', '/agent/tools/foo/bar', { body: JSON.stringify({ args: {} }) }, 403, 'SCOPE_DENIED'],
  ];
  for (const [method, path, init, status, code] of cases) {
    const res = await api(path, { ...init, method }, mcp.token);
    assert.equal(res.status, status, `${method} ${path} -> ${res.status}`);
    if (code) {
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, code, `${method} ${path}`);
    } else {
      await res.arrayBuffer();
    }
  }
});

test('revoking the device invalidates the mcp:readonly credential', async () => {
  const mcp = await claim('mcp:readonly');
  const revoked = await api(`/devices/${mcp.id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 204);
  const res = await api('/agent/tools?for=mcp', {}, mcp.token);
  assert.equal(res.status, 401);
});

test('a full-scope device token keeps access to the whole API', async () => {
  const full = await claim();
  const res = await api('/connections', {}, full.token);
  assert.equal(res.status, 200);
});
