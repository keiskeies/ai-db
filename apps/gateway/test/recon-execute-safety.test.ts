import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayConfig } from '../src/config';
import { executeReconRepair, snapshotRedisKeys } from '../src/commands/reconExecute';
import { MAX_REPAIR_COMMANDS, reconcileData, type ReconMapping } from '../src/features/reconcile';
import type { RedisReconcileCasInput, RedisReconcileCasResult, RedisReconcileSnapshot } from '../src/drivers/redis';
import type { ConnectionManager } from '../src/manager';
import { Store } from '../src/store';

function configFor(dir: string): GatewayConfig {
  for (const name of ['demo', 'exports', 'imports', 'backups', 'attachments']) mkdirSync(join(dir, name), { recursive: true });
  return {
    version: '0', home: dir, dbPath: join(dir, 'aidb.db'), host: '127.0.0.1', port: 0,
    token: 'test-token', secret: 'test-secret', demoDir: join(dir, 'demo'), exportDir: join(dir, 'exports'),
    importDir: join(dir, 'imports'), backupDir: join(dir, 'backups'), attachmentDir: join(dir, 'attachments'),
    staticDir: join(dir, 'static'), production: false,
  };
}

function batch(rows: unknown[][], columns: Array<{ name: string; type?: string }> = [], messages: string[] = [], truncated = false) {
  return {
    sets: [{ columns, rows, rowCount: rows.length, affected: 0, durationMs: 0, truncated }],
    messages,
    durationMs: 0,
  };
}

function quoted(key: string): string {
  return JSON.stringify(key);
}

function snapshotAfterCommands(input: RedisReconcileCasInput): RedisReconcileSnapshot {
  const snapshot: RedisReconcileSnapshot = { ...input.expected, value: structuredClone(input.expected.value), capturedAt: Date.now() };
  for (const command of input.commands) {
    const args = command.args;
    if (command.command === 'DEL') {
      snapshot.type = 'none';
      snapshot.value = null;
      snapshot.ttl = -2;
    } else if (command.command === 'SET') {
      snapshot.type = 'string';
      snapshot.value = args[1];
      snapshot.ttl = -1;
    } else if (command.command === 'PERSIST') {
      snapshot.ttl = -1;
    } else if (command.command === 'PEXPIRE') {
      snapshot.ttl = Math.max(1, Math.floor((command.expireAt ?? Date.now()) - Date.now()));
    } else if (command.command === 'HSET') {
      if (snapshot.type !== 'hash') {
        snapshot.type = 'hash';
        snapshot.value = [];
        snapshot.ttl = -1;
      }
      const rows = snapshot.value as unknown[][];
      for (let index = 1; index + 1 < args.length; index += 2) {
        const at = rows.findIndex((row) => row[0] === args[index]);
        if (at >= 0) rows[at] = [args[index], args[index + 1]];
        else rows.push([args[index], args[index + 1]]);
      }
    } else if (command.command === 'HDEL') {
      const rows = Array.isArray(snapshot.value) ? snapshot.value as unknown[][] : [];
      snapshot.value = rows.filter((row) => !args.slice(1).includes(String(row[0])));
      if (!(snapshot.value as unknown[][]).length) {
        snapshot.type = 'none';
        snapshot.value = null;
        snapshot.ttl = -2;
      }
    } else if (command.command === 'RPUSH' || command.command === 'SADD') {
      if (snapshot.type !== (command.command === 'RPUSH' ? 'list' : 'set')) {
        snapshot.type = command.command === 'RPUSH' ? 'list' : 'set';
        snapshot.value = [];
        snapshot.ttl = -1;
      }
      const rows = snapshot.value as unknown[][];
      for (const value of args.slice(1)) {
        if (command.command === 'SADD' && rows.some((row) => row[0] === value)) continue;
        rows.push([value]);
      }
    } else if (command.command === 'ZADD') {
      if (snapshot.type !== 'zset') {
        snapshot.type = 'zset';
        snapshot.value = [];
        snapshot.ttl = -1;
      }
      const rows = snapshot.value as unknown[][];
      for (let index = 1; index + 1 < args.length; index += 2) {
        const at = rows.findIndex((row) => row[0] === args[index + 1]);
        if (at >= 0) rows[at] = [args[index + 1], args[index]];
        else rows.push([args[index + 1], args[index]]);
      }
    }
  }
  return snapshot;
}

function recordingCas(handler?: (input: RedisReconcileCasInput, call: number) => RedisReconcileCasResult | Promise<RedisReconcileCasResult>) {
  const calls: RedisReconcileCasInput[] = [];
  return {
    calls,
    driver: {
      supportsReconcileCas: () => true,
      compareAndSwapKey: async (input: RedisReconcileCasInput): Promise<RedisReconcileCasResult> => {
        calls.push(input);
        return handler
          ? handler(input, calls.length)
          : { applied: true, wrote: true, snapshot: snapshotAfterCommands(input) };
      },
    },
  };
}

function managerWithResponses(responses: Map<string, unknown[][]>, driver: unknown, unexpected: (sql: string) => ReturnType<typeof batch> | void = () => assert.fail('unexpected Redis write')) {
  return {
    query: async (_connectionId: string, sql: string) => {
      const rows = responses.get(sql);
      if (rows) return batch(rows);
      return unexpected(sql) ?? batch([]);
    },
    rawDriver: async () => driver,
  } as unknown as ConnectionManager;
}

function formatCommand(command: RedisReconcileCasInput['commands'][number]): string {
  if (command.command === 'PEXPIRE') return `PEXPIRE ${quoted(command.args[0])} <remaining>`;
  return `${command.command} ${command.args.map(quoted).join(' ')}`;
}

function stringKeyResponses(keys: string[]): Map<string, unknown[][]> {
  const responses = new Map<string, unknown[][]>();
  for (const key of keys) {
    responses.set(`TYPE ${quoted(key)}`, [['string']]);
    responses.set(`PTTL ${quoted(key)}`, [[-1]]);
    responses.set(`GET ${quoted(key)}`, [[`before-${key}`]]);
  }
  return responses;
}

interface ScanPage {
  rows: unknown[][];
  cursor?: string;
  truncated?: boolean;
}

function keyspaceManager(pages: Map<string, Map<string, ScanPage>>, values: Map<string, Map<string, string>>) {
  const scans: string[] = [];
  return {
    scans,
    manager: {
      query: async (connectionId: string, sql: string) => {
        if (sql.startsWith('SCAN ')) {
          const cursor = sql.split(/\s+/)[1];
          const page = pages.get(connectionId)?.get(cursor);
          assert.ok(page, `unexpected ${connectionId} scan cursor ${cursor}`);
          scans.push(`${connectionId}:${cursor}`);
          return batch(page.rows, [{ name: 'key', type: 'string' }], page.cursor === undefined ? [] : [`cursor=${page.cursor}`], page.truncated ?? false);
        }
        if (sql.startsWith('TYPE ')) return batch([['string']], [{ name: 'type', type: 'string' }]);
        if (sql.startsWith('MGET ')) {
          const keys = [...sql.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(match[0]) as string);
          return batch(keys.map((key) => [values.get(connectionId)?.get(key) ?? 'left']), [{ name: 'value', type: 'string' }]);
        }
        assert.fail(`unexpected reconciliation command ${sql}`);
      },
    } as unknown as ConnectionManager,
  };
}

function redisReconFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-recon-coverage-'));
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  const left = store.createConnection({ name: 'left', engine: 'redis', host: '127.0.0.1', port: 6379 });
  const right = store.createConnection({ name: 'right', engine: 'redis', host: '127.0.0.1', port: 6379 });
  return {
    store, left, right,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('snapshotRedisKeys captures string, list, set, and missing keys without truncation', async () => {
  const responses = new Map<string, unknown[][]>([
    [`TYPE ${quoted('s')}`, [['string']]], [`PTTL ${quoted('s')}`, [[5000]]], [`GET ${quoted('s')}`, [['original']]],
    [`TYPE ${quoted('l')}`, [['list']]], [`PTTL ${quoted('l')}`, [[-1]]], [`LLEN ${quoted('l')}`, [[2]]], [`LRANGE ${quoted('l')} 0 -1`, [['first'], ['second']]],
    [`TYPE ${quoted('set')}`, [['set']]], [`PTTL ${quoted('set')}`, [[-1]]], [`SCARD ${quoted('set')}`, [[2]]], [`SMEMBERS ${quoted('set')}`, [['alpha'], ['beta']]],
    [`TYPE ${quoted('missing')}`, [['none']]], [`PTTL ${quoted('missing')}`, [[-2]]],
  ]);
  const calls: Array<{ sql: string; options: any }> = [];
  const manager = {
    query: async (_connectionId: string, sql: string, options: any) => {
      calls.push({ sql, options });
      const rows = responses.get(sql);
      assert.ok(rows, `unexpected Redis snapshot command: ${sql}`);
      return batch(rows);
    },
  } as unknown as ConnectionManager;

  const started = Date.now();
  const snapshot = await snapshotRedisKeys(manager, 'redis-conn', '2', ['s', 'l', 'set', 'missing', 's']);
  const finished = Date.now();
  assert.deepEqual(snapshot.map(({ capturedAt, ...entry }) => entry), [
    { key: 's', type: 'string', value: 'original', ttl: 5000 },
    { key: 'l', type: 'list', value: [['first'], ['second']], ttl: -1 },
    { key: 'set', type: 'set', value: [['alpha'], ['beta']], ttl: -1 },
    { key: 'missing', type: 'none', value: null, ttl: -2 },
  ]);
  assert.equal(snapshot.length, 4, 'duplicate keys must be snapshotted once');
  assert.ok(snapshot.every((entry) => entry.capturedAt >= started && entry.capturedAt <= finished));
  assert.ok(calls.every((call) => call.options.database === '2' && call.options.allowMulti === false && call.options.autoLimit === false && call.options.actor === 'user'));
  const maxRows = new Map(calls.map((call) => [call.sql, call.options.maxRows]));
  assert.ok(maxRows.get(`LRANGE ${quoted('l')} 0 -1`) >= 100_000);
  assert.ok(maxRows.get(`SMEMBERS ${quoted('set')}`) >= 100_000);
});

test('snapshotRedisKeys captures every hash field/value row without truncation', async () => {
  const responses = new Map<string, unknown[][]>([
    [`TYPE ${quoted('h')}`, [['hash']]],
    [`PTTL ${quoted('h')}`, [[-1]]],
    [`HLEN ${quoted('h')}`, [[2]]],
    [`HGETALL ${quoted('h')}`, [['a', '1'], ['b', '2']]],
  ]);
  let snapshotMaxRows = 0;
  const manager = {
    query: async (_connectionId: string, sql: string, options: any) => {
      const rows = responses.get(sql);
      assert.ok(rows, `unexpected Redis hash command: ${sql}`);
      if (sql.startsWith('HGETALL ')) snapshotMaxRows = options.maxRows;
      return batch(rows);
    },
  } as unknown as ConnectionManager;
  const snapshot = await snapshotRedisKeys(manager, 'redis-conn', '0', ['h']);
  assert.equal(snapshot[0].type, 'hash');
  assert.deepEqual(snapshot[0].value, [['a', '1'], ['b', '2']]);
  assert.ok(snapshotMaxRows >= 100_000, 'hash snapshots must have room for every allowed field');
});

test('snapshotRedisKeys captures every zset member/score row without truncation', async () => {
  const responses = new Map<string, unknown[][]>([
    [`TYPE ${quoted('z')}`, [['zset']]],
    [`PTTL ${quoted('z')}`, [[-1]]],
    [`ZCARD ${quoted('z')}`, [[2]]],
    [`ZRANGE ${quoted('z')} 0 -1 WITHSCORES`, [['alpha', '1.5'], ['beta', '2']]],
  ]);
  let snapshotMaxRows = 0;
  const manager = {
    query: async (_connectionId: string, sql: string, options: any) => {
      const rows = responses.get(sql);
      assert.ok(rows, `unexpected Redis zset command: ${sql}`);
      if (sql.startsWith('ZRANGE ')) snapshotMaxRows = options.maxRows;
      return batch(rows);
    },
  } as unknown as ConnectionManager;
  const snapshot = await snapshotRedisKeys(manager, 'redis-conn', '0', ['z']);
  assert.equal(snapshot[0].type, 'zset');
  assert.deepEqual(snapshot[0].value, [['alpha', '1.5'], ['beta', '2']]);
  assert.ok(snapshotMaxRows >= 100_000, 'zset snapshots must have room for every allowed member');
});

test('snapshotRedisKeys rejects an unsupported Redis type instead of saving a partial snapshot', async () => {
  const commands: string[] = [];
  const manager = {
    query: async (_connectionId: string, sql: string) => {
      commands.push(sql);
      if (sql === `TYPE ${quoted('stream')}`) return batch([['stream']]);
      if (sql === `PTTL ${quoted('stream')}`) return batch([[-1]]);
      assert.fail(`unsupported types must not be read with ${sql}`);
    },
  } as unknown as ConnectionManager;
  await assert.rejects(() => snapshotRedisKeys(manager, 'redis-conn', '0', ['stream']), { code: 'RECON_UNSUPPORTED_TYPE' });
  assert.deepEqual(commands, [`TYPE ${quoted('stream')}`, `PTTL ${quoted('stream')}`]);
});

test('snapshotRedisKeys rejects binary values before a backup can be lossy', async () => {
  const manager = {
    query: async (_connectionId: string, sql: string) => {
      if (sql.startsWith('TYPE ')) return batch([['string']]);
      if (sql.startsWith('PTTL ')) return batch([[-1]]);
      if (sql.startsWith('GET ')) return batch([['<binary 3 bytes>']], [{ name: 'value', type: 'binary' }]);
      assert.fail(`unexpected command ${sql}`);
    },
  } as unknown as ConnectionManager;
  await assert.rejects(() => snapshotRedisKeys(manager, 'redis-conn', '0', ['binary']), { code: 'RECON_UNSUPPORTED_BINARY' });
});

function reconEnvironment(
  plan: string[],
  repairComplete = true,
  summary: { comparisonComplete?: boolean; truncated?: boolean; skippedKeys?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-recon-execute-'));
  const config = configFor(dir);
  const store = new Store(config.dbPath, config.secret);
  const conn = store.createConnection({ name: 'Redis', engine: 'redis', host: '127.0.0.1', port: 6379, database: '2' });
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: 'left', database: '1', keyPattern: 'repair' },
    right: { kind: 'keyspace', connectionId: conn.id, database: '2', keyPattern: 'repair' },
  };
  const artifact = store.createArtifact({
    type: 'recon', title: 'Redis repair', spec: { version: 1, type: 'recon', title: 'Redis repair', input: { mapping } },
  });
  store.addArtifactRun({
    artifactId: artifact.id,
    status: 'succeeded',
    result: {
      repair: plan,
      repairComplete,
      level: 'keys',
      summary: { comparisonComplete: true, truncated: false, skippedKeys: 0, ...summary },
    },
  });
  return {
    dir, config, store, conn, artifactId: artifact.id,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('recon repair rejects changes between backup and pre-write snapshots without executing commands', async () => {
  const env = reconEnvironment([`SET ${quoted('repair')} "after"`]);
  let reads = 0;
  const writes: string[] = [];
  const cas = recordingCas();
  const manager = managerWithResponses(new Map(), cas.driver, (sql) => {
    if (!/^(TYPE|PTTL|GET) /.test(sql)) writes.push(sql);
    if (sql === `TYPE ${quoted('repair')}`) return batch([['string']]);
    if (sql === `PTTL ${quoted('repair')}`) return batch([[-1]]);
    if (sql === `GET ${quoted('repair')}`) return batch([[++reads === 1 ? 'before' : 'after']]);
    return batch([]);
  });

  try {
    await assert.rejects(() => executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' }), { code: 'SNAPSHOT_CHANGED' });
    assert.equal(reads, 2, 'both the backup and pre-write snapshots must be taken');
    assert.equal(cas.calls.length, 0, 'a stale plan must not start a Redis transaction');
    assert.deepEqual(writes, [], 'a stale plan must not issue any repair command');
    assert.deepEqual(readdirSync(env.config.backupDir), [], 'a rejected stale snapshot must not leave a backup artifact');
  } finally {
    env.cleanup();
  }
});

test('recon repair rejects a TTL change between snapshots even when the value is unchanged', async () => {
  const env = reconEnvironment([`SET ${quoted('repair')} "after"`]);
  let ttlReads = 0;
  const cas = recordingCas();
  const manager = managerWithResponses(new Map(), cas.driver, (sql) => {
    if (sql.startsWith('TYPE ')) return batch([['string']]);
    if (sql.startsWith('PTTL ')) return batch([[++ttlReads === 1 ? 5000 : -1]]);
    if (sql.startsWith('GET ')) return batch([['before']]);
    return batch([]);
  });
  try {
    await assert.rejects(() => executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' }), { code: 'SNAPSHOT_CHANGED' });
    assert.equal(ttlReads, 2);
    assert.equal(cas.calls.length, 0);
    assert.deepEqual(readdirSync(env.config.backupDir), []);
  } finally {
    env.cleanup();
  }
});

test('plain SET repair preserves expiring, persistent, and missing-key TTL semantics in CAS', async () => {
  const plan = [`SET ${quoted('expiring')} "new"`, `SET ${quoted('persistent')} "new"`, `SET ${quoted('missing')} "new"`];
  const env = reconEnvironment(plan);
  const responses = new Map<string, unknown[][]>([
    [`TYPE ${quoted('expiring')}`, [['string']]], [`PTTL ${quoted('expiring')}`, [[60_000]]], [`GET ${quoted('expiring')}`, [['old']]],
    [`TYPE ${quoted('persistent')}`, [['string']]], [`PTTL ${quoted('persistent')}`, [[-1]]], [`GET ${quoted('persistent')}`, [['old']]],
    [`TYPE ${quoted('missing')}`, [['none']]], [`PTTL ${quoted('missing')}`, [[-2]]],
  ]);
  const cas = recordingCas();
  const manager = managerWithResponses(responses, cas.driver);
  try {
    const repaired = await executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' });
    assert.equal(repaired.executed, 3);
    assert.equal(repaired.failed, 0);
    assert.deepEqual(cas.calls.map((call) => call.commands.map((command) => command.command)), [
      ['SET', 'PEXPIRE'], ['SET', 'PERSIST'], ['SET'],
    ]);
    const expiration = cas.calls[0].commands[1];
    assert.ok((expiration.expireAt ?? 0) > Date.now());
    assert.ok((expiration.expireAt ?? 0) <= cas.calls[0].expected.capturedAt + 60_000);
  } finally {
    env.cleanup();
  }
});

test('failed recon repair restores touched string, list, set, and missing keys', async () => {
  const plan = [
    `SET ${quoted('s')} "changed"`,
    `DEL ${quoted('l')}`,
    `DEL ${quoted('set')}`,
    `SET ${quoted('gone')} "created"`,
    `SET ${quoted('fail')} "fail"`,
  ];
  const env = reconEnvironment(plan);
  const responses = new Map<string, unknown[][]>([
    [`TYPE ${quoted('s')}`, [['string']]], [`PTTL ${quoted('s')}`, [[60_000]]], [`GET ${quoted('s')}`, [['original']]],
    [`TYPE ${quoted('l')}`, [['list']]], [`PTTL ${quoted('l')}`, [[-1]]], [`LLEN ${quoted('l')}`, [[2]]], [`LRANGE ${quoted('l')} 0 -1`, [['first'], ['second']]],
    [`TYPE ${quoted('set')}`, [['set']]], [`PTTL ${quoted('set')}`, [[-1]]], [`SCARD ${quoted('set')}`, [[2]]], [`SMEMBERS ${quoted('set')}`, [['alpha'], ['beta']]],
    [`TYPE ${quoted('gone')}`, [['none']]], [`PTTL ${quoted('gone')}`, [[-2]]],
    [`TYPE ${quoted('fail')}`, [['none']]], [`PTTL ${quoted('fail')}`, [[-2]]],
  ]);
  const cas = recordingCas((input, call) => call === 5
    ? { applied: false, wrote: false, snapshot: input.expected, error: 'simulated repair failure' }
    : { applied: true, wrote: true, snapshot: snapshotAfterCommands(input) });
  const manager = managerWithResponses(responses, cas.driver);

  try {
    const repaired = await executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' });
    assert.equal(repaired.executed, 4);
    assert.equal(repaired.failed, 1);
    assert.equal(repaired.rolledBack, true);
    assert.equal(repaired.verification, undefined, 'failed repairs must not be verified as successful');
    assert.equal(repaired.results.length, 5);
    assert.equal(repaired.results[4].ok, false);
    assert.equal(repaired.results[4].error, 'simulated repair failure');
    assert.ok(repaired.backupPath);

    const backup = JSON.parse(readFileSync(repaired.backupPath, 'utf8'));
    assert.deepEqual(backup.keys.map(({ capturedAt, ...entry }: any) => entry), [
      { key: 's', type: 'string', value: 'original', ttl: 60_000 },
      { key: 'l', type: 'list', value: [['first'], ['second']], ttl: -1 },
      { key: 'set', type: 'set', value: [['alpha'], ['beta']], ttl: -1 },
      { key: 'gone', type: 'none', value: null, ttl: -2 },
      { key: 'fail', type: 'none', value: null, ttl: -2 },
    ]);

    const rollback = cas.calls.slice(5);
    assert.deepEqual(rollback.map((call) => call.commands.map(formatCommand)), [
      ['SET "s" "original"', 'PEXPIRE "s" <remaining>'],
      ['DEL "l"', 'RPUSH "l" "first" "second"', 'PERSIST "l"'],
      ['DEL "set"', 'SADD "set" "alpha" "beta"', 'PERSIST "set"'],
      ['DEL "gone"'],
    ]);
    const expiration = rollback[0].commands.find((command) => command.command === 'PEXPIRE')!;
    assert.ok((expiration.expireAt ?? 0) > Date.now());
    assert.ok((expiration.expireAt ?? 0) <= backup.keys[0].capturedAt + 60_000, 'rollback must restore the remaining TTL, not the original full TTL twice');
  } finally {
    env.cleanup();
  }
});

test('a concurrent repair conflict rolls back only keys whose post-repair state is still current', async () => {
  const plan = [`SET ${quoted('a')} "after-a"`, `SET ${quoted('b')} "after-b"`];
  const env = reconEnvironment(plan);
  const responses = new Map<string, unknown[][]>([
    [`TYPE ${quoted('a')}`, [['string']]], [`PTTL ${quoted('a')}`, [[-1]]], [`GET ${quoted('a')}`, [['before-a']]],
    [`TYPE ${quoted('b')}`, [['string']]], [`PTTL ${quoted('b')}`, [[-1]]], [`GET ${quoted('b')}`, [['before-b']]],
  ]);
  const cas = recordingCas((input, call) => call === 2
    ? { applied: false, wrote: false, snapshot: { ...input.expected, value: 'concurrent-b' }, error: 'concurrent writer' }
    : { applied: true, wrote: true, snapshot: snapshotAfterCommands(input) });
  const manager = managerWithResponses(responses, cas.driver);
  try {
    const repaired = await executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' });
    assert.equal(repaired.executed, 1);
    assert.equal(repaired.failed, 1);
    assert.equal(repaired.rolledBack, true);
    assert.equal(cas.calls.length, 3, 'the conflicted key must not be overwritten by rollback');
    assert.equal(cas.calls[2].key, 'a');
    assert.equal(cas.calls[2].expected.value, 'after-a');
    assert.deepEqual(cas.calls[2].commands.map((command) => command.command), ['SET', 'PERSIST']);
    assert.equal(cas.calls[2].commands[0].args[1], 'before-a');
  } finally {
    env.cleanup();
  }
});

test('a partially applied key transaction is compensated using its observed post-state', async () => {
  const plan = [`SET ${quoted('a')} "after-a"`, `SET ${quoted('b')} "after-b"`];
  const env = reconEnvironment(plan);
  const responses = stringKeyResponses(['a', 'b']);
  const cas = recordingCas((input, call) => call === 2
    ? { applied: false, wrote: true, snapshot: snapshotAfterCommands(input), error: 'partial transaction' }
    : { applied: true, wrote: true, snapshot: snapshotAfterCommands(input) });
  const manager = managerWithResponses(responses, cas.driver);
  try {
    const repaired = await executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' });
    assert.equal(repaired.executed, 1);
    assert.equal(repaired.failed, 1);
    assert.equal(repaired.rolledBack, true);
    assert.deepEqual(cas.calls.map((call) => call.key), ['a', 'b', 'a', 'b']);
    assert.equal(cas.calls[3].expected.value, 'after-b');
    assert.equal(cas.calls[3].commands[0].args[1], 'before-b');
  } finally {
    env.cleanup();
  }
});

test('rollback stops short of a key changed by another writer after repair', async () => {
  const plan = [`SET ${quoted('a')} "after-a"`, `SET ${quoted('b')} "after-b"`, `SET ${quoted('c')} "after-c"`];
  const env = reconEnvironment(plan);
  const responses = stringKeyResponses(['a', 'b', 'c']);
  const cas = recordingCas((input, call) => {
    if (call === 3) return { applied: false, wrote: false, snapshot: input.expected, error: 'repair conflict' };
    if (call === 5) return { applied: false, wrote: false, snapshot: { ...input.expected, value: 'concurrent-b' }, error: 'rollback conflict' };
    return { applied: true, wrote: true, snapshot: snapshotAfterCommands(input) };
  });
  const manager = managerWithResponses(responses, cas.driver);
  try {
    const repaired = await executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' });
    assert.equal(repaired.rolledBack, false);
    assert.equal(cas.calls.length, 5, 'a conflicted rollback must not retry or overwrite the key');
    assert.equal(cas.calls[4].key, 'b');
    assert.ok(env.store.listAudit({ connectionId: env.conn.id }).some((entry) => entry.tool === 'command.recon.repair.rollback' && entry.status === 'error'));
  } finally {
    env.cleanup();
  }
});

test('incomplete or unmarked repair plans are refused before any snapshot or write', async () => {
  const env = reconEnvironment([`SET ${quoted('a')} "after"`], false);
  let queries = 0;
  let driverReads = 0;
  const manager = {
    query: async () => { queries++; return batch([]); },
    rawDriver: async () => { driverReads++; return {}; },
  } as unknown as ConnectionManager;
  try {
    await assert.rejects(() => executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' }), { code: 'REPAIR_PLAN_INCOMPLETE' });
    assert.equal(queries, 0);
    assert.equal(driverReads, 0);
    assert.deepEqual(readdirSync(env.config.backupDir), []);
  } finally {
    env.cleanup();
  }
});

test('recon repair refuses skipped, capped, and unproven comparisons before any snapshot or write', async () => {
  const cases = [
    { name: 'skipped keys', summary: { skippedKeys: 1 } },
    { name: 'capped scan', summary: { truncated: true } },
    { name: 'incomplete comparison', summary: { comparisonComplete: false } },
    { name: 'missing coverage marker', summary: { comparisonComplete: undefined } },
  ];
  for (const item of cases) {
    const env = reconEnvironment([`SET ${quoted('a')} "after"`], true, item.summary);
    let queries = 0;
    let driverReads = 0;
    const manager = {
      query: async () => { queries++; return batch([]); },
      rawDriver: async () => { driverReads++; return {}; },
    } as unknown as ConnectionManager;
    try {
      await assert.rejects(
        () => executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' }),
        { code: 'REPAIR_PLAN_INCOMPLETE' },
        item.name,
      );
      assert.equal(queries, 0, `${item.name}: no snapshot reads`);
      assert.equal(driverReads, 0, `${item.name}: no CAS driver access`);
      assert.deepEqual(readdirSync(env.config.backupDir), [], `${item.name}: no backup artifact`);
    } finally {
      env.cleanup();
    }
  }
});

test('drivers without WATCH/MULTI/EXEC support fail closed before snapshotting', async () => {
  const env = reconEnvironment([`SET ${quoted('a')} "after"`]);
  let queries = 0;
  const manager = {
    query: async () => { queries++; return batch([]); },
    rawDriver: async () => ({ supportsReconcileCas: () => false }),
  } as unknown as ConnectionManager;
  try {
    await assert.rejects(() => executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' }), { code: 'RECON_CAS_UNSUPPORTED' });
    assert.equal(queries, 0);
    assert.deepEqual(readdirSync(env.config.backupDir), []);
  } finally {
    env.cleanup();
  }
});

test('binary placeholder repair values are rejected before any Redis read or write', async () => {
  const env = reconEnvironment([`SET ${quoted('a')} "<binary 5 bytes>"`]);
  let queries = 0;
  const manager = {
    query: async () => { queries++; return batch([]); },
    rawDriver: async () => assert.fail('binary plans must not open a CAS driver'),
  } as unknown as ConnectionManager;
  try {
    await assert.rejects(() => executeReconRepair(env.store, manager, env.config, env.artifactId, { confirm: 'EXECUTE' }), { code: 'RECON_UNSUPPORTED_BINARY' });
    assert.equal(queries, 0);
  } finally {
    env.cleanup();
  }
});

test('Redis reconciliation keeps skipped-key results read-only and disables an otherwise complete repair', async () => {
  const env = redisReconFixture();
  const { manager } = keyspaceManager(
    new Map<string, Map<string, ScanPage>>([
      [env.left.id, new Map([['0', { rows: [['item:1'], ['item:2'], ['ignored']], cursor: '0' }]])],
      [env.right.id, new Map([['0', { rows: [['item:1']], cursor: '0' }]])],
    ]),
    new Map([
      [env.left.id, new Map([['item:1', 'same'], ['item:2', 'left']])],
      [env.right.id, new Map([['item:1', 'same']])],
    ]),
  );
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: env.left.id, keyPattern: 'item:*', keyExtract: '^item:(\\d+)$', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: env.right.id, keyPattern: 'item:*', keyExtract: '^item:(\\d+)$', valueType: 'string' },
    baseSide: 'left',
    maxKeys: 100,
  };
  try {
    const result = await reconcileData(env.store, manager, mapping, 'fields');
    assert.equal(result.summary.skippedKeys, 1);
    assert.equal(result.summary.truncated, false);
    assert.equal(result.summary.comparisonComplete, false);
    assert.deepEqual(result.repair, [`SET "item:2" "left"`]);
    assert.equal(result.repairComplete, false);
    assert.match(result.repairNote ?? '', /只读核对/);
    assert.ok(result.notes.some((note) => note.includes('已跳过')));
  } finally {
    env.cleanup();
  }
});

test('a terminal Redis scan at the key cap cannot produce an executable repair', async () => {
  const env = redisReconFixture();
  const { manager } = keyspaceManager(
    new Map<string, Map<string, ScanPage>>([
      [env.left.id, new Map([['0', { rows: [['item:1'], ['item:2']], cursor: '0' }]])],
      [env.right.id, new Map([['0', { rows: [], cursor: '0' }]])],
    ]),
    new Map([[env.left.id, new Map([['item:1', 'left-1'], ['item:2', 'left-2']])]]),
  );
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: env.left.id, keyPattern: 'item:*', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: env.right.id, keyPattern: 'item:*', valueType: 'string' },
    baseSide: 'left',
    maxKeys: 2,
  };
  try {
    const result = await reconcileData(env.store, manager, mapping, 'fields');
    assert.equal(result.summary.truncated, true);
    assert.equal(result.summary.comparisonComplete, false);
    assert.equal(result.repair.length, 2);
    assert.equal(result.repairComplete, false);
    assert.match(result.repairNote ?? '', /只读核对/);
    assert.ok(result.notes.some((note) => note.includes('结果可能不完整')));
  } finally {
    env.cleanup();
  }
});

test('a truncated terminal Redis page remains available as an incomplete read-only result', async () => {
  const env = redisReconFixture();
  const { manager } = keyspaceManager(
    new Map<string, Map<string, ScanPage>>([
      [env.left.id, new Map([['0', { rows: [['item:1']], cursor: '0', truncated: true }]])],
      [env.right.id, new Map([['0', { rows: [], cursor: '0' }]])],
    ]),
    new Map([[env.left.id, new Map([['item:1', 'left']])]]),
  );
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: env.left.id, keyPattern: 'item:*', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: env.right.id, keyPattern: 'item:*', valueType: 'string' },
    baseSide: 'left',
  };
  try {
    const result = await reconcileData(env.store, manager, mapping, 'fields');
    assert.equal(result.summary.truncated, true);
    assert.equal(result.summary.comparisonComplete, false);
    assert.equal(result.repairComplete, false);
    assert.ok(result.notes.some((note) => note.includes('只读核对')));
  } finally {
    env.cleanup();
  }
});

test('a Redis scan without a terminal cursor cannot claim complete comparison', async () => {
  const env = redisReconFixture();
  const { manager } = keyspaceManager(
    new Map<string, Map<string, ScanPage>>([
      [env.left.id, new Map([['0', { rows: [['item:1']] }]])],
      [env.right.id, new Map([['0', { rows: [], cursor: '0' }]])],
    ]),
    new Map([[env.left.id, new Map([['item:1', 'left']])]]),
  );
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: env.left.id, keyPattern: 'item:*', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: env.right.id, keyPattern: 'item:*', valueType: 'string' },
    baseSide: 'left',
  };
  try {
    const result = await reconcileData(env.store, manager, mapping, 'fields');
    assert.equal(result.summary.truncated, true);
    assert.equal(result.summary.comparisonComplete, false);
    assert.equal(result.repairComplete, false);
  } finally {
    env.cleanup();
  }
});

test('complete non-terminal Redis pages can still produce a complete repair', async () => {
  const env = redisReconFixture();
  const { manager, scans } = keyspaceManager(
    new Map<string, Map<string, ScanPage>>([
      [env.left.id, new Map([
        ['0', { rows: [['item:1']], cursor: '42', truncated: true }],
        ['42', { rows: [['item:2']], cursor: '0' }],
      ])],
      [env.right.id, new Map([['0', { rows: [], cursor: '0' }]])],
    ]),
    new Map([[env.left.id, new Map([['item:1', 'left-1'], ['item:2', 'left-2']])]]),
  );
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: env.left.id, keyPattern: 'item:*', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: env.right.id, keyPattern: 'item:*', valueType: 'string' },
    baseSide: 'left',
    maxKeys: 10,
  };
  try {
    const result = await reconcileData(env.store, manager, mapping, 'fields');
    assert.deepEqual(scans, [`${env.left.id}:0`, `${env.left.id}:42`, `${env.right.id}:0`]);
    assert.equal(result.summary.truncated, false);
    assert.equal(result.summary.comparisonComplete, true);
    assert.equal(result.repair.length, 2);
    assert.equal(result.repairComplete, true);
  } finally {
    env.cleanup();
  }
});

test('large missing-row plans carry an explicit cap marker and are not silently complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-recon-plan-cap-'));
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  const left = store.createConnection({ name: 'left', engine: 'redis', host: '127.0.0.1', port: 6379 });
  const right = store.createConnection({ name: 'right', engine: 'redis', host: '127.0.0.1', port: 6379 });
  const keys = Array.from({ length: MAX_REPAIR_COMMANDS + 1 }, (_, index) => `item:${index}`);
  const manager = {
    query: async (connectionId: string, sql: string) => {
      if (sql.startsWith('SCAN ')) {
        if (connectionId === right.id) return batch([], [{ name: 'key', type: 'string' }], ['cursor=0']);
        const start = Number(sql.split(/\s+/)[1]);
        const end = Math.min(start + 1000, keys.length);
        return batch(keys.slice(start, end).map((key) => [key]), [{ name: 'key', type: 'string' }], [`cursor=${end < keys.length ? end : 0}`]);
      }
      if (sql.startsWith('TYPE ')) return batch([['string']], [{ name: 'value', type: 'string' }]);
      if (sql.startsWith('MGET ')) {
        const rawKeys = [...sql.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
        return batch(rawKeys.map(() => ['left']), [{ name: 'value', type: 'string' }]);
      }
      assert.fail(`unexpected reconciliation command ${sql}`);
    },
  } as unknown as ConnectionManager;
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: left.id, keyPattern: 'item:*', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: right.id, keyPattern: 'item:*', valueType: 'string' },
    baseSide: 'left',
    maxKeys: keys.length + 100,
  };
  try {
    const result = await reconcileData(store, manager, mapping, 'fields');
    assert.equal(result.summary.missingInRight, keys.length);
    assert.equal(result.summary.truncated, false);
    assert.equal(result.repair.length, MAX_REPAIR_COMMANDS);
    assert.equal(result.repairComplete, false);
    assert.match(result.repairNote ?? '', new RegExp(String(MAX_REPAIR_COMMANDS)));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Redis reconciliation rejects binary source values instead of planning placeholder writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-recon-binary-'));
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  const left = store.createConnection({ name: 'left', engine: 'redis', host: '127.0.0.1', port: 6379 });
  const right = store.createConnection({ name: 'right', engine: 'redis', host: '127.0.0.1', port: 6379 });
  const manager = {
    query: async (connectionId: string, sql: string) => {
      if (sql.startsWith('SCAN ')) return batch([['item:1']], [{ name: 'key', type: 'string' }], ['cursor=0']);
      if (sql.startsWith('TYPE ')) return batch([['string']], [{ name: 'value', type: 'string' }]);
      if (sql.startsWith('MGET ')) {
        return connectionId === left.id
          ? batch([['<binary 3 bytes>']], [{ name: 'value', type: 'binary' }])
          : batch([['right']], [{ name: 'value', type: 'string' }]);
      }
      assert.fail(`unexpected reconciliation command ${sql}`);
    },
  } as unknown as ConnectionManager;
  const mapping: ReconMapping = {
    mode: 'keyspace-keyspace',
    left: { kind: 'keyspace', connectionId: left.id, keyPattern: 'item:*', valueType: 'string' },
    right: { kind: 'keyspace', connectionId: right.id, keyPattern: 'item:*', valueType: 'string' },
    baseSide: 'left',
  };
  try {
    await assert.rejects(() => reconcileData(store, manager, mapping, 'fields'), { code: 'RECON_UNSUPPORTED_BINARY' });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
