import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSqlStatements, restoreDropStatements, safeDefaultToDump, dumpKeysetSql, dumpPageSql } from '../src/services';
import { insertBatchSize } from '../src/features/transfer';

async function collectStatements(path: string): Promise<string[]> {
  const out: string[] = [];
  for await (const statement of readSqlStatements(path)) out.push(statement);
  return out;
}

test('readSqlStatements：多行字符串内的换行与分号不再拆坏语句', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bkp-'));
  const file = join(dir, 'dump.sql');
  writeFileSync(
    file,
    [
      'CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT);',
      `INSERT INTO t (id, body) VALUES (1, '{"a":"x\ny"}');`,
      `INSERT INTO t (id, body) VALUES (2, '分号;在串内');`,
      `INSERT INTO t (id, body) VALUES (3, '转义''引号');`,
    ].join('\n'),
    'utf8',
  );
  const statements = await collectStatements(file);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(statements.length, 4, `应切出 4 条语句，实际 ${statements.length}`);
  assert.equal(statements[1], `INSERT INTO t (id, body) VALUES (1, '{"a":"x\ny"}');`, '多行字符串值应保留在一条语句里');
  assert.match(statements[2], /分号;在串内/, '串内分号不切分');
  assert.match(statements[3], /''/, '转义引号保留');
});

test('readSqlStatements：无分号 EOF 时整体 flush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bkp-'));
  const file = join(dir, 'dump.sql');
  writeFileSync(file, 'INSERT INTO t (id) VALUES (1)\n', 'utf8');
  const statements = await collectStatements(file);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /VALUES \(1\)/);
});

test('readSqlStatements：行注释与空行被跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bkp-'));
  const file = join(dir, 'dump.sql');
  writeFileSync(file, '-- 注释头\n\nSELECT 1;\n-- 中间注释\nSELECT 2;\n', 'utf8');
  const statements = await collectStatements(file);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(statements, ['SELECT 1;', 'SELECT 2;']);
});

test('restoreDropStatements：oracle/dm/clickhouse 生成 DROP 前置', () => {
  const dump = 'CREATE TABLE "users" (id NUMBER(10) PRIMARY KEY);\nCREATE VIEW "v_active" AS SELECT 1 FROM users;\n';
  const oracle = restoreDropStatements('oracle' as never, dump);
  // 视图先于表 DROP（视图依赖表）
  assert.equal(oracle[0], 'DROP VIEW "v_active" CASCADE CONSTRAINTS;');
  assert.equal(oracle[1], 'DROP TABLE "users" CASCADE CONSTRAINTS;');

  const ch = restoreDropStatements('clickhouse' as never, dump);
  assert.equal(ch[0], 'DROP VIEW IF EXISTS "v_active";');
  assert.equal(ch[1], 'DROP TABLE IF EXISTS "users";');
});

test('restoreDropStatements：mysql 包裹外键关闭两行', () => {
  const drops = restoreDropStatements('mysql' as never, 'CREATE TABLE users (id INT PRIMARY KEY);');
  assert.deepEqual(drops, ['SET FOREIGN_KEY_CHECKS=0;', 'DROP TABLE IF EXISTS users;', 'SET FOREIGN_KEY_CHECKS=1;']);
});

test('safeDefaultToDump：白名单函数与字面量保留，强转/表达式丢弃', () => {
  // nextval('seq') 带参数（引号内），当前白名单只收无参函数 —— 保持丢弃，确保不落盘注入型默认值。
  assert.equal(safeDefaultToDump('nextval(\'seq\')'), undefined);
  assert.equal(safeDefaultToDump('now()'), 'now()');
  assert.equal(safeDefaultToDump('CURRENT_TIMESTAMP'), undefined, '无参内置关键字不带括号时不入白名单');
  assert.equal(safeDefaultToDump('42'), '42');
  assert.equal(safeDefaultToDump("'abc'"), "'abc'");
  assert.equal(safeDefaultToDump("'2026-01-01'::date"), undefined, ':: 强转丢弃');
  assert.equal(safeDefaultToDump('a + b'), undefined, '表达式丢弃');
});

test('dumpPageSql / dumpKeysetSql：oracle/dm 走 FETCH 语法', () => {
  assert.equal(dumpPageSql('oracle' as never, 'SELECT * FROM t', ['id'], 100, 0).endsWith('LIMIT 100'), false);
  assert.equal(dumpKeysetSql('oracle' as never, 'SELECT * FROM t', 'id', 100, 5), 'SELECT * FROM t WHERE "id" > :1 ORDER BY "id" FETCH FIRST 100 ROWS ONLY');
  assert.equal(dumpKeysetSql('dm' as never, 'SELECT * FROM t', 'id', 100, undefined), 'SELECT * FROM t ORDER BY "id" FETCH FIRST 100 ROWS ONLY');
});

test('insertBatchSize：mssql 按列数折算，oracle 大余量，其余 200', () => {
  assert.equal(insertBatchSize('sqlserver', 15), 133);
  assert.equal(insertBatchSize('sqlserver', 1), 200);
  assert.equal(insertBatchSize('oracle', 100), 200);
  assert.equal(insertBatchSize('mysql', 200), 200);
});
