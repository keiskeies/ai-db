import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTableVisibility, bundleAgentContext, emptyBundle, expandTerms, findTableByAlias } from '../src/agent/context';
import { LocalProvider } from '../src/agent/providers/local';
import type { AgentContextData, ProviderEvent, ProviderMessage } from '../src/agent/types';
import type { AgentContextEntry, ConnectionConfig, Memory, TableInfo } from '../src/types';

const iso = new Date('2026-10-27T00:00:00.000Z').toISOString();

function entry(partial: Partial<AgentContextEntry> & { kind: AgentContextEntry['kind']; table: string }): AgentContextEntry {
  return { id: `${partial.kind}-${partial.table}`, connectionId: 'c1', database: 'main', enabled: true, createdAt: iso, updatedAt: iso, ...partial };
}

function glossaryTerm(title: string, content: string): Memory {
  return {
    id: title,
    scopeType: 'global',
    scopeKey: '*',
    kind: 'glossary',
    title,
    content,
    tags: [],
    importance: 0.8,
    confidence: 0.7,
    pinned: false,
    archived: false,
    useCount: 0,
    createdAt: iso,
    updatedAt: iso,
  };
}

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'Demo',
  engine: 'sqlite',
  color: 'green',
  environment: 'dev',
  groupName: 'demo',
  database: '/tmp/demo.sqlite',
  readonly: false,
  createdAt: iso,
  updatedAt: iso,
};

const tables: TableInfo[] = [
  { name: 'users', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] },
  { name: 'orders', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'status', type: 'TEXT', nullable: true, primaryKey: false }] },
];
const assetTable: TableInfo = { name: 'sys_asset', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] };

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const inspectResult = (list: TableInfo[], callId = 'x'): ProviderMessage => ({
  role: 'tool',
  toolCallId: callId,
  name: 'inspect_schema',
  content: JSON.stringify({ ok: true, summary: `${list.length} tables`, data: { tables: list }, meta: { durationMs: 1 } }),
});

// ---------- pure helpers ----------

test('applyTableVisibility hides disabled tables no matter where the list came from', () => {
  const all = [{ name: 'users' }, { name: 'orders' }, { name: 'Audit_Log' }];
  const bundle = bundleAgentContext([entry({ kind: 'table', table: 'orders', enabled: false }), entry({ kind: 'table', table: 'audit_log', enabled: false })], {});
  assert.deepEqual(applyTableVisibility(all, bundle).map((t) => t.name), ['users']);
  assert.deepEqual(applyTableVisibility(all, undefined), all, 'no bundle -> untouched');
  assert.deepEqual(applyTableVisibility(all, emptyBundle()), all, 'inactive bundle -> untouched');
});

test('expandTerms rewrites business shorthand using the glossary', () => {
  const glossary = [glossaryTerm('JS', 'JumpServer 堡垒机，资产表是 sys_asset')];
  assert.match(expandTerms('看看 JS 的资产', glossary), /sys_asset/);
  assert.equal(expandTerms('看看 JS 的资产', undefined), '看看 JS 的资产');
  assert.equal(expandTerms('看看 JS 的资产', []), '看看 JS 的资产');
  assert.equal(expandTerms('JSmith 的记录', glossary), 'JSmith 的记录', '词内不误伤');
  assert.match(expandTerms('js 呢', glossary), /sys_asset/, '大小写不敏感');
});

test('expandTerms truncates runaway glossary content', () => {
  assert.ok(expandTerms('GMV 多少', [glossaryTerm('GMV', 'x'.repeat(5000))]).length < 300);
});

test('findTableByAlias maps a business name back to the physical table', () => {
  const bundle = bundleAgentContext([entry({ kind: 'table', table: 'clue', alias: '线索表' }), entry({ kind: 'table', table: 'clue_detail', alias: '线索明细表' })], {});
  const list = [{ name: 'clue' }, { name: 'clue_detail' }, { name: 'sys_org' }];
  assert.equal(findTableByAlias('线索表有多少行', list, bundle), 'clue');
  assert.equal(findTableByAlias('线索明细表的结构', list, bundle), 'clue_detail', '更长的别名优先，避免前缀误匹配');
  assert.equal(findTableByAlias('sys_org 的结构', list, bundle), undefined, '没有别名命中时不猜测');
  assert.equal(findTableByAlias('线索表有多少行', list, undefined), undefined);
});

// ---------- offline provider honours the business context ----------

test('offline reasoner hides disabled tables even after inspect_schema returns them', async () => {
  const provider = new LocalProvider();
  const bundle = bundleAgentContext([entry({ kind: 'table', table: 'orders', enabled: false })], { connectionId: 'c1', database: 'main' });
  const context: AgentContextData = { connection, databases: [{ name: 'main', tables }], agentContext: bundle };

  const first = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '看看有哪些表' }], tools: [], context }));
  const call = first.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;

  const second = await collect(
    provider.stream({
      system: '',
      messages: [{ role: 'user', content: '看看有哪些表' }, inspectResult(tables, call.call.id)],
      tools: [],
      context,
    }),
  );
  const text = second.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('');
  assert.match(text, /users/);
  assert.ok(!text.includes('orders'), `被禁用的表不应出现在离线回答里：${text}`);
});

test('offline reasoner resolves a business alias to the physical table', async () => {
  const provider = new LocalProvider();
  const bundle = bundleAgentContext([entry({ kind: 'table', table: 'users', alias: '用户表' })], { connectionId: 'c1', database: 'main' });
  const context: AgentContextData = { connection, databases: [{ name: 'main', tables }], agentContext: bundle };

  const events = await collect(
    provider.stream({ system: '', messages: [{ role: 'user', content: '用户表有多少行' }, inspectResult(tables)], tools: [], context }),
  );
  const call = events.find((e) => e.type === 'tool_call' && e.call.name !== 'inspect_schema');
  assert.ok(call && call.type === 'tool_call', '应产生一次针对该表的工具调用');
  if (call?.type !== 'tool_call') return;
  assert.match(JSON.stringify(call.call.args), /users/, `别名「用户表」应解析到 users：${JSON.stringify(call.call.args)}`);
});

test('offline reasoner expands glossary shorthand before picking a table', async () => {
  const provider = new LocalProvider();
  const all = [...tables, assetTable];
  const context: AgentContextData = {
    connection,
    databases: [{ name: 'main', tables: all }],
    glossary: [glossaryTerm('JS', 'JumpServer 堡垒机，资产表是 sys_asset')],
  };

  const events = await collect(
    provider.stream({ system: '', messages: [{ role: 'user', content: 'JS 的资产有多少行' }, inspectResult(all)], tools: [], context }),
  );
  const call = events.find((e) => e.type === 'tool_call' && e.call.name !== 'inspect_schema');
  assert.ok(call && call.type === 'tool_call', '应产生一次工具调用');
  if (call?.type !== 'tool_call') return;
  assert.match(JSON.stringify(call.call.args), /sys_asset/, `术语展开后应命中 sys_asset：${JSON.stringify(call.call.args)}`);
});

test('offline reasoner is unchanged when no business context is configured', async () => {
  const provider = new LocalProvider();
  const plain: AgentContextData = { connection, databases: [{ name: 'main', tables }] };
  const withEmpty: AgentContextData = { connection, databases: [{ name: 'main', tables }], agentContext: emptyBundle(), glossary: [] };
  const messages: ProviderMessage[] = [{ role: 'user', content: '看看有哪些表' }, inspectResult(tables)];

  const run = async (context: AgentContextData) => {
    const events = await collect(provider.stream({ system: '', messages, tools: [], context }));
    return events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('');
  };
  assert.equal(await run(withEmpty), await run(plain), '空 bundle 不得改变离线输出');
  assert.match(await run(plain), /orders/);
});
