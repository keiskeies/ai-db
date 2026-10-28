import { listenRandom } from './helpers';
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ElasticsearchDriver } from '../src/drivers/elasticsearch';
import { WeaviateDriver } from '../src/drivers/weaviate';
import { supportsFieldAdd } from '../src/drivers/types';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;
const WEAVIATE_PORT = process.env.AIDB_TEST_WEAVIATE_PORT ? Number(process.env.AIDB_TEST_WEAVIATE_PORT) : undefined;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('ES 与 Weaviate 的追加字段走各自的 schema 接口', async () => {
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined });
    return json({ acknowledged: true, result: true });
  });
  try {
    const es = new ElasticsearchDriver({ host: '127.0.0.1', port: 9203 });
    assert.equal(supportsFieldAdd(es), true);
    assert.deepEqual(await es.createField({ object: 'logs', name: 'extra', type: 'keyword' }), { name: 'extra', type: 'keyword', added: true });
    assert.equal(seen[0].method, 'PUT');
    assert.match(seen[0].url, /\/logs\/_mapping$/);
    assert.deepEqual(JSON.parse(seen[0].body ?? '{}'), { properties: { extra: { type: 'keyword' } } });

    await es.createField({ object: 'logs', name: 'other', type: 'not-a-type' });
    assert.deepEqual(JSON.parse(seen[1].body ?? '{}'), { properties: { other: { type: 'keyword' } } }, '未知类型退回 keyword');

    const weaviate = new WeaviateDriver({ host: '127.0.0.1', port: 8081 });
    assert.equal(supportsFieldAdd(weaviate), true);
    assert.deepEqual(await weaviate.createField({ object: 'article', name: 'views', type: 'integer' }), { name: 'views', type: 'int', added: true });
    assert.equal(seen[2].method, 'POST');
    assert.match(seen[2].url, /\/v1\/schema\/Article\/properties$/, 'class 名同样补首字母大写');
    assert.deepEqual(JSON.parse(seen[2].body ?? '{}'), { name: 'views', dataType: ['int'] });

    await assert.rejects(() => es.createField({ object: '', name: 'x', type: 'text' }), /索引名/);
    await assert.rejects(() => es.createField({ object: 'logs', name: '  ', type: 'text' }), /字段名/);
    await assert.rejects(() => weaviate.createField({ object: '  ', name: 'x', type: 'text' }), /class 名/);
  } finally {
    mocked.mock.restore();
  }
});

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-field-add-'));
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
  const connect = async (partial: Record<string, unknown>) => {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({ groupName: 'live', color: 'orange', environment: 'dev', readonly: false, ...partial }),
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

test('HTTP 与 Agent 都能给 ES mapping 和 Weaviate class 追加字段', { skip: !ES_PORT || !WEAVIATE_PORT }, async () => {
  const env = await harness();
  after(env.close);
  const esId = await env.connect({ name: 'es-fields', engine: 'elasticsearch', host: '127.0.0.1', port: ES_PORT });
  const esReadonly = await env.connect({ name: 'es-fields-readonly', engine: 'elasticsearch', host: '127.0.0.1', port: ES_PORT, readonly: true });
  const wvId = await env.connect({ name: 'wv-fields', engine: 'weaviate', host: '127.0.0.1', port: WEAVIATE_PORT });

  await env.api('/objects/create', { method: 'POST', body: JSON.stringify({ connectionId: esId, name: 'aidb_field_es', fields: [{ name: 'message', type: 'text' }] }) });
  await env.api('/objects/create', { method: 'POST', body: JSON.stringify({ connectionId: wvId, name: 'aidbFieldWv', fields: [{ name: 'title', type: 'text' }] }) });

  const refused = await env.api<{ error: { code: string } }>('/fields/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: esReadonly, object: 'aidb_field_es', name: 'nope', type: 'keyword' }),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'READONLY');

  const added = await env.api<{ result: { name: string; type: string } }>('/fields/create', {
    method: 'POST',
    body: JSON.stringify({ connectionId: esId, object: 'aidb_field_es', name: 'extra', type: 'keyword' }),
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.result.type, 'keyword');

  const executor = new ToolExecutor(env.gateway.store, env.gateway.manager, env.gateway.config, () => env.gateway.store.getSettings());
  const agentResult = await executor.execute(
    {
      id: 'alter-field',
      name: 'alter_table',
      args: { connectionId: wvId, table: 'AidbFieldWv', operations: [{ op: 'add_column', column: { name: 'views', type: 'int' } }] },
    },
    { sessionId: 's1', connectionId: wvId },
  );
  assert.equal(agentResult.ok, true, agentResult.error?.message);
  assert.equal((agentResult.data as Record<string, unknown>).sql, undefined, '不生成 SQL 语句');

  const unsupportedOp = await executor.execute(
    {
      id: 'alter-drop',
      name: 'alter_table',
      args: { connectionId: wvId, table: 'AidbFieldWv', operations: [{ op: 'drop_column', name: 'views' }] },
    },
    { sessionId: 's1', connectionId: wvId },
  );
  assert.equal(unsupportedOp.ok, false, '这些引擎只支持追加字段');

  const esSchema = await env.api<{ schemas: Array<{ tables: Array<{ name: string; columns?: Array<{ name: string }> }> }> }>(
    `/connections/${esId}/schema?refresh=1`,
  );
  const esIndex = esSchema.body.schemas.flatMap((item) => item.tables).find((table) => table.name === 'aidb_field_es');
  assert.ok(esIndex?.columns?.some((column) => column.name === 'extra'), 'ES mapping 新字段出现在对象树');

  const wvSchema = await env.api<{ schemas: Array<{ tables: Array<{ name: string; columns?: Array<{ name: string }> }> }> }>(
    `/connections/${wvId}/schema?refresh=1`,
  );
  const wvClass = wvSchema.body.schemas.flatMap((item) => item.tables).find((table) => table.name === 'AidbFieldWv');
  assert.ok(wvClass?.columns?.some((column) => column.name === 'views'), 'Weaviate property 新字段出现在对象树');

  await env.api('/objects/drop', { method: 'POST', body: JSON.stringify({ connectionId: esId, name: 'aidb_field_es' }) });
  await env.api('/objects/drop', { method: 'POST', body: JSON.stringify({ connectionId: wvId, name: 'aidbFieldWv' }) });
});
