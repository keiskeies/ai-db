import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

const MONGO_PORT = process.env.AIDB_TEST_MONGO_PORT ? Number(process.env.AIDB_TEST_MONGO_PORT) : undefined;
const DB = 'aidb_index_http';

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-index-http-'));
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
  const connect = async (name: string, readonly: boolean) => {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name,
        engine: 'mongodb',
        host: '127.0.0.1',
        port: MONGO_PORT,
        database: DB,
        groupName: 'live',
        color: 'green',
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
    gateway,
    close: async () => {
      await gateway.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows 上 SQLite 句柄可能还未释放，临时目录交给系统清理 */
      }
    },
  };
}

test('MongoDB 索引通过 /indexes 建删，只读与 _id_ 都被拦住', { skip: !MONGO_PORT }, async () => {
  const admin = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { serverSelectionTimeoutMS: 5000 });
  await admin.connect();
  await admin.db(DB).dropDatabase();
  await admin.db(DB).collection('widgets').insertMany([{ weight: 1 }, { weight: 2 }]);
  await admin.close();

  const env = await harness();
  after(env.close);
  const writable = await env.connect('mongo-index-write', false);
  const readonly = await env.connect('mongo-index-readonly', true);

  const refused = await env.api<{ error: { code: string } }>('/indexes/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonly, database: DB, collection: 'widgets', columns: ['weight'] }),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'READONLY');

  const bad = await env.api('/indexes/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: DB, collection: 'widgets', columns: [] }),
  });
  assert.equal(bad.status, 400, '没有字段时直接拒绝');

  const created = await env.api<{ result: { name: string; created: boolean } }>('/indexes/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: DB, collection: 'widgets', columns: ['weight'], unique: true, name: 'weight_unique' }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.result.name, 'weight_unique');

  const schema = await env.api<{ schemas: Array<{ tables: Array<{ name: string; indexes?: Array<{ name: string; unique: boolean }> }> }> }>(
    `/connections/${writable}/schema?refresh=1&database=${DB}`,
  );
  const widgets = schema.body.schemas.flatMap((item) => item.tables).find((table) => table.name === 'widgets');
  assert.ok(
    widgets?.indexes?.some((index) => index.name === 'weight_unique' && index.unique),
    '刷新后的对象树带上新索引',
  );

  const protectedDrop = await env.api<{ error: { code: string } }>('/indexes/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: DB, collection: 'widgets', name: '_id_' }),
  });
  assert.ok(protectedDrop.status >= 400, '_id_ 主键索引不可删');

  const dropped = await env.api<{ result: { dropped: boolean } }>('/indexes/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: DB, collection: 'widgets', name: 'weight_unique' }),
  });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal(dropped.body.result.dropped, true);

  const afterDrop = await env.api<{ schemas: Array<{ tables: Array<{ name: string; indexes?: Array<{ name: string }> }> }> }>(
    `/connections/${writable}/schema?refresh=1&database=${DB}`,
  );
  const stillThere = afterDrop.body.schemas
    .flatMap((item) => item.tables)
    .find((table) => table.name === 'widgets')
    ?.indexes?.some((index) => index.name === 'weight_unique');
  assert.equal(stillThere, false, '删除后索引不再出现');

  const audits = await env.api<{ entries: Array<{ tool: string; risk: string }> }>(`/audit?connectionId=${writable}&limit=30`);
  const tools = (audits.body.entries ?? []).map((entry) => `${entry.tool}:${entry.risk}`);
  assert.ok(tools.includes('indexes.create:ddl'), '建索引记 ddl 审计');
  assert.ok(tools.includes('indexes.drop:destructive'), '删索引记 destructive 审计');

  const cleanup = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { serverSelectionTimeoutMS: 5000 });
  await cleanup.connect();
  await cleanup.db(DB).dropDatabase();
  await cleanup.close();
});

test('Agent 的 manage_index 走 MongoDB 索引通道，而不是拼 SQL', { skip: !MONGO_PORT }, async () => {
  const seed = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { serverSelectionTimeoutMS: 5000 });
  await seed.connect();
  await seed.db(DB).dropDatabase();
  await seed.db(DB).collection('widgets').insertMany([{ weight: 1 }, { weight: 2 }]);
  await seed.close();

  const env = await harness();
  after(env.close);
  const executor = new ToolExecutor(env.gateway.store, env.gateway.manager, env.gateway.config, () => env.gateway.store.getSettings());
  const connectionId = await env.connect('mongo-index-agent', false);

  const run = (args: Record<string, unknown>) =>
    executor.execute(
      { id: `idx-${Math.random().toString(36).slice(2)}`, name: 'manage_index', args: { connectionId, database: DB, table: 'widgets', ...args } },
      { sessionId: 's1', connectionId },
    );

  const created = await run({ action: 'create', index: { columns: ['weight'], name: 'agent_idx', unique: true }, sparse: true });
  assert.equal(created.ok, true, created.error?.message);
  assert.equal((created.data as Record<string, unknown>).index, 'agent_idx');
  const ddl = (created.data as Record<string, unknown>).sql;
  assert.equal(ddl, undefined, '非 SQL 引擎不应生成 SQL 语句');

  const dropped = await run({ action: 'drop', name: 'agent_idx' });
  assert.equal(dropped.ok, true, dropped.error?.message);

  const protectedDrop = await run({ action: 'drop', name: '_id_' });
  assert.equal(protectedDrop.ok, false, '_id_ 主键索引不能删');

  const audits = await env.api<{ entries: Array<{ tool: string; status: string }> }>(`/audit?connectionId=${connectionId}&limit=30`);
  const agentAudits = (audits.body.entries ?? []).filter((entry) => entry.tool === 'manage_index');
  assert.ok(agentAudits.length >= 3, 'Agent 建删索引都要留审计');
  assert.ok(agentAudits.some((entry) => entry.status === 'error'), '失败的删除同样入审计');

  const cleanup = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { serverSelectionTimeoutMS: 5000 });
  await cleanup.connect();
  await cleanup.db(DB).dropDatabase();
  await cleanup.close();
});
