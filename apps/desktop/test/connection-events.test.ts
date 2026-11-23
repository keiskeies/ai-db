import assert from 'node:assert/strict';
import test from 'node:test';

const calls: string[] = [];
let holdConnections = false;
let releaseConnections: ((response: Response) => void) | undefined;
globalThis.location = { hash: '#token=t', pathname: '/', search: '' } as unknown as Location;
globalThis.history = { replaceState() {} } as unknown as History;
const mem = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, String(value)),
  removeItem: (key: string) => void mem.delete(key),
} as unknown as Storage;
globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
const connections = [
  { id: 'active', name: 'active', engine: 'mysql', color: 'blue', environment: 'dev', groupName: '默认', host: '127.0.0.1', port: 3306, readonly: false, createdAt: '', updatedAt: '' },
  { id: 'created', name: 'created', engine: 'postgresql', color: 'blue', environment: 'dev', groupName: '默认', host: '127.0.0.1', port: 5432, readonly: false, createdAt: '', updatedAt: '' },
];
let connectionsResponse = connections;
globalThis.fetch = (async (input: any) => {
  const path = String(input);
  calls.push(path);
  if (path === '/api/connections' && holdConnections) {
    holdConnections = false;
    return new Promise<Response>((resolve) => { releaseConnections = resolve; });
  }
  return new Response(JSON.stringify(path === '/api/connections' ? { connections: connectionsResponse } : {}), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const { useApp } = await import('../src/store');

test('connections_changed refreshes and expands without switching the active connection or loading a default database', async () => {
  useApp.setState({ connections: [connections[0]], activeConnectionId: 'active', agentDatabase: 'keep', expandedConnections: { active: true }, eventExpandedConnections: {}, schemas: {}, loadedDatabases: {} });
  calls.length = 0;
  await useApp.getState().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: 'created', change: 'created', at: new Date().toISOString() });
  const state = useApp.getState();
  assert.deepEqual(state.connections.map((item) => item.id), ['active', 'created']);
  assert.equal(state.activeConnectionId, 'active');
  assert.equal(state.agentDatabase, 'keep');
  assert.equal(state.expandedConnections.created, true);
  assert.equal(state.eventExpandedConnections.created, true);
  assert.equal(state.schemas.created, undefined);
  assert.deepEqual(state.loadedDatabases.created ?? [], []);
  assert.deepEqual(calls, ['/api/connections']);
});

test('an older connections_changed response cannot overwrite a newer event', async () => {
  useApp.setState({ connections: [connections[0]], activeConnectionId: 'active', expandedConnections: {}, schemas: {} });
  connectionsResponse = [connections[0]];
  holdConnections = true;
  const older = useApp.getState().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: 'created', change: 'created', at: 'older' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  connectionsResponse = connections;
  await useApp.getState().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: 'created', change: 'updated', at: 'newer' });
  releaseConnections?.(new Response(JSON.stringify({ connections: [connections[0]] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await older;
  assert.deepEqual(useApp.getState().connections.map((item) => item.id), ['active', 'created']);
  assert.equal(useApp.getState().activeConnectionId, 'active');
});

test('updated connections invalidate stale schema state without switching focus', async () => {
  useApp.setState({
    connections: [connections[0]], activeConnectionId: 'other', expandedConnections: { active: true },
    schemas: { active: [] }, loadedDatabases: { active: ['db'] }, schemaLoading: { 'active:db': true }, expandedSchemas: { 'active:db': true },
  });
  connectionsResponse = [connections[0]];
  await useApp.getState().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: 'active', change: 'updated', at: new Date().toISOString() });
  const state = useApp.getState();
  assert.equal(state.activeConnectionId, 'other');
  assert.equal(state.schemas.active, undefined);
  assert.equal(state.loadedDatabases.active, undefined);
  assert.equal(state.schemaLoading['active:db'], undefined);
  assert.equal(state.expandedSchemas['active:db'], undefined);
});

test('a stale delete response still cleans state after a newer create snapshot', async () => {
  useApp.setState({
    connections: [connections[0]], activeConnectionId: 'active', agentDatabase: 'db', eventExpandedConnections: {},
    expandedConnections: { active: true }, schemas: { active: [] }, loadedDatabases: { active: ['db'] },
    tabs: [{ id: 'query-1', kind: 'query', title: 'q', connectionId: 'active', sql: 'SELECT 1' }], activeTabId: 'query-1',
  });
  connectionsResponse = [];
  holdConnections = true;
  const olderDelete = useApp.getState().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: 'active', change: 'deleted', at: 'older' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  connectionsResponse = [connections[1]];
  await useApp.getState().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: 'created', change: 'created', at: 'newer' });
  releaseConnections?.(new Response(JSON.stringify({ connections: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await olderDelete;
  const state = useApp.getState();
  assert.deepEqual(state.connections.map((item) => item.id), ['created']);
  assert.equal(state.schemas.active, undefined);
  assert.equal(state.loadedDatabases.active, undefined);
  assert.equal(state.expandedConnections.active, undefined);
  assert.ok(state.tabs.every((tab) => !('connectionId' in tab && tab.connectionId === 'active')));
});

test('reconnect reconciliation removes connections deleted while offline', async () => {
  useApp.setState({ connections: [connections[0]], activeConnectionId: 'active', eventExpandedConnections: {}, schemas: { active: [] }, loadedDatabases: { active: ['db'] } });
  connectionsResponse = [];
  await useApp.getState().syncConnectionsFromEvent();
  const state = useApp.getState();
  assert.deepEqual(state.connections, []);
  assert.equal(state.activeConnectionId, undefined);
  assert.equal(state.schemas.active, undefined);
  assert.equal(state.loadedDatabases.active, undefined);
});

test('deleted connections clear tabs and all per-connection schema state', async () => {
  useApp.setState({
    connections: [connections[0]], activeConnectionId: 'active', agentDatabase: 'db',
    expandedConnections: { active: true }, schemas: { active: [] }, loadedDatabases: { active: ['db'] },
    schemaLoading: { 'active:db': true }, expandedSchemas: { 'active:db': true },
    tabs: [{ id: 'query-1', kind: 'query', title: 'q', connectionId: 'active', sql: 'SELECT 1' }], activeTabId: 'query-1',
  });
  connectionsResponse = [];
  await useApp.getState().syncConnectionsFromEvent({ type: 'connections_changed', connectionId: 'active', change: 'deleted', at: new Date().toISOString() });
  const state = useApp.getState();
  assert.deepEqual(state.connections, []);
  assert.equal(state.activeConnectionId, undefined);
  assert.equal(state.agentDatabase, '');
  assert.equal(state.schemas.active, undefined);
  assert.equal(state.loadedDatabases.active, undefined);
  assert.equal(state.schemaLoading['active:db'], undefined);
  assert.equal(state.expandedSchemas['active:db'], undefined);
  assert.equal(state.expandedConnections.active, undefined);
  assert.deepEqual(state.tabs.map((tab) => tab.id), ['welcome']);
  assert.equal(state.activeTabId, 'welcome');
});
