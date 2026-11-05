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
  const requests = [];
  return {
    logs,
    writes,
    requests,
    io: {
      ask: async () => answers.shift() ?? '',
      log: (text) => logs.push(text),
      writeCredentials: (c) => { writes.push(c); return join(home, 'credentials.json'); },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: claimStatus >= 200 && claimStatus < 300,
          status: claimStatus,
          json: async () => claimBody,
        };
      },
    },
  };
}

test('posts to the isolated MCP claim endpoint without a caller-controlled scope', async () => {
  const h = harness({ token: 'T', device: { id: 'd1', name: 'Claude Code', scope: 'mcp:readonly' } });
  const result = await runPair(h.io);
  assert.equal(result.ok, true);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /\/api\/pair\/mcp\/claim$/);
  const body = JSON.parse(h.requests[0].init.body);
  assert.equal(body.scope, undefined, 'scope 由服务端硬编码，CLI 不应传');
  assert.equal(body.code, '123456');
});

test('posts a vendor-neutral device identity', async () => {
  const h = harness({ token: 'T', device: { id: 'd1', name: 'MCP Client', scope: 'mcp:readonly' } });
  await runPair(h.io);
  const body = JSON.parse(h.requests[0].init.body);
  assert.equal(body.deviceName, 'MCP Client');
  assert.equal(body.platform, 'mcp-client');
  assert.doesNotMatch(JSON.stringify(body), /Claude|claude/);
});


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
