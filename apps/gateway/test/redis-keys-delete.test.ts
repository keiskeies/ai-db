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
