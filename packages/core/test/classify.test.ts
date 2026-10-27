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

test('applies limits only to unbounded reads', () => {
  assert.equal(applyLimit('SELECT * FROM t', 50), 'SELECT * FROM t LIMIT 50');
  assert.equal(applyLimit('SELECT * FROM t LIMIT 5', 50), 'SELECT * FROM t LIMIT 5');
  assert.equal(applyLimit('UPDATE t SET a=1 WHERE id=1', 50), 'UPDATE t SET a=1 WHERE id=1');
  assert.equal(applyLimit('SELECT 1; SELECT 2', 50), 'SELECT 1; SELECT 2');
  assert.equal(applyLimit('EXPLAIN SELECT * FROM t', 50), 'EXPLAIN SELECT * FROM t');
});
