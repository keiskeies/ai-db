import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppSettings } from '@aidb/core';
import { embedText } from '../src/embeddings';

function settingsFor(port: number): AppSettings {
  return { embedding: { provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'test-embedding', apiKey: 'k' } } as unknown as AppSettings;
}

test('embedText：同文本命中缓存不再请求上游，并发同文本合并为一次', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const input = JSON.parse(body).input as string;
      // 不同文本给不同向量，验证缓存键含文本；延迟一点让并发请求重叠。
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ embedding: input === 'a' ? [1, 0] : [0, 1] }] }));
      }, 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const settings = settingsFor(port);
  try {
    const [v1, v2] = await Promise.all([embedText(settings, 'a'), embedText(settings, 'a')]);
    assert.deepEqual(v1, [1, 0]);
    assert.deepEqual(v2, [1, 0]);
    assert.equal(calls, 1, '并发同文本只打一次上游');

    const again = await embedText(settings, 'a');
    assert.deepEqual(again, [1, 0]);
    assert.equal(calls, 1, '缓存命中不再请求');

    const other = await embedText(settings, 'b');
    assert.deepEqual(other, [0, 1]);
    assert.equal(calls, 2, '不同文本换键');

    // 换 model 视为不同缓存键。
    const otherModel = { embedding: { ...settings.embedding, model: 'another-model' } } as unknown as AppSettings;
    await embedText(otherModel, 'a');
    assert.equal(calls, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('embedText：私有 provider 仅信任配置 origin，重定向到其他私网 origin 被拒绝', async () => {
  let redirectedCalls = 0;
  const target = createServer((_req, res) => {
    redirectedCalls += 1;
    res.end(JSON.stringify({ data: [{ embedding: [9, 9] }] }));
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as AddressInfo).port;
  const source = createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `http://127.0.0.1:${targetPort}/embeddings`);
    res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as AddressInfo).port;
  try {
    await assert.rejects(embedText(settingsFor(sourcePort), 'redirect-private'), (err: any) => err.code === 'EMBEDDING_FAILED');
    assert.equal(redirectedCalls, 0);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  }
});

test('embedText：超过响应字节上限时失败且不缓存', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-length', String(2 * 1024 * 1024 + 1));
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const settings = settingsFor(port);
    await assert.rejects(embedText(settings, 'oversized'), (err: any) => err.code === 'EMBEDDING_FAILED');
    await assert.rejects(embedText(settings, 'oversized'), (err: any) => err.code === 'EMBEDDING_FAILED');
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('embedText：上游失败不缓存，重试仍会请求', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: [2, 2] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const settings = settingsFor(port);
  try {
    await assert.rejects(embedText(settings, 'retry-text'));
    const vector = await embedText(settings, 'retry-text');
    assert.deepEqual(vector, [2, 2]);
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});