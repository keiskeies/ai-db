import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { inflateRawSync } from 'node:zlib';
import type { AgentEvent, ConnectionConfig, DatabaseSchema, TableInfo, ToolResult } from '@aidb/core';
import { createGateway } from '../src/server';

const home = mkdtempSync(join(tmpdir(), 'aidb-it-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'it-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'it-secret',
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

function unzipEntry(buffer: Buffer, target: string): string | undefined {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== target) continue;
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const chunk = buffer.subarray(start, start + compressedSize);
    return (method === 0 ? chunk : inflateRawSync(chunk)).toString('utf8');
  }
  return undefined;
}

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

let demo: ConnectionConfig;

test('health, bootstrap and demo seed', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as any;
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.demoReady, true);

  const boot = await api<{ connections: ConnectionConfig[]; tools: unknown[]; settings: { agent: { provider: string } } }>('/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.body.tools.length, 40);
  demo = boot.body.connections.find((c) => c.engine === 'sqlite')!;
  assert.ok(demo, 'demo connection exists');
  assert.equal(boot.body.settings.agent.provider, 'local');
});

test('query, pagination, sorting and readonly enforcement', async () => {
  const count = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) AS c FROM orders' }),
  });
  assert.equal(count.status, 200);
  assert.equal(Number(count.body.batch.sets[0].rows[0][0]), 900);

  const page = await api<{ total: number; batch: { sets: Array<{ rows: unknown[][]; columns: Array<{ name: string }> }> } }>(
    `/data?connectionId=${demo.id}&table=orders&limit=5&offset=10&orderBy=total_cents&orderDir=desc`,
  );
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 900);
  assert.equal(page.body.batch.sets[0].rows.length, 5);
  const totals = page.body.batch.sets[0].rows.map((r) => Number(r[page.body.batch.sets[0].columns.findIndex((c) => c.name === 'total_cents')]));
  for (let i = 1; i < totals.length; i++) assert.ok(totals[i - 1] >= totals[i]);

  const pageA = await api<{ batch: { sets: Array<{ rows: unknown[][]; columns: Array<{ name: string }> }> } }>(
    `/data?connectionId=${demo.id}&table=orders&limit=5&offset=0`,
  );
  const pageB = await api<{ batch: { sets: Array<{ rows: unknown[][]; columns: Array<{ name: string }> }> } }>(
    `/data?connectionId=${demo.id}&table=orders&limit=5&offset=5`,
  );
  const idIndex = pageA.body.batch.sets[0].columns.findIndex((column) => column.name === 'id');
  const idsA = pageA.body.batch.sets[0].rows.map((row) => Number(row[idIndex]));
  const idsB = pageB.body.batch.sets[0].rows.map((row) => Number(row[idIndex]));
  assert.equal(new Set([...idsA, ...idsB]).size, 10, '默认分页不应重复');
  assert.ok(Math.max(...idsA) < Math.min(...idsB), '默认按主键升序分页');

  const multi = await api<{ sql: string; batch: { sets: Array<{ rows: unknown[][]; columns: Array<{ name: string }> }> } }>(
    `/data?connectionId=${demo.id}&table=orders&limit=8&offset=0&orderBy=status,total_cents&orderDir=asc,desc`,
  );
  assert.equal(multi.status, 200);
  assert.match(multi.body.sql, /ORDER BY .*status.*ASC.*, .*total_cents.* DESC/i);
  const columnIndex = (name: string) => multi.body.batch.sets[0].columns.findIndex((column) => column.name === name);
  const statusIndex = columnIndex('status');
  const multiTotalIndex = columnIndex('total_cents');
  const multiRows = multi.body.batch.sets[0].rows;
  for (let i = 1; i < multiRows.length; i += 1) {
    const previous = String(multiRows[i - 1][statusIndex]);
    const current = String(multiRows[i][statusIndex]);
    assert.ok(previous <= current, `${previous} <= ${current}`);
    if (previous === current) {
      assert.ok(Number(multiRows[i - 1][multiTotalIndex]) >= Number(multiRows[i][multiTotalIndex]));
    }
  }

  const readonly = await api<{ connection: ConnectionConfig }>('/connections', {
    method: 'POST',
    body: JSON.stringify({ name: 'Readonly demo', engine: 'sqlite', database: demo.database, readonly: true }),
  });
  assert.equal(readonly.status, 201);
  const blocked = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonly.body.connection.id, sql: 'UPDATE orders SET status = 1 WHERE id = 1' }),
  });
  assert.equal(blocked.status, 403);
  assert.equal((blocked.body as any).error.code, 'READONLY');
  await api(`/connections/${readonly.body.connection.id}`, { method: 'DELETE' });

  const grouped = await api<{ connection: { id: string } }>('/connections', {
    method: 'POST',
    body: JSON.stringify({ name: 'Group demo', engine: 'sqlite', database: demo.database, groupName: '组A' }),
  });
  assert.equal(grouped.status, 201);
  const renamed = await api<{ renamed: number }>('/groups/rename', { method: 'POST', body: JSON.stringify({ from: '组A', to: '组B' }) });
  assert.equal(renamed.status, 200);
  assert.ok(renamed.body.renamed >= 1);
  const afterRename = await api<{ connections: Array<{ name: string; groupName: string }> }>('/connections');
  assert.equal(afterRename.body.connections.find((item) => item.name === 'Group demo')?.groupName, '组B');
  const removed = await api<{ moved: number }>('/groups/delete', { method: 'POST', body: JSON.stringify({ name: '组B' }) });
  assert.equal(removed.status, 200);
  const afterRemove = await api<{ connections: Array<{ name: string; groupName: string }> }>('/connections');
  assert.equal(afterRemove.body.connections.find((item) => item.name === 'Group demo')?.groupName, '默认');
  await api(`/connections/${grouped.body.connection.id}`, { method: 'DELETE' });
});

test('row CRUD, DDL, export and import', async () => {
  const update = await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'products', op: 'update', values: { name: 'IT TEST' }, key: { id: 1 } }),
  });
  assert.equal(update.status, 200);
  const badUpdate = await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'products', op: 'update', values: { nmae: 'typo' }, key: { id: 1 } }),
  });
  assert.equal(badUpdate.status, 400);
  assert.equal((badUpdate.body as any).error.code, 'UNKNOWN_COLUMN');
  const nonPkUpdate = await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'products', op: 'update', values: { price_cents: 1 }, key: { name: 'IT TEST' } }),
  });
  assert.equal(nonPkUpdate.status, 400);
  assert.equal((nonPkUpdate.body as any).error.code, 'KEY_NOT_PRIMARY');
  await api('/ddl/execute', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, statements: ['CREATE TABLE IF NOT EXISTS "it_nopk" ("label" TEXT)'] }),
  });
  const noPkDelete = await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_nopk', op: 'delete', key: { label: 'x' } }),
  });
  assert.equal(noPkDelete.status, 400);
  assert.equal((noPkDelete.body as any).error.code, 'NO_PRIMARY_KEY');
  const check = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT name FROM products WHERE id = 1' }),
  });
  assert.equal(check.body.batch.sets[0].rows[0][0], 'IT TEST');
  await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'products', op: 'update', values: { name: '机械键盘 K8' }, key: { id: 1 } }),
  });

  const preview = await api<{ statements: string[] }>('/ddl/preview', {
    method: 'POST',
    body: JSON.stringify({
      connectionId: demo.id,
      table: 'it_items',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, nullable: false },
        { name: 'name', type: 'TEXT', nullable: false },
      ],
    }),
  });
  assert.equal(preview.status, 200);
  assert.match(preview.body.statements.join('\n'), /CREATE TABLE/);
  const created = await api('/ddl/execute', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, statements: preview.body.statements }),
  });
  assert.equal(created.status, 200);

  const insert = await api('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_items', op: 'insert', values: { name: 'alpha' } }),
  });
  assert.equal(insert.status, 200);
  assert.equal((insert.body as any).result.affected, 1);

  const exported = await api<{ file: { path: string; rows: number } }>('/export', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_items', format: 'csv' }),
  });
  assert.equal(exported.status, 200);
  assert.ok(existsSync(exported.body.file.path));
  assert.equal(exported.body.file.rows, 1);

  const toolList = await api<{ tools: Array<{ name: string; inputSchema: { properties?: { format?: { enum?: string[] } } } }> }>('/agent/tools');
  assert.ok(toolList.body.tools.find((tool) => tool.name === 'export_result')?.inputSchema.properties?.format?.enum?.includes('xlsx'));

  const xlsxExport = await api<{ file: { path: string; bytes: number } }>('/export', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_items', format: 'xlsx' }),
  });
  assert.equal(xlsxExport.status, 200);
  const xlsxBytes = readFileSync(xlsxExport.body.file.path);
  assert.equal(xlsxBytes.subarray(0, 2).toString(), 'PK');
  assert.ok(xlsxBytes.length > 500);
  const sheetXml = unzipEntry(xlsxBytes, 'xl/worksheets/sheet1.xml');
  assert.ok(sheetXml, 'xlsx 缺少工作表');
  assert.match(sheetXml as string, /<t xml:space="preserve">name<\/t>/);
  assert.match(sheetXml as string, /<t xml:space="preserve">alpha<\/t>/);

  await api('/ddl/execute', {
    method: 'POST',
    body: JSON.stringify({
      connectionId: demo.id,
      statements: ['CREATE TABLE "it_import" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)'],
    }),
  });
  const imported = await api<{ result: { inserted: number } }>('/import', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_import', csv: 'name\nAlpha\nBeta\n', hasHeader: true }),
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.result.inserted, 2);
  const importedCount = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) FROM it_import' }),
  });
  assert.equal(Number(importedCount.body.batch.sets[0].rows[0][0]), 2);
  const duplicateMapping = await api('/import', {
    method: 'POST',
    body: JSON.stringify({
      connectionId: demo.id,
      table: 'it_import',
      csv: `a,b
1,2
`,
      hasHeader: false,
      mapping: [{ column: 'name', sourceIndex: 0 }, { column: 'name', sourceIndex: 1 }],
    }),
  });
  assert.equal(duplicateMapping.status, 400);
  assert.equal((duplicateMapping.body as any).error.code, 'DUPLICATE_COLUMN');

  await api('/ddl/execute', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, statements: ['DROP TABLE "it_items"', 'DROP TABLE "it_import"'] }),
  });
});

test('table operations and batch data operations', async () => {
  const created = await api('/ddl/execute', {
    method: 'POST',
    body: JSON.stringify({
      connectionId: demo.id,
      statements: [
        'CREATE TABLE "it_ops" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "tag" TEXT)',
        `INSERT INTO "it_ops" ("name", "tag") VALUES ('Alpha', 'a'), ('Beta', 'b'), ('Gamma', 'c')`,
      ],
    }),
  });
  assert.equal(created.status, 200);

  const ddl = await api<{ ddl: string }>('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops', op: 'ddl' }),
  });
  assert.equal(ddl.status, 200);
  assert.match(ddl.body.ddl, /CREATE TABLE "it_ops"/);

  const duplicate = await api('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops', op: 'duplicate', newName: 'it_ops_copy', withData: true }),
  });
  assert.equal(duplicate.status, 200);
  const copied = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) FROM "it_ops_copy"' }),
  });
  assert.equal(Number(copied.body.batch.sets[0].rows[0][0]), 3);

  const rename = await api('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_copy', op: 'rename', newName: 'it_ops_renamed' }),
  });
  assert.equal(rename.status, 200);

  const inserted = await api<{ result: { affected: number } }>('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', op: 'insertMany', rows: [{ name: 'Delta' }, { name: 'Epsilon' }] }),
  });
  assert.equal(inserted.status, 200);
  assert.equal(inserted.body.result.affected, 2);

  const delta = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: `SELECT "id" FROM "it_ops_renamed" WHERE "name" = 'Delta'` }),
  });
  const deltaId = delta.body.batch.sets[0].rows[0][0];
  const removed = await api<{ result: { affected: number } }>('/rows', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', op: 'deleteMany', keys: [{ id: deltaId }] }),
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.result.affected, 1);

  const preview = await api<{ affected: number }>('/data/replace', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', column: 'name', find: 'Alpha', replace: 'Omega', preview: true }),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.affected, 1);
  const replaced = await api<{ affected: number }>('/data/replace', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', column: 'name', find: 'Alpha', replace: 'Omega' }),
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.affected, 1);
  const omega = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: `SELECT COUNT(*) FROM "it_ops_renamed" WHERE "name" = 'Omega'` }),
  });
  assert.equal(Number(omega.body.batch.sets[0].rows[0][0]), 1);

  const analyzed = await api<{ supported: boolean }>('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', op: 'maintenance', action: 'analyze' }),
  });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.body.supported, true);
  const repair = await api<{ supported: boolean }>('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', op: 'maintenance', action: 'repair' }),
  });
  assert.equal(repair.status, 200);
  assert.equal(repair.body.supported, false);

  const truncated = await api('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', op: 'truncate' }),
  });
  assert.equal(truncated.status, 200);
  const empty = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) FROM "it_ops_renamed"' }),
  });
  assert.equal(Number(empty.body.batch.sets[0].rows[0][0]), 0);

  await api('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops', op: 'drop' }),
  });
  await api('/tables/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, table: 'it_ops_renamed', op: 'drop' }),
  });

  const unsupported = await api<{ supported: boolean }>('/databases/ops', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, database: 'main', op: 'create' }),
  });
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.body.supported, false);
});

async function runTurn(sessionId: string, text: string, mode = 'ask', approve = false, database?: string): Promise<{ events: AgentEvent[]; text: string }> {
  const res = await fetch(`${base}/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, mode, ...(database ? { database } : {}) }),
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: AgentEvent[] = [];
  let answer = '';
  let approved = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (frame && !frame.startsWith(':')) {
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) {
          const event = JSON.parse(data) as AgentEvent;
          events.push(event);
          if (event.type === 'text_delta') answer += event.text;
          if (event.type === 'approval_required') {
            if (approve && !approved) {
              approved = true;
              await api(`/agent/approvals/${event.approvalId}`, { method: 'POST', body: JSON.stringify({ decision: 'allow', scope: 'once' }) });
            } else {
              await api(`/agent/approvals/${event.approvalId}`, { method: 'POST', body: JSON.stringify({ decision: 'deny', scope: 'once' }) });
            }
          }
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
  return { events, text: answer };
}

test('agent inspects schema, DDL approval, memory and audit', async () => {
  const created = await api<{ session: { id: string } }>('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id }),
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.session.id;

  const tablesTurn = await runTurn(sessionId, '看看有哪些表');
  assert.ok(tablesTurn.events.some((e) => e.type === 'tool_call' && e.tool === 'inspect_schema'));
  assert.match(tablesTurn.text, /users/);
  assert.match(tablesTurn.text, /orders/);
  assert.ok(tablesTurn.events.some((e) => e.type === 'done'));

  const memoryTurn = await runTurn(sessionId, '记住：测试订单单位是分');
  assert.ok(memoryTurn.events.some((e) => e.type === 'tool_call' && e.tool === 'memory_write'));
  const memorySearch = await api<{ memories: Array<{ title: string }> }>('/agent/memories?q=测试订单单位');
  assert.ok(memorySearch.body.memories.length > 0);

  const sqlTurn = await runTurn(sessionId, 'SELECT COUNT(*) AS c FROM orders');
  assert.ok(sqlTurn.events.some((e) => e.type === 'tool_call' && e.tool === 'run_sql'));

  const ddlTurn = await runTurn(sessionId, '创建表 it_agent_tasks，包含 id 自增主键, title 文本', 'ask', true);
  assert.ok(ddlTurn.events.some((e) => e.type === 'approval_required'));
  assert.ok(ddlTurn.events.some((e) => e.type === 'tool_result' && (e as any).result.ok));
  const tables = await api<{ tables: TableInfo[] }>(`/connections/${demo.id}/tables`);
  assert.ok(tables.body.tables.some((t) => t.name === 'it_agent_tasks'));
  await api('/ddl/execute', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, statements: ['DROP TABLE "it_agent_tasks"'] }),
  });

  const searchSession = await api<{ session: { id: string } }>('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id }),
  });
  const recall = await runTurn(searchSession.body.session.id, '之前说测试订单单位是什么');
  assert.ok(recall.events.some((e) => e.type === 'tool_call' && e.tool === 'memory_search'));
  assert.match(recall.text, /分/);

  const detail = await api<{ messages: unknown[] }>(`/agent/sessions/${sessionId}`);
  assert.ok(detail.body.messages.length >= 4);

  const audit = await api<{ entries: Array<{ actor: string; tool?: string }> }>('/audit?limit=50');
  assert.ok(audit.body.entries.some((e) => e.actor === 'agent' && e.tool === 'run_sql'));
  const history = await api<{ items: Array<{ id: string; favorite?: boolean }> }>('/history');
  assert.ok(history.body.items.length > 0);
  const historyId = history.body.items[0].id;
  const favorited = await api<{ favorite: boolean }>(`/history/${historyId}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: true }) });
  assert.equal(favorited.status, 200);
  assert.equal(favorited.body.favorite, true);
  const afterFavorite = await api<{ items: Array<{ id: string; favorite?: boolean }> }>('/history');
  assert.equal(afterFavorite.body.items.find((item) => item.id === historyId)?.favorite, true);
  const missing = await api(`/history/not-a-real-id/favorite`, { method: 'POST', body: JSON.stringify({ favorite: true }) });
  assert.equal(missing.status, 404);
  await api(`/history/${historyId}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: false }) });
  if (afterFavorite.body.items.length > 1) {
    const pinned = afterFavorite.body.items[1].id;
    await api(`/history/${pinned}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: true }) });
    const pinnedList = await api<{ items: Array<{ id: string }> }>('/history');
    assert.equal(pinnedList.body.items[0].id, pinned);
    await api(`/history/${pinned}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: false }) });
  }
});

test('agent runs concrete audit, chart and quality tools', async () => {
  const created = await api<{ session: { id: string } }>('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id }),
  });
  const sessionId = created.body.session.id;

  const audit = await runTurn(sessionId, '给数据库做一次体检');
  assert.ok(audit.events.some((e) => e.type === 'tool_call' && e.tool === 'audit_database'));
  assert.match(audit.text, /体检/);
  const auditResult = audit.events.find((e) => e.type === 'tool_result' && (e as any).tool === 'audit_database') as any;
  assert.ok(Array.isArray(auditResult?.result?.data?.findings));

  const chart = await runTurn(sessionId, '按 status 统计 orders 并画柱状图');
  assert.ok(chart.events.some((e) => e.type === 'tool_call' && e.tool === 'render_chart'));
  const chartResult = chart.events.find((e) => e.type === 'tool_result' && (e as any).tool === 'render_chart') as any;
  assert.ok(chartResult?.result?.data?.chart?.series?.length >= 4);

  const quality = await runTurn(sessionId, '检查 orders 的空值和重复主键');
  assert.ok(quality.events.some((e) => e.type === 'tool_call' && e.tool === 'check_data_quality'));
  assert.match(quality.text, /质量检查/);
});

test('engine variants are accepted and preview dialect-specific DDL', async () => {
  const variants: Array<{ engine: string; expect: RegExp }> = [
    { engine: 'mariadb', expect: /`tasks`/ },
    { engine: 'sqlserver', expect: /\[tasks\]/ },
    { engine: 'oracle', expect: /GENERATED BY DEFAULT AS IDENTITY/ },
    { engine: 'clickhouse', expect: /ENGINE = MergeTree/ },
    { engine: 'cockroachdb', expect: /SERIAL/ },
  ];
  for (const variant of variants) {
    const created = await api<{ connection: ConnectionConfig }>('/connections', {
      method: 'POST',
      body: JSON.stringify({ name: `variant-${variant.engine}`, engine: variant.engine, host: '127.0.0.1', database: 'demo', username: 'demo' }),
    });
    assert.equal(created.status, 201, variant.engine);
    assert.ok(Number(created.body.connection.port) > 0, variant.engine);
    const preview = await api<{ ddl: string }>('/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: created.body.connection.id,
        table: 'tasks',
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, nullable: false },
          { name: 'title', type: 'TEXT', nullable: false },
        ],
      }),
    });
    assert.equal(preview.status, 200, variant.engine);
    assert.match(preview.body.ddl, variant.expect, variant.engine);
    await api(`/connections/${created.body.connection.id}`, { method: 'DELETE' });
  }
  const invalid = await api('/connections', { method: 'POST', body: JSON.stringify({ name: 'bad', engine: 'db2' }) });
  assert.equal(invalid.status, 400);
});

test('productivity toolkit: search, compare, sync, transfer, generate, monitor, jobs, dictionary', async () => {
  const targetPath = join(home, 'target.sqlite');
  const targetDb = new DatabaseSync(targetPath);
  targetDb.exec('CREATE TABLE target_only (id INTEGER PRIMARY KEY, name TEXT)');
  targetDb.close();
  const targetCreated = await api<{ connection: ConnectionConfig }>('/connections', {
    method: 'POST',
    body: JSON.stringify({ name: 'Target SQLite', engine: 'sqlite', database: targetPath }),
  });
  assert.equal(targetCreated.status, 201);
  const targetId = targetCreated.body.connection.id;

  const searchObjects = await api<{ objects: Array<{ table: string; kind: string }>; data: unknown[] }>('/search', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, query: 'orders', scope: 'objects' }),
  });
  assert.ok(searchObjects.body.objects.some((item) => item.table === 'orders'));

  const searchData = await api<{ data: Array<{ table: string; rows: unknown[][] }> }>('/search', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, query: 'completed', scope: 'data' }),
  });
  assert.ok(searchData.body.data.length > 0);

  const dictionary = await api<{ dictionary: { tableCount: number; markdown: string; sql: string } }>(`/dictionary?connectionId=${demo.id}`);
  assert.ok(dictionary.body.dictionary.tableCount >= 5);
  assert.match(dictionary.body.dictionary.markdown, /orders/);
  assert.match(dictionary.body.dictionary.sql, /CREATE TABLE/);

  const monitor = await api<{ monitor: { sections: unknown[]; version?: string } }>(`/monitor?connectionId=${demo.id}`);
  assert.ok(monitor.body.monitor.sections.length >= 2);
  assert.match(String(monitor.body.monitor.version), /SQLite/);

  const users = await api<{ supported: boolean }>(`/users?connectionId=${demo.id}`);
  assert.equal(users.body.supported, false);

  const compare = await api<{ diff: any }>('/schema/compare', {
    method: 'POST',
    body: JSON.stringify({ sourceId: demo.id, targetId }),
  });
  assert.ok(compare.body.diff.summary.added >= 5);
  assert.ok(compare.body.diff.summary.removed >= 1);
  assert.ok(compare.body.diff.sql.length > 0);

  const sync = await api('/schema/sync', {
    method: 'POST',
    body: JSON.stringify({ connectionId: targetId, statements: compare.body.diff.sql }),
  });
  if (sync.status !== 200) console.log('SYNC ERROR', JSON.stringify(sync.body).slice(0, 600), 'SQL', (compare.body.diff.sql as string[]).join(';').slice(0, 800));
  assert.equal(sync.status, 200);
  const targetTables = await api<{ tables: TableInfo[] }>(`/connections/${targetId}/tables`);
  assert.ok(targetTables.body.tables.some((table) => table.name === 'orders'));
  assert.ok(!targetTables.body.tables.some((table) => table.name === 'target_only'));

  const transfer = await api<{ result: { totalRows: number; createdTables: number } }>('/transfer', {
    method: 'POST',
    body: JSON.stringify({ sourceId: demo.id, targetId, tables: ['orders'], mode: 'append' }),
  });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.result.totalRows, 900);
  const targetCount = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: targetId, sql: 'SELECT COUNT(*) FROM orders' }),
  });
  assert.equal(Number(targetCount.body.batch.sets[0].rows[0][0]), 900);

  const preview = await api<{ result: { rowsPreview: unknown[][]; inserted: number; dryRun: boolean } }>('/generate', {
    method: 'POST',
    body: JSON.stringify({ connectionId: targetId, table: 'users', rows: 25, dryRun: true }),
  });
  assert.equal(preview.body.result.dryRun, true);
  assert.equal(preview.body.result.rowsPreview.length, 5);
  const generated = await api<{ result: { inserted: number } }>('/generate', {
    method: 'POST',
    body: JSON.stringify({ connectionId: targetId, table: 'users', rows: 25 }),
  });
  assert.equal(generated.body.result.inserted, 25);
  const generatedCount = await api<{ batch: { sets: Array<{ rows: unknown[][] }> } }>('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: targetId, sql: 'SELECT COUNT(*) FROM users' }),
  });
  assert.equal(Number(generatedCount.body.batch.sets[0].rows[0][0]), 25);

  const job = await api<{ job: { id: string } }>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: 'count orders', connectionId: demo.id, type: 'query', sql: 'SELECT COUNT(*) FROM orders', intervalSeconds: 3600 }),
  });
  assert.equal(job.status, 201);
  const run = await api<{ ok: boolean; message: string }>(`/jobs/${job.body.job.id}/run`, { method: 'POST' });
  assert.equal(run.body.ok, true);
  const jobs = await api<{ jobs: Array<{ id: string; lastStatus?: string }> }>('/jobs');
  assert.ok(jobs.body.jobs.some((item) => item.id === job.body.job.id && item.lastStatus === 'ok'));
  await api(`/jobs/${job.body.job.id}`, { method: 'DELETE' });

  const dataCompare = await api<{ result: any }>('/data/compare', {
    method: 'POST',
    body: JSON.stringify({ sourceId: demo.id, targetId }),
  });
  assert.ok(dataCompare.body.result.rows.some((row: any) => row.table === 'orders' && row.status === 'same'));
  assert.ok(dataCompare.body.result.rows.some((row: any) => row.table === 'users' && row.status === 'different'));

  const advanced = await api<{ objects: any }>(`/objects?connectionId=${demo.id}`);
  assert.equal(advanced.body.objects.supported, true);
  assert.ok(Array.isArray(advanced.body.objects.triggers));

  await api(`/connections/${targetId}`, { method: 'DELETE' });
});

test('pairing issues a device token and revocation blocks it', async () => {
  const start = await api<{ code: string }>('/pair/start', { method: 'POST' });
  assert.equal(start.status, 200);
  assert.match(start.body.code, /^\d{6}$/);
  const claim = await fetch(`${base}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: start.body.code, deviceName: 'Integration Phone', platform: 'android' }),
  });
  assert.equal(claim.status, 200);
  const claimed = (await claim.json()) as any;
  assert.ok(claimed.token);
  const withDevice = await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${claimed.token}` } });
  assert.equal(withDevice.status, 200);
  const devices = await api<{ devices: Array<{ id: string }> }>('/devices');
  assert.ok(devices.body.devices.length === 1);
  await api(`/devices/${devices.body.devices[0].id}`, { method: 'DELETE' });
  const afterRevoke = await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${claimed.token}` } });
  assert.equal(afterRevoke.status, 401);
});

test('websocket protocol streams a full agent turn', async () => {
  const session = await api<{ session: { id: string } }>('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id }),
  });
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const events: any[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket turn timed out')), 20000);
    ws.on('message', (raw) => {
      const event = JSON.parse(String(raw));
      events.push(event);
      if (event.type === 'turn_end') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  ws.send(JSON.stringify({ type: 'turn', sessionId: session.body.session.id, text: '看看有哪些表', mode: 'ask' }));
  await completed;
  ws.close();
  assert.ok(events.some((event) => event.type === 'start'));
  assert.ok(events.some((event) => event.type === 'tool_call' && event.tool === 'inspect_schema'));
  assert.ok(events.some((event) => event.type === 'done'));
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('agent session remembers the selected database', async () => {
  const created = await api<{ session: { id: string; database?: string } }>('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, database: 'demo_db_one' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.session.database, 'demo_db_one');

  const patched = await api<{ session: { database?: string } }>(`/agent/sessions/${created.body.session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ database: 'demo_db_two' }),
  });
  assert.equal(patched.body.session.database, 'demo_db_two');

  const detail = await api<{ session: { database?: string } }>(`/agent/sessions/${created.body.session.id}`);
  assert.equal(detail.body.session.database, 'demo_db_two');
});

test('agent turn runs against the database chosen in the session', async () => {
  const created = await api<{ session: { id: string } }>('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id }),
  });
  const sessionId = created.body.session.id;

  await runTurn(sessionId, '看看有哪些表', 'ask', false, 'demo_db_one');

  // 工具没传 database 时，执行器应以会话选中的库为准
  const audit = await api<{ entries: Array<{ tool: string; database?: string }> }>(`/audit?connectionId=${demo.id}&limit=20`);
  const inspect = audit.body.entries.find((entry) => entry.tool === 'inspect_schema');
  assert.equal(inspect?.database, 'demo_db_one');

  const detail = await api<{ session: { database?: string } }>(`/agent/sessions/${sessionId}`);
  assert.equal(detail.body.session.database, 'demo_db_one');
});
