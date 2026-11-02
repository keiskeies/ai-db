import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLimit, classifySql, classifyStatement, readonlyViolation, splitStatements } from '../src/sql/classify';

test('classifies read statements', () => {
  assert.equal(classifyStatement('SELECT * FROM users LIMIT 10').kind, 'read');
  assert.equal(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x').kind, 'read');
  assert.equal(classifyStatement('EXPLAIN SELECT * FROM t').kind, 'read');
  assert.equal(classifyStatement('PRAGMA table_info(users)').kind, 'read');
  assert.equal(classifyStatement('SHOW TABLES').kind, 'read');
});

test('classifies writes and destructive statements', () => {
  assert.equal(classifyStatement('INSERT INTO t VALUES (1)').kind, 'write');
  assert.equal(classifyStatement('UPDATE t SET a = 1 WHERE id = 2').kind, 'write');
  assert.equal(classifyStatement('UPDATE t SET a = 1').kind, 'destructive');
  assert.equal(classifyStatement('DELETE FROM t WHERE id = 1').kind, 'write');
  assert.equal(classifyStatement('DELETE FROM t').kind, 'destructive');
  assert.equal(classifyStatement('CREATE TABLE t (id INTEGER)').kind, 'ddl');
  assert.equal(classifyStatement('ALTER TABLE t ADD COLUMN b TEXT').kind, 'ddl');
  assert.equal(classifyStatement('ALTER TABLE t DROP COLUMN b').kind, 'destructive');
  assert.equal(classifyStatement('DROP TABLE t').kind, 'destructive');
  assert.equal(classifyStatement('TRUNCATE TABLE t').kind, 'destructive');
});

test('keywords inside literals or comments do not affect classification', () => {
  assert.equal(classifyStatement("SELECT 'DROP TABLE users' AS note").kind, 'read');
  assert.equal(classifyStatement('-- DROP TABLE users\nSELECT 1').kind, 'read');
});

test('classifies multi-statement scripts by the highest risk', () => {
  const result = classifySql('SELECT 1; UPDATE t SET a=1 WHERE id=1; DROP TABLE x;');
  assert.equal(result.risk, 'destructive');
  assert.equal(result.statements.length, 3);
});

test('splits statements while respecting strings and comments', () => {
  const sql = "SELECT ';' AS a; -- ; not a separator\nINSERT INTO t VALUES ('a;b');";
  const parts = splitStatements(sql);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /SELECT/);
  assert.match(parts[1], /INSERT/);
});

test('readonly violations cover all mutations', () => {
  assert.equal(readonlyViolation('SELECT 1', 'sqlite'), null);
  assert.match(readonlyViolation('UPDATE t SET a=1 WHERE id=1') ?? '', /只读/);
  assert.match(readonlyViolation('DROP TABLE t') ?? '', /只读/);
  assert.match(readonlyViolation('SELECT 1; DELETE FROM t', 'sqlite') ?? '', /只读/);
});

// 事故：`SET SESSION group_concat_max_len=65535; SELECT ...` 被当成「包含写操作」拦下。
// 会话级设置只影响当前连接，不碰数据，必须按只读对待，否则最普通的调参查询都要走批量开关。
test('会话级语句不改变数据，按只读处理', () => {
  assert.equal(classifyStatement('SET SESSION group_concat_max_len = 65535').kind, 'session');
  assert.equal(classifyStatement('SET NAMES utf8mb4').kind, 'session');
  assert.equal(classifyStatement('SET @row := 0').kind, 'session');
  assert.equal(classifyStatement('USE kbook').kind, 'session');
  assert.equal(classifyStatement('BEGIN').kind, 'session');
  assert.equal(classifyStatement('COMMIT').kind, 'session');
  assert.equal(classifyStatement('ROLLBACK').kind, 'session');

  const script = classifySql(
    "SET SESSION group_concat_max_len = 65535;\nSELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='kbook';",
  );
  assert.equal(script.risk, 'read', '会话设置 + 查询不是写脚本，不该触发多语句闸门');
  assert.equal(readonlyViolation('SET SESSION group_concat_max_len = 65535; SELECT 1'), null, '只读连接上也该放行');
});

test('会话级语句里的危险子集仍按写/破坏性处理', () => {
  assert.equal(classifyStatement('SET GLOBAL max_connections = 500').kind, 'write', '改服务端全局配置不是会话级');
  assert.equal(classifyStatement("SET @@GLOBAL.sql_mode = ''").kind, 'write');
  assert.equal(classifyStatement('SET PERSIST max_connections = 500').kind, 'write');
  assert.equal(classifyStatement("SET PASSWORD FOR 'u'@'h' = 'x'").kind, 'destructive', '改密码必须审批');
});

test('applies limits only to unbounded reads', () => {
  assert.equal(applyLimit('SELECT * FROM t', 50), 'SELECT * FROM t LIMIT 50');
  assert.equal(applyLimit('SELECT * FROM t LIMIT 5', 50), 'SELECT * FROM t LIMIT 5');
  assert.equal(applyLimit('UPDATE t SET a=1 WHERE id=1', 50), 'UPDATE t SET a=1 WHERE id=1');
  assert.equal(applyLimit('SELECT 1; SELECT 2', 50), 'SELECT 1; SELECT 2');
  assert.equal(applyLimit('EXPLAIN SELECT * FROM t', 50), 'EXPLAIN SELECT * FROM t');
});

test('SQL Server 的 sp_rename 是结构变更，不是 unknown', () => {
  // 回归：SQL Server 改表名/列名走 EXEC sp_rename。归为 unknown 时，
  // 任何"只认 ddl/destructive"的下游判定都会漏掉它 —— 结构变更
  // 既不广播事件也不清 schema 缓存，客户端一直显示旧表名。
  assert.equal(classifyStatement("EXEC sp_rename 'dbo.orders','orders_v2'").kind, 'ddl');
  assert.equal(classifyStatement("EXEC sp_rename 'dbo.orders.total','amount','COLUMN'").kind, 'ddl');
  // 其它 EXEC 不一定是结构变更，不能被一起归成 ddl。
  assert.equal(classifyStatement('EXEC usp_rebuild_indexes').kind, 'unknown');
});
