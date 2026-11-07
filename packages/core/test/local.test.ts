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

// ---- 规划器接线：探测往返、图表入参、结论口径 ----

const rich: TableInfo[] = [
  {
    name: 'users',
    type: 'table',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'city', type: 'TEXT', nullable: true, primaryKey: false, comment: '城市' },
    ],
  },
  {
    name: 'orders',
    type: 'table',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'user_id', type: 'INTEGER', nullable: true, primaryKey: false },
      { name: 'status', type: 'TEXT', nullable: true, primaryKey: false, comment: '状态' },
      { name: 'amount_cents', type: 'INTEGER', nullable: true, primaryKey: false, comment: '金额' },
      { name: 'created_at', type: 'TEXT', nullable: true, primaryKey: false },
    ],
    foreignKeys: [{ name: 'fk_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
  },
];

const richContext: AgentContextData = { connection, databases: [{ name: 'main', tables: rich }] };

function toolMessage(name: string, data: unknown, toolCallId = 'x'): ProviderMessage {
  return { role: 'tool', toolCallId, name, content: JSON.stringify({ ok: true, summary: `${name} done`, data, meta: { durationMs: 1 } }) };
}

test('offline planner spends one bounded probe, then filters on a real value', async () => {
  const provider = new LocalProvider();
  const question = '统计已支付订单的金额合计';
  const first = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: question }], tools: [], context: richContext }));
  const probeCall = first.find((e) => e.type === 'tool_call');
  assert.ok(probeCall && probeCall.type === 'tool_call');
  if (probeCall?.type !== 'tool_call') return;
  assert.equal(probeCall.call.name, 'profile_column');
  assert.equal(probeCall.call.args.table, 'orders');
  assert.equal(probeCall.call.args.column, 'status');
  assert.match(textOf(first), /只读/);

  const second = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: question },
        toolMessage('profile_column', { table: 'orders', column: 'status', distinct: 2, total: 14, top: [{ value: '已支付', count: 12 }, { value: '已退款', count: 2 }] }),
      ],
      tools: [],
      context: richContext,
    }),
  );
  const runCall = second.find((e) => e.type === 'tool_call');
  assert.ok(runCall && runCall.type === 'tool_call');
  if (runCall?.type !== 'tool_call') return;
  assert.match(String(runCall.call.args.sql), /"status" = '已支付'/);
  assert.match(String(runCall.call.args.sql), /SUM\("amount_cents"\)/);
});

test('offline planner stops probing and asks when the value matches nothing', async () => {
  const provider = new LocalProvider();
  const question = '统计已支付订单的金额合计';
  const events = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: question },
        toolMessage('profile_column', { table: 'orders', column: 'status', distinct: 2, total: 9, top: [{ value: 'shipped', count: 5 }, { value: 'refunded', count: 4 }] }),
      ],
      tools: [],
      context: richContext,
    }),
  );
  assert.equal(events.some((e) => e.type === 'tool_call'), false);
  assert.match(textOf(events), /shipped/);
  assert.match(textOf(events), /已支付/);
});

test('offline planner hands the chart tool stable result aliases', async () => {
  const provider = new LocalProvider();
  const question = '按 status 统计 orders 并画柱状图';
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: question }], tools: [], context: richContext }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.equal(call.call.name, 'render_chart');
  assert.equal(call.call.args.type, 'bar');
  assert.equal(call.call.args.x, 'label');
  assert.equal(call.call.args.y, 'value');
  assert.match(String(call.call.args.sql), /GROUP BY "status"/);
});

test('offline planner states the numbers it read before showing the table', async () => {
  const provider = new LocalProvider();
  const question = '按 status 统计 orders 的金额合计';
  const events = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: question },
        toolMessage('analyze_chart', {
          x: 'label',
          y: 'value',
          rowCount: 2,
          sum: 12300,
          avg: 6150,
          min: 300,
          max: 12000,
          argmin: 'refunded',
          argmax: 'paid',
          topShare: [{ label: 'paid', value: 12000, share: 0.9756 }],
        }),
      ],
      tools: [],
      context: richContext,
    }),
  );
  const text = textOf(events);
  assert.match(text, /12,300/);
  assert.match(text, /金额/);
  assert.match(text, /```sql/);
  assert.match(text, /Bridge 计算/);
});

test('offline planner reports the window it applied for a time phrase', async () => {
  const provider = new LocalProvider();
  const question = '按 status 统计近 3 个月订单的金额';
  const sent = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: question }], tools: [], context: richContext }));
  const call = sent.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.match(String(call.call.args.sql), /"created_at" >= '/);

  const events = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: question },
        toolMessage('run_sql', {
          columns: [{ name: 'label' }, { name: 'value' }],
          rows: [['paid', 12000], ['refunded', 300]],
        }),
      ],
      tools: [],
      context: richContext,
    }),
  );
  const text = textOf(events);
  assert.match(text, /12,300/);
  assert.match(text, /近 3 个月/);
});

test('offline planner asks for join keys instead of inventing them', async () => {
  const provider = new LocalProvider();
  const withOrphan: AgentContextData = {
    connection,
    databases: [
      {
        name: 'main',
        tables: [...rich, { name: 'tickets', type: 'table', comment: '工单', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] }],
      },
    ],
  };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按工单统计订单金额合计' }], tools: [], context: withOrphan }));
  assert.equal(events.some((e) => e.type === 'tool_call'), false);
  assert.match(textOf(events), /tickets/);
  assert.match(textOf(events), /外键/);
});

test('offline planner joins via the foreign key and keeps every column qualified', async () => {
  const provider = new LocalProvider();
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按用户的城市统计订单金额合计' }], tools: [], context: richContext }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.match(String(call.call.args.sql), /INNER JOIN "users" ON "orders"\."user_id" = "users"\."id"/);
  assert.match(String(call.call.args.sql), /GROUP BY "users"\."city"/);
});

test('offline planner stays out of the way for engines without SQL', async () => {
  const provider = new LocalProvider();
  const mongo: ConnectionConfig = { ...connection, id: 'c2', name: 'Mongo', engine: 'mongodb' };
  const context: AgentContextData = { connection: mongo, databases: [{ name: 'main', tables: rich }] };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按 status 统计 orders 的金额合计' }], tools: [], context }));
  assert.equal(events.some((e) => e.type === 'tool_call' && e.call.name === 'profile_column'), false);
});
