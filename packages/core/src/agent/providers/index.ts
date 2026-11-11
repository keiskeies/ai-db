import type { AgentSettings } from '../../types';
import type { LlmProvider } from '../types';
import { AnthropicProvider } from './anthropic';
import { LocalProvider } from './local';
import { OpenAIProvider } from './openai';
import { maxOutputTokensOf } from './profile';
import { presetById } from './presets';

/** Ollama 的对话端点是 OpenAI 兼容的 /v1，这里补齐后缀。 */
export function ollamaChatBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  if (/\/v\d+$/.test(raw)) return raw;
  return `${raw}/v1`;
}

export function createProvider(settings: AgentSettings): LlmProvider {
  const maxTokens = maxOutputTokensOf(settings);
  if (settings.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: settings.apiKey, baseUrl: settings.baseUrl || 'https://api.anthropic.com', model: settings.model, maxTokens });
  }
  if (settings.provider === 'ollama') {
    const preset = presetById(settings.preset);
    return new OpenAIProvider({
      apiKey: settings.apiKey,
      baseUrl: ollamaChatBaseUrl(settings.baseUrl || preset?.baseUrl),
      model: settings.model,
      maxTokens,
      label: preset?.label ?? 'Ollama',
      // 本机推理引擎加载模型/长提示词 prefill 期间可以整几分钟不吐字节，
      // 这不是卡死。对这类端点不做停摆判定——误杀比漏杀贵得多。
      stallMs: 0,
    });
  }
  if (settings.provider === 'openai') {
    const preset = presetById(settings.preset);
    return new OpenAIProvider({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl || 'https://api.openai.com/v1',
      model: settings.model,
      maxTokens,
      label: preset?.label,
    });
  }
  return new LocalProvider();
}

export { AnthropicProvider } from './anthropic';
export { OpenAIProvider } from './openai';
export { LocalProvider } from './local';
