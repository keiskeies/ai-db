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

test('搜索设置默认启用四个免密钥后端，并加密保存 Key', async () => {
  const settings = gateway.store.getSettings();
  assert.deepEqual(settings.search.enabled, ['exa', 'parallel', 'duckduckgo', 'searxng']);
  assert.equal(settings.search.numResults, 8);
  assert.equal(settings.search.dedupe, 'url');
  const listed: any = await fetch(`${base}/api/search/backends`, { headers }).then((res) => res.json());
  assert.equal(listed.backends.length, 11);
  assert.equal(listed.backends.filter((item: any) => item.group === 'free').length, 4);
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
  const { parseExa, parseDuckDuckGo } = await import('../src/search');
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
});

test('健康遥测可探测也可重置', async () => {
  gateway.store.saveSearchKeys({ brave: '__CLEAR__' });
  const settings = gateway.store.getSettings();
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
