import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const gatewayRoot = resolve(here, '../../../apps/gateway');
const repoRoot = resolve(here, '../../..');

const TOKEN = 'aidb-mcp-stdio-token';
const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-stdio-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });

/** 用 tsx 起一个真实网关，读取它写出的端口，供纯 ESM 的 MCP server 连接。 */
const portFile = join(home, 'port.txt');
const gw = spawn(process.execPath, ['--import', 'tsx', join(gatewayRoot, 'test/fixtures/stdio-gateway.ts')], {
  cwd: repoRoot,
  env: { ...process.env, AIDB_STDIO_HOME: home, AIDB_STDIO_TOKEN: TOKEN, AIDB_STDIO_PORT_FILE: portFile },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let gwStderr = '';
gw.stderr.on('data', (c) => { gwStderr += c; });
gw.stdout.on('data', () => {});

async function waitForPort() {
  for (let i = 0; i < 100; i += 1) {
    try { return Number(readFileSync(portFile, 'utf8').trim()); } catch { /* not yet */ }
    if (gw.exitCode !== null) throw new Error(`gateway exited: ${gwStderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway did not start: ${gwStderr}`);
}
const port = await waitForPort();

test.after(async () => {
  gw.kill();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(home, { recursive: true, force: true });
});

// 真实配对流程换取 mcp:readonly token，写入临时凭据文件。
const h = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const started = await fetch(`http://127.0.0.1:${port}/api/pair/start`, { method: 'POST', headers: h });
const { code } = await started.json();
const claimed = await fetch(`http://127.0.0.1:${port}/api/pair/claim`, {
  method: 'POST', headers: h,
  body: JSON.stringify({ code, deviceName: 'Claude Code', platform: 'claude-code', scope: 'mcp:readonly' }),
});
const { token } = await claimed.json();
const credFile = join(home, 'credentials.json');
writeFileSync(credFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, token, deviceId: 'd1', pairedAt: new Date().toISOString() }));

function spawnServer(script) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, AIDB_MCP_CREDENTIALS: credFile },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const stdoutLines = [];
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  lines.on('line', (line) => {
    stdoutLines.push(line);
    if (!line.trim().startsWith('{')) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const waiter = pending.get(msg.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(msg.id); waiter.resolve(msg); }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 10000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, call, stdoutLines, stderr: () => stderr };
}

const repoServer = resolve(here, '../../../scripts/aidb-mcp-server.mjs');
const publishedServer = resolve(here, '../bin/aidb-mcp.mjs');

for (const [label, script] of [['仓库内 wrapper', repoServer], ['发布包入口', publishedServer]]) {
  test(`${label} speaks stdio MCP with paired credentials`, async () => {
    const { child, call, stdoutLines, stderr } = spawnServer(script);
    try {
      const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.equal(init.result.serverInfo.name, 'aidb-studio');
      const listed = await call(2, 'tools/list');
      const names = listed.result.tools.map((t) => t.name);
      assert.ok(names.includes('list_connections'));
      assert.ok(names.includes('run_sql'));
      assert.ok(!names.includes('create_table'));
      assert.ok(!names.includes('mcp_call'));
      const called = await call(3, 'tools/call', { name: 'list_connections', arguments: {} });
      assert.equal(called.result.isError, undefined);
      assert.match(called.result.content[0].text, /Demo/);
      // stdout 每一行都必须是 JSON-RPC，不能混入提示文本。
      for (const line of stdoutLines) assert.doesNotThrow(() => JSON.parse(line));
      assert.doesNotMatch(stderr(), /AIDB_TOKEN/);
    } finally {
      child.kill();
    }
  });
}

test('server.mjs 忽略非对象/畸形 JSON 行后仍可继续服务', async () => {
  const { child, call, stdoutLines } = spawnServer(publishedServer);
  try {
    child.stdin.write('null\n');
    child.stdin.write('42\n');
    child.stdin.write('"a string"\n');
    child.stdin.write('{not json}\n');
    child.stdin.write('\n');
    const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'aidb-studio');
    const listed = await call(2, 'tools/list');
    assert.ok(Array.isArray(listed.result.tools));
    for (const line of stdoutLines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    child.kill();
  }
});
