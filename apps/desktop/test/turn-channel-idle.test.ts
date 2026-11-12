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

const { readWithIdleCeiling, ApiError } = await import('../src/lib/api');

const here = dirname(fileURLToPath(import.meta.url));
// test/ → desktop/ → apps/ → 仓库根
const root = resolve(here, '../../..');
const source = (rel: string) => readFileSync(join(root, rel), 'utf8');
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
