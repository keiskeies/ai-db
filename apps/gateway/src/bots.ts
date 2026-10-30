import type { AgentEvent, NotificationChannelInfo } from '@aidb/core';
import type { AgentHost } from './agentHost';
import type { Store } from './store';

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
}

const busyChats = new Set<string>();

function configOf(store: Store, channel: NotificationChannelInfo): BotConfig {
  return (store.getNotificationChannelConfig<BotConfig>(channel.id) ?? {}) as BotConfig;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof payload === 'string' ? payload.slice(0, 180) : JSON.stringify(payload).slice(0, 180)}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function replyFeishu(config: BotConfig, chatId: string, text: string): Promise<void> {
  const base = (config.apiBase || 'https://open.feishu.cn').replace(/\/+$/, '');
  const tokenPayload = await postJson(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    app_id: config.appId,
    app_secret: config.appSecret,
  });
  const token = tokenPayload?.tenant_access_token;
  if (!token) throw new Error(`飞书 tenant token 获取失败：${tokenPayload?.msg ?? 'unknown'}`);
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

function allowed(config: BotConfig, chatKey: string): boolean {
  const list = Array.isArray(config.allowedChats) ? config.allowedChats.map(String) : [];
  return !list.length || list.includes(chatKey);
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
      { text, mode: 'readonly', connectionId: config.connectionId, database: config.database },
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
    await reply(`AiDB 处理失败：${String(err?.message ?? err).slice(0, 300)}`).catch(() => undefined);
    store.addAudit({
      actor: 'agent',
      connectionId: config.connectionId,
      tool: 'bot.message',
      risk: 'read',
      approval: 'none',
      status: 'error',
      durationMs: Date.now() - started,
      meta: { channelId: channel.id, chatKey, error: err?.message },
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
  const config = configOf(store, channel);
  if (channel.type === 'feishu') {
    if (body?.type === 'url_verification') {
      if (config.verificationToken && body.token !== config.verificationToken) return { status: 403, body: { error: 'invalid token' } };
      return { status: 200, body: { challenge: body.challenge } };
    }
    if (body?.encrypt) return { status: 400, body: { error: 'encrypted events are not supported yet' } };
    const token = body?.header?.token ?? body?.token;
    if (config.verificationToken && token !== config.verificationToken) return { status: 403, body: { error: 'invalid token' } };
    if (body?.header?.event_type !== 'im.message.receive_v1') return { status: 200, body: { code: 0 } };
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
    if (config.token && authorization !== `Bearer ${config.token}`) return { status: 403, body: { error: 'invalid bot token' } };
    if (body?.post_type !== 'message') return { status: 200, body: { status: 'ok', retcode: 0 } };
    const selfId = String(body?.self_id ?? '');
    const senderId = String(body?.sender?.user_id ?? body?.user_id ?? '');
    if (selfId && senderId === selfId) return { status: 200, body: { status: 'ok', retcode: 0 } };
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
