import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBotEvent } from '../src/bots';
import { Store } from '../src/store';

const home = mkdtempSync(join(tmpdir(), 'aidb-bot-boundary-'));
const store = new Store(join(home, 'aidb.db'), 'bot-boundary-master-secret');
const host = { startTurn: async () => { throw new Error('must not be called'); } } as any;

test.after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

function oneBotChannel() {
  return store.createNotificationChannel({
    name: 'OneBot boundary',
    type: 'qq-onebot',
    config: { endpoint: 'http://127.0.0.1:9999', token: 'bot-token', inbound: false, allowedChats: [] },
  });
}

function event(id: number, time = Math.floor(Date.now() / 1000)) {
  return { post_type: 'message', message_type: 'group', self_id: 1, group_id: 123, user_id: 9, message_id: id, time, raw_message: 'hello' };
}

test('bot callbacks require fresh event metadata and suppress replayed event IDs', async () => {
  const channel = oneBotChannel();
  const headers = { authorization: 'Bearer bot-token' };
  const replay = event(1001);
  const first = await handleBotEvent(store, host, channel.id, replay, headers);
  assert.equal(first.status, 403, 'inbound is disabled');
  const duplicate = await handleBotEvent(store, host, channel.id, replay, headers);
  assert.equal(duplicate.status, 200, 'replay must be acknowledged without executing again');
  assert.equal((await handleBotEvent(store, host, channel.id, event(1002, Math.floor(Date.now() / 1000) - 3600), headers)).status, 400);
  assert.equal((await handleBotEvent(store, host, channel.id, event(1003, Math.floor(Date.now() / 1000) + 3600), headers)).status, 400);
  const { message_id: _messageId, ...missingId } = event(1004);
  assert.equal((await handleBotEvent(store, host, channel.id, missingId, headers)).status, 400);
  assert.equal((await handleBotEvent(store, host, channel.id, event(1005), { authorization: 'Bearer wrong' })).status, 403);
});

test('bot callback rate limiting is process-wide and returns Retry-After', async () => {
  const channels = Array.from({ length: 4 }, () => oneBotChannel());
  let limited = 0;
  for (let index = 0; index < 64; index += 1) {
    const channel = channels[index % channels.length];
    const result = await handleBotEvent(store, host, channel.id, event(2000 + index), { authorization: 'Bearer invalid' });
    if (result.status === 429) {
      limited += 1;
      assert.ok(Number(result.headers?.['retry-after']) > 0);
    }
  }
  assert.ok(limited >= 4, `expected global 60/minute limit, got ${limited} limited responses`);
});
