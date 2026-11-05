import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPair, credentialsFromClaim } from '../bin/pair.mjs';

const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-pair-'));
test.after(() => rmSync(home, { recursive: true, force: true }));

function harness(claimBody, claimStatus = 200) {
  const answers = ['123456', 'http://127.0.0.1:8787'];
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    io: {
      ask: async () => answers.shift() ?? '',
      log: (text) => logs.push(text),
      writeCredentials: (c) => { writes.push(c); return join(home, 'credentials.json'); },
      fetch: async () => ({
        ok: claimStatus >= 200 && claimStatus < 300,
        status: claimStatus,
        json: async () => claimBody,
      }),
    },
  };
}

test('stores the URL the user entered, not the public bridge.url', async () => {
  const h = harness({
    token: 'T',
    device: { id: 'd1', name: 'Claude Code', scope: 'mcp:readonly' },
    bridge: { url: 'https://db.example.com', host: 'db.example.com', port: 443 },
  });
  const result = await runPair(h.io);
  assert.equal(result.ok, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].url, 'http://127.0.0.1:8787');
  assert.notEqual(h.writes[0].url, 'https://db.example.com');
});

test('rejects a claim response without a token and writes nothing', async () => {
  const h = harness({ device: { id: 'd1' }, bridge: { url: 'https://db.example.com' } });
  const result = await runPair(h.io);
  assert.equal(result.ok, false);
  assert.equal(h.writes.length, 0);
  assert.ok(h.logs.some((l) => /缺少设备令牌/.test(l)));
});

test('rejects an invalid pairing code', async () => {
  const h = harness({ token: 'T' });
  h.io.ask = async () => 'abc';
  const result = await runPair(h.io);
  assert.equal(result.ok, false);
  assert.equal(h.writes.length, 0);
  assert.ok(h.logs.some((l) => /6 位数字/.test(l)));
});

test('credentialsFromClaim keeps deviceId and token', () => {
  const c = credentialsFromClaim('http://local:8787', { token: 'TK', device: { id: 'D' }, bridge: { url: 'https://public' } });
  assert.equal(c.token, 'TK');
  assert.equal(c.deviceId, 'D');
  assert.equal(c.url, 'http://local:8787');
  assert.ok(c.pairedAt);
});
