import { DEFAULT_MAX_OUTPUT_TOKENS, formatTokenSize } from './profile';

export class ProviderError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
  /** 429 时服务商 Retry-After 头换算出的毫秒数；runtime 重试退避据此让路。 */
  retryAfterMs?: number;
  constructor(message: string, opts: { code?: string; status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = opts.code ?? 'PROVIDER_ERROR';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * 流式响应「彻底不动了」的判定阈值：连续这么久没有任何字节进来就认定连接死了。
 *
 * 值必须远大于「模型在认真生成一段长内容」的字节间隔（正常是毫秒级），也要大于
 * 服务商常见的 SSE keep-alive 间隔（多数 15~30 秒发一个注释帧）——否则慢但健康的
 * 流会被误杀。只有真的一个字节都没来才算停摆，生成得慢从来不是问题。
 */
export const PROVIDER_STALL_MS = 300_000;

/** 停摆错误的 code；runtime 据此把停摆与真正的调用失败分开处理。 */
export const PROVIDER_STALL_CODE = 'PROVIDER_STALLED';
export const PROVIDER_STREAM_CODE = 'PROVIDER_STREAM';
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 10_000;

export interface SseOptions {
  /** 连续无字节多久算停摆；0 表示关闭（本地模型首 token 前可能静默很久）。 */
  stallMs?: number;
}

/** 停摆阈值的环境变量入口；设 0 关掉看门狗（自建端点首 token 前可能静默很久）。 */
export const PROVIDER_STALL_ENV = 'AIDB_PROVIDER_STALL_MS';

/**
 * 停摆阈值的取值顺序：显式传入 > 环境变量 > 默认值。
 *
 * 环境变量的地位与原来的 AIDB_AGENT_TURN_MS 一样——运维的兜底开关，只是它现在调的是
 * 「多久没字节算死」，而不是「一个回合最多活多久」。填非法值按没填处理。
 */
export function resolveStallMs(
  explicit: number | undefined,
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.max(0, explicit);
  const raw = env[PROVIDER_STALL_ENV];
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(parsed)) return Math.max(0, parsed);
  return PROVIDER_STALL_MS;
}

export class ProviderStallError extends ProviderError {
  constructor(stallMs: number) {
    super(`模型接口连续 ${Math.round(stallMs / 1000)} 秒没有任何响应，已断开本次调用`, {
      code: 'PROVIDER_STALLED',
      retryable: true,
    });
    this.name = 'ProviderStallError';
  }
}

/**
 * 绝对截止时间的默认上限。停摆看门狗只看「有没有进展」，对关闭了停摆判定的本地端点
 * （Ollama stallMs:0）来说，引擎真挂死时一个字节都不来但也永远不报错——必须有一条
 * 「无论如何最多活这么久」的兜底底线。15 分钟足够覆盖本地长 prefill，又不至于无限挂起。
 */
export const PROVIDER_DEADLINE_MS = 15 * 60 * 1000;
export const PROVIDER_DEADLINE_ENV = 'AIDB_PROVIDER_DEADLINE_MS';
export const PROVIDER_DEADLINE_CODE = 'PROVIDER_DEADLINE';

/** 连接建立阶段（拿到响应头之前）的兜底超时；本地引擎加载模型再慢，TCP/HTTP 握手也不该这么久。 */
export const PROVIDER_CONNECT_MS = 30_000;
export const PROVIDER_CONNECT_CODE = 'PROVIDER_CONNECT_TIMEOUT';

/** 取值顺序与 resolveStallMs 一致：显式传入 > 环境变量 > 默认值；0 表示关闭绝对截止。 */
export function resolveDeadlineMs(
  explicit?: number,
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.max(0, explicit);
  const raw = env[PROVIDER_DEADLINE_ENV];
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(parsed)) return Math.max(0, parsed);
  return PROVIDER_DEADLINE_MS;
}

/** 与停摆错误刻意分开：停摆是「连接不动了」，截止是「跑得太久」，处置与文案都不同。 */
export class ProviderDeadlineError extends ProviderError {
  constructor(deadlineMs: number) {
    super(`模型调用超过绝对时长上限（${Math.round(deadlineMs / 60000)} 分钟），已终止本次调用；本地引擎可通过环境变量 ${PROVIDER_DEADLINE_ENV} 调大上限`, {
      code: PROVIDER_DEADLINE_CODE,
      retryable: true,
    });
    this.name = 'ProviderDeadlineError';
  }
}

export class ProviderConnectError extends ProviderError {
  constructor(connectMs: number) {
    super(`模型接口 ${Math.round(connectMs / 1000)} 秒内未建立连接（连接阶段超时），已断开本次调用`, {
      code: PROVIDER_CONNECT_CODE,
      retryable: true,
    });
    this.name = 'ProviderConnectError';
  }
}

/**
 * 读下一个字节，但连续 stallMs 没有任何字节就抛 PROVIDER_STALLED。
 *
 * 这是对「回合卡死」唯一的正确防御位置——**这一层知道什么叫进展**。回合级计时器不知道：
 * 它只看总时长，于是健康的长回合（模型在连续生成、工具在连续返回）和真卡死的连接
 * 在它眼里一模一样，只能一起掐断。字节流在这里断了，才真的「多等一秒也不会变」。
 *
 * 判定只看字节、不看内容：SSE 注释帧（`: keep-alive`）也算进展，它是服务端活着的证据，
 * 哪怕 parseFrame 会把它丢掉。stallMs 为 0 时行为与裸 `reader.read()` 完全一致。
 */
/** 本仓库的 lib 组合里没有全局 ReadableStreamReadResult，从 reader.read() 反推。 */
type ChunkRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stallMs: number,
): Promise<ChunkRead> {
  const pending = reader.read();
  if (!(stallMs > 0)) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  try {
    // 谁先返回：连接给了字节，还是静默越过了阈值。
    return await new Promise<ChunkRead>((resolve, reject) => {
      timer = setTimeout(() => {
        stalled = true;
        reject(new ProviderStallError(stallMs));
      }, stallMs);
      timer.unref?.();
      pending.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    // 阈值先到时调用方会直接退出循环；cancel 若卡住不能把停摆错误一起拖死。
    if (stalled) void reader.cancel().catch(() => undefined);
  }
}

export function providerStreamError(message: string): ProviderError {
  return new ProviderError(message, { code: PROVIDER_STREAM_CODE, retryable: true });
}

export function parseToolArguments(text: string, provider: string, tool: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw providerStreamError(`${provider} 返回的工具 ${tool} 参数 JSON 未闭合或格式无效`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw providerStreamError(`${provider} 返回的工具 ${tool} 参数必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

export async function readResponseText(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; stallMs?: number; timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? ERROR_BODY_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? ERROR_BODY_MAX_BYTES;
  const onAbort = () => { void reader.cancel(controller.signal.reason).catch(() => undefined); };
  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) controller.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(providerStreamError('读取模型错误响应超时')), Math.max(1, timeoutMs));
  timer.unref?.();
  let size = 0;
  let text = '';
  try {
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const chunk = await readChunk(reader, opts.stallMs ?? PROVIDER_STALL_MS);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maxBytes) throw providerStreamError('模型错误响应超过读取上限');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    opts.signal?.removeEventListener('abort', onOuterAbort);
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * 给 fetch 请求头阶段加停摆看门狗：连续 stallMs 没拿到响应就把请求掐掉。
 *
 * 这一段连字节都还没有，readSse 的看门狗管不到，而它恰恰最容易无声挂死（端点被网关
 * 吃掉、TLS 握手卡住）。原来到点就掐整个回合的定时器顺手覆盖了这里，删掉它之后必须由
 * 这一层自己说清「等多久算死」——注意判定依然是「没有响应」，不是「回合跑太久」。
 *
 * 用法：把返回的 signal 传给 fetch，拿到响应头之后调 clear() 关掉请求头阶段的定时器
 * （之后的静默交给 readSse 逐块判定）。clear() 故意**不**摘外层 abort 监听——fetch 的请求体读取
 * 仍然挂在这个 signal 上，摘掉监听会让「用户点停止」再也传不到连接上。流彻底结束后调
 * dispose() 收尾（清掉绝对截止定时器与外层监听）。
 *
 * opts 面向关闭了停摆判定的本地端点（Ollama stallMs:0）：
 * - connectMs：连接建立阶段的兜底超时（默认 30s），错误与停摆文案区分开；
 * - deadlineMs：覆盖「请求 + 整个流式读取」的绝对截止时间，clear() 不会停掉它。
 * 不传 opts 时行为与旧版完全一致，其他提供商的停摆看门狗不受影响。
 */
export function watchRequestStall(
  outer: AbortSignal | undefined,
  stallMs: number,
  opts?: { deadlineMs?: number; connectMs?: number },
): { signal: AbortSignal | undefined; clear: () => void; dispose: () => void } {
  const deadlineMs = opts?.deadlineMs ?? 0;
  if (!(stallMs > 0) && opts === undefined) return { signal: outer, clear: () => undefined, dispose: () => undefined };
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onOuterAbort, { once: true });
  // 请求头阶段：有停摆阈值沿用停摆判定；没有（本地端点）则用连接阶段兜底超时
  const headerMs = stallMs > 0 ? stallMs : (opts?.connectMs ?? PROVIDER_CONNECT_MS);
  const headerError = stallMs > 0 ? new ProviderStallError(stallMs) : new ProviderConnectError(headerMs);
  const headerTimer = setTimeout(() => controller.abort(headerError), headerMs);
  headerTimer.unref?.();
  // 绝对截止独立于请求头阶段：拿到响应头后继续计时，直到整个流读完
  const deadlineTimer = deadlineMs > 0 ? setTimeout(() => controller.abort(new ProviderDeadlineError(deadlineMs)), deadlineMs) : undefined;
  deadlineTimer?.unref?.();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(headerTimer),
    dispose: () => {
      clearTimeout(headerTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}

/** Split an ReadableStream into SSE frames. Handles chunk boundaries and CRLF. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  opts: SseOptions = {},
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingCr = false;
  let done = false;
  while (!done) {
    const chunk = await readChunk(reader, opts.stallMs ?? PROVIDER_STALL_MS);
    if (chunk.done) {
      done = true;
      buffer += ((pendingCr ? '\r' : '') + decoder.decode()).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (buffer.trim()) {
        const last = parseFrame(buffer);
        if (last) yield last;
      }
      break;
    }
    const decoded: string = (pendingCr ? '\r' : '') + decoder.decode(chunk.value, { stream: true });
    pendingCr = decoded.endsWith('\r');
    buffer += (pendingCr ? decoded.slice(0, -1) : decoded).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame = parseFrame(raw);
      if (frame) yield frame;
      idx = buffer.indexOf('\n\n');
    }
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

/**
 * 服务商抱怨「输出/上下文太长」时的补话。
 *
 * 没填档案时 max_tokens 下发的是默认档位 32K（设置页预填的那个值）。大多数端点吃得下，
 * 但小窗口或低配额的端点会直接 400 拒掉——这时错误里只有一句服务商原文，用户不知道该改哪。
 * 与其让人猜，不如直接说出改哪儿。命中关键词才补，正常报错不掺话。
 */
const LIMIT_HINT = /max_tokens|maximum tokens|too long|context.length|too many tokens/i;

/** Retry-After 两种合法形态：秒数或 HTTP 日期；解析失败按没给处理。 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(Number(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function mapHttpError(status: number, body: string, retryAfter?: string | null): ProviderError {
  let detail = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body);
    detail = parsed.error?.message ?? parsed.message ?? detail;
  } catch {
    /* keep raw */
  }
  if (status === 400 && LIMIT_HINT.test(detail)) {
    detail += `（若该端点不接受这么大的输出上限，到 设置 → 模型能力 把「最大输出 token 数」调小；没填时按默认档位 ${formatTokenSize(DEFAULT_MAX_OUTPUT_TOKENS)} 下发）`;
  }
  const retryable = status === 429 || status >= 500;
  const code = status === 401 || status === 403 ? 'PROVIDER_AUTH' : status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP';
  return new ProviderError(`模型接口返回 ${status}：${detail}`, {
    code,
    status,
    retryable,
    ...(status === 429 ? { retryAfterMs: parseRetryAfterMs(retryAfter) } : {}),
  });
}

/**
 * 提示词缓存用量的归一化。
 *
 * 各家服务商的字段名与口径都不一样，但都能归到「命中多少 / 未命中多少」两个数字上：
 * - OpenAI 系：`prompt_tokens_details.cached_tokens`，未命中部分要自己减出来；
 * - DeepSeek 系：`prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens` 都给；
 * - Anthropic 系：`cache_read_input_tokens` 是命中量，其余输入都算未命中。
 *
 * 两个数都拿不到时返回空对象——调用方据此隐藏缓存指标，而不是显示一个假的 0%。
 */
export function normalizeCacheUsage(
  tokensIn: number,
  cacheHitTokens?: number,
  cacheMissTokens?: number,
): { cacheHitTokens?: number; cacheMissTokens?: number } {
  // 负数与非数字都按「服务商没报这个字段」处理，不能让脏数据污染命中率
  const valid = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  const hit = valid(cacheHitTokens);
  const miss = valid(cacheMissTokens);
  if (hit === undefined && miss === undefined) return {};
  const input = Number.isFinite(tokensIn) ? Math.max(0, Math.floor(tokensIn)) : 0;
  if (hit !== undefined && miss !== undefined) return { cacheHitTokens: hit, cacheMissTokens: miss };
  if (hit !== undefined) return { cacheHitTokens: hit, cacheMissTokens: Math.max(0, input - hit) };
  return { cacheHitTokens: Math.max(0, input - (miss as number)), cacheMissTokens: miss };
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** 本机或内网端点（Ollama / LM Studio / vLLM）通常不带鉴权。 */
export function isPrivateEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host === 'host.docker.internal' || host === 'gateway.docker.internal';
}
