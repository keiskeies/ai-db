import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { parseAllowedPrivateOrigins } from './config';

export type EgressErrorCode =
  | 'EGRESS_URL_DENIED'
  | 'EGRESS_DNS_FAILED'
  | 'EGRESS_REDIRECT_DENIED'
  | 'EGRESS_REDIRECT_LIMIT'
  | 'EGRESS_RESPONSE_TOO_LARGE'
  | 'EGRESS_TIMEOUT'
  | 'EGRESS_ABORTED'
  | 'EGRESS_NETWORK';

export class EgressError extends Error {
  constructor(message: string, readonly code: EgressErrorCode, readonly cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'EgressError';
  }
}

export type DnsLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
export type FetchImplementation = (url: string, init: Omit<RequestInit, 'dispatcher'> & { dispatcher: Dispatcher }) => Promise<Response>;

export interface EgressOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowPrivateOrigins?: string[];
  /** Defaults to HTTP(S); callers can require HTTPS or explicitly allow HTTP. */
  allowedProtocols?: readonly string[];
  /** Every hop, including redirects, must pass this caller-owned policy check. */
  validateUrl?: (url: URL) => void | Promise<void>;
  /** Explicitly configured HTTP(S) proxy; target DNS is still resolved and pinned locally. */
  proxyUrl?: string;
  sameOriginOnly?: boolean;
  followRedirects?: boolean;
  /** Tests may replace DNS/transport; production uses system DNS and the global Node fetch. */
  lookupImpl?: DnsLookup;
  fetchImpl?: FetchImplementation;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_BYTES_LIMIT = 64 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'user-agent', 'range']);
const PRIVATE_IPV4_CIDRS: Array<[bigint, number]> = [
  [0x00000000n, 8], [0x0a000000n, 8], [0x64400000n, 10], [0x7f000000n, 8],
  [0xa9fe0000n, 16], [0xac100000n, 12], [0xc0000000n, 24], [0xc0000200n, 24],
  [0xc0586300n, 24], [0xc0a80000n, 16], [0xc6120000n, 15], [0xc6336400n, 22],
  [0xcb007100n, 24], [0xe0000000n, 4], [0xf0000000n, 4],
];
const ALWAYS_BLOCKED_IPV4_CIDRS: Array<[bigint, number]> = [
  [0x00000000n, 8], [0xa9fe0000n, 16], [0xc0000000n, 24], [0xc0000200n, 24],
  [0xc0586300n, 24], [0xc6120000n, 15], [0xc6336400n, 22], [0xcb007100n, 24],
  [0xe0000000n, 4], [0xf0000000n, 4],
];
const IPV6_DOCUMENTATION_CIDRS: Array<[bigint, number]> = [
  [0x20010db8000000000000000000000000n, 32],
  [0x3fff0000000000000000000000000000n, 20],
];

function ipv4Number(ip: string): bigint | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const values = parts.map(Number);
  if (values.some((value) => value > 255)) return undefined;
  return values.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function ipv6Number(ip: string): bigint | undefined {
  let value = ip.toLowerCase();
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    if (separator < 0) return undefined;
    const ipv4 = ipv4Number(value.slice(separator + 1));
    if (ipv4 === undefined) return undefined;
    const words = [(ipv4 >> 16n) & 0xffffn, ipv4 & 0xffffn]
      .map((word) => word.toString(16))
      .join(':');
    value = `${value.slice(0, separator + 1)}${words}`;
  }
  if (!value.includes(':')) return undefined;
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const parseGroups = (text: string): number[] | undefined => {
    if (!text) return [];
    const groups = text.split(':');
    if (groups.length > 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (halves.length === 2 && missing < 1) return undefined;
  const groups = [...left, ...Array<number>(missing).fill(0), ...right];
  return groups.reduce((number, group) => (number << 16n) | BigInt(group), 0n);
}

function inCidr(value: bigint, base: bigint, prefix: number, bits = 128): boolean {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (base >> shift);
}

function isBlockedIpv4Number(number: bigint): boolean {
  return PRIVATE_IPV4_CIDRS.some(([base, prefix]) => inCidr(number, base, prefix, 32));
}

function isIpv6TransitionNumber(number: bigint): boolean {
  if ((number >> 32n) === 0xffffn) return true; // IPv4-mapped
  if ((number >> 32n) === 0xffff0000n) return true; // IPv4-translated
  if (inCidr(number, 0x64ff9b000000000000000000000000n, 96)) return true; // NAT64 well-known prefix
  if (inCidr(number, 0x64ff9b000100000000000000000000n, 48)) return true; // Local-use NAT64 prefix
  if ((number >> 112n) === 0x2002n) return true; // 6to4
  if (inCidr(number, 0x20010000000000000000000000000000n, 23)) return true; // Teredo/ORCHID/IETF assignments
  if (number > 1n && number < 0x100000000n) return true; // IPv4-compatible, except loopback
  const interfaceId = number & 0xffffffffffffn;
  const interfaceWords = interfaceId >> 32n;
  return interfaceWords === 0x5efen || interfaceWords === 0x2005efen; // ISATAP
}

function isAlwaysBlockedIpv6Number(number: bigint): boolean {
  if (number === 1n) return false; // ::1 can use the explicit private-origin opt-in, like 127.0.0.1.
  if (isIpv6TransitionNumber(number)) return true;
  if (inCidr(number, 0xfe800000000000000000000000000000n, 10)) return true; // Link-local
  if ((number & 0xff00n) === 0xff00n) return true; // Multicast
  if (number === 0xfd000ec2000000000000000000000254n) return true; // AWS IMDS IPv6
  if (IPV6_DOCUMENTATION_CIDRS.some(([base, prefix]) => inCidr(number, base, prefix))) return true;
  if (inCidr(number, 0xfc000000000000000000000000000000n, 7)) return false; // Unique-local
  return (number >> 125n) !== 1n; // Reserve opt-in for global unicast, ULA and loopback only.
}

/** Conservative public-address check: documentation and every IPv6 transition form are denied. */
export function isBlockedIp(input: string): boolean {
  const value = input.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(value);
  if (family === 4) {
    const number = ipv4Number(value);
    return number === undefined || isBlockedIpv4Number(number);
  }
  if (family !== 6) return true;
  const number = ipv6Number(value);
  if (number === undefined || isAlwaysBlockedIp(value)) return true;
  if (inCidr(number, 0xfc000000000000000000000000000000n, 7) || number === 1n) return true;
  return (number >> 125n) !== 1n; // Only 2000::/3 global unicast remains eligible.
}

/** Metadata, link-local, transition and other non-private special ranges remain denied with an opt-in. */
export function isAlwaysBlockedIp(input: string): boolean {
  const value = input.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(value) === 4) {
    const number = ipv4Number(value);
    if (number === undefined) return true;
    return number === 0xa9fea9fen // AWS IMDS
      || number === 0x646464c8n // Alibaba metadata (100.100.100.200)
      || ALWAYS_BLOCKED_IPV4_CIDRS.some(([base, prefix]) => inCidr(number, base, prefix, 32));
  }
  if (isIP(value) !== 6) return true;
  const number = ipv6Number(value);
  return number === undefined || isAlwaysBlockedIpv6Number(number);
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function isMetadataHost(host: string): boolean {
  return host === 'metadata' || host === 'instance-data' || host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal');
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}

function allowedOrigins(value: string[] | undefined): Set<string> {
  return new Set((value ?? parseAllowedPrivateOrigins(process.env.AIDB_EGRESS_ALLOW_PRIVATE_ORIGINS)).map((item) => {
    try {
      return new URL(item).origin;
    } catch {
      throw new EgressError('私网出站白名单包含非法 origin', 'EGRESS_URL_DENIED');
    }
  }));
}

export interface ResolvedOutboundUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

function normalizedIp(address: string): string {
  return address.replace(/^\[|\]$/g, '').split('%')[0];
}

/** Resolves and validates every DNS answer; returns the address that must be pinned for this hop. */
export async function resolveOutboundUrl(input: string | URL, options: EgressOptions = {}): Promise<ResolvedOutboundUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EgressError('出站 URL 格式不正确', 'EGRESS_URL_DENIED');
  }
  const protocols = new Set((options.allowedProtocols ?? ['http:', 'https:']).map((protocol) => {
    const normalized = protocol.toLowerCase();
    return normalized.endsWith(':') ? normalized : `${normalized}:`;
  }));
  if (!protocols.has(url.protocol)) {
    throw new EgressError(`出站 URL 协议未获允许：${url.protocol}`, 'EGRESS_URL_DENIED');
  }
  if (url.username || url.password) throw new EgressError('出站 URL 不能携带用户名或密码', 'EGRESS_URL_DENIED');
  const host = normalizedHost(url);
  if (!host) throw new EgressError('出站 URL 缺少主机名', 'EGRESS_URL_DENIED');
  if (isMetadataHost(host)) throw new EgressError('禁止访问云元数据地址', 'EGRESS_URL_DENIED');
  if (options.validateUrl) {
    try {
      await options.validateUrl(url);
    } catch (err) {
      if (err instanceof EgressError) throw err;
      throw new EgressError('出站 URL 未通过调用方策略', 'EGRESS_URL_DENIED', err);
    }
  }
  const explicitlyAllowed = allowedOrigins(options.allowPrivateOrigins).has(url.origin);
  if (!explicitlyAllowed && isLocalHost(host)) throw new EgressError(`禁止访问本机/内网主机：${host}`, 'EGRESS_URL_DENIED');

  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await (options.lookupImpl ?? (lookup as unknown as DnsLookup))(host, { all: true, verbatim: true });
    } catch (err) {
      throw new EgressError(`域名解析失败：${host}`, 'EGRESS_DNS_FAILED', err);
    }
  }
  if (!addresses.length) throw new EgressError(`域名没有解析结果：${host}`, 'EGRESS_DNS_FAILED');
  for (const entry of addresses) {
    const address = normalizedIp(entry.address);
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new EgressError(`域名返回了非法地址：${host}`, 'EGRESS_DNS_FAILED');
    if (isAlwaysBlockedIp(address)) throw new EgressError('禁止访问 link-local/云元数据/transition 地址', 'EGRESS_URL_DENIED');
    if (!explicitlyAllowed && isBlockedIp(address)) {
      throw new EgressError(`域名解析到内网地址或受限地址，已拒绝：${host}`, 'EGRESS_URL_DENIED');
    }
  }
  const address = normalizedIp(addresses[0].address);
  return { url, address, family: isIP(address) as 4 | 6 };
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    if (typeof options === 'object' && options !== null && 'all' in options && options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as LookupFunction;
}

function pinnedAgent(address: string, family: 4 | 6): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(address, family) } });
}

function proxyOrigin(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    return url.toString();
  } catch (err) {
    throw new EgressError('出站代理只支持合法的 http/https URL', 'EGRESS_URL_DENIED', err);
  }
}

interface PinnedTransport {
  dispatcher: Dispatcher;
  url: string;
  headers: Headers;
}

function pinnedTransport(resolved: ResolvedOutboundUrl, headers: Headers, proxyUrl?: string): PinnedTransport {
  if (!proxyUrl) {
    return { dispatcher: pinnedAgent(resolved.address, resolved.family), url: resolved.url.toString(), headers };
  }
  const transportUrl = new URL(resolved.url);
  const host = transportUrl.host;
  transportUrl.hostname = resolved.family === 6 ? `[${resolved.address}]` : resolved.address;
  const transportHeaders = new Headers(headers);
  transportHeaders.set('host', host);
  const dispatcher = new ProxyAgent({
    uri: proxyOrigin(proxyUrl),
    requestTls: resolved.url.protocol === 'https:' ? { servername: normalizedHost(resolved.url) } : undefined,
  });
  return { dispatcher, url: transportUrl.toString(), headers: transportHeaders };
}

function abortError(signal: AbortSignal, callerSignal?: AbortSignal): EgressError {
  return callerSignal?.aborted
    ? new EgressError('出站请求已取消', 'EGRESS_ABORTED')
    : new EgressError('出站请求超时（含响应体读取与逐跳重定向）', 'EGRESS_TIMEOUT');
}

async function readCappedBody(response: Response, cap: number, signal: AbortSignal, callerSignal?: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw abortError(signal, callerSignal);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > cap) {
    void response.body?.cancel().catch(() => undefined);
    throw new EgressError(`出站响应超过 ${cap} 字节上限`, 'EGRESS_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal, callerSignal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value) continue;
      if (size + value.byteLength > cap) {
        void reader.cancel().catch(() => undefined);
        throw new EgressError(`出站响应超过 ${cap} 字节上限`, 'EGRESS_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function withoutCrossOriginCredentials(headers: Headers): Headers {
  const next = new Headers();
  headers.forEach((value, key) => {
    if (SAFE_CROSS_ORIGIN_HEADERS.has(key.toLowerCase())) next.set(key, value);
  });
  return next;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, callerSignal?: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal, callerSignal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal, callerSignal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// Calling the current global fetch preserves deliberate test mocks while Node honors the Undici dispatcher.
const defaultFetch: FetchImplementation = (url, init) => globalThis.fetch(url, init as unknown as RequestInit);

/**
 * Unified outbound fetch: caller protocol policy, all-answer DNS validation, IP pinning,
 * per-hop redirect checks, cross-origin credential stripping, one total deadline and a byte cap.
 * The response body is fully buffered before this function returns.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, options: EgressOptions = {}): Promise<Response> {
  const timeoutMs = Math.min(Math.max(Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1), 120_000);
  const maxBytes = Math.min(Math.max(Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES), 1), MAX_BYTES_LIMIT);
  const maxRedirects = Math.min(Math.max(Math.floor(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS), 0), 10);
  const callerSignal = init.signal ?? undefined;
  if (callerSignal?.aborted) throw new EgressError('出站请求已取消', 'EGRESS_ABORTED');
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new EgressError('出站 URL 格式不正确', 'EGRESS_URL_DENIED');
  }
  const originalOrigin = current.origin;
  let method = (init.method ?? 'GET').toUpperCase();
  let headers = new Headers(init.headers);
  let body = init.body;

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const resolved = await raceAbort(resolveOutboundUrl(current, options), signal, callerSignal);
      current = resolved.url;
      if (options.sameOriginOnly && current.origin !== originalOrigin) {
        throw new EgressError('重定向跨 origin，已拒绝且未外发凭证', 'EGRESS_REDIRECT_DENIED');
      }
      const transport = pinnedTransport(resolved, headers, options.proxyUrl);
      let response: Response;
      try {
        response = await raceAbort(fetchImpl(transport.url, {
          ...init,
          method,
          headers: transport.headers,
          body,
          signal,
          redirect: 'manual',
          dispatcher: transport.dispatcher,
        }), signal, callerSignal);
      } catch (err) {
        await transport.dispatcher.destroy().catch(() => undefined);
        throw err;
      }
      const redirect = REDIRECT_STATUSES.has(response.status);
      if (redirect && options.followRedirects !== false && init.redirect !== 'manual') {
        try {
          const location = response.headers.get('location');
          void response.body?.cancel().catch(() => undefined);
          if (init.redirect === 'error') throw new EgressError('调用方禁止重定向', 'EGRESS_REDIRECT_DENIED');
          if (!location) throw new EgressError(`HTTP ${response.status} 重定向缺少 Location`, 'EGRESS_REDIRECT_DENIED');
          if (hop === maxRedirects) throw new EgressError('出站重定向次数过多', 'EGRESS_REDIRECT_LIMIT');
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new EgressError('重定向 Location 不是合法 URL', 'EGRESS_REDIRECT_DENIED');
          }
          if (options.sameOriginOnly && next.origin !== originalOrigin) {
            throw new EgressError('重定向跨 origin，已拒绝且未外发凭证', 'EGRESS_REDIRECT_DENIED');
          }
          if (next.origin !== current.origin) headers = withoutCrossOriginCredentials(headers);
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
            headers.delete('content-length');
            headers.delete('content-type');
          }
          current = next;
        } finally {
          await transport.dispatcher.destroy().catch(() => undefined);
        }
        continue;
      }
      try {
        const bytes = await readCappedBody(response, maxBytes, signal, callerSignal);
        const noBody = response.status === 204 || response.status === 205 || response.status === 304;
        return new Response(noBody ? null : bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } finally {
        await transport.dispatcher.destroy().catch(() => undefined);
      }
    }
    throw new EgressError('出站重定向次数过多', 'EGRESS_REDIRECT_LIMIT');
  } catch (err) {
    if (err instanceof EgressError) throw err;
    if (signal.aborted) throw abortError(signal, callerSignal);
    throw new EgressError(`出站请求失败：${err instanceof Error ? err.message : '网络不可达'}`, 'EGRESS_NETWORK', err);
  }
}
