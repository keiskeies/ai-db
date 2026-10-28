import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writesLineProtocol } from '@aidb/core';
import { createGateway } from '../src/server';

const PORT = process.env.AIDB_TEST_INFLUXDB_PORT ? Number(process.env.AIDB_TEST_INFLUXDB_PORT) : undefined;
const DB = 'aidb_influx_write';

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-influx-write-'));
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
  const port = (gateway.server.address() as any).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const connect = async (name: string, readonly: boolean) => {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name,
        engine: 'influxdb',
        host: '127.0.0.1',
        port: PORT,
        database: DB,
        groupName: 'live',
        color: 'cyan',
        environment: 'dev',
        readonly,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.connection.id;
  };
  return {
    api,
    connect,
    close: async () => {
      await gateway.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows 上 SQLite 句柄可能还未释放 */
      }
    },
  };
}

test('InfluxDB 行协议写入：写入后能查回，只读与非 InfluxDB 被拒', { skip: !PORT }, async () => {
  assert.equal(writesLineProtocol('influxdb'), true);
  assert.equal(writesLineProtocol('mongodb'), false);

  const env = await harness();
  after(env.close);
  const writable = await env.connect('influx-write', false);
  const readonly = await env.connect('influx-write-ro', true);

  const line = `aidb_lp,host=probe value=42.5 ${Date.now()}000000`;
  const written = await env.api<{ result: { written: number } }>('/influx/write', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: DB, lines: [line] }),
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.result.written, 1);

  const query = await env.api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: DB, sql: 'SELECT host, value FROM aidb_lp' }),
  });
  assert.equal(query.status, 200, JSON.stringify(query.body));
  const rows = query.body.batch.sets.flatMap((set) => set.rows ?? []);
  assert.ok(rows.length >= 1, '写入的样本能查回');
  assert.ok(rows.some((row) => row.includes('probe')), JSON.stringify(rows));

  const ro = await env.api('/influx/write', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonly, database: DB, lines: [line] }),
  });
  assert.equal(ro.status, 403);

  const empty = await env.api('/influx/write', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: DB, lines: ['   ', ''] }),
  });
  assert.equal(empty.status, 400);

  const audits = await env.api<{ entries: Array<{ tool: string; risk: string }> }>(`/audit?connectionId=${writable}&limit=20`);
  assert.ok((audits.body.entries ?? []).some((entry) => entry.tool === 'influx.write' && entry.risk === 'write'));
});