import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCypher,
  classifyMql,
  classifyRedis,
  cypherQueryFromArgs,
  formatStructuredQuery,
  mqlQueryFromArgs,
  parseRedisCommandLine,
  readonlyViolationForQuery,
} from '../src/query';

test('MQL classification allows reads and rejects server-side scripts', () => {
  assert.equal(classifyMql({ language: 'mql', collection: 'users', op: 'find', filter: { status: 'active' } }).kind, 'read');
  assert.equal(classifyMql({ language: 'mql', collection: 'users', op: 'count' }).kind, 'read');
  assert.equal(
    classifyMql({ language: 'mql', collection: 'orders', op: 'aggregate', pipeline: [{ $match: {} }, { $group: { _id: '$status', n: { $sum: 1 } } }] }).kind,
    'read',
  );

  const scripted = classifyMql({ language: 'mql', collection: 'users', op: 'find', filter: { $where: 'this.age > 18' } });
  assert.equal(scripted.kind, 'destructive');
  assert.match(scripted.reason ?? '', /脚本/);

  const out = classifyMql({ language: 'mql', collection: 'orders', op: 'aggregate', pipeline: [{ $match: {} }, { $out: 'archive' }] });
  assert.equal(out.kind, 'destructive');
  assert.match(out.reason ?? '', /写入/);

  const nested = classifyMql({
    language: 'mql',
    collection: 'orders',
    op: 'aggregate',
    pipeline: [{ $lookup: { from: 'users', pipeline: [{ $merge: { into: 'x' } }], as: 'u' } }],
  });
  assert.equal(nested.kind, 'destructive');

  assert.equal(classifyMql({ language: 'mql', collection: 'users', op: 'distinct' }).kind, 'destructive');
  assert.equal(readonlyViolationForQuery({ language: 'mql', collection: 'users', op: 'find' }), null);
  assert.match(String(readonlyViolationForQuery({ language: 'mql', collection: 'users', op: 'aggregate', pipeline: [{ $out: 'x' }] })), /只读/);
});

test('MQL arguments normalize to structured queries', () => {
  assert.equal(mqlQueryFromArgs({ collection: 'users', filter: { a: 1 } }).op, 'find');
  assert.equal(mqlQueryFromArgs({ collection: 'users', pipeline: [{ $match: {} }] }).op, 'aggregate');
  assert.equal(mqlQueryFromArgs({ collection: 'users', field: 'status' }).op, 'distinct');
  const query = mqlQueryFromArgs({ collection: 'users', op: 'find', filter: { a: 1 }, limit: 5, skip: 2, sort: { a: -1 } });
  assert.equal(query.limit, 5);
  assert.equal(query.skip, 2);
  assert.deepEqual(query.sort, { a: -1 });
  assert.equal(formatStructuredQuery(query), JSON.stringify(query));
});

test('Redis classification separates reads, writes and destructive commands', () => {
  assert.equal(classifyRedis({ language: 'redis', command: 'GET', args: ['k'] }).kind, 'read');
  assert.equal(classifyRedis({ language: 'redis', command: 'scan', args: ['0'] }).kind, 'read');
  assert.equal(classifyRedis({ language: 'redis', command: 'SET', args: ['k', 'v'] }).kind, 'write');
  assert.equal(classifyRedis({ language: 'redis', command: 'HSET', args: ['h', 'f', 'v'] }).kind, 'write');
  assert.equal(classifyRedis({ language: 'redis', command: 'CONFIG', args: ['GET', 'maxmemory'] }).kind, 'read');
  assert.equal(classifyRedis({ language: 'redis', command: 'CONFIG', args: ['SET', 'maxmemory', '1gb'] }).kind, 'destructive');
  assert.equal(classifyRedis({ language: 'redis', command: 'FLUSHALL' }).kind, 'destructive');
  assert.equal(classifyRedis({ language: 'redis', command: 'EVAL', args: ['return 1', '0'] }).kind, 'destructive');
  assert.equal(classifyRedis({ language: 'redis', command: 'MODULE', args: ['LIST'] }).kind, 'destructive');
  assert.equal(classifyRedis({ language: 'redis', command: 'SOME_NEW_COMMAND' }).kind, 'write');
  assert.equal(readonlyViolationForQuery({ language: 'redis', command: 'GET', args: ['k'] }), null);
  assert.match(String(readonlyViolationForQuery({ language: 'redis', command: 'SET', args: ['k', 'v'] })), /只读/);
});

test('Redis command line parsing keeps quoted arguments together', () => {
  assert.deepEqual(parseRedisCommandLine('SET "hello world" 1'), { language: 'redis', command: 'SET', args: ['hello world', '1'] });
  assert.deepEqual(parseRedisCommandLine("HGETALL 'user:1'"), { language: 'redis', command: 'HGETALL', args: ['user:1'] });
  assert.equal(parseRedisCommandLine('   '), null);
});

test('Cypher classification distinguishes reads, writes, DDL and destructive clauses', () => {
  assert.equal(classifyCypher({ language: 'cypher', text: 'MATCH (n:Person) RETURN n LIMIT 10' }).kind, 'read');
  assert.equal(classifyCypher({ language: 'cypher', text: 'MATCH (n) WHERE n.name = "CREATE" RETURN n' }).kind, 'read');
  assert.equal(classifyCypher({ language: 'cypher', text: 'CREATE (n:Person {name: $name})', params: { name: 'Ada' } }).kind, 'write');
  assert.equal(classifyCypher({ language: 'cypher', text: 'MATCH (n:Person {name: $name}) SET n.age = 37', params: { name: 'Ada' } }).kind, 'write');
  assert.equal(classifyCypher({ language: 'cypher', text: 'MATCH (n) DETACH DELETE n' }).kind, 'destructive');
  assert.equal(classifyCypher({ language: 'cypher', text: 'CREATE INDEX FOR (n:Person) ON (n.name)' }).kind, 'ddl');
  assert.equal(classifyCypher({ language: 'cypher', text: 'CALL apoc.create.node([\'Person\'], {name: \'Ada\'})' }).kind, 'write');
  assert.equal(classifyCypher({ language: 'cypher', text: 'CALL db.labels() YIELD label RETURN label' }).kind, 'read');
  assert.equal(classifyCypher({ language: 'cypher', text: 'EXPLAIN MATCH (n) RETURN n' }).kind, 'read');
  assert.equal(classifyCypher({ language: 'cypher', text: 'PROFILE CREATE (n:Person)' }).kind, 'write');
  assert.equal(readonlyViolationForQuery({ language: 'cypher', text: 'MATCH (n) RETURN n' }), null);
  assert.match(String(readonlyViolationForQuery({ language: 'cypher', text: 'MATCH (n) DELETE n' })), /只读/);
  assert.deepEqual(cypherQueryFromArgs({ query: 'RETURN 1', params: { x: 1 } }), { language: 'cypher', text: 'RETURN 1', params: { x: 1 } });
});
