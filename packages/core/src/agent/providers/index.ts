import type { AgentSettings } from '../../types';
import type { LlmProvider } from '../types';
import { AnthropicProvider } from './anthropic';
import { LocalProvider } from './local';
import { OpenAIProvider } from './openai';
import { presetById } from './presets';

/** Ollama 的对话端点是 OpenAI 兼容的 /v1，这里补齐后缀。 */
export function ollamaChatBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  if (/\/v\d+$/.test(raw)) return raw;
  return `${raw}/v1`;
}

export function createProvider(settings: AgentSettings): LlmProvider {
  if (settings.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: settings.apiKey, baseUrl: settings.baseUrl || 'https://api.anthropic.com', model: settings.model });
  }
  if (settings.provider === 'ollama') {
    const preset = presetById(settings.preset);
    return new OpenAIProvider({
      apiKey: settings.apiKey,
      baseUrl: ollamaChatBaseUrl(settings.baseUrl || preset?.baseUrl),
      model: settings.model,
      label: preset?.label ?? 'Ollama',
    });
  }
  if (settings.provider === 'openai') {
    const preset = presetById(settings.preset);
    return new OpenAIProvider({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl || 'https://api.openai.com/v1',
      model: settings.model,
      label: preset?.label,
    });
  }
  return new LocalProvider();
}

export { AnthropicProvider } from './anthropic';
export { OpenAIProvider } from './openai';
export { LocalProvider } from './local';
