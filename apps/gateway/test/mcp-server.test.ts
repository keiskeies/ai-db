import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-server-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'mcp-server-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'mcp-server-secret',
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
const port = (gateway.server.address() as AddressInfo).port;

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

function makeClient(child: ReturnType<typeof spawn>) {
  const lines = createInterface({ input: child.stdout! });
  const pending = new Map<number, { resolve: (value: any) => void; timer: NodeJS.Timeout }>();
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    } catch {
      /* ignore non-JSON output */
    }
  });
  return (id: number, method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 10_000);
      pending.set(id, { resolve, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

test('stdio MCP server exposes and calls AiDB read tools', async () => {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  const started = await fetch(`http://127.0.0.1:${port}/api/pair/mcp/start`, { method: 'POST', headers });
  assert.equal(started.status, 200);
  const { code } = await started.json() as { code: string };
  const claimed = await fetch(`http://127.0.0.1:${port}/api/pair/mcp/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code, deviceName: 'stdio test', platform: 'test' }),
  });
  assert.equal(claimed.status, 200);
  const credential = await claimed.json() as { token: string; device: { id: string; scope: string } };
  assert.equal(credential.device.scope, 'mcp:readonly');
  const restricted = await fetch(`http://127.0.0.1:${port}/api/connections`, {
    headers: { authorization: `Bearer ${credential.token}` },
  });
  assert.equal(restricted.status, 403, 'stdio 必须使用只读设备令牌，不能退回网关主令牌');
  const credentialFile = join(home, 'mcp-credentials.json');
  writeFileSync(credentialFile, JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    token: credential.token,
    deviceId: credential.device.id,
    pairedAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/aidb-mcp-server.mjs', import.meta.url))], {
    env: { ...process.env, AIDB_MCP_CREDENTIALS: credentialFile, AIDB_URL: 'http://127.0.0.1:1', AIDB_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const call = makeClient(child);
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'aidb-studio');
    const listed = await call(2, 'tools/list');
    const names = listed.result.tools.map((tool: any) => tool.name);
    assert.ok(names.includes('list_connections'));
    assert.ok(names.includes('inspect_schema'));
    assert.ok(names.includes('run_sql'));
    assert.ok(!names.includes('create_table'));
    assert.ok(!names.includes('mcp_list_servers'));
    assert.ok(!names.includes('mcp_list_tools'));
    assert.ok(!names.includes('mcp_call'));
    const bridged = (await fetch(`http://127.0.0.1:${port}/api/agent/tools?for=mcp`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json())) as { tools: Array<{ name: string }> };
    assert.ok(!bridged.tools.some((tool: any) => ['mcp_list_servers', 'mcp_list_tools', 'mcp_call'].includes(tool.name)));
    const proxyCall = await fetch(`http://127.0.0.1:${port}/api/agent/tools/mcp_call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args: { server: 'builtin-filesystem', tool: 'read_file', arguments: { path: 'C:/Windows/win.ini' } } }),
    });
    assert.equal(proxyCall.status, 403);
    const called = await call(3, 'tools/call', { name: 'list_connections', arguments: {} });
    assert.equal(called.result.isError, undefined);
    assert.match(called.result.content[0].text, /Demo/);
  } finally {
    child.kill();
  }
});
