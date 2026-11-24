import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpRequest } from '../src/pipeline/http';

// C2：单个超时信号必须覆盖「请求 + body 读取」全程。
// 旧实现拿到响应头就 clearTimeout，body 挂死时无限等——这里用真实 socket 复现。

const sockets = new Set<import('node:net').Socket>();
let server: Server;
let base: string;

server = createServer((req, res) => {
  const mode = req.url ?? '/';
  if (mode === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
    return;
  }
  if (mode === '/stall-body') {
    // 响应头立刻给，body 吐一半就永远不再吐——旧实现会在这里无限挂起
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    return;
  }
  // /stall-headers：连响应头都不给
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  for (const socket of sockets) socket.destroy();
  server.close();
});

test('正常请求不受影响', async () => {
  const res = await httpRequest({ url: `${base}/ok`, timeoutMs: 2000 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.json, { hello: 'world' });
});

test('body 读取挂死：超时覆盖全程，按 PIPELINE_HTTP_NETWORK 报错', async () => {
  const started = Date.now();
  await assert.rejects(
    httpRequest({ url: `${base}/stall-body`, timeoutMs: 1000 }),
    (err: any) => {
      assert.equal(err.code, 'PIPELINE_HTTP_NETWORK');
      assert.match(err.message, /秒未完成/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 950 && elapsed < 4000, `应在超时阈值附近返回，实际 ${elapsed}ms`);
});

test('响应头都不给：请求阶段同样被超时掐断', async () => {
  const started = Date.now();
  await assert.rejects(
    httpRequest({ url: `${base}/stall-headers`, timeoutMs: 1000 }),
    (err: any) => err.code === 'PIPELINE_HTTP_NETWORK',
  );
  assert.ok(Date.now() - started < 4000);
});

test('调用方取消立即终止挂死的请求，而不是等到超时', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = httpRequest({ url: `${base}/stall-body`, timeoutMs: 30000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (err: any) => err.code === 'PIPELINE_ABORTED');
  assert.ok(Date.now() - started < 2000);
});