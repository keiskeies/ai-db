import test from 'node:test';
import assert from 'node:assert/strict';
import { injectMaxExecutionTime, wrapSelectLimit } from '../src/drivers/sqlCap';
import { systemCatalogQuery } from '../src/agentContextGuard';

test('injectMaxExecutionTime 在带前导注释的 SQL 上插对位置', () => {
  const line = '-- 报表查询\nSELECT * FROM t';
  const out = injectMaxExecutionTime(line, 30000, 'mysql');
  assert.ok(out.startsWith('-- 报表查询\n'), '前导注释必须原样保留');
  assert.ok(out.includes('SELECT /*+ MAX_EXECUTION_TIME(30000) */ * FROM t'), `提示必须紧跟顶层 SELECT：${out}`);

  const block = '/* hello world */ SELECT 1';
  const out2 = injectMaxExecutionTime(block, 30000, 'mysql');
  assert.equal(out2, '/* hello world */ SELECT /*+ MAX_EXECUTION_TIME(30000) */ 1');
});

test('wrapSelectLimit 的闭括号不被尾部行注释吞掉', () => {
  const out = wrapSelectLimit('SELECT * FROM t -- note', 10, 'postgresql');
  assert.ok(out, '单条 SELECT 应当可以外包');
  assert.ok(out!.includes('\n) AS _aidb_limit LIMIT 10'), out!);
});

test('systemCatalogQuery 覆盖 PG/SQLite/SHOW 变体', () => {
  assert.equal(systemCatalogQuery('SHOW FULL TABLES'), true);
  assert.equal(systemCatalogQuery('SHOW TABLE STATUS'), true);
  assert.equal(systemCatalogQuery('SELECT * FROM pg_catalog.pg_tables'), true);
  assert.equal(systemCatalogQuery('SELECT name FROM sqlite_master'), true);
  assert.equal(systemCatalogQuery('SELECT table_name FROM information_schema.tables'), true);
  assert.equal(systemCatalogQuery('SELECT * FROM business.orders'), false);
});