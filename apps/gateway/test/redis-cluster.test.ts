import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisDriver, type RedisOptions } from '../src/drivers/redis';

type FakeNode = { dbsize?: () => Promise<number>; call?: (command: string, ...args: string[]) => Promise<[string, string[]]> };

function fakeCluster(nodes: FakeNode[]) {
  return {
    status: 'ready',
    connect: async () => undefined,
    ping: async () => 'PONG',
    info: async () => 'redis_version:7.4.0',
    call: async () => {
      throw new Error('unknown command');
    },
    nodes: (role: string) => (role === 'master' ? nodes : []),
  };
}

const withReady = (client: unknown, options: RedisOptions) => {
  const driver = new RedisDriver(options);
  (driver as any).ready = async () => client;
  return driver;
};

test('Redis Cluster exposes one logical database and sums key counts across masters', async () => {
  const nodes: FakeNode[] = [
    { dbsize: async () => 40, call: async () => ['8', ['a:1', 'a:2']] },
    { dbsize: async () => 60, call: async () => ['0', ['b:1']] },
  ];
  const driver = withReady(fakeCluster(nodes), { host: '127.0.0.1', port: 7000, cluster: true });

  assert.deepEqual(await driver.listDatabases(), ['0']);
  const tables = await driver.describe('0');
  assert.equal(tables[0].name, 'keys');
  assert.equal(tables[0].rowEstimate, 100);
});

test('Cluster SCAN merges every master so paging cannot lose keys', async () => {
  const nodes: FakeNode[] = [
    { call: async () => ['8', ['a:1']] },
    { call: async () => ['0', ['b:1', 'b:2']] },
    { call: async () => { throw new Error('node down'); } },
  ];
  const driver = withReady(fakeCluster(nodes), { host: '127.0.0.1', port: 7000, cluster: true });

  const [cursor, keys] = await (driver as any).clusterScan(nodes, ['0', 'COUNT', '10']);
  assert.equal(cursor, '8');
  assert.deepEqual(keys, ['a:1', 'b:1', 'b:2']);

  const done = await (driver as any).clusterScan([{ call: async () => ['0', ['x']] }], ['0']);
  assert.deepEqual(done, ['0', ['x']]);

  await assert.rejects(
    () => (driver as any).clusterScan([{ call: async () => { throw new Error('all down'); } }], ['0']),
    /all down/,
  );
});

test('standalone Redis keeps its 16 databases and single-node cursor', async () => {
  const client = {
    status: 'ready',
    connect: async () => undefined,
    call: async (command: string) => {
      if (command === 'CONFIG') return ['databases', '16'];
      if (command === 'SCAN') return ['0', ['k']];
      return [];
    },
    info: async () => 'redis_version:7.4.0',
    dbsize: async () => 7,
  };
  const driver = withReady(client, { host: '127.0.0.1', port: 6379 });
  assert.equal((await driver.listDatabases()).length, 16);
  const tables = await driver.describe('3');
  assert.equal(tables[0].rowEstimate, 7);
  const result = await driver.run('SCAN 0 COUNT 10');
  assert.equal(result.rowCount, 1);
});
