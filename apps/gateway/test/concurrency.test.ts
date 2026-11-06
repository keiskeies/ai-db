import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/drivers/concurrency';

test('mapLimit bounds in-flight work and keeps input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [8, 1, 4, 2, 7, 3, 6, 5];
  const out = await mapLimit(items, 3, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, value));
    inFlight -= 1;
    return value * 2;
  });
  assert.deepEqual(out, items.map((value) => value * 2));
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test('mapLimit survives an empty list', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
