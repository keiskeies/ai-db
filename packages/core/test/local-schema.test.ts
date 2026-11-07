import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groundedColumns, hiddenTableMention, matchColumn, matchTable, numericColumns, pickDimension, pickMeasure, pickTimeColumn, rankTables } from '../src/agent/local/schema';
import type { GroundingOptions } from '../src/agent/local/schema';
import { EMPTY_AGENT_CONTEXT_BUNDLE } from '../src/types';
import type { AgentContextBundle, ColumnInfo, TableInfo } from '../src/types';

function column(name: string, type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, type, nullable: true, primaryKey: false, ...extra };
}

const orders: TableInfo = {
  name: 'orders',
  type: 'table',
  columns: [
    column('id', 'INTEGER', { primaryKey: true, autoIncrement: true }),
    column('user_id', 'INTEGER'),
    column('status', 'TEXT'),
    column('amount_cents', 'INTEGER'),
    column('created_at', 'TIMESTAMP'),
    column('note', 'TEXT'),
  ],
  foreignKeys: [{ name: 'fk_orders_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
};

const users: TableInfo = {
  name: 'users',
  type: 'table',
  columns: [column('id', 'INTEGER', { primaryKey: true }), column('name', 'TEXT'), column('city', 'TEXT')],
};

const tables = [orders, users];

function bundleWith(patch: Partial<AgentContextBundle>): GroundingOptions {
  return { bundle: { ...EMPTY_AGENT_CONTEXT_BUNDLE, ...patch } };
}

describe('offline semantic grounding', () => {
  it('prefers an explicitly named table over scored candidates', () => {
    assert.equal(matchTable('看看 users 表结构', tables)?.name, 'users');
  });

  it('does not let a short name swallow a longer one', () => {
    const orderItems: TableInfo = { name: 'order_items', type: 'table', columns: [column('id', 'INTEGER')] };
    assert.equal(matchTable('统计 order_items 的行数', [orders, orderItems])?.name, 'order_items');
  });

  it('resolves a table through the user-maintained business alias', () => {
    const opts = bundleWith({ tableMeta: { orders: { alias: '销售订单' } } });
    assert.equal(matchTable('销售订单 有多少行', tables, opts)?.name, 'orders');
  });

  it('resolves a table from column and comment signal when no name is given', () => {
    const opts = bundleWith({ tableMeta: { orders: { description: '记录每笔成交的金额与状态' } } });
    assert.equal(matchTable('每笔成交的金额是多少', tables, opts)?.name, 'orders');
  });

  it('never returns a table the user disabled', () => {
    const opts = bundleWith({ disabledTables: ['orders'], tableMeta: { orders: { alias: '销售订单' } } });
    assert.equal(matchTable('销售订单 有多少行', tables, opts)?.name, undefined);
  });

  it('reports the hidden table the question actually asked about', () => {
    const opts = bundleWith({ disabledTables: ['orders'], tableMeta: { orders: { alias: '销售订单' } } });
    assert.equal(hiddenTableMention('销售订单 有多少行', tables, opts)?.name, 'orders');
    assert.equal(hiddenTableMention('orders 表结构', tables, opts)?.name, 'orders');
    assert.equal(hiddenTableMention('users 有多少行', tables, opts)?.name, undefined);
    assert.equal(hiddenTableMention('销售订单 有多少行', tables)?.name, undefined);
  });

  it('falls back to the only visible table', () => {
    assert.equal(matchTable('多少行', [orders])?.name, 'orders');
    assert.equal(matchTable('多少行', tables)?.name, undefined);
  });

  it('ranks relevant tables ahead of unrelated ones', () => {
    const opts = bundleWith({ tableMeta: { users: { alias: '买家城市' } } });
    const ranked = rankTables('买家城市 分布', tables, opts);
    assert.equal(ranked[0]?.name, 'users');
  });

  it('maps a Chinese column alias to the physical column', () => {
    const opts = bundleWith({ columnMeta: { orders: { amount_cents: { alias: '订单金额' }, status: { alias: '订单状态' } } } });
    assert.equal(matchColumn('按订单状态统计订单金额', orders, opts)?.name, 'status');
  });

  it('matches a physical column name on word boundaries only', () => {
    assert.equal(matchColumn('看看 note', orders)?.name, 'note');
    assert.equal(matchColumn('统计 id 的数量', orders)?.name, 'id');
    assert.equal(matchColumn('user_id 去重', orders)?.name, 'user_id');
  });

  it('falls back to the native column comment', () => {
    const withComment: TableInfo = { ...orders, columns: orders.columns!.map((c) => (c.name === 'status' ? { ...c, comment: '支付状态' } : c)) };
    assert.equal(matchColumn('按支付状态分组', withComment)?.name, 'status');
  });

  it('hides columns the user disabled', () => {
    const opts = bundleWith({ disabledColumns: { orders: ['amount_cents'] } });
    assert.equal(groundedColumns(orders, opts).some((c) => c.name === 'amount_cents'), false);
    assert.equal(matchColumn('统计 amount_cents', orders, opts)?.name, undefined);
    assert.equal(pickMeasure(orders, '金额合计', opts)?.name, undefined);
  });

  it('picks a real measure instead of a foreign key or identifier', () => {
    assert.equal(pickMeasure(orders, '合计')?.name, 'amount_cents');
  });

  it('honours an explicitly named measure over the default', () => {
    const withQty: TableInfo = { ...orders, columns: [...orders.columns!, column('qty', 'INTEGER')] };
    assert.equal(pickMeasure(withQty, '统计 qty 合计')?.name, 'qty');
  });

  it('prefers a status-like dimension and honours an explicit one', () => {
    assert.equal(pickDimension(orders, '分布')?.name, 'status');
    assert.equal(pickDimension(orders, '按 note 分组', {})?.name, 'note');
  });

  it('finds the time column', () => {
    assert.equal(pickTimeColumn(orders, '趋势')?.name, 'created_at');
  });

  it('keeps identifier columns available for scatter axes', () => {
    const names = numericColumns(orders).map((c) => c.name);
    assert.ok(names.includes('user_id'));
    assert.ok(names.includes('amount_cents'));
    assert.ok(!names.includes('created_at'));
  });
});