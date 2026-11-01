import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, toAnthropicMessages } from '../src/agent/providers/anthropic';
import { OpenAIProvider, toOpenAIMessages } from '../src/agent/providers/openai';
import type { ProviderEvent, ProviderMessage } from '../src/agent/types';

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

test('anthropic message conversion merges tool results', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 'a', name: 'inspect_schema', args: { connectionId: 'c1' } }] },
    { role: 'tool', toolCallId: 'a', name: 'inspect_schema', content: '{"ok":true}' },
  ];
  const converted = toAnthropicMessages(messages);
  assert.equal(converted.length, 3);
  const assistant = converted[1].content as Array<Record<string, unknown>>;
  assert.equal(assistant.some((block) => block.type === 'tool_use'), true);
  const toolResult = converted[2].content as Array<Record<string, unknown>>;
  assert.equal(toolResult[0].type, 'tool_result');
  assert.equal(toolResult[0].tool_use_id, 'a');
});

test('openai message conversion maps tool calls and results', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run_sql', args: { sql: 'SELECT 1' } }] },
    { role: 'tool', toolCallId: 'a', name: 'run_sql', content: 'ok' },
  ];
  const converted = toOpenAIMessages('system', messages);
  assert.equal(converted[0].role, 'system');
  assert.equal(converted[2].role, 'assistant');
  assert.equal(converted[2].tool_calls?.[0].function.name, 'run_sql');
  assert.equal(converted[3].role, 'tool');
  assert.equal(converted[3].tool_call_id, 'a');
});

test('anthropic provider streams text, tool calls and usage', async () => {
  const originalFetch = globalThis.fetch;
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"list_connections","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"include\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"true}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  globalThis.fetch = (async () => sseResponse(frames)) as typeof fetch;
  try {
    const provider = new AnthropicProvider({ apiKey: 'test', baseUrl: 'http://mock', model: 'claude-test' });
    const events = await collect(provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }));
    const text = events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('');
    assert.equal(text, 'Hello');
    const tool = events.find((e) => e.type === 'tool_call');
    assert.ok(tool && tool.type === 'tool_call');
    if (tool?.type === 'tool_call') {
      assert.equal(tool.call.name, 'list_connections');
      assert.deepEqual(tool.call.args, { include: true });
    }
    const usage = events.find((e) => e.type === 'usage');
    assert.ok(usage && usage.type === 'usage' && usage.tokensIn === 11 && usage.tokensOut === 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai compatible provider streams text, tool calls and usage', async () => {
  const originalFetch = globalThis.fetch;
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"list_connections","arguments":"{\\"x\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  globalThis.fetch = (async () => sseResponse(frames)) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: 'test', baseUrl: 'http://mock/v1', model: 'gpt-test' });
    const events = await collect(provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }));
    const text = events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('');
    assert.equal(text, 'Hi');
    const tool = events.find((e) => e.type === 'tool_call');
    assert.ok(tool && tool.type === 'tool_call');
    if (tool?.type === 'tool_call') {
      assert.equal(tool.call.name, 'list_connections');
      assert.deepEqual(tool.call.args, { x: 1 });
    }
    const usage = events.find((e) => e.type === 'usage');
    assert.ok(usage && usage.type === 'usage' && usage.tokensIn === 5 && usage.tokensOut === 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------- 服务商预设与模型列表 ----------
import { PROVIDER_PRESETS, matchPreset, ollamaOrigin, presetById } from '../src/agent/providers/presets';
import { listProviderModels } from '../src/agent/providers/models';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('provider presets are unique and well formed', () => {
  const ids = PROVIDER_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(['local', 'anthropic', 'openai', 'ollama'].includes(preset.kind), preset.id);
    assert.ok(preset.label.length > 0);
    assert.ok(preset.defaultModel.length > 0 || preset.id === 'custom', preset.id);
    if (preset.kind !== 'local' && preset.id !== 'custom') {
      assert.ok(/^https?:\/\//.test(preset.baseUrl), `${preset.id} baseUrl`);
    }
    for (const model of preset.models) assert.ok(typeof model === 'string' && model.length > 0, `${preset.id} model entry`);
    if (preset.defaultModel) assert.ok(preset.models.includes(preset.defaultModel), `${preset.id} default model missing from list`);
  }
  assert.ok(presetById('ollama')?.kind === 'ollama');
  assert.equal(matchPreset('openai', 'https://api.deepseek.com/v1/')?.id, 'deepseek');
  assert.equal(ollamaOrigin('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
});

test('model listing reads OpenAI compatible /models with the bearer key', async () => {
  const calls: Array<{ url: string; headers: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init?.headers });
    return jsonResponse({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }] });
  }) as unknown as typeof fetch;
  const result = await listProviderModels({ kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test' }, { fetchImpl });
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/models');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
  assert.deepEqual(result.models, ['a-model', 'b-model']);
});

test('ollama listing prefers native /api/tags and falls back to /v1/models', async () => {
  const seen: string[] = [];
  const tagsFirst = (async (url: string) => {
    seen.push(url);
    return jsonResponse({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen3:8b' }] });
  }) as unknown as typeof fetch;
  const first = await listProviderModels({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, { fetchImpl: tagsFirst });
  assert.deepEqual(seen, ['http://127.0.0.1:11434/api/tags']);
  assert.deepEqual(first.models, ['llama3.1:8b', 'qwen3:8b']);

  const fallback = (async (url: string) => {
    if (url.endsWith('/api/tags')) throw new TypeError('fetch failed');
    return jsonResponse({ data: [{ id: 'glm-4.5' }] });
  }) as unknown as typeof fetch;
  const second = await listProviderModels({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, { fetchImpl: fallback });
  assert.deepEqual(second.models, ['glm-4.5']);
  assert.equal(second.endpoint, 'http://127.0.0.1:11434/v1/models');
});

test('anthropic listing uses x-api-key and rejects missing credentials', async () => {
  let captured: any;
  const fetchImpl = (async (url: string, init: any) => {
    captured = { url, headers: init?.headers };
    return jsonResponse({ data: [{ id: 'claude-sonnet-4-20250514' }] });
  }) as unknown as typeof fetch;
  const result = await listProviderModels({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant' }, { fetchImpl });
  assert.equal(captured.url, 'https://api.anthropic.com/v1/models');
  assert.equal(captured.headers['x-api-key'], 'sk-ant');
  assert.deepEqual(result.models, ['claude-sonnet-4-20250514']);
  await assert.rejects(() => listProviderModels({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }, { fetchImpl }), /需要 API Key/);
});

test('model listing validates the endpoint and the local provider', async () => {
  await assert.rejects(() => listProviderModels({ kind: 'openai', baseUrl: 'ftp://x/models' }), /合法的 http\/https/);
  await assert.rejects(() => listProviderModels({ kind: 'openai', baseUrl: '' }), /合法的 http\/https/);
  await assert.rejects(() => listProviderModels({ kind: 'local', baseUrl: '' }), /内置离线推理/);
  const notFound = (async () => jsonResponse({ error: { message: 'no route' } }, 404)) as unknown as typeof fetch;
  await assert.rejects(() => listProviderModels({ kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' }, { fetchImpl: notFound }), /返回 404/);
});

test('openai provider allows keyless local endpoints but not public ones', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
  try {
    const local = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' });
    await collect(local.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })).catch(() => undefined);
    const publicProvider = new OpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    await assert.rejects(() => collect(publicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })), /缺少 API Key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------- 提示词缓存用量：三家服务商的字段都要归一化 ----------
import { normalizeCacheUsage } from '../src/agent/providers/common';

test('cache usage normalization covers every provider shape', () => {
  // DeepSeek：命中与未命中都直接给，原样透出
  assert.deepEqual(normalizeCacheUsage(100, 90, 10), { cacheHitTokens: 90, cacheMissTokens: 10 });
  // OpenAI 系：只给命中量，未命中由输入总量减出来
  assert.deepEqual(normalizeCacheUsage(100, 60), { cacheHitTokens: 60, cacheMissTokens: 40 });
  // Anthropic 系：只给未命中量时反向补出命中
  assert.deepEqual(normalizeCacheUsage(100, undefined, 30), { cacheHitTokens: 70, cacheMissTokens: 30 });
  // 都没有就是空对象——调用方据此隐藏指标，而不是报 0%
  assert.deepEqual(normalizeCacheUsage(100), {});
  assert.deepEqual(normalizeCacheUsage(100, undefined, undefined), {});
  // 负数与非数字按缺省处理，不能让脏数据污染比率
  assert.deepEqual(normalizeCacheUsage(100, -5, Number.NaN), {});
});

async function usageOf(provider: { stream: (req: any) => AsyncIterable<ProviderEvent> }): Promise<Extract<ProviderEvent, { type: 'usage' }>> {
  const events = await collect(provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }) as AsyncIterable<ProviderEvent>);
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  return usage as Extract<ProviderEvent, { type: 'usage' }>;
}

test('openai provider reports DeepSeek cache fields', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse(
      [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_cache_hit_tokens":90,"prompt_cache_miss_tokens":10}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    )) as typeof fetch;
  try {
    const usage = await usageOf(new OpenAIProvider({ apiKey: 'k', baseUrl: 'http://mock/v1', model: 'deepseek-chat' }));
    assert.equal(usage.tokensIn, 100);
    assert.equal(usage.cacheHitTokens, 90);
    assert.equal(usage.cacheMissTokens, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai provider reads nested prompt_tokens_details.cached_tokens', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse(
      [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":150}}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    )) as typeof fetch;
  try {
    const usage = await usageOf(new OpenAIProvider({ apiKey: 'k', baseUrl: 'http://mock/v1', model: 'gpt-4o-mini' }));
    assert.equal(usage.cacheHitTokens, 150);
    assert.equal(usage.cacheMissTokens, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai provider omits cache fields when the provider reports none', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse(
      [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    )) as typeof fetch;
  try {
    const usage = await usageOf(new OpenAIProvider({ apiKey: 'k', baseUrl: 'http://mock/v1', model: 'plain' }));
    assert.equal(usage.cacheHitTokens, undefined);
    assert.equal(usage.cacheMissTokens, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anthropic provider counts cache read/write into input tokens', async () => {
  const originalFetch = globalThis.fetch;
  const frames = [
    // 真实输入 = input_tokens(10) + cache_read(80) + cache_creation(10)
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":80,"cache_creation_input_tokens":10}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hi"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  globalThis.fetch = (async () => sseResponse(frames)) as typeof fetch;
  try {
    const usage = await usageOf(new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://mock', model: 'claude-test' }));
    assert.equal(usage.tokensIn, 100, '缓存读写必须计入输入总量');
    assert.equal(usage.tokensOut, 4);
    assert.equal(usage.cacheHitTokens, 80);
    assert.equal(usage.cacheMissTokens, 20, '未命中 = 原始输入 + 缓存写入');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anthropic provider omits cache fields without cache usage', async () => {
  const originalFetch = globalThis.fetch;
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  ].join('');
  globalThis.fetch = (async () => sseResponse(frames)) as typeof fetch;
  try {
    const usage = await usageOf(new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://mock', model: 'claude-test' }));
    assert.equal(usage.tokensIn, 11);
    assert.equal(usage.cacheHitTokens, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
