import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RedisDriver,
  redisSnapshotsMatch,
  type RedisReconcileCasInput,
  type RedisReconcileSnapshot,
} from '../src/drivers/redis';

function fakeStringRedis(initial: { value: string; ttl: number }, options: { afterWatch?: () => void; failCommand?: string } = {}) {
  const state = { type: 'string', value: initial.value, ttl: initial.ttl };
  let watched = false;
  let invalidated = false;
  const client: any = {
    status: 'ready',
    on: () => client,
    duplicate: () => client,
    disconnect: () => { state.type = 'none'; },
    watch: async () => {
      watched = true;
      invalidated = false;
      options.afterWatch?.();
      if (options.afterWatch) invalidated = true;
    },
    unwatch: async () => { watched = false; },
    type: async () => state.type,
    pttl: async () => state.ttl,
    get: async () => state.type === 'none' ? null : state.value,
    multi: () => {
      const queued: Array<{ command: string; args: string[] }> = [];
      const transaction: any = {
        call(command: string, ...args: string[]) {
          queued.push({ command, args });
          return transaction;
        },
        exec: async () => {
          if (!watched || invalidated) return null;
          const replies: Array<[Error | null, unknown]> = [];
          for (const { command, args } of queued) {
            if (command === 'SET') {
              state.type = 'string';
              state.value = args[1];
              state.ttl = -1;
            } else if (command === 'PEXPIRE') {
              state.ttl = Number(args[1]);
            } else if (command === 'PERSIST') {
              state.ttl = -1;
            } else if (command === 'DEL') {
              state.type = 'none';
              state.value = '';
              state.ttl = -2;
            }
            replies.push(options.failCommand === command ? [new Error(`simulated ${command} failure`), null] : [null, 'OK']);
          }
          return replies;
        },
      };
      return transaction;
    },
  };
  return { client, state };
}

function driverWithClient(client: any): RedisDriver {
  const driver = new RedisDriver({ host: '127.0.0.1', port: 6379 });
  (driver as any).clients.set(0, client);
  return driver;
}

function expectedString(key: string, value: string, ttl: number, capturedAt = Date.now() - 100): RedisReconcileSnapshot {
  return { key, type: ttl === -2 ? 'none' : 'string', value: ttl === -2 ? null : value, ttl, capturedAt };
}

test('Redis WATCH/MULTI CAS applies SET and restores the remaining TTL atomically', async () => {
  const capturedAt = Date.now() - 100;
  const fake = fakeStringRedis({ value: 'before', ttl: 59_900 });
  const driver = driverWithClient(fake.client);
  const expected = expectedString('key', 'before', 60_000, capturedAt);
  try {
    const result = await driver.compareAndSwapKey({
      key: 'key',
      expected,
      commands: [
        { command: 'SET', args: ['key', 'after'] },
        { command: 'PEXPIRE', args: ['key', '0'], expireAt: capturedAt + 60_000 },
      ],
    });
    assert.equal(result.applied, true);
    assert.equal(result.wrote, true);
    assert.equal(fake.state.value, 'after');
    assert.ok(fake.state.ttl > 58_000 && fake.state.ttl <= 60_000, `unexpected restored TTL ${fake.state.ttl}`);
  } finally {
    await driver.close();
  }
});

test('Redis WATCH/MULTI CAS keeps a persistent SET persistent', async () => {
  const fake = fakeStringRedis({ value: 'before', ttl: -1 });
  const driver = driverWithClient(fake.client);
  try {
    const result = await driver.compareAndSwapKey({
      key: 'key',
      expected: expectedString('key', 'before', -1),
      commands: [{ command: 'SET', args: ['key', 'after'] }, { command: 'PERSIST', args: ['key'] }],
    });
    assert.equal(result.applied, true);
    assert.equal(fake.state.value, 'after');
    assert.equal(fake.state.ttl, -1);
  } finally {
    await driver.close();
  }
});

test('Redis WATCH/MULTI CAS does not overwrite a concurrent writer', async () => {
  const fake = fakeStringRedis({ value: 'before', ttl: -1 }, {
    afterWatch: () => {
      fake.state.value = 'concurrent';
    },
  });
  const driver = driverWithClient(fake.client);
  try {
    const result = await driver.compareAndSwapKey({
      key: 'key',
      expected: expectedString('key', 'before', -1),
      commands: [{ command: 'SET', args: ['key', 'after'] }],
    });
    assert.equal(result.applied, false);
    assert.equal(result.wrote, false);
    assert.equal(fake.state.value, 'concurrent');
  } finally {
    await driver.close();
  }
});

test('Redis WATCH/MULTI CAS rejects a changed TTL before queuing writes', async () => {
  const fake = fakeStringRedis({ value: 'before', ttl: 30_000 });
  const driver = driverWithClient(fake.client);
  try {
    const result = await driver.compareAndSwapKey({
      key: 'key',
      expected: expectedString('key', 'before', 60_000),
      commands: [{ command: 'SET', args: ['key', 'after'] }],
    });
    assert.equal(result.applied, false);
    assert.equal(result.wrote, false);
    assert.equal(fake.state.value, 'before');
    assert.equal(fake.state.ttl, 30_000);
  } finally {
    await driver.close();
  }
});

test('Redis transaction runtime errors report a possibly partial write for safe compensating CAS', async () => {
  const fake = fakeStringRedis({ value: 'before', ttl: -1 }, { failCommand: 'PEXPIRE' });
  const driver = driverWithClient(fake.client);
  try {
    const result = await driver.compareAndSwapKey({
      key: 'key',
      expected: expectedString('key', 'before', -1),
      commands: [{ command: 'SET', args: ['key', 'after'] }, { command: 'PEXPIRE', args: ['key', '1000'] }],
    });
    assert.equal(result.applied, false);
    assert.equal(result.wrote, true);
    assert.equal(fake.state.value, 'after');
    assert.match(result.error ?? '', /PEXPIRE/);
    assert.equal(result.snapshot?.value, 'after');
  } finally {
    await driver.close();
  }
});

test('snapshot matching tolerates elapsed TTL but never confuses persistent and expiring keys', () => {
  const expected = expectedString('key', 'value', 5000, 1000);
  assert.equal(redisSnapshotsMatch(expected, { ...expected, ttl: 4000 }, 2000), true);
  assert.equal(redisSnapshotsMatch(expected, { ...expected, ttl: 2900 }, 2000), false);
  assert.equal(redisSnapshotsMatch({ ...expected, ttl: -1 }, { ...expected, ttl: 4000 }, 2000), false);
  assert.equal(redisSnapshotsMatch({ ...expected, ttl: -2, type: 'none', value: null }, { ...expected, ttl: -1 }, 2000), false);
});

test('Redis query results mark binary scalar and hash cells instead of hiding their type', async () => {
  const client: any = {
    status: 'ready',
    disconnect: () => undefined,
    call: async (command: string) => command === 'GET' ? Buffer.from([0, 255, 1]) : [Buffer.from('field'), Buffer.from([0, 255])],
  };
  const driver = driverWithClient(client);
  try {
    const scalar = await driver.executeQuery({ language: 'redis', command: 'GET', args: ['binary'] });
    assert.equal(scalar.columns[0].type, 'binary');
    assert.equal(scalar.rows[0][0], '<binary 3 bytes>');
    const hash = await driver.executeQuery({ language: 'redis', command: 'HGETALL', args: ['binary'] });
    assert.deepEqual(hash.columns.map((column) => column.type), ['binary', 'binary']);
  } finally {
    await driver.close();
  }
});

test('Redis Cluster reconciliation fails closed because cross-key CAS is unavailable', async () => {
  const driver = new RedisDriver({ host: '127.0.0.1', port: 6379, cluster: true });
  try {
    assert.equal(driver.supportsReconcileCas(), false);
    await assert.rejects(() => driver.compareAndSwapKey({
      key: 'key',
      expected: expectedString('key', 'before', -1),
      commands: [{ command: 'SET', args: ['key', 'after'] }],
    }), { code: 'RECON_CAS_UNSUPPORTED' });
  } finally {
    await driver.close();
  }
});

test('CAS rejects binary expected snapshots before opening a transaction', async () => {
  const driver = new RedisDriver({ host: '127.0.0.1', port: 6379 });
  const input: RedisReconcileCasInput = {
    key: 'key',
    expected: { ...expectedString('key', 'before', -1), value: Buffer.from([0, 255]) },
    commands: [{ command: 'SET', args: ['key', 'after'] }],
  };
  try {
    await assert.rejects(() => driver.compareAndSwapKey(input), { code: 'RECON_UNSUPPORTED_BINARY' });
  } finally {
    await driver.close();
  }
});
