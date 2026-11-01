import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from '@aidb/core';
import { ConnectionManager } from '../src/manager';
import { Store } from '../src/store';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-multi-'));
  const file = join(dir, 'multi.db');
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)');
  seed.exec("INSERT INTO probe VALUES (1, 'seed')");
  seed.close();
  const store = new Store(join(dir, 'aidb.db'), 'secret');
  const config = {
    version: '0',
    home: dir,
    dbPath: join(dir, 'aidb.db'),
    host: '127.0.0.1',
    port: 0,
    token: 't',
    secret: 'secret',
    demoDir: join(dir, 'demo'),
    exportDir: join(dir, 'exports'),
    importDir: join(dir, 'imports'),
    backupDir: join(dir, 'backups'),
    attachmentDir: join(dir, 'attachments'),
    staticDir: join(dir, 'static'),
    production: false,
  };
  const manager = new ConnectionManager(store, config, () => DEFAULT_SETTINGS);
  const conn = store.createConnection({ name: 'multi', engine: 'sqlite', database: file });
  return {
    manager,
    conn,
    cleanup: async () => {
      await manager.closeAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('只读多语句脚本一次执行，写脚本在缺省下也执行（上限内的批量不再拦）', async () => {
  const { manager, conn, cleanup } = setup();
  try {
    const readOnly = await manager.query(conn.id, 'SELECT 1 AS a; SELECT 2 AS b;', {
      allowMulti: false,
      autoLimit: false,
      actor: 'agent',
    });
    assert.equal(readOnly.sets.length, 2, '多条只读 SELECT 应一次执行');
    assert.equal(Number(readOnly.sets[1].rows[0][0]), 2);

    // 上限以内的写脚本不再需要开关：建表序列、一张表几十条列变更都是常态。
    // 权限边界是 resolveRisk + evaluatePermission（按整段最高风险判定），与条数无关。
    const writes = await manager.query(conn.id, "INSERT INTO probe VALUES (2,'x'); INSERT INTO probe VALUES (3,'y');", {
      allowMulti: false,
      autoLimit: false,
      actor: 'agent',
    });
    assert.equal(writes.sets.length, 2, '上限内的写脚本缺省即可执行');

    const enabled = await manager.query(conn.id, "INSERT INTO probe VALUES (4,'x'); INSERT INTO probe VALUES (5,'y');", {
      allowMulti: true,
      autoLimit: false,
      actor: 'agent',
    });
    assert.equal(enabled.sets.length, 2);

    const count = await manager.query(conn.id, 'SELECT COUNT(*) AS n FROM probe', { allowMulti: false, autoLimit: false, actor: 'agent' });
    assert.equal(Number(count.sets[0].rows[0][0]), 5);
  } finally {
    await cleanup();
  }
});