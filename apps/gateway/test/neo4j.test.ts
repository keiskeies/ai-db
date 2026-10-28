import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jDriver } from '../src/drivers/neo4j';

const NEO4J_PORT = process.env.AIDB_TEST_NEO4J_PORT ? Number(process.env.AIDB_TEST_NEO4J_PORT) : undefined;
const NEO4J_PASSWORD = process.env.AIDB_TEST_NEO4J_PASSWORD ?? 'testpass';

test('Neo4j driver contract', { skip: !NEO4J_PORT }, async () => {
  const driver = new Neo4jDriver({
    host: '127.0.0.1',
    port: NEO4J_PORT!,
    user: 'neo4j',
    password: NEO4J_PASSWORD,
    database: 'neo4j',
  });

  const ping = await driver.test();
  assert.equal(ping.ok, true, ping.message);
  assert.match(String(ping.version), /Neo4j/i);

  const databases = await driver.listDatabases();
  assert.ok(databases.includes('neo4j'));

  await driver.executeQuery({ language: 'cypher', text: 'MATCH (n) DETACH DELETE n' });
  await driver.executeQuery({
    language: 'cypher',
    text: `
      CREATE (a:Person {name: 'Ada', age: 36})
      CREATE (b:Person {name: 'Linus', age: 55})
      CREATE (c:Person {name: 'Grace', age: 85})
      CREATE (a)-[:KNOWS {since: 2020}]->(b)
      CREATE (b)-[:KNOWS {since: 2021}]->(c)
    `,
  });

  const tables = await driver.describe('neo4j');
  const person = tables.find((table) => table.name === 'Person');
  assert.ok(person, 'Person label listed');
  assert.equal(person.kind, 'node_label');
  assert.ok(person.columns?.some((column) => column.name === 'name'));
  assert.ok(person.columns?.some((column) => column.name === 'age'));
  const knows = tables.find((table) => table.name === 'KNOWS');
  assert.ok(knows, 'KNOWS relationship listed');
  assert.equal(knows.kind, 'edge_label');
  assert.ok(knows.columns?.some((column) => column.name === 'since'));

  const people = await driver.executeQuery({
    language: 'cypher',
    text: 'MATCH (n:Person) RETURN n.name AS name, n.age AS age ORDER BY age',
  });
  assert.equal(people.rowCount, 3);
  assert.equal(people.resultKind, 'table');
  assert.deepEqual(people.columns.map((column) => column.name), ['name', 'age']);
  assert.deepEqual(people.rows.map((row) => row[0]), ['Ada', 'Linus', 'Grace']);

  const graph = await driver.executeQuery({
    language: 'cypher',
    text: 'MATCH (p:Person)-[r:KNOWS]->(q:Person) RETURN p, r, q ORDER BY p.name',
  });
  assert.equal(graph.rowCount, 2);
  assert.equal(graph.resultKind, 'graph');
  assert.deepEqual(graph.columns.map((column) => column.kind), ['json', 'json', 'json']);
  assert.match(JSON.stringify(graph.rows[0][0]), /Ada/);
  assert.ok(graph.graph, 'graph payload');
  assert.equal(graph.graph.nodes.length, 3);
  assert.equal(graph.graph.edges.length, 2);

  const count = await driver.executeQuery({ language: 'cypher', text: 'MATCH (n) RETURN count(n) AS c' });
  assert.deepEqual(count.rows, [[3]]);

  const explained = await driver.executeQuery({ language: 'cypher', text: 'EXPLAIN MATCH (n:Person) RETURN n' });
  assert.ok(explained.rowCount > 0);

  const withParams = await driver.executeQuery({
    language: 'cypher',
    text: 'MATCH (n:Person {name: $name}) RETURN n.age AS age',
    params: { name: 'Ada' },
  });
  assert.deepEqual(withParams.rows, [[36]]);

  await assert.rejects(() => driver.executeQuery({ language: 'cypher', text: '   ' }), /Cypher 不能为空/);
  await driver.close();
});
