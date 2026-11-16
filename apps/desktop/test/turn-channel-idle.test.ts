import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「通道静默上限」：把「图标永远转、也说不出原因」里最阴的一档变成一句人话。
 *
 * `reader.read()` 在没有字节时会永远等下去。半开的 TCP（网关被杀、笔记本休眠唤醒、
 * 代理悄悄断线）既不产生 error 也不产生 done，于是 while 循环永远卡在那里，
 * live.status 一直是 streaming——界面转圈，用户只能刷新整页。
 *
 * 敢设这个上限，是因为服务端的心跳与回合进展**无关**：agent 回合的 SSE 路由用
 * setInterval 每 15 秒写一帧 `: ping`，大查询、等审批、模型慢慢想都在照常发字节。
 * 所以这条上限只能判「通道死了」，绝不会误判「这步很慢」——下面两条断言一个正一个反，
 * 把这个区别钉住。
 */

await (async () => {
  globalThis.location = { hash: '#token=t', pathname: '/', search: '' } as unknown as Location;
  globalThis.history = { replaceState() {} } as unknown as History;
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  } as unknown as Storage;
})();

const { readWithIdleCeiling, streamTurn, EVENT_IDLE_MS, ApiError } = await import('../src/lib/api');

const here = dirname(fileURLToPath(import.meta.url));
// test/ → desktop/ → apps/ → 仓库根
const root = resolve(here, '../../..');
const source = (rel: string) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n'); // autocrlf 工作区是 CRLF，源码断言按 LF 写
const routes = source('apps/gateway/src/routes.ts');
const apiSource = source('apps/desktop/src/lib/api.ts');

function streamOf(...chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read: async () =>
      index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true, value: undefined as unknown as Uint8Array },
    cancel: async () => undefined,
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** 一个永远不 resolve 的 reader，外加能观察到是否被 cancel。 */
function hangingReader(): { reader: ReadableStreamDefaultReader<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const reader = {
    read: () => new Promise<never>(() => undefined),
    cancel: async () => {
      cancelled = true;
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return { reader, cancelled: () => cancelled };
}

const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * 造一个「服务端 SSE 事件循环」：按计划发射事件帧与心跳帧。
 *
 * 每个计划条目 `[delayMs, chunk]`：先等 delayMs，再推 chunk。最后一个条目之前
 * 的 delay 都远小于 EVENT_IDLE_MS，只有用于触发字节级/事件级上限的条目才等很久。
 */
function heartbeatStream(
  plan: Array<[number, string]>,
): { reader: ReadableStreamDefaultReader<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = {
    read: () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        const step = plan[i];
        if (!step) {
          resolve({ done: true });
          return;
        }
        i += 1;
        const [delayMs, chunk] = step;
        timer = setTimeout(() => {
          if (cancelled) return;
          resolve({ done: false, value: bytes(chunk) });
        }, delayMs);
      }),
    cancel: async () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return { reader, cancelled: () => cancelled };
}

// streamTurn 里 fetch 到的 body 流；不做真 fetch，只验证 reader 循环与上限逻辑。
function fakeFetchBody(reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
}

test('正常字节照原样交出，流结束返回 undefined', async () => {
  const reader = streamOf(bytes(': ping\n\n'), bytes('data: {"type":"text_delta","text":"好"}\n\n'));
  const first = await readWithIdleCeiling(reader, undefined, 50);
  assert.deepEqual([...(first ?? [])], [...bytes(': ping\n\n')]);
  const second = await readWithIdleCeiling(reader, undefined, 50);
  assert.ok(second);
  const end = await readWithIdleCeiling(reader, undefined, 50);
  assert.equal(end, undefined, 'done 要变成 undefined，让调用方跳出循环');
});

test('通道静默：抛 TURN_CHANNEL_IDLE，并且 cancel 掉 reader 让网关那边收到 close', async () => {
  const { reader, cancelled } = hangingReader();
  await assert.rejects(() => readWithIdleCeiling(reader, undefined, 30), (err: unknown) => {
    assert.ok(err instanceof ApiError, `应当是 ApiError，实际 ${(err as Error)?.name}`);
    assert.equal((err as ApiError).code, 'TURN_CHANNEL_IDLE');
    // 用例把阈值压到 30ms，所以文案里的秒数是 0；断文案内容没有意义，
    // 只断它确实带了一句话说清「连接静默、已断开、可继续」——按源码里的中文原文查。
    assert.match((err as Error).message, /\S/, '必须带一句可读的说明');
    assert.match(apiSource, /与服务端的连接连续 \{0\} 秒没有任何响应[\s\S]{0,40}继续/, '文案要说清还能继续，而不是只报断开');
    return true;
  });
  // 不 cancel 就只是本地不等了：底层连接还挂着，网关那边收不到 close，
  // 于是它的回合继续跑、会话永远 running。
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelled(), true, '超时必须取消读取');
});

test('用户中止仍然是 AbortError：不能被静默文案盖掉「用户中止」', async () => {
  const { reader } = hangingReader();
  const controller = new AbortController();
  const pending = readWithIdleCeiling(reader, controller.signal, 60_000);
  // 上限给到 60 秒，确保下面这条一定是中止先到
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => pending, (err: unknown) => {
    assert.equal((err as Error).name, 'AbortError', '静默上限的文案不该冒充用户中止');
    assert.notEqual((err as ApiError).code, 'TURN_CHANNEL_IDLE', '人点的停止就是停止，别报成连接静默');
    return true;
  });
});

test('事件级静默上限：只有 `: ping` 心跳、无 data 帧的健康回合不被误杀', async () => {
  // 压缩时间轴：事件上限压到 45ms，心跳每 30ms 一帧、全程无 data 帧。
  // 若心跳不算活动，第二次读前检查时 lastActivityAt 还停在 0，不到 90ms 就会抛；
  // 心跳算活动则一直刷新，流结束自然 return，且字节级上限（默认 600s）远未触发。
  const idle = 45;
  const { reader, cancelled } = heartbeatStream([
    [0, ': ping\n\n'],
    [30, ': ping\n\n'],
    [60, ': ping\n\n'],
    [90, ': ping\n\n'],
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeFetchBody(reader);
  try {
    await streamTurn('s1', { text: '慢' }, () => undefined, undefined, idle);
  } finally {
    globalThis.fetch = origFetch;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelled(), false, '健康心跳回合不该被 cancel');
});

test('字节级兜底：默认上限是长阈值，短窗口内重度延迟不会触发', async () => {
  // readWithIdleCeiling 默认 idleMs 是线上阈值（600s）：挂起 reader 上等 150ms
  // 不应当抛 TURN_CHANNEL_IDLE——证明字节级不是 90 秒短阈值重新回来；
  // 再用手动 cancel 收尾，避免定时器挂到 600s。
  const { reader } = hangingReader();
  const controller = new AbortController();
  const pending = readWithIdleCeiling(reader, controller.signal);
  let fired = false;
  pending.then(
    () => undefined,
    () => {
      fired = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fired, false, '150ms 不该触发 600s 的字节级上限');
  controller.abort();
  await assert.rejects(() => pending, (err: unknown) => {
    assert.equal((err as Error).name, 'AbortError');
    return true;
  });
});

test('来源断言：字节级上限已是 600000ms，且事件级上限小于字节级', () => {
  const ceiling = /const TURN_IDLE_CEILING_MS = ([\d_]+)/.exec(apiSource);
  assert.ok(ceiling, '字节级上限找不到');
  const ceilingMs = Number(ceiling![1].replace(/_/g, ''));
  assert.equal(ceilingMs, 600_000, '字节级上限应为 10 分钟（与 PROVIDER_STALL_MS 对齐）');
  assert.ok(
    typeof EVENT_IDLE_MS === 'number' && EVENT_IDLE_MS === 300_000,
    `事件级上限应当导出且为 5 分钟，实际 ${EVENT_IDLE_MS}`,
  );
  assert.ok(EVENT_IDLE_MS < ceilingMs, '事件级上限应比字节级上限小');
});

test('上限按服务端心跳定，且心跳与回合进展无关', () => {
  // 心跳必须是**独立定时器**：写在事件回调里的心跳等于「有进展才发」，
  // 那样长查询就不再发字节，这条上限会把健康长回合一刀切断。
  const heartbeat = routes.slice(routes.indexOf("'/agent/sessions/:id/turns'"), routes.indexOf("'/agent/sessions/:id/turns'") + 2400);
  assert.match(heartbeat, /setInterval\(\(\) => \{[\s\S]{0,80}res\.write\(': ping\\n\\n'\)/, '心跳得是 setInterval');
  const interval = /},\s*(\d+)\);\s*\n\s*res\.on\('close'/.exec(heartbeat);
  assert.ok(interval, '找不到心跳间隔');
  const heartbeatMs = Number(interval![1]);
  // 源码里写的是 90_000 这种带分隔符的字面量，要把分隔符吃掉再转数字
  const ceiling = /const TURN_IDLE_CEILING_MS = ([\d_]+)/.exec(apiSource);
  assert.ok(ceiling, '客户端静默上限找不到');
  const ceilingMs = Number(ceiling![1].replace(/_/g, ''));
  // 至少容忍连丢 4 次心跳：桌面端切后台、系统睡眠唤醒都可能一次就吞掉好几帧。
  assert.ok(
    ceilingMs >= heartbeatMs * 4,
    `上限 ${ceilingMs}ms 太贴近心跳 ${heartbeatMs}ms：偶发丢帧就会误断开健康回合`,
  );
});
