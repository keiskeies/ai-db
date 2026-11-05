import { PipelineError, type PipelineCredentialSecret } from './types';

/**
 * 数据流的出站 HTTP。
 *
 * 与 notifications.ts 的 webhook 不同，这里要面对任意用户填写的地址：超时可控、
 * 响应体有上限、非 2xx 带片段报错。凭证按 id 从加密库取，只在构造请求头时出现。
 */

export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  /** 已渲染好的请求体：对象会序列化并带上 content-type。 */
  body?: unknown;
  bodyRaw?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  auth?: { mode: string; credential?: PipelineCredentialSecret | null; field?: string };
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  contentType: string;
  text: string;
  json: unknown;
  bytes: number;
}

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export function withQuery(url: string, query: Record<string, unknown>): string {
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return url;
  const pairs = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(valueText(value))}`);
  return url + (url.includes('?') ? '&' : '?') + pairs.join('&');
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function applyAuth(headers: Record<string, string>, auth: HttpRequestInput['auth']): void {
  const mode = auth?.mode ?? 'none';
  const secret = auth?.credential;
  if (mode === 'none' || !secret) {
    if (mode !== 'none' && !secret) throw new PipelineError('流水线引用的凭证不存在或已被删除', 'PIPELINE_CREDENTIAL_MISSING', '在数据流处理的凭证管理里重建后重新选择');
    return;
  }
  if (mode === 'bearer') {
    headers['authorization'] = `${secret.prefix?.trim() ? secret.prefix.trim() : 'Bearer'} ${secret.token ?? ''}`;
    return;
  }
  if (mode === 'basic') {
    const raw = `${secret.username ?? ''}:${secret.password ?? ''}`;
    headers['authorization'] = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    return;
  }
  if (mode === 'apikey' || mode === 'header') {
    const name = (auth?.field || secret.header || 'Authorization').trim();
    headers[name.toLowerCase()] = secret.value ?? secret.token ?? '';
  }
}

export async function httpRequest(input: HttpRequestInput): Promise<HttpResponse> {
  const method = (input.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9', ...(input.headers ?? {}) };
  applyAuth(headers, input.auth);
  let body: string | undefined;
  if (input.body !== undefined && input.body !== null && input.body !== '') {
    if (typeof input.body === 'string' || input.bodyRaw) {
      body = String(input.body);
      headers['content-type'] ??= 'application/json';
    } else {
      body = JSON.stringify(input.body);
      headers['content-type'] ??= 'application/json';
    }
  }
  const url = withQuery(input.url, input.query ?? {});
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT, 1000), 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' });
  } catch (err: any) {
    clearTimeout(timer);
    const reason = err?.name === 'AbortError' ? `超过 ${Math.round(timeoutMs / 1000)} 秒未响应` : (err?.cause?.message ?? err?.message ?? '连接失败');
    throw new PipelineError(`接口请求失败：${reason}`, 'PIPELINE_HTTP_NETWORK', `检查 ${new URL(url, 'http://localhost').host} 是否可达`);
  }
  clearTimeout(timer);

  const contentType = response.headers.get('content-type') ?? '';
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        truncated = true;
        void reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const textBody = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8');
  let json: unknown = undefined;
  if (!truncated && textBody.trim()) {
    const looksJson = contentType.includes('json') || /^[[{]/.test(textBody.trim());
    if (looksJson) {
      try {
        json = JSON.parse(textBody);
      } catch {
        json = undefined;
      }
    }
  }
  const result: HttpResponse = { status: response.status, ok: response.ok, contentType, text: textBody, json, bytes };
  if (!response.ok) {
    const snippet = textBody.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new PipelineError(
      `接口返回 ${response.status} ${response.statusText}${snippet ? `：${snippet}` : ''}`,
      'PIPELINE_HTTP_STATUS',
      `耗时 ${Date.now() - started}ms；可在步骤里把失败批次的处理策略改成忽略`,
    );
  }
  return result;
}

/** 响应里没解析出 JSON 时给一个可读的行集，避免整条流水线因为空路径而静默 0 行。 */
export function responseValue(response: HttpResponse): unknown {
  if (response.json !== undefined) return response.json;
  return { status: response.status, body: response.text, contentType: response.contentType };
}
