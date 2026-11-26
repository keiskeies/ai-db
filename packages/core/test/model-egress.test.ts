import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviderModels } from '../src/agent/providers/models';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

test('stored model keys are bound to provider and origin before any request', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return json({ data: [] }); }) as typeof fetch;
  await assert.rejects(
    listProviderModels({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'secret', keyProvider: 'openai' }, { fetchImpl }),
    (err: any) => err.code === 'MODEL_KEY_PROVIDER_MISMATCH',
  );
  await assert.rejects(
    listProviderModels({ kind: 'openai', baseUrl: 'https://other.example/v1', apiKey: 'secret', keyOrigin: 'https://trusted.example' }, { fetchImpl }),
    (err: any) => err.code === 'MODEL_KEY_ORIGIN_MISMATCH',
  );
  await assert.rejects(
    listProviderModels({ kind: 'anthropic', baseUrl: 'https://other.example', apiKey: 'anthropic-secret' }, { fetchImpl }),
    (err: any) => err.code === 'MODEL_KEY_ORIGIN_UNTRUSTED',
  );
  assert.equal(calls, 0);
});

test('Anthropic custom origin works only with an explicitly bound supplied key', async () => {
  let authorization: string | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get('x-api-key') ?? undefined;
    return json({ data: [{ id: 'claude-test' }] });
  }) as typeof fetch;
  const result = await listProviderModels({
    kind: 'anthropic',
    baseUrl: 'https://proxy.example',
    apiKey: 'new-key',
    keyOrigin: 'https://proxy.example',
    keyProvider: 'anthropic',
  }, { fetchImpl });
  assert.deepEqual(result.models, ['claude-test']);
  assert.equal(authorization, 'new-key');
});

test('model listing rejects cross-origin redirects without forwarding the key again', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return json({ data: [] }, 302, { location: 'https://attacker.example/v1/models' });
  }) as typeof fetch;
  await assert.rejects(
    listProviderModels({ kind: 'openai', baseUrl: 'https://trusted.example/v1', apiKey: 'stored-key', keyOrigin: 'https://trusted.example' }, { fetchImpl }),
    (err: any) => err.code === 'PROVIDER_REDIRECT_DENIED',
  );
  assert.deepEqual(urls, ['https://trusted.example/v1/models']);
});

test('same-origin model redirects are followed and oversized model responses are rejected', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return urls.length === 1
      ? json({}, 302, { location: '/v1/listed' })
      : json({ data: [{ id: 'model-a' }] });
  }) as typeof fetch;
  const result = await listProviderModels({ kind: 'openai', baseUrl: 'https://trusted.example/v1' }, { fetchImpl });
  assert.deepEqual(urls, ['https://trusted.example/v1/models', 'https://trusted.example/v1/listed']);
  assert.deepEqual(result.models, ['model-a']);

  const oversized = (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch;
  await assert.rejects(
    listProviderModels({ kind: 'openai', baseUrl: 'https://trusted.example/v1' }, { fetchImpl: oversized }),
    (err: any) => err.code === 'PROVIDER_BAD_PAYLOAD',
  );
});
