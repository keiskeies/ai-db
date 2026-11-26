import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test, { afterEach } from 'node:test';

type ApiModule = typeof import('../src/lib/api');
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let importGeneration = 0;

function setGlobal(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function storage(initial: Record<string, string> = {}, blocked = false) {
  const values = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  const removals: string[] = [];
  return {
    values,
    writes,
    removals,
    getItem(key: string) {
      if (blocked) throw new Error('storage blocked');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (blocked) throw new Error('storage blocked');
      writes.push([key, value]);
      values.set(key, value);
    },
    removeItem(key: string) {
      if (blocked) throw new Error('storage blocked');
      removals.push(key);
      values.delete(key);
    },
  };
}

function installWeb(start: string, opts: { local?: ReturnType<typeof storage>; session?: ReturnType<typeof storage> } = {}) {
  const local = opts.local ?? storage({ 'aidb.token': 'legacy-persistent-token' });
  const session = opts.session ?? storage();
  let current = new URL(start);
  const replacements: string[] = [];
  const location = {
    get hash() { return current.hash; },
    get search() { return current.search; },
    get pathname() { return current.pathname; },
  };
  setGlobal('window', {});
  setGlobal('location', location);
  setGlobal('localStorage', local);
  setGlobal('sessionStorage', session);
  setGlobal('history', {
    state: { preserved: true },
    replaceState(_state: unknown, _title: string, next: string) {
      replacements.push(next);
      current = new URL(next, current.origin);
    },
  });
  return {
    local,
    session,
    replacements,
    get url() { return current; },
    setUrl(next: string) { current = new URL(next, current.origin); },
  };
}

function installElectron(start = 'https://desktop.test/') {
  const web = installWeb(start);
  let listener: ((event: { type?: unknown; token?: unknown }) => void) | undefined;
  setGlobal('window', {
    aidbDesktop: {
      onGatewayEvent(callback: typeof listener) {
        listener = callback;
        return () => { listener = undefined; };
      },
    },
  });
  return {
    local: web.local,
    session: web.session,
    replacements: web.replacements,
    setUrl: web.setUrl,
    get url() { return web.url; },
    emit: (event: { type?: unknown; token?: unknown }) => listener?.(event),
  };
}

async function importApi(): Promise<ApiModule> {
  return import(`../src/lib/api.ts?security-test=${++importGeneration}`) as Promise<ApiModule>;
}

afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as any)[name];
  }
  originalGlobals.clear();
});

test('桌面 Web 从 hash 接收 token 后立即清理 URL，只保留 sessionStorage 并迁移删除旧 localStorage', async () => {
  const env = installWeb('https://desktop.test/studio?view=data#token=url-token&tab=query');
  const api = await importApi();

  assert.equal(api.TOKEN, 'url-token');
  assert.equal(api.authToken(), 'url-token');
  assert.equal(env.session.values.get('aidb.session.token'), 'url-token');
  assert.equal(env.local.values.has('aidb.token'), false);
  assert.deepEqual(env.replacements, ['/studio?view=data#tab=query']);
  assert.equal(env.url.hash, '#tab=query');
  assert.equal(JSON.stringify(env.replacements).includes('url-token'), false);

  env.setUrl('/studio?view=data#tab=query');
  const reloaded = await importApi();
  assert.equal(reloaded.TOKEN, 'url-token', '同一标签页重载从 sessionStorage 恢复');
  assert.equal(env.local.values.has('aidb.token'), false);
});

test('clearSessionToken 清内存、sessionStorage、旧 localStorage 和 URL 中迟到的 token', async () => {
  const env = installWeb('https://desktop.test/#token=first');
  const api = await importApi();
  env.setUrl('/#token=late&keep=1');

  api.clearSessionToken();

  assert.equal(api.TOKEN, '');
  assert.equal(api.authToken(), '');
  assert.equal(env.session.values.size, 0);
  assert.equal(env.local.values.size, 0);
  assert.equal(env.url.hash, '#keep=1');
  assert.equal(JSON.stringify(env.replacements).includes('late'), false);
});

test('浏览器禁用 sessionStorage 时仍使用内存令牌并清理 hash，不退回 localStorage', async () => {
  const env = installWeb('https://desktop.test/#token=memory-only', {
    local: storage({}, true),
    session: storage({}, true),
  });
  const api = await importApi();

  assert.equal(api.TOKEN, 'memory-only');
  assert.equal(env.url.hash, '');
  assert.deepEqual(env.replacements, ['/']);
});

test('Electron 只经现有 Bridge 接收内存 token；首轮请求等待交付且不写任何持久存储', async () => {
  const env = installElectron();
  const api = await importApi();
  const calls: Array<{ url: string; authorization: string }> = [];
  setGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: String((init?.headers as Record<string, string>)?.authorization ?? '') });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  assert.equal(api.TOKEN, '');
  assert.equal(typeof api.api?.health, 'function', `API exports: ${Object.keys(api).join(', ')}`);
  const pending = api.api.health();
  await Promise.resolve();
  assert.deepEqual(calls, [], 'dom-ready 前不能先发一个 Bearer 空令牌请求');

  env.emit({ type: 'token', token: 'bridge-token' });
  await pending;
  assert.deepEqual(calls, [{ url: '/api/health', authorization: 'Bearer bridge-token' }]);
  assert.equal(api.authToken(), 'bridge-token');
  assert.equal(env.session.writes.length, 0);
  assert.equal(env.local.writes.length, 0);
  assert.equal(env.session.values.size, 0);
  assert.equal(env.local.values.size, 0);

  env.emit({ type: 'token', token: 'rotated-token' });
  assert.equal(api.authToken(), 'rotated-token', '网关恢复后的新令牌使用 live binding');
  api.clearSessionToken();
  assert.equal(api.authToken(), '');
});

test('Electron 兼容读取旧 URL hash 后也立即清除，且不落 sessionStorage', async () => {
  const env = installElectron('https://desktop.test/#token=old-url-token&keep=1');
  const api = await importApi();

  assert.equal(api.TOKEN, 'old-url-token');
  assert.equal(env.url.hash, '#keep=1');
  assert.equal(env.session.writes.length, 0);
  assert.equal(env.local.writes.length, 0);
});

test('桌面 CSP 禁止内联/动态脚本与危险加载源，并保留 Vite、图片和打印所需能力', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const content = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/s)?.[1];
  assert.ok(content, 'index.html 必须声明 CSP');
  const directives = new Map(content.split(';').map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));

  assert.ok(directives.get("script-src")?.includes("'self'"));
  assert.equal(directives.get("script-src")?.includes("'unsafe-inline'"), false);
  assert.equal(directives.get("script-src")?.includes("'unsafe-eval'"), false);
  assert.equal(directives.get('object-src')?.join(' '), "'none'");
  assert.equal(directives.get('base-uri')?.join(' '), "'none'");
  // frame-ancestors 在 meta 中会被浏览器忽略；改由网关 HTTP 头下发，避免控制台告警。
  assert.equal(directives.has('frame-ancestors'), false);
  assert.ok(directives.get('connect-src')?.includes("'self'"));
  assert.ok(directives.get('connect-src')?.includes('ws://localhost:*'));
  assert.ok(directives.get('img-src')?.includes('blob:'));
  assert.ok(directives.get('frame-src')?.includes('blob:'));
  assert.ok(directives.get('worker-src')?.includes('blob:'));
  assert.ok(directives.get('style-src')?.includes("'unsafe-inline'"));

  const preamble = 'import { injectIntoGlobalHook } from "/@react-refresh";\n'
    + 'injectIntoGlobalHook(window);\n'
    + 'window.$RefreshReg$ = () => {};\n'
    + 'window.$RefreshSig$ = () => (type) => type;';
  const hash = createHash('sha256').update(preamble).digest('base64');
  assert.ok(directives.get('script-src')?.includes(`'sha256-${hash}'`), '只按哈希放行 Vite 的固定 React Refresh preamble');
});

test('Electron 外链只放行明确 HTTPS 主机白名单，拒绝危险 scheme、凭据、端口和伪装域名', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('const EXTERNAL_HTTPS_HOSTS');
  const end = main.indexOf('function readOpenTableArg', start);
  assert.ok(start >= 0 && end > start);
  const opened: string[] = [];
  const context = {
    URL,
    Promise,
    shell: { openExternal: async (url: string) => { opened.push(url); } },
  } as Record<string, unknown>;
  vm.runInNewContext(`${main.slice(start, end)}\nthis.allowed = isAllowedExternalUrl; this.open = openAllowedExternalUrl;`, context);
  const allowed = context.allowed as (url: string) => boolean;
  const open = context.open as (url: string) => boolean;

  for (const url of [
    'https://github.com/keiskeies/ai-db/issues/new',
    'https://platform.openai.com/api-keys',
    'https://API.SEARCH.BRAVE.COM/app/keys',
  ]) {
    assert.equal(allowed(url), true, url);
    assert.equal(open(url), true, url);
  }
  assert.deepEqual(opened, [
    'https://github.com/keiskeies/ai-db/issues/new',
    'https://platform.openai.com/api-keys',
    'https://API.SEARCH.BRAVE.COM/app/keys',
  ]);

  opened.length = 0;
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/system32/calc.exe',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
    'http://github.com/keiskeies/ai-db',
    'https://github.com.evil.test/',
    'https://evil.test@github.com/',
    'https://github.com:444/',
    'https://127.0.0.1/',
    '//github.com/keiskeies/ai-db',
    'not a url',
    '',
  ]) {
    assert.equal(allowed(url), false, url);
    assert.equal(open(url), false, url);
  }
  assert.deepEqual(opened, []);

  const handlerBody = main.match(/setWindowOpenHandler\(\(\{ url: target \}\) => \{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(handlerBody, '必须保留 setWindowOpenHandler');
  const handler = vm.runInNewContext(`({ url: target }) => {${handlerBody}}`, { openAllowedExternalUrl: open }) as (details: { url: string }) => { action: string };
  assert.equal(handler({ url: 'https://github.com/keiskeies/ai-db' }).action, 'deny');
  assert.equal(handler({ url: 'file:///C:/secret.txt' }).action, 'deny');
  assert.deepEqual(opened, ['https://github.com/keiskeies/ai-db'], '白名单也只交给系统浏览器，绝不在应用内创建窗口');
});

test('Electron 主进程不在 URL 中携带 token，dom-ready 与网关恢复都经现有 Bridge 更新内存令牌', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const createWindow = main.slice(main.indexOf('async function createWindow'), main.indexOf('// 启动健康检查超时'));
  assert.equal(createWindow.includes('#token='), false);
  assert.match(createWindow, /webContents\.on\('dom-ready', deliverToken\)/);
  assert.match(createWindow, /const deliverToken = \(\) => sendSessionToken\(sessionToken\)/);
  assert.match(main, /webContents\.send\('gateway:event', \{ type: 'token', token \}\)/);
  const restartAt = main.indexOf('async function attemptGatewayRestart');
  const tokenAt = main.indexOf('sendSessionToken(info.token)', restartAt);
  const recoveredAt = main.indexOf("{ type: 'recovered' }", restartAt);
  assert.ok(tokenAt > restartAt && recoveredAt > tokenAt, '恢复时先更新令牌，再通知界面重连');
});

test('桌面 Bridge 复用标准 known_hosts，文件缺失时不自动信任 SSH 主机', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf("const defaultKnownHosts = path.join");
  const end = main.indexOf('if (nodeBin) {', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /path\.join\(app\.getPath\('home'\), '\.ssh', 'known_hosts'\)/);
  assert.match(block, /!env\.AIDB_SSH_KNOWN_HOSTS_FILE && fs\.existsSync\(defaultKnownHosts\)/);
  assert.match(block, /env\.AIDB_SSH_KNOWN_HOSTS_FILE = defaultKnownHosts/);
});

test('Electron 主框架导航只允许可信本地 origin，开发 origin 与危险 scheme 边界明确', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('function isTrustedAppUrl');
  const end = main.indexOf('function readOpenTableArg', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL } as Record<string, unknown>;
  vm.runInNewContext(`${main.slice(start, end)}\nthis.trusted = isTrustedAppUrl; this.guard = guardMainFrameNavigation;`, context);
  const trusted = context.trusted as (target: string, origin: string) => boolean;
  const guard = context.guard as (event: { preventDefault(): void }, target: string, origin: string) => boolean;
  const origin = 'http://127.0.0.1:43127';
  const devOrigin = 'http://localhost:5180';

  assert.equal(trusted(`${origin}/studio?view=data#table`, origin), true);
  assert.equal(trusted('/studio', origin), true);
  assert.equal(trusted(`${devOrigin}/src/main.tsx`, devOrigin), true);
  for (const target of [
    'http://127.0.0.1:43128/',
    'http://localhost:43127/',
    'https://127.0.0.1:43127/',
    'http://evil.test/',
    'http://user@127.0.0.1:43127/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/system32/calc.exe',
    `blob:${origin}/id`,
    'about:blank',
  ]) {
    assert.equal(trusted(target, origin), false, target);
    let prevented = 0;
    assert.equal(guard({ preventDefault() { prevented += 1; } }, target, origin), false, target);
    assert.equal(prevented, 1, target);
  }

  const createWindow = main.slice(main.indexOf('async function createWindow'), main.indexOf('// 启动健康检查超时'));
  const loadAt = createWindow.indexOf('mainWindow.loadURL(url)');
  for (const marker of ["on('will-navigate'", "on('will-redirect'", "on('will-attach-webview'", 'setWindowOpenHandler']) {
    const at = createWindow.indexOf(marker);
    assert.ok(at >= 0 && at < loadAt, `${marker} 必须在首轮 loadURL 前安装`);
  }
});

test('Bridge 启动/复用只接受带本地 token 的 readiness，且不记录 token 或公开 health 回退', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const waitStart = main.indexOf('function waitForBridgeReady');
  const waitEnd = main.indexOf('// spawnSync', waitStart);
  assert.ok(waitStart >= 0 && waitEnd > waitStart);
  const wait = main.slice(waitStart, waitEnd);
  assert.match(wait, /\/api\/health\/ready/);
  assert.match(wait, /authorization: `Bearer \$\{token\}`/);
  assert.match(wait, /res\.statusCode === 200/);
  assert.match(wait, /const deadline = setTimeout/);
  assert.doesNotMatch(wait, /\/api\/health[`'"]|console\.(?:log|warn|error)/);
  assert.doesNotMatch(main, /waitForHealth\(/);

  const startup = main.slice(main.indexOf('async function startEmbeddedGateway'), main.indexOf('async function createWindow'));
  assert.match(startup, /waitForBridgeReady\(gatewayInfo\.port, gatewayInfo\.token\)/);
  assert.match(startup, /waitForBridgeReady\(port, token\)/);
  assert.match(startup, /gatewayProcess = null;\s*gatewayInfo = null;\s*child\.kill\(\)/);
});

test('Windows SSH 私钥 ACL 在写入/启动前收紧并复核，POSIX 权限路径保持不变', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const aclStart = main.indexOf('const WINDOWS_ACL_TIMEOUT_MS');
  const aclEnd = main.indexOf('// 渲染层生成菜单树', aclStart);
  assert.ok(aclStart >= 0 && aclEnd > aclStart);
  const acl = main.slice(aclStart, aclEnd);
  assert.match(acl, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(acl, /Get-Acl/);
  assert.match(acl, /AreAccessRulesProtected/);
  assert.match(acl, /S-1-5-18/);
  assert.match(acl, /S-1-5-32-544/);
  assert.doesNotMatch(acl, /S-1-1-0|S-1-5-11|S-1-5-32-545/);
  assert.match(acl, /SSH_KEY_ACL_UNAVAILABLE/);
  assert.match(acl, /if \(process\.platform !== 'win32'\) return/);
  assert.match(acl, /await hardenWindowsPrivateKeyPath\(directory, 'Directory'\)/);
  const writeAt = acl.indexOf('await sshKeyImport.importPrivateKeyFile');
  const fileAclAt = acl.indexOf("await hardenWindowsPrivateKeyPath(imported.path, 'File')");
  const cleanupAt = acl.indexOf('await fs.promises.unlink(imported.path)');
  assert.ok(writeAt >= 0 && fileAclAt > writeAt && cleanupAt > fileAclAt);

  const startup = main.slice(main.indexOf('async function startEmbeddedGateway'), main.indexOf('async function createWindow'));
  const ensureAt = startup.indexOf('await ensurePrivateKeyDirectory(userData)');
  const existingAt = startup.indexOf('await hardenExistingPrivateKeys(privateKeyDir)');
  const spawnAt = startup.indexOf('gatewayProcess = spawn');
  assert.ok(ensureAt >= 0 && existingAt > ensureAt && spawnAt > existingAt);
});
