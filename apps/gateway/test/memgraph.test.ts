import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jDriver } from '../src/drivers/neo4j';

const MEMGRAPH_PORT = process.env.AIDB_TEST_MEMGRAPH_PORT ? Number(process.env.AIDB_TEST_MEMGRAPH_PORT) : undefined;

test('Memgraph driver contract (Bolt/Cypher reuse)', { skip: !MEMGRAPH_PORT }, async () => {
  const driver = new Neo4jDriver(
    { host: '127.0.0.1', port: MEMGRAPH_PORT!, database: 'memgraph', defaultDatabase: 'memgraph' },
    'memgraph',
  );
  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);
  assert.match(String(ping.version), /Memgraph|Neo4j/i);

  await driver.executeQuery({ language: 'cypher', text: 'MATCH (n) DETACH DELETE n' });
  await driver.executeQuery({
    language: 'cypher',
    text: "CREATE (a:Person {name: 'Ada'})-[:KNOWS {since: 2020}]->(b:Person {name: 'Linus'})",
  });

  const tables = await driver.describe();
  const person = tables.find((table) => table.name === 'Person');
  assert.ok(person, 'Person label listed');
  assert.equal(person.kind, 'node_label');
  assert.ok(person.columns?.some((column) => column.name === 'name'));
  const knows = tables.find((table) => table.name === 'KNOWS');
  assert.ok(knows, 'KNOWS relationship listed');
  assert.equal(knows.kind, 'edge_label');

  const rows = await driver.executeQuery({ language: 'cypher', text: 'MATCH (n:Person) RETURN n.name AS name ORDER BY name' });
  assert.deepEqual(rows.rows, [['Ada'], ['Linus']]);
  await driver.close();
});
