import type {
  AgentContextBundle,
  AgentContextEntry,
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  AppSettings,
  ArtifactInfo,
  ArtifactRunInfo,
  ArtifactScheduleInfo,
  AuditEntry,
  BackupInfo,
  Capability,
  CommandDefinition,
  CommandRunEvent,
  CommandRunInfo,
  CommandRunInput,
  ConnectionConfig,
  DashboardCard,
  DashboardCardResult,
  DashboardCardSource,
  DashboardChartType,
  DashboardComposeResult,
  DashboardPreview,
  DashboardScheduleInfo,
  DashboardTimeRange,
  DatabaseSchema,
  DeviceInfo,
  McpServerInfo,
  Memory,
  ModelInfo,
  NotificationChannelInfo,
  NotificationChannelType,
  PipelineCredentialInfo,
  PipelineEvent,
  PipelineInfo,
  PipelineRunInfo,
  PipelineSpec,
  QueryBatchResult,
  QuestionSuggestion,
  QueryResult,
  RedisKeyDetail,
  SkillDetail,
  SkillReadResult,
  SkillRunFile,
  SkillSummary,
  TableInfo,
  ToolResult,
} from '@aidb/core';
import { t as tr } from '../i18n';

function resolveToken(): string {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const fromHash = params.get('token');
  if (fromHash) {
    try {
      localStorage.setItem('aidb.token', fromHash);
    } catch {
      /* ignore */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  try {
    return localStorage.getItem('aidb.token') || (import.meta.env.DEV ? 'dev-token' : '');
  } catch {
    return import.meta.env.DEV ? 'dev-token' : '';
  }
}

export const TOKEN = resolveToken();

/**
 * 每次调用都重新解析：WS 重连时要能拿到配对之后才写入的 token，
 * 而不是页面加载时快照下来的那个空串。
 */
export function authToken(): string {
  return resolveToken();
}

export class ApiError extends Error {
  code: string;
  status: number;
  hint?: string;
  constructor(message: string, opts: { code?: string; status?: number; hint?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code ?? 'API_ERROR';
    this.status = opts.status ?? 0;
    this.hint = opts.hint;
  }
}

/** 普通请求的兜底超时：后端挂起/半开连接时不能让用户对着转圈等到天荒地老。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** schema 内省可能逐库 describe，放宽到 60s。 */
const SCHEMA_REQUEST_TIMEOUT_MS = 60_000;
/** 导出/导入要落盘大文件，放宽到 300s。 */
const TRANSFER_REQUEST_TIMEOUT_MS = 300_000;
/** 备份/恢复整库可能很久，放宽到 600s。 */
const BACKUP_REQUEST_TIMEOUT_MS = 600_000;
/**
 * 慢查询合法地可能远超 30s（服务端 queryTimeoutMs 默认 30s 但可调高），
 * 这里给一个宽松上限只兜「半开连接」，真正的中止交给运行按钮的取消（F2）。
 */
const QUERY_REQUEST_TIMEOUT_MS = 120_000;

/** 组合多个 signal：任一 abort 即中止。AbortSignal.any 不可用时退回手动监听（兼容旧内核）。 */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
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

/** 把 fetch/读 body 阶段的异常归一成 ApiError；用户主动取消仍原样抛 AbortError 供调用方静默复位。 */
function asRequestError(err: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal | undefined, timeoutMs: number): unknown {
  if (callerSignal?.aborted) return err;
  if (timeoutSignal?.aborted) {
    return new ApiError(tr("请求超时（超过 {0} 秒无响应），已中止。", [Math.round(timeoutMs / 1000)]), { code: 'REQUEST_TIMEOUT' });
  }
  if (err instanceof ApiError) return err;
  if ((err as Error)?.name === 'AbortError') return err;
  return new ApiError(tr("网络请求失败：{0}", [(err as Error)?.message ?? String(err)]), { code: 'NETWORK_ERROR' });
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
  const { signal: callerSignal, ...rest } = init;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal = combineSignals(callerSignal ?? undefined, timeoutSignal);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`/api${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...(init.headers ?? {}),
      },
      signal,
    });
    if (res.status === 204) return undefined as T;
    text = await res.text();
  } catch (err) {
    throw asRequestError(err, callerSignal ?? undefined, timeoutSignal, timeoutMs);
  }
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const err = payload?.error;
    throw new ApiError(typeof err?.message === 'string' ? err.message : tr("请求失败（{0}）", [res.status]), {
      code: err?.code,
      status: res.status,
      hint: err?.hint,
    });
  }
  return payload as T;
}

export interface BootstrapData {
  version: string;
  platform: string;
  arch?: string;
  bridgeHost: string;
  bridgePort: number;
  connections: ConnectionConfig[];
  settings: AppSettings;
  sessions: AgentSessionMeta[];
  tools: Array<{ name: string; description: string; risk: string }>;
  /** 本机缺少原生绑定、因而不可能连通的引擎（当前是 macOS Intel 的 Oracle）。 */
  unavailableEngines?: UnavailableEngine[];
  startedAt: number;
}

export interface UnavailableEngine {
  engine: string;
  code: string;
  /** 形如 darwin-x64 */
  platform: string;
  detail: string;
}

export interface SessionDetail {
  session: AgentSessionMeta;
  messages: AgentMessage[];
  toolRuns: Array<Record<string, unknown>>;
}

export interface DataPage {
  batch: QueryBatchResult;
  table: string;
  total: number;
  limit: number;
  offset: number;
  sql: string;
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

/**
 * 一段 SSE 流上「连续多少字节都没来」就算这条通道死了。
 *
 * 存在的理由：`reader.read()` 在没有字节时会永远等下去。半开的 TCP（网关被杀、
 * 笔记本休眠唤醒、代理悄悄断了）不会产生 error、也不会产生 done，于是 while 循环
 * 永远卡在这里——回合状态一直停在 streaming，界面上那颗图标就一直转，
 * 正是「莫名其妙停了、也说不出原因」里最没法查的一档。
 *
 * 阈值按服务端的心跳定：routes.ts 每 15 秒写一帧 `: ping`，而且那个定时器与回合
 * 进展无关，所以大查询、等审批、模型慢慢想——都在照常发字节。它只是「半开连接」
 * 的兜底：agent 回合在 provider 返回前可能真实静默数分钟（长思考/长工具执行，
 * 与 `PROVIDER_STALL_MS` 的 300s 对齐放宽到 10 分钟），字节暂停不代表通道死了。
 */
const TURN_IDLE_CEILING_MS = 600_000;

/** 事件级静默上限：任何帧（含 `: ping` 心跳）都算活动；服务端每 15s 一次心跳，5 分钟含义是「网还通着」。 */
export const EVENT_IDLE_MS = 300_000;

/** 带静默上限的一次读取；超时抛错，用户中止仍然原样抛 AbortError。导出只为让这条分支可测。 */
export async function readWithIdleCeiling(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  /** 只给测试用：默认值就是线上阈值，没必要让用例真等 10 分钟。 */
  idleMs = TURN_IDLE_CEILING_MS,
  /** 非回合流（command/skill/transfer）复用这套看门狗时，换一句贴合场景的文案与错误码。 */
  idle?: { code?: string; message?: string },
): Promise<Uint8Array | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Uint8Array | undefined>((resolve, reject) => {
      timer = setTimeout(() => {
        // 先取消再抛：不 cancel 的话底层连接会一直挂着，网关那边的 close 也不触发，
        // 于是它那边的回合还在跑（网关靠 close 才 abort）。
        void reader.cancel().catch(() => undefined);
        reject(
          new ApiError(idle?.message ?? tr("与服务端的连接连续 {0} 秒没有任何响应，本次回复已断开。已完成的部分仍然保留，回复「继续」可接着做。", [Math.round(idleMs / 1000)]), {
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

export async function streamTurn(sessionId: string, payload: TurnPayload, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, /** 只给测试用：默认值就是线上阈值，没必要让用例真等 5 分钟。 */ eventIdleMs = EVENT_IDLE_MS): Promise<void> {
  const res = await fetch(`/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = tr("Agent 请求失败（{0}）", [res.status]);
    let code = 'AGENT_REQUEST';
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? message;
      code = parsed?.error?.code ?? code;
    } catch {
      /* keep */
    }
    throw new ApiError(message, { code, status: res.status });
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
      throw new ApiError(
        tr("与服务端的连接连续 {0} 秒没有任何响应，本次回复已断开。已完成的部分仍然保留，回复「继续」可接着做。", [Math.round(eventIdleMs / 1000)]),
        { code: 'TURN_CHANNEL_IDLE' },
      );
    }
    // 用带上限的读取而不是裸 reader.read()：半开的连接既不报错也不结束，
    // 裸读会永远等下去，界面上就是「图标转到天荒地老」。
    const chunk = await readWithIdleCeiling(reader, signal);
    if (chunk === undefined) break;
    // 任何一帧（哪怕是只有 `: ping` 的心跳块）到达都算通道还活着，
    // 在解码/解析之前就更新活动时间，避免静默回合被误杀。
    lastActivityAt = Date.now();
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
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
        if (data) {
          try {
            onEvent(JSON.parse(data) as AgentEvent);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}

export type TransferPhase = 'create' | 'read' | 'truncate' | 'write';

export interface TransferTableResult {
  table: string;
  status: 'ok' | 'error' | 'skipped';
  rows: number;
  created: boolean;
  truncated: boolean;
  error?: string;
}

export type TransferEvent =
  | { type: 'start'; mode: 'append' | 'replace'; tables: string[] }
  | { type: 'table-start'; table: string; index: number; total: number }
  | { type: 'phase-start'; table: string; phase: TransferPhase }
  | {
      type: 'phase-done';
      table: string;
      phase: TransferPhase;
      durationMs: number;
      rows?: number;
      columns?: number;
      skippedColumns?: number;
      batches?: number;
      limitReached?: boolean;
      ddl?: string;
    }
  | { type: 'progress'; table: string; rows: number; totalRows: number }
  | {
      type: 'table-done';
      table: string;
      result: TransferTableResult;
      durationMs: number;
      columns: number;
      skippedColumns: number;
      batches: number;
      limitReached: boolean;
    }
  | { type: 'table-error'; table: string; error: string; phase: TransferPhase; durationMs: number; rows: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; result: { results: TransferTableResult[]; totalRows: number; createdTables: number }; durationMs: number };

/**
 * command/skill 执行期可能长时间没有任何事件（跑一个大脚本/等外部进程），
 * 所以只用**字节层**静默上限判半开连接，阈值放宽到 120s；不做事件层判定，
 * 免得把「这一步真的很慢」误杀成「通道死了」。
 */
const WORKER_IDLE_CEILING_MS = 120_000;

interface SseIdleOptions {
  signal?: AbortSignal;
  /** 字节层静默上限：连续这么久没有任何字节就判通道死。默认沿用回合的 10 分钟。 */
  byteIdleMs?: number;
  /** 事件层静默上限（含心跳帧）；不传则不做事件层判定。 */
  eventIdleMs?: number;
  /** 静默超时的错误码与文案，按流类型贴合场景。 */
  idleCode?: string;
  idleMessage?: string;
}

/**
 * 共享的 SSE 读取循环：复用 streamTurn 的字节/事件双层 idle 看门狗。
 * 半开的 TCP 既不报错也不结束，裸 reader.read() 会永远等下去——这里用
 * readWithIdleCeiling 兜底，超时 cancel 掉 reader 让网关收到 close。
 */
async function readSseStream(res: Response, onEvent: (event: unknown) => void, opts: SseIdleOptions = {}): Promise<void> {
  if (!res.body) throw new ApiError(tr("响应不支持流式读取"), { code: 'SSE_BODY', status: res.status });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const byteIdleMs = opts.byteIdleMs ?? TURN_IDLE_CEILING_MS;
  const idle = { code: opts.idleCode, message: opts.idleMessage };
  let buffer = '';
  let lastActivityAt = Date.now();
  while (true) {
    if (opts.eventIdleMs && Date.now() - lastActivityAt > opts.eventIdleMs) {
      void reader.cancel().catch(() => undefined);
      throw new ApiError(
        opts.idleMessage ?? tr("与服务端的连接连续 {0} 秒没有任何响应，已断开。", [Math.round(opts.eventIdleMs / 1000)]),
        { code: opts.idleCode ?? 'SSE_CHANNEL_IDLE' },
      );
    }
    const chunk = await readWithIdleCeiling(reader, opts.signal, byteIdleMs, idle);
    if (chunk === undefined) break;
    // 任何一帧（哪怕只有心跳）到达都算通道还活着，在解码/解析之前就更新活动时间。
    lastActivityAt = Date.now();
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
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
        if (data) {
          try {
            onEvent(JSON.parse(data));
          } catch {
            /* ignore malformed frame */
          }
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}

async function readSse(res: Response, onEvent: (event: unknown) => void, signal?: AbortSignal): Promise<void> {
  // transfer/pipeline 可能长时间静默地搬数据，字节层沿用回合的宽松上限兜半开连接。
  await readSseStream(res, onEvent, { signal, idleCode: 'SSE_CHANNEL_IDLE', idleMessage: tr("与服务端的连接连续 {0} 秒没有任何响应，已断开。", [Math.round(TURN_IDLE_CEILING_MS / 1000)]) });
}

export async function streamTransfer(
  body: Record<string, unknown>,
  onEvent: (event: TransferEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/transfer/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = tr("数据传输请求失败（{0}）", [res.status]);
    let code = 'TRANSFER_REQUEST';
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? message;
      code = parsed?.error?.code ?? code;
    } catch {
      /* keep */
    }
    throw new ApiError(message, { code, status: res.status });
  }
  await readSse(res, (event) => onEvent(event as TransferEvent), signal);
}

/** 数据流按步骤推进，事件里带每步行数与样本，界面据此画进度条。 */
export async function streamPipelineRun(
  pipelineId: string,
  body: Record<string, unknown>,
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = tr("数据流运行失败（{0}）", [res.status]);
    let code = 'PIPELINE_REQUEST';
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? message;
      code = parsed?.error?.code ?? code;
    } catch {
      /* keep */
    }
    throw new ApiError(message, { code, status: res.status });
  }
  await readSse(res, (event) => onEvent(event as PipelineEvent), signal);
}

export interface StoredAttachment {
  id: string;
  mime: string;
  bytes: number;
}

export async function streamCommandRun(
  runId: string,
  onEvent: (event: CommandRunEvent) => void,
  after = 0,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/commands/runs/${encodeURIComponent(runId)}/events?after=${after}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal,
  });
  if (!res.ok || !res.body) throw new ApiError(tr("命令进度读取失败（{0}）", [res.status]), { code: 'COMMAND_STREAM', status: res.status });
  await readSseStream(res, (event) => onEvent(event as CommandRunEvent), {
    signal,
    byteIdleMs: WORKER_IDLE_CEILING_MS,
    idleCode: 'COMMAND_CHANNEL_IDLE',
    idleMessage: tr("命令进度连接连续 {0} 秒没有任何响应，已断开。", [Math.round(WORKER_IDLE_CEILING_MS / 1000)]),
  });
}

export async function streamSkillRun(
  runId: string,
  onEvent: (event: SkillWorkerEvent) => void,
  after = 0,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/skills/runs/${encodeURIComponent(runId)}/events?after=${after}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal,
  });
  if (!res.ok || !res.body) throw new ApiError(tr("Skill 进度读取失败（{0}）", [res.status]), { code: 'SKILL_STREAM', status: res.status });
  await readSseStream(res, (event) => onEvent(event as SkillWorkerEvent), {
    signal,
    byteIdleMs: WORKER_IDLE_CEILING_MS,
    idleCode: 'SKILL_CHANNEL_IDLE',
    idleMessage: tr("Skill 进度连接连续 {0} 秒没有任何响应，已断开。", [Math.round(WORKER_IDLE_CEILING_MS / 1000)]),
  });
}

// objectURL 永不 revoke 会一直占着 blob 内存；长会话里图片越积越多。
// 用 LRU（Map 的插入序即访问序）限到 100 条，淘汰最久未用的那条并 revoke。
const ATTACHMENT_URL_LIMIT = 100;
const attachmentUrls = new Map<string, string>();

/** 图片走带令牌的 fetch 再转 object URL，避免把令牌暴露在 <img src> 里。 */
export async function attachmentObjectUrl(id: string): Promise<string> {
  const cached = attachmentUrls.get(id);
  if (cached) {
    // 命中即刷新到队尾，成为最近使用项。
    attachmentUrls.delete(id);
    attachmentUrls.set(id, cached);
    return cached;
  }
  const res = await fetch(`/api/agent/attachments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new ApiError(tr("图片读取失败（{0}）", [res.status]), { code: 'ATTACHMENT_ERROR', status: res.status });
  const url = URL.createObjectURL(await res.blob());
  attachmentUrls.set(id, url);
  while (attachmentUrls.size > ATTACHMENT_URL_LIMIT) {
    const oldest = attachmentUrls.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = attachmentUrls.get(oldest);
    attachmentUrls.delete(oldest);
    if (evicted) URL.revokeObjectURL(evicted);
  }
  return url;
}

export interface SkillWorkerRun {
  runId: string;
  skill: string;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  text: string;
  error?: string;
  outputs: SkillRunFile[];
  workspace?: string;
  project?: string;
  startedAt: string;
  finishedAt?: string;
}

export type SkillWorkerEvent =
  | AgentEvent
  | { type: 'skill_question'; id: string; question: string; options?: string[] }
  | { type: 'skill_answer'; id: string; answer: string }
  | { type: 'skill_artifact'; workspace: string; files: SkillRunFile[] };

export const api = {
  health: () =>
    request<{ ok: boolean; version: string; platform?: string; arch?: string; demoReady: boolean; unavailableEngines?: UnavailableEngine[] }>(
      '/health',
    ),
  bootstrap: () => request<BootstrapData>('/bootstrap'),
  tools: () => request<{ tools: any[] }>('/agent/tools'),
  capabilities: () => request<{ capabilities: Capability[] }>('/capabilities'),
  capability: (id: string) => request<{ capability: Capability }>(`/capabilities/${encodeURIComponent(id)}`),
  commands: () => request<{ commands: CommandDefinition[] }>('/commands'),
  startCommand: (id: string, input: CommandRunInput, saveAs?: { title?: string }) =>
    request<{ run: CommandRunInfo }>(`/commands/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input, saveAs }),
    }),
  commandRun: (id: string) => request<{ run: CommandRunInfo }>(`/commands/runs/${encodeURIComponent(id)}`),
  cancelCommandRun: (id: string) => request<{ ok: boolean }>(`/commands/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  artifacts: (params: { type?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.type) q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    return request<{ artifacts: ArtifactInfo[] }>(`/artifacts${q.size ? `?${q.toString()}` : ''}`);
  },
  artifact: (id: string) => request<{ artifact: ArtifactInfo }>(`/artifacts/${encodeURIComponent(id)}`),
  artifactRuns: (id: string, limit = 20) =>
    request<{ runs: ArtifactRunInfo[] }>(`/artifacts/${encodeURIComponent(id)}/runs?limit=${limit}`),
  rerunArtifact: (id: string) =>
    request<{ run: CommandRunInfo }>(`/artifacts/${encodeURIComponent(id)}/runs`, { method: 'POST', body: JSON.stringify({}) }),
  exportArtifact: (id: string, format: 'xlsx' | 'pptx') =>
    request<{ path: string; rows: number; bytes: number; format: string; downloadUrl?: string; content?: string; encoding?: string }>(`/artifacts/${encodeURIComponent(id)}/export?format=${format}`, {}, TRANSFER_REQUEST_TIMEOUT_MS),
  artifactDeck: (id: string, body: { skill?: string; template?: string; mode?: 'deterministic' | 'agent' }) =>
    request<{ run: { runId: string; skill: string; status: string } }>(`/artifacts/${encodeURIComponent(id)}/deck`, { method: 'POST', body: JSON.stringify(body) }),
  artifactSchedule: (id: string) => request<{ schedule: ArtifactScheduleInfo | null }>(`/artifacts/${encodeURIComponent(id)}/schedule`),
  executeReconRepair: (id: string, body: { confirm: string; steps?: number[] }) =>
    request<{ executed: number; failed: number; backupPath?: string; verification?: { ok: boolean; missingInRight: number; extraInRight: number; valueChanged: number } }>(`/artifacts/${encodeURIComponent(id)}/recon/execute`, { method: 'POST', body: JSON.stringify(body) }),
  executeFixPlan: (id: string, body: { confirm: string; backup: boolean; steps?: number[]; dryRun?: boolean }) =>
    request<{ backupPath?: string; executed: number; failed: number; results: any[]; verification?: { ok: boolean; summary: string; findings: number }; transaction?: 'committed' | 'rolled_back' | 'none'; dryRun?: boolean }>(`/artifacts/${encodeURIComponent(id)}/fix/execute`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  setArtifactSchedule: (id: string, body: { intervalSeconds: number; enabled?: boolean; refreshNarrative?: boolean; notifyChannels?: string[] }) =>
    request<{ schedule: ArtifactScheduleInfo }>(`/artifacts/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify(body) }),
  skills: (includeDisabled = false) => request<{ skills: SkillSummary[] }>(`/skills?includeDisabled=${includeDisabled ? 1 : 0}`),
  skill: (id: string) => request<{ skill: SkillDetail }>(`/skills/${encodeURIComponent(id)}`),
  skillFile: (id: string, path: string) => request<SkillReadResult>(`/skills/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`),
  importSkill: (body: { path?: string; zipBase64?: string; git?: string; npm?: string; ref?: string; subdir?: string; id?: string }) =>
    request<{ skill: SkillSummary }>('/skills/import', { method: 'POST', body: JSON.stringify(body) }),
  enableSkill: (id: string, enabled: boolean) =>
    request<{ skill: SkillSummary }>(`/skills/${encodeURIComponent(id)}/enable`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  deleteSkill: (id: string) => request<void>(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  skillSecrets: (id: string) => request<{ declared: string[]; set: string[] }>(`/skills/${encodeURIComponent(id)}/secrets`),
  saveSkillSecrets: (id: string, secrets: Record<string, string>) =>
    request<{ declared: string[]; set: string[] }>(`/skills/${encodeURIComponent(id)}/secrets`, { method: 'PUT', body: JSON.stringify({ secrets }) }),
  deleteSkillSecret: (id: string, name: string) =>
    request<{ declared: string[]; set: string[] }>(`/skills/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  startSkillRun: (id: string, prompt?: string) =>
    request<{ run: { runId: string; skill: string; status: string } }>(`/skills/${encodeURIComponent(id)}/runs`, { method: 'POST', body: JSON.stringify({ prompt }) }),
  skillRun: (runId: string) => request<{ run: SkillWorkerRun }>(`/skills/runs/${encodeURIComponent(runId)}`),
  answerSkillQuestion: (runId: string, questionId: string, answer: string) =>
    request<{ ok: boolean }>(`/skills/runs/${encodeURIComponent(runId)}/answers`, { method: 'POST', body: JSON.stringify({ questionId, answer }) }),
  cancelSkillRun: (runId: string) => request<{ ok: boolean }>(`/skills/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  mcpServers: () => request<{ servers: McpServerInfo[] }>('/mcp/servers'),
  createMcpServer: (body: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }) =>
    request<{ server: McpServerInfo }>('/mcp/servers', { method: 'POST', body: JSON.stringify(body) }),
  updateMcpServer: (id: string, body: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }) =>
    request<{ server: McpServerInfo }>(`/mcp/servers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMcpServer: (id: string) => request<void>(`/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  mcpTools: (id: string) => request<{ server: McpServerInfo; tools: Array<{ name: string; description?: string; inputSchema?: unknown; risk?: 'read' | 'write' | 'destructive' }> }>(`/mcp/servers/${encodeURIComponent(id)}/tools`),
  notificationChannels: () => request<{ channels: NotificationChannelInfo[] }>('/notifications/channels'),
  createNotificationChannel: (body: { name: string; type: NotificationChannelType; config: Record<string, unknown>; enabled?: boolean }) =>
    request<{ channel: NotificationChannelInfo }>('/notifications/channels', { method: 'POST', body: JSON.stringify(body) }),
  updateNotificationChannel: (id: string, body: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
    request<{ channel: NotificationChannelInfo }>(`/notifications/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteNotificationChannel: (id: string) => request<void>(`/notifications/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testNotificationChannel: (id: string) =>
    request<{ result: { ok: boolean; message: string; name: string } }>(`/notifications/channels/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  deleteArtifactSchedule: (id: string) => request<void>(`/artifacts/${encodeURIComponent(id)}/schedule`, { method: 'DELETE' }),
  deleteArtifact: (id: string) => request<void>(`/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  connections: () => request<{ connections: ConnectionConfig[] }>('/connections'),
  createConnection: (body: Record<string, unknown>) => request<{ connection: ConnectionConfig }>('/connections', { method: 'POST', body: JSON.stringify(body) }),
  updateConnection: (id: string, body: Record<string, unknown>) => request<{ connection: ConnectionConfig }>(`/connections/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteConnection: (id: string) => request<void>(`/connections/${id}`, { method: 'DELETE' }),
  testConnection: (id: string) => request<{ result: { ok: boolean; version?: string; latencyMs: number; message?: string } }>(`/connections/${id}/test`, { method: 'POST' }),
  testDraft: (body: Record<string, unknown>, signal?: AbortSignal) => request<{ result: { ok: boolean; version?: string; latencyMs: number; message?: string } }>('/connections/test', { method: 'POST', body: JSON.stringify(body), signal }),
  getSchema: (id: string, refresh = false, database?: string) =>
    request<{ schemas: DatabaseSchema[] }>(`/connections/${id}/schema?refresh=${refresh ? 1 : 0}${database ? `&database=${encodeURIComponent(database)}` : ''}`, {}, SCHEMA_REQUEST_TIMEOUT_MS),
  getTables: (id: string, database?: string) =>
    request<{ database?: string; tables: TableInfo[] }>(`/connections/${id}/tables${database ? `?database=${encodeURIComponent(database)}` : ''}`, {}, SCHEMA_REQUEST_TIMEOUT_MS),
  refreshSchema: (id: string, database?: string) => request<{ schemas: DatabaseSchema[] }>(`/connections/${id}/refresh`, { method: 'POST', body: JSON.stringify({ database }) }, SCHEMA_REQUEST_TIMEOUT_MS),
  databases: (id: string) => request<{ databases: string[] }>(`/connections/${id}/databases`),

  query: (body: { connectionId: string; sql: string; database?: string; limit?: number; allowMulti?: boolean; sessionId?: string }, signal?: AbortSignal) =>
    request<{ batch: QueryBatchResult }>('/query', { method: 'POST', body: JSON.stringify(body), signal }, QUERY_REQUEST_TIMEOUT_MS),
  beginTransaction: (body: { connectionId: string; sessionId: string; database?: string }) =>
    request<{ result: { sessionId: string; database?: string } }>('/tx/begin', { method: 'POST', body: JSON.stringify(body) }),
  commitTransaction: (body: { sessionId: string }) =>
    request<{ result: { sessionId: string; committed: boolean } }>('/tx/commit', { method: 'POST', body: JSON.stringify(body) }),
  rollbackTransaction: (body: { sessionId: string }) =>
    request<{ result: { sessionId: string; rolledBack: boolean } }>('/tx/rollback', { method: 'POST', body: JSON.stringify(body) }),
  vectorSearch: (body: {
    connectionId: string;
    database?: string;
    collection: string;
    field?: string;
    vector?: number[];
    text?: string;
    topK?: number;
  }) => request<{ result: QueryResult }>('/vector/search', { method: 'POST', body: JSON.stringify(body) }),
  redisKey: (params: { connectionId: string; database?: string; key: string }) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
    return request<{ detail: RedisKeyDetail }>(`/redis/key?${q.toString()}`);
  },
  documentGet: (params: { connectionId: string; database?: string; collection: string; id: string }) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
    return request<{ detail: { id: string; document: string } }>(`/documents/get?${q.toString()}`);
  },
  setKeyTtl: (body: { connectionId: string; database?: string; key: string; seconds: number | null }) =>
    request<{ result: { key: string; ttl: number } }>('/redis/key/ttl', { method: 'POST', body: JSON.stringify(body) }),
  createRedisKey: (body: { connectionId: string; database?: string; key: string; type: string; value: unknown; ttl?: number | null }) =>
    request<{ result: { key: string; type: string; ttl: number } }>('/redis/key/create', { method: 'POST', body: JSON.stringify(body) }),
  setRedisKeyValue: (body: { connectionId: string; database?: string; key: string; value: string }) =>
    request<{ result: { key: string; type: string; ttl: number } }>('/redis/key/value', { method: 'POST', body: JSON.stringify(body) }),
  writeLineProtocol: (body: { connectionId: string; database?: string; lines: string[] }) =>
    request<{ result: { written: number } }>('/influx/write', { method: 'POST', body: JSON.stringify(body) }),
  setHashField: (body: { connectionId: string; database?: string; key: string; field: string; value: string }) =>
    request<{ result: { key: string; field: string; created: boolean } }>('/redis/hash/field', { method: 'POST', body: JSON.stringify(body) }),
  deleteHashField: (body: { connectionId: string; database?: string; key: string; field: string }) =>
    request<{ result: { key: string; field: string; deleted: boolean; keyGone: boolean } }>('/redis/hash/field/delete', { method: 'POST', body: JSON.stringify(body) }),
  addKeyMember: (body: { connectionId: string; database?: string; key: string; member: string; score?: number }) =>
    request<{ result: { key: string; type: string; added: boolean } }>('/redis/key/member', { method: 'POST', body: JSON.stringify(body) }),
  removeKeyMember: (body: { connectionId: string; database?: string; key: string; member: string }) =>
    request<{ result: { key: string; member: string; deleted: number; keyGone: boolean } }>('/redis/key/member/delete', { method: 'POST', body: JSON.stringify(body) }),
  setListItem: (body: { connectionId: string; database?: string; key: string; index: number; value: string }) =>
    request<{ result: { key: string; index: number; value: string } }>('/redis/key/list-item', { method: 'POST', body: JSON.stringify(body) }),
  renameKey: (body: { connectionId: string; database?: string; key: string; to: string }) =>
    request<{ result: { from: string; to: string } }>('/redis/key/rename', { method: 'POST', body: JSON.stringify(body) }),
  deleteRedisKeys: (body: { connectionId: string; database?: string; keys: string[] }) =>
    request<{ result: { deleted: number } }>('/redis/keys/delete', { method: 'POST', body: JSON.stringify(body) }),
  dropRedisIndex: (body: { connectionId: string; database?: string; name: string }) =>
    request<{ result: { name: string; dropped: boolean } }>('/redis/index/drop', { method: 'POST', body: JSON.stringify(body) }),
  createObject: (body: {
    connectionId: string;
    database?: string;
    name: string;
    dimension?: number;
    distance?: string;
    fields?: Array<{ name: string; type: string }>;
    edge?: boolean;
  }) => request<{ result: { name: string; kind: string } }>('/objects/create', { method: 'POST', body: JSON.stringify(body) }),
  createIndex: (body: {
    connectionId: string;
    database?: string;
    collection: string;
    columns: string[];
    name?: string;
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    type?: string;
  }) => request<{ result: { name: string; created: boolean } }>('/indexes/create', { method: 'POST', body: JSON.stringify(body) }),
  dropIndex: (body: { connectionId: string; database?: string; collection: string; name: string }) =>
    request<{ result: { name: string; dropped: boolean } }>('/indexes/drop', { method: 'POST', body: JSON.stringify(body) }),
  createField: (body: { connectionId: string; database?: string; object: string; name: string; type: string }) =>
    request<{ result: { name: string; type: string; added: boolean } }>('/fields/create', { method: 'POST', body: JSON.stringify(body) }),
  dropObject: (body: { connectionId: string; database?: string; name: string }) =>
    request<{ result: { name: string; dropped: boolean } }>('/objects/drop', { method: 'POST', body: JSON.stringify(body) }),
  upsertDocuments: (body: { connectionId: string; database?: string; collection: string; documents: Record<string, unknown>[] }) =>
    request<{ result: { ids: string[]; upserted: number } }>('/documents/upsert', { method: 'POST', body: JSON.stringify(body) }),
  deleteDocuments: (body: { connectionId: string; database?: string; collection: string; ids: string[] }) =>
    request<{ result: { deleted: number } }>('/documents/delete', { method: 'POST', body: JSON.stringify(body) }),
  importDocuments: (body: {
    connectionId: string;
    database?: string;
    collection: string;
    csv?: string;
    path?: string;
    hasHeader?: boolean;
    delimiter?: string;
    idColumn?: string;
    vectorColumn?: string;
  }) =>
    request<{ result: { imported: number; skipped: number; errors: string[]; collection: string } }>('/documents/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }, TRANSFER_REQUEST_TIMEOUT_MS),
  dashboardCards: (params: { connectionId: string; database?: string }) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
    return request<{ supported: boolean; limit: number; cards: DashboardCard[] }>(`/dashboards/cards?${q.toString()}`);
  },
  dashboardSaveCard: (body: {
    id?: string;
    connectionId: string;
    database?: string;
    title: string;
    sql: string;
    chartType: DashboardChartType;
    x?: string;
    y?: string;
    timeColumn?: string;
    span?: 1 | 2;
    pinned?: boolean;
    source?: DashboardCardSource;
  }) => request<{ card: DashboardCard; cards: DashboardCard[] }>('/dashboards/cards', { method: 'POST', body: JSON.stringify(body) }),
  dashboardDeleteCard: (id: string) =>
    request<{ cards: DashboardCard[] }>(`/dashboards/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  dashboardCompose: (body: { connectionId: string; database?: string; prompt: string }) =>
    request<DashboardComposeResult>('/dashboards/compose', { method: 'POST', body: JSON.stringify(body) }),
  dashboardPreview: (body: { connectionId: string; database?: string; sql: string }) =>
    request<{ preview: DashboardPreview }>('/dashboards/preview', { method: 'POST', body: JSON.stringify(body) }),
  dashboardReorderCards: (ids: string[]) =>
    request<{ cards: DashboardCard[] }>('/dashboards/cards/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  dashboardRefresh: (body: { connectionId: string; database?: string; cardIds?: string[]; range?: DashboardTimeRange }) =>
    request<{ results: DashboardCardResult[]; cards: DashboardCard[] }>('/dashboards/refresh', { method: 'POST', body: JSON.stringify(body) }),
  dashboardDiscardDrafts: (body: { connectionId: string; database?: string }) =>
    request<{ discarded: number; cards: DashboardCard[] }>('/dashboards/drafts', { method: 'DELETE', body: JSON.stringify(body) }),
  dashboardGenerate: (body: { connectionId: string; database?: string; limit?: number }) =>
    request<{ created: number; usedModel: boolean; notes: string[]; cards: DashboardCard[] }>('/dashboards/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  dashboardSchedule: (params: { connectionId: string; database?: string }) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
    return request<{ schedule: DashboardScheduleInfo | null }>(`/dashboards/schedule?${q.toString()}`);
  },
  dashboardSetSchedule: (body: { connectionId: string; database?: string; intervalSeconds: number; notifyChannels?: string[] }) =>
    request<{ schedule: DashboardScheduleInfo | null }>('/dashboards/schedule', { method: 'PUT', body: JSON.stringify(body) }),
  dashboardReport: (body: { connectionId: string; database?: string }) =>
    request<{ artifact: ArtifactInfo }>('/dashboards/report', { method: 'POST', body: JSON.stringify(body) }),
  data: (params: { connectionId: string; table: string; database?: string; limit?: number; offset?: number; orderBy?: string; orderDir?: string; where?: string }) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
    return request<DataPage>(`/data?${q.toString()}`);
  },
  rows: (body: Record<string, unknown>) => request<{ result: QueryResult }>('/rows', { method: 'POST', body: JSON.stringify(body) }, QUERY_REQUEST_TIMEOUT_MS),
  tableOps: (body: Record<string, unknown>) =>
    request<{ statements: string[]; ddl?: string; batch?: QueryBatchResult; supported?: boolean; message?: string }>('/tables/ops', {
      method: 'POST',
      body: JSON.stringify(body),
    }, QUERY_REQUEST_TIMEOUT_MS),
  databaseOps: (body: Record<string, unknown>) =>
    request<{ supported: boolean; statements: string[]; message?: string }>('/databases/ops', {
      method: 'POST',
      body: JSON.stringify(body),
    }, QUERY_REQUEST_TIMEOUT_MS),
  replaceData: (body: Record<string, unknown>) =>
    request<{ affected: number; sql: string; preview: boolean }>('/data/replace', { method: 'POST', body: JSON.stringify(body) }, QUERY_REQUEST_TIMEOUT_MS),
  ddlPreview: (body: Record<string, unknown>) => request<{ statements: string[]; ddl?: string }>('/ddl/preview', { method: 'POST', body: JSON.stringify(body) }),
  ddlExecute: (body: Record<string, unknown>) => request<{ batch: QueryBatchResult }>('/ddl/execute', { method: 'POST', body: JSON.stringify(body) }, QUERY_REQUEST_TIMEOUT_MS),
  // K5：服务端 inline 导出新形态返回 downloadUrl（GET /api/export/file?path=…）；
  // 旧形态仍可能带 base64 content。两种都兼容，调用方优先用 downloadUrl。
  exportData: (body: Record<string, unknown>, signal?: AbortSignal) =>
    request<{ file: { path: string; bytes: number; rows: number }; format: string; downloadUrl?: string; content?: string; encoding?: string }>('/export', { method: 'POST', body: JSON.stringify(body), signal }, TRANSFER_REQUEST_TIMEOUT_MS),
  importCsv: (body: Record<string, unknown>) =>
    request<{ result: { inserted: number; skipped: number; errors: string[]; columns: string[] } }>('/import', { method: 'POST', body: JSON.stringify(body) }, TRANSFER_REQUEST_TIMEOUT_MS),
  history: (params: { connectionId?: string; search?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
    return request<{ items: Array<{ id: string; sql: string; status: string; durationMs?: number; rowCount?: number; error?: string; favorite?: boolean; createdAt: string }> }>(`/history?${q.toString()}`);
  },
  renameGroup: (from: string, to: string) => request<{ renamed: number }>(`/groups/rename`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  deleteGroup: (name: string) => request<{ moved: number }>(`/groups/delete`, { method: 'POST', body: JSON.stringify({ name }) }),
  favoriteHistory: (id: string, favorite: boolean) => request<{ id: string; favorite: boolean }>(`/history/${id}/favorite`, { method: 'POST', body: JSON.stringify({ favorite }) }),
  clearHistory: () => request<void>('/history', { method: 'DELETE' }),
  backups: (connectionId?: string) => request<{ backups: BackupInfo[] }>(`/backups${connectionId ? `?connectionId=${connectionId}` : ''}`),
  createBackup: (body: { connectionId: string; database?: string; label?: string }) => request<{ backup: BackupInfo }>('/backups', { method: 'POST', body: JSON.stringify(body) }, BACKUP_REQUEST_TIMEOUT_MS),
  audit: (params: { limit?: number; connectionId?: string; actor?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value));
    return request<{ entries: AuditEntry[] }>(`/audit?${q.toString()}`);
  },

  // 不传参数时 URL 与旧实现完全一致；带参数才追加 query
  sessions: (opts: { connectionId?: string; database?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.connectionId) qs.set('connectionId', opts.connectionId);
    if (opts.database) qs.set('database', opts.database);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ sessions: AgentSessionMeta[] }>(`/agent/sessions${suffix}`);
  },
  createSession: (body: { connectionId?: string; database?: string; title?: string; permissionMode?: string }) =>
    request<{ session: AgentSessionMeta }>('/agent/sessions', { method: 'POST', body: JSON.stringify(body) }),
  getSession: (id: string) => request<SessionDetail>(`/agent/sessions/${id}`),
  updateSession: (id: string, body: Record<string, unknown>) => request<{ session: AgentSessionMeta }>(`/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSession: (id: string) => request<void>(`/agent/sessions/${id}`, { method: 'DELETE' }),
  abort: (id: string) => request<{ ok: boolean }>(`/agent/sessions/${id}/abort`, { method: 'POST' }),
  approve: (approvalId: string, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') =>
    request<{ ok: boolean }>(`/agent/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ decision, scope }) }),

  memories: (params: { q?: string; kind?: string; includeArchived?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.q) q.set('q', params.q);
    if (params.kind) q.set('kind', params.kind);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.includeArchived) q.set('includeArchived', '1');
    return request<{ memories: Memory[] }>(`/agent/memories?${q.toString()}`);
  },
  createMemory: (body: Record<string, unknown>) => request<{ memory: Memory; merged: boolean }>('/agent/memories', { method: 'POST', body: JSON.stringify(body) }),
  updateMemory: (id: string, body: Record<string, unknown>) => request<{ memory: Memory }>(`/agent/memories/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMemory: (id: string) => request<void>(`/agent/memories/${id}`, { method: 'DELETE' }),
  /** 图表一键解读/预测：不经过模型，执行器权威统计；失败时 ApiError.message 即人话原因。 */
  chartInsight: (body: { connectionId: string; database?: string; sql: string; x?: string; y?: string; mode: 'analyze' | 'forecast'; periods?: number; method?: 'linear' | 'moving_average' | 'auto' }) =>
    request<{ result: ToolResult }>('/agent/chart-insight', { method: 'POST', body: JSON.stringify(body) }),

  agentContext: (connectionId: string, database?: string) =>
    request<{ entries: AgentContextEntry[]; bundle: AgentContextBundle; active: boolean }>(
      `/agent/context?connectionId=${encodeURIComponent(connectionId)}${database ? `&database=${encodeURIComponent(database)}` : ''}`,
    ),
  putContextEntry: (body: {
    connectionId: string;
    database?: string;
    kind: 'table' | 'column';
    table: string;
    column?: string;
    enabled?: boolean;
    alias?: string | null;
    description?: string | null;
  }) => request<{ entry: AgentContextEntry }>('/agent/context/entry', { method: 'PUT', body: JSON.stringify(body) }),
  putContextRelation: (body: {
    connectionId: string;
    database?: string;
    table: string;
    column: string;
    refTable: string;
    refColumn: string;
    description?: string | null;
  }) => request<{ entry: AgentContextEntry }>('/agent/context/relation', { method: 'PUT', body: JSON.stringify(body) }),
  bulkContextTables: (body: { connectionId: string; database?: string; tables: string[]; enabled: boolean }) =>
    request<{ touched: number }>('/agent/context/bulk', { method: 'POST', body: JSON.stringify(body) }),
  deleteContextEntry: (id: string) => request<void>(`/agent/context/entry/${id}`, { method: 'DELETE' }),
  suggest: (params: { connectionId: string; database?: string; limit?: number; locale?: string; sessionId?: string; exclude?: string[] }) => {
    const q = new URLSearchParams({ connectionId: params.connectionId });
    if (params.database) q.set('database', params.database);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.sessionId) q.set('sessionId', params.sessionId);
    for (const p of params.exclude ?? []) q.append('exclude', p);
    q.set('locale', params.locale ?? 'en');
    return request<{ suggestions: QuestionSuggestion[] }>(`/agent/suggest?${q.toString()}`);
  },
  clearAgentContext: (connectionId: string, database?: string) =>
    request<{ removed: number }>(
      `/agent/context?connectionId=${encodeURIComponent(connectionId)}${database ? `&database=${encodeURIComponent(database)}` : ''}`,
      { method: 'DELETE' },
    ),

  updateSettings: (body: Record<string, unknown>) => request<{ settings: AppSettings }>('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  searchBackends: () => request<{ backends: Array<{ id: string; label: string; needsKey: boolean; group: 'free' | 'key' }>; health: Array<{ id: string; status: string; lastMs?: number; lastAt?: string; lastError?: string; successes: number; failures: number }>; keyStatus: Record<string, boolean> }>('/search/backends'),
  searchQuery: (body: { query: string; numResults?: number }) => request<{ query: string; results: Array<{ title: string; url: string; snippet: string; source: string; publishedAt?: string; score?: number; sources?: string[] }>; backends: Array<{ id: string; ok: boolean; count: number; ms: number; error?: string }>; total: number; deduped: number }>('/search/query', { method: 'POST', body: JSON.stringify(body) }),
  probeSearchBackend: (id: string) => request<{ health: { id: string; status: string; lastMs?: number; lastAt?: string; lastError?: string; successes: number; failures: number } }>(`/search/backends/${encodeURIComponent(id)}/probe`, { method: 'POST', body: JSON.stringify({}) }),
  resetSearchHealth: () => request<{ health: Array<{ id: string; status: string; lastMs?: number; lastAt?: string; lastError?: string; successes: number; failures: number }> }>('/search/backends/reset', { method: 'POST', body: JSON.stringify({}) }),
  searchDatabase: (body: { connectionId: string; database?: string; query: string; scope?: 'objects' | 'data' | 'all' }) =>
    request<any>('/search', { method: 'POST', body: JSON.stringify(body) }),
  compareSchemas: (body: { sourceId: string; sourceDatabase?: string; targetId: string; targetDatabase?: string }) =>
    request<{ diff: any }>('/schema/compare', { method: 'POST', body: JSON.stringify(body) }),
  syncSchema: (body: { connectionId: string; database?: string; statements: string[] }) =>
    request<{ batch: QueryBatchResult }>('/schema/sync', { method: 'POST', body: JSON.stringify(body) }, QUERY_REQUEST_TIMEOUT_MS),
  transfer: (body: Record<string, unknown>) => request<{ result: any }>('/transfer', { method: 'POST', body: JSON.stringify(body) }),
  generateData: (body: Record<string, unknown>) => request<{ result: any }>('/generate', { method: 'POST', body: JSON.stringify(body) }),
  monitor: (connectionId: string) => request<{ monitor: any }>(`/monitor?connectionId=${encodeURIComponent(connectionId)}`),
  killSession: (body: { connectionId: string; sessionId: string }) => request<{ result: any }>('/monitor/kill', { method: 'POST', body: JSON.stringify(body) }),
  users: (connectionId: string) => request<any>(`/users?connectionId=${encodeURIComponent(connectionId)}`),
  userAction: (body: Record<string, unknown>) => request<{ result: any }>('/users/action', { method: 'POST', body: JSON.stringify(body) }),
  objects: (connectionId: string, database?: string) =>
    request<{ objects: any }>(`/objects?connectionId=${encodeURIComponent(connectionId)}${database ? `&database=${encodeURIComponent(database)}` : ''}`),
  tableOptions: (connectionId: string, table: string, database?: string) =>
    request<{ supported: boolean; options: Array<{ label: string; value: string }>; note?: string }>(
      `/table-options?connectionId=${encodeURIComponent(connectionId)}&table=${encodeURIComponent(table)}${database ? `&database=${encodeURIComponent(database)}` : ''}`,
    ),
  agentModels: (body: { kind: string; baseUrl: string; apiKey?: string; modelConfigId?: string }) =>
    request<{ models: string[]; infos: ModelInfo[]; endpoint: string }>('/agent/models', { method: 'POST', body: JSON.stringify(body) }),
  uploadAttachment: (body: { mime: string; base64: string }) =>
    request<{ attachment: StoredAttachment }>('/agent/attachments', { method: 'POST', body: JSON.stringify(body) }),
  compareData: (body: { sourceId: string; sourceDatabase?: string; targetId: string; targetDatabase?: string; tables?: string[] }) =>
    request<{ result: any }>('/data/compare', { method: 'POST', body: JSON.stringify(body) }),
  snippets: () => request<{ snippets: any[] }>('/snippets'),
  createSnippet: (body: { name: string; sql: string; tags?: string[] }) => request<{ snippet: any }>('/snippets', { method: 'POST', body: JSON.stringify(body) }),
  deleteSnippet: (id: string) => request<void>(`/snippets/${id}`, { method: 'DELETE' }),
  dictionary: (connectionId: string, database?: string) =>
    request<{ dictionary: any }>(`/dictionary?connectionId=${encodeURIComponent(connectionId)}${database ? `&database=${encodeURIComponent(database)}` : ''}`),
  jobs: () => request<{ jobs: any[] }>('/jobs'),
  createJob: (body: Record<string, unknown>) => request<{ job: any }>('/jobs', { method: 'POST', body: JSON.stringify(body) }),
  updateJob: (id: string, body: Record<string, unknown>) => request<{ job: any }>(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteJob: (id: string) => request<void>(`/jobs/${id}`, { method: 'DELETE' }),
  runJob: (id: string) => request<{ ok: boolean; message: string }>(`/jobs/${id}/run`, { method: 'POST' }),
  // 数据流处理
  pipelines: () => request<{ pipelines: PipelineInfo[] }>('/pipelines'),
  pipelineMeta: () => request<{ steps: unknown[]; python: { ok: boolean; version?: string }; enabled: boolean; scriptsEnabled: boolean }>('/pipelines/meta'),
  createPipeline: (body: { name: string; description?: string; connectionId?: string; database?: string; spec: PipelineSpec }) =>
    request<{ pipeline: PipelineInfo }>('/pipelines', { method: 'POST', body: JSON.stringify(body) }),
  updatePipeline: (id: string, body: Record<string, unknown>) => request<{ pipeline: PipelineInfo }>(`/pipelines/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deletePipeline: (id: string) => request<void>(`/pipelines/${id}`, { method: 'DELETE' }),
  pipelineRuns: (id: string, limit = 20) => request<{ runs: PipelineRunInfo[] }>(`/pipelines/${id}/runs?limit=${limit}`),
  runPipeline: (id: string, body: Record<string, unknown> = {}) => request<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify(body) }),
  trialPipeline: (id: string, body: Record<string, unknown> = {}) => request<{ run: PipelineRunInfo }>(`/pipelines/${id}/trial`, { method: 'POST', body: JSON.stringify(body) }),
  cancelPipeline: (id: string) => request<{ ok: boolean }>(`/pipelines/${id}/cancel`, { method: 'POST' }),
  resetPipelineState: (id: string) => request<{ pipeline: PipelineInfo }>(`/pipelines/${id}/state/reset`, { method: 'POST' }),
  pipelineCredentials: () => request<{ credentials: PipelineCredentialInfo[] }>('/pipelines/credentials'),
  createPipelineCredential: (body: Record<string, unknown>) => request<{ credential: PipelineCredentialInfo }>('/pipelines/credentials', { method: 'POST', body: JSON.stringify(body) }),
  deletePipelineCredential: (id: string) => request<void>(`/pipelines/credentials/${id}`, { method: 'DELETE' }),
  restoreBackup: (id: string) => request<{ batch: QueryBatchResult }>(`/backups/${id}/restore`, { method: 'POST' }, BACKUP_REQUEST_TIMEOUT_MS),

  pairStart: () => request<{ code: string; expiresIn: number; qrPayload: string; host: string; port: number; url: string }>('/pair/start', { method: 'POST' }),
  pairMcpStart: () => request<{ code: string; expiresIn: number; host: string; port: number; url: string }>('/pair/mcp/start', { method: 'POST' }),
  devices: () => request<{ devices: DeviceInfo[] }>('/devices'),
  revokeDevice: (id: string) => request<void>(`/devices/${id}`, { method: 'DELETE' }),
};
