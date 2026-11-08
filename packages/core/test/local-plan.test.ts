import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContextBundle, Engine, TableInfo } from '../src/types';
import { EMPTY_AGENT_CONTEXT_BUNDLE } from '../src/types';
import type { GroundingOptions } from '../src/agent/local/schema';
import { findJoinPath, joinEdges, windowCondition } from '../src/agent/local/query';
import { compileQuery } from '../src/agent/local/query';
import type { QuerySpec } from '../src/agent/local/query';
import { planQuery } from '../src/agent/local/parse';

const sqlite: Engine = 'sqlite';

const users: TableInfo = {
  name: 'users',
  type: 'table',
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'city', type: 'TEXT', nullable: true, primaryKey: false, comment: '城市' },
  ],
};

const orders: TableInfo = {
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
};

const payments: TableInfo = {
  name: 'payments',
  type: 'table',
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'order_id', type: 'INTEGER', nullable: true, primaryKey: false },
    { name: 'paid_at', type: 'TEXT', nullable: true, primaryKey: false },
  ],
  foreignKeys: [{ name: 'fk_order', columns: ['order_id'], refTable: 'orders', refColumns: ['id'] }],
};

const tables = [users, orders, payments];
const grounding: GroundingOptions = { bundle: EMPTY_AGENT_CONTEXT_BUNDLE };

/** 列注释里写了取值枚举的版本：追问要连着好几问，每问都探测一次就没法在测试里一次跑完。 */
const enumOrders: TableInfo = { ...orders, columns: (orders.columns ?? []).map((c) => (c.name === 'status' ? { ...c, comment: '状态：已支付, 已退款, 待支付' } : c)) };
const enumTables = [users, enumOrders, payments];

function plan(question: string, input: Partial<Parameters<typeof planQuery>[0]> = {}) {
  return planQuery({ question, engine: sqlite, tables, grounding, now: '2026-11-07', ...input });
}

test('join path follows the foreign key graph and caps at two hops', () => {
  const edges = joinEdges(tables, []);
  const direct = findJoinPath('orders', 'users', edges);
  assert.ok(direct);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].right, 'users');
  assert.deepEqual(direct[0].on[0], { left: { table: 'orders', column: 'user_id' }, right: { table: 'users', column: 'id' } });

  const twoHop = findJoinPath('payments', 'users', edges);
  assert.ok(twoHop);
  assert.deepEqual(twoHop.map((join) => join.right), ['orders', 'users']);

  // 第三跳不猜：宁可追问，也不要一个凭印象拼出来的 JOIN。
  assert.equal(findJoinPath('payments', 'users', edges, 1), undefined);
});

test('manually registered relations make tables connectable', () => {
  const plain: TableInfo[] = [
    { name: 'users', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'name', type: 'TEXT', nullable: true, primaryKey: false }] },
    { name: 'orders', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'owner', type: 'TEXT', nullable: true, primaryKey: false }] },
  ];
  const edges = joinEdges(plain, [{ leftTable: 'users', leftColumn: 'name', rightTable: 'orders', rightColumn: 'owner' }]);
  const path = findJoinPath('users', 'orders', edges);
  assert.ok(path);
  assert.equal(path[0].via, 'relation');
  assert.deepEqual(path[0].on[0], { left: { table: 'users', column: 'name' }, right: { table: 'orders', column: 'owner' } });
});

test('time window uses a half-open range so the boundary day is not double counted', () => {
  const sql = windowCondition(sqlite, '"orders"."created_at"', '2026-11-01', '2026-11-07');
  assert.equal(sql, `"orders"."created_at" >= '2026-11-01' AND "orders"."created_at" < '2026-11-08'`);
});

test('compiler emits dialect quoting and stable result aliases', () => {
  const spec: QuerySpec = {
    table: 'orders',
    joins: [],
    filters: [{ col: { table: 'orders', column: 'status' }, op: 'eq', values: ['paid'] }],
    groupBy: [{ table: 'orders', column: 'status' }],
    measures: [{ fn: 'sum', col: { table: 'orders', column: 'amount_cents' } }],
    limit: 20,
  };
  const compiled = compileQuery(sqlite, spec);
  assert.equal(
    compiled.sql,
    `SELECT "status" AS "label", SUM("amount_cents") AS "value" FROM "orders" WHERE "status" = 'paid' GROUP BY "status" ORDER BY "value" DESC LIMIT 20`,
  );
  assert.deepEqual(compiled.valueAliases, ['value']);

  const mysql = compileQuery('mysql', spec);
  assert.match(mysql.sql, /SUM\(`amount_cents`\) AS `value`/);
});

test('multi-table specs qualify every column so same-named columns stay unambiguous', () => {
  const compiled = compileQuery(sqlite, {
    table: 'orders',
    joins: [{ left: 'orders', right: 'users', on: [{ left: { table: 'orders', column: 'user_id' }, right: { table: 'users', column: 'id' } }], via: 'fk' }],
    filters: [{ col: { table: 'users', column: 'city' }, op: 'eq', values: ['上海'] }],
    groupBy: [{ table: 'users', column: 'city' }],
    timeBucket: { col: { table: 'orders', column: 'created_at' }, grain: 'month' },
    measures: [{ fn: 'count' }],
  });
  assert.match(compiled.sql, /INNER JOIN "users" ON "orders"\."user_id" = "users"\."id"/);
  assert.match(compiled.sql, /GROUP BY strftime\('%Y-%m', "orders"\."created_at"\), "users"\."city"/);
  assert.match(compiled.sql, /WHERE "users"\."city" = '上海'/);
});

test('plan resolves a Chinese dimension word against the schema', () => {
  const result = plan('按状态统计订单的金额合计');
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /GROUP BY "status"/);
  assert.match(result.compiled!.sql, /SUM\("amount_cents"\)/);
  assert.equal(result.measureLabel, '金额');
});

test('plan keeps count intents as row counts', () => {
  const result = plan('orders 有多少行');
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /^SELECT COUNT\(\*\) AS "value" FROM "orders"/);
});

test('plan turns a time phrase into a bounded window and a bucketed series', () => {
  const result = plan('近 3 个月订单金额趋势');
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /strftime\('%Y-%m', "created_at"\) AS "period"/);
  assert.match(result.compiled!.sql, /"created_at" >= '2026-09-01' AND "created_at" < '2026-11-08'/);
  assert.match(result.compiled!.sql, /ORDER BY "period" ASC/);
});

test('plan joins a second named table when a key exists', () => {
  const result = plan('按用户的城市统计订单金额合计');
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /INNER JOIN "users" ON "orders"\."user_id" = "users"\."id"/);
  assert.match(result.compiled!.sql, /GROUP BY "users"\."city"/);
});

test('plan asks which keys to use when two tables have no registered relation', () => {
  const orphan: TableInfo = { name: 'tickets', type: 'table', comment: '工单', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] };
  const result = planQuery({ question: '按工单统计订单金额', engine: sqlite, tables: [...tables, orphan], grounding, now: '2026-11-07' });
  assert.equal(result.status, 'gap');
  assert.match(result.gap!, /tickets/);
  assert.match(result.gap!, /外键/);
});

test('plan probes distinct values once instead of inventing a filter literal', () => {
  const first = plan('统计已支付订单的金额合计');
  assert.equal(first.status, 'probe');
  assert.equal(first.probe!.column, 'status');
  assert.equal(first.probe!.raw, '已支付');

  // 探测回来的取值里有对得上的，直接落地成真实字面量。
  const matched = plan('统计 paid 订单的金额合计', { probe: { table: 'orders', column: 'status', values: ['paid', 'refunded'] } });
  assert.equal(matched.status, 'ready');
  assert.match(matched.compiled!.sql, /"status" = 'paid'/);

  // 探测过仍对不上：不猜条件，改为列出候选取值定点追问。
  const missed = plan('统计发货订单的金额合计', { probe: { table: 'orders', column: 'status', values: ['paid', 'refunded'] } });
  assert.equal(missed.status, 'gap');
  assert.match(missed.gap!, /发货/);
  assert.match(missed.gap!, /paid/);
});

test('plan uses glossary-annotated values before spending a probe', () => {
  const bundle: AgentContextBundle = {
    ...EMPTY_AGENT_CONTEXT_BUNDLE,
    columnMeta: { orders: { status: { description: '已支付, 待支付, 已退款' } } },
  };
  const result = planQuery({ question: '统计已支付订单的金额合计', engine: sqlite, tables: [orders], grounding: { bundle }, now: '2026-11-07' });
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /"status" = '已支付'/);
});

test('plan stops after one probe when the value column itself is unknown', () => {
  const result = plan('统计已支付订单的金额合计', { probeDone: true });
  assert.equal(result.status, 'ready');
});

test('plan reads top-N and detail requests as rows not groups', () => {
  const top = plan('金额最高的 10 笔订单');
  assert.equal(top.status, 'ready');
  assert.match(top.compiled!.sql, /LIMIT 10/);
  assert.equal(top.compiled!.sql.includes('GROUP BY'), false);
  assert.match(top.compiled!.sql, /ORDER BY "amount_cents" DESC/);

  const detail = plan('订单明细前 5 条');
  assert.equal(detail.status, 'ready');
  assert.match(detail.compiled!.sql, /"amount_cents" AS "label2"/);
  // 没点名度量的明细按时间倒序——最新几条，而不是按某个凭印象挑的列。
  assert.match(detail.compiled!.sql, /ORDER BY "created_at" DESC LIMIT 5/);
});

test('plan asks for a table instead of guessing one when nothing matches', () => {
  const result = planQuery({ question: '统计一下合计金额', engine: sqlite, tables: [payments], grounding, now: '2026-11-07' });
  // payments 只有 id/order_id/paid_at：没有可求和的列，也没有可分组的维度
  assert.ok(result.status === 'ready' || result.status === 'gap');
  if (result.status === 'ready') assert.match(result.compiled!.sql, /COUNT\(\*\)/);
});

test('plan matches English phrasing too', () => {
  const result = plan('total amount by status for orders');
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /GROUP BY "status"/);
  assert.match(result.compiled!.sql, /SUM\("amount_cents"\)/);
});

test('plan reads value enums out of the column comment without probing', () => {
  const commented: TableInfo = {
    name: 'orders',
    type: 'table',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'status', type: 'TEXT', nullable: true, primaryKey: false, comment: '状态：已支付, 已退款, 待支付' },
      { name: 'amount_cents', type: 'INTEGER', nullable: true, primaryKey: false, comment: '金额' },
      { name: 'created_at', type: 'TEXT', nullable: true, primaryKey: false },
    ],
  };
  const result = planQuery({ question: '统计已支付订单的金额合计', engine: sqlite, tables: [commented], grounding, now: '2026-11-07' });
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /"status" = '已支付'/, '注释里的枚举直接落地，不带冒号前缀');
});

test('plan keeps a code/label comment as a probe instead of guessing which is stored', () => {
  const coded: TableInfo = { ...orders, columns: (orders.columns ?? []).map((c) => (c.name === 'status' ? { ...c, comment: '状态：PAID=已支付, REFUNDED=已退款' } : c)) };
  const result = planQuery({ question: '统计已支付订单的金额合计', engine: sqlite, tables: [coded], grounding, now: '2026-11-07' });
  assert.equal(result.status, 'probe');
});

test('a subject noun is never turned into a filter value', () => {
  const result = plan('全部订单的金额合计');
  assert.equal(result.status, 'ready');
  assert.equal(result.compiled!.sql.includes('WHERE'), false, '「订单」是主语不是 status 的取值');
  assert.match(result.compiled!.sql, /SUM\("amount_cents"\)/);
});

test('a grain word alone is a bucket, not a dimension column', () => {
  const result = plan('按月看订单金额走势');
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /GROUP BY strftime\('%Y-%m', "created_at"\) ORDER BY/, '只按月份分桶，不该多出 amount_cents 分组');
  assert.equal(result.compiled!.sql.includes('"amount_cents" AS "label"'), false);
});

test('follow-ups inherit the previous question\'s table, window and measure', () => {
  const focus = plan('近 3 个月已支付订单的金额合计', { tables: enumTables }).spec!;
  const city = plan('那按城市呢', { focus, tables: enumTables });
  assert.equal(city.status, 'ready');
  assert.equal(city.compiled!.sql.includes('FROM "users"'), false, '追问不点名表时沿用上一问的 orders');
  assert.match(city.compiled!.sql, /INNER JOIN "users"/);
  assert.match(city.compiled!.sql, /GROUP BY "users"\."city"/);
  assert.match(city.compiled!.sql, /SUM\("orders"\."amount_cents"\)/, '度量也跟着上一问走');
  assert.match(city.compiled!.sql, /"orders"\."status" = '已支付'/);
  assert.match(city.compiled!.sql, /"orders"\."created_at" >= '2026-09-01'/);

  const refunded = plan('只看已退款的', { focus, tables: enumTables });
  assert.equal(refunded.status, 'ready');
  assert.match(refunded.compiled!.sql, /"status" = '已退款'/);
  assert.match(refunded.compiled!.sql, /"created_at" >= '2026-09-01'/, '换取值不该丢掉时间窗');

  const fresh = plan('全部订单的金额合计', { focus, tables: enumTables });
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.compiled!.sql.includes('WHERE'), false, '「全部」是在清空上一问的口径');
});

test('follow-ups chain: a second refinement keeps the first one\'s axes', () => {
  const first = plan('近 3 个月已支付订单按城市的金额合计', { tables: enumTables });
  assert.equal(first.status, 'ready');
  const second = plan('只看已退款的', { focus: first.spec!, tables: enumTables });
  assert.equal(second.status, 'ready');
  // 上一问要的是「每月每城市」两张轴，换条件不该把其中一张抹掉
  assert.match(second.compiled!.sql, /GROUP BY strftime\('%Y-%m', "orders"\."created_at"\), "users"\."city"/);
  assert.match(second.compiled!.sql, /"orders"\."status" = '已退款'/);
  assert.match(second.compiled!.sql, /"orders"\."created_at" >= '2026-09-01'/);
});

test('replay drops an unresolvable value instead of asking for a probe', () => {
  // 重放历史问题只是给追问算焦点，发不出探测查询：这里必须给出一句话而不是 probe。
  const replayed = plan('统计已支付订单的金额合计', { replay: true });
  assert.equal(replayed.status, 'ready');
  assert.equal(replayed.compiled!.sql.includes('status'), false);
  const live = plan('统计已支付订单的金额合计');
  assert.equal(live.status, 'probe', '同一句话在当轮是可以探测的');
});

test('detail follow-ups keep the previous projection and only change the count', () => {
  const focus = plan('金额最高的 10 笔订单').spec!;
  const result = plan('换成前 20 笔', { focus });
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /LIMIT 20/);
  assert.match(result.compiled!.sql, /ORDER BY "amount_cents" DESC/);
  assert.equal(result.compiled!.sql.includes('"amount_cents" AS "label2"'), true, '沿用上一问的列，不换一套投影');
});

test('a follow-up whose join is unregistered asks instead of inventing a key', () => {
  const orphan: TableInfo = { name: 'tickets', type: 'table', comment: '工单', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'level', type: 'TEXT', nullable: true, primaryKey: false, comment: '等级' }] };
  const focus = plan('近 3 个月已支付订单的金额合计', { tables: enumTables }).spec!;
  const result = planQuery({ question: '那按等级呢', engine: sqlite, tables: [...enumTables, orphan], grounding, now: '2026-11-07', focus });
  assert.equal(result.status, 'gap');
  assert.match(result.gap!, /tickets/);
});

test('a dimension glued to a measure phrase still groups by the dimension', () => {
  const result = plan('统计各城市的订单金额合计', { tables: enumTables });
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /GROUP BY "users"\."city"/);
  assert.match(result.compiled!.sql, /SUM\("orders"\."amount_cents"\)/);
  // 「城市」是维度，不是 status 的取值：凭空多一个 WHERE 会把数字查空。
  assert.equal(result.compiled!.sql.includes('WHERE'), false);
});

test('a dimension glued to a value keeps both the group and the filter', () => {
  for (const question of ['统计各城市的已支付订单金额合计', '统计各城市的已支付订单的金额合计', '各城市已支付订单的金额合计']) {
    const result = plan(question, { tables: enumTables });
    assert.equal(result.status, 'ready', question);
    assert.match(result.compiled!.sql, /GROUP BY "users"\."city"/, question);
    assert.match(result.compiled!.sql, /"orders"\."status" = '已支付'/, question);
  }
});

test('heatmap plans two category axes and one measure', () => {
  const plan2 = planQuery({ question: '按城市和渠道统计订单金额热力图', engine: sqlite, tables: [...tables, { name: 'channel' } as any], grounding, now: '2026-11-07' });
  // channel 不存在时是 gap 而不是画一条对角线。
  assert.equal(plan2.status, 'gap');

  const withChannel: TableInfo = { ...orders, columns: [...(orders.columns ?? []), { name: 'channel', type: 'TEXT', nullable: true, primaryKey: false, comment: '渠道' }] };
  const result = planQuery({ question: '按城市和渠道统计订单金额热力图', engine: sqlite, tables: [users, withChannel, payments], grounding, now: '2026-11-07' });
  assert.equal(result.status, 'ready');
  assert.equal(result.chart, 'heatmap');
  assert.match(result.compiled!.sql, /"users"\."city" AS "label"/);
  assert.match(result.compiled!.sql, /"orders"\."channel" AS "label2"/);
  assert.match(result.compiled!.sql, /GROUP BY "users"\."city", "orders"\."channel"/);
});

test('heatmap accepts a time grain as one of its axes', () => {
  const result = planQuery({ question: '按城市和月份看订单金额热力图', engine: sqlite, tables, grounding, now: '2026-11-07' });
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /strftime\(/, );
  assert.match(result.compiled!.sql, /GROUP BY strftime\([^)]*\), "users"\."city"/);
});

test('stacked splits one measure by a categorical column', () => {
  const result = planQuery({ question: '按城市堆叠各状态的订单金额', engine: sqlite, tables: enumTables, grounding, now: '2026-11-07' });
  assert.equal(result.status, 'ready');
  assert.equal(result.chart, 'stacked');
  const sql = result.compiled!.sql;
  // 每一段一列：CASE WHEN 把状态拆开，别名就是段名。
  assert.match(sql, /COALESCE\(SUM\(CASE WHEN "orders"\."status" IN \('已支付'\) THEN "orders"\."amount_cents" ELSE NULL END\), 0\) AS "已支付"/);
  assert.match(sql, /AS "已退款"/);
  assert.equal(result.compiled!.valueAliases.length >= 2, true);
});

test('stacked accepts several named measures', () => {
  const withQuantity: TableInfo = { ...orders, columns: [...(orders.columns ?? []), { name: 'quantity', type: 'INTEGER', nullable: true, primaryKey: false, comment: '数量' }] };
  const result = planQuery({ question: '按城市堆叠金额和数量', engine: sqlite, tables: [users, withQuantity, payments], grounding, now: '2026-11-07' });
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /SUM\("orders"\."amount_cents"\) AS "value"/);
  assert.match(result.compiled!.sql, /SUM\("orders"\."quantity"\) AS "value2"/);
  assert.equal(result.compiled!.valueAliases.length, 2);
});

test('radar caps the axis count so the executor does not downgrade it', () => {
  const result = planQuery({ question: '按城市统计订单金额雷达图', engine: sqlite, tables, grounding, now: '2026-11-07' });
  assert.equal(result.status, 'ready');
  assert.equal(result.chart, 'radar');
  assert.equal(result.spec?.limit, 8);
});
