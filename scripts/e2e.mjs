import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
check('27 agent tools', boot.tools.length === 27, String(boot.tools.length));

const MONGO_PORT = process.env.AIDB_TEST_MONGO_PORT ? Number(process.env.AIDB_TEST_MONGO_PORT) : undefined;
const REDIS_PORT = process.env.AIDB_TEST_REDIS_PORT ? Number(process.env.AIDB_TEST_REDIS_PORT) : undefined;
const NEO4J_PORT = process.env.AIDB_TEST_NEO4J_PORT ? Number(process.env.AIDB_TEST_NEO4J_PORT) : undefined;
const NEO4J_PASSWORD = process.env.AIDB_TEST_NEO4J_PASSWORD ?? 'testpass';
if (MONGO_PORT) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  await client.db('aidb_e2e').dropDatabase();
  await client.db('aidb_e2e').collection('widgets').insertMany([
    { name: 'alpha', weight: 1 },
    { name: 'beta', weight: 2 },
    { name: 'gamma', weight: 3 },
  ]);
  await client.close();
}
if (REDIS_PORT) {
  const { Redis } = await import('ioredis');
  const client = new Redis({ host: '127.0.0.1', port: REDIS_PORT, lazyConnect: true });
  await client.connect();
  await client.set('aidb:e2e:key', 'hello');
  await client.quit();
}
if (NEO4J_PORT) {
  const neo4j = (await import('neo4j-driver')).default;
  const driver = neo4j.driver(`neo4j://127.0.0.1:${NEO4J_PORT}`, neo4j.auth.basic('neo4j', NEO4J_PASSWORD));
  const session = driver.session({ database: 'neo4j' });
  await session.run('MATCH (n) DETACH DELETE n');
  await session.run('CREATE (a:Person {name: $a})-[:KNOWS {since: 2020}]->(b:Person {name: $b})', { a: 'Ada', b: 'Linus' });
  await session.close();
  await driver.close();
}

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
page.on('response', (res) => {
  if (res.status() >= 400) consoleErrors.push(`desktop: HTTP ${res.status()} ${res.url()} ${res.request().postData() ?? ''}`);
});
await page.goto(`${bridge}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForTimeout(900);
check('desktop boots', (await page.locator('.conn-row').count()) >= 1);
const ribbonModules = await page.locator('[data-testid="ribbon"] .ribbon-btn').count();
check('ribbon exposes Navicat modules', ribbonModules >= 12, `${ribbonModules} modules`);
await page.screenshot({ path: join(shots, 'desktop-welcome.png') });

// ---------------- 布局：折叠 / 拖宽 / 右键接管 ----------------
const sidebarBox = await page.locator('.sidebar').boundingBox();
await page.click('[data-testid="toggle-sidebar"]');
await page.waitForTimeout(200);
check('titlebar collapses the connection sidebar', (await page.locator('.sidebar').count()) === 0);
await page.click('[data-testid="toggle-sidebar"]');
await page.waitForTimeout(250);
check('sidebar toggles back', (await page.locator('.sidebar').count()) === 1);
await page.click('[data-testid="sidebar-collapse"]');
await page.waitForTimeout(200);
check('sidebar hides from its own header button', (await page.locator('.sidebar').count()) === 0);
await page.click('[data-testid="toggle-sidebar"]');
await page.waitForTimeout(250);
const splitBox = await page.locator('[data-testid="splitter-sidebar"]').boundingBox();
await page.mouse.move(splitBox.x + 2, splitBox.y + 60);
await page.mouse.down();
await page.mouse.move(splitBox.x + 62, splitBox.y + 60, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(250);
const widened = (await page.locator('.sidebar').boundingBox()).width;
check('sidebar is draggable wider', widened > sidebarBox.width + 30, `${Math.round(sidebarBox.width)} → ${Math.round(widened)}`);
await page.mouse.click(780, 720, { button: 'right' });
await page.waitForTimeout(250);
check('right click opens the app menu instead of the browser one', (await page.locator('[data-testid="context-menu"]').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

await page.click('[data-testid="sidebar-new-connection"]');
await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
const engineOptions = await page.locator('[data-testid="connection-engine"] option').count();
check('connection form lists 26 engines', engineOptions === 26, String(engineOptions));
await page.screenshot({ path: join(shots, 'desktop-connection-engines.png') });
await page.locator('.modal-head .icon-btn').click();
await page.waitForTimeout(200);

if (MONGO_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'Mongo E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'mongodb');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(MONGO_PORT));
  await page.fill('[data-testid="connection-database"]', 'aidb_e2e');
  await page.click('[data-testid="connection-save"]');
  const mongoRow = page.locator('.conn-row', { hasText: 'Mongo E2E' });
  await mongoRow.waitFor({ timeout: 15000 });
  // saveConnection 已展开新连接并触发 loadSchema，不再点击（点击会收起）
  try {
    await page.waitForSelector('[title="集合 widgets"]', { timeout: 20000 });
  } catch (err) {
    console.error('SIDEBAR TEXT:\n', await page.locator('.sidebar').innerText());
    console.error('GATEWAY LOGS:\n', gatewayLogs.join(''));
    throw err;
  }
  check('Mongo connection expands to collections', true);
  await page.click('[title="集合 widgets"]');
  await page.waitForSelector('[data-testid="query-run"]', { timeout: 10000 });
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  const mongoRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
  check('Mongo MQL query returns documents', mongoRows === 3, `${mongoRows} rows`);
  check('Mongo query hides SQL-only actions', (await page.locator('.query-actions').getByText('美化 SQL').count()) === 0);
  await page.screenshot({ path: join(shots, 'desktop-mongodb.png') });
}

if (REDIS_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'Redis E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'redis');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(REDIS_PORT));
  await page.fill('[data-testid="connection-database"]', '0');
  await page.click('[data-testid="connection-save"]');
  const redisRow = page.locator('.conn-row', { hasText: 'Redis E2E' });
  await redisRow.waitFor({ timeout: 15000 });
  // saveConnection 已展开新连接并触发 loadSchema，不再点击（点击会收起）
  await page.waitForSelector('[title="键空间 keys"]', { timeout: 20000 });
  check('Redis connection expands to a key space', true);
  await page.click('[title="键空间 keys"]');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  const redisRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
  check('Redis SCAN returns keys', redisRows >= 1, `${redisRows} rows`);
  await page.screenshot({ path: join(shots, 'desktop-redis.png') });
}

if (NEO4J_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'Neo4j E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'neo4j');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(NEO4J_PORT));
  await page.fill('[data-testid="connection-database"]', 'neo4j');
  await page.fill('[data-testid="connection-username"]', 'neo4j');
  await page.fill('[data-testid="connection-password"]', NEO4J_PASSWORD);
  await page.click('[data-testid="connection-save"]');
  const neo4jRow = page.locator('.conn-row', { hasText: 'Neo4j E2E' });
  await neo4jRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="节点标签 Person"]', { timeout: 25000 });
  check('Neo4j connection expands to labels', true);
  await page.click('[title="节点标签 Person"]');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  const neo4jRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
  if (neo4jRows !== 2) {
    console.error('NEO4J GRID:\n', await page.locator('[data-testid="query-result-grid"]').innerText());
    console.error('NEO4J EDITOR:\n', await page.locator('.cm-content').last().innerText());
  }
  check('Neo4j Cypher query returns nodes', neo4jRows === 2, `${neo4jRows} rows`);
  check('Neo4j query hides SQL-only actions', (await page.locator('.query-actions').getByText('美化 SQL').count()) === 0);
}

if (MONGO_PORT || REDIS_PORT || NEO4J_PORT) {
  // 恢复初始工作区：bootstrap 会把 active connection 指回 demo，并重新出现欢迎页
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
  await page.waitForTimeout(800);
}

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

await page.locator('[data-testid="tab-query"]').first().click({ button: 'right' });
await page.waitForSelector('[data-testid="context-menu"]', { timeout: 5000 });
const tabMenu = await page.locator('[data-testid="context-menu"]').innerText();
check('tab context menu offers close variants', ['关闭', '关闭其它', '关闭全部'].every((label) => tabMenu.includes(label)), tabMenu.replace(/\s+/g, ' ').slice(0, 80));
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

await page.locator('[data-testid="query-result-grid"] tbody tr td').nth(1).click({ button: 'right' });
await page.waitForSelector('[data-testid="context-menu"]', { timeout: 5000 });
const cellMenu = await page.locator('[data-testid="context-menu"]').innerText();
check('grid cell context menu copies values', /复制整行/.test(cellMenu) && /复制列名/.test(cellMenu), cellMenu.replace(/\s+/g, ' ').slice(0, 80));
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

await page.locator('.result-tab').filter({ hasText: '图表' }).click();
await page.waitForSelector('.query-chart-panel .chart-card', { timeout: 10000 });
check('query result renders a chart tab', true);
// 宽窗口下图表要收缩到 400px 以内，不能把窗口撑出滚动条
await page.setViewportSize({ width: 1920, height: 900 });
await page.waitForTimeout(500);
const wideChart = await page.locator('.query-chart-panel [data-testid="chart-svg"]').boundingBox();
check('chart height caps at 400px on a wide window', Boolean(wideChart) && wideChart.height <= 400.5 && wideChart.height <= 900 * 0.6, wideChart ? `${Math.round(wideChart.width)}x${Math.round(wideChart.height)}` : 'no chart');
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, 'desktop-query-chart.png') });

await page.getByRole('button', { name: /AI 优化/ }).click();
await page.waitForTimeout(300);
const prefilled = await page.locator('[data-testid="agent-input"]').inputValue();
check('SQL Copilot prefills the agent', prefilled.includes('优化') && prefilled.includes('SELECT'), prefilled.slice(0, 60));

// 连接只有单库（SQLite）时库选择器应当隐藏；多库时有独立探针覆盖（.tools/probes/db-pickers.mjs）
check('single-database connection hides the agent database picker', (await page.locator('[data-testid="agent-db"]').count()) === 0);

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
await page.waitForSelector('[data-testid="agent-chart"] [data-testid="chart-card"]', { timeout: 25000 });
check('agent renders a chart artifact', (await page.locator('[data-testid="agent-chart"] .chart-card svg, [data-testid="agent-chart"] .chart-card .pie').count()) > 0);
const execSections = page.locator('[data-testid="execution-section"]');
const lastExec = execSections.last();
check('execution steps fold away by default', (await lastExec.evaluate((el) => el.hasAttribute('open'))) === false);
check('chart is hoisted into the conclusion, not nested in a tool card', (await page.locator('.tool-card [data-testid="chart-card"]').count()) === 0 && (await page.locator('[data-testid="agent-chart"]').count()) > 0);

const settledChart = await page.locator('[data-testid="agent-chart"] [data-testid="chart-svg"]').boundingBox();
check('agent chart is a stable 350px tall', Boolean(settledChart) && Math.abs(settledChart.height - 350) <= 1, settledChart ? `${Math.round(settledChart.width)}x${Math.round(settledChart.height)}` : 'no chart');

// 图表高度要压在可见聊天区之内：先把 AI 面板拖宽，再压矮窗口
const agentSplit = await page.locator('[data-testid="splitter-agent"]').boundingBox();
await page.mouse.move(agentSplit.x + 2, agentSplit.y + 200);
await page.mouse.down();
await page.mouse.move(agentSplit.x - 300, agentSplit.y + 200, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
await page.setViewportSize({ width: 1440, height: 620 });
await page.waitForTimeout(700);
const shortTranscript = await page.locator('.agent-transcript').evaluate((el) => el.clientHeight);
const shortChart = await page.locator('[data-testid="agent-chart"] [data-testid="chart-svg"]').boundingBox();
check(
  'agent chart shrinks into the visible transcript',
  Boolean(shortChart) && shortChart.height <= shortTranscript && shortChart.height <= 400,
  shortChart ? `${Math.round(shortChart.width)}x${Math.round(shortChart.height)} in ${shortTranscript}` : 'no chart',
);
await page.setViewportSize({ width: 1440, height: 900 });
await page.locator('[data-testid="splitter-agent"]').dblclick();
await page.waitForTimeout(600);
await page.screenshot({ path: join(shots, 'desktop-chart.png') });

// ---------------- P3 图表三 tab / 工具条 / PNG ----------------
// 锚点用 chart-tabs 而不是 chart-card：切到「明细」时图表卡会卸载，用它定位会瞬间失效
const chartToolCard = page.locator('[data-testid="agent-chart"]').first();
check('chart result offers 图表/明细/SQL tabs', (await chartToolCard.locator('[data-testid="chart-tabs"] button').count()) === 3, await chartToolCard.locator('[data-testid="chart-tabs"] button').allTextContents().then((t) => t.join('|')).catch(() => ''));
await chartToolCard.locator('[data-testid="chart-tab-rows"]').click();
check('明细 tab exposes the rows the tool already returned', (await chartToolCard.locator('.tool-table tbody tr').count()) > 0, `${await chartToolCard.locator('.tool-table tbody tr').count()} rows`);
await chartToolCard.locator('[data-testid="chart-tab-sql"]').click();
check('SQL tab shows the chart SQL', /select/i.test((await chartToolCard.locator('.sql-block').first().textContent()) ?? ''));
await chartToolCard.locator('[data-testid="chart-tab-chart"]').click();
check('switching back restores the chart', (await chartToolCard.locator('[data-testid="chart-svg"]').count()) === 1);
const chartCard = chartToolCard.locator('[data-testid="chart-card"]');
check('chart toolbar is shared into the agent card', (await chartCard.locator('[data-testid="chart-toolbar"]').count()) === 1);
await chartCard.locator('[data-testid="chart-type-line"]').click();
check('chart type switches without a round trip', /LINE/.test((await chartCard.locator('.chart-head .badge').textContent()) ?? ''));
await chartCard.locator('[data-testid="chart-type-bar"]').click();
const pngDownload = page.waitForEvent('download', { timeout: 15000 });
await chartCard.locator('[data-testid="chart-export-png"]').click();
const pngPath = await (await pngDownload).path();
const pngHead = (await readFile(pngPath)).subarray(0, 4);
check('chart PNG export produces a real PNG', pngHead[0] === 0x89 && pngHead[1] === 0x50 && pngHead[2] === 0x4e && pngHead[3] === 0x47, `${pngHead.toString('hex')} ${(await statSync(pngPath)).size}B`);

// ---------------- P4 执行详情 ----------------
const execToggles = page.locator('[data-testid="exec-toggle"]');
check('每轮消息提供执行详情入口', (await execToggles.count()) > 0, `${await execToggles.count()} toggles`);
await execToggles.first().click();
const execDetail = page.locator('[data-testid="exec-detail"]').first();
check('执行详情抽屉展开', (await execDetail.count()) === 1);
check('时间线至少一行且带耗时', (await execDetail.locator('.exec-row').count()) > 0 && /\d/.test((await execDetail.locator('.exec-ms').first().textContent()) ?? ''));
check('汇总行给出调用次数', /次调用/.test((await execDetail.locator('[data-testid="exec-summary"]').textContent()) ?? ''), (await execDetail.locator('[data-testid="exec-summary"]').textContent()) ?? '');
await execDetail.locator('.exec-head').first().click();
check('单行可展开看参数', (await execDetail.locator('.exec-body').count()) > 0);
await execToggles.first().click();

// ---------------- P2 追问建议 ----------------
check('回合结束后出现追问建议', (await page.locator('[data-testid="agent-followups"] .suggest-chip').count()) > 0, `${await page.locator('[data-testid="agent-followups"] .suggest-chip').count()} chips`);

// ---------------- P3 forecast_chart ----------------
await page.fill('[data-testid="agent-input"]', '预测未来 3 个月 orders 的数量');
await page.click('[data-testid="agent-send"]');
await page.waitForFunction(() => document.querySelector('.chart-note') !== null, { timeout: 30000 });
const forecastNote = (await page.locator('.chart-note').first().textContent()) ?? '';
check('forecast 说明写清方法与拟合度', /方法：(线性回归|移动平均)/.test(forecastNote) && /r=/.test(forecastNote), forecastNote.slice(0, 80));
check('forecast 段以虚线渲染', (await page.locator('[data-testid="chart-forecast-line"]').count()) > 0);
check('forecast 带区间带', (await page.locator('[data-testid="chart-forecast-band"]').count()) > 0);
await page.screenshot({ path: join(shots, 'desktop-forecast.png') });

// ---------------- P2 猜你想问 ----------------
await page.click('[data-testid="agent-new-session"]');
await page.waitForSelector('[data-testid="agent-suggestions"]', { timeout: 10000 });
const suggestChips = page.locator('[data-testid="agent-suggestions"] .suggest-chip');
const chipCount = await suggestChips.count();
check('空会话给出猜你想问', chipCount > 0 && chipCount <= 6, `${chipCount} chips`);
const chipText = (await suggestChips.first().textContent()) ?? '';
await suggestChips.first().click();
check('点击推荐填入输入框且不自动发送', (await page.locator('[data-testid="agent-input"]').inputValue()).length > 4 && chipText.length > 0);
await page.fill('[data-testid="agent-input"]', '');

// ---------------- P5 会话重命名与搜索 ----------------
await page.click('[data-testid="agent-sessions"]');
await page.waitForSelector('.sessions-drawer', { timeout: 8000 });
const sessionTotal = await page.locator('.session-item').count();
const renamed = `E2E会话${Date.now().toString().slice(-6)}`;
await page.fill('[data-testid="session-search"]', '不存在zzz');
check('会话搜索能过滤到空', (await page.locator('.session-item').count()) === 0);
await page.fill('[data-testid="session-search"]', '');
check('清空搜索恢复全量', (await page.locator('.session-item').count()) === sessionTotal, `${sessionTotal} sessions`);
await page.locator('.session-item').first().locator('[data-testid="session-rename"]').click();
await page.waitForSelector('[data-testid="session-rename-input"]', { timeout: 5000 });
await page.fill('[data-testid="session-rename-input"]', renamed);
await page.locator('[data-testid="session-rename-input"]').press('Enter');
await page.waitForTimeout(600);
const renamedOnServer = (await api('/agent/sessions')).body.sessions.some((s) => s.title === renamed);
check('会话重命名已落库', renamedOnServer, renamed);
await page.screenshot({ path: join(shots, 'desktop-sessions.png') });
await page.click('.sessions-head .icon-btn');

// ---------------- P1 业务上下文 ----------------
await page.click('[data-testid="ribbon"] button[title="视图"]');
await page.waitForSelector('.tools-modal', { timeout: 10000 });
await page.locator('.tools-nav button').filter({ hasText: 'Agent 上下文' }).click();
await page.waitForSelector('[data-testid="ctx-connection"]', { timeout: 8000 });
if ((await page.locator('[data-testid="ctx-connection"]').inputValue()) !== demo.id) {
  await page.selectOption('[data-testid="ctx-connection"]', demo.id);
}
// schema 是异步加载的，必须等表格真的出行，否则拿不到任何 ctx-enable-* 开关
await page.waitForSelector('[data-testid="ctx-table-grid"] tbody tr', { timeout: 25000 });
const ctxToggle = page.locator('[data-testid^="ctx-enable-"]').first();
const ctxTable = (await ctxToggle.getAttribute('data-testid')).replace('ctx-enable-', '');
// /agent/context 对 database 是精确过滤，不带就会查到空列表
const ctxDb = encodeURIComponent(await page.locator('[data-testid="ctx-database"]').inputValue());
const ctxUrl = `/agent/context?connectionId=${demo.id}&database=${ctxDb}`;
await ctxToggle.click();
await page.waitForTimeout(700);
const ctxAfter = await api(ctxUrl);
check('禁用表写入业务上下文', ctxAfter.body.entries.some((e) => e.table === ctxTable && e.enabled === false), `${ctxTable}: ${JSON.stringify(ctxAfter.body.entries.slice(0, 2))}`);
await ctxToggle.click();
await page.waitForTimeout(700);
const ctxRestored = await api(ctxUrl);
check('重新启用同样落库', ctxRestored.body.entries.some((e) => e.table === ctxTable && e.enabled === true), ctxTable);
// 清空是破坏性操作，UI 用 window.confirm 二次确认；Playwright 默认会自动 dismiss
let confirmText = '';
page.once('dialog', async (dialog) => { confirmText = dialog.message(); await dialog.accept(); });
await page.click('[data-testid="ctx-clear"]');
await page.waitForTimeout(700);
check('清空业务上下文前二次确认', /清空/.test(confirmText), confirmText.slice(0, 50));
check('清空业务上下文', ((await api(ctxUrl)).body.entries ?? []).length === 0);
await page.locator('.tools-modal .icon-btn').first().click();
await page.waitForTimeout(400);
check('业务上下文面板可关闭', (await page.locator('.tools-modal').count()) === 0);

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

const optionAvg = () => page.evaluate(() => {
  const opt = document.querySelector('option');
  if (!opt) return 255;
  const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(opt).backgroundColor);
  if (!m) return 255;
  const [r, g, b] = m[1].split(',').map((v) => Number(v.trim()));
  return (r + g + b) / 3;
});
const darkOption = await optionAvg();
check('native select options follow the dark surface', darkOption < 60, `avg ${Math.round(darkOption)}`);
await page.click('[data-testid="theme-toggle"]');
await page.waitForTimeout(800);
check('theme toggles to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
// 设计约束：底必须是中性石墨（三通道接近），强调色必须是青（G/B 高于 R），否则又滑回蓝黑
const rgbOf = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const neutralHex = (hex) => {
  const [r, g, b] = rgbOf(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 8;
};
const cyanHex = (hex) => {
  const [r, g, b] = rgbOf(hex);
  return g > r && b > r;
};
const readPalette = () => page.evaluate(() => {
  const style = getComputedStyle(document.documentElement);
  return { bg: style.getPropertyValue('--bg-app').trim(), accent: style.getPropertyValue('--accent').trim() };
});
const lightPalette = await readPalette();
check('light palette is neutral paper with cyan accent', neutralHex(lightPalette.bg) && cyanHex(lightPalette.accent), `${lightPalette.bg} / ${lightPalette.accent}`);
const lightOption = await optionAvg();
check('native select options follow the light surface too', lightOption > 180, `avg ${Math.round(lightOption)}`);
await page.screenshot({ path: join(shots, 'desktop-light.png') });
await page.click('[data-testid="theme-toggle"]');
await page.waitForTimeout(600);
const darkPalette = await readPalette();
check('dark surface is neutral graphite, accent is cyan', neutralHex(darkPalette.bg) && cyanHex(darkPalette.accent), `${darkPalette.bg} / ${darkPalette.accent}`);

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
// 桌面形态的导出交给 Electron 下载管理器：浏览器里的 download 事件在这儿根本不会触发，
// 只能从主进程侧取证（will-download + 落盘字节）。返回 'OK …' 或 'FAIL …' 供 check 使用。
async function electronPngExport(app, window) {
  const saveTo = join(tmpdir(), `aidb-e2e-electron-${Date.now()}.png`);
  try {
    await app.evaluate(({ session }, target) => {
      global.__export = null;
      session.defaultSession.on('will-download', (_event, item) => {
        global.__export = { name: item.getFilename(), bytes: item.getTotalBytes(), filters: item.getSaveDialogOptions()?.filters ?? null };
        item.setSavePath(target); // 别让原生「另存为」框在无头环境里卡住整条流水线
        item.once('done', (_e, state) => { global.__export.state = state; });
      });
    }, saveTo);

    await window.click('[data-testid="welcome-new-query"]');
    await window.waitForSelector('[data-testid="query-run"]', { timeout: 15000 });
    const conn = window.locator('[data-testid="query-connection"]');
    const options = await conn.locator('option').allTextContents();
    const demo = options.findIndex((text) => /demo/i.test(text));
    if (demo < 0) return `FAIL no demo connection (options: ${options.join(' | ')})`;
    await conn.selectOption({ index: demo });
    await window.waitForTimeout(1500);
    await window.click('.cm-content');
    await window.keyboard.type('SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status');
    await window.click('[data-testid="query-run"]');
    await window.waitForSelector('.grid-row, tbody tr', { timeout: 25000 });
    await window.locator('.result-tabs .result-tab').filter({ hasText: '图表' }).first().click();
    await window.waitForSelector('[data-testid="chart-svg"]', { timeout: 15000 });
    await window.locator('[data-testid="chart-export-png"]').click();

    let info = null;
    for (let i = 0; i < 40; i++) {
      info = await app.evaluate(() => global.__export);
      if (info?.state) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!info) return 'FAIL will-download never fired — export is silently dropped on desktop';
    if (info.state !== 'completed') return `FAIL download state=${info.state}`;
    const bytes = await readFile(saveTo);
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return `FAIL not a PNG (${bytes.subarray(0, 4).toString('hex')})`;
    const filtered = Array.isArray(info.filters) && info.filters.some((f) => f.extensions?.includes('png'));
    if (!filtered) return `FAIL save dialog without a PNG filter (${JSON.stringify(info.filters)})`;
    return `OK ${info.name} ${bytes.length}B ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  } catch (err) {
    return `FAIL ${String(err).split('\n')[0].slice(0, 180)}`;
  } finally {
    rmSync(saveTo, { force: true });
  }
}

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
  delete env.VITE_DEV_SERVER_URL; // 必须走内嵌 Bridge + dist，才是真实的桌面形态
  let electronOk = false;
  let exportDetail = 'not attempted';
  let lastError = '';
  for (let attempt = 1; attempt <= 2 && !electronOk; attempt++) {
    let app;
    try {
      app = await electron.launch({ executablePath: electronBinary, args: [join(root, 'apps/desktop'), '--no-sandbox'], env, timeout: 90000 });
      const window = await app.firstWindow();
      await window.waitForSelector('[data-testid="app-root"]', { timeout: 45000 });
      await window.waitForTimeout(1500);
      electronOk = (await window.locator('.conn-row').count()) >= 1;
      if (electronOk) {
        await window.screenshot({ path: join(shots, 'electron-desktop.png') });
        exportDetail = await electronPngExport(app, window);
      } else lastError = 'no connections in Electron window';
      await app.close();
      app = undefined;
    } catch (err) {
      lastError = String(err).slice(0, 240);
      if (app) await app.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  check('electron shell boots with embedded bridge', electronOk, electronOk ? '' : lastError);
  check('electron 桌面形态导出真 PNG', electronOk && exportDetail.startsWith('OK'), exportDetail);
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
