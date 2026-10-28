import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { createGateway } from '../src/server';

const PORT = process.env.AIDB_TEST_REDIS_STACK_PORT ? Number(process.env.AIDB_TEST_REDIS_STACK_PORT) : undefined;

async function gateway() {
  const home = mkdtempSync(join(tmpdir(), 'aidb-redis-keys-'));
  for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
  const server = await createGateway({
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
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', () => resolve()));
  const httpPort = (server.server.address() as AddressInfo).port;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer it-token' };
  const api = async <T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const connect = async (name: string, readonly: boolean) => {
    const created = await api<{ connection: { id: string } }>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name,
        engine: 'redis',
        host: '127.0.0.1',
        port: PORT,
        database: '0',
        groupName: 'live',
        color: 'red',
        environment: 'dev',
        readonly,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.connection.id;
  };
  return {
    api,
    connect,
    close: async () => {
      await server.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows 上 SQLite 句柄可能还未释放，临时目录交给系统清理 */
      }
    },
  };
}

test('HTTP 接口删除键、拒绝只读连接，并能为 RediSearch 索引删除', { skip: !PORT }, async () => {
  const env = await gateway();
  after(env.close);

  const seed = new Redis({ host: '127.0.0.1', port: PORT!, lazyConnect: true });
  await seed.connect();
  await seed.del('aidb_http_a', 'aidb_http_b', 'aidb:idx:h1');
  await seed.set('aidb_http_a', '1');
  await seed.set('aidb_http_b', '2');
  await seed.hset('aidb:idx:h1', 'name', 'Ada');
  await seed.call('FT.CREATE', 'aidb_http_idx', 'ON', 'HASH', 'PREFIX', '1', 'aidb:idx:', 'SCHEMA', 'name', 'TEXT').catch(() => undefined);
  await seed.quit();

  const writable = await env.connect('redis-keys-write', false);
  const readonly = await env.connect('redis-keys-readonly', true);

  const missing = await env.api('/redis/keys/delete', { method: 'POST', body: JSON.stringify({ connectionId: writable, keys: [] }) });
  assert.equal(missing.status, 400, '空 keys 直接拒绝');

  const blocked = await env.api<{ error: { code: string } }>('/redis/keys/delete', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonly, keys: ['aidb_http_a'] }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'READONLY');

  const deleted = await env.api<{ result: { deleted: number } }>('/redis/keys/delete', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', keys: ['aidb_http_a', 'aidb_http_b', 'aidb_http_never'] }),
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.result.deleted, 2, '只统计真实存在的键');

  const gone = await env.api<{ error: { code: string } }>(`/redis/key?connectionId=${writable}&database=0&key=aidb_http_a`);
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'REDIS_KEY_NOT_FOUND');

  const indexDropped = await env.api<{ result: { name: string; dropped: boolean } }>('/redis/index/drop', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', name: 'aidb_http_idx' }),
  });
  assert.equal(indexDropped.status, 200, JSON.stringify(indexDropped.body));
  assert.equal(indexDropped.body.result.dropped, true);

  const check = new Redis({ host: '127.0.0.1', port: PORT!, lazyConnect: true });
  await check.connect();
  assert.ok(!(await check.call('FT._LIST') as unknown[]).map(String).includes('aidb_http_idx'));
  assert.equal(await check.hget('aidb:idx:h1', 'name'), 'Ada', '删除索引不动文档');
  await check.del('aidb:idx:h1');
  await check.quit();

  const audits = await env.api<{ entries: Array<{ tool: string; risk: string }> }>(`/audit?connectionId=${writable}&limit=20`);
  const tools = (audits.body.entries ?? []).map((entry) => entry.tool);
  assert.ok(tools.includes('redis.keys.delete'), '键删除留下审计');
  assert.ok(tools.includes('redis.index.drop'), '索引删除留下审计');
});

test('HTTP 设置/移除 TTL 与重命名键', { skip: !PORT }, async () => {
  const seed = new Redis({ host: '127.0.0.1', port: PORT!, lazyConnect: true });
  await seed.connect();
  try {
    await seed.del('aidb_ttl', 'aidb_rn_from', 'aidb_rn_to', 'aidb_rn_moved');
    await seed.set('aidb_ttl', '1');
    await seed.set('aidb_rn_from', 'a');
    await seed.set('aidb_rn_to', 'taken');
  } finally {
    await seed.quit();
  }

  const env = await gateway();
  after(env.close);
  const writable = await env.connect('redis-ttl-write', false);
  const readonly = await env.connect('redis-ttl-readonly', true);

  const blocked = await env.api<{ error: { code: string } }>('/redis/key/ttl', {
    method: 'POST',
    body: JSON.stringify({ connectionId: readonly, database: '0', key: 'aidb_ttl', seconds: 60 }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'READONLY');

  const bad = await env.api('/redis/key/ttl', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', key: 'aidb_ttl', seconds: 0 }),
  });
  assert.equal(bad.status, 400, '0 秒不是合法 TTL');

  const set = await env.api<{ result: { ttl: number } }>('/redis/key/ttl', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', key: 'aidb_ttl', seconds: 600 }),
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.ok(set.body.result.ttl > 500 && set.body.result.ttl <= 600, `TTL 应接近 600，实际 ${set.body.result.ttl}`);

  const detail = await env.api<{ detail: { ttl: number } }>(`/redis/key?connectionId=${writable}&database=0&key=aidb_ttl`);
  assert.ok(detail.body.detail.ttl > 500, '详情里的 TTL 同步');

  const cleared = await env.api<{ result: { ttl: number } }>('/redis/key/ttl', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', key: 'aidb_ttl', seconds: null }),
  });
  assert.equal(cleared.body.result.ttl, -1, 'PERSIST 后永不过期');

  const missing = await env.api<{ error: { code: string } }>('/redis/key/ttl', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', key: 'aidb_ttl_ghost', seconds: 60 }),
  });
  assert.equal(missing.body.error.code, 'REDIS_KEY_NOT_FOUND', '给不存在的键设 TTL 会报错而不是静默成功');

  const taken = await env.api<{ error: { code: string } }>('/redis/key/rename', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', key: 'aidb_rn_from', to: 'aidb_rn_to' }),
  });
  assert.equal(taken.status, 409, JSON.stringify(taken.body));
  assert.equal(taken.body.error.code, 'REDIS_RENAME_TAKEN');

  const renamed = await env.api<{ result: { from: string; to: string } }>('/redis/key/rename', {
    method: 'POST',
    body: JSON.stringify({ connectionId: writable, database: '0', key: 'aidb_rn_from', to: 'aidb_rn_moved' }),
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const gone = await env.api(`/redis/key?connectionId=${writable}&database=0&key=aidb_rn_from`);
  assert.equal(gone.status, 404);
  const moved = await env.api<{ detail: { key: string } }>(`/redis/key?connectionId=${writable}&database=0&key=aidb_rn_moved`);
  assert.equal(moved.body.detail.key, 'aidb_rn_moved');

  const audits = await env.api<{ entries: Array<{ tool: string; risk: string }> }>(`/audit?connectionId=${writable}&limit=30`);
  const byTool = new Map((audits.body.entries ?? []).map((entry) => [entry.tool, entry.risk]));
  assert.equal(byTool.get('redis.key.ttl'), 'write');
  assert.equal(byTool.get('redis.key.rename'), 'destructive');

  const cleanup = new Redis({ host: '127.0.0.1', port: PORT!, lazyConnect: true });
  await cleanup.connect();
  try {
    await cleanup.del('aidb_ttl', 'aidb_rn_to', 'aidb_rn_moved');
  } finally {
    await cleanup.quit();
  }
});

test('HTTP 新建键覆盖五种类型，拒绝重复键与只读连接', { skip: !PORT }, async () => {
  const env = await gateway();
  after(env.close);
  const writable = await env.connect('redis-create', false);
  const readonly = await env.connect('redis-create-ro', true);
  const db = '9';
  const names = ['aidb_ck_str', 'aidb_ck_hash', 'aidb_ck_list', 'aidb_ck_set', 'aidb_ck_zset'];

  const client = new Redis({ host: '127.0.0.1', port: PORT!, db: Number(db), lazyConnect: true });
  await client.connect();
  try {
    await client.del(...names);
    const create = (key: string, type: string, value: unknown, ttl?: number | null) =>
      env.api<{ result: { key: string; type: string; ttl: number } }>('/redis/key/create', {
        method: 'POST',
        body: JSON.stringify({ connectionId: writable, database: db, key, type, value, ttl }),
      });

    const str = await create('aidb_ck_str', 'string', 'hello', 600);
    assert.equal(str.status, 200, JSON.stringify(str.body));
    assert.equal(str.body.result.type, 'string');
    assert.ok(str.body.result.ttl > 0 && str.body.result.ttl <= 600, 'TTL 生效');
    assert.equal(await client.get('aidb_ck_str'), 'hello');

    assert.equal((await create('aidb_ck_hash', 'hash', { name: 'Ada', age: '36' })).status, 200);
    assert.deepEqual(await client.hgetall('aidb_ck_hash'), { name: 'Ada', age: '36' });

    assert.equal((await create('aidb_ck_list', 'list', ['a', 'b'])).status, 200);
    assert.deepEqual(await client.lrange('aidb_ck_list', 0, -1), ['a', 'b']);

    assert.equal((await create('aidb_ck_set', 'set', ['x', 'y', 'x'])).status, 200);
    assert.deepEqual((await client.smembers('aidb_ck_set')).sort(), ['x', 'y']);

    assert.equal((await create('aidb_ck_zset', 'zset', { alice: 1, bob: 2 })).status, 200);
    assert.deepEqual(await client.zrange('aidb_ck_zset', 0, -1, 'WITHSCORES'), ['alice', '1', 'bob', '2']);

    const dup = await create('aidb_ck_str', 'string', 'again');
    assert.equal(dup.status, 409);
    assert.equal((dup.body as any).error.code, 'REDIS_KEY_EXISTS');
    assert.equal(await client.get('aidb_ck_str'), 'hello', '重复创建不覆盖原值');

    const ro = await env.api('/redis/key/create', {
      method: 'POST',
      body: JSON.stringify({ connectionId: readonly, database: db, key: 'aidb_ck_ro', type: 'string', value: 'x' }),
    });
    assert.equal(ro.status, 403);
    assert.equal((ro.body as any).error.code, 'READONLY');

    const badType = await env.api('/redis/key/create', {
      method: 'POST',
      body: JSON.stringify({ connectionId: writable, database: db, key: 'aidb_ck_bad', type: 'stream', value: 'x' }),
    });
    assert.equal(badType.status, 400);

    const badScore = await create('aidb_ck_zset2', 'zset', { alice: 'not-a-number' });
    assert.equal(badScore.status, 400);

    const audits = await env.api<{ entries: Array<{ tool: string; risk: string }> }>(`/audit?connectionId=${writable}&limit=30`);
    assert.ok((audits.body.entries ?? []).some((entry) => entry.tool === 'redis.key.create' && entry.risk === 'write'));
  } finally {
    await client.del(...names, 'aidb_ck_zset2');
    await client.quit();
  }
});
