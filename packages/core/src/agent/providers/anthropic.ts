import type { LlmProvider, ProviderEvent, ProviderMessage, ProviderRequest, ToolCall } from '../types';
import { joinUrl, mapHttpError, ProviderError, readSse } from './common';

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
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
    const requested = req.maxTokens ?? this.cfg.maxTokens ?? 4096;
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
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        stream: true,
      }),
      signal,
    }).catch((err) => {
      if (err?.name === 'AbortError') throw err;
      throw new ProviderError(`无法连接模型接口：${err.message}`, { code: 'PROVIDER_NETWORK', retryable: true });
    });
    if (!res.ok || !res.body) throw mapHttpError(res.status, await res.text());

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';
    const pending = new Map<number, { id: string; name: string; json: string }>();

    for await (const frame of readSse(res.body)) {
      if (!frame.data || frame.data === '[DONE]') continue;
      let evt: any;
      try {
        evt = JSON.parse(frame.data);
      } catch {
        continue;
      }
      switch (evt.type) {
        case 'message_start':
          inputTokens = evt.message?.usage?.input_tokens ?? 0;
          outputTokens = evt.message?.usage?.output_tokens ?? 0;
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
          if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens;
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          break;
        case 'error':
          throw new ProviderError(evt.error?.message ?? '模型错误', { code: 'PROVIDER_STREAM', retryable: true });
        default:
          break;
      }
    }
    yield { type: 'usage', tokensIn: inputTokens, tokensOut: outputTokens };
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
