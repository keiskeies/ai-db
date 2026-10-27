import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type AgentSettings, type ModelProfile } from '../src/types';
import {
  activeReasoningTier,
  formatTokenSize,
  historyTokenBudget,
  parseTokenSize,
  supportsInput,
  withModelProfile,
} from '../src/agent/providers/profile';
import { listProviderModels, profileFromModelInfo } from '../src/agent/providers/models';
import { AnthropicProvider } from '../src/agent/providers/anthropic';
import { OpenAIProvider } from '../src/agent/providers/openai';
import type { ProviderEvent } from '../src/agent/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(payload: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** 捕获 provider 发出的请求体。 */
async function captureBody(stream: AsyncIterable<ProviderEvent>): Promise<Record<string, any>> {
  let captured: Record<string, any> = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    captured = JSON.parse(init.body);
    return sseResponse('data: [DONE]\n\n');
  }) as unknown as typeof fetch;
  try {
    await collect(stream);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return captured;
}

const agent = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  ...DEFAULT_SETTINGS.agent,
  provider: 'openai',
  baseUrl: 'https://gate.example/v1',
  model: 'm',
  ...over,
});

test('token sizes round-trip through the 256K shorthand', () => {
  assert.equal(parseTokenSize('256K'), 262144);
  assert.equal(parseTokenSize('1m'), 1048576);
  assert.equal(parseTokenSize('32000'), 32000);
  assert.equal(parseTokenSize('1,048,576'), 1048576);
  assert.equal(parseTokenSize(8192), 8192);
  assert.equal(parseTokenSize(''), undefined);
  assert.equal(parseTokenSize('abc'), undefined);
  assert.equal(formatTokenSize(262144), '256K');
  assert.equal(formatTokenSize(1048576), '1M');
  assert.equal(formatTokenSize(1500), '1500');
  assert.equal(formatTokenSize(undefined), '');
});

test('a reasoning tier only reaches the provider when it maps to a value', () => {
  const profile: ModelProfile = { reasoning: true, reasoningTiers: [{ level: 'off', value: '' }, { level: 'high', value: 'high' }] };
  const base = agent({ modelProfiles: { m: profile } });
  assert.equal(activeReasoningTier(base), undefined);
  assert.equal(activeReasoningTier({ ...base, reasoningTier: 'off' }), undefined);
  assert.deepEqual(activeReasoningTier({ ...base, reasoningTier: 'high' }), { level: 'high', value: 'high' });
  assert.equal(activeReasoningTier({ ...base, reasoningTier: 'nope' }), undefined);
  // 档案没开推理开关时，即便残留了档位也不下发。
  assert.equal(activeReasoningTier(agent({ reasoningTier: 'high', modelProfiles: { m: { reasoningTiers: [{ level: 'high', value: 'high' }] } } })), undefined);
});

test('the context window tightens the history budget but never exceeds the threshold', () => {
  assert.equal(historyTokenBudget(agent({ compactionThreshold: 24000 })), 12000);
  const small = agent({ compactionThreshold: 24000, modelProfiles: { m: { contextWindow: 16000, maxOutputTokens: 4000 } } });
  assert.equal(historyTokenBudget(small), 4000);
  const huge = agent({ compactionThreshold: 24000, modelProfiles: { m: { contextWindow: 262144 } } });
  assert.equal(historyTokenBudget(huge), 12000);
});

test('model profiles are stored per model without clobbering the others', () => {
  const next = withModelProfile(withModelProfile(agent(), 'a', { contextWindow: 1000 }), 'b', { maxOutputTokens: 2000 });
  assert.deepEqual(next.modelProfiles, { a: { contextWindow: 1000 }, b: { maxOutputTokens: 2000 } });
});

test('model listing keeps capability metadata alongside the ids', async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      data: [
        {
          id: 'qwen-reason',
          capabilities: ['Reasoning', 'Vision'],
          reasoning: { budget_tokens: true, efforts: ['minimal', 'low', 'high'] },
          context_length: 131072,
          max_output_tokens: 8192,
          supported_parameters: ['tools'],
        },
        { id: 'plain', owned_by: 'x' },
      ],
    })) as unknown as typeof fetch;
  const result = await listProviderModels({ kind: 'openai', baseUrl: 'https://gate.example/v1', apiKey: 'k' }, { fetchImpl });
  assert.deepEqual(result.models, ['plain', 'qwen-reason']);

  const detected = result.infos.find((info) => info.id === 'qwen-reason');
  assert.equal(detected?.contextWindow, 131072);
  assert.equal(detected?.maxOutputTokens, 8192);
  assert.deepEqual(detected?.inputs, ['text', 'image']);
  assert.equal(detected?.reasoning, true);
  assert.deepEqual(detected?.reasoningEfforts, ['minimal', 'low', 'high']);
  assert.deepEqual(profileFromModelInfo(detected!)?.reasoningTiers, [
    { level: 'off', value: '' },
    { level: 'minimal', value: 'minimal' },
    { level: 'low', value: 'low' },
    { level: 'high', value: 'high' },
  ]);

  const plain = result.infos.find((info) => info.id === 'plain');
  assert.equal(profileFromModelInfo(plain!), undefined);
});

test('declared input modalities win over the capability text', async () => {
  const fetchImpl = (async () => jsonResponse({ data: [{ id: 'router-model', architecture: { input_modalities: ['text', 'image'] } }] })) as unknown as typeof fetch;
  const result = await listProviderModels({ kind: 'openai', baseUrl: 'https://gate.example/v1' }, { fetchImpl });
  assert.deepEqual(result.infos[0].inputs, ['text', 'image']);
});

test('openai compatible provider sends reasoning_effort, max_tokens and image parts', async () => {
  const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' });
  const withCaps = await captureBody(
    provider.stream({
      system: 's',
      messages: [{ role: 'user', content: '看图', images: [{ mime: 'image/png', base64: 'AAA=' }] }],
      tools: [],
      maxTokens: 32768,
      reasoning: { level: 'high', value: 'high' },
    }),
  );
  assert.equal(withCaps.max_tokens, 32768);
  assert.equal(withCaps.reasoning_effort, 'high');
  assert.equal(withCaps.messages[1].content[0].type, 'text');
  assert.equal(withCaps.messages[1].content[1].image_url.url, 'data:image/png;base64,AAA=');

  const bare = await captureBody(provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }));
  assert.equal('reasoning_effort' in bare, false);
  assert.equal(bare.max_tokens, 4096);
  assert.equal(typeof bare.messages[1].content, 'string');
});

test('anthropic provider sends a thinking budget and keeps max_tokens above it', async () => {
  const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://x', model: 'claude-test' });
  const thinking = await captureBody(
    provider.stream({
      system: 's',
      messages: [{ role: 'user', content: 'hi', images: [{ mime: 'image/webp', base64: 'BBB=' }] }],
      tools: [],
      maxTokens: 16000,
      reasoning: { level: 'high', value: '16384' },
    }),
  );
  assert.deepEqual(thinking.thinking, { type: 'enabled', budget_tokens: 16384 });
  assert.equal(thinking.max_tokens, 17408);
  assert.equal(thinking.temperature, 1);
  assert.equal(thinking.messages[0].content[0].type, 'image');
  assert.equal(thinking.messages[0].content[0].source.media_type, 'image/webp');

  const plain = await captureBody(provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], temperature: 0.3 }));
  assert.equal('thinking' in plain, false);
  assert.equal(plain.max_tokens, 4096);
  assert.equal(plain.temperature, 0.3);
});

test('image input is gated by the model profile', () => {
  assert.equal(supportsInput(undefined, 'image'), false);
  assert.equal(supportsInput({ inputs: ['text'] }, 'image'), false);
  assert.equal(supportsInput({ inputs: ['text', 'image'] }, 'image'), true);
});
