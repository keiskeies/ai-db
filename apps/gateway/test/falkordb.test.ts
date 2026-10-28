import test from 'node:test';
import assert from 'node:assert/strict';
import { FalkorDriver } from '../src/drivers/falkordb';

const PORT = process.env.AIDB_TEST_FALKORDB_PORT ? Number(process.env.AIDB_TEST_FALKORDB_PORT) : undefined;
const GRAPH = 'aidb_test';

test('FalkorDB driver uses GRAPH.QUERY and returns graph data', { skip: !PORT }, async () => {
  const driver = new FalkorDriver({ host: '127.0.0.1', port: PORT!, database: GRAPH });
  try {
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);

    await driver.executeQuery({ language: 'cypher', text: 'MATCH (n) DETACH DELETE n' });
    const created = await driver.executeQuery({
      language: 'cypher',
      text: 'CREATE (a:Person {name: $a})-[:KNOWS {since: 2020}]->(b:Person {name: $b})',
      params: { a: 'Ada', b: 'Linus' },
    });
    assert.equal(created.rowCount, 0);
    assert.match(String(created.affected ?? 0), /^\d+$/);

    const rows = await driver.executeQuery({ language: 'cypher', text: 'MATCH (n:Person) RETURN n ORDER BY n.name' });
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.resultKind, 'graph');
    assert.equal(rows.graph?.nodes.length, 2);
    assert.deepEqual(rows.graph?.nodes.map((node) => node.properties.name).sort(), ['Ada', 'Linus']);
    assert.equal(rows.columns[0].type, 'node');

    const path = await driver.executeQuery({
      language: 'cypher',
      text: 'MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b',
    });
    assert.equal(path.resultKind, 'graph');
    assert.equal(path.graph?.nodes.length, 2);
    assert.equal(path.graph?.edges.length, 1);
    assert.equal(path.graph?.edges[0].type, 'KNOWS');

    const scalar = await driver.executeQuery({ language: 'cypher', text: 'MATCH (n:Person) RETURN count(n) AS total' });
    assert.equal(scalar.columns[0].name, 'total');
    assert.equal(scalar.rows[0][0], 2);
    assert.equal(scalar.resultKind, 'table');

    const tables = await driver.describe(GRAPH);
    assert.ok(tables.some((table) => table.name === 'Person' && table.kind === 'node_label'));
    assert.ok(tables.some((table) => table.name === 'KNOWS' && table.kind === 'edge_label'));
    const person = tables.find((table) => table.name === 'Person');
    assert.ok(person?.columns?.some((column) => column.name === 'name'));

    assert.ok((await driver.listDatabases()).includes(GRAPH));
    await assert.rejects(() => driver.executeQuery({ language: 'sql', text: 'SELECT 1' } as never), /Cypher/);
  } finally {
    await driver.close();
  }
});