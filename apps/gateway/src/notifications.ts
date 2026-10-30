import { createHmac } from 'node:crypto';
import type { ArtifactInfo, NotificationChannelType } from '@aidb/core';
import type { Store } from './store';

export type NotificationConfig =
  | { webhookUrl: string; secret?: string }
  | { endpoint: string; token?: string; targetType: 'group' | 'private'; targetId: string };

export interface NotificationSendResult {
  channelId: string;
  name: string;
  ok: boolean;
  message: string;
}

function requireHttp(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error(`${label} 不是合法 URL`), { code: 'INVALID_NOTIFICATION_CONFIG', status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error(`${label} 必须是 http(s) URL`), { code: 'INVALID_NOTIFICATION_CONFIG', status: 400 });
  }
  return parsed.toString();
}

export function validateNotificationChannel(type: NotificationChannelType, config: Record<string, unknown>): void {
  if (type === 'telegram') {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(String(config.botToken ?? '').trim())) {
      throw Object.assign(new Error('Telegram botToken 格式不正确'), { code: 'INVALID_NOTIFICATION_CONFIG', status: 400 });
    }
    if (!String(config.chatId ?? '').trim()) {
      throw Object.assign(new Error('Telegram chatId 必填'), { code: 'INVALID_NOTIFICATION_CONFIG', status: 400 });
    }
    if (config.apiBase) requireHttp(String(config.apiBase), 'Telegram API Base');
  } else if (type === 'qq-onebot') {
    requireHttp(String(config.endpoint ?? ''), 'OneBot endpoint');
    if (!['group', 'private'].includes(String(config.targetType ?? ''))) {
      throw Object.assign(new Error('OneBot targetType 必须是 group 或 private'), { code: 'INVALID_NOTIFICATION_CONFIG', status: 400 });
    }
    if (!String(config.targetId ?? '').trim()) {
      throw Object.assign(new Error('OneBot targetId 必填'), { code: 'INVALID_NOTIFICATION_CONFIG', status: 400 });
    }
  } else {
    requireHttp(String(config.webhookUrl ?? ''), type === 'feishu' ? '飞书 webhook' : '企业微信 webhook');
  }
}

export function channelSummary(type: NotificationChannelType, config: Record<string, unknown>): string {
  try {
    if (type === 'qq-onebot') {
      const endpoint = requireHttp(String(config.endpoint ?? ''), 'OneBot endpoint');
      const target = config.targetType === 'private' ? 'private' : 'group';
      return `${new URL(endpoint).host} · ${target} ${String(config.targetId ?? '')}`;
    }
    if (type === 'telegram') return `Telegram · ${String(config.chatId ?? '')}`;
    const url = new URL(requireHttp(String(config.webhookUrl ?? ''), 'webhook'));
    return url.host;
  } catch {
    return '未配置完整';
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
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
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof payload === 'string' ? payload.slice(0, 200) : JSON.stringify(payload).slice(0, 200)}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function feishuPayload(config: { webhookUrl: string; secret?: string }, text: string): { url: string; body: Record<string, unknown> } {
  const url = requireHttp(config.webhookUrl, '飞书 webhook');
  const body: Record<string, unknown> = { msg_type: 'text', content: { text } };
  if (config.secret?.trim()) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const stringToSign = `${timestamp}\n${config.secret.trim()}`;
    const sign = createHmac('sha256', config.secret.trim()).update(stringToSign).digest('base64');
    body.timestamp = timestamp;
    body.sign = sign;
  }
  return { url, body };
}

function wecomPayload(config: { webhookUrl: string }, text: string): { url: string; body: Record<string, unknown> } {
  const url = requireHttp(config.webhookUrl, '企业微信 webhook');
  return { url, body: { msgtype: 'markdown', markdown: { content: text } } };
}

function dingtalkPayload(config: { webhookUrl: string; secret?: string }, text: string): { url: string; body: Record<string, unknown> } {
  const url = new URL(requireHttp(config.webhookUrl, '钉钉 webhook'));
  if (config.secret?.trim()) {
    const timestamp = Date.now().toString();
    const sign = createHmac('sha256', config.secret.trim()).update(`${timestamp}
${config.secret.trim()}`).digest('base64');
    url.searchParams.set('timestamp', timestamp);
    url.searchParams.set('sign', sign);
  }
  return { url: url.toString(), body: { msgtype: 'markdown', markdown: { title: 'AiDB', text } } };
}

function slackPayload(config: { webhookUrl: string }, text: string): { url: string; body: Record<string, unknown> } {
  return { url: requireHttp(config.webhookUrl, 'Slack webhook'), body: { text } };
}

function discordPayload(config: { webhookUrl: string }, text: string): { url: string; body: Record<string, unknown> } {
  return { url: requireHttp(config.webhookUrl, 'Discord webhook'), body: { content: text.slice(0, 1900) } };
}

function telegramPayload(config: { botToken: string; chatId: string; apiBase?: string }, text: string): { url: string; body: Record<string, unknown> } {
  const base = (config.apiBase ? requireHttp(config.apiBase, 'Telegram API Base') : 'https://api.telegram.org').replace(/\/+$/, '');
  return {
    url: `${base}/bot${config.botToken.trim()}/sendMessage`,
    body: { chat_id: config.chatId.trim(), text: text.slice(0, 3900), disable_web_page_preview: true },
  };
}

function oneBotPayload(config: { endpoint: string; token?: string; targetType: 'group' | 'private'; targetId: string }, text: string) {
  const endpoint = requireHttp(config.endpoint, 'OneBot endpoint').replace(/\/+$/, '');
  const action = config.targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
  const target = config.targetType === 'private' ? { user_id: Number(config.targetId) || config.targetId } : { group_id: Number(config.targetId) || config.targetId };
  return {
    url: `${endpoint}/${action}`,
    body: { ...target, message: text },
    headers: (config.token?.trim() ? { authorization: `Bearer ${config.token.trim()}` } : {}) as Record<string, string>,
  };
}

export async function sendNotification(
  store: Store,
  channelId: string,
  text: string,
): Promise<NotificationSendResult> {
  const channel = store.getNotificationChannel(channelId);
  if (!channel) throw Object.assign(new Error('通知渠道不存在'), { code: 'CHANNEL_NOT_FOUND', status: 404 });
  if (!channel.enabled) return { channelId, name: channel.name, ok: false, message: '渠道已禁用' };
  const config = store.getNotificationChannelConfig<Record<string, unknown>>(channelId);
  if (!config) throw Object.assign(new Error('通知渠道配置不可读'), { code: 'CHANNEL_CONFIG_INVALID', status: 400 });
  try {
    if (channel.type === 'feishu') {
      const { url, body } = feishuPayload(config as any, text);
      const payload = await postJson(url, body);
      if (payload && typeof payload === 'object' && payload.code !== undefined && Number(payload.code) !== 0) {
        throw new Error(`飞书返回 code=${payload.code} ${payload.msg ?? ''}`);
      }
    } else if (channel.type === 'wecom') {
      const { url, body } = wecomPayload(config as any, text);
      const payload = await postJson(url, body);
      if (payload && typeof payload === 'object' && payload.errcode !== undefined && Number(payload.errcode) !== 0) {
        throw new Error(`企业微信返回 errcode=${payload.errcode} ${payload.errmsg ?? ''}`);
      }
    } else if (channel.type === 'dingtalk') {
      const { url, body } = dingtalkPayload(config as any, text);
      const payload = await postJson(url, body);
      if (payload && typeof payload === 'object' && payload.errcode !== undefined && Number(payload.errcode) !== 0) {
        throw new Error(`钉钉返回 errcode=${payload.errcode} ${payload.errmsg ?? ''}`);
      }
    } else if (channel.type === 'slack') {
      const { url, body } = slackPayload(config as any, text);
      await postJson(url, body);
    } else if (channel.type === 'discord') {
      const { url, body } = discordPayload(config as any, text);
      await postJson(url, body);
    } else if (channel.type === 'telegram') {
      const { url, body } = telegramPayload(config as any, text);
      const payload = await postJson(url, body);
      if (payload && typeof payload === 'object' && payload.ok === false) {
        throw new Error(`Telegram 返回失败：${payload.description ?? 'unknown'}`);
      }
    } else {
      const { url, body, headers } = oneBotPayload(config as any, text);
      const payload = await postJson(url, body, headers);
      if (payload && typeof payload === 'object' && payload.status === 'failed') {
        throw new Error(`OneBot 返回失败：${JSON.stringify(payload).slice(0, 200)}`);
      }
    }
    return { channelId, name: channel.name, ok: true, message: '已发送' };
  } catch (err: any) {
    return { channelId, name: channel.name, ok: false, message: err?.message ?? '发送失败' };
  }
}

function metricLine(block: any): string[] {
  if (block.kind === 'metric') return (block.metrics ?? []).map((metric: any) => `${metric.label}: ${metric.value}${metric.unit ?? ''}`);
  if (block.kind === 'comparison') return [`${block.left?.label}: ${block.left?.value} / ${block.right?.label}: ${block.right?.value}${block.delta ? `（差值 ${block.delta.absolute}）` : ''}`];
  return [];
}

function artifactMessage(artifact: ArtifactInfo, runStatus: string, result: any): string {
  const displayTitle = typeof (result as { title?: unknown } | undefined)?.title === 'string' ? String((result as { title: string }).title) : artifact.title;
  const lines = [`【AiDB ${artifact.type === 'report' ? '报告' : artifact.type}】${displayTitle}`, `状态：${runStatus}`];
  if (result?.sections) {
    lines.push(`布局：${result.layout ?? 'sections'} · ${result.sources?.length ?? 0} 个源`);
    for (const section of result.sections.slice(0, 6)) {
      const metrics = (section.blocks ?? []).flatMap(metricLine);
      if (metrics.length) lines.push(`${section.title}：${metrics.slice(0, 4).join(' · ')}`);
    }
  } else if (result?.summary?.comparedKeys !== undefined) {
    lines.push(`缺失 ${result.summary.missingInRight} · 多余 ${result.summary.extraInRight} · 改值 ${result.summary.valueChanged}`);
  } else if (result?.summary?.statements !== undefined) {
    lines.push(`新增 ${result.summary.added} · 删除 ${result.summary.removed} · 变更 ${result.summary.changed}`);
  } else if (result?.findings) {
    lines.push(`${result.findings.length} 项发现 · ${result.plan?.length ?? 0} 条计划`);
  }
  lines.push('在 AiDB Studio 中打开产物查看完整结果。');
  return lines.join('\n').slice(0, 1800);
}

export async function notifyArtifact(
  store: Store,
  artifactId: string,
  runStatus: string,
): Promise<NotificationSendResult[]> {
  const artifact = store.getArtifact(artifactId);
  if (!artifact) return [];
  const schedule = store.getArtifactSchedule(artifactId);
  const channelIds = schedule?.notifyChannels ?? [];
  if (!channelIds.length) return [];
  const run = store.listArtifactRuns(artifactId, 1)[0];
  const message = artifactMessage(artifact, runStatus, run?.result);
  const results: NotificationSendResult[] = [];
  for (const channelId of channelIds) {
    try {
      results.push(await sendNotification(store, channelId, message));
    } catch (err: any) {
      results.push({ channelId, name: channelId, ok: false, message: err?.message ?? '发送失败' });
    }
    store.addAudit({
      actor: 'user',
      tool: 'notification.send',
      risk: 'read',
      approval: 'scheduled',
      status: results[results.length - 1].ok ? 'ok' : 'error',
      meta: { artifactId, channelId, runStatus, result: results[results.length - 1] },
    });
  }
  return results;
}
