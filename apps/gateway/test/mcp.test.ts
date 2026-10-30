import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const script = join(home, 'mock-mcp.cjs');
writeFileSync(
  script,
  `const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.id) return;
  let result;
  if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
  else if (msg.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
  else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: 'echo:' + String(msg.params.arguments.text) }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`,
);

const TOKEN = 'mcp-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'mcp-secret',
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
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

test('MCP stdio server 可配置、发现工具并被 Agent 执行器调用', async () => {
  const created = await api('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name: 'mock-mcp', command: process.execPath, args: [script] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const serverId = created.body.server.id;
  assert.equal(created.body.server.name, 'mock-mcp');

  const listed = await api(`/mcp/servers/${serverId}/tools`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.tools.length, 1);
  assert.equal(listed.body.tools[0].name, 'echo');

  const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());
  const tools = await executor.execute(
    { id: 'mcp-list', name: 'mcp_list_tools', args: { server: serverId } },
    { sessionId: 'mcp-test' },
  );
  assert.equal(tools.ok, true, tools.error?.message);
  assert.equal((tools.data as any).tools[0].name, 'echo');

  const called = await executor.execute(
    { id: 'mcp-call', name: 'mcp_call', args: { server: serverId, tool: 'echo', arguments: { text: 'hi' } } },
    { sessionId: 'mcp-test' },
  );
  assert.equal(called.ok, true, called.error?.message);
  assert.match(called.summary, /echo:hi/);

  const deleted = await api(`/mcp/servers/${serverId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
});
