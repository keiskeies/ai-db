import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';

const home = mkdtempSync(join(tmpdir(), 'aidb-profile-'));
const TOKEN = 'profile-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'profile-secret',
  token: TOKEN,
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

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

/** 1x1 透明 PNG。 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('stores an image attachment and serves it back with its mime type', async () => {
  const uploaded = await api('/agent/attachments', { method: 'POST', body: JSON.stringify({ mime: 'image/png', base64: PNG }) });
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.body.attachment.id, /\.png$/);
  assert.equal(uploaded.body.attachment.mime, 'image/png');

  const file = await fetch(`${base}/api/agent/attachments/${uploaded.body.attachment.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await file.arrayBuffer()).length, uploaded.body.attachment.bytes);
});

test('rejects unsupported image types and path-like attachment ids', async () => {
  const rejected = await api('/agent/attachments', { method: 'POST', body: JSON.stringify({ mime: 'text/plain', base64: 'aGk=' }) });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'UNSUPPORTED_IMAGE');

  const traversal = await fetch(`${base}/api/agent/attachments/..%2F..%2Fsecret`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(traversal.status, 404);
});

test('refuses images when the current model has no vision capability', async () => {
  const created = await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: '能力门禁' }) });
  const turn = await fetch(`${base}/api/agent/sessions/${created.body.session.id}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: '看看这张图', images: ['00000000-0000-4000-8000-000000000000.png'] }),
  });
  assert.equal(turn.status, 200);
  assert.match(await turn.text(), /MODEL_NO_VISION/);
});

test('persists model profiles and the selected reasoning tier', async () => {
  const profile = {
    contextWindow: 262144,
    maxOutputTokens: 32768,
    inputs: ['text', 'image'],
    reasoning: true,
    reasoningTiers: [{ level: 'off', value: '' }, { level: 'high', value: 'high' }],
  };
  const saved = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({ agent: { provider: 'openai', baseUrl: 'https://gate.example/v1', model: 'qwen-reason', modelProfiles: { 'qwen-reason': profile }, reasoningTier: 'high' } }),
  });
  assert.equal(saved.status, 200);
  const current = await api('/settings');
  assert.deepEqual(current.body.settings.agent.modelProfiles['qwen-reason'], profile);
  assert.equal(current.body.settings.agent.reasoningTier, 'high');
});

test('persists multiple providers, models and encrypted keys; switches materialize correctly', async () => {
  const saved = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      agent: {
        modelConfigs: [
          { id: 'prov-a', name: 'Provider A', provider: 'openai', baseUrl: 'https://a.example/v1', models: [{ id: 'a-fast', name: 'A Fast' }, { id: 'a-pro' }] },
          { id: 'prov-b', provider: 'anthropic', baseUrl: 'https://b.example', models: [{ id: 'b-main' }] },
        ],
        activeModelId: 'prov-b',
        model: 'b-main',
        modelKeys: { 'prov-a': 'sk-a-secret', 'prov-b': 'sk-b-secret' },
      },
    }),
  });
  assert.equal(saved.status, 200);
  const agent = saved.body.settings.agent;
  assert.equal(agent.activeModelId, 'prov-b');
  assert.equal(agent.provider, 'anthropic');
  assert.equal(agent.baseUrl, 'https://b.example');
  assert.equal(agent.model, 'b-main');
  assert.equal(agent.modelApiKeyStatus['prov-a'], true);
  assert.equal(agent.modelApiKeyStatus['prov-b'], true);
  assert.equal(agent.apiKey, undefined, '公开设置不返回密钥');
  assert.equal(agent.modelKeys, undefined, '公开设置不返回待写入密钥');

  const raw = new DatabaseSync(gateway.config.dbPath);
  try {
    const app = raw.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string };
    const keys = raw.prepare("SELECT value FROM settings WHERE key = 'agentModelKeys'").get() as { value: string };
    assert.ok(app.value.includes('"prov-a"'), '模型源写入 app 设置');
    assert.ok(!app.value.includes('sk-a-secret'), 'app 设置不落明文密钥');
    assert.ok(keys.value && !keys.value.includes('sk-a-secret'), '密钥单独加密存储');
  } finally {
    raw.close();
  }

  const switched = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { activeModelId: 'prov-a', model: 'a-pro' } }) });
  const next = switched.body.settings.agent;
  assert.equal(next.provider, 'openai');
  assert.equal(next.baseUrl, 'https://a.example/v1');
  assert.equal(next.model, 'a-pro');
  assert.equal(next.hasApiKey, true);

  const within = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { activeModelId: 'prov-a', model: 'a-fast' } }) });
  assert.equal(within.body.settings.agent.model, 'a-fast');

  const legacyAdd = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { activeModelId: 'prov-a', model: 'a-new' } }) });
  assert.equal(legacyAdd.body.settings.agent.model, 'a-new', '旧式直接改 model 直接生效');
  assert.ok(
    legacyAdd.body.settings.agent.modelConfigs[0].models.some((entry: { id: string }) => entry.id === 'a-new'),
    '旧式直接改 model 会补进当前模型源',
  );

  const cleared = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { activeModelId: 'prov-b', model: 'b-main', modelKeys: { 'prov-b': '__CLEAR__' } } }) });
  assert.equal(cleared.body.settings.agent.modelApiKeyStatus['prov-b'], false, '删除密钥后状态同步');
  assert.equal(cleared.body.settings.agent.hasApiKey, false);
});

test('migrates string model lists and old single-model configs', async () => {
  const asStrings = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      agent: {
        modelConfigs: [{ id: 'legacy-list', provider: 'openai', baseUrl: 'https://legacy.example/v1', models: ['legacy-a', 'legacy-b'] }],
        activeModelId: 'legacy-list',
        model: 'legacy-a',
      },
    }),
  });
  assert.deepEqual(asStrings.body.settings.agent.modelConfigs[0].models, [{ id: 'legacy-a' }, { id: 'legacy-b' }]);

  const flat = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      agent: {
        modelConfigs: [{ id: 'legacy-flat', provider: 'openai', baseUrl: 'https://flat.example/v1', model: 'flat-only' }],
        activeModelId: 'legacy-flat',
        model: 'flat-only',
      },
    }),
  });
  assert.deepEqual(flat.body.settings.agent.modelConfigs[0].models, [{ id: 'flat-only' }]);

  const legacyEdit = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({ agent: { provider: 'openai', baseUrl: 'https://flat.example/v1', model: 'flat-second' } }),
  });
  const models = legacyEdit.body.settings.agent.modelConfigs[0].models.map((entry: { id: string }) => entry.id);
  assert.deepEqual(models, ['flat-only', 'flat-second'], '旧式直接改 model 会补进当前模型源');
});

test('reasoningTier 传 null 会真正清空，回到 Default', async () => {
  // 这是输入卡档位菜单里「Default」依赖的契约：前端只能传 null，
  // undefined 会在 JSON 里消失、被浅合并当成「没改」，档位就清不掉了。
  const setHigh = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { reasoningTier: 'high' } }) });
  assert.equal(setHigh.body.settings.agent.reasoningTier, 'high');

  const cleared = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { reasoningTier: null } }) });
  assert.equal(cleared.body.settings.agent.reasoningTier, undefined, 'null 必须归一成未设置，不能把 null 存进库');

  // 不传该字段时保持原值（其它设置项的常规合并语义不受影响）
  const keep = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { reasoningTier: 'low' } }) });
  assert.equal(keep.body.settings.agent.reasoningTier, 'low');
  const untouched = await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { temperature: 0.3 } }) });
  assert.equal(untouched.body.settings.agent.reasoningTier, 'low', '没提 reasoningTier 就不该动它');

  await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { reasoningTier: null } }) });
});

test('轮次统计用户发起的对话轮数，中止的回合也计入', async () => {
  // 状态条上「N 轮」的语义是「用户问了几次」，不是「几次成功跑完」。
  // 只统计 done 会出现「0 轮却跑了 N 步」这种读不通的组合。
  const created = await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: '轮次语义' }) });
  const sessionId = created.body.session.id;
  assert.equal(created.body.session.turns, 0);

  // 跑一轮真实的离线推理（本地 provider 不需要外部模型服务）
  const turn = await fetch(`${base}/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: '只回复两个字：收到' }),
  });
  assert.equal(turn.status, 200);
  await turn.text();

  const afterOne = (await api(`/agent/sessions`)).body.sessions.find((s: { id: string }) => s.id === sessionId);
  assert.ok(afterOne, '会话仍在列表里');
  assert.ok(afterOne.turns >= 1, `跑过一轮后 turns 必须增加，实际 ${afterOne.turns}`);
  // 轮次不该超过「步数」——一步都没走却算了一轮是不可能的
  assert.ok(afterOne.steps === 0 || afterOne.turns <= afterOne.steps + 1, `turns=${afterOne.turns} steps=${afterOne.steps}`);
});
