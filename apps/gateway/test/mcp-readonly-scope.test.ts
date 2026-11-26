import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const TOKEN = 'mcp-scope-test-token';
const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-scope-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'mcp-scope-test-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  attachmentDir: join(home, 'attachments'),
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

const api = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

async function claim(scope?: string): Promise<{ token: string; id: string }> {
  // MCP 专用链路：/pair/mcp/start + /pair/mcp/claim，scope 由服务端硬编码。
  const started = await api(scope ? '/pair/mcp/start' : '/pair/start', { method: 'POST' });
  const s = (await started.json()) as { code: string };
  const res = await api(scope ? '/pair/mcp/claim' : '/pair/claim', {
    method: 'POST',
    body: JSON.stringify({ code: s.code, deviceName: 'test', platform: 'test' }),
  });
  const body = (await res.json()) as { token: string; device: { id: string } };
  assert.equal(res.status, 200, JSON.stringify(body));
  return { token: body.token, id: body.device.id };
}

test('mcp:readonly token can only reach the read-only MCP bridge', async () => {
  const mcp = await claim('mcp:readonly');
  const cases: Array<[string, string, RequestInit, number, string?]> = [
    ['GET', '/health', {}, 200],
    ['GET', '/capabilities', {}, 403, 'SCOPE_DENIED'],
    ['GET', '/agent/tools?for=mcp', {}, 200],
    ['POST', '/agent/tools/list_connections', { body: JSON.stringify({ args: {} }) }, 200],
    // risk 错标成 'read' 但会写持久状态的工具，必须被显式白名单拒绝。
    ['POST', '/agent/tools/memory_write', { body: JSON.stringify({ args: { kind: 'fact', title: 'PWN', content: 'x' } }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/update_plan', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/backup_database', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/render_chart', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/analyze_chart', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/forecast_chart', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/create_table', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/create_connection', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['POST', '/agent/tools/probe_engine', { body: JSON.stringify({ args: {} }) }, 403, 'TOOL_NOT_EXPOSED'],
    ['GET', '/connections', {}, 403, 'SCOPE_DENIED'],
    ['GET', '/settings', {}, 403, 'SCOPE_DENIED'],
    ['POST', '/query', { body: JSON.stringify({ connectionId: 'demo', sql: 'SELECT 1' }) }, 403, 'SCOPE_DENIED'],
    ['GET', '/mcp/servers', {}, 403, 'SCOPE_DENIED'],
    // 不能靠 /agent/tools/ 前缀蒙混到别的路由。
    ['POST', '/agent/tools/foo/bar', { body: JSON.stringify({ args: {} }) }, 403, 'SCOPE_DENIED'],
  ];
  for (const [method, path, init, status, code] of cases) {
    const res = await api(path, { ...init, method }, mcp.token);
    assert.equal(res.status, status, `${method} ${path} -> ${res.status}`);
    if (code) {
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, code, `${method} ${path}`);
    } else {
      await res.arrayBuffer();
    }
  }
});

test('mcp:readonly token cannot enumerate the full tool catalog', async () => {
  const mcp = await claim('mcp:readonly');
  const res = await api('/agent/tools', {}, mcp.token);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tools: Array<{ name: string }> };
  assert.ok(!body.tools.some((t) => ['mcp_call', 'mcp_list_servers', 'mcp_list_tools', 'memory_write', 'create_table', 'create_connection', 'probe_engine', 'backup_database', 'render_chart', 'analyze_chart', 'forecast_chart'].includes(t.name)));
});

test('mcp:readonly 在执行前拒绝 run_sql/explain_sql 携带的写 SQL', async () => {
  const mcp = await claim('mcp:readonly');
  const connection = gateway.store.listConnections().find((item) => item.engine === 'sqlite');
  assert.ok(connection);
  const count = async () => (await gateway.manager.query(connection.id, 'SELECT COUNT(*) AS n FROM users', { maxRows: 1, actor: 'user' })).sets[0]?.rows?.[0]?.[0];
  const before = await count();

  for (const name of ['run_sql', 'explain_sql']) {
    const response = await api(`/agent/tools/${name}`, {
      method: 'POST',
      body: JSON.stringify({ args: { connectionId: connection.id, sql: 'DELETE FROM users' } }),
    }, mcp.token);
    assert.equal(response.status, 403, name);
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'TOOL_READ_ONLY', name);
  }
  assert.equal(await count(), before, '只读 MCP 请求不能改变数据库');
});

test('mcp:readonly 逐条拒绝 session、PRAGMA setter 与危险方括号 SQL', async () => {
  const mcp = await claim('mcp:readonly');
  const boundaryFile = join(home, 'mcp-sql-boundary.sqlite');
  const seed = new DatabaseSync(boundaryFile);
  seed.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  seed.close();
  const sqlite = gateway.store.createConnection({ name: 'MCP SQL boundary', engine: 'sqlite', database: boundaryFile });
  const sqlserver = gateway.store.createConnection({ name: 'MCP MSSQL boundary', engine: 'sqlserver', host: '127.0.0.1', port: 1, database: 'master' });
  const before = await gateway.manager.query(sqlite.id, 'PRAGMA foreign_keys', { actor: 'user', autoLimit: false });
  const cases = [
    { connectionId: sqlite.id, sql: 'SELECT 1; BEGIN', allowMulti: true },
    { connectionId: sqlite.id, sql: 'PRAGMA foreign_keys=OFF' },
    { connectionId: sqlserver.id, sql: "SELECT [foo']; DELETE FROM dbo.users; --] FROM dbo.users" },
  ];
  for (const name of ['run_sql', 'explain_sql']) {
    for (const args of cases) {
      const response = await api(`/agent/tools/${name}`, {
        method: 'POST',
        body: JSON.stringify({ args }),
      }, mcp.token);
      assert.equal(response.status, 403, `${name}: ${args.sql}`);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, 'TOOL_READ_ONLY', `${name}: ${args.sql}`);
    }
  }
  const adminBridge = await api('/agent/tools/run_sql', {
    method: 'POST',
    body: JSON.stringify({ args: { connectionId: sqlite.id, sql: 'SELECT 1; BEGIN', allowMulti: true } }),
  });
  assert.equal(adminBridge.status, 403, '普通凭据的出站 MCP 桥也不能靠聚合 read 混入 session');
  const state = await gateway.manager.query(sqlite.id, 'PRAGMA foreign_keys', { actor: 'user', autoLimit: false });
  assert.equal(Number(state.sets[0].rows[0][0]), Number(before.sets[0].rows[0][0]), '被拒绝的 PRAGMA 不能改变数据库连接状态');
});

test('直接 /query 的 allowMulti 不能突破服务端开关', async () => {
  const connection = gateway.store.listConnections().find((item) => item.engine === 'sqlite');
  assert.ok(connection);
  const original = gateway.store.getSettings();
  const sql = 'SELECT 1 AS a; SELECT 2 AS b';
  try {
    gateway.store.saveSettings({ ...original, allowMultiStatement: false });
    for (const allowMulti of [undefined, false, true]) {
      const response = await api('/query', {
        method: 'POST',
        body: JSON.stringify({ connectionId: connection.id, sql, ...(allowMulti === undefined ? {} : { allowMulti }) }),
      });
      assert.equal(response.status, 400, `服务端关闭时 allowMulti=${String(allowMulti)}`);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, 'SCRIPT_TOO_LARGE');
    }

    gateway.store.saveSettings({ ...original, allowMultiStatement: true });
    for (const allowMulti of [undefined, true]) {
      const response = await api('/query', {
        method: 'POST',
        body: JSON.stringify({ connectionId: connection.id, sql, ...(allowMulti === undefined ? {} : { allowMulti }) }),
      });
      assert.equal(response.status, 200, `服务端开启时 allowMulti=${String(allowMulti)}`);
      const body = (await response.json()) as { batch?: { sets?: unknown[] } };
      assert.equal(body.batch?.sets?.length, 2);
    }
    const veto = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: connection.id, sql, allowMulti: false }),
    });
    assert.equal(veto.status, 400, '客户端仍可用 false 主动关闭批量');
    const vetoBody = (await veto.json()) as { error?: { code?: string } };
    assert.equal(vetoBody.error?.code, 'SCRIPT_TOO_LARGE');

    const sqlserver = gateway.store.createConnection({ name: 'Direct MSSQL boundary', engine: 'sqlserver', host: '127.0.0.1', port: 1, database: 'master' });
    const unsafe = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ connectionId: sqlserver.id, sql: "SELECT [foo']; DELETE FROM dbo.users; --] FROM dbo.users", allowMulti: true }),
    });
    assert.equal(unsafe.status, 400);
    const unsafeBody = (await unsafe.json()) as { error?: { code?: string } };
    assert.equal(unsafeBody.error?.code, 'SQL_UNKNOWN');
  } finally {
    gateway.store.saveSettings(original);
  }
});

test('revoking the device invalidates the mcp:readonly credential', async () => {
  const mcp = await claim('mcp:readonly');
  const revoked = await api(`/devices/${mcp.id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 204);
  const res = await api('/agent/tools?for=mcp', {}, mcp.token);
  assert.equal(res.status, 401);
});

test('a new mobile device is restricted to explicitly authorized connections', async () => {
  const mobile = await claim();
  const res = await api('/connections', {}, mobile.token);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { connections: unknown[] };
  assert.deepEqual(body.connections, []);
  const settings = await api('/settings', {}, mobile.token);
  assert.equal(settings.status, 403);
});
