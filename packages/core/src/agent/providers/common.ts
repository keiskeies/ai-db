export class ProviderError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { code?: string; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = opts.code ?? 'PROVIDER_ERROR';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

export interface SseFrame {
  event?: string;
  data: string;
}

/** Split an ReadableStream into SSE frames. Handles chunk boundaries and CRLF. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
      if (buffer.trim()) {
        const last = parseFrame(buffer);
        if (last) yield last;
      }
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame = parseFrame(raw);
      if (frame) yield frame;
      idx = buffer.indexOf('\n\n');
    }
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

export function mapHttpError(status: number, body: string): ProviderError {
  let detail = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body);
    detail = parsed.error?.message ?? parsed.message ?? detail;
  } catch {
    /* keep raw */
  }
  const retryable = status === 429 || status >= 500;
  const code = status === 401 || status === 403 ? 'PROVIDER_AUTH' : status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP';
  return new ProviderError(`模型接口返回 ${status}：${detail}`, { code, status, retryable });
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** 本机或内网端点（Ollama / LM Studio / vLLM）通常不带鉴权。 */
export function isPrivateEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host === 'host.docker.internal' || host === 'gateway.docker.internal';
}
