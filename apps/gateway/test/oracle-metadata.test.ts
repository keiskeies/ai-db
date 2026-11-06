import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleDriver, oracleVersionHint } from '../src/drivers/oracle';

function fakePool(handler: (sql: string) => any) {
  return {
    getConnection: async () => ({
      execute: async (sql: string) => handler(sql),
      close: async () => undefined,
    }),
  };
}

const ora904 = Object.assign(new Error('ORA-00904: "IDENTITY_COLUMN": invalid identifier'), { errorNum: 904 });

test('Oracle 11g falls back when ORACLE_MAINTAINED and IDENTITY_COLUMN are missing', async () => {
  const driver = new OracleDriver({ host: '127.0.0.1', port: 1521, user: 'app', database: 'ORCL' });
  let databaseQueries = 0;
  (driver as any).pool = async () =>
    fakePool((sql) => {
      if (sql.includes('all_users')) {
        databaseQueries += 1;
        if (sql.includes('oracle_maintained')) throw ora904;
        return { rows: [{ USERNAME: 'APP' }] };
      }
      if (sql.includes('ALL_TABLES')) {
        return { rows: [{ OWNER: 'APP', TABLE_NAME: 'T1', KIND: 'TABLE', NUM_ROWS: 3 }] };
      }
      if (sql.includes('ALL_TAB_COLUMNS')) {
        if (sql.includes('IDENTITY_COLUMN') && !sql.includes('AS IDENTITY_COLUMN')) throw ora904;
        return {
          rows: [
            {
              OWNER: 'APP',
              TABLE_NAME: 'T1',
              COLUMN_NAME: 'ID',
              DATA_TYPE: 'NUMBER',
              DATA_LENGTH: 22,
              CHAR_LENGTH: null,
              DATA_PRECISION: null,
              DATA_SCALE: null,
              NULLABLE: 'N',
              DATA_DEFAULT: null,
              IDENTITY_COLUMN: null,
            },
          ],
        };
      }
      if (sql.includes('ALL_INDEXES')) throw new Error('ORA-00942: table or view does not exist');
      if (sql.includes('ALL_CONSTRAINTS')) {
        return {
          rows: [
            { OWNER: 'APP', TABLE_NAME: 'T1', CONSTRAINT_NAME: 'FK_T1', COLUMN_NAME: 'ID', REF_TABLE: 'T2', REF_COLUMN: 'ID' },
          ],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

  assert.deepEqual(await driver.listDatabases(), ['APP']);
  assert.equal(databaseQueries, 2);

  const tables = await driver.describe();
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'T1');
  assert.deepEqual(tables[0].columns?.map((column) => column.name), ['ID']);
  assert.equal(tables[0].columns?.[0].autoIncrement, false);
  assert.deepEqual(tables[0].indexes, []);
  assert.deepEqual(tables[0].foreignKeys?.map((fk) => fk.name), ['FK_T1']);
});

test('Oracle 11g thin-mode rejection gets an actionable hint', () => {
  const hint = oracleVersionHint(new Error('connections to this database server version are not supported by node-oracledb in Thin mode'));
  assert.match(String(hint), /Instant Client/);
  assert.match(String(hint), /AIDB_ORACLE_CLIENT_DIR/);
  assert.equal(oracleVersionHint(new Error('ORA-12541: TNS:no listener')), undefined);
});
