import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callMcpTool, shutdownMcpClients } from '../src/mcp';

// 契约 K1：call(tool, args, opts?: { signal, timeoutMs })。
// 旧调用不传 opts 照常；signal abort 立即 reject；timeoutMs 可覆盖默认 20s。

const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-opts-'));
const script = join(home, 'mock-slow-mcp.cjs');
writeFileSync(
  script,
  `const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.id) return; // notifications/cancelled 等通知无需回应
  let result;
  if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
  else if (msg.method === 'tools/list') result = { tools: [{ name: 'slow', description: 'never answers', inputSchema: { type: 'object' } }] };
  else return; // tools/call 故意永不回应，模拟挂死的长任务
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`,
);

const fakeStore = {
  listMcpServers: () => [{ id: 'mock', name: 'mock', command: process.execPath, args: [script], enabled: true }],
  getMcpServerEnv: () => ({}),
} as any;

after(() => {
  shutdownMcpClients();
  rmSync(home, { recursive: true, force: true });
});

test('K1：signal abort 时立即 reject，不等默认 20s', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    callMcpTool(fakeStore, 'mock', 'slow', {}, { signal: controller.signal }),
    (err: any) => err?.name === 'AbortError' || /中止/.test(err?.message ?? ''),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `abort 必须立刻生效，实际 ${elapsed}ms`);
});

test('K1：timeoutMs 覆盖默认超时', async () => {
  const started = Date.now();
  await assert.rejects(
    callMcpTool(fakeStore, 'mock', 'slow', {}, { timeoutMs: 400 }),
    (err: any) => /MCP 调用超时/.test(err?.message ?? ''),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 350 && elapsed < 3000, `应按传入的 400ms 超时，实际 ${elapsed}ms`);
});

test('K1：已 abort 的 signal 直接拒绝，不启动调用', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(callMcpTool(fakeStore, 'mock', 'slow', {}, { signal: controller.signal }));
});