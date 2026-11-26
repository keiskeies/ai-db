import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';
import { hashToken } from '../src/crypto';
import type { AgentAccessContext } from '../src/agentHost';

const TOKEN = 'device-capabilities-token';
const DEVICE_TOKEN = 'device-capabilities-mobile';
const ADMIN_DEVICE_TOKEN = 'device-capabilities-admin';
const home = mkdtempSync(join(tmpdir(), 'aidb-device-capabilities-'));
for (const dir of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(home, dir), { recursive: true });

function seedDatabase(name: string): string {
  const path = join(home, name);
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.exec("INSERT INTO items (name) VALUES ('allowed-row')");
  db.close();
  return path;
}

const allowedPath = seedDatabase('allowed.db');
const deniedPath = seedDatabase('denied.db');
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'device-capabilities-secret',
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
const port = await listenRandom(gateway.server);
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;

const allowed = gateway.store.createConnection({
  name: 'Allowed SQLite',
  engine: 'sqlite',
  database: allowedPath,
  host: 'internal.example',
  username: 'root',
  password: 'do-not-expose',
  note: 'do-not-expose-note',
});
const denied = gateway.store.createConnection({
  name: 'Denied SQLite',
  engine: 'sqlite',
  database: deniedPath,
  host: 'other.internal',
  username: 'other-user',
});
const device = gateway.store.createDevice({
  name: 'Phone',
  platform: 'ios',
  tokenHash: hashToken(DEVICE_TOKEN),
  scope: 'device',
  connectionIds: [allowed.id],
});
const adminDevice = gateway.store.createDevice({
  name: 'Trusted desktop',
  platform: 'desktop',
  tokenHash: hashToken(ADMIN_DEVICE_TOKEN),
  scope: 'admin',
});
const access: AgentAccessContext = {
  scope: 'device',
  deviceId: device.id,
  connectionIds: [allowed.id],
};

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api(path: string, init: RequestInit = {}, token = TOKEN) {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, any> : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers, text };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

test('mobile pairing persists only the server-side ACL and claim fields cannot escalate it', async () => {
  const started = await api('/pair/start', post({ connectionIds: [allowed.id] }));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const claimed = await api('/pair/claim', post({
    code: started.body.code,
    deviceName: 'Paired phone',
    platform: 'ios',
    scope: 'admin',
    connectionIds: [denied.id],
  }), DEVICE_TOKEN);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.device.scope, 'device');
  assert.deepEqual(claimed.body.device.connectionIds, [allowed.id]);

  const listed = await api('/connections', {}, claimed.body.token);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.connections.map((item: { id: string }) => item.id), [allowed.id]);
  const view = listed.body.connections[0];
  for (const field of ['host', 'port', 'username', 'password', 'ssh', 'options', 'authMode', 'note']) {
    assert.equal(Object.hasOwn(view, field), false, `${field} must not be exposed to a device`);
  }
});

test('device bootstrap returns only ACL-scoped data and read-only initialization settings', async () => {
  const visible = gateway.store.createSession({ connectionId: allowed.id, title: 'visible', permissionMode: 'readonly' });
  const hidden = gateway.store.createSession({ connectionId: denied.id, title: 'hidden', permissionMode: 'readonly' });
  const response = await api('/bootstrap', {}, DEVICE_TOKEN);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.connections.map((item: { id: string }) => item.id), [allowed.id]);
  assert.deepEqual(response.body.sessions.map((item: { id: string }) => item.id), [visible.id]);
  assert.ok(!response.body.sessions.some((item: { id: string }) => item.id === hidden.id));
  const connection = response.body.connections[0];
  for (const field of ['host', 'port', 'username', 'password', 'ssh', 'options', 'authMode', 'note']) {
    assert.equal(Object.hasOwn(connection, field), false, `${field} must not be exposed to a device`);
  }
  assert.equal(response.body.settings.agent.baseUrl, '');
  assert.equal(response.body.settings.agent.apiKey, undefined);
  assert.equal(response.body.settings.agent.modelConfigs, undefined);
  assert.equal(response.body.settings.search.proxyUrl, undefined);
  assert.equal(response.body.settings.search.searxngBaseUrl, '');
  const names = response.body.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes('run_sql'));
  assert.ok(!names.includes('create_connection'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('device artifacts are filtered by source connection and memories keep working', async () => {
  const allowedArtifact = gateway.store.createArtifact({
    type: 'report',
    title: 'allowed-report',
    status: 'ready',
    spec: { version: 1, type: 'report', title: 'allowed-report', sources: [{ connectionId: allowed.id }] },
  });
  const deniedArtifact = gateway.store.createArtifact({
    type: 'report',
    title: 'denied-report',
    status: 'ready',
    spec: { version: 1, type: 'report', title: 'denied-report', sources: [{ connectionId: denied.id }] },
  });
  const orphanArtifact = gateway.store.createArtifact({
    type: 'report',
    title: 'host-report',
    status: 'ready',
    spec: { version: 1, type: 'report', title: 'host-report' },
  });

  const listed = await api('/artifacts', {}, DEVICE_TOKEN);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const ids = listed.body.artifacts.map((item: { id: string }) => item.id);
  assert.ok(ids.includes(allowedArtifact.id));
  assert.ok(!ids.includes(deniedArtifact.id), '不得暴露其他连接的产物');
  assert.ok(!ids.includes(orphanArtifact.id), '无来源信息的宿主产物对设备不可见');
  assert.equal((await api(`/artifacts/${allowedArtifact.id}`, {}, DEVICE_TOKEN)).status, 200);
  assert.equal((await api(`/artifacts/${deniedArtifact.id}`, {}, DEVICE_TOKEN)).status, 404);

  const created = await api('/agent/memories', post({
    title: '设备记忆', content: '移动端可维护 Agent 记忆', kind: 'fact', scopeType: 'global',
  }), DEVICE_TOKEN);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const memories = await api('/agent/memories', {}, DEVICE_TOKEN);
  assert.equal(memories.status, 200);
  assert.ok(memories.body.memories.some((item: { id: string }) => item.id === created.body.memory.id));
  const removed = await api(`/agent/memories/${created.body.memory.id}`, { method: 'DELETE' }, DEVICE_TOKEN);
  assert.equal(removed.status, 204);
});

test('revoked and readonly MCP devices cannot bootstrap', async () => {
  const mcpToken = 'device-capabilities-mcp';
  gateway.store.createDevice({ name: 'MCP', platform: 'mcp', tokenHash: hashToken(mcpToken), scope: 'mcp:readonly' });
  const deniedMcp = await api('/bootstrap', {}, mcpToken);
  assert.equal(deniedMcp.status, 403);
  assert.equal(deniedMcp.body.error.code, 'SCOPE_DENIED');

  const revokedToken = 'device-capabilities-revoked';
  const revoked = gateway.store.createDevice({ name: 'Revoked', platform: 'ios', tokenHash: hashToken(revokedToken) });
  gateway.store.revokeDevice(revoked.id);
  const deniedRevoked = await api('/bootstrap', {}, revokedToken);
  assert.equal(deniedRevoked.status, 401);
  assert.equal(deniedRevoked.body.error.code, 'UNAUTHORIZED');
});

test('device capability matrix denies management, secrets, host files, and direct tool execution', async () => {
  const cases: Array<[string, string, RequestInit]> = [
    ['GET', '/settings', {}],
    ['GET', '/audit', {}],
    ['GET', '/devices', {}],
    ['GET', '/mcp/servers', {}],
    ['GET', '/notifications/channels', {}],
    ['GET', '/skills', {}],
    ['GET', '/backups', {}],
    ['GET', '/snippets', {}],
    ['GET', '/history', {}],
    ['GET', '/export/file?path=' + encodeURIComponent(allowedPath), {}],
    ['POST', '/connections', post({ name: 'evil', engine: 'sqlite', database: ':memory:' })],
    ['POST', '/pair/start', post({})],
    ['POST', '/backups', post({ connectionId: allowed.id })],
    ['POST', '/mcp/servers', post({ name: 'evil', command: 'node', args: ['-e', 'process.exit()'] })],
    ['POST', '/agent/tools/create_connection', post({ args: {} })],
    ['POST', '/agent/tools/mcp_call', post({ args: {} })],
    ['PUT', '/settings', { method: 'PUT', body: JSON.stringify({}) }],
    ['PUT', `/connections/${allowed.id}`, { method: 'PUT', body: JSON.stringify({ host: 'evil' }) }],
    ['PUT', `/devices/${device.id}/permissions`, { method: 'PUT', body: JSON.stringify({ connectionIds: [denied.id] }) }],
    ['DELETE', `/connections/${allowed.id}`, { method: 'DELETE' }],
  ];
  for (const [method, path, init] of cases) {
    const response = await api(path, { ...init, method }, DEVICE_TOKEN);
    assert.equal(response.status, 403, `${method} ${path}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error?.code, 'SCOPE_DENIED', `${method} ${path}`);
  }
});

test('connection ACL is enforced for queries, schema reads, and Agent sessions', async () => {
  const deniedQuery = await api('/query', post({ connectionId: denied.id, sql: 'SELECT * FROM items' }), DEVICE_TOKEN);
  assert.equal(deniedQuery.status, 403);
  assert.equal(deniedQuery.body.error?.code, 'CONNECTION_FORBIDDEN');

  const allowedQuery = await api('/query', post({ connectionId: allowed.id, sql: 'SELECT * FROM items' }), DEVICE_TOKEN);
  assert.equal(allowedQuery.status, 200, JSON.stringify(allowedQuery.body));
  assert.equal(allowedQuery.body.batch.sets[0].rows[0][1], 'allowed-row');

  const deniedData = await api(`/data?connectionId=${denied.id}&table=items&limit=5`, {}, DEVICE_TOKEN);
  assert.equal(deniedData.status, 403);
  assert.equal(deniedData.body.error?.code, 'CONNECTION_FORBIDDEN');
  const allowedData = await api(`/data?connectionId=${allowed.id}&table=items&limit=5`, {}, DEVICE_TOKEN);
  assert.equal(allowedData.status, 200, JSON.stringify(allowedData.body));
  assert.equal(allowedData.body.batch.sets[0].rows[0][1], 'allowed-row');

  const deniedSchema = await api(`/connections/${denied.id}/schema`, {}, DEVICE_TOKEN);
  assert.equal(deniedSchema.status, 403);
  assert.equal(deniedSchema.body.error?.code, 'CONNECTION_FORBIDDEN');
  const allowedSchema = await api(`/connections/${allowed.id}/schema`, {}, DEVICE_TOKEN);
  assert.equal(allowedSchema.status, 200, JSON.stringify(allowedSchema.body));

  const created = await api('/agent/sessions', post({ connectionId: allowed.id, permissionMode: 'readonly' }), DEVICE_TOKEN);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const hidden = gateway.store.createSession({ connectionId: denied.id, title: 'hidden', permissionMode: 'readonly' });
  const listed = await api('/agent/sessions', {}, DEVICE_TOKEN);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.sessions.some((session: { id: string }) => session.id === created.body.session.id));
  assert.ok(!listed.body.sessions.some((session: { id: string }) => session.id === hidden.id));

  const crossCreate = await api('/agent/sessions', post({ connectionId: denied.id }), DEVICE_TOKEN);
  assert.equal(crossCreate.status, 403);
  assert.equal(crossCreate.body.error?.code, 'CONNECTION_FORBIDDEN');
  const crossRead = await api(`/agent/sessions/${hidden.id}`, {}, DEVICE_TOKEN);
  assert.equal(crossRead.status, 403);
  assert.equal(crossRead.body.error?.code, 'CONNECTION_FORBIDDEN');
});

test('admin grant and revoke update the effective device ACL without allowing self-service escalation', async () => {
  const selfGrant = await api(`/devices/${device.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ connectionIds: [denied.id] }),
  }, DEVICE_TOKEN);
  assert.equal(selfGrant.status, 403);

  const granted = await api(`/devices/${device.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ connectionIds: [allowed.id, denied.id] }),
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.connectionIds, [allowed.id, denied.id].sort());
  const newlyAllowed = await api('/query', post({ connectionId: denied.id, sql: 'SELECT * FROM items' }), DEVICE_TOKEN);
  assert.equal(newlyAllowed.status, 200, JSON.stringify(newlyAllowed.body));

  const revoked = await api(`/devices/${device.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ connectionIds: [] }),
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body.connectionIds, []);
  const deniedAgain = await api('/query', post({ connectionId: denied.id, sql: 'SELECT * FROM items' }), DEVICE_TOKEN);
  assert.equal(deniedAgain.status, 403);
  assert.equal(deniedAgain.body.error?.code, 'CONNECTION_FORBIDDEN');

  await api(`/devices/${device.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ connectionIds: [allowed.id] }),
  });
});

test('Agent mode and connection overrides are rejected before SSE and independently by AgentHost', async () => {
  const created = await api('/agent/sessions', post({ connectionId: allowed.id, permissionMode: 'readonly' }), DEVICE_TOKEN);
  assert.equal(created.status, 201);
  const sessionId = created.body.session.id as string;

  for (const mode of ['auto', 'full']) {
    const response = await api(`/agent/sessions/${sessionId}/turns`, post({ text: 'hello', mode }), DEVICE_TOKEN);
    assert.equal(response.status, 403, mode);
    assert.equal(response.body.error?.code, 'MODE_NOT_ALLOWED', mode);
    assert.doesNotMatch(response.headers.get('content-type') ?? '', /text\/event-stream/);
  }
  const crossConnection = await api(`/agent/sessions/${sessionId}/turns`, post({
    text: 'hello', connectionId: denied.id, mode: 'readonly',
  }), DEVICE_TOKEN);
  assert.equal(crossConnection.status, 403);
  assert.equal(crossConnection.body.error?.code, 'CONNECTION_FORBIDDEN');
  assert.doesNotMatch(crossConnection.headers.get('content-type') ?? '', /text\/event-stream/);

  const init = await api(`/agent/sessions/${sessionId}/turns`, post({ text: '/init docs' }), DEVICE_TOKEN);
  assert.equal(init.status, 403);
  assert.equal(init.body.error?.code, 'COMMAND_NOT_ALLOWED');

  const fullSession = gateway.store.createSession({ connectionId: allowed.id, permissionMode: 'full' });
  const inheritedFull = await api(`/agent/sessions/${fullSession.id}/turns`, post({ text: 'hello' }), DEVICE_TOKEN);
  assert.equal(inheritedFull.status, 403);
  assert.equal(inheritedFull.body.error?.code, 'MODE_NOT_ALLOWED');

  await assert.rejects(
    gateway.host.startTurn(sessionId, { text: 'hello', mode: 'full' }, () => {}, access),
    (error: any) => error?.code === 'MODE_NOT_ALLOWED' && error?.status === 403,
  );
  await assert.rejects(
    gateway.host.startTurn(sessionId, { text: 'hello', mode: 'readonly', connectionId: denied.id }, () => {}, access),
    (error: any) => error?.code === 'CONNECTION_FORBIDDEN' && error?.status === 403,
  );

  const tools = await api('/agent/tools', {}, DEVICE_TOKEN);
  assert.equal(tools.status, 200);
  const names = tools.body.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes('run_sql'));
  for (const forbidden of ['create_connection', 'probe_engine', 'mcp_call', 'mcp_list_tools', 'export_result', 'backup_database', 'memory_write']) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
});

test('admin devices retain management and custom MCP capabilities', async () => {
  const connections = await api('/connections', {}, ADMIN_DEVICE_TOKEN);
  assert.equal(connections.status, 200);
  assert.ok(connections.body.connections.some((item: { id: string }) => item.id === denied.id));
  assert.equal(connections.body.connections.find((item: { id: string }) => item.id === denied.id).host, 'other.internal');

  const settings = await api('/settings', {}, ADMIN_DEVICE_TOKEN);
  assert.equal(settings.status, 200);
  const servers = await api('/mcp/servers', {}, ADMIN_DEVICE_TOKEN);
  assert.equal(servers.status, 200);
  const created = await api('/mcp/servers', post({ name: 'admin-only-mcp', command: 'node', args: ['-e', 'process.exit()'] }), ADMIN_DEVICE_TOKEN);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const removed = await api(`/mcp/servers/${created.body.server.id}`, { method: 'DELETE' }, ADMIN_DEVICE_TOKEN);
  assert.equal(removed.status, 204);

  const devices = await api('/devices', {}, ADMIN_DEVICE_TOKEN);
  assert.equal(devices.status, 200);
  assert.ok(devices.body.devices.some((item: { id: string }) => item.id === device.id));
});
