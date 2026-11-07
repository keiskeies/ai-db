import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider, detectIntent, parseCreateSpec } from '../src/agent/providers/local';
import type { AgentContextData, ProviderEvent, ProviderMessage } from '../src/agent/types';
import { EMPTY_AGENT_CONTEXT_BUNDLE } from '../src/types';
import type { AgentContextBundle, ConnectionConfig, TableInfo } from '../src/types';

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

const schemas = [{ name: 'main', tables }];

function contextWith(bundle: Partial<AgentContextBundle>): AgentContextData {
  return { connection, databases: schemas, agentContext: { ...EMPTY_AGENT_CONTEXT_BUNDLE, ...bundle } };
}

function textOf(events: ProviderEvent[]): string {
  return events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('');
}

test('offline group-by resolves business aliases for both the table and the column', async () => {
  const provider = new LocalProvider();
  const context = contextWith({
    tableMeta: { orders: { alias: '销售订单' } },
    columnMeta: { orders: { status: { alias: '订单状态' } } },
  });
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按订单状态统计销售订单' }], tools: [], context }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.equal(call.call.name, 'run_sql');
  assert.match(String(call.call.args.sql), /FROM "orders"/);
  assert.match(String(call.call.args.sql), /GROUP BY "status"/);
});

test('offline mode refuses a hidden table instead of answering about a different one', async () => {
  const provider = new LocalProvider();
  const context = contextWith({ disabledTables: ['orders'] });
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '统计 orders 的行数' }], tools: [], context }));
  assert.equal(events.some((e) => e.type === 'tool_call'), false);
  assert.match(textOf(events), /隐藏/);
  assert.match(textOf(events), /orders/);
});

test('offline describe omits columns the user disabled and says how many', async () => {
  const provider = new LocalProvider();
  const withNote: TableInfo[] = [
    { ...tables[1], columns: [...(tables[1].columns ?? []), { name: 'note', type: 'TEXT', nullable: true, primaryKey: false }] },
    tables[0],
  ];
  const context: AgentContextData = {
    connection,
    databases: [{ name: 'main', tables: withNote }],
    agentContext: { ...EMPTY_AGENT_CONTEXT_BUNDLE, disabledColumns: { orders: ['note'] } },
  };
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'orders 表结构' },
    { role: 'tool', toolCallId: 'x', name: 'inspect_schema', content: JSON.stringify({ ok: true, summary: '2 tables', data: { tables: withNote }, meta: { durationMs: 1 } }) },
  ];
  const events = await collect(provider.stream({ system: '', messages, tools: [], context }));
  const text = textOf(events);
  assert.match(text, /status/);
  assert.equal(/\| `note` \|/.test(text), false);
  assert.match(text, /另有 1 列被/);
});

test('offline measure selection skips foreign keys and identifier columns', async () => {
  const provider = new LocalProvider();
  const numeric: TableInfo[] = [
    {
      name: 'orders',
      type: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'user_id', type: 'INTEGER', nullable: true, primaryKey: false },
        { name: 'status', type: 'TEXT', nullable: true, primaryKey: false },
        { name: 'amount_cents', type: 'INTEGER', nullable: true, primaryKey: false },
      ],
      foreignKeys: [{ name: 'fk', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
    },
  ];
  const context: AgentContextData = { connection, databases: [{ name: 'main', tables: numeric }] };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按 status 统计 orders 的合计' }], tools: [], context }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.match(String(call.call.args.sql), /SUM\("amount_cents"\)/);
  assert.equal(/SUM\("user_id"\)/.test(String(call.call.args.sql)), false);
});
