import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider, detectIntent, parseCreateSpec } from '../src/agent/providers/local';
import type { AgentContextData, ProviderEvent, ProviderMessage } from '../src/agent/types';
import type { ConnectionConfig, TableInfo } from '../src/types';

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'Demo',
  engine: 'sqlite',
  color: 'green',
  environment: 'dev',
  groupName: 'demo',
  database: '/tmp/demo.sqlite',
  readonly: false,
  createdAt: '',
  updatedAt: '',
};

const tables: TableInfo[] = [
  { name: 'users', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'name', type: 'TEXT', nullable: false, primaryKey: false }] },
  { name: 'orders', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'status', type: 'TEXT', nullable: true, primaryKey: false }] },
];

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('intent detection covers common offline requests', () => {
  assert.equal(detectIntent('看看有哪些表'), 'list_tables');
  assert.equal(detectIntent('orders 表结构'), 'describe');
  assert.equal(detectIntent('按 status 统计 orders'), 'group');
  assert.equal(detectIntent('备份当前数据库'), 'backup');
  assert.equal(detectIntent('创建表 tasks，包含 id 自增主键, title 文本'), 'create');
  assert.equal(detectIntent('记住：金额单位是分'), 'memory_write');
  assert.equal(detectIntent('SELECT * FROM users'), 'raw_sql');
});

test('parses create table specifications', () => {
  const parsed = parseCreateSpec('创建表 tasks，包含 id 自增主键, title 文本, done 布尔, created_at 时间', 'sqlite');
  assert.ok('table' in parsed);
  if (!('table' in parsed)) return;
  assert.equal(parsed.table, 'tasks');
  assert.equal(parsed.columns.length, 4);
  assert.equal(parsed.columns[0].name, 'id');
  assert.equal(parsed.columns[0].autoIncrement, true);
  assert.equal(parsed.columns[0].primaryKey, true);
  assert.equal(parsed.columns[2].type, 'INTEGER');
});

test('local reasoner calls inspect_schema first, then answers with grounded tables', async () => {
  const provider = new LocalProvider();
  const context: AgentContextData = { connection };
  const first: ProviderMessage[] = [{ role: 'user', content: '看看有哪些表' }];
  const events = await collect(provider.stream({ system: '', messages: first, tools: [], context }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.equal(call.call.name, 'inspect_schema');
  assert.equal(call.call.args.connectionId, 'c1');

  const second: ProviderMessage[] = [
    { role: 'user', content: '看看有哪些表' },
    { role: 'tool', toolCallId: call.call.id, name: 'inspect_schema', content: JSON.stringify({ ok: true, summary: '2 tables', data: { tables }, meta: { durationMs: 1 } }) },
  ];
  const finalEvents = await collect(provider.stream({ system: '', messages: second, tools: [], context }));
  const text = finalEvents.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('');
  assert.match(text, /users/);
  assert.match(text, /orders/);
  assert.equal(finalEvents.at(-1)?.type, 'done');
});
