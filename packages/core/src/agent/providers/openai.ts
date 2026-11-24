import type { LlmProvider, ProviderEvent, ProviderMessage, ProviderRequest, ToolCall } from '../types';
import { isPrivateEndpoint, joinUrl, mapHttpError, normalizeCacheUsage, parseToolArguments, ProviderError, providerStreamError, readResponseText, readSse, resolveStallMs, watchRequestStall } from './common';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './profile';

/** 从 OpenAI 兼容响应的 usage 里取缓存命中量；各家字段位置不同，这里统一认。 */
function readCacheUsage(usage: any): { hit?: number; miss?: number } {
  if (!usage || typeof usage !== 'object') return {};
  const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  // DeepSeek 系：命中与未命中都直接给在 usage 上
  const deepHit = num(usage.prompt_cache_hit_tokens);
  const deepMiss = num(usage.prompt_cache_miss_tokens);
  if (deepHit !== undefined || deepMiss !== undefined) return { hit: deepHit, miss: deepMiss };
  // OpenAI / Moonshot / 硅基流动等：可能只给命中量，也可能挂一层 prompt_tokens_details
  const cached = num(usage.prompt_tokens_details?.cached_tokens) ?? num(usage.cached_tokens);
  if (cached !== undefined) return { hit: cached };
  return {};
}

export interface OpenAIConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  /** 展示名（来自服务商预设）。 */
  label?: string;
  /** 流式停摆阈值（毫秒）；0 关闭。本地推理（Ollama 等）首 token 前可能静默很久，须传 0。 */
  stallMs?: number;
  /**
   * 绝对截止时间（毫秒），覆盖请求 + 整个流式读取；0 关闭。
   * 只给关闭了停摆判定的本地端点用：stallMs:0 时引擎挂死没有任何防线，必须有兜底上限。
   */
  deadlineMs?: number;
}

type OpenAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function userContent(msg: Extract<ProviderMessage, { role: 'user' }>): string | OpenAIContentPart[] {
  if (!msg.images?.length) return msg.content;
  const parts: OpenAIContentPart[] = [];
  if (msg.content) parts.push({ type: 'text', text: msg.content });
  for (const image of msg.images) parts.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
  return parts;
}

export function toOpenAIMessages(system: string, messages: ProviderMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }];
  for (const msg of messages) {
    if (msg.role === 'user') out.push({ role: 'user', content: userContent(msg) });
    else if (msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: msg.content || null,
        ...(msg.toolCalls?.length
          ? {
              tool_calls: msg.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
    }
  }
  return out;
}

export class OpenAIProvider implements LlmProvider {
  id = 'openai';
  label: string;
  constructor(private cfg: OpenAIConfig) {
    this.label = cfg.label?.trim() || 'OpenAI Compatible';
  }

  private authHeaders(): Record<string, string> {
    const key = (this.cfg.apiKey ?? '').trim();
    return key ? { 'content-type': 'application/json', authorization: `Bearer ${key}` } : { 'content-type': 'application/json' };
  }

  async *stream(req: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (!(this.cfg.apiKey ?? '').trim() && !isPrivateEndpoint(this.cfg.baseUrl)) {
      throw new ProviderError('缺少 API Key', { code: 'NO_API_KEY' });
    }
    const stallMs = resolveStallMs(this.cfg.stallMs);
    // 只看响应头阶段的静默；拿到头之后交给 readSse 逐块判定。
    // 本地端点（stallMs:0）另加连接阶段超时与绝对截止，见 watchRequestStall。
    const requestWatch = watchRequestStall(signal, stallMs, this.cfg.deadlineMs !== undefined ? { deadlineMs: this.cfg.deadlineMs } : undefined);
    try {
      const res = await fetch(joinUrl(this.cfg.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          model: this.cfg.model,
          messages: toOpenAIMessages(req.system, req.messages),
          temperature: req.temperature ?? 0.2,
          // 兜底值 = 设置页写着的那个默认档位，不再另有一个界面上看不见的 4096。
          max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(req.reasoning?.value ? { reasoning_effort: req.reasoning.value } : {}),
          ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto' } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: requestWatch.signal,
      }).catch((err) => {
        // 停摆/截止阈值是被 abort(reason) 触发的，err 只是 AbortError，真因在 signal.reason 上
        const reason = requestWatch.signal?.reason;
        if (reason instanceof ProviderError) throw reason;
        if (err?.name === 'AbortError') throw err;
        throw new ProviderError(`无法连接模型接口：${err.message}`, { code: 'PROVIDER_NETWORK', retryable: true });
      });
      requestWatch.clear();
      if (!res.ok) {
        const body = res.body ? await readResponseText(res.body, { signal: requestWatch.signal, stallMs }) : '';
        throw mapHttpError(res.status, body, res.headers.get('retry-after'));
      }
      if (!res.body) throw providerStreamError('模型接口未返回流式响应');

      const calls = new Map<number, { id: string; name: string; args: string }>();
      let tokensIn = 0;
      let tokensOut = 0;
      let cacheHitTokens: number | undefined;
      let cacheMissTokens: number | undefined;
      let stopReason: string | undefined;
      let terminated = false;

      for await (const frame of readSse(res.body, { stallMs })) {
        if (!frame.data) continue;
        if (frame.data === '[DONE]') { terminated = true; break; }
        let evt: any;
        try {
          evt = JSON.parse(frame.data);
        } catch {
          throw providerStreamError('模型接口返回了无效的 SSE JSON');
        }
        if (!evt || typeof evt !== 'object' || Array.isArray(evt)) throw providerStreamError('模型接口返回了无效的 SSE 事件');
        if (evt.usage) {
          tokensIn = evt.usage.prompt_tokens ?? tokensIn;
          tokensOut = evt.usage.completion_tokens ?? tokensOut;
          const cache = readCacheUsage(evt.usage);
          if (cache.hit !== undefined) cacheHitTokens = cache.hit;
          if (cache.miss !== undefined) cacheMissTokens = cache.miss;
        }
        const choice = evt.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.content) yield { type: 'text', text: delta.content };
        if (delta.reasoning_content) yield { type: 'thinking', text: delta.reasoning_content };
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const idx = part.index ?? calls.size;
            const slot = calls.get(idx) ?? { id: '', name: '', args: '' };
            if (part.id) slot.id = part.id;
            if (part.function?.name) slot.name = part.function.name;
            if (part.function?.arguments) slot.args += part.function.arguments;
            calls.set(idx, slot);
          }
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }

      if (!terminated) throw providerStreamError('模型流意外 EOF，缺少 [DONE] 终止帧');

      for (const slot of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
        if (!slot.name) throw providerStreamError('模型返回的工具调用缺少函数名');
        const call: ToolCall = {
          id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: slot.name,
          args: parseToolArguments(slot.args, 'OpenAI 兼容接口', slot.name),
        };
        yield { type: 'tool_call', call };
      }
      yield { type: 'usage', tokensIn, tokensOut, ...normalizeCacheUsage(tokensIn, cacheHitTokens, cacheMissTokens) };
      yield { type: 'done', stopReason: stopReason ?? (calls.size ? 'tool_calls' : 'stop') };
    } catch (err) {
      // 绝对截止在 body 读取期间触发时，readSse 抛出的只是 AbortError，真因同样在 signal.reason
      const reason = requestWatch.signal?.reason;
      if (reason instanceof ProviderError) throw reason;
      throw err;
    } finally {
      requestWatch.dispose();
    }
  }
}
