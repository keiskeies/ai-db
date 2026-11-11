import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_STALL_CODE,
  PROVIDER_STALL_MS,
  ProviderStallError,
  readSse,
  resolveStallMs,
  watchRequestStall,
} from '../src/agent/providers/common';

// 这一组测试锁的是「回合不再有截止时间」之后的替代防线：
// 卡死只能由「连续多久没有字节」判定，慢但健康的流绝不能被误杀。

function frame(data: string): string {
  return `data: ${data}\n\n`;
}

/** 每 intervalMs 给一帧、共 count 帧的流；用来模拟「慢但一直在动」的健康连接。 */
function dripStream(frames: string[], intervalMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (index >= frames.length) {
            controller.close();
          } else {
            controller.enqueue(encoder.encode(frames[index++]));
          }
          resolve();
        }, intervalMs);
      });
    },
  });
}

/** 一帧都不发的流：真卡死的连接就是这个样子。 */
function silentStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return new Promise<void>(() => undefined);
    },
  });
}

async function drain(source: ReadableStream<Uint8Array>, stallMs: number): Promise<string[]> {
  const out: string[] = [];
  for await (const f of readSse(source, { stallMs })) out.push(f.data);
  return out;
}

test('慢但持续在动的流不会被停摆判定误杀', async () => {
  // 每 40ms 一帧、共 8 帧 ≈ 320ms，远超下面那个 120ms 阈值：
  // 判定看的是「帧间隔」，不是「总时长」——这正是回合级计时器做错的地方。
  const started = Date.now();
  const frames = await drain(dripStream([frame('1'), frame('2'), frame('3'), frame('4'), frame('5'), frame('6'), frame('7'), frame('8')], 40), 120);
  assert.equal(frames.length, 8, '健康长流必须一帧不落地读完');
  assert.ok(Date.now() - started > 120, '这个用例本身必须跑过阈值，否则什么都没测到');
});

test('连续无字节超过阈值时抛 PROVIDER_STALLED', async () => {
  await assert.rejects(
    () => drain(silentStream(), 80),
    (err: any) => {
      assert.equal(err.code, PROVIDER_STALL_CODE);
      assert.equal(err.name, 'ProviderStallError');
      assert.equal(err.retryable, true, '停摆可以重试，不能报成永久失败');
      return true;
    },
  );
});

test('已经收到的帧不因后续停摆而丢失', async () => {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame('第一批 12 张表')));
    },
    pull(controller) {
      // 第一帧之后彻底静默
      void controller;
      return new Promise<void>(() => undefined);
    },
  });
  const seen: string[] = [];
  // 边读边抛：第一帧必须在停摆之前就已经交给调用方
  await assert.rejects(
    (async () => {
      for await (const f of readSse(source, { stallMs: 80 })) seen.push(f.data);
    })(),
    /没有任何响应/,
  );
  assert.deepEqual(seen, ['第一批 12 张表'], '停摆不能作废已经产出的帧');
});

test('SSE keep-alive 注释帧算进展，不判死也不挤掉真数据', async () => {
  // 注释帧会被 parseFrame 丢掉（一帧数据都不产出），但字节确实进来了。
  // 若判定看的是「有没有数据帧」而不是「有没有字节」，这里会以 PROVIDER_STALLED 结束。
  const heartbeats = Array.from({ length: 6 }, () => ': keep-alive\n\n');
  const frames = await drain(dripStream([...heartbeats, frame('done')], 40), 200);
  assert.deepEqual(frames, ['done'], '心跳既不能被判死，也不能挤掉真数据');
});

test('stallMs=0 完全关闭看门狗，行为与裸 reader.read() 一致', async () => {
  const frames = await drain(dripStream([frame('a'), frame('b')], 30), 0);
  assert.deepEqual(frames, ['a', 'b']);
});

test('阈值取值顺序：显式传入 > 环境变量 > 默认值，非法值按没填', () => {
  assert.equal(resolveStallMs(1000, {}), 1000);
  assert.equal(resolveStallMs(0, {}), 0, '0 是合法值：关掉看门狗');
  assert.equal(resolveStallMs(undefined, { AIDB_PROVIDER_STALL_MS: '45000' }), 45_000);
  assert.equal(resolveStallMs(undefined, { AIDB_PROVIDER_STALL_MS: '0' }), 0);
  assert.equal(resolveStallMs(1000, { AIDB_PROVIDER_STALL_MS: '45000' }), 1000, '显式值赢过环境变量');
  assert.equal(resolveStallMs(undefined, { AIDB_PROVIDER_STALL_MS: 'abc' }), PROVIDER_STALL_MS);
  assert.equal(resolveStallMs(undefined, { AIDB_PROVIDER_STALL_MS: '' }), PROVIDER_STALL_MS);
  assert.equal(resolveStallMs(undefined, {}), PROVIDER_STALL_MS);
  assert.ok(PROVIDER_STALL_MS >= 120_000, '默认值必须远大于 SSE keep-alive 间隔，否则慢服务商会被误杀');
});

test('请求头阶段的看门狗：到点以 ProviderStallError 中止请求', async () => {
  const watch = watchRequestStall(undefined, 40);
  assert.ok(watch.signal);
  await assert.rejects(
    () => new Promise<Response>((resolve, reject) => {
      watch.signal!.addEventListener('abort', () => reject(watch.signal!.reason));
      void resolve;
    }),
    (reason: any) => {
      assert.equal(reason?.code, PROVIDER_STALL_CODE);
      return true;
    },
  );
  watch.clear();
});

test('外层中止信号照样传到请求阶段的 signal 上', async () => {
  const outer = new AbortController();
  const watch = watchRequestStall(outer.signal, 60_000);
  outer.abort();
  assert.equal(watch.signal?.aborted, true, '用户点停止必须能传到 fetch');
  watch.clear();
});

test('clear() 之后不再到点中止：响应头拿到就该由 readSse 接手', async () => {
  const watch = watchRequestStall(undefined, 30);
  watch.clear();
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(watch.signal?.aborted, false, 'clear 之后再判死就是把健康流掐了');
});

test('stallMs=0 时请求阶段直接透传外层 signal，不新建 controller', () => {
  const outer = new AbortController();
  const watch = watchRequestStall(outer.signal, 0);
  assert.equal(watch.signal, outer.signal);
});

test('停摆错误的文案说清是「无响应」，不是「跑太久」', () => {
  const err = new ProviderStallError(300_000);
  assert.match(err.message, /300 秒/);
  assert.match(err.message, /没有任何响应/);
  assert.doesNotMatch(err.message, /上限|预算/, '回合已经没有上限了，文案不能暗示还有');
});
