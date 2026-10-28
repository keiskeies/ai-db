import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildSystemPrompt, type ConnectionConfig } from '@aidb/core';
import { createGateway } from '../src/server';

const home = mkdtempSync(join(tmpdir(), 'aidb-ctx-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'ctx-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'ctx-secret',
  token: TOKEN,
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
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const ctxPath = (id: string, database: string) => `/agent/context?connectionId=${id}&database=${encodeURIComponent(database)}`;

let demo: ConnectionConfig;
let database = '';
let first = '';
let second = '';

test('bootstrap exposes the demo connection and its schema', async () => {
  const boot = await api<{ connections: ConnectionConfig[] }>('/bootstrap');
  assert.equal(boot.status, 200);
  demo = boot.body.connections.find((c) => c.engine === 'sqlite')!;
  assert.ok(demo, 'demo connection exists');
  const schemas = await gateway.manager.schema(demo.id, demo.database);
  database = schemas[0]?.name ?? '';
  const tables = schemas.flatMap((s) => s.tables).map((t) => t.name);
  assert.ok(tables.length >= 2, 'demo 库至少要有两张表');
  [first, second] = tables;
});

test('agent context routes validate their inputs', async () => {
  assert.equal((await api('/agent/context')).status, 400, 'connectionId 必填');
  assert.equal((await api('/agent/context/entry', { method: 'PUT', body: JSON.stringify({ table: 'x' }) })).status, 400);
  assert.equal(
    (await api('/agent/context/entry', { method: 'PUT', body: JSON.stringify({ connectionId: demo.id, table: 'x', kind: 'nope' }) })).status,
    400,
    'kind 只接受 table/column',
  );
  assert.equal(
    (await api('/agent/context/relation', { method: 'PUT', body: JSON.stringify({ connectionId: demo.id, table: first, column: 'a', refTable: second }) })).status,
    400,
    '缺少 refColumn 应被拒绝',
  );
  assert.equal((await api('/agent/context/bulk', { method: 'POST', body: JSON.stringify({ connectionId: demo.id }) })).status, 400, 'tables[] 必填');
  assert.equal((await api(`/agent/context?connectionId=${demo.id}`, { method: 'DELETE' })).status, 200, 'clear 只需 connectionId');
});

test('an unconfigured connection yields an inactive bundle (zero regression)', async () => {
  const res = await api<{ entries: any[]; bundle: any; active: boolean }>(ctxPath(demo.id, database));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, []);
  assert.equal(res.body.active, false);

  const schemas = await gateway.manager.schema(demo.id, demo.database);
  const plain = buildSystemPrompt({ databases: schemas, mode: 'ask', memories: [] });
  const withInactiveBundle = buildSystemPrompt({
    databases: schemas,
    mode: 'ask',
    memories: [],
    context: gateway.store.agentContextBundle(demo.id, database),
  });
  assert.equal(plain, withInactiveBundle, '未配置上下文时 prompt 必须逐字节相同');
  assert.ok(!withInactiveBundle.includes('Business context'));
});

test('table and column overrides upsert instead of duplicating', async () => {
  const disable = await api<{ entry: any }>('/agent/context/entry', {
    method: 'PUT',
    body: JSON.stringify({ connectionId: demo.id, database, kind: 'table', table: first, enabled: false }),
  });
  assert.equal(disable.status, 200);
  assert.equal(disable.body.entry.enabled, false);

  const annotate = await api<{ entry: any }>('/agent/context/entry', {
    method: 'PUT',
    body: JSON.stringify({ connectionId: demo.id, database, kind: 'table', table: first, alias: '业务主表', description: '演示用主表' }),
  });
  assert.equal(annotate.body.entry.id, disable.body.entry.id, '同一 (connection,database,kind,table,column) 必须 upsert');
  assert.equal(annotate.body.entry.alias, '业务主表');
  assert.equal(annotate.body.entry.enabled, false, '未传 enabled 时保留原值');

  const schemas = await gateway.manager.schema(demo.id, demo.database);
  const column = schemas.flatMap((s) => s.tables).find((t) => t.name === second)?.columns?.[0];
  assert.ok(column, 'second 表应有列');
  await api('/agent/context/entry', {
    method: 'PUT',
    body: JSON.stringify({ connectionId: demo.id, database, kind: 'column', table: second, column: column.name, enabled: false }),
  });
  const annotatedColumn = await api<{ entry: any }>('/agent/context/entry', {
    method: 'PUT',
    body: JSON.stringify({ connectionId: demo.id, database, kind: 'column', table: second, column: column.name, description: '枚举值：A=甲，B=乙' }),
  });
  assert.equal(annotatedColumn.body.entry.enabled, false, '只改描述不得把 enabled 复位为 true');
  assert.equal(annotatedColumn.body.entry.description, '枚举值：A=甲，B=乙');

  const res = await api<{ entries: any[]; bundle: any; active: boolean }>(ctxPath(demo.id, database));
  assert.equal(res.body.active, true);
  assert.equal(res.body.entries.filter((e: any) => e.kind === 'table').length, 1);
  assert.equal(res.body.entries.filter((e: any) => e.kind === 'column').length, 1);
  assert.deepEqual(res.body.bundle.disabledTables, [first.toLowerCase()]);
  assert.deepEqual(res.body.bundle.disabledColumns[second.toLowerCase()], [column.name.toLowerCase()]);
  assert.deepEqual(res.body.bundle.tableMeta[first.toLowerCase()], { alias: '业务主表', description: '演示用主表' });
});

test('manual relations dedupe on the four-column key', async () => {
  for (const description of ['下单人', '下单人（修订）']) {
    const rel = await api<{ entry: any }>('/agent/context/relation', {
      method: 'PUT',
      body: JSON.stringify({ connectionId: demo.id, database, table: first, column: 'owner_id', refTable: second, refColumn: 'id', description }),
    });
    assert.equal(rel.status, 200);
  }
  const res = await api<{ bundle: any }>(ctxPath(demo.id, database));
  assert.equal(res.body.bundle.relations.length, 1);
  assert.equal(res.body.bundle.relations[0].description, '下单人（修订）');
});

test('disabled tables and business semantics reach the system prompt end to end', async () => {
  const schemas = await gateway.manager.schema(demo.id, demo.database);
  const bundle = gateway.store.agentContextBundle(demo.id, database);
  const prompt = buildSystemPrompt({ databases: schemas, mode: 'ask', memories: [], context: bundle });

  const escapedFirst = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.ok(!new RegExp(`- table ${escapedFirst}(\\s|$)`).test(prompt), `被禁用的表 ${first} 不应出现在 prompt`);
  assert.match(prompt, /tables hidden by the user's context settings/);
  assert.match(prompt, /### Join relations/);
  assert.ok(prompt.includes(`${first}.owner_id = ${second}.id`), '手工关系应作为 JOIN 提示注入');
});

test('bulk enable and clear restore the default behaviour', async () => {
  const bulk = await api<{ touched: number }>('/agent/context/bulk', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, database, tables: [first, second], enabled: true }),
  });
  assert.equal(bulk.body.touched, 2);
  const afterBulk = await api<{ bundle: any }>(ctxPath(demo.id, database));
  assert.deepEqual(afterBulk.body.bundle.disabledTables, [], '批量启用后不再有禁用表');

  const cleared = await api<{ removed: number }>(ctxPath(demo.id, database), { method: 'DELETE' });
  assert.ok(cleared.body.removed >= 3, `应清除表/列/关系配置，实际 ${cleared.body.removed}`);
  const afterClear = await api<{ entries: any[]; active: boolean }>(ctxPath(demo.id, database));
  assert.deepEqual(afterClear.body.entries, []);
  assert.equal(afterClear.body.active, false, '缓存必须在清空后立即失效');
});

test('glossary and example SQL are recalled in their own quota', async () => {
  await api('/agent/memories', { method: 'POST', body: JSON.stringify({ kind: 'glossary', title: 'GMV', content: '成交总额', connectionId: demo.id, database }) });
  await api('/agent/memories', {
    method: 'POST',
    body: JSON.stringify({ kind: 'sql_example', title: '本月 GMV', content: 'SELECT SUM(amount) FROM orders', connectionId: demo.id, database }),
  });
  const listed = await api<{ memories: any[] }>('/agent/memories?kind=glossary');
  assert.ok(listed.body.memories.some((m) => m.title === 'GMV'));

  const recall = gateway.store.recallForTurn('本月 GMV 是多少', { connectionId: demo.id, database });
  assert.ok(recall.glossary.some((m) => m.title === 'GMV'), '术语应被独立召回');
  assert.ok(recall.sqlExamples.some((m) => m.title === '本月 GMV'), '示例 SQL 应被独立召回');
  assert.ok(
    !recall.memories.some((m) => m.kind === 'glossary' || m.kind === 'sql_example'),
    '普通记忆召回中不应混入业务语义类，避免挤占 6 条名额',
  );

  const schemas = await gateway.manager.schema(demo.id, demo.database);
  const prompt = buildSystemPrompt({
    databases: schemas,
    mode: 'ask',
    memories: recall.memories,
    glossary: recall.glossary,
    sqlExamples: recall.sqlExamples,
  });
  assert.match(prompt, /## Business context/);
  assert.match(prompt, /- GMV → 成交总额/);
  assert.match(prompt, /SELECT SUM\(amount\) FROM orders/);
  assert.match(prompt, /match this caliber/);
});

test('single entry delete works and the memory_search tool still sees all kinds', async () => {
  const one = await api<{ entry: any }>('/agent/context/entry', {
    method: 'PUT',
    body: JSON.stringify({ connectionId: demo.id, database, kind: 'table', table: first, enabled: false }),
  });
  assert.equal((await api(`/agent/context/entry/${one.body.entry.id}`, { method: 'DELETE' })).status, 204);
  const res = await api<{ entries: any[] }>(ctxPath(demo.id, database));
  assert.deepEqual(res.body.entries, []);

  const searched = gateway.store.searchMemories('GMV', { connectionId: demo.id, database, limit: 10 });
  assert.ok(searched.some((m) => m.kind === 'glossary'), 'memory_search 工具仍可检索到术语');
});

test('猜你想问 is generated locally from the loaded schema', async () => {
  assert.equal((await api('/agent/suggest')).status, 400, 'connectionId 必填');

  const res = await api<{ suggestions: any[] }>(`/agent/suggest?connectionId=${demo.id}&database=${encodeURIComponent(database)}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.suggestions.length > 0, 'demo 库应能生成推荐问题');
  assert.ok(res.body.suggestions.length <= 6, '默认上限 6 条');
  for (const s of res.body.suggestions) {
    assert.ok(s.id && s.prompt && s.reason && s.kind && s.table, `推荐项字段完整：${JSON.stringify(s)}`);
    assert.ok(['trend', 'group', 'topn', 'quality', 'relation'].includes(s.kind), `未知类型 ${s.kind}`);
  }
  assert.equal(new Set(res.body.suggestions.map((s) => s.prompt)).size, res.body.suggestions.length, '推荐问题不得重复');

  const limited = await api<{ suggestions: any[] }>(`/agent/suggest?connectionId=${demo.id}&database=${encodeURIComponent(database)}&limit=2`);
  assert.ok(limited.body.suggestions.length <= 2);

  // 禁用某张表后，它不再出现在推荐里
  const victim = res.body.suggestions[0].table;
  await api('/agent/context/entry', {
    method: 'PUT',
    body: JSON.stringify({ connectionId: demo.id, database, kind: 'table', table: victim, enabled: false }),
  });
  const after = await api<{ suggestions: any[] }>(`/agent/suggest?connectionId=${demo.id}&database=${encodeURIComponent(database)}`);
  assert.ok(!after.body.suggestions.some((s) => s.table === victim), `被禁用的 ${victim} 不应再被推荐`);

  // 配置了别名后，推荐语改用业务名
  await api('/agent/context/entry', {
    method: 'PUT',
    body: JSON.stringify({ connectionId: demo.id, database, kind: 'table', table: victim, enabled: true, alias: '探针别名表' }),
  });
  const aliased = await api<{ suggestions: any[] }>(`/agent/suggest?connectionId=${demo.id}&database=${encodeURIComponent(database)}`);
  const mine = aliased.body.suggestions.filter((s) => s.table === victim);
  assert.ok(mine.length === 0 || mine.every((s) => s.prompt.includes('探针别名表')), '推荐语应使用业务别名');

  await api(`/agent/context?connectionId=${demo.id}`, { method: 'DELETE' });
});
