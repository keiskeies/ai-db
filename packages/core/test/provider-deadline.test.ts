import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_CONNECT_CODE,
  PROVIDER_DEADLINE_CODE,
  PROVIDER_DEADLINE_MS,
  PROVIDER_STALL_CODE,
  ProviderConnectError,
  ProviderDeadlineError,
  parseRetryAfterMs,
  resolveDeadlineMs,
  watchRequestStall,
} from '../src/agent/providers/common';
import { OpenAIProvider } from '../src/agent/providers/openai';
import type { ProviderRequest } from '../src/agent/types';

// C1：Ollama 保留 stallMs:0（本地 prefill 慢不是卡死），但必须有绝对截止兜底，
// 且截止错误与停摆错误是两回事；连接建立阶段另有短超时。

const baseRequest: ProviderRequest = { system: 's', messages: [], tools: [] };

test('绝对截止取值顺序：显式 > 环境变量 > 默认 15 分钟，0 关闭', () => {
  assert.equal(resolveDeadlineMs(5000, {}), 5000);
  assert.equal(resolveDeadlineMs(0, {}), 0);
  assert.equal(resolveDeadlineMs(undefined, { AIDB_PROVIDER_DEADLINE_MS: '60000' }), 60_000);
  assert.equal(resolveDeadlineMs(undefined, { AIDB_PROVIDER_DEADLINE_MS: '0' }), 0);
  assert.equal(resolveDeadlineMs(5000, { AIDB_PROVIDER_DEADLINE_MS: '60000' }), 5000);
  assert.equal(resolveDeadlineMs(undefined, { AIDB_PROVIDER_DEADLINE_MS: 'abc' }), PROVIDER_DEADLINE_MS);
  assert.equal(resolveDeadlineMs(undefined, {}), PROVIDER_DEADLINE_MS);
  assert.equal(PROVIDER_DEADLINE_MS, 15 * 60 * 1000);
});

test('截止错误与停摆错误文案/错误码都不同', () => {
  const deadline = new ProviderDeadlineError(900_000);
  assert.equal(deadline.code, PROVIDER_DEADLINE_CODE);
  assert.notEqual(deadline.code, PROVIDER_STALL_CODE);
  assert.match(deadline.message, /绝对时长上限/);
  assert.match(deadline.message, /AIDB_PROVIDER_DEADLINE_MS/);
  assert.doesNotMatch(deadline.message, /没有任何响应/);
  const connect = new ProviderConnectError(30_000);
  assert.equal(connect.code, PROVIDER_CONNECT_CODE);
  assert.match(connect.message, /连接阶段超时/);
});

test('stallMs=0 + deadline：clear() 之后绝对截止仍然生效（覆盖 body 读取全程）', async () => {
  const watch = watchRequestStall(undefined, 0, { deadlineMs: 80, connectMs: 5000 });
  assert.ok(watch.signal);
  watch.clear(); // 模拟拿到响应头
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(watch.signal?.aborted, true);
  assert.ok(watch.signal?.reason instanceof ProviderDeadlineError);
  watch.dispose();
});

test('dispose() 之后绝对截止不再触发（流正常结束不能留定时器）', async () => {
  const watch = watchRequestStall(undefined, 0, { deadlineMs: 60, connectMs: 5000 });
  watch.clear();
  watch.dispose();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(watch.signal?.aborted, false);
});

test('连接建立阶段：stallMs=0 时默认 30s 内可配短超时，错误区别于停摆', async () => {
  const watch = watchRequestStall(undefined, 0, { deadlineMs: 60_000, connectMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(watch.signal?.aborted, true);
  assert.ok(watch.signal?.reason instanceof ProviderConnectError);
  assert.equal((watch.signal?.reason as ProviderConnectError).code, PROVIDER_CONNECT_CODE);
  watch.dispose();
});

test('不传 opts 的旧行为不变：stallMs=0 透传外层 signal，stallMs>0 仍是停摆判定', async () => {
  const outer = new AbortController();
  const passthrough = watchRequestStall(outer.signal, 0);
  assert.equal(passthrough.signal, outer.signal);
  const stalled = watchRequestStall(undefined, 40);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal((stalled.signal?.reason as any)?.code, PROVIDER_STALL_CODE);
  stalled.dispose();
});

/** 挂死的 SSE body：signal abort 时以 reason 拒绝读取（模拟 undici 的真实行为）。 */
function hangingResponse(signal: AbortSignal | undefined, frames: string[] = [], intervalMs = 0): Response {
  const encoder = new TextEncoder();
  let index = 0;
  let settled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        settled = true;
        try {
          controller.error(signal.reason ?? new Error('aborted'));
        } catch {
          /* 已关闭 */
        }
      }, { once: true });
      if (frames.length && intervalMs <= 0) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
      }
    },
    pull(controller) {
      if (!frames.length || intervalMs <= 0) return new Promise<void>(() => undefined);
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // abort 之后控制器已 error/close，滴答定时器必须停手，否则 enqueue 抛未捕获异常
          if (!settled) {
            try {
              if (index >= frames.length) controller.close();
              else controller.enqueue(encoder.encode(frames[index++]));
            } catch {
              /* 已关闭 */
            }
          }
          resolve();
        }, intervalMs);
      });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('OpenAIProvider（Ollama 配置）：body 挂死时按绝对截止报错，而不是永远等', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: any, init: any) => Promise.resolve(hangingResponse(init?.signal))) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', stallMs: 0, deadlineMs: 100 });
    await assert.rejects(
      (async () => {
        for await (const _ev of provider.stream(baseRequest)) void _ev;
      })(),
      (err: any) => {
        assert.equal(err.code, PROVIDER_DEADLINE_CODE);
        assert.notEqual(err.code, PROVIDER_STALL_CODE);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAIProvider：一直在吐字节的健康流也会被绝对截止掐断（截止看总时长，不看进展）', async () => {
  const originalFetch = globalThis.fetch;
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`;
  globalThis.fetch = ((_url: any, init: any) => Promise.resolve(hangingResponse(init?.signal, [frame, frame, frame, frame, frame, frame, frame, frame], 30))) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', stallMs: 0, deadlineMs: 120 });
    const started = Date.now();
    let text = '';
    await assert.rejects(
      (async () => {
        for await (const ev of provider.stream(baseRequest)) {
          if (ev.type === 'text') text += ev.text;
        }
      })(),
      (err: any) => err.code === PROVIDER_DEADLINE_CODE,
    );
    assert.ok(text.length > 0, '截止前已吐出的字节必须保留');
    assert.ok(Date.now() - started >= 110, '必须真的跑到了截止时间');
    assert.ok(Date.now() - started < 2000, '不能无限等');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAIProvider：正常完成的流不受截止影响，定时器不泄漏', async () => {
  const originalFetch = globalThis.fetch;
  const done = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  globalThis.fetch = ((_url: any, init: any) => Promise.resolve(hangingResponse(init?.signal, [done]))) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', stallMs: 0, deadlineMs: 5000 });
    const events: string[] = [];
    for await (const ev of provider.stream(baseRequest)) events.push(ev.type);
    assert.ok(events.includes('text'));
    assert.ok(events.includes('done'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Retry-After 解析：秒数与 HTTP 日期都认，非法值按没给', () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs('0.5'), 500);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('abc'), undefined);
  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfterMs(future);
  assert.ok(parsed !== undefined && parsed > 3000 && parsed <= 5000);
});