import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDriver } from '../src/drivers/postgres';

function fakePool(handler: (sql: string) => any) {
  return {
    query: async (sql: string) => handler(sql),
  };
}

const tableRow = { table_schema: 'public', table_name: 't1', table_type: 'BASE TABLE' };
const columnRows = [
  { table_schema: 'public', table_name: 't1', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: "nextval('t1_id_seq')" },
  { table_schema: 'public', table_name: 't1', column_name: 'name', data_type: 'text', udt_name: 'text', is_nullable: 'YES', column_default: null },
];

test('PG index columns come from indkey without array_position', async () => {
  const sqls: string[] = [];
  const driver = new PostgresDriver({ host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres' });
  (driver as any).pool = () =>
    fakePool((sql) => {
      sqls.push(sql);
      if (sql.includes('information_schema.tables')) return { rows: [tableRow] };
      if (sql.includes('information_schema.columns')) return { rows: columnRows };
      if (sql.includes('pg_index')) {
        return {
          rows: [
            { schema: 'public', table: 't1', index: 't1_pkey', unique: true, primary: true, indkey: '1', relid: 100 },
            { schema: 'public', table: 't1', index: 't1_name_idx', unique: false, primary: false, indkey: '0 2', relid: 100 },
          ],
        };
      }
      if (sql.includes('pg_attribute')) {
        return {
          rows: [
            { relid: 100, attnum: 1, column: 'id' },
            { relid: 100, attnum: 2, column: 'name' },
          ],
        };
      }
      if (sql.includes('information_schema.table_constraints')) {
        return { rows: [{ schema: 'public', table: 't1', name: 't1_name_fk', column: 'name', ref_table: 't2', ref_column: 'name' }] };
      }
      if (sql.includes('reltuples')) return { rows: [{ schema: 'public', table: 't1', estimate: 12 }] };
      return { rows: [] };
    });

  const tables = await driver.describe();
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns?.map((column) => [column.name, column.primaryKey]), [['id', true], ['name', false]]);
  assert.equal(tables[0].rowEstimate, 12);
  const primary = tables[0].indexes?.find((index) => index.name === 't1_pkey');
  assert.deepEqual(primary?.columns, ['id']);
  assert.equal(primary?.primary, true);
  // 表达式索引的 0 号 attnum 被跳过，只保留真实列。
  assert.deepEqual(tables[0].indexes?.find((index) => index.name === 't1_name_idx')?.columns, ['name']);
  assert.deepEqual(tables[0].foreignKeys?.map((fk) => [fk.name, fk.columns, fk.refTable]), [['t1_name_fk', ['name'], 't2']]);
  assert.equal(sqls.some((sql) => sql.includes('array_position')), false);
});

test('PG tables and columns survive an index catalog failure', async () => {
  const driver = new PostgresDriver({ host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres' });
  (driver as any).pool = () =>
    fakePool((sql) => {
      if (sql.includes('information_schema.tables')) return { rows: [tableRow] };
      if (sql.includes('information_schema.columns')) return { rows: columnRows };
      if (sql.includes('pg_index') || sql.includes('pg_attribute')) throw new Error('catalog unavailable');
      return { rows: [] };
    });

  const tables = await driver.describe();
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns?.map((column) => column.name), ['id', 'name']);
  assert.deepEqual(tables[0].indexes, []);
});
