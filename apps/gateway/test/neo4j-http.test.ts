import { listenRandom } from './helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Neo4jDriver } from '../src/drivers/neo4j';
import { createGateway } from '../src/server';

const NEO4J_PORT = process.env.AIDB_TEST_NEO4J_PORT ? Number(process.env.AIDB_TEST_NEO4J_PORT) : undefined;
const NEO4J_PASSWORD = process.env.AIDB_TEST_NEO4J_PASSWORD ?? 'testpass';

test('Neo4j works through the HTTP schema/query pipeline', { skip: !NEO4J_PORT }, async () => {
  const seed = new Neo4jDriver({
    host: '127.0.0.1',
    port: NEO4J_PORT!,
    user: 'neo4j',
    password: NEO4J_PASSWORD,
    database: 'neo4j',
  });
  await seed.executeQuery({ language: 'cypher', text: 'MATCH (n) DETACH DELETE n' });
  await seed.executeQuery({
    language: 'cypher',
    text: 'CREATE (a:Person {name: "Ada"})-[:KNOWS {since: 2020}]->(b:Person {name: "Linus"})',
  });
  await seed.close();

  const home = mkdtempSync(join(tmpdir(), 'aidb-neo4j-http-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  const gateway = await createGateway({
    home,
    dbPath: join(home, 'aidb.db'),
    secret: 'it-secret',
    token: 'it-token',
    demoDir: join(home, 'demo'),
    exportDir: join(home, 'exports'),
    importDir: join(home, 'imports'),
    backupDir: join(home, 'backups'),
    staticDir: join(home, 'static-missing'),
    port: 0,
    host: '127.0.0.1',
    production: false,
  });
  await listenRandom(gateway.server);
  const port = (gateway.server.address() as AddressInfo).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const baseConnection = {
    name: 'neo4j-live',
    engine: 'neo4j',
    host: '127.0.0.1',
    port: NEO4J_PORT,
    database: 'neo4j',
    username: 'neo4j',
    password: NEO4J_PASSWORD,
    groupName: 'live',
    color: 'green',
    environment: 'dev',
  };

  try {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({ ...baseConnection, readonly: false }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.connection.id;

    const schema = await api<{ schemas: Array<{ name: string; tables: Array<{ name: string; kind?: string; columns?: unknown[] }> }> }>(
      `/connections/${id}/schema?database=neo4j`,
    );
    assert.equal(schema.status, 200, JSON.stringify(schema.body));
    const tables = schema.body.schemas.flatMap((item) => item.tables);
    const person = tables.find((table) => table.name === 'Person');
    assert.ok(person, 'Person label in schema');
    assert.equal(person.kind, 'node_label');
    const knows = tables.find((table) => table.name === 'KNOWS');
    assert.ok(knows, 'KNOWS relationship in schema');
    assert.equal(knows.kind, 'edge_label');

    const query = await api<{ batch: { sets: Array<{ rowCount: number; resultKind?: string; rows: unknown[][] }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: id,
        database: 'neo4j',
        sql: 'MATCH (p:Person) RETURN p.name AS name ORDER BY name',
      }),
    });
    assert.equal(query.status, 200, JSON.stringify(query.body));
    assert.equal(query.body.batch.sets[0].rowCount, 2);
    assert.deepEqual(query.body.batch.sets[0].rows, [['Ada'], ['Linus']]);

    const graph = await api<{ batch: { sets: Array<{ resultKind?: string; rowCount: number }> } }>('/query', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: id,
        database: 'neo4j',
        sql: 'MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b',
      }),
    });
    assert.equal(graph.status, 200, JSON.stringify(graph.body));
    assert.equal(graph.body.batch.sets[0].resultKind, 'graph');

    const readonly = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({ ...baseConnection, name: 'neo4j-readonly', readonly: true }),
    });
    assert.equal(readonly.status, 201, JSON.stringify(readonly.body));
    const readonlyQuery = await api('/query', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: readonly.body.connection.id,
        database: 'neo4j',
        sql: 'CREATE (n:Temp {name: "x"})',
      }),
    });
    assert.equal(readonlyQuery.status, 403, JSON.stringify(readonlyQuery.body));
    assert.equal((readonlyQuery.body as any).error.code, 'READONLY');

    const monitor = await api(`/monitor?connectionId=${id}`);
    assert.equal(monitor.status, 400);
    assert.equal((monitor.body as any).error.code, 'UNSUPPORTED_ENGINE');

    await api(`/connections/${readonly.body.connection.id}`, { method: 'DELETE' });
    await api(`/connections/${id}`, { method: 'DELETE' });
  } finally {
    await gateway.close();
    rmSync(home, { recursive: true, force: true });
  }
});
