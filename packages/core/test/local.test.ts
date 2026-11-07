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

// ---- 业务上下文可执行化：示例 SQL 定口径，反例硬挡 ----

const iso = '2026-11-01T00:00:00.000Z';

function memory(kind: 'glossary' | 'sql_example', title: string, content: string) {
  return { id: title, scopeType: 'global' as const, scopeKey: '*', kind, title, content, tags: [], importance: 0.8, confidence: 0.9, pinned: false, archived: false, useCount: 0, createdAt: iso, updatedAt: iso };
}

const exampleSql = `SELECT status AS label, SUM(amount_cents) AS value FROM orders WHERE status = '已支付' GROUP BY status`;

test('a registered example SQL runs verbatim instead of the planner caliber', async () => {
  const provider = new LocalProvider();
  const context: AgentContextData = { ...richContext, sqlExamples: [memory('sql_example', '订单金额合计口径', exampleSql)] };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按 status 统计订单金额合计' }], tools: [], context }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.equal(call.call.name, 'analyze_chart');
  assert.equal(call.call.args.sql, exampleSql);
  assert.match(textOf(events), /示例 SQL/);

  const final = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: '按 status 统计订单金额合计' },
        toolMessage('analyze_chart', { x: 'label', y: 'value', rowCount: 1, sum: 98000, avg: 98000, min: 98000, max: 98000, argmin: '已支付', argmax: '已支付' }),
      ],
      tools: [],
      context,
    }),
  );
  const answer = textOf(final);
  // 收尾必须把用户自己的口径原样亮出来，不然数字无法复核。
  assert.match(answer, /```sql\nSELECT status AS label/);
  assert.match(answer, /98,000/);
});

test('an example for a chart question drives render_chart, not the planner SQL', async () => {
  const provider = new LocalProvider();
  const context: AgentContextData = { ...richContext, sqlExamples: [memory('sql_example', '订单金额合计口径', exampleSql)] };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按 status 统计订单金额并画柱状图' }], tools: [], context }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.equal(call.call.name, 'render_chart');
  assert.equal(call.call.args.sql, exampleSql);
  assert.equal(call.call.args.type, 'bar');
});

test('an unrelated question keeps the planner even when an example exists', async () => {
  const provider = new LocalProvider();
  const context: AgentContextData = { ...richContext, sqlExamples: [memory('sql_example', '每月下单用户数走势', 'SELECT created_at, COUNT(DISTINCT user_id) AS users FROM orders GROUP BY created_at')] };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按用户的城市统计订单金额合计' }], tools: [], context }));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.match(String(call.call.args.sql), /INNER JOIN "users"/);
  assert.equal(textOf(events).includes('示例 SQL'), false);
});

test('an anti-pattern stops the offline planner from querying the forbidden table', async () => {
  const provider = new LocalProvider();
  const context: AgentContextData = { ...richContext, glossary: [memory('glossary', '反例：订单数不要用支付流水', '统计订单笔数必须用 orders；pay_flow 是支付流水，一行不等于一笔订单。'), ] };
  const withFlow: AgentContextData = {
    ...context,
    databases: [{ name: 'main', tables: [...rich, { name: 'pay_flow', comment: '支付流水', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'amount', type: 'INTEGER', nullable: true, primaryKey: false, comment: '金额' }] }] }],
  };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按 status 统计 pay_flow 的金额合计' }], tools: [], context: withFlow }));
  assert.equal(events.some((e) => e.type === 'tool_call'), false);
  const answer = textOf(events);
  assert.match(answer, /pay_flow/);
  assert.match(answer, /一行不等于一笔订单/);
});

test('an anti-pattern also blocks the templates that skip the planner', async () => {
  const provider = new LocalProvider();
  // 预测走自己的外推模板，不经过 planQuery：这一层漏了就是「反例对数字无效」。
  const context: AgentContextData = {
    ...richContext,
    glossary: [memory('glossary', '反例：金额不要用 pay_flow', '统计金额一律用 orders.amount_cents；pay_flow 金额含税，不要用。')],
    databases: [{ name: 'main', tables: [...rich, { name: 'pay_flow', comment: '支付流水', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'amount', type: 'INTEGER', nullable: true, primaryKey: false, comment: '金额' }, { name: 'created_at', type: 'TEXT', nullable: true, primaryKey: false }] }] }],
  };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '预测 pay_flow 未来 3 个月的金额走势' }], tools: [], context }));
  assert.equal(events.some((e) => e.type === 'tool_call'), false);
  assert.match(textOf(events), /pay_flow/);

  // 但看结构这种库操作不算用错口径，不能被业务反例一起挡掉。
  const described = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: 'pay_flow 表结构' }], tools: [], context }));
  assert.match(textOf(described), /^(?!.*我不该用)/s);
  assert.ok(described.some((e) => e.type === 'tool_call'));
});


test('a compound question issues one read-only query per clause', async () => {
  const provider = new LocalProvider();
  const enumRich: TableInfo[] = rich.map((table) => (table.name === 'orders' ? { ...table, columns: (table.columns ?? []).map((column) => (column.name === 'status' ? { ...column, comment: '状态：已支付, 已退款, 待支付' } : column)) } : table));
  const context: AgentContextData = { connection, databases: [{ name: 'main', tables: enumRich }] };
  const events = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '统计订单总数，以及已支付订单的金额合计' }], tools: [], context }));
  const calls = events.filter((e) => e.type === 'tool_call').map((e: any) => e.call);
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].args.sql), /COUNT\(\*\)/);
  assert.match(String(calls[1].args.sql), /SUM\("amount_cents"\)/);
  assert.match(String(calls[1].args.sql), /"status" = '已支付'/);
  const plan = events.find((e) => e.type === 'plan') as any;
  assert.ok(plan, '计划卡应由规划器直接给出');
  assert.equal(plan.items.length, 2);
});

test('a compound question reads each clause out of its own result', async () => {
  const provider = new LocalProvider();
  const question = '统计订单总数，以及近 3 个月的金额合计';
  const sent = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: question }], tools: [], context: richContext }));
  const calls = sent.filter((e) => e.type === 'tool_call').map((e: any) => e.call);
  assert.equal(calls.length, 2);
  const dataFor = (name: string, value: number) =>
    name === 'analyze_chart'
      ? { x: 'label', y: 'value', rowCount: 1, sum: value, avg: value, min: value, max: value, argmin: '全部', argmax: '全部' }
      : { columns: [{ name: 'label' }, { name: 'value' }], rows: [['全部', value]] };
  const events = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: '', toolCalls: calls.map((call: any) => ({ id: call.id, name: call.name, args: call.args })) },
        ...calls.map((call: any, index: number) => ({
          role: 'tool' as const,
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ ok: true, summary: 'ok', data: dataFor(call.name, [42, 8800][index]), meta: { durationMs: 1 } }),
        })),
      ],
      tools: [],
      context: richContext,
    }),
  );
  const answer = textOf(events);
  assert.match(answer, /\*\*42\*\*/);
  assert.match(answer, /8,800/);
  assert.equal(events.some((e) => e.type === 'tool_call'), false);
});

test('a follow-up inherits the earlier question instead of restarting it', async () => {
  const provider = new LocalProvider();
  const events = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: '统计近 3 个月已支付订单的金额合计' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'p1', name: 'run_sql', args: { sql: 'SELECT 1' } }] },
        { role: 'tool', toolCallId: 'p1', name: 'run_sql', content: JSON.stringify({ ok: true, summary: 'ok', data: { columns: [{ name: 'label' }, { name: 'value' }], rows: [['全部', 1]] }, meta: { durationMs: 1 } }) },
        { role: 'user', content: '那按城市拆分呢' },
      ],
      tools: [],
      context: richContext,
    }),
  );
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.match(String(call.call.args.sql), /GROUP BY "users"\."city"/);
  assert.match(String(call.call.args.sql), /INNER JOIN "users"/);
});

test('a follow-up that says 全部 drops the inherited window and filter', async () => {
  const provider = new LocalProvider();
  const events = await collect(
    provider.stream({
      system: '',
      messages: [
        { role: 'user', content: '统计近 3 个月已支付订单的金额合计' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'p1', name: 'run_sql', args: { sql: 'SELECT 1' } }] },
        { role: 'tool', toolCallId: 'p1', name: 'run_sql', content: JSON.stringify({ ok: true, summary: 'ok', data: { columns: [{ name: 'label' }, { name: 'value' }], rows: [['全部', 1]] }, meta: { durationMs: 1 } }) },
        { role: 'user', content: '全部订单的金额合计' },
      ],
      tools: [],
      context: richContext,
    }),
  );
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call?.type !== 'tool_call') return;
  assert.equal(/WHERE/.test(String(call.call.args.sql)), false);
});
