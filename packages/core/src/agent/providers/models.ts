import type { ModelInputModality, ModelProfile } from '../../types';
import { DEFAULT_REASONING_TIERS } from './profile';
import { ProviderError, mapHttpError } from './common';
import { ollamaOrigin, type ProviderKind } from './presets';

export interface ModelSource {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
}

/** 服务商 /models 里能安全识别出来的能力信息；识别不到时字段全部缺省。 */
export interface ModelInfo {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputs?: ModelInputModality[];
  reasoning?: boolean;
  /** 服务商声明的推理档位名（openai 兼容按字符串下发）。 */
  reasoningEfforts?: string[];
}

export interface ModelList {
  models: string[];
  /** 与 models 同序的能力信息，供界面预填模型档案。 */
  infos: ModelInfo[];
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

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function records(payload: unknown): Record<string, unknown>[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function idsOf(payload: unknown, keys: string[]): string[] {
  const out = new Set<string>();
  for (const item of records(payload)) {
    for (const key of keys) {
      const value = str(item[key]);
      if (value) {
        out.add(value);
        break;
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b)).slice(0, MAX_MODELS);
}

function wordsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter((item): item is string => Boolean(item));
}

function modalitiesOf(item: Record<string, unknown>): ModelInputModality[] | undefined {
  const capabilityText = [...wordsOf(item.capabilities), ...wordsOf(item.supported_parameters), ...wordsOf(item.tags)].join(' ').toLowerCase();
  const declared = [
    ...wordsOf(item.input_modalities),
    ...wordsOf(item.supported_modalities),
    ...wordsOf((item.architecture as Record<string, unknown> | undefined)?.input_modalities),
  ].map((word) => word.toLowerCase());
  const inputs = new Set<ModelInputModality>();
  if (declared.includes('text')) inputs.add('text');
  if (declared.some((word) => word === 'image' || word === 'vision') || /\bvision\b|\bimage\b/.test(capabilityText)) inputs.add('image');
  if (/\btext\b|\blanguage\b/.test(capabilityText)) inputs.add('text');
  if (!inputs.size) return undefined;
  // 收图的模型必然也收文本；反之没有任何模态线索时不下结论，避免给纯文本模型编造档案。
  if (inputs.has('image')) inputs.add('text');
  return (['text', 'image'] as ModelInputModality[]).filter((modality) => inputs.has(modality));
}

function effortsOf(item: Record<string, unknown>): string[] | undefined {
  const reasoning = item.reasoning as Record<string, unknown> | undefined;
  const efforts = wordsOf(reasoning?.efforts).length ? wordsOf(reasoning?.efforts) : wordsOf(item.reasoning_efforts);
  return efforts.length ? efforts : undefined;
}

/** 从服务商返回的单条模型记录里提取能力；识别不出任何一项时返回 undefined。 */
export function detectModelInfo(id: string, item: Record<string, unknown>): ModelInfo {
  const info: ModelInfo = { id };
  const contextWindow = num(item.context_length) ?? num(item.context_window) ?? num(item.max_input_tokens);
  const maxOutputTokens = num(item.max_output_tokens) ?? num(item.max_completion_tokens) ?? num((item.params as Record<string, unknown> | undefined)?.max_output_tokens);
  const inputs = modalitiesOf(item);
  const efforts = effortsOf(item);
  const capabilityText = wordsOf(item.capabilities).join(' ').toLowerCase();
  const reasoning = Boolean(efforts?.length) || /reasoning|thinking/.test(capabilityText) || wordsOf(item.supported_parameters).includes('reasoning_effort');
  if (contextWindow) info.contextWindow = contextWindow;
  if (maxOutputTokens) info.maxOutputTokens = maxOutputTokens;
  if (inputs) info.inputs = inputs;
  if (reasoning) info.reasoning = true;
  if (efforts) info.reasoningEfforts = efforts;
  return info;
}

function infosOf(payload: unknown, keys: string[]): ModelInfo[] {
  const items = records(payload);
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const item of items) {
    let id: string | undefined;
    for (const key of keys) {
      id = str(item[key]);
      if (id) break;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(detectModelInfo(id, item));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
}

/** 把探测到的能力转成可编辑的模型档案；什么都没探测到时返回 undefined，界面保持空白。 */
export function profileFromModelInfo(info: ModelInfo): ModelProfile | undefined {
  const profile: ModelProfile = {};
  if (info.contextWindow) profile.contextWindow = info.contextWindow;
  if (info.maxOutputTokens) profile.maxOutputTokens = info.maxOutputTokens;
  if (info.inputs) profile.inputs = info.inputs;
  if (info.reasoning || info.reasoningEfforts?.length) {
    profile.reasoning = true;
    profile.reasoningTiers = info.reasoningEfforts?.length
      ? [{ level: 'off', value: '' }, ...info.reasoningEfforts.map((level) => ({ level, value: level }))]
      : DEFAULT_REASONING_TIERS.map((tier) => ({ ...tier }));
  }
  return Object.keys(profile).length ? profile : undefined;
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
    const keys = ['id', 'model'];
    return { models: idsOf(payload, keys), infos: infosOf(payload, keys), endpoint: url };
  }

  const base = requireUrl(input.baseUrl, '模型服务接入地址');

  if (input.kind === 'ollama') {
    const tagsUrl = `${ollamaOrigin(base.toString())}/api/tags`;
    try {
      const payload = await fetchJson(tagsUrl, {}, timeoutMs, fetchImpl);
      const keys = ['name', 'model'];
      return { models: idsOf(payload, keys), infos: infosOf(payload, keys), endpoint: tagsUrl };
    } catch (err) {
      if ((err as ProviderError).code !== 'PROVIDER_UNREACHABLE' && (err as ProviderError).code !== 'PROVIDER_HTTP') throw err;
      // 远程 Ollama 可能只暴露 OpenAI 兼容端点，退回到 /models
    }
  }

  const url = `${base.toString().replace(/\/+$/, '')}/models`;
  const payload = await fetchJson(url, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, timeoutMs, fetchImpl);
  const keys = ['id', 'model', 'name'];
  return { models: idsOf(payload, keys), infos: infosOf(payload, keys), endpoint: url };
}
