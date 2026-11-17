import test from 'node:test';
import assert from 'node:assert/strict';
import { MysqlDriver } from '../src/drivers/mysql';

test('MySQL-compatible engines keep tables when optional catalogs are missing', async () => {
  const driver = new MysqlDriver({ host: '127.0.0.1', port: 3306, user: 'root', database: 'demo' });
  const query = async (sql: string) => {
    if (sql === 'SHOW DATABASES') throw new Error('SHOW DATABASES is not supported');
    if (sql.includes('information_schema.SCHEMATA')) return [[{ SCHEMA_NAME: 'demo' }], []];
    if (sql.includes('information_schema.TABLES')) {
      return [[{ TABLE_NAME: 't1', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 7 }], []];
    }
    if (sql.includes('information_schema.COLUMNS')) {
      return [
        [
          { TABLE_NAME: 't1', COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', EXTRA: '', COLUMN_COMMENT: '' },
        ],
        [],
      ];
    }
    // 模拟 Doris / StarRocks / GBase 8a 缺失统计或约束视图（以及不认识 innodb_lock_wait_timeout）。
    throw new Error(`unknown catalog: ${sql}`);
  };
  // 内省走独占连接 + 看门狗（metadataQuery），假连接复用同一份 catalog 应答。
  (driver as any).pool = () => ({
    query,
    getConnection: async () => ({ query, release() {}, destroy() {} }),
  });

  assert.deepEqual(await driver.listDatabases(), ['demo']);
  const tables = await driver.describe();
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns?.map((column) => column.name), ['id']);
  assert.deepEqual(tables[0].indexes, []);
  assert.deepEqual(tables[0].foreignKeys, []);
});
