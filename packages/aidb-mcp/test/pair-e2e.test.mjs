import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const gatewayRoot = resolve(here, '../../../apps/gateway');
const repoRoot = resolve(here, '../../..');
const cli = resolve(here, '../bin/aidb-mcp.mjs');

const TOKEN = 'aidb-mcp-pair-e2e-token';
const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-pair-e2e-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
const credFile = join(home, 'credentials.json');
const portFile = join(home, 'port.txt');

const gw = spawn(process.execPath, ['--import', 'tsx', join(gatewayRoot, 'test/fixtures/stdio-gateway.ts')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AIDB_STDIO_HOME: home,
    AIDB_STDIO_TOKEN: TOKEN,
    AIDB_STDIO_PORT_FILE: portFile,
    AIDB_PUBLIC_URL: 'https://db.example.com',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let gwStderr = '';
gw.stderr.on('data', (c) => { gwStderr += c; });
gw.stdout.on('data', () => {});

async function waitForPort() {
  for (let i = 0; i < 100; i += 1) {
    try { return Number(readFileSync(portFile, 'utf8').trim()); } catch { /* not yet */ }
    if (gw.exitCode !== null) throw new Error('gateway exited: ' + gwStderr);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('gateway did not start: ' + gwStderr);
}
const port = await waitForPort();

test.after(async () => {
  gw.kill();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(home, { recursive: true, force: true });
});

test('pair CLI stores the reachable local URL even when AIDB_PUBLIC_URL is set', async () => {
  const h = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
  const started = await fetch('http://127.0.0.1:' + port + '/api/pair/start', { method: 'POST', headers: h });
  const { code } = await started.json();

  const child = spawn(process.execPath, [cli, 'pair'], {
    env: { ...process.env, AIDB_MCP_CREDENTIALS: credFile },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  // readline 的 question 不带换行，stdout 无独立行；用 prompt 文本里的冒号计数不可靠，
  // 改为按 chunk 到达顺序逐个喂入（每个 prompt 输出后紧跟一次写入）。
  const answers = [code, 'http://127.0.0.1:' + port];
  let fed = 0;
  const feed = () => {
    if (fed >= answers.length) return;
    child.stdin.write(answers[fed] + '\n');
    fed += 1;
    if (fed < answers.length) setTimeout(feed, 150);
  };
  setTimeout(feed, 150);

  const exit = await new Promise((resolveExit) => child.on('close', resolveExit));
  assert.equal(exit, 0, 'stdout=' + stdout + ' stderr=' + stderr);
  assert.match(stdout, /配对成功/);
  const cred = JSON.parse(readFileSync(credFile, 'utf8'));
  assert.equal(cred.url, 'http://127.0.0.1:' + port, '不能写入 AIDB_PUBLIC_URL 的公网地址');
  assert.notEqual(cred.url, 'https://db.example.com');
  assert.equal(typeof cred.token, 'string');
  assert.ok(cred.token.length > 20);

  // 用刚落盘的凭据真正启动 MCP server，验证端到端可用。
  const srv = spawn(process.execPath, [cli], {
    env: { ...process.env, AIDB_MCP_CREDENTIALS: credFile },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const srvLines = createInterface({ input: srv.stdout });
  const pending = new Map();
  srvLines.on('line', (line) => {
    if (!line.trim().startsWith('{')) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const w = pending.get(msg.id);
    if (w) { clearTimeout(w.timer); pending.delete(msg.id); w.resolve(msg); }
  });
  const call = (id, method, params) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout ' + method)), 10000);
    pending.set(id, { resolve: res, timer });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'aidb-studio');
    const listed = await call(2, 'tools/list');
    assert.ok(listed.result.tools.some((t) => t.name === 'list_connections'));
  } finally {
    srv.kill();
  }
});
