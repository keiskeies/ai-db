import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContextBundle, DatabaseSchema, Memory } from '../src/types';
import { buildReportBrief, formatReportBriefForPrompt } from '../src/commands/reportBrief';

const context: AgentContextBundle = {
  connectionId: 'c1',
  database: 'shop',
  disabledTables: [],
  disabledColumns: {},
  tableMeta: { orders: { alias: '交易单据', description: '已支付订单主表' } },
  columnMeta: {
    orders: {
      order_amount: { alias: '成交金额', description: '实付金额，不含取消订单' },
      channel: { alias: '获客渠道' },
    },
    customers: { region: { alias: '所在地区' } },
  },
  relations: [],
};

const databases: DatabaseSchema[] = [{
  name: 'shop',
  tables: [
    {
      name: 'orders', type: 'table', rowEstimate: 10000,
      columns: [
        { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
        { name: 'customer_id', type: 'bigint', nullable: false, primaryKey: false },
        { name: 'order_amount', type: 'decimal(18,2)', nullable: false, primaryKey: false },
        { name: 'channel', type: 'varchar(32)', nullable: true, primaryKey: false },
        { name: 'paid_at', type: 'datetime', nullable: true, primaryKey: false },
      ],
      foreignKeys: [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
    },
    {
      name: 'customers', type: 'table', rowEstimate: 2000,
      columns: [
        { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
        { name: 'region', type: 'varchar(32)', nullable: true, primaryKey: false },
      ],
    },
    { name: 'audit_logs', type: 'table', rowEstimate: 90000, columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }] },
  ],
}];

function glossary(partial: Partial<Memory>): Memory {
  return {
    id: 'm1', scopeType: 'connection', scopeKey: 'c1', kind: 'glossary', title: '成交额', content: '按 orders.order_amount 汇总已支付订单。', tags: [], synonyms: [], importance: 5, confidence: 1, pinned: true, archived: false, useCount: 0, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...partial,
  };
}

test('需求扩写携带业务别名、字段角色和外键，而不是只有自然语言问题', () => {
  const brief = buildReportBrief({ topic: '为什么成交额下滑', databases, context });
  assert.equal(brief.mode, 'diagnosis');
  assert.equal(brief.coverage.requireAttribution, true);
  assert.equal(brief.coverage.requireAnomaly, true);
  const orders = brief.grounding.tables.find((table) => table.name === 'orders');
  assert.ok(orders);
  assert.equal(orders.alias, '交易单据');
  assert.equal(orders.columns.find((column) => column.name === 'order_amount')?.role, 'metric');
  assert.equal(orders.columns.find((column) => column.name === 'order_amount')?.alias, '成交金额');
  assert.equal(orders.columns.find((column) => column.name === 'paid_at')?.role, 'time');
  assert.ok(brief.grounding.tables.some((table) => table.name === 'customers'));
  assert.ok(brief.grounding.joins.some((join) => join.leftTable === 'shop.orders' && join.rightTable === 'shop.customers'));
});

test('分析计划每一步都绑定候选表与字段，首步明确做对象/口径确认', () => {
  const brief = buildReportBrief({ topic: '看看离季度成交额目标还差多少', audience: 'executive', databases, context });
  assert.equal(brief.mode, 'target');
  assert.equal(brief.audience, 'executive');
  assert.equal(brief.plan[0].id, 'bind');
  assert.ok(brief.plan[0].tables.includes('shop.orders'));
  assert.ok(brief.plan[0].columns.includes('shop.orders.order_amount'));
  assert.ok(brief.plan[0].columns.includes('shop.orders.paid_at'));
  assert.ok(brief.plan.some((step) => step.analyses.includes('target')));
  const prompt = formatReportBriefForPrompt(brief);
  assert.match(prompt, /business-word → table\/column mapping/);
  assert.match(prompt, /shop\.orders\.order_amount/);
  assert.match(prompt, /Allowed join paths/);
});

test('术语同义词和标准 SQL 能把用户简称关联到正确表', () => {
  const brief = buildReportBrief({
    topic: 'GMV 最近怎么样',
    databases,
    context,
    glossary: [glossary({ title: '成交额', synonyms: ['GMV'] })],
    sqlExamples: [{ ...glossary({ id: 's1', kind: 'sql_example', title: '月度成交额', content: 'SELECT SUM(order_amount) FROM orders GROUP BY paid_at', synonyms: [] }) }],
  });
  assert.ok(brief.grounding.tables.some((table) => table.name === 'orders'));
  assert.ok(brief.grounding.businessTerms.some((term) => term.synonyms.includes('GMV')));
  assert.ok(brief.normalizedTopic.includes('orders.order_amount'));
});

test('JOIN 只引用最终保留且同库启用的表，截断后不留下悬空端点', () => {
  const names = Array.from({ length: 12 }, (_, index) => `t${index + 1}`);
  const shop: DatabaseSchema = {
    name: 'shop',
    tables: names.map((name) => ({ name, type: 'table', columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }] })),
  };
  const archive: DatabaseSchema = {
    name: 'archive',
    tables: [
      { name: 'orders', type: 'table', columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }], foreignKeys: [{ columns: ['id'], refTable: 'customers', refColumns: ['id'] }] },
      { name: 'customers', type: 'table', columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }] },
    ],
  };
  const brief = buildReportBrief({
    topic: '整体经营概览',
    databases: [shop, archive],
    focusTables: names,
    context: {
      ...context,
      relations: [
        { leftTable: 't1', leftColumn: 'id', rightTable: 'missing', rightColumn: 'id' },
        { leftTable: 't1', leftColumn: 'id', rightTable: 't2', rightColumn: 'id' },
      ],
    },
  });
  const retained = new Set(brief.grounding.tables.map((table) => `${table.database}.${table.name}`));
  assert.equal(brief.grounding.tables.length, 12);
  assert.ok(brief.grounding.joins.length > 0);
  for (const join of brief.grounding.joins) {
    assert.ok(retained.has(join.leftTable), join.leftTable);
    assert.ok(retained.has(join.rightTable), join.rightTable);
    assert.equal(join.leftTable.split('.')[0], join.rightTable.split('.')[0]);
  }
});

test('用户选表优先，禁用表不会进入 grounding 或计划', () => {
  const disabled = { ...context, disabledTables: ['customers', 'audit_logs'] };
  const brief = buildReportBrief({ topic: '整体经营概览', databases, context: disabled, focusTables: ['orders'] });
  assert.ok(brief.grounding.tables.some((table) => table.name === 'orders'));
  assert.ok(!brief.grounding.tables.some((table) => table.name === 'customers'));
  assert.ok(brief.plan.every((step) => !step.tables.some((table) => table.endsWith('.audit_logs'))));
  assert.equal(brief.grounding.tables.find((table) => table.name === 'orders')?.matchReason, '用户指定');
});
