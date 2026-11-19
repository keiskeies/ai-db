import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatement, classifySql, readonlyViolation, splitStatements } from '../src/sql/classify';

test('SET ROLE 与 SET SESSION AUTHORIZATION 是权限变更，不是会话参数', () => {
  assert.equal(classifyStatement('SET ROLE admin').kind, 'write');
  assert.equal(classifyStatement('SET SESSION AUTHORIZATION alice').kind, 'write');
  assert.equal(classifyStatement('SET SESSION group_concat_max_len = 65535').kind, 'session');
});

test('SQLite 写库头的 PRAGMA 不再归为只读', () => {
  assert.equal(classifyStatement('PRAGMA user_version = 5').kind, 'write');
  assert.equal(classifyStatement('PRAGMA application_id = 1').kind, 'write');
  assert.equal(classifyStatement('PRAGMA table_info(users)').kind, 'read');
});

test('MySQL 可执行注释里的写子句不能骗过只读判定', () => {
  const sql = "SELECT * FROM t /*! INTO OUTFILE '/tmp/x' */";
  assert.equal(classifyStatement(sql, 'mysql').kind, 'write');
  assert.equal(classifyStatement(sql).kind, 'write', '引擎未知时宁可误拦');
  assert.equal(classifyStatement(sql, 'postgresql').kind, 'read', 'PG 上它就是死注释');
  const lock = 'SELECT * FROM t /*! FOR UPDATE */';
  assert.match(readonlyViolation(lock, 'mysql') ?? '', /只读/);
  assert.equal(readonlyViolation(lock, 'postgresql'), null);
});

test('PG 双引号标识符不认反斜杠：后续语句不能被掩码吞掉', () => {
  const sql = String.raw`SELECT "a\"; DROP TABLE t --"`;
  const c = classifySql(sql, 'postgresql');
  assert.equal(c.statements.length, 2);
  assert.equal(c.risk, 'destructive');
});

test('MySQL 单引号认反斜杠：含转义引号的字符串不被劈碎', () => {
  const sql = String.raw`SELECT 'a\'; DROP TABLE t; --'`;
  const c = classifySql(sql, 'mysql');
  assert.equal(c.statements.length, 1);
  assert.equal(c.risk, 'read');
});

test('PG 美元引用内的分号不拆分语句', () => {
  const c = classifySql('SELECT $$; DROP TABLE t;$$', 'postgresql');
  assert.equal(c.statements.length, 1);
  assert.equal(c.risk, 'read');
  const fn = 'DO $$ BEGIN DELETE FROM t WHERE id = 1; END $$';
  assert.equal(splitStatements(fn, 'postgresql').length, 1);
});

test('MySQL 标识符里的 $ 不是美元引用：后续 DROP 不能被吞掉', () => {
  const sql = 'SELECT a$b$c; DROP TABLE t';
  assert.equal(classifySql(sql, 'mysql').risk, 'destructive');
  assert.equal(classifySql(sql, 'mysql').statements.length, 2);
  assert.equal(classifySql(sql).statements.length, 2, '引擎未知时不认美元引用，宁可误拆');
});