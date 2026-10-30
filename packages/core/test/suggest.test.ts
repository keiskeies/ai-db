import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleAgentContext } from '../src/agent/context';
import { disabledTableInSql, isDimensionColumn, isMeasureColumn, isTimeColumn, suggestFollowUps, suggestQuestions, tablesFromSql, type QuestionSuggestion } from '../src/agent/suggest';
import type { AgentContextEntry, ColumnInfo, DatabaseSchema, TableInfo } from '../src/types';

const iso = new Date('2026-10-27T00:00:00.000Z').toISOString();

const col = (name: string, type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({ name, type, nullable: true, primaryKey: false, ...extra });

const orders: TableInfo = {
  name: 'orders',
  type: 'table',
  rowEstimate: 5000,
  columns: [
    col('id', 'INT', { primaryKey: true, autoIncrement: true }),
    col('user_id', 'INT'),
    col('amount', 'DECIMAL(12,2)'),
    col('status', 'VARCHAR(20)'),
    col('created_at', 'DATETIME'),
  ],
  foreignKeys: [{ name: 'fk_orders_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
};

const users: TableInfo = {
  name: 'users',
  type: 'table',
  columns: [col('id', 'INT', { primaryKey: true }), col('name', 'VARCHAR(64)'), col('city', 'VARCHAR(32)')],
};

const logTable: TableInfo = {
  name: 'audit_log',
  type: 'table',
  columns: [col('id', 'INT', { primaryKey: true }), col('message', 'TEXT')],
};

const schema: DatabaseSchema[] = [{ name: 'shop', tables: [orders, users, logTable, { name: 'v_orders', type: 'view', columns: [col('id', 'INT')] }] }];

function ctxEntry(partial: Partial<AgentContextEntry> & { kind: AgentContextEntry['kind']; table: string }): AgentContextEntry {
  return { id: `${partial.kind}-${partial.table}`, connectionId: 'c1', database: 'shop', enabled: true, createdAt: iso, updatedAt: iso, ...partial };
}

const kinds = (list: QuestionSuggestion[]) => list.map((s) => s.kind);

// ---------- column role detection ----------

test('column roles are detected conservatively', () => {
  assert.equal(isTimeColumn(col('created_at', 'DATETIME')), true);
  assert.equal(isTimeColumn(col('birthday', 'DATE')), true);
  assert.equal(isTimeColumn(col('year_month', 'VARCHAR(7)')), true, '名称含 month 也按时间处理');
  assert.equal(isTimeColumn(col('amount', 'DECIMAL(12,2)')), false);

  const fk = new Set(['user_id']);
  assert.equal(isMeasureColumn(col('amount', 'DECIMAL(12,2)'), fk), true);
  assert.equal(isMeasureColumn(col('total_cents', 'BIGINT'), fk), true);
  assert.equal(isMeasureColumn(col('user_id', 'INT'), fk), false, '外键列不是度量');
  assert.equal(isMeasureColumn(col('owner_id', 'INT'), fk), false, '没有外键约束的 *_id 列也不是度量');
  assert.equal(isMeasureColumn(col('id', 'INT'), fk), false, '裸 id 列不是度量');
  assert.equal(isMeasureColumn(col('order_no', 'BIGINT'), fk), false, '单号类数值列不是度量');
  assert.equal(isMeasureColumn(col('id', 'INT', { primaryKey: true }), fk), false, '主键不是度量');
  assert.equal(isMeasureColumn(col('created_at', 'DATETIME'), fk), false, '时间列不是度量');
  assert.equal(isMeasureColumn(col('status', 'VARCHAR(20)'), fk), false);

  assert.equal(isDimensionColumn(col('status', 'VARCHAR(20)')), true);
  assert.equal(isDimensionColumn(col('city', 'VARCHAR(32)')), true);
  assert.equal(isDimensionColumn(col('amount', 'DECIMAL(12,2)')), false);
  assert.equal(isDimensionColumn(col('id', 'INT', { primaryKey: true })), false);
});

test('tablesFromSql pulls table names out of real statements', () => {
  assert.deepEqual(tablesFromSql('SELECT * FROM orders o JOIN users u ON u.id = o.user_id').sort(), ['orders', 'users']);
  assert.deepEqual(tablesFromSql('UPDATE orders SET status = 1'), ['orders']);
  assert.deepEqual(tablesFromSql('INSERT INTO audit_log (a) VALUES (1)'), ['audit_log']);
  assert.deepEqual(tablesFromSql('select * from `Orders`'), ['orders']);
  assert.deepEqual(tablesFromSql(''), []);
});

test('disabledTableInSql hard-blocks SQL referencing a disabled table', () => {
  assert.equal(disabledTableInSql('SELECT COUNT(*) FROM t_order', ['t_trade_pay_flow']), undefined);
  assert.equal(
    disabledTableInSql('SELECT * FROM t_order o JOIN t_trade_pay_flow p ON p.order_no = o.order_sn', ['t_trade_pay_flow']),
    't_trade_pay_flow',
  );
  assert.equal(disabledTableInSql('UPDATE T_TRADE_PAY_FLOW SET flag = 0', ['t_trade_pay_flow']), 't_trade_pay_flow');
  assert.equal(disabledTableInSql('SELECT * FROM t_order o, t_trade_pay_flow p', ['t_trade_pay_flow']), 't_trade_pay_flow');
  assert.equal(disabledTableInSql('SELECT * FROM other_db.t_trade_pay_flow', ['t_trade_pay_flow']), 't_trade_pay_flow');
  assert.equal(disabledTableInSql('SELECT 1', ['t_trade_pay_flow']), undefined);
  assert.equal(disabledTableInSql('SELECT * FROM t_order', []), undefined);
});

// ---------- suggestion generation ----------

test('returns nothing when there is no schema to reason about', () => {
  assert.deepEqual(suggestQuestions(undefined), []);
  assert.deepEqual(suggestQuestions([]), []);
  assert.deepEqual(suggestQuestions([{ name: 'empty', tables: [] }]), []);
});

test('generates trend questions only when a time column actually exists', () => {
  const withTime = suggestQuestions([{ name: 'shop', tables: [orders] }], { limit: 12 });
  const trend = withTime.find((s) => s.kind === 'trend');
  assert.ok(trend, '有时间列时应给出趋势问题');
  assert.match(trend.prompt, /近 12 个月/);
  assert.match(trend.prompt, /amount/, '应挑中数值列作为度量');

  const noTime = suggestQuestions([{ name: 'shop', tables: [users] }], { limit: 12 });
  assert.ok(!noTime.some((s) => s.kind === 'trend'), '没有时间列就不该编造趋势问题');
});

test('trend never picks an identifier column as the measure', () => {
  // demo 库里 events 只有 user_id 这个数值列，没有真正的度量
  const events: TableInfo = {
    name: 'events',
    type: 'table',
    columns: [col('id', 'INT', { primaryKey: true }), col('user_id', 'INT'), col('type', 'VARCHAR(32)'), col('created_at', 'DATETIME')],
  };
  const list = suggestQuestions([{ name: 'shop', tables: [events] }], { limit: 12 });
  const trend = list.find((s) => s.kind === 'trend');
  assert.ok(trend, '仍应给出趋势问题');
  assert.ok(!trend.prompt.includes('user_id'), `不应对标识符列求趋势：${trend.prompt}`);
  assert.match(trend.prompt, /记录数趋势/, '没有合适度量时退回记录数');
});

test('covers group / topn / relation / quality and explains each recommendation', () => {
  const list = suggestQuestions(schema, { limit: 12, maxPerKind: 3 });
  const set = new Set(kinds(list));
  for (const kind of ['trend', 'group', 'topn', 'quality', 'relation']) assert.ok(set.has(kind as QuestionSuggestion['kind']), `缺少 ${kind} 类推荐`);
  assert.ok(list.every((s) => s.reason.length > 0), '每条推荐都要说明依据');
  assert.ok(list.every((s) => s.prompt.length > 0));
  assert.ok(list.every((s) => s.id.length > 0));
  assert.ok(!list.some((s) => s.table === 'v_orders'), '视图不参与推荐');
});

test('topn and relation require a real foreign key', () => {
  const noFk = suggestQuestions([{ name: 'shop', tables: [users, logTable] }], { limit: 12 });
  assert.ok(!noFk.some((s) => s.kind === 'topn' || s.kind === 'relation'));
});

test('limit is honoured and results stay varied instead of one kind dominating', () => {
  const list = suggestQuestions(schema, { limit: 6 });
  assert.equal(list.length, 6);
  const counts = new Map<string, number>();
  for (const s of list) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 2, `默认每类最多 2 条，实际 ${JSON.stringify([...counts])}`);
  assert.ok(counts.size >= 3, '至少覆盖 3 类问题');
  assert.equal(new Set(list.map((s) => s.prompt)).size, list.length, '推荐问题不得重复');
  assert.ok(Number.isFinite(suggestQuestions(schema, { limit: 99 }).length));
  assert.ok(suggestQuestions(schema, { limit: 0 }).length >= 1, 'limit 下限被夹到 1');
});

test('business context narrows and humanises the suggestions', () => {
  const bundle = bundleAgentContext(
    [ctxEntry({ kind: 'table', table: 'audit_log', enabled: false }), ctxEntry({ kind: 'table', table: 'orders', alias: '订单表' }), ctxEntry({ kind: 'column', table: 'orders', column: 'amount', alias: '订单金额' })],
    { connectionId: 'c1', database: 'shop' },
  );
  const list = suggestQuestions(schema, { limit: 12, bundle });
  assert.ok(!list.some((s) => s.table === 'audit_log'), '被禁用的表不参与推荐');
  assert.ok(!list.some((s) => s.prompt.includes('audit_log')));
  assert.ok(list.some((s) => s.prompt.includes('订单表')), '推荐语应使用业务别名');
  assert.ok(list.some((s) => s.prompt.includes('订单金额')), '列别名同样生效');
});

test('recently queried tables are recommended first', () => {
  const cold = suggestQuestions(schema, { limit: 4 });
  const warm = suggestQuestions(schema, { limit: 4, history: ['audit_log'] });
  assert.ok(warm.some((s) => s.table === 'audit_log'), '最近查过的表应进入推荐');
  assert.notDeepEqual(kinds(cold), kinds(warm));
});

// ---------- follow-ups ----------

test('follow-ups are scoped to the tables this turn actually touched', () => {
  const list = suggestFollowUps({ schemas: schema, tables: ['orders'], usedTools: ['run_sql'], limit: 3 });
  assert.ok(list.length > 0);
  assert.equal(list.length, 3);
  assert.ok(list.every((s) => s.table === 'orders'), `只应围绕 orders：${JSON.stringify(list.map((s) => s.table))}`);
});

test('follow-ups do not repeat what the agent already did', () => {
  const afterQuality = suggestFollowUps({ schemas: schema, tables: ['orders'], usedTools: ['check_data_quality'], limit: 3 });
  assert.ok(!afterQuality.some((s) => s.kind === 'quality'), '刚做过质量检查就不该再推荐质量检查');

  const afterChart = suggestFollowUps({ schemas: schema, tables: ['orders'], usedTools: ['render_chart'], limit: 3 });
  assert.ok(!afterChart.some((s) => s.kind === 'trend'), '刚画过趋势图就不该再推荐趋势');
});

test('follow-ups are empty without tables or schema', () => {
  assert.deepEqual(suggestFollowUps({ schemas: schema, tables: [], usedTools: [] }), []);
  assert.deepEqual(suggestFollowUps({ schemas: undefined, tables: ['orders'], usedTools: [] }), []);
  assert.deepEqual(suggestFollowUps({ schemas: schema, tables: ['nope'], usedTools: [] }), [], '未知表名不产生推荐');
});

test('follow-ups honour business context too', () => {
  const bundle = bundleAgentContext([ctxEntry({ kind: 'table', table: 'orders', alias: '订单表' })], {});
  const list = suggestFollowUps({ schemas: schema, tables: ['orders'], usedTools: [], bundle, limit: 3 });
  assert.ok(list.some((s) => s.prompt.includes('订单表')));
});
