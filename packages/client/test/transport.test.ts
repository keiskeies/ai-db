import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TransportError,
  combineSignals,
  normalizeBaseUrl,
  formatTemplate,
  request,
  drainSseFrames,
  readWithIdleCeiling,
  streamTurn,
  type RequestConfig,
  type TransportDeps,
} from '../src/index';

class TestError extends TransportError {
  constructor(message: string, opts: { code?: string; status?: number; hint?: string } = {}) {
    super(message, opts);
    this.name = 'TestError';
  }
}

const deps: TransportDeps = { makeError: (m, o) => new TestError(m, o) };

const cfg = (over: Partial<RequestConfig> = {}): RequestConfig => ({
  baseUrl: '',
  getToken: () => 't',
  ...deps,
  ...over,
});

const stubFetch = (fn: typeof fetch) => {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => {
    globalThis.fetch = original;
  };
};

test('formatTemplate 按占位符序号直替', () => {
  assert.equal(formatTemplate('请求失败（{0}）', [404]), '请求失败（404）');
  assert.equal(formatTemplate('{0}秒/{1}', [1, 'x']), '1秒/x');
  assert.equal(formatTemplate('无占位'), '无占位');
});

test('normalizeBaseUrl 补 scheme 去尾斜杠', () => {
  assert.equal(normalizeBaseUrl(' 192.168.1.5:8787/ '), 'http://192.168.1.5:8787');
  assert.equal(normalizeBaseUrl('https://h:9000///'), 'https://h:9000');
});

test('TransportError 默认值与 name 不覆盖', () => {
  const err = new TransportError('m');
  assert.equal(err.code, 'API_ERROR');
  assert.equal(err.status, 0);
  assert.equal(err.name, 'Error');
  assert.equal(err.hint, undefined);
  const sub = new TestError('m', { code: 'C', status: 500, hint: 'h' });
  assert.equal(sub.name, 'TestError');
  assert.equal(sub.code, 'C');
  assert.equal(sub.hint, 'h');
  assert.ok(sub instanceof TransportError);
});

test('combineSignals 任一 abort 即中止', () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = combineSignals(a.signal, b.signal);
  assert.equal(combined.aborted, false);
  b.abort();
  assert.equal(combined.aborted, true);
  const single = combineSignals(a.signal);
  assert.equal(single, a.signal);
});

test('request 204 语义按端注入', async () => {
  const restore = stubFetch(async () => new Response(null, { status: 204 }));
  try {
    assert.equal(await request('/x', {}, 0, cfg()), undefined);
    assert.equal(await request('/x', {}, 0, cfg({ noContent: 'null' })), null);
  } finally {
    restore();
  }
});

test('request HTTP 错误兜底链逐端保持', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ error: { message: '坏了' } }), { status: 400 }));
  try {
    // desktop：不兜底 code，落类默认 API_ERROR
    await assert.rejects(request('/x', {}, 0, cfg()), (e: TestError) => e.code === 'API_ERROR' && e.status === 400 && e.message === '坏了');
    // mobile：兜底 BRIDGE_HTTP
    await assert.rejects(request('/x', {}, 0, cfg({ httpFallbackCode: 'BRIDGE_HTTP' })), (e: TestError) => e.code === 'BRIDGE_HTTP');
    // 服务端给了 code 就用服务端的
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'm', code: 'SRV' } }), { status: 400 });
    await assert.rejects(request('/x', {}, 0, cfg({ httpFallbackCode: 'BRIDGE_HTTP' })), (e: TestError) => e.code === 'SRV');
    // 无 error.message 时用状态码文案
    globalThis.fetch = async () => new Response('plain text', { status: 500 });
    await assert.rejects(request('/x', {}, 0, cfg()), (e: TestError) => e.message === '请求失败（500）');
  } finally {
    restore();
  }
});

test('request 网络错误归一按端开关', async () => {
  const boom = new Error('socket hang up');
  const restore = stubFetch(async () => {
    throw boom;
  });
  try {
    // mobile：裸抛原错误
    await assert.rejects(request('/x', {}, 0, cfg()), (e: unknown) => e === boom);
    // desktop：归一成 NETWORK_ERROR
    await assert.rejects(request('/x', {}, 0, cfg({ normalizeNetworkErrors: true })), (e: TestError) => e.code === 'NETWORK_ERROR' && e.message.includes('socket hang up'));
  } finally {
    restore();
  }
});

test('request 注入 baseUrl 与 getToken', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const restore = stubFetch(async (url, init) => {
    seenUrl = String(url);
    seenAuth = String((init?.headers as Record<string, string>).authorization);
    return new Response(JSON.stringify({ ok: true }));
  });
  try {
    const out = await request<{ ok: boolean }>('/health', {}, 0, cfg({ baseUrl: 'http://h:8787', getToken: () => 'tok' }));
    assert.deepEqual(out, { ok: true });
    assert.equal(seenUrl, 'http://h:8787/api/health');
    assert.equal(seenAuth, 'Bearer tok');
  } finally {
    restore();
  }
});

test('drainSseFrames 分帧/心跳/多行 data/残尾', () => {
  const seen: string[] = [];
  const rest = drainSseFrames(': ping\n\ndata: {"a":1}\n\ndata: line1\ndata: line2\n\ndata: partial', (d) => seen.push(d));
  assert.deepEqual(seen, ['{"a":1}', 'line1\nline2']);
  assert.equal(rest, 'data: partial');
  assert.equal(drainSseFrames(rest + '\n\n', (d) => seen.push(d)), '');
  assert.equal(seen[2], 'partial');
});

const byteStream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

test('readWithIdleCeiling 字节原样交出、done 回 undefined', async () => {
  const reader = byteStream([new Uint8Array([1, 2, 3])]).getReader();
  assert.deepEqual(await readWithIdleCeiling(reader, undefined, 1000, undefined, deps), new Uint8Array([1, 2, 3]));
  assert.equal(await readWithIdleCeiling(reader, undefined, 1000, undefined, deps), undefined);
});

test('readWithIdleCeiling 静默超时 cancel 并抛注入错误', async () => {
  let cancelled = false;
  const reader = new ReadableStream<Uint8Array>({ start() {} }).getReader();
  const originalCancel = reader.cancel.bind(reader);
  reader.cancel = () => {
    cancelled = true;
    return originalCancel();
  };
  await assert.rejects(
    readWithIdleCeiling(reader, undefined, 30, undefined, deps),
    (e: TestError) => e.code === 'TURN_CHANNEL_IDLE' && e instanceof TestError && /连续 0 秒/.test(e.message),
  );
  assert.equal(cancelled, true);
});

test('readWithIdleCeiling 用户中止保持 AbortError', async () => {
  const controller = new AbortController();
  const reader = new ReadableStream<Uint8Array>({ start() {} }).getReader();
  const pending = readWithIdleCeiling(reader, controller.signal, 5000, undefined, deps);
  controller.abort();
  await assert.rejects(pending, (e: Error) => e.name === 'AbortError');
});

test('streamTurn 心跳流不被事件级上限误杀', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < 6; i++) {
        controller.enqueue(encoder.encode(': ping\n\n'));
        await new Promise((r) => setTimeout(r, 20));
      }
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  const restore = stubFetch(async () => new Response(body));
  try {
    const events: unknown[] = [];
    await streamTurn('s1', { text: 'hi' }, (e) => events.push(e), undefined, 50, {
      baseUrl: '',
      getToken: () => 't',
      byteIdleMs: 600_000,
      ...deps,
    });
    assert.deepEqual(events, [{ type: 'done' }]);
  } finally {
    restore();
  }
});

test('streamTurn 半开连接由字节看门狗兜底抛 TURN_CHANNEL_IDLE', async () => {
  const body = new ReadableStream<Uint8Array>({ start() {} });
  const restore = stubFetch(async () => new Response(body));
  try {
    await assert.rejects(
      streamTurn('s1', { text: 'hi' }, () => undefined, undefined, 600_000, {
        baseUrl: '',
        getToken: () => 't',
        byteIdleMs: 30,
        ...deps,
      }),
      (e: TestError) => e.code === 'TURN_CHANNEL_IDLE',
    );
  } finally {
    restore();
  }
});