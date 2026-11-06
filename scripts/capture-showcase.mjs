import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';

const root = process.cwd();
const outDir = join(root, 'docs', 'screenshots', 'showcase');
const framesRoot = join(root, '.capture-frames');
const home = join(root, '.capture-home');
const mobileDist = join(root, 'apps', 'mobile', 'dist');
const TOKEN = 'showcase-token';

for (const dir of [outDir, framesRoot]) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// A copy of the live workspace home keeps the encrypted model key + secret in sync,
// while leaving the user's sessions and locale untouched.
if (existsSync(home)) rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
for (const f of ['aidb.db', 'aidb.db-wal', 'aidb.db-shm', 'secret']) {
  const from = join(homedir(), '.aidb', f);
  if (existsSync(from)) cpSync(from, join(home, f));
}

const port = 8793;
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const gateway = spawn(process.execPath, [join(root, 'apps/gateway/dist/index.js')], {
  env: { ...process.env, AIDB_HOME: home, AIDB_PORT: String(port), AIDB_HOST: '127.0.0.1', AIDB_TOKEN: TOKEN, NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
gateway.stdout.on('data', (d) => process.stdout.write(`[gw] ${d}`));
gateway.stderr.on('data', (d) => process.stderr.write(`[gw!] ${d}`));

async function api(path, init = {}) {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

await api('/settings', { method: 'PUT', body: JSON.stringify({ locale: 'en', theme: 'dark', agent: { permissionMode: 'ask' } }) });
const conns = (await api('/connections')).body.connections;
const demo = conns.find((c) => c.engine === 'sqlite') ?? conns[0];
for (const c of conns) {
  if (c.id !== demo.id) await api(`/connections/${c.id}`, { method: 'DELETE' });
}
console.log('connection:', demo?.name, demo?.id);
const sessions = (await api('/agent/sessions')).body.sessions ?? [];
for (const s of sessions) await api(`/agent/sessions/${s.id}`, { method: 'DELETE' });
const memories = (await api('/agent/memories')).body.memories ?? [];
for (const m of memories) await api(`/agent/memories/${m.id}`, { method: 'DELETE' });
const cards = (await api(`/dashboards/cards?connectionId=${demo.id}`)).body.cards ?? [];
for (const c of cards) await api(`/dashboards/cards/${c.id}`, { method: 'DELETE' });

// Dashboard cards so the shot shows live SQL-backed visuals.
const dashSql = "SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS orders, ROUND(SUM(total_cents)/100.0, 2) AS revenue FROM orders GROUP BY month ORDER BY month";
await api('/dashboards/cards', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, title: 'Monthly revenue', sql: dashSql, chartType: 'line', timeColumn: 'month' }) });
await api('/dashboards/cards', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, title: 'Orders by status', sql: 'SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC', chartType: 'bar' }) });
await api('/dashboards/cards', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, title: 'Revenue by channel', sql: 'SELECT channel, ROUND(SUM(total_cents)/100.0, 2) AS revenue FROM orders GROUP BY channel ORDER BY revenue DESC', chartType: 'bar' }) });

const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const mobileServer = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  let file = resolve(join(mobileDist, pathname));
  if (!file.startsWith(mobileDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(mobileDist, 'index.html');
  res.setHeader('content-type', mime[extname(file)] ?? 'text/html; charset=utf-8');
  createReadStream(file).pipe(res);
});
const mobilePort = 5199;
await new Promise((r) => mobileServer.listen(mobilePort, '127.0.0.1', r));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const shotLog = [];

async function shot(page, name, opts = {}) {
  const file = join(outDir, name);
  try {
    await page.screenshot({ path: file, ...opts });
    shotLog.push(`${name} ✓`);
  } catch (err) {
    shotLog.push(`${name} ✗ ${err.message}`);
  }
}

const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await desktopContext.newPage();
page.on('console', (m) => m.type() === 'error' && errors.push(`desktop: ${m.text()}`));
page.on('pageerror', (e) => errors.push(`desktop: ${e.message}`));
await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 60000 });
await page.waitForTimeout(1200);

async function activateDemo() {
  const row = page.locator('.conn-row', { hasText: 'Demo · Shop DB' }).first();
  await row.waitFor({ timeout: 20000 });
  if (!(await page.locator('.conn-row.active').first().innerText().catch(() => '')).includes('Demo')) await row.click();
  await page.waitForTimeout(600);
}

async function openDemoTable() {
  await activateDemo();
  const homeRow = page.locator('[data-testid="welcome-table-orders"]');
  if (await homeRow.waitFor({ timeout: 8000 }).then(() => true, () => false)) { await homeRow.click(); return; }
  await page.click('[title="TABLE orders"]');
}

await activateDemo();
await page.waitForTimeout(800);
await shot(page, '01-welcome.png');

// Connection editor with all engines.
try {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.click('[data-testid="connection-engine"]');
  await page.waitForSelector('.select-menu', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot(page, '02-engines.png');
  await page.keyboard.press('Escape');
  await page.locator('.modal-head .icon-btn').click();
} catch (err) { shotLog.push(`02-engines ✗ ${err.message}`); }

// Data grid.
try {
  await openDemoTable();
  await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
  await page.waitForTimeout(900);
  await shot(page, '03-data.png');
  await shot(page, '03b-data-grid.png', { clip: await page.locator('[data-testid="data-grid"]').boundingBox() ?? undefined });
} catch (err) { shotLog.push(`03-data ✗ ${err.message}`); }

// SQL editor + result grid.
try {
  await page.click('[data-testid="ribbon-new-query"]');
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.locator('.cm-content').click();
  await page.keyboard.type("SELECT status, COUNT(*) AS orders, ROUND(SUM(total_cents)/100.0, 2) AS revenue\nFROM orders\nGROUP BY status\nORDER BY revenue DESC;");
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('[data-testid="query-result-grid"]', { timeout: 30000 });
  await page.waitForTimeout(700);
  await shot(page, '04-query.png');
  await page.click('[data-testid="query-chart"]');
  await page.waitForSelector('.query-chart-panel [data-testid="chart-svg"]', { timeout: 15000 });
  await page.click('[data-testid="chart-type-line"]').catch(() => undefined);
  await page.waitForTimeout(800);
  await shot(page, '05-chart.png');
  await page.click('[data-testid="chart-type-bar"]').catch(() => undefined);
  await page.click('[data-testid="chart-extra-total"]').catch(() => undefined);
  await page.waitForTimeout(700);
} catch (err) { shotLog.push(`04-query ✗ ${err.message}`); }

// Relationship diagram.
try {
  await page.click('[data-testid="open-relations"]');
  await page.waitForSelector('[data-testid="erd-canvas"]', { timeout: 15000 });
  await page.waitForTimeout(900);
  await shot(page, '06-relations.png');
  await page.locator('.tab.active .tab-close').click();
} catch (err) { shotLog.push(`06-relations ✗ ${err.message}`); }

// Dashboard.
try {
  await activateDemo();
  const openBtn = page.locator('[data-testid="open-dashboard"]');
  if (await openBtn.count()) await openBtn.click();
  else await page.locator('[data-testid="ribbon"] .ribbon-btn').filter({ hasText: /dashboard/i }).first().click();
  await page.waitForSelector('[data-testid="tab-dashboard"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="dashboard-card"] [data-testid="chart-svg"]', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot(page, '07-dashboard.png');
} catch (err) { shotLog.push(`07-dashboard ✗ ${err.message}`); }

// Toolbox.
try {
  const ribbonBtn = page.locator('[data-testid="ribbon"] .ribbon-btn').filter({ hasText: /toolbox/i }).first();
  if (await ribbonBtn.count()) await ribbonBtn.click();
  else await page.locator('[data-testid="ribbon"] button[title="Toolbox"]').click();
  await page.waitForSelector('.tools-modal', { timeout: 12000 });
  await page.waitForTimeout(1000);
  await shot(page, '08-toolbox.png');
  await page.locator('.tools-modal .icon-btn').first().click();
} catch (err) { shotLog.push(`08-toolbox ✗ ${err.message}`); }

// Settings.
try {
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-save"]', { timeout: 15000 });
  await page.waitForTimeout(600);
  await shot(page, '09-settings.png');
  await page.locator('.settings-modal .modal-head .icon-btn').click();
} catch (err) { shotLog.push(`09-settings ✗ ${err.message}`); }

// ---------------- Agent: real model turn with frame capture ----------------
async function newSession() {
  await page.click('[data-testid="agent-new-session"]');
  await page.waitForSelector('[data-testid="agent-input"]', { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function captureTurn(text, { framesDir, midShot, takePanelShot } = {}) {
  if (framesDir) { mkdirSync(framesDir, { recursive: true }); }
  const panel = await page.locator('[data-testid="agent-panel"]').boundingBox();
  const clip = panel ? { x: panel.x, y: panel.y, width: panel.width, height: panel.height } : undefined;
  await page.fill('[data-testid="agent-input"]', text);
  await page.click('[data-testid="agent-send"]');
  await page.waitForSelector('[data-testid="agent-activity"]', { timeout: 20000 }).catch(() => undefined);
  let frame = 0;
  let mid = false;
  let lastText = '';
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < 240000) {
    if (clip && frame < 240) {
      await page.screenshot({ path: join(framesDir, `frame-${String(frame).padStart(3, '0')}.png`), clip }).catch(() => undefined);
      frame++;
    }
    const state = await page.evaluate(() => {
      const activity = Boolean(document.querySelector('[data-testid="agent-activity"]'));
      const transcript = document.querySelector('.agent-transcript')?.textContent ?? '';
      const tools = document.querySelectorAll('[data-testid="tool-card"]').length;
      return { activity, transcript, tools };
    });
    if (!mid && state.tools >= 2 && midShot) {
      mid = true;
      await shot(page, midShot);
    }
    if (!state.activity) {
      if (state.transcript === lastText) stable++;
      else { stable = 0; lastText = state.transcript; }
      if (stable >= 6) break;
    }
    await page.waitForTimeout(350);
  }
  if (takePanelShot) {
    const box = await page.locator('[data-testid="agent-panel"]').boundingBox();
    if (box) await shot(page, takePanelShot, { clip: box });
  }
  return frame;
}

await newSession();
await page.waitForTimeout(600);
const loopFrames = await captureTurn(
  'Analyze the orders table end to end: total revenue, order count, status breakdown, and the monthly revenue trend. Then render the monthly trend as a chart.',
  { framesDir: join(framesRoot, 'loop'), midShot: '10-agent-working.png', takePanelShot: '12-agent-panel.png' },
);
console.log('loop frames:', loopFrames);
await shot(page, '11-agent-answer.png');

const forecastFrames = await captureTurn(
  'Forecast the next 3 months of revenue and explain the method, the fit quality, and the interval you used.',
  { framesDir: join(framesRoot, 'forecast') },
);
console.log('forecast frames:', forecastFrames);
await shot(page, '13-agent-forecast.png');

// Approval gate (deny so the demo stays clean).
try {
  await page.fill('[data-testid="agent-input"]', 'Create a table named ops_healthcheck with id auto-increment primary key, service text, status text, and checked_at timestamp.');
  await page.click('[data-testid="agent-send"]');
  await page.waitForSelector('[data-testid="approval-allow-once"]', { timeout: 120000 });
  await page.waitForTimeout(500);
  await shot(page, '14-agent-approval.png');
  await page.click('[data-testid="approval-deny"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-activity"]'), null, { timeout: 90000 }).catch(() => undefined);
} catch (err) { shotLog.push(`14-approval ✗ ${err.message}`); }

// Light theme.
try {
  await page.click('[data-testid="theme-toggle"]');
  await page.waitForTimeout(1000);
  await shot(page, '15-light.png');
  await page.click('[data-testid="theme-toggle"]');
  await page.waitForTimeout(800);
} catch (err) { shotLog.push(`15-light ✗ ${err.message}`); }

// ---------------- Mobile (Expo web) ----------------
const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await mobileContext.addInitScript(() => { localStorage.setItem('aidb.mobile.locale', 'en'); });
const mobile = await mobileContext.newPage();
mobile.on('pageerror', (e) => errors.push(`mobile: ${e.message}`));
await mobile.goto(`http://127.0.0.1:${mobilePort}`, { waitUntil: 'networkidle' });
await mobile.waitForTimeout(2000);
await mobile.screenshot({ path: join(outDir, '16-mobile-pairing.png') }).catch((e) => shotLog.push(`16 ✗ ${e.message}`));
try {
  const pair = await api('/pair/start', { method: 'POST' });
  await mobile.getByTestId('m-bridge-url').fill(base);
  await mobile.getByTestId('m-pair-code').fill(pair.body.code);
  await mobile.getByTestId('m-connect').click();
  await mobile.waitForFunction(() => /Bridge (online|在线)/i.test(document.body.innerText), null, { timeout: 60000 });
  await mobile.waitForTimeout(1000);
  await mobile.screenshot({ path: join(outDir, '17-mobile-chat.png') });
  await mobile.getByTestId('m-chat-input').fill('List the tables in this database and their row counts.');
  await mobile.getByTestId('m-send').click();
  await mobile.waitForFunction(() => document.body.innerText.includes('tables'), null, { timeout: 120000 });
  await mobile.waitForTimeout(1200);
  await mobile.screenshot({ path: join(outDir, '18-mobile-agent.png') });
  await mobile.getByTestId('m-tab-tools').click();
  await mobile.waitForTimeout(600);
  await mobile.screenshot({ path: join(outDir, '19-mobile-tools.png') });
  await mobile.getByTestId('m-tab-data').click();
  await mobile.waitForSelector('[data-testid="m-table-orders"]', { timeout: 20000 });
  await mobile.getByTestId('m-table-orders').click();
  await mobile.waitForTimeout(1800);
  await mobile.screenshot({ path: join(outDir, '20-mobile-data.png') });
} catch (err) { shotLog.push(`mobile ✗ ${err.message}`); }

console.log('\n--- screenshots ---');
for (const line of shotLog) console.log(line);
console.log('\n--- console errors ---');
for (const line of errors.slice(0, 30)) console.log(line);
console.log(`assets: ${readdirSync(outDir).length} files in ${outDir}`);

await mobileContext.close().catch(() => undefined);
await desktopContext.close().catch(() => undefined);
await browser.close().catch(() => undefined);
await new Promise((r) => mobileServer.close(r));
gateway.kill('SIGTERM');
setTimeout(() => process.exit(0), 800);
