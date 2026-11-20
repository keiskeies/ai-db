import type { AppSettings } from '@aidb/core';
import { DbError } from './drivers';

export function embeddingAvailable(settings: AppSettings): boolean {
  const config = settings.embedding;
  return config.provider !== 'none' && Boolean(config.baseUrl && config.model);
}

/**
 * 同一文本的向量是确定的：重复检索（Agent 多轮、仪表板刷新）不该每次都付一次 HTTP 往返。
 * 按 provider+baseUrl+model+text 缓存，配置变更自然换键；LRU 封顶防止长文本/大向量撑堆。
 */
const EMBED_CACHE_MAX = 256;
const embedCache = new Map<string, number[]>();
/** 并发同文本请求合并成一次上游调用。 */
const embedPending = new Map<string, Promise<number[]>>();

export async function embedText(settings: AppSettings, text: string): Promise<number[]> {
  const config = settings.embedding;
  if (!embeddingAvailable(settings)) {
    throw new DbError('未配置 Embedding Provider', {
      code: 'EMBEDDING_NOT_CONFIGURED',
      hint: '在设置中配置 OpenAI 兼容 /embeddings 或 Ollama，再使用文本向量检索',
    });
  }
  const base = config.baseUrl.replace(/\/+$/, '');
  const key = `${config.provider}|${base}|${config.model}|${text}`;
  const hit = embedCache.get(key);
  if (hit) {
    embedCache.delete(key);
    embedCache.set(key, hit);
    return hit;
  }
  const pending = embedPending.get(key);
  if (pending) return pending;
  const task = requestEmbedding(config.provider, base, config.model, config.apiKey, text)
    .then((vector) => {
      embedCache.set(key, vector);
      if (embedCache.size > EMBED_CACHE_MAX) {
        const oldest = embedCache.keys().next().value;
        if (oldest !== undefined) embedCache.delete(oldest);
      }
      return vector;
    })
    .finally(() => {
      embedPending.delete(key);
    });
  embedPending.set(key, task);
  return task;
}

async function requestEmbedding(
  provider: AppSettings['embedding']['provider'],
  base: string,
  model: string,
  apiKey: string | undefined,
  text: string,
): Promise<number[]> {
  const url = provider === 'ollama' ? `${base}/api/embeddings` : base.endsWith('/embeddings') ? base : `${base}/embeddings`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = provider === 'ollama' ? { model, prompt: text } : { model, input: text };
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (err: any) {
    throw new DbError(`Embedding 请求失败：${err?.message ?? '网络错误'}`, { code: 'EMBEDDING_FAILED' });
  }
  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok) {
    throw new DbError(`Embedding 服务返回 ${response.status}`, {
      code: 'EMBEDDING_FAILED',
      hint: typeof payload?.error?.message === 'string' ? payload.error.message : undefined,
    });
  }
  const vector = provider === 'ollama' ? payload?.embedding : payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(Number(value)))) {
    throw new DbError('Embedding 服务没有返回有效向量', { code: 'EMBEDDING_INVALID' });
  }
  return vector.map((value) => Number(value));
}
