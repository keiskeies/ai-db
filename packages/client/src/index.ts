/**
 * 平台无关的传输核心：JSON 请求壳 + SSE 分帧/双层静默看门狗。
 * 两端差异（超时、204 语义、错误兜底码、文案翻译、错误类身份）全部经配置注入，
 * 核心本身不持有任一端的现值——见 docs/25 附录 B 的 A/B/C 分类裁决。
 */

export interface TransportErrorOptions {
  code?: string;
  status?: number;
  hint?: string;
}

/** 共享错误基类。不设置 name：desktop 子类置 'ApiError'，mobile 子类保持 'Error'。 */
export class TransportError extends Error {
  code: string;
  status: number;
  hint?: string;
  constructor(message: string, opts: TransportErrorOptions = {}) {
    super(message);
    this.code = opts.code ?? 'API_ERROR';
    this.status = opts.status ?? 0;
    this.hint = opts.hint;
  }
}

export interface TransportDeps {
  /** 错误工厂：desktop 造 ApiError，mobile 造 BridgeError，instanceof/name 锚点由各端子类保持。 */
  makeError: (message: string, opts?: TransportErrorOptions) => Error;
  /** 文案翻译：desktop 注入 i18n 的 tr；不注入时用 {0} 占位符直替（mobile 硬编码中文现状）。 */
  tr?: (template: string, args?: Array<string | number>) => string;
}

export function formatTemplate(template: string, args?: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (_, i) => String(args?.[Number(i)] ?? ''));
}

const trOf = (deps: TransportDeps) => deps.tr ?? formatTemplate;

/** 组合多个 signal：任一 abort 即中止。AbortSignal.any 不可用时退回手动监听（兼容旧内核）。 */
export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export interface RequestConfig extends TransportDeps {
  /** 请求前缀：desktop 传 ''（同源 /api），mobile 传配对得到的 baseUrl。 */
  baseUrl: string;
  /** desktop 请求注入 () => TOKEN 保持加载期快照语义；mobile 注入实例 config.token。 */
  getToken: () => string;
  /** 0 = 禁用超时（mobile 现状）；desktop 注入五档现值。 */
  timeoutMs?: number;
  /** 204 返回值：desktop 'undefined'，mobile 'null'。两端 DELETE 调用方分别依赖，不得统一。 */
  noContent?: 'undefined' | 'null';
  /** HTTP 错误兜底码：desktop 不兜底（落类默认 'API_ERROR'），mobile 'BRIDGE_HTTP'。 */
  httpFallbackCode?: string;
  /** 是否把 fetch/读 body 异常归一成传输错误：desktop true，mobile false（裸抛）。 */
  normalizeNetworkErrors?: boolean;
}

/** 把 fetch/读 body 阶段的异常归一成传输错误；用户主动取消仍原样抛 AbortError 供调用方静默复位。 */
function asRequestError(err: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal | undefined, timeoutMs: number, deps: TransportDeps): unknown {
  const tr = trOf(deps);
  if (callerSignal?.aborted) return err;
  if (timeoutSignal?.aborted) {
    return deps.makeError(tr('请求超时（超过 {0} 秒无响应），已中止。', [Math.round(timeoutMs / 1000)]), { code: 'REQUEST_TIMEOUT' });
  }
  if (err instanceof TransportError) return err;
  if ((err as Error)?.name === 'AbortError') return err;
  return deps.makeError(tr('网络请求失败：{0}', [(err as Error)?.message ?? String(err)]), { code: 'NETWORK_ERROR' });
}

export async function request<T>(path: string, init: RequestInit = {}, timeoutMs: number, cfg: RequestConfig): Promise<T> {
  const tr = trOf(cfg);
  const { signal: callerSignal, ...rest } = init;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal = combineSignals(callerSignal ?? undefined, timeoutSignal);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${cfg.baseUrl}/api${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.getToken()}`,
        ...(init.headers ?? {}),
      },
      signal,
    });
    if (res.status === 204) return (cfg.noContent === 'null' ? null : undefined) as T;
    text = await res.text();
  } catch (err) {
    if (!cfg.normalizeNetworkErrors) throw err;
    throw asRequestError(err, callerSignal ?? undefined, timeoutSignal, timeoutMs, cfg);
  }
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const err = payload?.error;
    throw cfg.makeError(typeof err?.message === 'string' ? err.message : tr('请求失败（{0}）', [res.status]), {
      code: err?.code ?? cfg.httpFallbackCode,
      status: res.status,
      hint: err?.hint,
    });
  }
  return payload as T;
}

/** 回合通道字节级静默的默认文案模板；desktop 适配层另以字面量注入同一文案（测试源码锚定）。 */
export const TURN_IDLE_TEMPLATE = '与服务端的连接连续 {0} 秒没有任何响应，本次回复已断开。已完成的部分仍然保留，回复「继续」可接着做。';

/** 带静默上限的一次读取；超时抛错，用户中止仍然原样抛 AbortError。 */
export async function readWithIdleCeiling(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  idleMs: number,
  idle: { code?: string; message?: string } | undefined,
  deps: TransportDeps,
): Promise<Uint8Array | undefined> {
  const tr = trOf(deps);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Uint8Array | undefined>((resolve, reject) => {
      timer = setTimeout(() => {
        // 先取消再抛：不 cancel 的话底层连接会一直挂着，网关那边的 close 也不触发，
        // 于是它那边的回合还在跑（网关靠 close 才 abort）。
        void reader.cancel().catch(() => undefined);
        reject(
          deps.makeError(idle?.message ?? tr(TURN_IDLE_TEMPLATE, [Math.round(idleMs / 1000)]), {
            code: idle?.code ?? 'TURN_CHANNEL_IDLE',
          }),
        );
      }, idleMs);
      // 用户点停止：把 AbortError 照原样抛出去，别让上面那段超时文案盖掉「用户中止」
      const onAbort = () => {
        void reader.cancel().catch(() => undefined);
        reject(signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      reader.read().then(
        ({ done, value }) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(done ? undefined : value);
        },
        (err) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 从缓冲区取出所有完整 SSE 帧的 data 段，返回剩余不足一帧的尾部。心跳/注释帧跳过。 */
export function drainSseFrames(buffer: string, onData: (data: string) => void): string {
  let idx = buffer.indexOf('\n\n');
  while (idx !== -1) {
    const frame = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 2);
    if (frame && !frame.startsWith(':')) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data) onData(data);
    }
    idx = buffer.indexOf('\n\n');
  }
  return buffer;
}

export interface SseIdleOptions {
  signal?: AbortSignal;
  /** 字节层静默上限：连续这么久没有任何字节就判通道死。默认由适配层注入（desktop 为回合的 10 分钟）。 */
  byteIdleMs?: number;
  /** 事件层静默上限（含心跳帧）；不传则不做事件层判定。 */
  eventIdleMs?: number;
  /** 静默超时的错误码与文案，按流类型贴合场景。 */
  idleCode?: string;
  idleMessage?: string;
}

/**
 * 共享的 SSE 读取循环：字节/事件双层 idle 看门狗。
 * 半开的 TCP 既不报错也不结束，裸 reader.read() 会永远等下去——这里用
 * readWithIdleCeiling 兜底，超时 cancel 掉 reader 让网关收到 close。
 */
export async function readSseStream(
  res: Response,
  onEvent: (event: unknown) => void,
  opts: SseIdleOptions,
  deps: TransportDeps,
  defaultByteIdleMs: number,
): Promise<void> {
  const tr = trOf(deps);
  if (!res.body) throw deps.makeError(tr('响应不支持流式读取'), { code: 'SSE_BODY', status: res.status });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const byteIdleMs = opts.byteIdleMs ?? defaultByteIdleMs;
  const idle = { code: opts.idleCode, message: opts.idleMessage };
  let buffer = '';
  let lastActivityAt = Date.now();
  while (true) {
    if (opts.eventIdleMs && Date.now() - lastActivityAt > opts.eventIdleMs) {
      void reader.cancel().catch(() => undefined);
      throw deps.makeError(
        opts.idleMessage ?? tr('与服务端的连接连续 {0} 秒没有任何响应，已断开。', [Math.round(opts.eventIdleMs / 1000)]),
        { code: opts.idleCode ?? 'SSE_CHANNEL_IDLE' },
      );
    }
    const chunk = await readWithIdleCeiling(reader, opts.signal, byteIdleMs, idle, deps);
    if (chunk === undefined) break;
    // 任何一帧（哪怕只有心跳）到达都算通道还活着，在解码/解析之前就更新活动时间。
    lastActivityAt = Date.now();
    buffer = drainSseFrames((buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n'), (data) => {
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore malformed frame */
      }
    });
  }
}

export interface TurnPayload {
  text: string;
  mode?: string;
  attachments?: string[];
  /** 已上传的图片附件 id。 */
  images?: string[];
  connectionId?: string;
  database?: string;
}

export interface StreamTurnConfig extends TransportDeps {
  baseUrl: string;
  getToken: () => string;
  /** 字节级静默上限（desktop 注入 TURN_IDLE_CEILING_MS 现值）。 */
  byteIdleMs: number;
  /** 事件级静默超时文案；不注入时用 TURN_IDLE_TEMPLATE 经 tr 产出。 */
  eventIdleMessage?: string;
}

/** SSE 回合通道。WS 回合通道是 mobile 平台专属，不在此核心内（docs/25 C1 裁决）。 */
export async function streamTurn<T = unknown>(
  sessionId: string,
  payload: TurnPayload,
  onEvent: (event: T) => void,
  signal: AbortSignal | undefined,
  eventIdleMs: number,
  cfg: StreamTurnConfig,
): Promise<void> {
  const tr = trOf(cfg);
  const res = await fetch(`${cfg.baseUrl}/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.getToken()}` },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = tr('Agent 请求失败（{0}）', [res.status]);
    let code = 'AGENT_REQUEST';
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? message;
      code = parsed?.error?.code ?? code;
    } catch {
      /* keep */
    }
    throw cfg.makeError(message, { code, status: res.status });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // 事件级静默上限：服务端只在有新内容时才发 data: 帧，但心跳定时器是独立于回合
  // 进展的——所以「5 分钟没有任何一帧到达」只能是通道死了，而不是这步很慢。
  let lastActivityAt = Date.now();
  while (true) {
    // 字节级上限只管「半开连接」。真正的长思考/长工具回合可能连续几分钟没有字节，
    // 这是合法的；这里用事件级上限兜底：连心跳都没有了才是真断了。
    if (Date.now() - lastActivityAt > eventIdleMs) {
      void reader.cancel().catch(() => undefined);
      throw cfg.makeError(cfg.eventIdleMessage ?? tr(TURN_IDLE_TEMPLATE, [Math.round(eventIdleMs / 1000)]), { code: 'TURN_CHANNEL_IDLE' });
    }
    // 用带上限的读取而不是裸 reader.read()：半开的连接既不报错也不结束，
    // 裸读会永远等下去，界面上就是「图标转到天荒地老」。
    const chunk = await readWithIdleCeiling(reader, signal, cfg.byteIdleMs, undefined, cfg);
    if (chunk === undefined) break;
    // 任何一帧（哪怕是只有 `: ping` 的心跳块）到达都算通道还活着，
    // 在解码/解析之前就更新活动时间，避免静默回合被误杀。
    lastActivityAt = Date.now();
    buffer = drainSseFrames((buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n'), (data) => {
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore malformed frame */
      }
    });
  }
}