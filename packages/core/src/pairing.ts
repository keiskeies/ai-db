export interface PairingPayload {
  url: string;
  code: string;
  host: string;
  port: number;
}

function pairingError(message: string): Error {
  return new Error(message);
}

/**
 * 解析桌面端「为移动端配对」二维码。
 * 兼容两种载荷：{v,url,host,port,code} 与旧版 {v,host,port,code}（无 url）。
 */
export function parsePairingPayload(raw: string): PairingPayload {
  const text = String(raw ?? '').trim();
  if (!text) throw pairingError('二维码内容为空');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw pairingError('二维码不是有效的配对信息');
  }
  const code = String(data.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw pairingError('二维码缺少有效的 6 位配对码');
  const rawUrl = typeof data.url === 'string' && data.url.trim() ? data.url.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl || `http://${String(data.host ?? '')}:${Number(data.port ?? 8787)}`);
  } catch {
    throw pairingError('二维码中的 Bridge 地址无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw pairingError('Bridge 地址只支持 http/https');
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return { url: parsed.origin, code, host: parsed.hostname, port };
}
