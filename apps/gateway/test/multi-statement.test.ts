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
    store,
    conn,
    cleanup: async () => {
      await manager.closeAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('allowMulti:false 对两条只读或写语句都真正拒绝，且拒绝时没有副作用', async () => {
  const { manager, conn, cleanup } = setup();
  try {
    await assert.rejects(
      () => manager.query(conn.id, 'SELECT 1 AS a; SELECT 2 AS b;', { allowMulti: false, autoLimit: false, actor: 'agent' }),
      (error: any) => error.code === 'SCRIPT_TOO_LARGE' && /2 条可执行语句/.test(error.message),
    );
    await assert.rejects(
      () => manager.query(conn.id, "INSERT INTO probe VALUES (2,'x'); INSERT INTO probe VALUES (3,'y');", { allowMulti: false, autoLimit: false, actor: 'agent' }),
      (error: any) => error.code === 'SCRIPT_TOO_LARGE',
    );
    await assert.rejects(
      () => manager.query(conn.id, "INSERT INTO probe VALUES (2,'x'); INSERT INTO probe VALUES (3,'y');", { autoLimit: false, actor: 'agent' }),
      (error: any) => error.code === 'SCRIPT_TOO_LARGE',
      '省略 allowMulti 与 false 同义',
    );

    const count = await manager.query(conn.id, 'SELECT COUNT(*) AS n FROM probe', { allowMulti: false, autoLimit: false, actor: 'agent' });
    assert.equal(Number(count.sets[0].rows[0][0]), 1, '被拒绝的写脚本不能执行第一条');
  } finally {
    await cleanup();
  }
});

test('只有显式 allowMulti:true 才执行脚本，单条语句仍可正常执行', async () => {
  const { manager, conn, cleanup } = setup();
  try {
    const readOnly = await manager.query(conn.id, 'SELECT 1 AS a; SELECT 2 AS b;', {
      allowMulti: true,
      autoLimit: false,
      actor: 'agent',
    });
    assert.equal(readOnly.sets.length, 2);
    assert.equal(Number(readOnly.sets[1].rows[0][0]), 2);

    const writes = await manager.query(conn.id, "INSERT INTO probe VALUES (2,'x'); INSERT INTO probe VALUES (3,'y');", {
      allowMulti: true,
      autoLimit: false,
      actor: 'agent',
    });
    assert.equal(writes.sets.length, 2);

    const single = await manager.query(conn.id, "INSERT INTO probe VALUES (4,'x')", { allowMulti: false, autoLimit: false, actor: 'agent' });
    assert.equal(single.sets.length, 1);

    const count = await manager.query(conn.id, 'SELECT COUNT(*) AS n FROM probe', { allowMulti: false, autoLimit: false, actor: 'agent' });
    assert.equal(Number(count.sets[0].rows[0][0]), 4);
  } finally {
    await cleanup();
  }
});

test('manager 在建连前拒绝危险方括号，并保留正确转义后的单语句闸门', async () => {
  const { manager, store, cleanup } = setup();
  try {
    const sqlserver = store.createConnection({ name: 'mssql-boundary', engine: 'sqlserver', host: '127.0.0.1', port: 1, database: 'master' });
    const payload = "SELECT [foo']; DELETE FROM dbo.users; --] FROM dbo.users";
    for (const allowMulti of [false, true]) {
      await assert.rejects(
        () => manager.query(sqlserver.id, payload, { allowMulti, autoLimit: false, actor: 'user' }),
        (error: any) => error.code === 'SQL_UNKNOWN' && /括号|引号|注释/.test(error.message),
        'allowMulti 不能绕过词法安全边界',
      );
    }
    await assert.rejects(
      () => manager.query(sqlserver.id, 'SELECT [foo]]bar] FROM [dbo].[users]; DELETE FROM dbo.users', { allowMulti: false, autoLimit: false, actor: 'user' }),
      (error: any) => error.code === 'SCRIPT_TOO_LARGE' && /2 条可执行语句/.test(error.message),
    );

    const mysql = store.createConnection({ name: 'mysql-comment-boundary', engine: 'mysql', host: '127.0.0.1', port: 1, database: 'app' });
    await assert.rejects(
      () => manager.query(mysql.id, 'SELECT 1; # ; DROP TABLE hidden;\nDELETE FROM users', { allowMulti: false, autoLimit: false, actor: 'user' }),
      (error: any) => error.code === 'SCRIPT_TOO_LARGE' && /2 条可执行语句/.test(error.message),
      '# 注释内的分号不计数，换行后的 DELETE 必须计数',
    );
  } finally {
    await cleanup();
  }
});

test('只读连接拒绝 PRAGMA setter、未知 pragma 与副作用 pragma', async () => {
  const { manager, store, conn, cleanup } = setup();
  try {
    const readonly = store.createConnection({ name: 'multi-readonly', engine: 'sqlite', database: store.getConnection(conn.id)!.database, readonly: true });
    const before = await manager.query(readonly.id, 'PRAGMA foreign_keys', { allowMulti: false, autoLimit: false, actor: 'agent' });
    for (const sql of [
      'PRAGMA foreign_keys=OFF',
      'PRAGMA writable_schema=ON',
      'PRAGMA query_only=OFF',
      'PRAGMA user_version(5)',
      'PRAGMA wal_checkpoint',
      'PRAGMA optimize',
      'PRAGMA unknown_future_setting=ON',
    ]) {
      await assert.rejects(
        () => manager.query(readonly.id, sql, { allowMulti: true, autoLimit: false, actor: 'agent' }),
        (error: any) => error.code === 'READONLY',
        sql,
      );
    }
    const state = await manager.query(readonly.id, 'PRAGMA foreign_keys', { allowMulti: false, autoLimit: false, actor: 'agent' });
    assert.equal(Number(state.sets[0].rows[0][0]), Number(before.sets[0].rows[0][0]), '被拒绝的 PRAGMA 不能改变连接状态');
  } finally {
    await cleanup();
  }
});