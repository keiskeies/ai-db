import type { AppSettings } from '@aidb/core';
import { DbError } from './drivers';

export function embeddingAvailable(settings: AppSettings): boolean {
  const config = settings.embedding;
  return config.provider !== 'none' && Boolean(config.baseUrl && config.model);
}

export async function embedText(settings: AppSettings, text: string): Promise<number[]> {
  const config = settings.embedding;
  if (!embeddingAvailable(settings)) {
    throw new DbError('未配置 Embedding Provider', {
      code: 'EMBEDDING_NOT_CONFIGURED',
      hint: '在设置中配置 OpenAI 兼容 /embeddings 或 Ollama，再使用文本向量检索',
    });
  }
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = config.provider === 'ollama' ? `${base}/api/embeddings` : base.endsWith('/embeddings') ? base : `${base}/embeddings`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const body = config.provider === 'ollama' ? { model: config.model, prompt: text } : { model: config.model, input: text };
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
  const vector = config.provider === 'ollama' ? payload?.embedding : payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(Number(value)))) {
    throw new DbError('Embedding 服务没有返回有效向量', { code: 'EMBEDDING_INVALID' });
  }
  return vector.map((value) => Number(value));
}
