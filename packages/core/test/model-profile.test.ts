import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type AgentSettings, type ModelProfile } from '../src/types';
import {
  activeReasoningTier,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
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

test('the context window scales the history budget by the compaction percent', () => {
  // 没填档案 = 默认档位 256K/32K，与「档案里写 256K/32K」必须算出同一个预算，
  // 否则设置页上那个数字只是装饰。
  const byDefault = historyTokenBudget(agent({ compactionThreshold: 70 }));
  const byProfile = historyTokenBudget(
    agent({ compactionThreshold: 70, modelProfiles: { m: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS } } }),
  );
  assert.equal(byDefault, byProfile, '默认档位与手填同一档位必须等价');
  assert.ok(byDefault > 48000, `256K 窗口的预算不该停在旧的小窗口兜底上：${byDefault}`);
  // 128K 窗口：预算按窗口宽计算，~70% 但不超过窗口余量
  const small = agent({ compactionThreshold: 70, modelProfiles: { m: { contextWindow: 16384, maxOutputTokens: 4000 } } });
  const smallBudget = historyTokenBudget(small);
  assert.ok(smallBudget >= 4000, '兜底不小于最低历史预算');
  assert.ok(smallBudget <= 16384 - 4000, '预算不超过窗口余量');
  // 大窗口 1M：同样的 70% 设置预算随窗口放大
  const huge = agent({ compactionThreshold: 70, modelProfiles: { m: { contextWindow: 1048576, maxOutputTokens: 4096 } } });
  const hugeBudget = historyTokenBudget(huge);
  assert.ok(hugeBudget > smallBudget, '大窗口的预算应显著大于小窗口');
  // 百分比越小预算越小
  const lower = agent({ compactionThreshold: 30, modelProfiles: { m: { contextWindow: 1048576, maxOutputTokens: 4096 } } });
  assert.ok(historyTokenBudget(lower) < historyTokenBudget(huge), '更低的百分比应压缩得更狠');
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
  // 没填档案时下发默认档位，而不是另一个界面上看不见的数
  assert.equal(bare.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
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
  assert.equal(plain.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(plain.temperature, 0.3);
});

test('image input is gated by the model profile', () => {
  assert.equal(supportsInput(undefined, 'image'), false);
  assert.equal(supportsInput({ inputs: ['text'] }, 'image'), false);
  assert.equal(supportsInput({ inputs: ['text', 'image'] }, 'image'), true);
});

test('单条工具结果的字符预算随上下文窗口与已用量变化', async () => {
  const { modelResultCharBudget } = await import('../src/agent/providers/profile');
  // 没填档案 = 默认档位 256K/32K，与声明了同一档位的档案算出同一个预算。
  // 旧的 16000 固定值消失：那是「界面上写 256K、实际按 16K 截」的分裂来源。
  assert.equal(modelResultCharBudget({}), modelResultCharBudget({ contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS }));
  assert.equal(modelResultCharBudget({ contextWindow: 0 }), modelResultCharBudget({}), '0 视同没填');
  assert.ok(modelResultCharBudget({}) > 16000, '默认档位下不该还停在旧的小窗口固定值');

  const small = modelResultCharBudget({ contextWindow: 8_192, maxOutputTokens: 4_096 });
  const big = modelResultCharBudget({ contextWindow: 1_000_000, maxOutputTokens: 8_192 });
  assert.ok(big > small * 5, `1M 窗口应远大于 8K 窗口：${small} → ${big}`);
  assert.ok(small >= 6_000, '再小的窗口也要给够一次像样的取样');
  assert.ok(big <= 200_000, '单条结果要有绝对上限，否则序列化本身拖慢回合');

  // 已用越多预算越小，触底后停在地板而不是变成 0 或负数
  const fresh = modelResultCharBudget({ contextWindow: 200_000, maxOutputTokens: 8_192 });
  const used = modelResultCharBudget({ contextWindow: 200_000, maxOutputTokens: 8_192, usedTokens: 150_000 });
  const exhausted = modelResultCharBudget({ contextWindow: 200_000, maxOutputTokens: 8_192, usedTokens: 400_000 });
  assert.ok(fresh > used, '上下文吃紧时要收窄');
  assert.equal(exhausted, 6_000, '窗口顶穿也不能给 0');
  assert.equal(modelResultCharBudget({ contextWindow: 200_000, maxOutputTokens: 8_192, usedTokens: Number.NaN }), fresh, 'NaN 已用量要当 0 处理');
});

/**
 * 「没填」与「填了默认值」必须处处等价——这正是 placeholder 文案变成真实默认档位的
 * 全部意义：界面上写出来的数就是参与计算的数。这条把每个预算函数的等价性一次钉死，
 * 以后任何一处偷偷给「没填」另开一条兜底分支，这里就会红。
 */
test('没填模型档案时，各处预算都按设置页写着的默认档位算', async () => {
  const core = await import('../src/agent/providers/profile');
  const filled = { contextWindow: core.DEFAULT_CONTEXT_WINDOW, maxOutputTokens: core.DEFAULT_MAX_OUTPUT_TOKENS };
  const settings = { ...DEFAULT_SETTINGS.agent, provider: 'openai', model: 'm' } as AgentSettings;

  assert.equal(core.contextWindowOf(undefined), core.DEFAULT_CONTEXT_WINDOW);
  assert.equal(core.contextWindowOf({ contextWindow: 0 }), core.DEFAULT_CONTEXT_WINDOW);
  assert.equal(core.contextWindowOf({ contextWindow: 32_000 }), 32_000, '填了就用自己的');
  assert.equal(core.maxOutputTokensOf(settings), core.DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(core.maxOutputTokensOf(settings, { maxOutputTokens: 8192 }), 8192);

  assert.equal(core.midContextTokenBudget(undefined), core.midContextTokenBudget(core.DEFAULT_CONTEXT_WINDOW, core.DEFAULT_MAX_OUTPUT_TOKENS));
  assert.ok(core.midContextTokenBudget(undefined) > 0, '没填档案时中途压缩也开着——以前这里返回 0，长回合唯一的自保机制恰好失效');
  assert.equal(core.schemaTokenBudget({}), core.schemaTokenBudget(filled));
  assert.ok(core.schemaTokenBudget({}) > 0, 'schema 段不再有「0 = 不设限」这一档');
  assert.equal(core.historyTokenBudget(settings), core.historyTokenBudget({ ...settings, modelProfiles: { m: filled } }));
  assert.equal(core.modelResultCharBudget({}), core.modelResultCharBudget(filled));

  // 默认档位必须和设置页输入框显示的字串对得上（预填值由这两个常数算出）
  assert.equal(core.formatTokenSize(core.DEFAULT_CONTEXT_WINDOW), '256K');
  assert.equal(core.formatTokenSize(core.DEFAULT_MAX_OUTPUT_TOKENS), '32K');
  assert.equal(core.parseTokenSize('256K'), core.DEFAULT_CONTEXT_WINDOW);
  assert.equal(core.parseTokenSize('32K'), core.DEFAULT_MAX_OUTPUT_TOKENS);
});

/**
 * 默认输出上限提到 32K 之后，小端点可能直接把请求拒了。这类报错必须指到能改的地方，
 * 否则用户只会看到一句服务商原文。
 */
test('端点嫌 max_tokens 太大时，错误里说去哪儿调小', async () => {
  const { mapHttpError } = await import('../src/agent/providers/common');
  const rejected = mapHttpError(400, JSON.stringify({ error: { message: 'max_tokens is too large: 32768' } }));
  assert.match(rejected.message, /最大输出 token 数/);
  assert.match(rejected.message, /32K/, '提示里写的数必须就是实际下发的默认值');
  const unrelated = mapHttpError(400, JSON.stringify({ error: { message: 'unknown parameter: reasoning_effort' } }));
  assert.ok(!unrelated.message.includes('最大输出'), '正常报错不掺话');
});
