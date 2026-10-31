import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  SearchBackendHealth,
  SearchBackendId,
  SearchBackendReport,
  SearchResponse,
  SearchResult,
  SearchSettings,
} from '@aidb/core';
import type { Store } from './store';

const SEARCH_KEYS = ['brave', 'tavily', 'serper', 'mojeek', 'deepseek', 'anthropic', 'openai', 'searxng'] as const;
type SearchKeyId = (typeof SEARCH_KEYS)[number];

export const SEARCH_BACKENDS: Array<{ id: SearchBackendId; label: string; needsKey: boolean; group: 'free' | 'key' }> = [
  { id: 'exa', label: 'Exa (MCP, 免费)', needsKey: false, group: 'free' },
  { id: 'parallel', label: 'Parallel (MCP, 免费)', needsKey: false, group: 'free' },
  { id: 'duckduckgo', label: 'DuckDuckGo (HTML)', needsKey: false, group: 'free' },
  { id: 'searxng', label: 'SearXNG (元搜索)', needsKey: false, group: 'free' },
  { id: 'brave', label: 'Brave Search', needsKey: true, group: 'key' },
  { id: 'tavily', label: 'Tavily (AI)', needsKey: true, group: 'key' },
  { id: 'serper', label: 'Serper.dev', needsKey: true, group: 'key' },
  { id: 'mojeek', label: 'Mojeek', needsKey: true, group: 'key' },
  { id: 'deepseek', label: 'DeepSeek', needsKey: true, group: 'key' },
  { id: 'anthropic', label: 'Anthropic', needsKey: true, group: 'key' },
  { id: 'openai', label: 'OpenAI', needsKey: true, group: 'key' },
];

const health = new Map<SearchBackendId, SearchBackendHealth>();

export class SearchError extends Error {
  constructor(message: string, readonly code = 'SEARCH_ERROR') {
    super(message);
    this.name = 'SearchError';
  }
}

function fail(message: string, code = 'SEARCH_ERROR'): never {
  throw new SearchError(message, code);
}

function healthOf(id: SearchBackendId): SearchBackendHealth {
  const current = health.get(id) ?? { id, status: 'idle', successes: 0, failures: 0 };
  health.set(id, current);
  return current;
}

export function searchHealth(): SearchBackendHealth[] {
  return SEARCH_BACKENDS.map((backend) => {
    const entry = healthOf(backend.id);
    return { ...entry };
  });
}

export function resetSearchHealth(): void {
  health.clear();
}

export function getSearchKey(store: Store, id: SearchKeyId): string | undefined {
  return store.getSearchApiKey(id);
}

function markSuccess(id: SearchBackendId, ms: number, count: number): void {
  const entry = healthOf(id);
  entry.status = 'ok';
  entry.lastMs = ms;
  entry.lastAt = new Date().toISOString();
  entry.lastError = undefined;
  entry.successes += 1;
  if (!count) entry.lastError = 'no results';
}

function markFailure(id: SearchBackendId, ms: number, error: string): void {
  const entry = healthOf(id);
  entry.status = 'error';
  entry.lastMs = ms;
  entry.lastAt = new Date().toISOString();
  entry.lastError = error.slice(0, 300);
  entry.failures += 1;
}

/* --------------------------------------------------------------- transport */

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') fail(`请求超时（${timeoutMs}ms）`, 'SEARCH_TIMEOUT');
    fail(`请求失败：${err?.message ?? url}`, 'SEARCH_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!response.ok) fail(`HTTP ${response.status}：${text.slice(0, 200)}`, 'SEARCH_HTTP_ERROR');
  try {
    return JSON.parse(text);
  } catch {
    fail(`返回不是 JSON：${text.slice(0, 120)}`, 'SEARCH_BAD_JSON');
  }
}

function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (isIP(value) === 6) return value === '::1' || value === '::' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
  return true;
}

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/(^|\.)(localhost|local|internal)$/i.test(host)) fail(`内网地址不可搜索：${host}`, 'SEARCH_URL_DENIED');
  if (isIP(host)) {
    if (isPrivateIp(host)) fail(`内网地址不可搜索：${host}`, 'SEARCH_URL_DENIED');
    return;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    fail(`域名解析失败：${host}`, 'SEARCH_DNS_FAILED');
  }
  for (const address of addresses) if (isPrivateIp(address.address)) fail(`域名解析到内网地址：${host}`, 'SEARCH_URL_DENIED');
}

/** SearXNG instances are user-configured; allow loopback only when explicitly configured. */
async function assertSearchEndpoint(url: URL, allowLoopback: boolean): Promise<void> {
  if (!allowLoopback) {
    await assertPublicHost(url);
    return;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return;
  await assertPublicHost(url);
}

/* --------------------------------------------------------------- remote MCP */

async function mcpSession(url: string, timeoutMs: number): Promise<{ session?: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'AiDB Studio', version: '0.1' } },
      }),
    },
    timeoutMs,
  );
  const session = response.headers.get('mcp-session-id') ?? undefined;
  const text = await response.text();
  const payload = ssePayload(text, response.headers.get('content-type') ?? '');
  try {
    const message = JSON.parse(payload);
    if (message.error) fail(message.error.message ?? 'MCP initialize 失败', 'SEARCH_MCP_ERROR');
  } catch {
    /* some servers return non-JSON; tools/call will surface the real error */
  }
  const next = { ...headers, ...(session ? { 'mcp-session-id': session } : {}), 'mcp-protocol-version': '2024-11-05' };
  await fetchWithTimeout(url, { method: 'POST', headers: next, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) }, timeoutMs).catch(() => undefined);
  return { session, headers: next };
}

function ssePayload(text: string, contentType: string): string {
  if (!contentType.includes('text/event-stream')) return text;
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('data: '));
  return lines.length ? lines[lines.length - 1].slice(6) : text;
}

async function mcpCall(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<any> {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }),
    },
    timeoutMs,
  );
  const text = await response.text();
  const payload = ssePayload(text, response.headers.get('content-type') ?? '');
  const message = JSON.parse(payload);
  if (message.error) fail(message.error.message ?? `MCP ${tool} 失败`, 'SEARCH_MCP_ERROR');
  return message.result;
}

function mcpText(result: any): string {
  return (result?.content ?? [])
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text)
    .join('\n');
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exa's search returns "Title / URL / Published / Highlights" blocks. */
export function parseExa(text: string, numResults: number): SearchResult[] {
  const blocks = text.split(/\n---+\n/).map((block) => block.trim()).filter(Boolean);
  const results: SearchResult[] = [];
  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim() ?? '';
    if (!url) continue;
    const highlights = block.match(/Highlights:\s*([\s\S]+)$/)?.[1]?.trim() ?? '';
    results.push({ title: title || url, url, snippet: stripMarkdown(highlights).slice(0, 400), source: 'exa' });
    if (results.length >= numResults) break;
  }
  return results;
}

async function searchExa(query: string, settings: SearchSettings): Promise<SearchResult[]> {
  const { headers } = await mcpSession('https://mcp.exa.ai/mcp', settings.timeoutMs);
  const text = mcpText(await mcpCall('https://mcp.exa.ai/mcp', 'web_search_exa', {
    query,
    objective: `Find authoritative, current pages that answer: ${query}`,
    numResults: settings.numResults,
  }, settings.timeoutMs, headers));
  return parseExa(text, settings.numResults);
}

async function searchParallel(query: string, settings: SearchSettings): Promise<SearchResult[]> {
  const { headers } = await mcpSession('https://search.parallel.ai/mcp', settings.timeoutMs);
  const text = mcpText(await mcpCall('https://search.parallel.ai/mcp', 'web_search', {
    objective: `Find authoritative, current pages that answer: ${query}`,
    search_queries: [query.slice(0, 80)],
    session_id: `aidb-${randomUUID()}`,
  }, settings.timeoutMs, headers));
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return (parsed.results ?? []).slice(0, settings.numResults).map((item: any) => ({
    title: String(item.title ?? item.url ?? ''),
    url: String(item.url ?? ''),
    snippet: String((item.excerpts ?? []).join(' ') ?? '').slice(0, 400),
    source: 'parallel',
    publishedAt: item.publish_date ?? undefined,
  })).filter((item: SearchResult) => item.url);
}

/* --------------------------------------------------------------- DDG / SearXNG */

export function parseDuckDuckGo(html: string, numResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && results.length < numResults) {
    const href = decodeHtml(match[1]);
    const target = href.startsWith('//duckduckgo.com/l/') ? new URL(href, 'https://duckduckgo.com').searchParams.get('uddg') : href;
    if (!target) continue;
    const title = stripMarkdown(decodeHtml(match[2].replace(/<[^>]+>/g, '')));
    const snippetMatch = html.slice(match.index, match.index + 800).match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    results.push({ title: title || target, url: target, snippet: snippetMatch ? stripMarkdown(decodeHtml(snippetMatch[1].replace(/<[^>]+>/g, ''))).slice(0, 400) : '', source: 'duckduckgo' });
  }
  return results;
}

async function searchDuckDuckGo(query: string, settings: SearchSettings): Promise<SearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      accept: 'text/html',
      ...(settings.language ? { 'accept-language': settings.language } : {}),
    },
  }, settings.timeoutMs);
  if (!response.ok) fail(`HTTP ${response.status}`, 'SEARCH_HTTP_ERROR');
  return parseDuckDuckGo(await response.text(), settings.numResults);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

async function searchSearxng(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const base = (settings.searxngBaseUrl || 'https://searx.be').replace(/\/+$/, '');
  const url = new URL(`${base}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  if (settings.language) url.searchParams.set('language', settings.language);
  if (settings.timeRange !== 'any') url.searchParams.set('time_range', settings.timeRange);
  if (settings.safeSearch) url.searchParams.set('safesearch', '1');
  await assertSearchEndpoint(url, /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(base));
  const key = getSearchKey(store, 'searxng');
  const response = await fetchWithTimeout(url.toString(), {
    headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  }, settings.timeoutMs);
  const body = await readJson(response);
  return (body.results ?? []).slice(0, settings.numResults).map((item: any) => ({
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.content ?? '').slice(0, 400),
    source: 'searxng',
    publishedAt: item.publishedDate ?? undefined,
    score: typeof item.score === 'number' ? item.score : undefined,
  })).filter((item: SearchResult) => item.url);
}

/* --------------------------------------------------------------- keyed APIs */

async function searchBrave(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const key = getSearchKey(store, 'brave');
  if (!key) fail('未配置 Brave API Key', 'SEARCH_KEY_MISSING');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(settings.numResults));
  url.searchParams.set('safesearch', settings.safeSearch ? 'strict' : 'off');
  if (settings.language) url.searchParams.set('search_lang', settings.language);
  if (settings.timeRange !== 'any') url.searchParams.set('freshness', settings.timeRange === 'day' ? 'pd' : settings.timeRange === 'week' ? 'pw' : settings.timeRange === 'month' ? 'pm' : 'py');
  const response = await fetchWithTimeout(url.toString(), { headers: { accept: 'application/json', 'x-subscription-token': key } }, settings.timeoutMs);
  const body = await readJson(response);
  return (body.web?.results ?? []).slice(0, settings.numResults).map((item: any) => ({
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.description ?? '').slice(0, 400),
    source: 'brave',
    publishedAt: item.page_age ?? undefined,
  })).filter((item: SearchResult) => item.url);
}

async function searchTavily(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const key = getSearchKey(store, 'tavily');
  if (!key) fail('未配置 Tavily API Key', 'SEARCH_KEY_MISSING');
  const response = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: settings.numResults, search_depth: 'basic', include_answer: false }),
  }, settings.timeoutMs);
  const body = await readJson(response);
  return (body.results ?? []).slice(0, settings.numResults).map((item: any) => ({
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.content ?? '').slice(0, 400),
    source: 'tavily',
    score: typeof item.score === 'number' ? item.score : undefined,
  })).filter((item: SearchResult) => item.url);
}

async function searchSerper(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const key = getSearchKey(store, 'serper');
  if (!key) fail('未配置 Serper API Key', 'SEARCH_KEY_MISSING');
  const response = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ q: query, num: settings.numResults, ...(settings.language ? { hl: settings.language } : {}), ...(settings.timeRange !== 'any' ? { tbs: `qdr:${settings.timeRange === 'day' ? 'd' : settings.timeRange === 'week' ? 'w' : settings.timeRange === 'month' ? 'm' : 'y'}` } : {}) }),
  }, settings.timeoutMs);
  const body = await readJson(response);
  return (body.organic ?? []).slice(0, settings.numResults).map((item: any) => ({
    title: String(item.title ?? ''),
    url: String(item.link ?? ''),
    snippet: String(item.snippet ?? '').slice(0, 400),
    source: 'serper',
    publishedAt: item.date ?? undefined,
  })).filter((item: SearchResult) => item.url);
}

async function searchMojeek(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const key = getSearchKey(store, 'mojeek');
  if (!key) fail('未配置 Mojeek API Key', 'SEARCH_KEY_MISSING');
  const url = new URL('https://api.mojeek.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', key);
  url.searchParams.set('fmt', 'json');
  const response = await fetchWithTimeout(url.toString(), { headers: { accept: 'application/json' } }, settings.timeoutMs);
  const body = await readJson(response);
  return (body.response?.results ?? body.results ?? []).slice(0, settings.numResults).map((item: any) => ({
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.desc ?? item.snippet ?? '').slice(0, 400),
    source: 'mojeek',
  })).filter((item: SearchResult) => item.url);
}

async function searchDeepseek(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const key = getSearchKey(store, 'deepseek');
  if (!key) fail('未配置 DeepSeek API Key', 'SEARCH_KEY_MISSING');
  const response = await fetchWithTimeout('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, count: settings.numResults, need_content: false }),
  }, settings.timeoutMs);
  const body = await readJson(response);
  return (body.results ?? []).slice(0, settings.numResults).map((item: any) => ({
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.snippet ?? item.summary ?? '').slice(0, 400),
    source: 'deepseek',
    publishedAt: item.date ?? undefined,
    score: typeof item.rerank_score === 'number' ? item.rerank_score : undefined,
  })).filter((item: SearchResult) => item.url);
}

/** Anthropic's hosted web_search tool returns citations inside text blocks. */
async function searchAnthropic(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const key = getSearchKey(store, 'anthropic');
  if (!key) fail('未配置 Anthropic API Key', 'SEARCH_KEY_MISSING');
  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: settings.anthropicModel || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `Search the web and summarize authoritative sources for: ${query}` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    }),
  }, settings.timeoutMs);
  const body = await readJson(response);
  const results: SearchResult[] = [];
  for (const block of body.content ?? []) {
    if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item?.type !== 'web_search_result' || typeof item.url !== 'string') continue;
        results.push({ title: String(item.title ?? item.url), url: item.url, snippet: String(item.encrypted_content ?? item.page_age ?? '').slice(0, 200), source: 'anthropic', publishedAt: item.page_age ?? undefined });
      }
    }
  }
  return results.slice(0, settings.numResults);
}

/** OpenAI Responses API web_search tool; citations live in annotations. */
async function searchOpenai(query: string, settings: SearchSettings, store: Store): Promise<SearchResult[]> {
  const key = getSearchKey(store, 'openai');
  if (!key) fail('未配置 OpenAI API Key', 'SEARCH_KEY_MISSING');
  const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: settings.openaiModel || 'gpt-5.1',
      input: `Search the web and summarize authoritative sources for: ${query}`,
      tools: [{ type: 'web_search' }],
    }),
  }, settings.timeoutMs);
  const body = await readJson(response);
  const results: SearchResult[] = [];
  for (const output of body.output ?? []) {
    for (const content of output?.content ?? []) {
      for (const annotation of content?.annotations ?? []) {
        if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string') continue;
        results.push({ title: String(annotation.title ?? annotation.url), url: annotation.url, snippet: String(content.text ?? '').slice(0, 300), source: 'openai' });
      }
    }
  }
  return results.slice(0, settings.numResults);
}

/* --------------------------------------------------------------- orchestration */

type BackendFn = (query: string, settings: SearchSettings, store: Store) => Promise<SearchResult[]>;

const BACKENDS: Record<SearchBackendId, BackendFn> = {
  exa: (query, settings) => searchExa(query, settings),
  parallel: (query, settings) => searchParallel(query, settings),
  duckduckgo: (query, settings) => searchDuckDuckGo(query, settings),
  searxng: (query, settings, store) => searchSearxng(query, settings, store),
  brave: (query, settings, store) => searchBrave(query, settings, store),
  tavily: (query, settings, store) => searchTavily(query, settings, store),
  serper: (query, settings, store) => searchSerper(query, settings, store),
  mojeek: (query, settings, store) => searchMojeek(query, settings, store),
  deepseek: (query, settings, store) => searchDeepseek(query, settings, store),
  anthropic: (query, settings, store) => searchAnthropic(query, settings, store),
  openai: (query, settings, store) => searchOpenai(query, settings, store),
};

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref)$/i.test(key)) url.searchParams.delete(key);
    }
    if (![...url.searchParams.keys()].length) url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

export async function runSearch(query: string, store: Store, overrides: Partial<SearchSettings> = {}): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) fail('query 不能为空', 'SEARCH_INVALID_INPUT');
  const settings = { ...store.getSettings().search, ...overrides };
  const enabled = (settings.enabled ?? []).filter((id) => BACKENDS[id]);
  if (!enabled.length) fail('没有启用任何搜索后端', 'SEARCH_NO_BACKENDS');
  const results: SearchResult[] = [];
  const reports: SearchBackendReport[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(settings.concurrency || 4, enabled.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= enabled.length) return;
      const id = enabled[index];
      const started = Date.now();
      try {
        const found = await BACKENDS[id](trimmed, settings, store);
        const ms = Date.now() - started;
        if (settings.healthTelemetry) markSuccess(id, ms, found.length);
        reports.push({ id, ok: true, count: found.length, ms });
        results.push(...found);
      } catch (err: any) {
        const ms = Date.now() - started;
        const message = err?.message ?? String(err);
        if (settings.healthTelemetry) markFailure(id, ms, message);
        reports.push({ id, ok: false, count: 0, ms, error: message });
      }
    }
  });
  await Promise.all(workers);
  const merged: SearchResult[] = [];
  const seen = new Set<string>();
  let deduped = 0;
  for (const item of results) {
    if (!item.url) continue;
    const key = settings.dedupe === 'none' ? `${item.url}#${item.source}` : normalizeUrl(item.url);
    if (settings.dedupe !== 'none' && seen.has(key)) {
      deduped += 1;
      const existing = merged.find((entry) => normalizeUrl(entry.url) === normalizeUrl(item.url));
      if (existing) existing.sources = [...new Set([...(existing.sources ?? [existing.source]), item.source])];
      continue;
    }
    seen.add(key);
    merged.push({ ...item, url: settings.dedupe === 'none' ? item.url : normalizeUrl(item.url), sources: [item.source] });
  }
  if (settings.rerank) {
    merged.sort((a, b) => {
      const scoreA = (a.score ?? 0) + (a.sources?.length ?? 0) * 0.1;
      const scoreB = (b.score ?? 0) + (b.sources?.length ?? 0) * 0.1;
      return scoreB - scoreA;
    });
  }
  return { query: trimmed, results: merged.slice(0, settings.numResults), backends: reports, total: results.length, deduped };
}

/* --------------------------------------------------------------- health probe */

export async function probeSearchBackend(id: SearchBackendId, store: Store): Promise<SearchBackendHealth> {
  const settings = store.getSettings().search;
  const started = Date.now();
  try {
    const found = await BACKENDS[id]('OpenAI', settings, store);
    markSuccess(id, Date.now() - started, found.length);
  } catch (err: any) {
    markFailure(id, Date.now() - started, err?.message ?? String(err));
  }
  return { ...healthOf(id) };
}

/* --------------------------------------------------------------- CLI helpers (unused by UI) */

export function searchBackendNeedsKey(id: SearchBackendId): boolean {
  return SEARCH_BACKENDS.find((backend) => backend.id === id)?.needsKey ?? false;
}