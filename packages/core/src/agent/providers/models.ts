import { ProviderError, mapHttpError } from './common';
import { ollamaOrigin, type ProviderKind } from './presets';

export interface ModelSource {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
}

export interface ModelList {
  models: string[];
  /** 实际请求的地址，便于用户判断连的是哪个端点。 */
  endpoint: string;
}

const MAX_MODELS = 500;

function invalidUrl(label: string, value: string): ProviderError {
  return new ProviderError(`${label}不是合法的 http/https 地址：${value || '（空）'}`, { code: 'INVALID_BASE_URL' });
}

function requireUrl(value: string, label: string): URL {
  const trimmed = (value || '').trim();
  if (!trimmed) throw invalidUrl(label, trimmed);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalidUrl(label, trimmed);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalidUrl(label, trimmed);
  return parsed;
}

function idsOf(payload: unknown, keys: string[]): string[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.add(item.trim());
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    for (const key of keys) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        out.add(value.trim());
        break;
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b)).slice(0, MAX_MODELS);
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal });
  } catch (err: any) {
    throw new ProviderError(`无法连接 ${url}：${err?.cause?.code ?? err?.message ?? '网络不可达'}`, { code: 'PROVIDER_UNREACHABLE', retryable: true });
  }
  const text = await res.text();
  if (!res.ok) throw mapHttpError(res.status, text);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new ProviderError(`${url} 返回的不是 JSON，请检查接入地址`, { code: 'PROVIDER_BAD_PAYLOAD' });
  }
}

/** 读取服务商的模型列表：OpenAI 兼容读 /models，Anthropic 读 /v1/models，Ollama 优先原生 /api/tags。 */
export async function listProviderModels(
  input: ModelSource,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelList> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const apiKey = (input.apiKey ?? '').trim();

  if (input.kind === 'local') throw new ProviderError('内置离线推理没有远程模型列表', { code: 'LOCAL_PROVIDER' });

  if (input.kind === 'anthropic') {
    const base = requireUrl(input.baseUrl, 'Anthropic 接入地址');
    if (!apiKey) throw new ProviderError('Anthropic 需要 API Key 才能读取模型列表', { code: 'NO_API_KEY' });
    const url = `${base.toString().replace(/\/+$/, '')}/v1/models`;
    const payload = await fetchJson(
      url,
      { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      timeoutMs,
      fetchImpl,
    );
    return { models: idsOf(payload, ['id', 'model']), endpoint: url };
  }

  const base = requireUrl(input.baseUrl, '模型服务接入地址');

  if (input.kind === 'ollama') {
    const tagsUrl = `${ollamaOrigin(base.toString())}/api/tags`;
    try {
      const payload = await fetchJson(tagsUrl, {}, timeoutMs, fetchImpl);
      return { models: idsOf(payload, ['name', 'model']), endpoint: tagsUrl };
    } catch (err) {
      if ((err as ProviderError).code !== 'PROVIDER_UNREACHABLE' && (err as ProviderError).code !== 'PROVIDER_HTTP') throw err;
      // 远程 Ollama 可能只暴露 OpenAI 兼容端点，退回到 /models
    }
  }

  const url = `${base.toString().replace(/\/+$/, '')}/models`;
  const payload = await fetchJson(url, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, timeoutMs, fetchImpl);
  return { models: idsOf(payload, ['id', 'model', 'name']), endpoint: url };
}
