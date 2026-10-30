import type { LlmProvider, ProviderEvent, ProviderMessage, ProviderRequest, ToolCall } from '../types';
import { isPrivateEndpoint, joinUrl, mapHttpError, ProviderError, readSse } from './common';

export interface OpenAIConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  /** 展示名（来自服务商预设）。 */
  label?: string;
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
    const res = await fetch(joinUrl(this.cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        model: this.cfg.model,
        messages: toOpenAIMessages(req.system, req.messages),
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? 4096,
        ...(req.reasoning?.value ? { reasoning_effort: req.reasoning.value } : {}),
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto' } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    }).catch((err) => {
      if (err?.name === 'AbortError') throw err;
      throw new ProviderError(`无法连接模型接口：${err.message}`, { code: 'PROVIDER_NETWORK', retryable: true });
    });
    if (!res.ok || !res.body) throw mapHttpError(res.status, await res.text());

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason = 'stop';

    for await (const frame of readSse(res.body)) {
      if (!frame.data) continue;
      if (frame.data === '[DONE]') break;
      let evt: any;
      try {
        evt = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (evt.usage) {
        tokensIn = evt.usage.prompt_tokens ?? tokensIn;
        tokensOut = evt.usage.completion_tokens ?? tokensOut;
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

    for (const slot of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      if (!slot.name) continue;
      const call: ToolCall = {
        id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: slot.name,
        args: safeJson(slot.args),
      };
      yield { type: 'tool_call', call };
    }
    yield { type: 'usage', tokensIn, tokensOut };
    yield { type: 'done', stopReason };
  }
}

function safeJson(text: string): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
