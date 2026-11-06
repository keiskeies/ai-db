import test from 'node:test';
import assert from 'node:assert/strict';
import { CassandraDriver } from '../src/drivers/cassandra';

function fakeClient(handlers: Array<{ match: RegExp; rows?: unknown[]; error?: string }>) {
  return {
    connect: async () => undefined,
    execute: async (sql: string) => {
      const hit = handlers.find((handler) => handler.match.test(sql));
      if (!hit) throw new Error(`unexpected CQL: ${sql}`);
      if (hit.error) throw new Error(hit.error);
      return { rows: hit.rows ?? [] };
    },
    shutdown: async () => undefined,
  };
}

const withClient = (handlers: Parameters<typeof fakeClient>[0]) => {
  const driver = new CassandraDriver({ host: '127.0.0.1', port: 9042 });
  (driver as any).ready = async () => fakeClient(handlers);
  return driver;
};

test('Cassandra 2.x falls back to system.schema_* metadata', async () => {
  const driver = withClient([
    { match: /system_schema\.keyspaces/, error: 'No keyspace has been specified: the table system_schema does not exist' },
    { match: /system\.schema_keyspaces/, rows: [{ keyspace_name: 'app' }, { keyspace_name: 'audit' }] },
    { match: /system_schema\.tables/, error: 'the table system_schema does not exist' },
    { match: /system\.schema_columnfamilies/, rows: [{ columnfamily_name: 'events' }] },
    {
      match: /system\.schema_columns/,
      rows: [
        { columnfamily_name: 'events', column_name: 'id', type: 'partition_key', component_index: null, validator: 'org.apache.cassandra.db.marshal.UUIDType' },
        { columnfamily_name: 'events', column_name: 'ts', type: 'clustering', component_index: 0, validator: 'org.apache.cassandra.db.marshal.LongType' },
        { columnfamily_name: 'events', column_name: 'payload', type: 'regular', component_index: null, validator: 'org.apache.cassandra.db.marshal.UTF8Type' },
      ],
    },
  ]);

  assert.deepEqual(await driver.listDatabases(), ['app', 'audit']);
  const tables = await driver.describe('app');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'events');
  assert.deepEqual(tables[0].columns?.map((column) => [column.name, column.type, column.primaryKey]), [
    ['id', 'uuid', true],
    ['ts', 'bigint', true],
    ['payload', 'text', false],
  ]);
});

test('modern Cassandra keeps system_schema and reports the original error when both fail', async () => {
  const modern = withClient([
    { match: /system_schema\.keyspaces/, rows: [{ keyspace_name: 'app' }] },
    { match: /system_schema\.tables/, rows: [{ table_name: 'events' }] },
    { match: /system_schema\.views/, rows: [] },
    { match: /system_schema\.columns/, rows: [{ table_name: 'events', column_name: 'id', kind: 'partition_key', position: 0, type: 'uuid' }] },
  ]);
  const tables = await modern.describe('app');
  assert.deepEqual(tables[0].columns?.map((column) => column.name), ['id']);

  const broken = withClient([
    { match: /system_schema\.tables/, error: 'unconfigured table system_schema.tables' },
    { match: /system\.schema_columnfamilies/, error: 'Unknown keyspace/table system.schema_columnfamilies' },
  ]);
  await assert.rejects(() => broken.describe('app'), /unconfigured table system_schema\.tables/);
});
