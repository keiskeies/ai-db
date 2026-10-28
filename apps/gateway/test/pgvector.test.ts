import { listenRandom } from './helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createGateway } from '../src/server';

const PGVECTOR_PORT = process.env.AIDB_TEST_PGVECTOR_PORT ? Number(process.env.AIDB_TEST_PGVECTOR_PORT) : undefined;

test('pgvector search and embedding work through the HTTP pipeline', { skip: !PGVECTOR_PORT }, async () => {
  const pool = new pg.Pool({ host: '127.0.0.1', port: PGVECTOR_PORT!, user: 'postgres', password: 'test', database: 'aidb' });
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query('DROP TABLE IF EXISTS items');
  await pool.query('CREATE TABLE items (id serial primary key, name text, embedding vector(3))');
  await pool.query("INSERT INTO items (name, embedding) VALUES ('Ada', '[1,0,0]'), ('Linus', '[0,1,0]')");

  const embeddingServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
    });
  });
  await listenRandom(embeddingServer);
  const embeddingPort = (embeddingServer.address() as AddressInfo).port;

  const home = mkdtempSync(join(tmpdir(), 'aidb-pgvector-http-'));
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

  try {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'pgvector-live',
        engine: 'postgresql',
        host: '127.0.0.1',
        port: PGVECTOR_PORT,
        database: 'aidb',
        username: 'postgres',
        password: 'test',
        groupName: 'live',
        color: 'blue',
        environment: 'dev',
        readonly: false,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.connection.id;

    const schema = await api<{ schemas: Array<{ tables: Array<{ name: string; columns?: Array<{ name: string; type: string }> }> }> }>(
      `/connections/${id}/schema?database=aidb`,
    );
    assert.equal(schema.status, 200, JSON.stringify(schema.body));
    const items = schema.body.schemas.flatMap((item) => item.tables).find((table) => table.name === 'items');
    assert.ok(items, 'items table in schema');
    assert.ok(items.columns?.some((column) => column.name === 'embedding' && /vector/i.test(column.type)));

    const search = await api<{ result: { rowCount: number; columns: Array<{ name: string }>; rows: unknown[][] } }>('/vector/search', {
      method: 'POST',
      body: JSON.stringify({ connectionId: id, database: 'aidb', collection: 'items', field: 'embedding', vector: [1, 0, 0], topK: 2 }),
    });
    assert.equal(search.status, 200, JSON.stringify(search.body));
    assert.equal(search.body.result.rowCount, 2);
    const scoreIndex = search.body.result.columns.findIndex((column) => column.name === 'score');
    assert.ok(scoreIndex >= 0);
    assert.deepEqual(search.body.result.rows[0].slice(0, 2), [1, 'Ada']);
    assert.equal(Number(search.body.result.rows[0][scoreIndex]), 1);

    const settings = await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        embedding: { provider: 'openai', baseUrl: `http://127.0.0.1:${embeddingPort}`, model: 'test-embedding', apiKey: 'test-key' },
      }),
    });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));

    const textSearch = await api<{ result: { rowCount: number; columns: Array<{ name: string }>; rows: unknown[][] } }>('/vector/search', {
      method: 'POST',
      body: JSON.stringify({ connectionId: id, database: 'aidb', collection: 'items', field: 'embedding', text: 'Ada', topK: 2 }),
    });
    assert.equal(textSearch.status, 200, JSON.stringify(textSearch.body));
    assert.equal(textSearch.body.result.rowCount, 2);
    const textScoreIndex = textSearch.body.result.columns.findIndex((column) => column.name === 'score');
    assert.ok(textScoreIndex >= 0);
    assert.deepEqual(textSearch.body.result.rows[0].slice(0, 2), [1, 'Ada']);
    assert.equal(Number(textSearch.body.result.rows[0][textScoreIndex]), 1);

    await api(`/connections/${id}`, { method: 'DELETE' });
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
    await pool.query('DROP TABLE IF EXISTS items').catch(() => undefined);
    await pool.end().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});
