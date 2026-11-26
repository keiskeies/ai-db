import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentEvent, NotificationChannelInfo } from '@aidb/core';
import type { AgentHost } from './agentHost';
import type { Store } from './store';
import { EgressError, safeFetch } from './egress';

interface BotConfig {
  inbound?: boolean;
  apiBase?: string;
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  endpoint?: string;
  token?: string;
  allowedChats?: string[];
  connectionId?: string;
  database?: string;
}

interface BotEventResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const busyChats = new Set<string>();
const EVENT_WINDOW_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;
const GLOBAL_RATE_LIMIT = 60;
const CHANNEL_RATE_LIMIT = 20;
const MAX_TRACKED_EVENTS = 10_000;
const seenEvents = new Map<string, number>();
let globalWindow = 0;
let globalCount = 0;
const channelWindows = new Map<string, { start: number; count: number }>();

function consumeRateLimit(channelId: string, now: number): number | undefined {
  if (now - globalWindow >= RATE_WINDOW_MS) {
    globalWindow = now;
    globalCount = 0;
  }
  globalCount += 1;
  const channel = channelWindows.get(channelId);
  const channelCount = !channel || now - channel.start >= RATE_WINDOW_MS ? 1 : channel.count + 1;
  channelWindows.set(channelId, { start: !channel || now - channel.start >= RATE_WINDOW_MS ? now : channel.start, count: channelCount });
  if (globalCount > GLOBAL_RATE_LIMIT) return Math.ceil((globalWindow + RATE_WINDOW_MS - now) / 1000);
  if (channelCount > CHANNEL_RATE_LIMIT) return Math.ceil((channelWindows.get(channelId)!.start + RATE_WINDOW_MS - now) / 1000);
  return undefined;
}

function eventKey(channelId: string, eventId: string): string {
  return `${channelId}:${createHash('sha256').update(eventId).digest('hex')}`;
}

function markEventOnce(key: string, timestampMs: number, now: number): 'fresh' | 'duplicate' | 'stale' {
  if (Math.abs(now - timestampMs) > EVENT_WINDOW_MS) return 'stale';
  if (seenEvents.has(key)) return 'duplicate';
  if (seenEvents.size >= MAX_TRACKED_EVENTS) {
    for (const [existing, seenAt] of seenEvents) {
      if (now - seenAt > EVENT_WINDOW_MS) seenEvents.delete(existing);
    }
    if (seenEvents.size >= MAX_TRACKED_EVENTS) seenEvents.delete(seenEvents.keys().next().value!);
  }
  seenEvents.set(key, now);
  return 'fresh';
}

function configOf(store: Store, channel: NotificationChannelInfo): BotConfig {
  return (store.getNotificationChannelConfig<BotConfig>(channel.id) ?? {}) as BotConfig;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, { timeoutMs: 15_000, maxBytes: 1024 * 1024 });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) throw new EgressError(`机器人服务返回 HTTP ${response.status}`, 'EGRESS_NETWORK');
  return payload;
}

async function replyFeishu(config: BotConfig, chatId: string, text: string): Promise<void> {
  const base = (config.apiBase || 'https://open.feishu.cn').replace(/\/+$/, '');
  const tokenPayload = await postJson(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    app_id: config.appId,
    app_secret: config.appSecret,
  });
  const token = tokenPayload?.tenant_access_token;
  if (!token) throw new Error('飞书 tenant token 获取失败');
  await postJson(
    `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
    { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: text.slice(0, 1800) }) },
    { authorization: `Bearer ${token}` },
  );
}

async function replyOneBot(config: BotConfig, target: { type: 'group' | 'private'; id: string }, text: string): Promise<void> {
  const endpoint = String(config.endpoint ?? '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('OneBot endpoint 未配置');
  const action = target.type === 'private' ? 'send_private_msg' : 'send_group_msg';
  const body = target.type === 'private' ? { user_id: Number(target.id) || target.id, message: text.slice(0, 1800) } : { group_id: Number(target.id) || target.id, message: text.slice(0, 1800) };
  await postJson(`${endpoint}/${action}`, body, config.token ? { authorization: `Bearer ${config.token}` } : {});
}

function configuredToken(config: BotConfig, key: 'token' | 'verificationToken'): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function tokenMatches(config: BotConfig, key: 'token' | 'verificationToken', supplied: unknown): boolean {
  const expected = configuredToken(config, key);
  if (expected === undefined || typeof supplied !== 'string') return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function allowed(config: BotConfig, chatKey: string): boolean {
  // 空白项没有语义；清洗后为空必须拒绝所有会话，不能退化成“允许所有”。
  const list = Array.isArray(config.allowedChats)
    ? config.allowedChats.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return list.includes(chatKey);
}

async function askAndReply(
  store: Store,
  host: AgentHost,
  channel: NotificationChannelInfo,
  config: BotConfig,
  chatKey: string,
  text: string,
  reply: (answer: string) => Promise<void>,
): Promise<void> {
  const busyKey = `${channel.id}:${chatKey}`;
  if (busyChats.has(busyKey)) {
    await reply('上一条问题还在处理中，请稍后再问。').catch(() => undefined);
    return;
  }
  busyChats.add(busyKey);
  const started = Date.now();
  try {
    if (!config.connectionId) {
      await reply('机器人还没有绑定数据库连接，请在 AiDB 通知渠道里配置 connectionId。').catch(() => undefined);
      return;
    }
    if (!store.getConnection(config.connectionId)) {
      await reply('机器人绑定的数据库连接不存在，请在 AiDB 中检查配置。').catch(() => undefined);
      return;
    }
    const session = store.createSession({
      connectionId: config.connectionId,
      database: config.database,
      title: `Bot · ${channel.name} · ${chatKey}`,
      permissionMode: 'readonly',
    });
    let answer = '';
    await host.startTurn(
      session.id,
      { text, mode: 'readonly', connectionId: config.connectionId, database: config.database, disableMcp: true },
      (event: AgentEvent) => {
        if (event.type === 'text_delta') answer += event.text;
      },
    );
    const final = answer.trim() || '没有生成回答。';
    await reply(final);
    store.addAudit({
      actor: 'agent',
      connectionId: config.connectionId,
      database: config.database,
      tool: 'bot.message',
      risk: 'read',
      approval: 'none',
      status: 'ok',
      durationMs: Date.now() - started,
      meta: { channelId: channel.id, chatKey, sessionId: session.id },
    });
  } catch (err: any) {
    await reply('AiDB 处理失败，请稍后重试或联系管理员。').catch(() => undefined);
    store.addAudit({
      actor: 'agent',
      connectionId: config.connectionId,
      tool: 'bot.message',
      risk: 'read',
      approval: 'none',
      status: 'error',
      durationMs: Date.now() - started,
      meta: { channelId: channel.id, chatKey, errorType: err instanceof Error ? err.name : 'UnknownError' },
    });
  } finally {
    busyChats.delete(busyKey);
  }
}

export async function handleBotEvent(
  store: Store,
  host: AgentHost,
  channelId: string,
  body: any,
  headers: Record<string, string | string[] | undefined>,
): Promise<BotEventResponse> {
  const channel = store.getNotificationChannel(channelId);
  if (!channel || !channel.enabled) return { status: 404, body: { error: 'channel not found' } };
  const retryAfter = consumeRateLimit(channelId, Date.now());
  if (retryAfter !== undefined) return { status: 429, body: { error: 'rate limit exceeded' }, headers: { 'retry-after': String(retryAfter) } };
  const config = configOf(store, channel);
  if (channel.type === 'feishu') {
    if (!configuredToken(config, 'verificationToken')) return { status: 503, body: { error: 'bot verification token is not configured' } };
    if (body?.type === 'url_verification') {
      if (!tokenMatches(config, 'verificationToken', body.token)) return { status: 403, body: { error: 'invalid token' } };
      return { status: 200, body: { challenge: body.challenge } };
    }
    if (body?.encrypt) return { status: 400, body: { error: 'encrypted events are not supported yet' } };
    const token = body?.header?.token ?? body?.token;
    if (!tokenMatches(config, 'verificationToken', token)) return { status: 403, body: { error: 'invalid token' } };
    if (body?.header?.event_type !== 'im.message.receive_v1') return { status: 200, body: { code: 0 } };
    const eventId = String(body?.header?.event_id ?? '').trim();
    const timestamp = Number(body?.header?.create_time);
    if (!eventId || eventId.length > 256 || !Number.isFinite(timestamp) || timestamp <= 0) {
      return { status: 400, body: { error: 'missing or invalid event metadata' } };
    }
    const freshness = markEventOnce(eventKey(channel.id, `feishu:${eventId}`), timestamp, Date.now());
    if (freshness === 'stale') return { status: 400, body: { error: 'event outside accepted time window' } };
    if (freshness === 'duplicate') return { status: 200, body: { code: 0 } };
    const event = body?.event;
    if (event?.sender?.sender_type === 'app' || event?.sender?.sender_type === 'bot') return { status: 200, body: { code: 0 } };
    const chatId = String(event?.message?.chat_id ?? '');
    const messageType = String(event?.message?.message_type ?? '');
    if (!chatId || messageType !== 'text') return { status: 200, body: { code: 0 } };
    let text = '';
    try {
      text = String(JSON.parse(String(event?.message?.content ?? '{}')).text ?? '');
    } catch {
      text = '';
    }
    text = text.replace(/@_user_\d+/g, '').trim();
    if (!text) return { status: 200, body: { code: 0 } };
    if (!config.inbound) return { status: 403, body: { error: 'inbound is disabled for this channel' } };
    if (!allowed(config, chatId)) {
      void replyFeishu(config, chatId, '该群未在 AiDB 机器人白名单中。').catch(() => undefined);
      return { status: 200, body: { code: 0 } };
    }
    void askAndReply(store, host, channel, config, chatId, text, (answer) => replyFeishu(config, chatId, answer));
    return { status: 200, body: { code: 0 } };
  }

  if (channel.type === 'qq-onebot') {
    const authorization = String(headers.authorization ?? '');
    if (!authorization.startsWith('Bearer ') || !tokenMatches(config, 'token', authorization.slice(7))) return { status: 403, body: { error: 'invalid bot token' } };
    if (body?.post_type !== 'message') return { status: 200, body: { status: 'ok', retcode: 0 } };
    const selfId = String(body?.self_id ?? '');
    const senderId = String(body?.sender?.user_id ?? body?.user_id ?? '');
    if (selfId && senderId === selfId) return { status: 200, body: { status: 'ok', retcode: 0 } };
    const eventId = String(body?.message_id ?? body?.event_id ?? '').trim();
    const rawTimestamp = Number(body?.time);
    const timestamp = rawTimestamp > 1_000_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
    if (!eventId || eventId.length > 256 || !Number.isFinite(rawTimestamp) || rawTimestamp <= 0 || !Number.isFinite(timestamp)) {
      return { status: 400, body: { error: 'missing or invalid event metadata' } };
    }
    const freshness = markEventOnce(eventKey(channel.id, `onebot:${eventId}`), timestamp, Date.now());
    if (freshness === 'stale') return { status: 400, body: { error: 'event outside accepted time window' } };
    if (freshness === 'duplicate') return { status: 200, body: { status: 'ok', retcode: 0 } };
    const messageType = body?.message_type === 'private' ? 'private' : 'group';
    const chatId = String(messageType === 'private' ? body?.user_id ?? senderId : body?.group_id ?? '');
    const text = String(body?.raw_message ?? body?.message ?? '').trim();
    if (!chatId || !text) return { status: 200, body: { status: 'ok', retcode: 0 } };
    if (!config.inbound) return { status: 403, body: { error: 'inbound is disabled for this channel' } };
    const chatKey = `${messageType}:${chatId}`;
    if (!allowed(config, chatKey) && !allowed(config, chatId)) {
      void replyOneBot(config, { type: messageType, id: chatId }, '该会话未在 AiDB 机器人白名单中。').catch(() => undefined);
      return { status: 200, body: { status: 'ok', retcode: 0 } };
    }
    void askAndReply(store, host, channel, config, chatKey, text, (answer) => replyOneBot(config, { type: messageType, id: chatId }, answer));
    return { status: 200, body: { status: 'ok', retcode: 0 } };
  }

  // 企业微信自助机器人 webhook 只支持 outbound；inbound 需要企业应用回调，暂未开放。
  void headers;
  return { status: 400, body: { error: 'inbound is not supported for this channel type' } };
}
