import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-model-boundary-'));
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'model-boundary-secret',
  token: 'model-token',
  staticDir: join(home, 'missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/api`;
const headers = { 'content-type': 'application/json', authorization: 'Bearer model-token' };
const received: Array<{ path: string; key?: string }> = [];
const mock = createServer((req, res) => {
  received.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
  res.setHeader('content-type', 'application/json');
  if (req.url?.startsWith('/redirect/v1/models')) {
    res.writeHead(302, { location: 'https://attacker.example/v1/models' });
    res.end();
    return;
  }
  res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
});
await listenRandom(mock);
const mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api(path: string, body: unknown, method = 'POST') {
  const response = await fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test('stored model keys cannot be reused at another origin or provider', async () => {
  const saved = await api('/settings', { agent: {
    modelConfigs: [{ id: 'bound', provider: 'anthropic', baseUrl: mockBase, models: [{ id: 'mock-model' }] }],
    activeModelId: 'bound', model: 'mock-model', modelKeys: { bound: 'stored-anthropic-key' },
  } }, 'PUT');
  assert.equal(saved.status, 200);
  const crossOrigin = await api('/agent/models', { kind: 'anthropic', modelConfigId: 'bound', baseUrl: 'https://other.example' });
  assert.equal(crossOrigin.status, 400);
  assert.equal(crossOrigin.body.error.code, 'MODEL_KEY_ORIGIN_MISMATCH');
  const crossProvider = await api('/agent/models', { kind: 'openai', modelConfigId: 'bound', baseUrl: mockBase });
  assert.equal(crossProvider.status, 400);
  assert.equal(crossProvider.body.error.code, 'MODEL_KEY_PROVIDER_MISMATCH');
  assert.deepEqual(received, []);
});

test('matching configured origin may reuse its key and model redirects cannot cross origin', async () => {
  const matching = await api('/agent/models', { kind: 'anthropic', modelConfigId: 'bound' });
  assert.equal(matching.status, 200);
  assert.deepEqual(matching.body.models, ['mock-model']);
  assert.equal(received.at(-1)?.key, 'stored-anthropic-key');

  const saved = await api('/settings', { agent: {
    modelConfigs: [{ id: 'redirect', provider: 'openai', baseUrl: `${mockBase}/redirect/v1`, models: [{ id: 'mock-model' }] }],
    activeModelId: 'redirect', model: 'mock-model', modelKeys: { redirect: 'stored-openai-key' },
  } }, 'PUT');
  assert.equal(saved.status, 200);
  const redirected = await api('/agent/models', { kind: 'openai', modelConfigId: 'redirect' });
  assert.equal(redirected.status, 400);
  assert.equal(redirected.body.error.code, 'PROVIDER_REDIRECT_DENIED');
  assert.equal(received.filter((item) => item.path === '/redirect/v1/models').length, 1);
  assert.equal(received.some((item) => item.path.includes('attacker.example')), false);
});
