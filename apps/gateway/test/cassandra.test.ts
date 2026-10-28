import test from 'node:test';
import assert from 'node:assert/strict';
import { CassandraDriver } from '../src/drivers/cassandra';

const CASSANDRA_PORT = process.env.AIDB_TEST_CASSANDRA_PORT ? Number(process.env.AIDB_TEST_CASSANDRA_PORT) : undefined;

test('Cassandra/ScyllaDB driver contract', { skip: !CASSANDRA_PORT }, async () => {
  const driver = new CassandraDriver({ host: '127.0.0.1', port: CASSANDRA_PORT! });
  try {
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);
    assert.match(String(ping.version), /Cassandra|Scylla/i);

    await driver.executeQuery({ language: 'cql', text: "DROP KEYSPACE IF EXISTS aidb_test" });
    await driver.executeQuery({
      language: 'cql',
      text: "CREATE KEYSPACE aidb_test WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}",
    });
    await driver.executeQuery({
      language: 'cql',
      text: 'CREATE TABLE aidb_test.items (id int PRIMARY KEY, name text, amount double)',
    });
    await driver.executeQuery({ language: 'cql', text: 'INSERT INTO aidb_test.items (id, name, amount) VALUES (?, ?, ?)', params: [1, 'Ada', 12.5] });
    await driver.executeQuery({ language: 'cql', text: 'INSERT INTO aidb_test.items (id, name, amount) VALUES (?, ?, ?)', params: [2, 'Linus', 7] });

    const rows = await driver.executeQuery({ language: 'cql', text: 'SELECT id, name, amount FROM aidb_test.items' });
    assert.equal(rows.rowCount, 2);
    const byId = new Map(rows.rows.map((row) => [Number(row[rows.columns.findIndex((column) => column.name === 'id')]), row]));
    assert.equal(byId.get(1)?.[rows.columns.findIndex((column) => column.name === 'name')], 'Ada');

    const keyspaces = await driver.listDatabases();
    assert.ok(keyspaces.includes('aidb_test'));
    const tables = await driver.describe('aidb_test');
    const table = tables.find((item) => item.name === 'items');
    assert.ok(table, 'items table listed');
    assert.equal(table.schema, 'aidb_test');
    assert.ok(table.columns?.some((column) => column.name === 'id' && column.primaryKey));
    assert.ok(table.columns?.some((column) => column.name === 'name' && !column.primaryKey));

    const parsed = await driver.run('SELECT count(*) AS c FROM aidb_test.items');
    assert.equal(parsed.rowCount, 1);
  } finally {
    await driver.executeQuery({ language: 'cql', text: 'DROP KEYSPACE IF EXISTS aidb_test' }).catch(() => undefined);
    await driver.close();
  }
});
