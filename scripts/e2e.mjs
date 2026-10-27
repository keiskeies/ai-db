import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDist = join(root, 'apps', 'desktop', 'dist');
const mobileDist = join(root, 'apps', 'mobile', 'dist');
const gatewayEntry = join(root, 'apps', 'gateway', 'dist', 'index.js');
const shots = join(root, 'docs', 'screenshots');

for (const required of [desktopDist, mobileDist, gatewayEntry]) {
  if (!existsSync(required)) {
    console.error(`Missing build artifact: ${required}\nRun: npm run build`);
    process.exit(1);
  }
}

const TOKEN = 'e2e-token';
const home = mkdtempSync(join(tmpdir(), 'aidb-e2e-'));
const checks = [];
const consoleErrors = [];
const gatewayLogs = [];

const check = (name, condition, detail = '') => {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function freePort() {
  return new Promise((res, rej) => {
    const server = createNetServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => res(port));
    });
  });
}

async function waitHealth(url, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Bridge did not start: ${url}`);
}

const port = await freePort();
const gatewayEnv = { ...process.env, AIDB_HOME: home, AIDB_HOST: '127.0.0.1', AIDB_PORT: String(port), AIDB_TOKEN: TOKEN, AIDB_SECRET: 'e2e-secret', AIDB_STATIC_DIR: desktopDist, NODE_ENV: 'production' };
delete gatewayEnv.ELECTRON_RUN_AS_NODE;
const gateway = spawn(process.execPath, [gatewayEntry], { env: gatewayEnv, stdio: ['ignore', 'pipe', 'pipe'] });
gateway.stdout.on('data', (d) => gatewayLogs.push(String(d)));
gateway.stderr.on('data', (d) => gatewayLogs.push(String(d)));
const bridge = `http://127.0.0.1:${port}`;
await waitHealth(`${bridge}/api/health`);

const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const api = async (path, init = {}) => {
  const res = await fetch(`${bridge}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const boot = (await api('/bootstrap')).body;
const demo = boot.connections.find((c) => c.engine === 'sqlite');
check('bridge bootstrap', Boolean(demo), demo?.name);
check('22 agent tools', boot.tools.length === 22, String(boot.tools.length));

// Mobile static server
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf' };
const mobileServer = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  let file = resolve(join(mobileDist, pathname));
  if (!file.startsWith(mobileDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(mobileDist, 'index.html');
  res.setHeader('content-type', mime[extname(file)] ?? 'text/html; charset=utf-8');
  createReadStream(file).pipe(res);
});
const mobilePort = await freePort();
await new Promise((r) => mobileServer.listen(mobilePort, '127.0.0.1', r));
const mobileBase = `http://127.0.0.1:${mobilePort}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// ---------------- Desktop (browser, production build) ----------------
const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await desktopContext.newPage();
page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(`desktop: ${msg.text()}`));
page.on('pageerror', (err) => consoleErrors.push(`desktop: ${err.message}`));
await page.goto(`${bridge}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForTimeout(900);
check('desktop boots', (await page.locator('.conn-row').count()) >= 1);
const ribbonModules = await page.locator('[data-testid="ribbon"] .ribbon-btn').count();
check('ribbon exposes Navicat modules', ribbonModules >= 12, `${ribbonModules} modules`);
await page.screenshot({ path: join(shots, 'desktop-welcome.png') });

await page.click('[data-testid="sidebar-new-connection"]');
await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
const engineOptions = await page.locator('[data-testid="connection-engine"] option').count();
check('connection form lists 8 engines', engineOptions === 8, String(engineOptions));
await page.screenshot({ path: join(shots, 'desktop-connection-engines.png') });
await page.locator('.modal-head .icon-btn').click();
await page.waitForTimeout(200);

await page.click('[data-testid="ribbon"] button[title="视图"]');
await page.waitForSelector('.tools-modal', { timeout: 10000 });
const toolCount = await page.locator('.tools-nav button').count();
check('toolbox exposes Navicat productivity tools', toolCount >= 9, `${toolCount} tools`);
await page.locator('.tools-nav button').filter({ hasText: '数据库搜索' }).click();
await page.waitForSelector('.tools-content .search-box input', { timeout: 10000 });
await page.screenshot({ path: join(shots, 'desktop-toolbox.png') });
await page.locator('.tools-content .search-box input').fill('orders');
await page.keyboard.press('Enter');
await page.waitForTimeout(1600);
check('database-wide search works', (await page.locator('.tools-content .result-row').count()) > 0);
await page.locator('.tools-modal .modal-head .icon-btn').click();
await page.waitForTimeout(200);

await page.click('[data-testid="welcome-open-demo"]');
await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 15000 });
const gridRows = await page.locator('[data-testid="data-grid"] tbody tr').count();
check('data grid opens demo table', gridRows === 100, `${gridRows} rows`);
check('data grid shows row numbers', (await page.locator('[data-testid="grid-row-0"] td').first().innerText()) === '1');
await page.screenshot({ path: join(shots, 'desktop-data.png') });

await page.locator('[title="TABLE orders"]').click({ button: 'right' });
await page.waitForSelector('.context-menu', { timeout: 5000 });
const tableMenu = await page.locator('.context-menu').innerText();
check(
  'table context menu exposes Navicat operations',
  ['重命名表', '复制表', '清空表', '删除表', '维护表', '查看 DDL'].every((label) => tableMenu.includes(label)),
  tableMenu.replace(/\s+/g, ' ').slice(0, 120),
);
await page.locator('.context-menu').getByText('查看 DDL').click();
const ddlOk = await page
  .waitForFunction(() => document.querySelector('.ddl-block')?.textContent?.includes('CREATE TABLE'), { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
const ddlText = await page.locator('.ddl-block, .risk-banner').first().innerText().catch(() => '');
check('table DDL dialog renders create statement', ddlOk, ddlText.replace(/\s+/g, ' ').slice(0, 100));
await page.locator('.modal-head .icon-btn').click();
await page.waitForTimeout(250);

await page.locator('.db-node').first().click({ button: 'right' });
await page.waitForSelector('.context-menu', { timeout: 5000 });
const dbMenu = await page.locator('.context-menu').innerText();
check(
  'database context menu exposes database operations',
  ['新建数据库', '删除数据库', '转储 SQL 文件', '在数据库中查找'].every((label) => dbMenu.includes(label)),
  dbMenu.replace(/\s+/g, ' ').slice(0, 120),
);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

await page.locator('[data-testid="grid-row-0"] input[type="checkbox"]').click();
check('data row selection enables batch operations', (await page.locator('.data-toolbar-2').innerText()).includes('已选 1'));
await page.locator('[data-testid="grid-row-0"] input[type="checkbox"]').click();

await page.click('[data-testid="data-filter-builder"]');
await page.waitForSelector('.filter-rule', { timeout: 5000 });
await page.locator('.filter-rule select').first().selectOption('status');
await page.locator('.filter-rule .input').fill('completed');
await page.click('[data-testid="filter-apply"]');
await page.waitForTimeout(1200);
check('filter builder composes SQL filter', (await page.locator('[data-testid="data-filter"]').inputValue()).includes('status'));
await page.fill('[data-testid="data-filter"]', '');
await page.press('[data-testid="data-filter"]', 'Enter');
await page.waitForTimeout(800);
await page.click('[data-testid="data-find-replace"]');
await page.waitForSelector('[data-testid="replace-find"]', { timeout: 5000 });
check('find and replace dialog opens', true);
await page.locator('.modal-head .icon-btn').click();
await page.waitForTimeout(250);

await page.click('[data-testid="ribbon-new-query"]');
await page.waitForSelector('.cm-content');
check(
  'query window exposes connection and database selectors',
  (await page.locator('[data-testid="query-connection"]').count()) === 1 && (await page.locator('[data-testid="query-database"]').count()) === 1,
);
await page.locator('.cm-content').click();
await page.keyboard.type('SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC;');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('[data-testid="query-result-grid"]', { timeout: 20000 });
const queryRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
check('SQL editor runs with Ctrl+Enter', queryRows >= 4, `${queryRows} rows`);
await page.screenshot({ path: join(shots, 'desktop-query.png') });

await page.locator('.result-tab').filter({ hasText: '图表' }).click();
await page.waitForSelector('.query-chart-panel .chart-card', { timeout: 10000 });
check('query result renders a chart tab', true);
await page.screenshot({ path: join(shots, 'desktop-query-chart.png') });

await page.getByRole('button', { name: /AI 优化/ }).click();
await page.waitForTimeout(300);
const prefilled = await page.locator('[data-testid="agent-input"]').inputValue();
check('SQL Copilot prefills the agent', prefilled.includes('优化') && prefilled.includes('SELECT'), prefilled.slice(0, 60));

await page.fill('[data-testid="agent-input"]', '看看有哪些表');
await page.click('[data-testid="agent-send"]');
await page.waitForFunction(() => document.querySelector('.agent-transcript')?.textContent?.includes('张表'), { timeout: 25000 });
check('agent inspects schema', (await page.locator('[data-testid="tool-card"]').count()) > 0);
await page.screenshot({ path: join(shots, 'desktop-agent.png') });

await page.fill('[data-testid="agent-input"]', '创建表 e2e_tasks，包含 id 自增主键, title 文本');
await page.click('[data-testid="agent-send"]');
await page.waitForSelector('[data-testid="approval-allow-once"]', { timeout: 25000 });
check('DDL requires approval', true);
await page.screenshot({ path: join(shots, 'desktop-approval.png') });
await page.click('[data-testid="approval-allow-once"]');
await page.waitForFunction(() => document.querySelector('.agent-transcript')?.textContent?.includes('已创建表'), { timeout: 25000 });
const tablesAfter = await api(`/connections/${demo.id}/tables`);
check('agent DDL executed after approval', tablesAfter.body.tables.some((t) => t.name === 'e2e_tasks'));
await page.screenshot({ path: join(shots, 'desktop-agent-ddl.png') });

await page.fill('[data-testid="agent-input"]', '按 status 统计 orders 并画柱状图');
await page.click('[data-testid="agent-send"]');
await page.waitForSelector('.chart-card', { timeout: 25000 });
check('agent renders a chart artifact', (await page.locator('.chart-card svg, .chart-card .pie').count()) > 0);
await page.screenshot({ path: join(shots, 'desktop-chart.png') });

await page.fill('[data-testid="agent-input"]', '给数据库做一次体检');
await page.click('[data-testid="agent-send"]');
await page.waitForFunction(() => document.querySelector('.agent-transcript')?.textContent?.includes('体检完成'), { timeout: 30000 });
check('agent audit produces findings', (await page.locator('.finding').count()) > 0);
await page.screenshot({ path: join(shots, 'desktop-audit.png') });

await page.fill('[data-testid="agent-input"]', '记住：E2E 金额单位是分');
await page.click('[data-testid="agent-send"]');
await page.waitForFunction(() => document.querySelector('.agent-transcript')?.textContent?.includes('已记住'), { timeout: 25000 });
const memories = await api('/agent/memories?q=E2E');
check('mobile/desktop shared memory written', memories.body.memories.length > 0, `${memories.body.memories.length} memories`);

await page.click('[data-testid="open-settings"]');
await page.waitForSelector('[data-testid="settings-save"]', { timeout: 10000 });
check('settings modal opens', (await page.locator('.settings-modal').count()) === 1);
await page.screenshot({ path: join(shots, 'desktop-settings.png') });
await page.locator('.settings-modal .modal-head .icon-btn').click();
await page.waitForTimeout(300);

await page.click('[data-testid="theme-toggle"]');
await page.waitForTimeout(800);
check('theme toggles to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
await page.screenshot({ path: join(shots, 'desktop-light.png') });
await page.click('[data-testid="theme-toggle"]');
await page.waitForTimeout(600);

await page.click('[data-testid="agent-memory"]');
await page.waitForSelector('[data-testid="memory-drawer"]', { timeout: 10000 });
await page.waitForSelector('[data-testid="memory-drawer"] .memory-card', { timeout: 15000 }).catch(() => undefined);
check('memory drawer lists memories', (await page.locator('[data-testid="memory-drawer"] .memory-card').count()) > 0);
await page.screenshot({ path: join(shots, 'desktop-memory.png') });
await page.locator('[data-testid="memory-drawer"] .drawer-head .icon-btn').last().click();
await page.waitForTimeout(400);

await page.click('[data-testid="open-relations"]');
await page.waitForSelector('[data-testid="erd-canvas"]', { timeout: 10000 });
const erdNodes = await page.locator('.erd-node').count();
check('relationship diagram renders tables', erdNodes >= 5, `${erdNodes} nodes`);
await page.screenshot({ path: join(shots, 'desktop-relations.png') });
await page.locator('.tab.active .tab-close').click();

// ---------------- Mobile (Expo web build) ----------------
const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mobile = await mobileContext.newPage();
mobile.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(`mobile: ${msg.text()}`));
mobile.on('pageerror', (err) => consoleErrors.push(`mobile: ${err.message}`));
await mobile.goto(mobileBase, { waitUntil: 'networkidle' });
await mobile.waitForTimeout(1800);
const pairingText = await mobile.locator('body').innerText();
check('mobile pairing screen', pairingText.includes('Bridge 地址') && pairingText.includes('配对码'));
await mobile.screenshot({ path: join(shots, 'mobile-pairing.png') });

const pair = await api('/pair/start', { method: 'POST' });
check('pairing code issued', /^\d{6}$/.test(pair.body.code), pair.body.code);
await mobile.getByTestId('m-bridge-url').fill(bridge);
await mobile.getByTestId('m-pair-code').fill(pair.body.code);
await mobile.getByTestId('m-connect').click();
await mobile.waitForFunction(() => document.body.innerText.includes('Bridge 在线'), { timeout: 40000 });
await mobile.screenshot({ path: join(shots, 'mobile-chat.png') });
check('mobile pairs and connects via Bridge', true);

await mobile.getByTestId('m-chat-input').fill('看看有哪些表');
await mobile.getByTestId('m-send').click();
await mobile.waitForFunction(() => document.body.innerText.includes('张表'), { timeout: 30000 });
check('mobile agent answers', true);
await mobile.screenshot({ path: join(shots, 'mobile-agent.png') });

await mobile.getByTestId('m-tab-data').click();
await mobile.waitForSelector('[data-testid="m-table-orders"]', { timeout: 15000 });
await mobile.getByTestId('m-table-orders').click();
await mobile.waitForTimeout(1500);
check('mobile data is read-only', (await mobile.locator('body').innerText()).includes('只读'));
await mobile.screenshot({ path: join(shots, 'mobile-data.png') });

await mobile.getByTestId('m-tab-memory').click();
await mobile.waitForTimeout(1000);
await mobile.screenshot({ path: join(shots, 'mobile-memory.png') });
await mobile.getByTestId('m-tab-settings').click();
await mobile.waitForTimeout(700);
check('mobile settings shows Bridge and Agent', (await mobile.locator('body').innerText()).includes('BRIDGE'));
await mobile.screenshot({ path: join(shots, 'mobile-settings.png') });

// ---------------- Electron desktop shell ----------------
let electronBinary;
const candidates =
  process.platform === 'win32'
    ? [join(root, '.tools/electron45/node_modules/electron/dist/electron.exe'), join(root, 'node_modules/electron/dist/electron.exe')]
    : process.platform === 'darwin'
      ? [join(root, '.tools/electron45/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')]
      : [join(root, '.tools/electron45/node_modules/electron/dist/electron'), join(root, 'node_modules/electron/dist/electron')];
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    electronBinary = candidate;
    break;
  }
}
if (!electronBinary) {
  try {
    const { createRequire } = await import('node:module');
    const resolved = createRequire(import.meta.url)('electron');
    if (typeof resolved === 'string' && existsSync(resolved)) electronBinary = resolved;
  } catch {
    /* not installed */
  }
}
if (electronBinary) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let electronOk = false;
  let lastError = '';
  for (let attempt = 1; attempt <= 2 && !electronOk; attempt++) {
    let app;
    try {
      app = await electron.launch({ executablePath: electronBinary, args: [join(root, 'apps/desktop'), '--no-sandbox'], env, timeout: 90000 });
      const window = await app.firstWindow();
      await window.waitForSelector('[data-testid="app-root"]', { timeout: 45000 });
      await window.waitForTimeout(1500);
      electronOk = (await window.locator('.conn-row').count()) >= 1;
      if (electronOk) await window.screenshot({ path: join(shots, 'electron-desktop.png') });
      else lastError = 'no connections in Electron window';
      await app.close();
      app = undefined;
    } catch (err) {
      lastError = String(err).slice(0, 240);
      if (app) await app.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  check('electron shell boots with embedded bridge', electronOk, electronOk ? '' : lastError);
} else {
  console.log('SKIP  electron shell — no Electron binary installed');
}

// ---------------- Cleanup & report ----------------
await api('/ddl/execute', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, statements: ['DROP TABLE IF EXISTS "e2e_tasks"'] }) });
await desktopContext.close();
await mobileContext.close();
await browser.close();
await new Promise((r) => mobileServer.close(() => r()));
gateway.kill();
await new Promise((r) => setTimeout(r, 400));
rmSync(home, { recursive: true, force: true });

if (consoleErrors.length) {
  check('no browser console errors', false, consoleErrors.slice(0, 3).join(' | '));
} else {
  check('no browser console errors', true);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} E2E checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => `${f.name}${f.detail ? ` (${f.detail})` : ''}`).join('; '));
  if (gatewayLogs.length) console.log('gateway log tail:\n' + gatewayLogs.join('').slice(-1500));
  process.exit(1);
}
