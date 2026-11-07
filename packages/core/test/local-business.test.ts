import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContextBundle, Engine, Memory, TableInfo } from '../src/types';
import { EMPTY_AGENT_CONTEXT_BUNDLE } from '../src/types';
import type { GroundingOptions } from '../src/agent/local/schema';
import { forbiddenFromGlossary, isColumnForbidden, isTableForbidden, matchSqlExample } from '../src/agent/local/business';
import { planQuery } from '../src/agent/local/parse';

const sqlite: Engine = 'sqlite';
const iso = new Date('2026-11-01T00:00:00.000Z').toISOString();

const orders: TableInfo = {
  name: 't_order',
  comment: '订单',
  type: 'table',
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'status', type: 'VARCHAR(20)', nullable: true, primaryKey: false, comment: '状态' },
    { name: 'money', type: 'DECIMAL(10,2)', nullable: true, primaryKey: false, comment: '实付金额' },
    { name: 'created_timestamp', type: 'DATETIME', nullable: true, primaryKey: false },
  ],
};

const payFlow: TableInfo = {
  name: 't_trade_pay_flow',
  comment: '支付流水',
  type: 'table',
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'order_sn', type: 'VARCHAR(32)', nullable: true, primaryKey: false },
    { name: 'pay_amount', type: 'DECIMAL(10,2)', nullable: true, primaryKey: false, comment: '金额' },
  ],
};

const refund: TableInfo = {
  name: 't_order_refund',
  comment: '退款单',
  type: 'table',
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'sn', type: 'VARCHAR(32)', nullable: true, primaryKey: false },
  ],
};

const tables = [orders, payFlow, refund];
const grounding: GroundingOptions = { bundle: EMPTY_AGENT_CONTEXT_BUNDLE };

function glossaryMemory(title: string, content: string): Memory {
  return { id: title, scopeType: 'global', scopeKey: '*', kind: 'glossary', title, content, tags: [], importance: 0.8, confidence: 0.9, pinned: false, archived: false, useCount: 0, createdAt: iso, updatedAt: iso };
}

function exampleMemory(title: string, content: string): Memory {
  return { ...glossaryMemory(title, content), kind: 'sql_example' };
}

test('anti-pattern only forbids the table its negative clause names', () => {
  const forbidden = forbiddenFromGlossary([glossaryMemory('反例：订单数不要用支付流水', '统计订单笔数必须用 t_order；t_trade_pay_flow 一行不是一笔订单。')], tables, grounding);
  assert.equal(isTableForbidden(forbidden, 't_trade_pay_flow'), true);
  // 被推荐的那张表不能被禁：同一句话里两个表名都在，只有否定分句算数。
  assert.equal(isTableForbidden(forbidden, 't_order'), false);
  assert.equal(forbidden.reasons.length, 1);
});

test('anti-patterns match table names case-insensitively and ignore ordinary terms', () => {
  const forbidden = forbiddenFromGlossary([glossaryMemory('GMV', '已完成订单（T_ORDER.status = \'COMPLETE\'）的 money 合计')], tables, grounding);
  assert.equal(forbidden.tables.size, 0);
  assert.equal(forbidden.columns.size, 0);
});

test('a bare column named in an anti-pattern is only forbidden when unique', () => {
  const ambiguous = forbiddenFromGlossary([glossaryMemory('反例：id 不要直接展示', 'order_sn 和 id 都不该出现在答案里，用 sn 定位')], tables, grounding);
  assert.equal(ambiguous.columns.has('t_order.id'), false);
  assert.equal(ambiguous.columns.has('t_trade_pay_flow.id'), false);

  const unique = forbiddenFromGlossary([glossaryMemory('反例：不要用退款流水号', '统计退款不要按 sn 关联，sn 是流水号不是订单号')], tables, grounding);
  assert.equal(isColumnForbidden(unique, 't_order_refund', 'sn'), true);
});

test('planner refuses the table an anti-pattern forbids and quotes the reason', () => {
  const bundle: AgentContextBundle = { ...EMPTY_AGENT_CONTEXT_BUNDLE };
  const glossary = [glossaryMemory('反例：订单数不要用支付流水', '统计订单笔数必须用 t_order；t_trade_pay_flow 是支付流水，一行不等于一笔订单。')];
  const result = planQuery({ question: 't_trade_pay_flow 有多少行', engine: sqlite, tables, grounding: { ...grounding, bundle }, forbidden: forbiddenFromGlossary(glossary, tables, grounding) });
  assert.equal(result.status, 'gap');
  assert.match(result.gap!, /t_trade_pay_flow/);
  assert.match(result.gap!, /一行不等于一笔订单/);
});

test('forbidden columns drop out of measure selection', () => {
  const forbidden = forbiddenFromGlossary([glossaryMemory('反例：pay_amount 不是订单金额', '统计金额用 t_order.money；pay_amount 不含手续费，不要用。')], tables, grounding);
  const result = planQuery({ question: 't_trade_pay_flow 的金额合计', engine: sqlite, tables, grounding, forbidden });
  // t_trade_pay_flow 唯一的数值列被禁了：宁可说没有可用列，也不要给一个口径错的数字。
  assert.ok(result.status === 'gap' || !/SUM\("pay_amount"\)/.test(result.compiled?.sql ?? ''), result.compiled?.sql ?? result.gap ?? '');
});

test('a registered example SQL wins over the planner', () => {
  const sqlExamples = [exampleMemory('上月各支付渠道 GMV', "SELECT status, ROUND(SUM(money), 2) AS gmv FROM t_order WHERE status = 'COMPLETE' GROUP BY status ORDER BY gmv DESC")];
  const match = matchSqlExample('上月各支付渠道 GMV 是多少', tables, { bundle: EMPTY_AGENT_CONTEXT_BUNDLE, sqlExamples });
  assert.ok(match);
  assert.match(match.sql, /status = 'COMPLETE'/);
});

test('example matching stays conservative', () => {
  const sqlExamples = [exampleMemory('每月活跃买家数', 'SELECT created_timestamp, COUNT(DISTINCT id) AS buyers FROM t_order GROUP BY created_timestamp')];
  const byExample = matchSqlExample('按月看活跃买家数', tables, { bundle: EMPTY_AGENT_CONTEXT_BUNDLE, sqlExamples });
  assert.ok(byExample, '同话题应命中');

  // 不相关的问题不能被套上示例口径——错口径比没口径更糟。
  assert.equal(matchSqlExample('退款单有多少条', tables, { bundle: EMPTY_AGENT_CONTEXT_BUNDLE, sqlExamples }), undefined);
  // 写语句、多语句、点了被禁表名的示例都不套用。
  assert.equal(matchSqlExample('上月各支付渠道 GMV', tables, { bundle: EMPTY_AGENT_CONTEXT_BUNDLE, sqlExamples: [exampleMemory('删除', 'DELETE FROM t_order')] }), undefined);
  assert.equal(
    matchSqlExample('上月各支付渠道 GMV', tables, {
      bundle: EMPTY_AGENT_CONTEXT_BUNDLE,
      sqlExamples: [exampleMemory('流水 GMV', 'SELECT SUM(pay_amount) AS gmv FROM t_trade_pay_flow')],
    }, forbiddenFromGlossary([glossaryMemory('反例：订单数不要用支付流水', '统计订单笔数必须用 t_order；t_trade_pay_flow 一行不等于一笔订单')], tables, grounding)),
    undefined,
  );
});

test('provider-side plan still compiles when examples exist but do not match', () => {
  const result = planQuery({ question: '按状态统计订单金额合计', engine: sqlite, tables, grounding });
  assert.equal(result.status, 'ready');
  assert.match(result.compiled!.sql, /GROUP BY "status"/);
});
