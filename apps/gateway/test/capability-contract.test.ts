import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { CAPABILITIES, getCapability } from '@aidb/core';
import { createGateway } from '../src/server';
import { capabilityPromptBlock } from '../src/agentHost';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-capability-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });

const TOKEN = 'capability-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'capability-secret',
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

after(async () => {
  await gateway.close();
});

async function api(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

// ---------- 提示块 ----------

test('能力目录注入 12 条功能，含 id / 标题 / 工具 / 字段 / 状态', () => {
  const block = capabilityPromptBlock();
  assert.match(block, /^## Capabilities/);
  for (const capability of CAPABILITIES) {
    assert.ok(block.includes(capability.id), `缺少 ${capability.id}`);
    assert.ok(block.includes(capability.title.zh), `缺少标题 ${capability.title.zh}`);
  }
  // 有工具的写明工具名，没工具的必须引导去工具箱
  assert.match(block, /transfer_data/);
  assert.match(block, /### 只能引导（无 Agent 工具）/);
  assert.match(block, /引导用户到「工具箱 → 自动化任务」/);
});

test('能力目录明确禁止编造与假装执行', () => {
  const block = capabilityPromptBlock();
  assert.match(block, /不要编造参数/);
  assert.match(block, /不要声称已完成/);
  assert.match(block, /不要自己拼 REST 请求/);
});

test('字段的必填标记与状态 id 出现在提示里', () => {
  const block = capabilityPromptBlock();
  assert.match(block, /sourceConnectionId:connection\*/);
  assert.match(block, /States: running\/ok\/partial\/failed/);
});

test('提示块对空契约列表安全', () => {
  assert.match(capabilityPromptBlock([]), /none registered/);
});

test('提示块体量在预算内（≤ 2000 字符 ≈ 1.3k token）', () => {
  const block = capabilityPromptBlock();
  assert.ok(block.length <= 2000, `能力目录过大：${block.length} 字符`);
});

// ---------- API ----------

test('GET /capabilities 返回 12 条', async () => {
  const response = await api('/api/capabilities');
  assert.equal(response.status, 200);
  assert.equal(response.body.capabilities.length, 12);
  const transfer = response.body.capabilities.find((item: any) => item.id === 'transfer');
  assert.deepEqual(transfer.tools, ['transfer_data']);
});

test('GET /capabilities/:id 返回单个契约', async () => {
  const response = await api('/api/capabilities/jobs');
  assert.equal(response.status, 200);
  assert.equal(response.body.capability.id, 'jobs');
  assert.deepEqual(response.body.capability.tools, []);
});

test('GET /capabilities/:id 未知功能返回 404', async () => {
  const response = await api('/api/capabilities/nope');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'CAPABILITY_NOT_FOUND');
});

// ---------- 契约与工具表一致性 ----------

test('契约声明的工具都能在 /agent/tools 里找到', async () => {
  const response = await api('/api/agent/tools');
  assert.equal(response.status, 200);
  const names = new Set(response.body.tools.map((tool: any) => tool.name));
  for (const capability of CAPABILITIES) {
    for (const tool of capability.tools) {
      assert.ok(names.has(tool), `${capability.id} 声明的 ${tool} 不在工具表里`);
    }
  }
});

test('无工具的功能集中在需要人工确认的模块上', () => {
  const noTool = CAPABILITIES.filter((capability) => capability.tools.length === 0).map((capability) => capability.id);
  assert.deepEqual(noTool.sort(), [
    'advanced-objects',
    'agent-context',
    'compare-data',
    'dictionary',
    'jobs',
    'monitor',
    'query-builder',
    'users',
  ]);
});

test('每个契约的 maxRisk 都能被策略层理解', () => {
  const allowed = new Set(['read', 'write', 'ddl', 'destructive']);
  for (const capability of CAPABILITIES) {
    assert.ok(allowed.has(capability.maxRisk), `${capability.id} 的 maxRisk 非法`);
  }
});

test('getCapability 与 /capabilities 结果一致', async () => {
  const response = await api('/api/capabilities');
  for (const item of response.body.capabilities) {
    assert.deepEqual(getCapability(item.id), item);
  }
});
