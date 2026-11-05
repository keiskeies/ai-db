import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const TOKEN = 'mcp-ws-test-token';
const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-ws-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'mcp-ws-test-secret',
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
const port = await listenRandom(gateway.server);

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function claim(scope?: string): Promise<string> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  const startPath = scope ? '/pair/mcp/start' : '/pair/start';
  const claimPath = scope ? '/pair/mcp/claim' : '/pair/claim';
  const started = await fetch(`http://127.0.0.1:${port}/api${startPath}`, { method: 'POST', headers });
  const s = (await started.json()) as { code: string };
  const res = await fetch(`http://127.0.0.1:${port}/api${claimPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: s.code, deviceName: 'test', platform: 'test' }),
  });
  return ((await res.json()) as { token: string }).token;
}

/**
 * ws 客户端的 open 会先于服务端的 close(4401) 帧到达，所以不能一见 open 就判定成功：
 * 统一等待 close 或一小段稳定期，只有「没被关掉」才算真正建立连接。
 */
function connect(token: string): Promise<{ code: number; opened: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        resolve({ code: 0, opened: true });
      } else {
        ws.terminate();
        reject(new Error('ws timeout'));
      }
    }, 250);
    ws.on('close', (code) => { clearTimeout(timer); resolve({ code, opened: false }); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

test('mcp:readonly token is rejected on the WebSocket channel', async () => {
  const token = await claim('mcp:readonly');
  const result = await connect(token);
  assert.equal(result.opened, false);
  assert.equal(result.code, 4401);
});

test('a full-scope device token can still open the WebSocket channel', async () => {
  const token = await claim();
  const result = await connect(token);
  assert.equal(result.opened, true, `ws closed with ${result.code}`);
  // 正常关闭，清理服务端连接
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
});
