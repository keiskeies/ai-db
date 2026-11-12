import type { LlmProvider, ProviderEvent, ProviderMessage, ProviderRequest, ToolCall } from '../types';
import { joinUrl, mapHttpError, normalizeCacheUsage, ProviderError, readSse, resolveStallMs, watchRequestStall } from './common';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './profile';

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  /** 流式停摆阈值（毫秒）；0 关闭。 */
  stallMs?: number;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export function toAnthropicMessages(messages: ProviderMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.images?.length) {
        const blocks: AnthropicBlock[] = msg.images.map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mime, data: image.base64 },
        }));
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        out.push({ role: 'user', content: blocks });
        continue;
      }
      const last = out[out.length - 1];
      if (last && last.role === 'user' && typeof last.content === 'string') {
        last.content = `${last.content}\n\n${msg.content}`;
      } else {
        out.push({ role: 'user', content: msg.content });
      }
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : msg.content });
      continue;
    }
    const block: AnthropicBlock = { type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content };
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
      last.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export class AnthropicProvider implements LlmProvider {
  id = 'anthropic';
  label = 'Anthropic';
  constructor(private cfg: AnthropicConfig) {}

  async *stream(req: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (!this.cfg.apiKey) throw new ProviderError('缺少 Anthropic API Key', { code: 'NO_API_KEY' });
    const budget = req.reasoning ? Number(req.reasoning.value) : NaN;
    const thinking = Number.isFinite(budget) && budget >= 1024 ? Math.floor(budget) : undefined;
    // 兜底值 = 设置页写着的那个默认档位，不再另有一个界面上看不见的 4096。
    const requested = req.maxTokens ?? this.cfg.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const stallMs = resolveStallMs(this.cfg.stallMs);
    // 只看响应头阶段的静默；拿到头之后交给 readSse 逐块判定
    const requestWatch = watchRequestStall(signal, stallMs);
    const res = await fetch(joinUrl(this.cfg.baseUrl, '/v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.cfg.model,
        // 开启 thinking 时 max_tokens 必须大于 budget_tokens，且不接受 temperature 调整。
        max_tokens: thinking ? Math.max(requested, thinking + 1024) : requested,
        temperature: thinking ? 1 : (req.temperature ?? 0.2),
        ...(thinking ? { thinking: { type: 'enabled', budget_tokens: thinking } } : {}),
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
        stream: true,
      }),
      signal: requestWatch.signal,
    }).catch((err) => {
      // 停摆阈值是被 abort(reason) 触发的，err 可能只是 AbortError，真因在 signal.reason 上
      const reason = requestWatch.signal?.reason;
      if (reason instanceof ProviderError) throw reason;
      if (err?.name === 'AbortError') throw err;
      throw new ProviderError(`无法连接模型接口：${err.message}`, { code: 'PROVIDER_NETWORK', retryable: true });
    }).finally(requestWatch.clear);
    if (!res.ok || !res.body) throw mapHttpError(res.status, await res.text());

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let stopReason = 'end_turn';
    const pending = new Map<number, { id: string; name: string; json: string }>();

    /**
     * Anthropic 的 input_tokens 不含缓存部分：
     * 真实输入 = input_tokens + cache_read_input_tokens（命中）+ cache_creation_input_tokens（写入，按未命中计）。
     * 只取 input_tokens 会让输入 token 严重偏低，上下文占比和成本都会失真。
     */
    const absorbUsage = (usage: any): void => {
      if (!usage || typeof usage !== 'object') return;
      if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
      if (typeof usage.cache_read_input_tokens === 'number') cacheReadTokens = usage.cache_read_input_tokens;
      if (typeof usage.cache_creation_input_tokens === 'number') cacheWriteTokens = usage.cache_creation_input_tokens;
    };

    for await (const frame of readSse(res.body, { stallMs: resolveStallMs(this.cfg.stallMs) })) {
      if (!frame.data || frame.data === '[DONE]') continue;
      let evt: any;
      try {
        evt = JSON.parse(frame.data);
      } catch {
        continue;
      }
      switch (evt.type) {
        case 'message_start':
          absorbUsage(evt.message?.usage);
          break;
        case 'content_block_start':
          if (evt.content_block?.type === 'tool_use') {
            pending.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, json: '' });
          } else if (evt.content_block?.type === 'text' && evt.content_block.text) {
            yield { type: 'text', text: evt.content_block.text };
          }
          break;
        case 'content_block_delta': {
          const delta = evt.delta;
          if (delta?.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text };
          else if (delta?.type === 'thinking_delta' && delta.thinking) yield { type: 'thinking', text: delta.thinking };
          else if (delta?.type === 'input_json_delta') {
            const slot = pending.get(evt.index);
            if (slot) slot.json += delta.partial_json ?? '';
          }
          break;
        }
        case 'content_block_stop': {
          const slot = pending.get(evt.index);
          if (slot) {
            yield { type: 'tool_call', call: { id: slot.id, name: slot.name, args: safeJson(slot.json) } };
            pending.delete(evt.index);
          }
          break;
        }
        case 'message_delta':
          // message_delta 的 usage 是累计输出，同时可能补充缓存统计
          absorbUsage(evt.usage);
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          break;
        case 'error':
          throw new ProviderError(evt.error?.message ?? '模型错误', { code: 'PROVIDER_STREAM', retryable: true });
        default:
          break;
      }
    }
    // 输入总量要把缓存命中/写入都算进来，缓存字段仅在服务商真的返回时才上报
    const totalIn = inputTokens + cacheReadTokens + cacheWriteTokens;
    const cache =
      cacheReadTokens > 0 || cacheWriteTokens > 0
        ? normalizeCacheUsage(totalIn, cacheReadTokens, inputTokens + cacheWriteTokens)
        : {};
    yield { type: 'usage', tokensIn: totalIn, tokensOut: outputTokens, ...cache };
    yield { type: 'done', stopReason };
  }
}

function safeJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function __test_toAnthropicMessages(messages: ProviderMessage[]): AnthropicMessage[] {
  return toAnthropicMessages(messages);
}

export function __test_toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, args };
}
