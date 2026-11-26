import type { ModelInputModality, ModelProfile } from '../../types';
import { DEFAULT_REASONING_TIERS } from './profile';
import { ProviderError, mapHttpError } from './common';
import { ollamaOrigin, presetById, type ProviderKind } from './presets';

export interface ModelSource {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  /** 已存密钥的原 origin；只有同 origin 才允许复用，不能随任意 baseUrl 外发。 */
  keyOrigin?: string;
  /** 已存密钥对应的协议，防止把 OpenAI key 改名成 Anthropic 协议外发。 */
  keyProvider?: ProviderKind;
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
const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_REDIRECTS = 5;
const ANTHROPIC_ORIGIN = new URL(presetById('anthropic')!.baseUrl).origin;

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
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw invalidUrl(label, trimmed);
  return parsed;
}

/** 统一 origin 比较：默认端口、大小写和末尾斜杠不造成虚假差异。 */
export function modelOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function assertCredentialBinding(input: ModelSource, base: URL, apiKey: string): void {
  if (!apiKey) return;
  if (input.keyProvider && input.keyProvider !== input.kind) {
    throw new ProviderError('已存模型密钥的协议与当前请求不一致', { code: 'MODEL_KEY_PROVIDER_MISMATCH' });
  }
  if (input.keyOrigin && modelOrigin(input.keyOrigin) !== base.origin) {
    throw new ProviderError('已存模型密钥不能用于其他 origin；自定义 origin 必须重新提供 API Key', { code: 'MODEL_KEY_ORIGIN_MISMATCH' });
  }
  // 直接调用 core 时，自定义 Anthropic origin 也必须显式声明该 key 属于这个 origin。
  if (input.kind === 'anthropic' && base.origin !== ANTHROPIC_ORIGIN && !input.keyOrigin) {
    throw new ProviderError('Anthropic API Key 不能发往未声明绑定的自定义 origin', { code: 'MODEL_KEY_ORIGIN_UNTRUSTED' });
  }
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

async function readModelText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_MODEL_LIST_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new ProviderError('模型列表响应超过读取上限', { code: 'PROVIDER_BAD_PAYLOAD' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString('utf8');
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
  const original = new URL(url);
  let current = url;
  for (let hop = 0; hop <= MAX_MODEL_REDIRECTS; hop += 1) {
    let res: Response;
    try {
      res = await fetchImpl(current, { method: 'GET', headers, signal, redirect: 'manual' });
    } catch (err: any) {
      throw new ProviderError(`无法连接 ${current}：${err?.cause?.code ?? err?.message ?? '网络不可达'}`, { code: 'PROVIDER_UNREACHABLE', retryable: true });
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      void res.body?.cancel().catch(() => undefined);
      if (!location) throw new ProviderError('模型接口重定向缺少 Location', { code: 'PROVIDER_REDIRECT_DENIED' });
      if (hop === MAX_MODEL_REDIRECTS) throw new ProviderError('模型接口重定向次数过多', { code: 'PROVIDER_REDIRECT_DENIED' });
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new ProviderError('模型接口重定向地址无效', { code: 'PROVIDER_REDIRECT_DENIED' });
      }
      // 模型 Key 只允许留在最初绑定 origin；同 origin 重定向也要重新经过网关 egress 校验。
      if (next.origin !== original.origin || next.username || next.password) {
        throw new ProviderError('模型接口重定向跨 origin，已拒绝外发 API Key', { code: 'PROVIDER_REDIRECT_DENIED' });
      }
      current = next.toString();
      continue;
    }
    const text = await readModelText(res);
    if (!res.ok) throw mapHttpError(res.status, text);
    try {
      return JSON.parse(text || '{}');
    } catch {
      throw new ProviderError(`${current} 返回的不是 JSON，请检查接入地址`, { code: 'PROVIDER_BAD_PAYLOAD' });
    }
  }
  throw new ProviderError('模型接口重定向次数过多', { code: 'PROVIDER_REDIRECT_DENIED' });
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
    assertCredentialBinding(input, base, apiKey);
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
  assertCredentialBinding(input, base, apiKey);

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
