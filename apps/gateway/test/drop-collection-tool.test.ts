import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from '@aidb/core';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';

const home = mkdtempSync(join(tmpdir(), 'aidb-drop-tool-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'drop-secret',
  token: 'drop-token',
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});

after(async () => {
  await gateway.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows 上 SQLite 句柄可能还未释放，临时目录交给系统清理 */
  }
});

const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());

function connect(partial: Record<string, unknown>): ConnectionConfig {
  return gateway.store.createConnection({
    groupName: 'stub',
    color: 'cyan',
    environment: 'dev',
    readonly: false,
    ...partial,
  } as any);
}

const qdrant = connect({ name: 'qdrant-drop-tool', engine: 'qdrant', host: '127.0.0.1', port: 6335, database: 'default' });
const kv = connect({ name: 'redis-drop-tool', engine: 'redis', host: '127.0.0.1', port: 6399, database: '0' });

function drop(conn: ConnectionConfig, args: Record<string, unknown>) {
  return executor.execute(
    { id: `drop-${Math.random().toString(36).slice(2)}`, name: 'delete_collection', args: { connectionId: conn.id, ...args } },
    { sessionId: 's1', connectionId: conn.id },
  );
}

test('delete_collection 必须原样重复名字才动手', async () => {
  const missing = await drop(qdrant, { name: 'aidb_drop' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'CONFIRM_REQUIRED');

  const mismatched = await drop(qdrant, { name: 'aidb_drop', confirm: 'aidb_dr0p' });
  assert.equal(mismatched.ok, false, 'confirm 不一致时不能删除');
  assert.equal(mismatched.error?.code, 'CONFIRM_REQUIRED');
});

test('delete_collection 走驱动 DELETE 并写入审计', async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const mocked = mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ result: true, acknowledged: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const result = await drop(qdrant, { name: 'aidb_drop', confirm: 'aidb_drop' });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(seen.length, 1, '只发送一次 DELETE');
    assert.equal(seen[0].method, 'DELETE');
    assert.match(seen[0].url, /\/collections\/aidb_drop$/);
    const audits = gateway.store.listAudit({ connectionId: qdrant.id, limit: 10 });
    assert.ok(
      audits.some((item) => item.tool === 'delete_collection' && item.risk === 'destructive' && item.status === 'ok'),
      'Agent 删集合应留下破坏性审计',
    );
  } finally {
    mocked.mock.restore();
  }
});

test('不支持对象生命周期的引擎直接拒绝', async () => {
  const result = await drop(kv, { name: 'anything', confirm: 'anything' });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'UNSUPPORTED_ENGINE');
});
