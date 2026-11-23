import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCandidates, PROBE_RANK, type ConnectionConfig, type ConnectionSecret } from '@aidb/core';
import { capToolArgs } from '../src/agentHost';
import { classifyProbeFailure, ConnectionProvisioner, isReservedProbeAddress } from '../src/connectionProvisioner';
import { GatewayEvents } from '../src/events';
import { authorityHost } from '../src/drivers/host';
import type { ConnectionManager } from '../src/manager';
import type { Store } from '../src/store';

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const now = new Date().toISOString();
  return {
    id: 'existing', name: 'existing', engine: 'mysql', color: 'blue', environment: 'dev', groupName: '默认',
    host: '192.168.1.7', port: 3306, database: 'shop', username: 'root', readonly: false, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function harness(options: { connections?: ConnectionConfig[]; secrets?: Record<string, ConnectionSecret>; test?: (config: ConnectionConfig) => Promise<{ ok: boolean; version?: string; latencyMs: number; message?: string; code?: string }> } = {}) {
  const connections = [...(options.connections ?? [])];
  const created: Array<Record<string, unknown>> = [];
  const invalidated: string[] = [];
  const events = new GatewayEvents();
  const emitted: Array<{ type: string; connectionId: string; change: string; at: string }> = [];
  events.onConnectionsChanged((event) => emitted.push(event));
  const store = {
    listConnections: () => connections,
    getConnectionSecret: (id: string) => options.secrets?.[id] ?? {},
    createConnection: (input: Record<string, unknown>) => {
      created.push(input);
      const saved = connection({ id: `created-${created.length}`, name: String(input.name), engine: input.engine as ConnectionConfig['engine'], host: String(input.host), port: Number(input.port), username: String(input.username), database: input.database as string | undefined });
      connections.push(saved);
      return saved;
    },
  } as unknown as Store;
  const manager = {
    testConfig: options.test ?? (async (config: ConnectionConfig) => config.engine === 'mysql' ? { ok: true, version: 'MySQL 8.0.36', latencyMs: 3 } : { ok: false, latencyMs: 1, message: 'Protocol error', code: 'EPROTO' }),
    invalidate: (id: string) => { invalidated.push(id); },
  } as unknown as ConnectionManager;
  return { provisioner: new ConnectionProvisioner(store, manager, events), created, invalidated, emitted };
}

const createArgs = { name: 'shop', engine: 'mysql', host: '192.168.1.7', port: 3306, username: 'root', database: 'shop' };

test('URL authorities keep IPv6 literals bracketed', () => {
  assert.equal(authorityHost('::1'), '[::1]');
  assert.equal(authorityHost('127.0.0.1'), '127.0.0.1');
  assert.equal(authorityHost('db.example.com'), 'db.example.com');
});

test('probe candidates use port hints without including file engines', () => {
  assert.deepEqual(probeCandidates(3306), ['mysql', 'mariadb', 'polardb', 'tdsql', 'greatsql', 'goldendb']);
  assert.deepEqual(probeCandidates(1), PROBE_RANK);
  assert.ok(probeCandidates(3306).every((engine) => !['sqlite', 'duckdb'].includes(engine)));
});

test('probe_engine keeps the real driver concurrency at four', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const h = harness({ test: async () => {
    active++;
    calls++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return { ok: false, message: 'Protocol error', code: 'EPROTO', latencyMs: 20 };
  } });
  const result = await h.provisioner.probe({ host: '192.168.1.7', port: 1, username: 'root' });
  assert.equal(result.outcome, 'unknown');
  assert.equal(calls, PROBE_RANK.length);
  assert.equal(maxActive, 4);
});

test('authentication errors identify the protocol instead of reporting an unknown database', () => {
  assert.equal(classifyProbeFailure({ code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied for user root' }), 'auth_failed');
  assert.equal(classifyProbeFailure({ code: '28P01', message: 'password authentication failed' }), 'auth_failed');
  assert.equal(classifyProbeFailure({ message: 'NOAUTH Authentication required' }), 'auth_failed');
  assert.equal(classifyProbeFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }), 'unreachable');
  assert.equal(classifyProbeFailure({ code: 'EPROTO', message: 'Protocol error' }), 'protocol_mismatch');
  assert.equal(classifyProbeFailure({ code: 'CLICKHOUSE_TIMEOUT', message: 'ClickHouse 查询超时' }), 'unreachable');
  assert.equal(classifyProbeFailure({ code: 'SEARCH_401', message: 'missing authentication credentials' }), 'auth_failed');
  assert.equal(classifyProbeFailure({ message: 'something else' }), 'unknown');
});

test('probe_engine tests one transport for a shared port and performs no store writes', async () => {
  const h = harness();
  const result = await h.provisioner.probe({ host: '192.168.1.7', port: 3306, username: 'root' });
  assert.equal(result.outcome, 'connected');
  assert.equal(result.recommendation, 'mysql');
  assert.deepEqual(result.protocolMatches.slice(0, 6).map((item) => item.engine), ['mysql', 'mariadb', 'polardb', 'tdsql', 'greatsql', 'goldendb']);
  assert.equal(result.passwordRef, undefined);
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.invalidated, []);
});

test('probe_engine can identify a protocol when credentials are rejected and does not issue a password ref', async () => {
  const h = harness({ test: async (config) => config.engine === 'mysql' ? { ok: false, code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied for user root', latencyMs: 2 } : { ok: false, message: 'Protocol error', latencyMs: 1 } });
  const result = await h.provisioner.probe({ host: '192.168.1.7', port: 3306, username: 'root' });
  assert.equal(result.outcome, 'auth_failed');
  assert.equal(result.recommendation, 'mysql');
  assert.ok(result.protocolMatches.every((item) => item.version === undefined));
  assert.equal(result.passwordRef, undefined);
});

test('probe_engine uses the version string to distinguish products sharing a transport', async () => {
  const maria = harness({ test: async (config) => config.engine === 'mysql' ? { ok: true, version: 'MySQL 10.11.6-MariaDB', latencyMs: 2 } : { ok: false, message: 'Protocol error', latencyMs: 1 } });
  const mariaResult = await maria.provisioner.probe({ host: '192.168.1.7', port: 3306, username: 'root' });
  assert.equal(mariaResult.recommendation, 'mariadb');
  assert.equal(mariaResult.protocolMatches[0]?.engine, 'mariadb');

  const search = harness({ test: async (config) => config.engine === 'elasticsearch' ? { ok: true, version: 'OpenSearch 2.11.0', latencyMs: 2 } : { ok: false, message: 'Protocol error', latencyMs: 1 } });
  const searchResult = await search.provisioner.probe({ host: '192.168.1.7', port: 9200, username: 'root' });
  assert.equal(searchResult.recommendation, 'opensearch');
  assert.equal(searchResult.protocolMatches[0]?.engine, 'opensearch');
});

test('a passwordRef cannot be replayed against another endpoint', async () => {
  const existing = connection({ database: 'other', hasPassword: true });
  const h = harness({ connections: [existing], secrets: { existing: { password: 'stored-secret' } } });
  const probe = await h.provisioner.probe({ host: '192.168.1.7', port: 3306, username: 'root' });
  await assert.rejects(() => h.provisioner.create({ ...createArgs, host: '192.168.1.8', passwordRef: probe.passwordRef }), /目标地址不匹配/);
  assert.deepEqual(h.created, []);
});

test('probe_engine reuses a saved credential through a one-time ref and create_connection consumes it', async () => {
  const existing = connection({ database: 'other', hasPassword: true });
  let testedConfig: ConnectionConfig | undefined;
  const h = harness({
    connections: [existing], secrets: { existing: { password: 'stored-secret' } },
    test: async (config) => { testedConfig = config; return { ok: true, version: 'MySQL 8.0.36', latencyMs: 3 }; },
  });
  const probe = await h.provisioner.probe({ host: '192.168.1.7', port: 3306, username: 'root', database: 'shop' });
  assert.ok(probe.passwordRef);
  const created = await h.provisioner.create({ ...createArgs, passwordRef: probe.passwordRef, sslInsecure: true });
  assert.equal(created.tested, true);
  assert.equal(testedConfig?.sslInsecure, true);
  assert.equal(created.connection.id, 'created-1');
  assert.equal(h.created[0]?.password, 'stored-secret');
  assert.ok(!JSON.stringify(created).includes('stored-secret'));
  assert.deepEqual(h.invalidated, ['created-1']);
  assert.deepEqual(h.emitted, [{ type: 'connections_changed', connectionId: 'created-1', change: 'created', at: h.emitted[0]?.at }]);
  await assert.rejects(() => h.provisioner.create({ ...createArgs, database: 'another', passwordRef: probe.passwordRef }), /passwordRef/);
});

test('create_connection rejects plaintext passwords and duplicate endpoints', async () => {
  const h = harness({ connections: [connection()] });
  await assert.rejects(() => h.provisioner.create({ ...createArgs, password: 'do-not-store' }), /不接受明文密码/);
  await assert.rejects(() => h.provisioner.create({ ...createArgs, Password: 'do-not-store' }), /不接受明文密码/);
  await assert.rejects(() => h.provisioner.create(createArgs), /已存在/);
  assert.deepEqual(h.created, []);
});

test('create_connection blocks a failed credential test but saves an untested connection without a credential', async () => {
  const failed = harness({
    connections: [connection({ database: 'other', hasPassword: true })],
    secrets: { existing: { password: 'wrong-secret' } },
    test: async () => ({ ok: false, code: '28P01', message: 'password authentication failed', latencyMs: 1 }),
  });
  await assert.rejects(() => failed.provisioner.create({ ...createArgs, useSavedCredential: true }), /CONNECTION_AUTH_FAILED|password authentication failed/);
  assert.deepEqual(failed.created, []);

  const untested = harness();
  const result = await untested.provisioner.create({ ...createArgs, host: '192.168.1.8' });
  assert.equal(result.tested, false);
  assert.match(result.warning ?? '', /未保存密码/);
  assert.equal(untested.created.length, 1);
});

test('probe and create reject cloud metadata and link-local addresses', async () => {
  const h = harness();
  assert.equal(isReservedProbeAddress('169.254.169.254'), true);
  assert.equal(isReservedProbeAddress('::ffff:169.254.169.254'), true);
  assert.equal(isReservedProbeAddress('0:0:0:0:0:ffff:a9fe:a9fe'), true);
  assert.equal(isReservedProbeAddress('0:0:0:0:0:0:0:0'), true);
  assert.equal(isReservedProbeAddress('0:0:0:0:0:0:0:1'), false);
  assert.equal(isReservedProbeAddress('fe80::1'), true);
  assert.equal(isReservedProbeAddress('192.168.1.7'), false);
  await assert.rejects(() => h.provisioner.probe({ host: '169.254.169.254', port: 80, username: 'root' }), /RESERVED_ADDRESS|链路本地|保留/);
  await assert.rejects(() => h.provisioner.create({ ...createArgs, host: 'metadata.google.internal' }), /RESERVED_ADDRESS|云元数据/);
});

test('concurrent creates for the same endpoint persist only one connection', async () => {
  const h = harness();
  const results = await Promise.allSettled([
    h.provisioner.create({ ...createArgs, name: 'first' }),
    h.provisioner.create({ ...createArgs, name: 'second' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(h.created.length, 1);
});

test('create_connection rejects file-based engines and strict-TLS hostnames', async () => {
  const h = harness();
  await assert.rejects(() => h.provisioner.create({ ...createArgs, engine: 'sqlite', database: 'C:/Windows/win.ini' }), /FILE_ENGINE_NOT_SUPPORTED|不支持 SQLite/);
  await assert.rejects(() => h.provisioner.create({ ...createArgs, host: 'localhost', ssl: true }), /TLS_HOSTNAME_REQUIRES_IP|严格 TLS/);
  await assert.rejects(() => h.provisioner.probe({ host: 'localhost', port: 3306, username: 'root', ssl: true }), /TLS_HOSTNAME_REQUIRES_IP|严格 TLS/);
  assert.deepEqual(h.created, []);
});

test('hostname probes pin the validated address for the driver', async () => {
  let connectedHost: string | undefined;
  const h = harness({ test: async (config) => { connectedHost = config.host; return { ok: true, version: 'MySQL 8.0.36', latencyMs: 1 }; } });
  const result = await h.provisioner.probe({ host: 'localhost', port: 3306, username: 'root' });
  assert.equal(result.outcome, 'connected');
  assert.ok(connectedHost === '127.0.0.1' || connectedHost === '::1');
});

test('create_connection validates display fields at the tool boundary', async () => {
  const h = harness();
  await assert.rejects(() => h.provisioner.create({ ...createArgs, name: '   ' }), /name 不能为空/);
  await assert.rejects(() => h.provisioner.create({ ...createArgs, environment: 'production' }), /environment/);
  await assert.rejects(() => h.provisioner.create({ ...createArgs, color: 'black' }), /color/);
  assert.deepEqual(h.created, []);
});

test('tool arguments are redacted before UI display and audit persistence', () => {
  const args = capToolArgs({ name: 'x', password: 'plain-secret', Password: 'upper-secret', nested: { sshPrivateKey: 'private-key', ssh_password: 'snake-secret', safe: 1 } });
  const text = JSON.stringify(args);
  assert.ok(!text.includes('plain-secret'));
  assert.ok(!text.includes('upper-secret'));
  assert.ok(!text.includes('private-key'));
  assert.ok(!text.includes('snake-secret'));
  assert.match(text, /\*\*\*/);
});
