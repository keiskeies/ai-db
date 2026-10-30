import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allTableScanNeedsScope, disabledTableTarget, disabledToolError, filterDisabledObjects, systemCatalogQuery } from '../src/agentContextGuard';
import type { ToolCall, ToolResult } from '@aidb/core';

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'c1', name, args });
const ok = (data: unknown): ToolResult => ({ ok: true, summary: 'ok', data, meta: { durationMs: 1 } });

test('object tools reject disabled table/collection arguments', () => {
  assert.equal(disabledTableTarget(call('sample_rows', { table: 't_trade_pay_flow' }), ['t_trade_pay_flow']), 't_trade_pay_flow');
  assert.equal(disabledTableTarget(call('inspect_schema', { tables: ['t_order', 'T_TRADE_PAY_FLOW'] }), ['t_trade_pay_flow']), 'T_TRADE_PAY_FLOW');
  assert.equal(disabledTableTarget(call('sample_rows', { table: 't_order' }), ['t_trade_pay_flow']), undefined);
  assert.equal(disabledTableTarget(call('run_sql', { sql: 'SELECT * FROM t_trade_pay_flow' }), ['t_trade_pay_flow']), undefined);
});

test('disabledToolError is TABLE_DISABLED', () => {
  const result = disabledToolError('t_trade_pay_flow');
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'TABLE_DISABLED');
  assert.match(result.error?.message ?? '', /t_trade_pay_flow/);
});

test('search_objects and inspect_schema filter disabled objects out of results', () => {
  const search = filterDisabledObjects(
    call('search_objects', { query: 'flow' }),
    ok({ matches: [{ table: 't_trade_pay_flow' }, { table: 't_order' }], total: 2 }),
    ['t_trade_pay_flow'],
  );
  assert.deepEqual((search.data as any).matches, [{ table: 't_order' }]);
  assert.equal((search.data as any).total, 1);
  assert.match(search.summary, /已过滤/);

  const inspect = filterDisabledObjects(
    call('inspect_schema', {}),
    ok({ tables: [{ name: 't_order' }, { name: 't_trade_pay_flow' }] }),
    ['t_trade_pay_flow'],
  );
  assert.deepEqual((inspect.data as any).tables, [{ name: 't_order' }]);
});

test('unrelated results are returned unchanged', () => {
  const result = ok({ matches: [{ table: 't_order' }], total: 1 });
  assert.equal(filterDisabledObjects(call('search_objects', { query: 'order' }), result, []), result);
});

test('nested recon_data args and all-table scans are guarded', () => {
  const recon = call('recon_data', { left: { kind: 'table', connectionId: 'c1', table: 't_trade_pay_flow' }, right: { kind: 'table', connectionId: 'c2', table: 't_order' } });
  assert.equal(disabledTableTarget(recon, ['t_trade_pay_flow']), 't_trade_pay_flow');
  assert.equal(allTableScanNeedsScope(call('schema_diff', { sourceConnectionId: 'a', targetConnectionId: 'b' }), ['t_trade_pay_flow']), true);
  assert.equal(allTableScanNeedsScope(call('schema_diff', { tables: ['t_order'] }), ['t_trade_pay_flow']), false);
  assert.equal(allTableScanNeedsScope(call('transfer_data', { tables: [] }), ['t_trade_pay_flow']), true);
  assert.equal(allTableScanNeedsScope(call('audit_database', {}), ['t_trade_pay_flow']), false);
});

test('system catalog queries are recognized', () => {
  assert.equal(systemCatalogQuery('SELECT * FROM information_schema.tables'), true);
  assert.equal(systemCatalogQuery('select table_name from performance_schema.tables'), true);
  assert.equal(systemCatalogQuery('SHOW TABLES'), true);
  assert.equal(systemCatalogQuery('show databases'), true);
  assert.equal(systemCatalogQuery('SELECT * FROM mysql.user'), true);
  assert.equal(systemCatalogQuery('SHOW CREATE TABLE t_order'), false);
  assert.equal(systemCatalogQuery('SELECT * FROM t_order'), false);
});

test('aggregate findings referencing disabled tables are redacted', () => {
  const audit = filterDisabledObjects(
    call('audit_database', {}),
    ok({ findings: [{ table: 't_trade_pay_flow', code: 'NO_PK' }, { table: 't_order', code: 'EMPTY_TABLE' }] }),
    ['t_trade_pay_flow'],
  );
  assert.deepEqual((audit.data as any).findings, [{ table: 't_order', code: 'EMPTY_TABLE' }]);
  assert.match(audit.summary, /已过滤/);
});
