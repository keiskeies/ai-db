import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlLiteral } from '../src/services';

test('SQL boolean literal follows the dialect, not just the engine id', () => {
  assert.equal(sqlLiteral(true, 'postgresql'), 'TRUE');
  assert.equal(sqlLiteral(false, 'cockroachdb'), 'FALSE');
  assert.equal(sqlLiteral(true, 'kingbase'), 'TRUE');
  assert.equal(sqlLiteral(false, 'opengauss'), 'FALSE');
  assert.equal(sqlLiteral(true, 'timescale'), 'TRUE');
  assert.equal(sqlLiteral(true, 'mysql'), '1');
  assert.equal(sqlLiteral(false, 'oracle'), '0');
});
