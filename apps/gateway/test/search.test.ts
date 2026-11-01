import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-search-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'search-secret',
  token: 'search-token',
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
const port = await listenRandom(gateway.server);
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
const headers = { 'content-type': 'application/json', authorization: 'Bearer search-token' };

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

test('搜索设置默认启用三个实测可达的免密钥后端，并加密保存 Key', async () => {
  const settings = gateway.store.getSettings();
  assert.deepEqual(settings.search.enabled, ['exa', 'parallel', 'bing']);
  assert.equal(settings.search.numResults, 8);
  assert.equal(settings.search.dedupe, 'url');
  const listed: any = await fetch(`${base}/api/search/backends`, { headers }).then((res) => res.json());
  assert.equal(listed.backends.length, 12);
  assert.equal(listed.backends.filter((item: any) => item.group === 'free').length, 5);
  assert.equal(listed.backends.filter((item: any) => item.group === 'key').length, 7);

  const saved: any = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ search: { ...settings.search, searchKeys: { brave: 'brave-test-key' } } }),
  }).then((res) => res.json());
  assert.equal(saved.settings.search.keyStatus.brave, true);
  assert.equal(JSON.stringify(saved.settings).includes('brave-test-key'), false);
  assert.equal(gateway.store.getSearchApiKey('brave'), 'brave-test-key');
});

test('聚合搜索聚合去重，并隔离失败后端', async () => {
  // A local SearXNG-compatible endpoint proves the JSON search path without touching the internet.
  const searx = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/search') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [
        { title: 'Alpha result', url: 'https://example.com/a?utm_source=x', content: 'alpha snippet', score: 2 },
        { title: 'Duplicate result', url: 'https://example.com/a', content: 'dup snippet', score: 1 },
        { title: 'Beta result', url: 'https://example.com/b', content: 'beta snippet', score: 3 },
      ] }));
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  const searxPort = await listenRandom(searx, '127.0.0.1');
  gateway.store.saveSearchKeys({ brave: '__CLEAR__' });
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({
    ...settings,
    search: {
      ...settings.search,
      enabled: ['searxng', 'brave'],
      searxngBaseUrl: `http://127.0.0.1:${searxPort}`,
      numResults: 5,
      healthTelemetry: true,
    },
  });
  const response = await fetch(`${base}/api/search/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'alpha beta' }),
  });
  const body: any = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].url.includes('utm_source'), false);
  assert.equal(body.results[0].sources.includes('searxng'), true);
  assert.equal(body.deduped >= 1, true);
  const brave = body.backends.find((item: any) => item.id === 'brave');
  assert.equal(brave.ok, false);
  assert.match(brave.error, /API Key/);
  searx.close();
});

test('web_search 工具读取同一套搜索设置', async () => {
  gateway.store.saveSearchKeys({ brave: '__CLEAR__' });
  const settings = gateway.store.getSettings();
  const web = gateway.store.listMcpServers().find((server) => server.builtin === 'web')!;
  gateway.store.updateMcpServer(web.id, { enabled: true });
  gateway.store.saveSettings({ ...settings, search: { ...settings.search, enabled: ['brave'] } });
  const executor = new (await import('../src/executor')).ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());
  const result = await executor.execute(
    { id: 'search', name: 'mcp_call', args: { server: 'builtin-web', tool: 'web_search', arguments: { query: 'test' } } },
    { sessionId: 'search-test' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'SEARCH_ALL_FAILED');
  assert.match(result.error?.message ?? '', /Brave API Key/);
});

test('解析 MCP 与 HTML 返回的搜索结果', async () => {
  const { parseExa, parseDuckDuckGo, parseBingRss } = await import('../src/search');
  const exa = parseExa(
    ['Title: First result', 'URL: https://example.com/one', 'Published: 2026-01-02', 'Highlights: **bold** [link](https://x)', '', '---', '', 'Title: Second', 'URL: https://example.com/two', 'Highlights: plain'].join('\n'),
    5,
  );
  assert.equal(exa.length, 2);
  assert.equal(exa[0].title, 'First result');
  assert.equal(exa[0].snippet, 'bold link');
  assert.equal(exa[0].source, 'exa');

  const html = [
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dddg">Alpha &amp; one</a>',
    '<a class="result__snippet" href="#">Alpha <b>snippet</b></a>',
    '<a class="result__a" href="https://example.com/b">Beta</a>',
    '<div class="result__snippet">Beta snippet</div>',
  ].join('\n');
  const ddg = parseDuckDuckGo(html, 5);
  assert.equal(ddg.length, 2);
  assert.equal(ddg[0].url, 'https://example.com/a?utm_source=ddg');
  assert.equal(ddg[0].title, 'Alpha & one');
  assert.match(ddg[0].snippet, /Alpha snippet/);
  assert.equal(ddg[1].url, 'https://example.com/b');
  assert.equal(ddg[0].source, 'duckduckgo');
  assert.equal(parseDuckDuckGo(html, 1).length, 1);

  // 必应 RSS 的 pubDate 跟随站点语言，中文节点必须能换算成 ISO 时间，否则时间范围过滤失效。
  const rss = [
    '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>',
    '<item><title><![CDATA[数据库 &amp; 概念]]></title><link>https://example.com/a?q=1&amp;x=2</link>',
    '<description><![CDATA[<p>中文 摘要</p>]]></description><pubDate>周二, 29 10月 2026 15:05:00 GMT</pubDate></item>',
    '<item><title>English date</title><link>https://example.com/b</link><description>plain</description>',
    '<pubDate>Thu, 29 Oct 2026 15:05:00 GMT</pubDate></item>',
    '<item><title>无链接</title><link>/relative</link><description>skip</description></item>',
    '</channel></rss>',
  ].join('\n');
  const bing = parseBingRss(rss, 5);
  assert.equal(bing.length, 2);
  assert.equal(bing[0].url, 'https://example.com/a?q=1&x=2');
  assert.equal(bing[0].title, '数据库 & 概念');
  assert.equal(bing[0].snippet, '中文 摘要');
  assert.equal(bing[0].source, 'bing');
  assert.equal(bing[0].publishedAt, '2026-10-29T15:05:00.000Z');
  assert.equal(bing[1].publishedAt, '2026-10-29T15:05:00.000Z');
  assert.equal(parseBingRss(rss, 1).length, 1);
});

test('旧版默认后端列表迁移为新默认，手动选择保持不变', async () => {
  const settings = gateway.store.getSettings();
  const saved: any = gateway.store.saveSettings({
    ...settings,
    search: { ...settings.search, enabled: ['exa', 'parallel', 'duckduckgo', 'searxng'], searxngBaseUrl: 'https://searx.be' },
  });
  assert.deepEqual(saved.search.enabled, ['exa', 'parallel', 'bing']);
  assert.equal(saved.search.searxngBaseUrl, '');
  const probed: any = await fetch(`${base}/api/search/backends/searxng/probe`, { method: 'POST', headers }).then((res) => res.json());
  assert.equal(probed.health.status, 'error');
  assert.match(probed.health.lastError, /自建/);

  const manual: any = gateway.store.saveSettings({
    ...settings,
    search: { ...settings.search, enabled: ['bing', 'duckduckgo'] },
  });
  assert.deepEqual(manual.search.enabled, ['bing', 'duckduckgo']);
});

test('出站代理按请求注入：代理不可达时报错而不是悄悄直连', async () => {
  // 本地 SearXNG mock 直连可用；填一个不存在的代理后必须失败，证明 dispatcher 真的生效。
  const mock = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: [{ title: 'Mock', url: 'https://example.com/mock', content: 'snippet' }] }));
  });
  const mockPort = await listenRandom(mock, '127.0.0.1');
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({
    ...settings,
    search: { ...settings.search, proxyUrl: 'http://127.0.0.1:1', searxngBaseUrl: `http://127.0.0.1:${mockPort}` },
  });
  const probed: any = await fetch(`${base}/api/search/backends/searxng/probe`, { method: 'POST', headers }).then((res) => res.json());
  assert.equal(probed.health.status, 'error');
  assert.match(probed.health.lastError, /经代理 http:\/\/127\.0\.0\.1:1/);

  gateway.store.saveSettings({ ...gateway.store.getSettings(), search: { ...gateway.store.getSettings().search, proxyUrl: 'socks5://127.0.0.1:7891' } });
  const direct: any = await fetch(`${base}/api/search/backends/searxng/probe`, { method: 'POST', headers }).then((res) => res.json());
  assert.equal(direct.health.status, 'ok', direct.health.lastError ?? 'ok');
  assert.equal(direct.health.successes >= 1, true);

  const cleared = gateway.store.getSettings();
  gateway.store.saveSettings({ ...cleared, search: { ...cleared.search, proxyUrl: '', searxngBaseUrl: '' } });
  mock.close();
});

test('自建 SearXNG：time_range 空结果回退重试，参数错误要可见', async () => {
  const seen: string[][] = [];
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push([...url.searchParams.keys()]);
    res.setHeader('content-type', 'application/json');
    if (url.searchParams.get('language') === 'bad') return void res.end(JSON.stringify({ error: 'Invalid value bad for parameter language' }));
    if (url.searchParams.has('time_range')) return void res.end(JSON.stringify({ results: [] }));
    res.end(JSON.stringify({ results: [{ title: 'Hit', url: 'https://example.com/hit', content: 'snippet', score: 1 }] }));
  });
  const port = await listenRandom(srv, '127.0.0.1');
  const search = { ...gateway.store.getSettings().search, enabled: ['searxng'] as any, searxngBaseUrl: `http://127.0.0.1:${port}`, timeRange: 'week' as const, safeSearch: false, language: '' };
  gateway.store.saveSettings({ ...gateway.store.getSettings(), search });
  const fell: any = await fetch(`${base}/api/search/query`, { method: 'POST', headers, body: JSON.stringify({ query: 'postgres' }) }).then((res) => res.json());
  assert.equal(fell.backends[0].ok, true);
  assert.equal(fell.results[0].url, 'https://example.com/hit');
  assert.equal(fell.results[0].score, 1);
  assert.equal(seen[0].includes('safesearch'), true, '安全搜索关掉也要显式下发');
  assert.equal(seen[1].includes('time_range'), false, '回退请求应去掉 time_range');

  gateway.store.saveSettings({ ...gateway.store.getSettings(), search: { ...search, timeRange: 'any', language: 'bad' } });
  const bad: any = await fetch(`${base}/api/search/query`, { method: 'POST', headers, body: JSON.stringify({ query: 'postgres' }) }).then((res) => res.json());
  assert.equal(bad.backends[0].ok, false);
  assert.match(bad.backends[0].error, /SearXNG：Invalid value bad/);

  const restored = gateway.store.getSettings();
  gateway.store.saveSettings({ ...restored, search: { ...restored.search, enabled: ['searxng'], searxngBaseUrl: '', timeRange: 'any', language: '' } });
  srv.close();
});

test('健康遥测可探测也可重置', async () => {
  gateway.store.saveSearchKeys({ brave: '__CLEAR__' });  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, search: { ...settings.search, enabled: ['brave'], healthTelemetry: true } });
  await fetch(`${base}/api/search/backends/reset`, { method: 'POST', headers });

  const probed: any = await fetch(`${base}/api/search/backends/brave/probe`, { method: 'POST', headers }).then((res) => res.json());
  assert.equal(probed.health.status, 'error');
  assert.match(probed.health.lastError, /API Key/);
  assert.equal(probed.health.failures, 1);

  const listed: any = await fetch(`${base}/api/search/backends`, { headers }).then((res) => res.json());
  assert.equal(listed.health.find((item: any) => item.id === 'brave').status, 'error');

  const reset: any = await fetch(`${base}/api/search/backends/reset`, { method: 'POST', headers }).then((res) => res.json());
  assert.equal(reset.health.find((item: any) => item.id === 'brave').status, 'idle');
  assert.equal(reset.health.find((item: any) => item.id === 'brave').failures, 0);
});
