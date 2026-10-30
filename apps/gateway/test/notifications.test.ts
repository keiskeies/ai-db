import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-notify-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'notify-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'notify-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const port = (gateway.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

const received: Array<{ path: string; body: any; headers: Record<string, string | string[] | undefined> }> = [];
const mock = createServer((req, res) => {
  let text = '';
  req.on('data', (chunk) => (text += chunk));
  req.on('end', () => {
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep */
    }
    received.push({ path: req.url ?? '', body, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    if ((req.url ?? '').includes('tenant_access_token')) {
      res.end(JSON.stringify({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }));
      return;
    }
    res.end(JSON.stringify({ code: 0, errcode: 0, status: 'ok' }));
  });
});
await listenRandom(mock);
const mockPort = (mock.address() as AddressInfo).port;
const mockBase = `http://127.0.0.1:${mockPort}`;

after(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

test('飞书 / 企微 / OneBot / 钉钉 / Slack / Discord / Telegram 渠道发送 payload 正确', async () => {
  const feishu = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: '飞书群', type: 'feishu', config: { webhookUrl: `${mockBase}/feishu`, secret: 'feishu-secret' } }),
  });
  assert.equal(feishu.status, 201, JSON.stringify(feishu.body));
  const wecom = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: '企微群', type: 'wecom', config: { webhookUrl: `${mockBase}/wecom` } }),
  });
  assert.equal(wecom.status, 201, JSON.stringify(wecom.body));
  const onebot = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: 'QQ 群', type: 'qq-onebot', config: { endpoint: mockBase, token: 'bot-token', targetType: 'group', targetId: '123' } }),
  });
  assert.equal(onebot.status, 201, JSON.stringify(onebot.body));
  const dingtalk = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: '钉钉群', type: 'dingtalk', config: { webhookUrl: `${mockBase}/dingtalk?access_token=x`, secret: 'ding-secret' } }),
  });
  assert.equal(dingtalk.status, 201, JSON.stringify(dingtalk.body));
  const slack = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: 'Slack', type: 'slack', config: { webhookUrl: `${mockBase}/slack` } }),
  });
  assert.equal(slack.status, 201, JSON.stringify(slack.body));
  const discord = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: 'Discord', type: 'discord', config: { webhookUrl: `${mockBase}/discord` } }),
  });
  assert.equal(discord.status, 201, JSON.stringify(discord.body));
  const telegram = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: 'Telegram', type: 'telegram', config: { botToken: '123:ABC', chatId: '42', apiBase: mockBase } }),
  });
  assert.equal(telegram.status, 201, JSON.stringify(telegram.body));

  const feishuTest = await api(`/notifications/channels/${feishu.body.channel.id}/test`, { method: 'POST' });
  assert.equal(feishuTest.body.result.ok, true, feishuTest.body.result.message);
  const wecomTest = await api(`/notifications/channels/${wecom.body.channel.id}/test`, { method: 'POST' });
  assert.equal(wecomTest.body.result.ok, true, wecomTest.body.result.message);
  const onebotTest = await api(`/notifications/channels/${onebot.body.channel.id}/test`, { method: 'POST' });
  assert.equal(onebotTest.body.result.ok, true, onebotTest.body.result.message);
  for (const channel of [dingtalk, slack, discord, telegram]) {
    const result = await api(`/notifications/channels/${channel.body.channel.id}/test`, { method: 'POST' });
    assert.equal(result.body.result.ok, true, `${channel.body.channel.type}: ${result.body.result.message}`);
  }

  const feishuRequest = received.find((item) => item.path === '/feishu');
  assert.ok(feishuRequest);
  assert.equal(feishuRequest.body.msg_type, 'text');
  assert.ok(feishuRequest.body.timestamp);
  assert.ok(feishuRequest.body.sign);
  const wecomRequest = received.find((item) => item.path === '/wecom');
  assert.ok(wecomRequest);
  assert.equal(wecomRequest.body.msgtype, 'markdown');
  const onebotRequest = received.find((item) => item.path === '/send_group_msg');
  assert.ok(onebotRequest);
  assert.equal(onebotRequest.body.group_id, 123);
  assert.equal(onebotRequest.headers.authorization, 'Bearer bot-token');
  const dingtalkRequest = received.find((item) => item.path.startsWith('/dingtalk?'));
  assert.ok(dingtalkRequest);
  assert.match(dingtalkRequest.path, /timestamp=/);
  assert.match(dingtalkRequest.path, /sign=/);
  assert.equal(dingtalkRequest.body.msgtype, 'markdown');
  const slackRequest = received.find((item) => item.path === '/slack');
  assert.ok(slackRequest);
  assert.match(slackRequest.body.text, /AiDB/);
  const discordRequest = received.find((item) => item.path === '/discord');
  assert.ok(discordRequest);
  assert.match(discordRequest.body.content, /AiDB/);
  const telegramRequest = received.find((item) => item.path === '/bot123:ABC/sendMessage');
  assert.ok(telegramRequest);
  assert.equal(telegramRequest.body.chat_id, '42');

  const list = await api('/notifications/channels');
  assert.equal(list.body.channels.length, 7);
  assert.ok(list.body.channels.every((channel: any) => !('config' in channel)));
});

test('定时报告会通过绑定渠道发送通知', async () => {
  const boot = await api('/bootstrap');
  const demo = boot.body.connections.find((connection: any) => connection.engine === 'sqlite');
  const started = await api('/commands/report/runs', {
    method: 'POST',
    body: JSON.stringify({ input: { sources: [{ connectionId: demo.id, label: 'Demo' }], topic: '通知测试', format: 'screen' } }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run.id;
  const eventsResponse = await fetch(`${base}/api/commands/runs/${runId}/events`, { headers });
  const text = await eventsResponse.text();
  const events = text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data));
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const channels = await api('/notifications/channels');
  const channelId = channels.body.channels.find((channel: any) => channel.type === 'wecom').id;
  const schedule = await api(`/artifacts/${artifactId}/schedule`, {
    method: 'POST',
    body: JSON.stringify({ intervalSeconds: 60, notifyChannels: [channelId] }),
  });
  assert.deepEqual(schedule.body.schedule.notifyChannels, [channelId]);

  const before = received.filter((item) => item.path === '/wecom').length;
  await gateway.scheduler.tick();
  let afterCount = before;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    afterCount = received.filter((item) => item.path === '/wecom').length;
    if (afterCount > before) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(afterCount > before, `notifications ${before} -> ${afterCount}`);
  const message = received.filter((item) => item.path === '/wecom').at(-1)?.body.markdown.content ?? '';
  assert.match(message, /通知测试/);
  assert.match(message, /AiDB/);
});


test('飞书 URL 验证与 OneBot inbound 问答', async () => {
  const feishu = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({ name: '飞书回调', type: 'feishu', config: { webhookUrl: `${mockBase}/feishu`, verificationToken: 'verify-me' } }),
  });
  const challenge = await fetch(`${base}/api/bots/${feishu.body.channel.id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', challenge: 'challenge-123', token: 'verify-me' }),
  });
  assert.equal(challenge.status, 200);
  assert.equal(((await challenge.json()) as { challenge: string }).challenge, 'challenge-123');

  const boot = await api('/bootstrap');
  const demo = boot.body.connections.find((connection: any) => connection.engine === 'sqlite');
  const onebot = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({
      name: 'QQ inbound',
      type: 'qq-onebot',
      config: {
        endpoint: mockBase,
        token: 'bot-token',
        targetType: 'group',
        targetId: '123',
        inbound: true,
        allowedChats: ['group:123'],
        connectionId: demo.id,
      },
    }),
  });
  const beforeReplies = received.filter((item) => item.path === '/send_group_msg').length;
  const event = await fetch(`${base}/api/bots/${onebot.body.channel.id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bot-token' },
    body: JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      self_id: 1,
      group_id: 123,
      user_id: 9,
      raw_message: '看看有哪些表',
    }),
  });
  assert.equal(event.status, 200);
  const deadline = Date.now() + 15000;
  let reply: any;
  while (Date.now() < deadline) {
    const replies = received.filter((item) => item.path === '/send_group_msg');
    if (replies.length > beforeReplies) {
      reply = replies.at(-1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(reply, 'OneBot reply not sent');
  assert.equal(reply.body.group_id, 123);
  assert.match(String(reply.body.message), /表|数据库|连接/);
});


test('飞书 inbound 消息经只读 Agent 回复', async () => {
  const boot = await api('/bootstrap');
  const demo = boot.body.connections.find((connection: any) => connection.engine === 'sqlite');
  const feishu = await api('/notifications/channels', {
    method: 'POST',
    body: JSON.stringify({
      name: '飞书问答',
      type: 'feishu',
      config: {
        webhookUrl: `${mockBase}/feishu`,
        apiBase: mockBase,
        appId: 'app-id',
        appSecret: 'app-secret',
        verificationToken: 'verify-me',
        inbound: true,
        allowedChats: ['chat-1'],
        connectionId: demo.id,
      },
    }),
  });
  const before = received.filter((item) => item.path.startsWith('/open-apis/im/v1/messages')).length;
  const event = await fetch(`${base}/api/bots/${feishu.body.channel.id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schema: '2.0',
      header: { token: 'verify-me', event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_type: 'user' },
        message: { chat_id: 'chat-1', message_type: 'text', content: JSON.stringify({ text: '看看有哪些表' }) },
      },
    }),
  });
  assert.equal(event.status, 200);
  const deadline = Date.now() + 15000;
  let reply: any;
  while (Date.now() < deadline) {
    const replies = received.filter((item) => item.path.startsWith('/open-apis/im/v1/messages'));
    if (replies.length > before) {
      reply = replies.at(-1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(reply, 'Feishu reply not sent');
  assert.equal(reply.body.receive_id, 'chat-1');
  assert.match(String(JSON.parse(reply.body.content).text), /表|数据库|连接/);
});
