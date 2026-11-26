import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatement, classifySql, hasUnsafeSqlSyntax, maskLiterals, readonlyViolation, splitStatements } from '../src/sql/classify';

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

test('SQL Server 方括号标识符按 ]] 转义，危险括号 SQL fail-closed', () => {
  const safe = 'SELECT [foo]]bar] AS [value] FROM [dbo].[users]';
  assert.equal(classifyStatement(safe, 'sqlserver').kind, 'read');
  assert.equal(maskLiterals(safe, 'sqlserver').length, safe.length);

  const payload = "SELECT [foo']; DELETE FROM dbo.users; --] FROM dbo.users";
  const classified = classifySql(payload, 'sqlserver');
  assert.ok(classified.statements.length >= 2, '闭合方括号后的真实分号必须暴露后续语句');
  assert.equal(classified.statements[0]?.kind, 'unknown');
  assert.equal(classified.statements[1]?.kind, 'destructive');
  assert.equal(classified.risk, 'destructive');
  assert.match(classified.statements[0]?.reason ?? '', /括号|引号|注释/);
  assert.equal(hasUnsafeSqlSyntax(payload, 'sqlserver'), true);
  assert.ok(readonlyViolation(payload, 'sqlserver'), '只读边界必须拒绝危险方括号');

  const split = classifySql(`${safe}; DELETE FROM dbo.users`, 'sqlserver');
  assert.equal(split.statements.length, 2, '闭合且正确转义的标识符之后的真实分号仍要拆分');
  assert.equal(split.statements[1]?.kind, 'destructive');
  assert.equal(split.risk, 'destructive');

  assert.equal(classifyStatement('SELECT [foo', 'sqlserver').kind, 'unknown');
  assert.equal(classifyStatement(payload, 'postgresql').kind, 'unknown', '方言不明/非 SQL Server 的危险括号也不能放行');
  assert.equal(classifyStatement("SELECT ARRAY['a','b'][1]", 'postgresql').kind, 'read', 'PG 正常数组表达式不能误伤');
});

test('MySQL # 注释屏蔽分号并在换行处结束，-- 无空白时不是注释', () => {
  const commentOnly = 'SELECT 1 # ; DROP TABLE hidden';
  assert.equal(splitStatements(commentOnly, 'mysql').length, 1);
  assert.equal(classifyStatement(commentOnly, 'mysql').kind, 'read');
  assert.equal(maskLiterals(commentOnly, 'mysql').length, commentOnly.length);

  const boundary = 'SELECT 1; # ; DROP TABLE hidden;\nDELETE FROM users';
  const classified = classifySql(boundary, 'mysql');
  assert.equal(classified.statements.length, 2);
  assert.equal(classified.statements[0]?.kind, 'read');
  assert.equal(classified.statements[1]?.kind, 'destructive');
  assert.equal(classified.risk, 'destructive');

  assert.equal(classifySql('SELECT 1--1; DROP TABLE users', 'mysql').risk, 'destructive', 'MySQL 的 1--1 是算术表达式');
  assert.equal(classifySql('SELECT 1 # ; DROP TABLE users', 'postgresql').risk, 'destructive', '非 MySQL 方言不能套用 # 注释语义');
});

test('PRAGMA 仅放行内省查询，setter 与副作用 pragma 都不是 read', () => {
  const reads = [
    'PRAGMA table_info(users)',
    'PRAGMA main.table_info(users)',
    'PRAGMA index_list(users)',
    'PRAGMA foreign_keys',
    'PRAGMA user_version',
    'PRAGMA journal_mode',
    'PRAGMA database_list',
  ];
  for (const sql of reads) assert.equal(classifyStatement(sql, 'sqlite').kind, 'read', sql);

  const writes = [
    'PRAGMA foreign_keys=OFF',
    'PRAGMA writable_schema=ON',
    'PRAGMA query_only=OFF',
    'PRAGMA user_version = 5',
    'PRAGMA user_version(5)',
    'PRAGMA application_id = 1',
    'PRAGMA journal_mode=WAL',
    'PRAGMA cache_size=-100',
    'PRAGMA wal_checkpoint',
    'PRAGMA optimize',
    'PRAGMA shrink_memory',
    'PRAGMA incremental_vacuum',
    'PRAGMA unknown_future_setting=ON',
  ];
  for (const sql of writes) {
    assert.notEqual(classifyStatement(sql, 'sqlite').kind, 'read', sql);
    assert.ok(readonlyViolation(sql, 'sqlite'), `只读连接必须拒绝 ${sql}`);
  }
});