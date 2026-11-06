import test from 'node:test';
import assert from 'node:assert/strict';
import type { TableInfo } from '@aidb/core';
import { dumpKeysetSql, dumpPageSql, dumpReadPlan, sqlLiteral } from '../src/services';

test('SQL boolean literal follows the dialect, not just the engine id', () => {
  assert.equal(sqlLiteral(true, 'postgresql'), 'TRUE');
  assert.equal(sqlLiteral(false, 'cockroachdb'), 'FALSE');
  assert.equal(sqlLiteral(true, 'kingbase'), 'TRUE');
  assert.equal(sqlLiteral(false, 'opengauss'), 'FALSE');
  assert.equal(sqlLiteral(true, 'timescale'), 'TRUE');
  assert.equal(sqlLiteral(true, 'mysql'), '1');
  assert.equal(sqlLiteral(false, 'oracle'), '0');
});

test('SQL date literal keeps the wall clock and uses the dialect format', () => {
  const date = new Date(2026, 10, 6, 1, 2, 3, 456);
  assert.match(sqlLiteral(date, 'postgresql'), /^'\d{4}-\d{2}-\d{2} 01:02:03\.456[+-]\d{2}:\d{2}'$/);
  assert.equal(sqlLiteral(date, 'mysql'), "'2026-11-06 01:02:03.456'");
  assert.equal(sqlLiteral(date, 'sqlserver'), "'2026-11-06T01:02:03.456'");
  assert.equal(sqlLiteral(date, 'oracle'), "TO_TIMESTAMP('2026-11-06 01:02:03.456', 'YYYY-MM-DD HH24:MI:SS.FF3')");
  assert.equal(sqlLiteral(date, 'dm'), "TO_TIMESTAMP('2026-11-06 01:02:03.456', 'YYYY-MM-DD HH24:MI:SS.FF3')");
});

test('SQL binary literal matches the engine dialect', () => {
  const bytes = Buffer.from([0, 255]);
  assert.equal(sqlLiteral(bytes, 'postgresql'), "decode('00ff', 'hex')");
  assert.equal(sqlLiteral(bytes, 'sqlserver'), '0x00ff');
  assert.equal(sqlLiteral(bytes, 'oracle'), "hextoraw('00ff')");
  assert.equal(sqlLiteral(bytes, 'clickhouse'), "unhex('00ff')");
  assert.equal(sqlLiteral(bytes, 'mysql'), "X'00ff'");
  // node:sqlite 返回的是 Uint8Array，不是 Buffer。
  assert.equal(sqlLiteral(new Uint8Array([0, 255]), 'sqlite'), "X'00ff'");
  assert.equal(sqlLiteral(bytes, 'duckdb'), "'\\x00ff'::BLOB");
});

test('PG arrays dump as ARRAY literals instead of JSON text', () => {
  assert.equal(sqlLiteral(['a', 'b'], 'postgresql'), "ARRAY['a', 'b']");
  assert.equal(sqlLiteral([1, 2], 'postgresql'), 'ARRAY[1, 2]');
  assert.equal(sqlLiteral([], 'postgresql'), "'{}'");
  assert.equal(sqlLiteral(['a'], 'mysql'), "'[\"a\"]'");
});

const keyed = (pk: string[]): TableInfo => ({
  name: 't',
  type: 'table',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: pk.includes('id') },
    { name: 'org', type: 'integer', nullable: false, primaryKey: pk.includes('org') },
  ],
});

test('backup reads paginate by primary key and refuse to guess without one', () => {
  assert.deepEqual(dumpReadPlan('postgresql', keyed(['id'])), { mode: 'keyset', column: 'id' });
  assert.deepEqual(dumpReadPlan('mysql', keyed(['id', 'org'])), { mode: 'offset', order: ['id', 'org'] });
  assert.deepEqual(dumpReadPlan('mysql', keyed([])), { mode: 'single' });
  // Oracle / 达梦没有可靠的跨版本分页语法，保持一次性读取而不是冒漏行风险。
  assert.deepEqual(dumpReadPlan('oracle', keyed(['id'])), { mode: 'single' });

  assert.equal(
    dumpPageSql('mysql', 'SELECT * FROM `t`', ['id'], 2000, 4000),
    'SELECT * FROM `t` ORDER BY `id` LIMIT 2000 OFFSET 4000',
  );
  assert.equal(
    dumpPageSql('sqlserver', 'SELECT * FROM [t]', ['id'], 2000, 4000),
    'SELECT * FROM [t] ORDER BY [id] OFFSET 4000 ROWS FETCH NEXT 2000 ROWS ONLY',
  );
  assert.equal(dumpKeysetSql('postgresql', 'SELECT * FROM "t"', 'id', 2000, undefined), 'SELECT * FROM "t" ORDER BY "id" LIMIT 2000');
  assert.equal(
    dumpKeysetSql('postgresql', 'SELECT * FROM "t"', 'id', 2000, 7),
    'SELECT * FROM "t" WHERE "id" > $1 ORDER BY "id" LIMIT 2000',
  );
  assert.equal(
    dumpKeysetSql('sqlserver', 'SELECT * FROM [t]', 'id', 2000, 7),
    'SELECT * FROM [t] WHERE [id] > @p1 ORDER BY [id] OFFSET 0 ROWS FETCH NEXT 2000 ROWS ONLY',
  );
});
