import test from 'node:test';
import assert from 'node:assert/strict';
import { DmDriver } from '../src/drivers/dm';

const DM_PORT = process.env.AIDB_TEST_DM_PORT ? Number(process.env.AIDB_TEST_DM_PORT) : undefined;
const DM_PASSWORD = process.env.AIDB_TEST_DM_PASSWORD ?? 'SYSDBA';

// dmdb 使用 DES-CFB 登录加密，运行时需要 NODE_OPTIONS=--openssl-legacy-provider
test('DM8 driver contract', { skip: !DM_PORT }, async () => {
  const driver = new DmDriver({
    host: '127.0.0.1',
    port: DM_PORT!,
    user: 'SYSDBA',
    password: DM_PASSWORD,
  });

  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);
  assert.match(String(ping.version), /DM8/);

  const databases = await driver.listDatabases();
  assert.ok(databases.includes('SYSDBA'), `schemas: ${databases.join(',')}`);

  await driver.run('DROP TABLE AIDB_TEST_T').catch(() => undefined);
  await driver.run(`
    CREATE TABLE AIDB_TEST_T (
      ID INT PRIMARY KEY,
      NAME VARCHAR(50) NOT NULL,
      AMOUNT NUMBER(10,2)
    )
  `);
  await driver.runParams('INSERT INTO AIDB_TEST_T (ID, NAME, AMOUNT) VALUES (?, ?, ?)', [1, 'Ada', 12.5]);
  await driver.runParams('INSERT INTO AIDB_TEST_T (ID, NAME, AMOUNT) VALUES (?, ?, ?)', [2, 'Linus', 7]);

  const rows = await driver.runParams('SELECT ID, NAME, AMOUNT FROM AIDB_TEST_T ORDER BY ID', []);
  assert.equal(rows.rowCount, 2);
  assert.deepEqual(rows.rows, [
    [1, 'Ada', 12.5],
    [2, 'Linus', 7],
  ]);

  const tables = await driver.describe('SYSDBA');
  const table = tables.find((item) => item.name === 'AIDB_TEST_T');
  assert.ok(table, 'AIDB_TEST_T listed');
  assert.equal(table.schema, 'SYSDBA');
  assert.ok(table.columns?.some((column) => column.name === 'ID' && column.primaryKey));
  assert.ok(table.columns?.some((column) => column.name === 'NAME' && column.nullable === false));
  assert.ok(table.columns?.some((column) => column.name === 'AMOUNT' && /NUMBER/.test(column.type)));

  await driver.run('DROP TABLE AIDB_TEST_T');
  await driver.close();
});
