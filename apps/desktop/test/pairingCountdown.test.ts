import test from 'node:test';
import assert from 'node:assert/strict';
import { secondsLeft } from '../src/lib/pairingCountdown.ts';

test('secondsLeft counts down from expiresIn to zero', () => {
  const createdAt = 1_000_000;
  assert.equal(secondsLeft(createdAt, 60, createdAt), 60);
  assert.equal(secondsLeft(createdAt, 60, createdAt + 1_000), 59);
  assert.equal(secondsLeft(createdAt, 60, createdAt + 30_500), 30);
  assert.equal(secondsLeft(createdAt, 60, createdAt + 59_999), 1);
  assert.equal(secondsLeft(createdAt, 60, createdAt + 60_000), 0);
  assert.equal(secondsLeft(createdAt, 60, createdAt + 999_999), 0, '过期后不会变成负数');
});
