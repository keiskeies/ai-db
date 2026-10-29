import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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
const gatewayEnv = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--openssl-legacy-provider'].filter(Boolean).join(' '), AIDB_HOME: home, AIDB_HOST: '127.0.0.1', AIDB_PORT: String(port), AIDB_TOKEN: TOKEN, AIDB_SECRET: 'e2e-secret', AIDB_STATIC_DIR: desktopDist, NODE_ENV: 'production' };
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
check('40 agent tools', boot.tools.length === 40, String(boot.tools.length));

const MONGO_PORT = process.env.AIDB_TEST_MONGO_PORT ? Number(process.env.AIDB_TEST_MONGO_PORT) : undefined;
const REDIS_PORT = process.env.AIDB_TEST_REDIS_PORT ? Number(process.env.AIDB_TEST_REDIS_PORT) : undefined;
const NEO4J_PORT = process.env.AIDB_TEST_NEO4J_PORT ? Number(process.env.AIDB_TEST_NEO4J_PORT) : undefined;
const NEO4J_PASSWORD = process.env.AIDB_TEST_NEO4J_PASSWORD ?? 'testpass';
const DM_PORT = process.env.AIDB_TEST_DM_PORT ? Number(process.env.AIDB_TEST_DM_PORT) : undefined;
const DM_PASSWORD = process.env.AIDB_TEST_DM_PASSWORD ?? 'SYSDBA';
const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const MYSQL_TX_PORT = process.env.AIDB_TEST_MYSQL_PORT ? Number(process.env.AIDB_TEST_MYSQL_PORT) : undefined;
const MILVUS_PORT = process.env.AIDB_TEST_MILVUS_PORT ? Number(process.env.AIDB_TEST_MILVUS_PORT) : undefined;
const ES_PORT = process.env.AIDB_TEST_ELASTICSEARCH_PORT ? Number(process.env.AIDB_TEST_ELASTICSEARCH_PORT) : undefined;
const WEAVIATE_PORT = process.env.AIDB_TEST_WEAVIATE_PORT ? Number(process.env.AIDB_TEST_WEAVIATE_PORT) : undefined;
const DUCKDB_E2E = process.env.AIDB_TEST_DUCKDB === '1';
const TDENGINE_PORT = process.env.AIDB_TEST_TDENGINE_PORT ? Number(process.env.AIDB_TEST_TDENGINE_PORT) : undefined;
const FALKORDB_PORT = process.env.AIDB_TEST_FALKORDB_PORT ? Number(process.env.AIDB_TEST_FALKORDB_PORT) : undefined;
const FALKORDB_GRAPH = 'aidb_e2e';
const INFLUXDB_PORT = process.env.AIDB_TEST_INFLUXDB_PORT ? Number(process.env.AIDB_TEST_INFLUXDB_PORT) : undefined;
const INFLUXDB_DB = 'aidb_e2e';
const ARANGO_PORT = process.env.AIDB_TEST_ARANGO_PORT ? Number(process.env.AIDB_TEST_ARANGO_PORT) : undefined;
const ARANGO_DB = 'aidb_e2e';
const ARANGO_PASSWORD = process.env.AIDB_TEST_ARANGO_PASSWORD ?? 'testpass';
const REDIS_STACK = process.env.AIDB_TEST_REDIS_STACK === '1';
const TIMESCALE_PORT = process.env.AIDB_TEST_TIMESCALE_PORT ? Number(process.env.AIDB_TEST_TIMESCALE_PORT) : undefined;
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
  await client.db('aidb_e2e').collection('widgets').createIndex({ name: 1 }, { unique: true, name: 'name_unique' });
  await client.close();
}
if (TIMESCALE_PORT) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ host: '127.0.0.1', port: TIMESCALE_PORT, user: 'postgres', password: 'test', database: 'postgres' });
  await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  await pool.query('DROP TABLE IF EXISTS aidb_e2e_metrics');
  await pool.query('CREATE TABLE aidb_e2e_metrics (ts timestamptz NOT NULL, host text, value double precision)');
  await pool.query("SELECT create_hypertable('aidb_e2e_metrics', 'ts')");
  await pool.query("INSERT INTO aidb_e2e_metrics VALUES ('2024-01-05T00:00:00Z', 'a', 1), ('2024-02-05T00:00:00Z', 'b', 2)");
  await pool.end();
}
if (REDIS_PORT) {
  const { Redis } = await import('ioredis');
  const client = new Redis({ host: '127.0.0.1', port: REDIS_PORT, lazyConnect: true });
  await client.connect();
  await client.set('aidb:e2e:key', 'hello');
  await client.del('aidb:e2e:key_renamed', 'aidb:e2e:created', 'aidb:e2e:members', 'aidb:e2e:list');
  await client.set('aidb:e2e:del', 'throwaway');
  if (REDIS_STACK) {
    await client.call('FT.DROPINDEX', 'aidb_e2e').catch(() => undefined);
    await client.call('JSON.SET', 'doc:1', '$', '{"name":"Ada"}');
    await client.call('JSON.SET', 'doc:2', '$', '{"name":"Linus"}');
    await client.call('FT.CREATE', 'aidb_e2e', 'ON', 'JSON', 'PREFIX', '1', 'doc:', 'SCHEMA', '$.name', 'AS', 'name', 'TEXT');
  }
  await client.quit();
}
if (ES_PORT) {
  const esBase = `http://127.0.0.1:${ES_PORT}`;
  await fetch(`${esBase}/aidb_es_ui`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${esBase}/aidb_es_ui`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mappings: { properties: { message: { type: 'text' } } } }),
  });
  await fetch(`${esBase}/aidb_es_ui/_doc/1?refresh=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  });
}
if (WEAVIATE_PORT) {
  const wvBase = `http://127.0.0.1:${WEAVIATE_PORT}`;
  await fetch(`${wvBase}/v1/schema/AidbUiClass`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${wvBase}/v1/schema`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ class: 'AidbUiClass', vectorizer: 'none', properties: [{ name: 'title', dataType: ['text'] }] }),
  });
  await fetch(`${wvBase}/v1/batch/objects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      objects: [
        { class: 'AidbUiClass', id: 'd1d1d1d1-0000-4000-8000-000000000001', properties: { title: 'hello' }, vector: [0.1, 0.2] },
        { class: 'AidbUiClass', id: 'd1d1d1d1-0000-4000-8000-000000000002', properties: { title: 'world' }, vector: [0.3, 0.4] },
      ],
    }),
  });
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
if (DM_PORT) {
  const created = await api('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'dm-seed',
      engine: 'dm',
      host: '127.0.0.1',
      port: DM_PORT,
      database: 'SYSDBA',
      username: 'SYSDBA',
      password: DM_PASSWORD,
      groupName: 'seed',
      color: 'red',
      environment: 'dev',
      readonly: false,
    }),
  });
  if (created.status !== 201) throw new Error(`DM seed connection failed: ${JSON.stringify(created.body)}`);
  const id = created.body.connection.id;
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: id, database: 'SYSDBA', sql: 'DROP TABLE AIDB_E2E' }),
  });
  const ddl = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: id, database: 'SYSDBA', sql: 'CREATE TABLE AIDB_E2E (ID INT PRIMARY KEY, NAME VARCHAR(50))' }),
  });
  if (ddl.status !== 200) throw new Error(`DM seed DDL failed: ${JSON.stringify(ddl.body)}`);
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: id, database: 'SYSDBA', sql: "INSERT INTO AIDB_E2E VALUES (1, 'Ada')" }),
  });
  await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: id, database: 'SYSDBA', sql: "INSERT INTO AIDB_E2E VALUES (2, 'Linus')" }),
  });
  await api(`/connections/${id}`, { method: 'DELETE' });
}
if (QDRANT_PORT) {
  const base = `http://127.0.0.1:${QDRANT_PORT}`;
  await fetch(`${base}/collections/aidb_e2e`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${base}/collections/aidb_uicreated`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${base}/collections/aidb_e2e`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: 3, distance: 'Cosine' } }),
  });
  await fetch(`${base}/collections/aidb_e2e/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      points: [
        { id: 1, vector: [1, 0, 0], payload: { name: 'Ada' } },
        { id: 2, vector: [0, 1, 0], payload: { name: 'Linus' } },
      ],
    }),
  });
  await fetch(`${base}/collections/aidb_e2e/index?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ field_name: 'name', field_schema: { type: 'keyword' } }),
  });
}
if (TDENGINE_PORT) {
  const base = `http://127.0.0.1:${TDENGINE_PORT}`;
  const sql = (query, db) =>
    fetch(`${base}/rest/sql${db ? `/${db}` : ''}`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from('root:taosdata').toString('base64')}` },
      body: query,
    });
  await sql('DROP DATABASE IF EXISTS aidb_e2e');
  await sql('CREATE DATABASE aidb_e2e');
  await sql('CREATE STABLE meters (ts TIMESTAMP, current FLOAT) TAGS (location NCHAR(32))', 'aidb_e2e');
  await sql("INSERT INTO d1 USING meters TAGS ('beijing') VALUES (NOW, 10.3)", 'aidb_e2e');
  await sql("INSERT INTO d2 USING meters TAGS ('shanghai') VALUES (NOW, 12.1)", 'aidb_e2e');
}
if (INFLUXDB_PORT) {
  const write = await fetch(`http://127.0.0.1:${INFLUXDB_PORT}/api/v3/write_lp?db=${INFLUXDB_DB}&precision=nanosecond`, {
    method: 'POST',
    body: ['cpu,host=a value=1.0 1700000000000000000', 'cpu,host=b value=2.0 1700000060000000000'].join('\n'),
  });
  if (write.status !== 204) throw new Error(`InfluxDB seed failed: ${write.status} ${await write.text()}`);
}
if (ARANGO_PORT) {
  const base = `http://127.0.0.1:${ARANGO_PORT}`;
  const auth = { authorization: `Basic ${Buffer.from(`root:${ARANGO_PASSWORD}`).toString('base64')}`, 'content-type': 'application/json' };
  const arango = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  await arango('/_db/_system/_api/database', { method: 'POST', body: JSON.stringify({ name: ARANGO_DB }) });
  for (const name of ['knows', 'person', 'aidb_ui_col']) {
    await arango(`/_db/${ARANGO_DB}/_api/collection/${name}`, { method: 'DELETE' });
  }
  await arango(`/_db/${ARANGO_DB}/_api/collection`, { method: 'POST', body: JSON.stringify({ name: 'person' }) });
  await arango(`/_db/${ARANGO_DB}/_api/collection`, { method: 'POST', body: JSON.stringify({ name: 'knows', type: 3 }) });
  await arango(`/_db/${ARANGO_DB}/_api/document/person`, {
    method: 'POST',
    body: JSON.stringify([
      { _key: 'ada', name: 'Ada' },
      { _key: 'linus', name: 'Linus' },
    ]),
  });
  await arango(`/_db/${ARANGO_DB}/_api/document/knows`, {
    method: 'POST',
    body: JSON.stringify([{ _key: 'k1', _from: 'person/ada', _to: 'person/linus', since: 2020 }]),
  });
  await arango(`/_db/${ARANGO_DB}/_api/index?collection=person`, {
    method: 'POST',
    body: JSON.stringify({ type: 'inverted', fields: ['age'], name: 'age' }),
  });
}
if (FALKORDB_PORT) {
  const { Redis } = await import('ioredis');
  const client = new Redis({ host: '127.0.0.1', port: FALKORDB_PORT, lazyConnect: true });
  await client.connect();
  await client.call('GRAPH.QUERY', FALKORDB_GRAPH, 'MATCH (n) DETACH DELETE n');
  await client.call(
    'GRAPH.QUERY',
    FALKORDB_GRAPH,
    "CYPHER a='Ada' b='Linus' CREATE (:Person {name: $a})-[:KNOWS {since: 2020}]->(:Person {name: $b})",
  );
  await client.quit();
}
const duckdbPath = join(home, 'duckdb-e2e.duckdb');
if (DUCKDB_E2E) {
  const created = await api('/connections', {
    method: 'POST',
    body: JSON.stringify({ name: 'duckdb-seed', engine: 'duckdb', database: duckdbPath, groupName: 'seed', color: 'orange', environment: 'dev', readonly: false }),
  });
  if (created.status !== 201) throw new Error(`DuckDB seed connection failed: ${JSON.stringify(created.body)}`);
  const id = created.body.connection.id;
  await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: id, sql: 'CREATE OR REPLACE TABLE DUCK_E2E (ID INTEGER, NAME VARCHAR)' }) });
  await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: id, sql: "INSERT INTO DUCK_E2E VALUES (1, 'Ada'), (2, 'Linus')" }) });
  await api(`/connections/${id}`, { method: 'DELETE' });
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
check('connection form lists 41 engines', engineOptions === 41, String(engineOptions));
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

  await page.click('[data-testid="open-document-write"]');
  await page.waitForSelector('[data-testid="document-write-json"]', { timeout: 10000 });
  await page.fill('[data-testid="document-write-collection"]', 'widgets');
  await page.fill('[data-testid="document-write-json"]', JSON.stringify([{ _id: '64b0c0d0e0f0a0b0c0d0e0f0', name: 'Gamma', weight: 9 }]));
  await page.click('[data-testid="document-write-submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 4, null, { timeout: 25000 });
  check('MongoDB document write appears in the result grid', true);

  await page.click('[data-testid="open-document-write"]');
  await page.waitForSelector('[data-testid="document-mode-delete"]', { timeout: 10000 });
  await page.fill('[data-testid="document-write-collection"]', 'widgets');
  await page.click('[data-testid="document-mode-delete"]');
  await page.fill('[data-testid="document-delete-ids"]', '64b0c0d0e0f0a0b0c0d0e0f0');
  await page.click('[data-testid="document-write-submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 3, null, { timeout: 25000 });
  check('MongoDB delete by id removes the document', true);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'gamma' }).first().dblclick();
  await page.waitForSelector('[data-testid="doc-edit-json"]', { timeout: 10000 });
  const editedDoc = JSON.parse(await page.locator('[data-testid="doc-edit-json"]').inputValue());
  editedDoc.name = 'delta';
  await page.fill('[data-testid="doc-edit-json"]', JSON.stringify(editedDoc, null, 2));
  await page.click('[data-testid="doc-edit-save"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('delta'), null, { timeout: 25000 });
  check('MongoDB document edited from the result grid', true);
  await page.waitForTimeout(200);

  await page.locator('[title="集合 widgets"]').click({ button: 'right' });
  await page.click('text=对象信息');
  await page.locator('[data-testid="object-info-index-name"]', { hasText: '_id_' }).first().waitFor({ timeout: 10000 });
  const indexNames = await page.locator('[data-testid="object-info-index-name"]').allInnerTexts();
  check('MongoDB collection indexes show in object info', indexNames.includes('_id_') && indexNames.includes('name_unique'), indexNames.join(','));
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);

  const openIndexPanel = async () => {
    await page.locator('[title="集合 widgets"]').click({ button: 'right' });
    await page.click('text=对象信息');
    await page.waitForSelector('[data-testid="create-index-open"]', { timeout: 10000 });
  };
  await openIndexPanel();
  await page.click('[data-testid="create-index-open"]');
  await page.fill('[data-testid="index-fields"]', 'weight');
  await page.fill('[data-testid="index-name"]', 'e2e_weight_idx');
  await page.click('[data-testid="index-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await openIndexPanel();
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="object-info-index-name"]')].some((cell) => cell.textContent === 'e2e_weight_idx'),
    null,
    { timeout: 20000 },
  );
  check('Mongo index created from the object info panel', true);

  await page.locator('.tool-table tr', { hasText: 'e2e_weight_idx' }).locator('[data-testid="index-drop-open"]').click();
  await page.fill('[data-testid="index-drop-confirm"]', 'e2e_weight_idx');
  await page.click('[data-testid="index-drop-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await openIndexPanel();
  await page.waitForFunction(
    () => ![...document.querySelectorAll('[data-testid="object-info-index-name"]')].some((cell) => cell.textContent === 'e2e_weight_idx'),
    null,
    { timeout: 20000 },
  );
  check('Mongo index dropped from the object info panel', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);

  await page.screenshot({ path: join(shots, 'desktop-mongodb.png') });
}

if (TIMESCALE_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'Timescale E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'timescale');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(TIMESCALE_PORT));
  await page.fill('[data-testid="connection-username"]', 'postgres');
  await page.fill('[data-testid="connection-password"]', 'test');
  await page.click('[data-testid="connection-save"]');
  const tsRow = page.locator('.conn-row', { hasText: 'Timescale E2E' });
  await tsRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="TABLE aidb_e2e_metrics"]', { timeout: 25000 });
  check('Timescale connection expands to hypertables', true);
  await page.click('[title="TABLE aidb_e2e_metrics"]');
  await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
  const tsRows = await page.locator('[data-testid="data-grid"] tbody tr').count();
  check('Timescale data grid returns rows', tsRows === 2, `${tsRows} rows`);
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
  await page.locator('[data-testid="query-result-grid"] tbody tr').first().dblclick();
  await page.waitForSelector('[data-testid="redis-key-type"]', { timeout: 10000 });
  const keyType = await page.locator('[data-testid="redis-key-type"]').innerText();
  check('Redis key detail opens on double click', /类型\s+\S+/.test(keyType), keyType);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'aidb:e2e:del' }).first().dblclick();
  await page.waitForSelector('[data-testid="redis-key-delete"]', { timeout: 10000 });
  await page.click('[data-testid="redis-key-delete"]');
  await page.fill('[data-testid="redis-key-confirm"]', 'aidb:e2e:del');
  await page.click('[data-testid="redis-key-delete-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 10000 });
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(
    () => ![...document.querySelectorAll('[data-testid="query-result-grid"] tbody tr')].some((row) => row.textContent.includes('aidb:e2e:del')),
    null,
    { timeout: 20000 },
  );
  check('Redis key deleted from the key detail dialog', true);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'aidb:e2e:key' }).first().dblclick();
  await page.waitForSelector('[data-testid="key-ttl-input"]', { timeout: 10000 });
  await page.fill('[data-testid="key-ttl-input"]', '600');
  await page.click('[data-testid="key-ttl-set"]');
  await page.waitForFunction(
    () => /剩余 \d+s/.test(document.querySelector('[data-testid="redis-key-ttl"]')?.textContent ?? ''),
    null,
    { timeout: 10000 },
  );
  check('Redis key TTL set from the detail dialog', true);
  await page.fill('[data-testid="key-rename-input"]', 'aidb:e2e:key_renamed');
  await page.click('[data-testid="key-rename-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('aidb:e2e:key_renamed'),
    null,
    { timeout: 20000 },
  );
  check('Redis key renamed from the detail dialog', true);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'aidb:e2e:key_renamed' }).first().dblclick();
  await page.waitForSelector('[data-testid="key-value-input"]', { timeout: 10000 });
  await page.fill('[data-testid="key-value-input"]', 'hello-edited');
  const valueSaved = page.waitForResponse(
    (response) => response.url().includes('/api/redis/key/value') && response.request().method() === 'POST',
  );
  await page.click('[data-testid="key-value-save"]');
  await valueSaved;
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 10000 });
  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'aidb:e2e:key_renamed' }).first().dblclick();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="key-value-input"]')?.value === 'hello-edited',
    null,
    { timeout: 10000 },
  );
  check('Redis string value edited from the key detail dialog', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 10000 });

  await page.click('[data-testid="open-key-create"]');
  await page.waitForSelector('[data-testid="key-create-name"]', { timeout: 10000 });
  await page.fill('[data-testid="key-create-name"]', 'aidb:e2e:created');
  await page.selectOption('[data-testid="key-create-type"]', 'hash');
  await page.fill('[data-testid="key-create-value"]', '{"name":"Ada"}');
  await page.click('[data-testid="key-create-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('aidb:e2e:created'),
    null,
    { timeout: 20000 },
  );
  check('Redis key created from the new-key dialog', true);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'aidb:e2e:created' }).first().dblclick();
  await page.waitForSelector('[data-testid="redis-key-grid"] tbody tr', { timeout: 10000 });
  await page.locator('[data-testid="redis-key-grid"] tbody tr', { hasText: 'name' }).first().dblclick();
  await page.waitForSelector('[data-testid="hash-field-editor"]', { timeout: 10000 });
  await page.fill('[data-testid="hash-field-value"]', 'Ada Lovelace');
  await page.click('[data-testid="hash-field-save"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="redis-key-grid"]')?.innerText.includes('Ada Lovelace'),
    null,
    { timeout: 20000 },
  );
  check('Redis hash field edited from the key detail dialog', true);

  await page.click('[data-testid="hash-field-delete-name"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="redis-key-grid"]'),
    null,
    { timeout: 20000 },
  );
  check('Redis hash field delete removes the emptied key', true);

  // set 键：新建后在详情里加成员、再按成员删除
  await page.click('[data-testid="open-key-create"]');
  await page.waitForSelector('[data-testid="key-create-name"]', { timeout: 10000 });
  await page.fill('[data-testid="key-create-name"]', 'aidb:e2e:members');
  await page.selectOption('[data-testid="key-create-type"]', 'set');
  await page.fill('[data-testid="key-create-value"]', '["alpha"]');
  await page.click('[data-testid="key-create-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('aidb:e2e:members'),
    null,
    { timeout: 20000 },
  );
  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'aidb:e2e:members' }).first().dblclick();
  await page.waitForSelector('[data-testid="member-input"]', { timeout: 10000 });
  await page.fill('[data-testid="member-input"]', 'beta');
  await page.click('[data-testid="member-add"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="redis-key-grid"]')?.innerText.includes('beta'),
    null,
    { timeout: 20000 },
  );
  check('Redis set member added from the key detail dialog', true);
  await page.click('[data-testid="member-delete-beta"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="redis-key-grid"]')?.innerText.includes('beta'),
    null,
    { timeout: 20000 },
  );
  check('Redis set member removed from the key detail dialog', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 10000 });

  // list 键：双击行按索引改写
  await page.click('[data-testid="open-key-create"]');
  await page.waitForSelector('[data-testid="key-create-name"]', { timeout: 10000 });
  await page.fill('[data-testid="key-create-name"]', 'aidb:e2e:list');
  await page.selectOption('[data-testid="key-create-type"]', 'list');
  await page.fill('[data-testid="key-create-value"]', '["one"]');
  await page.click('[data-testid="key-create-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('aidb:e2e:list'),
    null,
    { timeout: 20000 },
  );
  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'aidb:e2e:list' }).first().dblclick();
  await page.waitForSelector('[data-testid="redis-key-grid"] tbody tr', { timeout: 10000 });
  await page.locator('[data-testid="redis-key-grid"] tbody tr').first().dblclick();
  await page.waitForSelector('[data-testid="list-item-value"]', { timeout: 10000 });
  await page.fill('[data-testid="list-item-value"]', 'rewritten');
  await page.click('[data-testid="list-item-save"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="redis-key-grid"]')?.innerText.includes('rewritten'),
    null,
    { timeout: 20000 },
  );
  check('Redis list element rewritten by index from the key detail dialog', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 10000 });

  if (REDIS_STACK) {
    await page.waitForSelector('[title="搜索索引 aidb_e2e"]', { timeout: 20000 });
    check('Redis Stack exposes RediSearch indexes', true);
    await page.click('[title="搜索索引 aidb_e2e"]');
    await page.locator('[data-testid="query-run"]').last().click();
    await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
    const searchRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
    check('FT.SEARCH returns indexed documents', searchRows === 2, `${searchRows} rows`);

    await page.locator('[title="搜索索引 aidb_e2e"]').click({ button: 'right' });
    await page.click('text=删除索引…');
    await page.waitForSelector('[data-testid="drop-object-confirm"]', { timeout: 10000 });
    await page.fill('[data-testid="drop-object-confirm"]', 'aidb_e2e');
    await page.click('[data-testid="drop-object-submit"]');
    await page.waitForSelector('[title="搜索索引 aidb_e2e"]', { state: 'detached', timeout: 20000 });
    check('RediSearch index dropped from the tree menu', true);
  }
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
  await page.click('[data-testid="result-mode-graph"]');
  await page.waitForSelector('[data-testid="graph-view"]', { timeout: 10000 });
  const graphNodes = await page.locator('[data-testid="graph-node"]').count();
  check('Neo4j graph view renders nodes', graphNodes === 2, `${graphNodes} nodes`);
}

if (DM_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'DM E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'dm');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(DM_PORT));
  await page.fill('[data-testid="connection-password"]', DM_PASSWORD);
  await page.click('[data-testid="connection-save"]');
  const dmRow = page.locator('.conn-row', { hasText: 'DM E2E' });
  await dmRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="TABLE AIDB_E2E"]', { timeout: 30000 });
  check('DM connection expands to tables', true);
  await page.click('[title="TABLE AIDB_E2E"]');
  await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
  const dmRows = await page.locator('[data-testid="data-grid"] tbody tr').count();
  check('DM data grid returns rows', dmRows === 2, `${dmRows} rows`);
}

if (QDRANT_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'Qdrant E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'qdrant');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(QDRANT_PORT));
  await page.fill('[data-testid="connection-database"]', 'default');
  await page.click('[data-testid="connection-save"]');
  const qdrantRow = page.locator('.conn-row', { hasText: 'Qdrant E2E' });
  await qdrantRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="向量集合 aidb_e2e"]', { timeout: 25000 });
  check('Qdrant connection expands to collections', true);
  await page.click('[title="向量集合 aidb_e2e"]');
  await page.waitForSelector('[data-testid="query-run"]', { timeout: 10000 });
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  const qdrantRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
  check('Qdrant scroll returns points', qdrantRows === 2, `${qdrantRows} rows`);

  // 截断提示：topK 小于实际条数时结果标签旁应出现「结果已截断」
  await page.fill('.cm-content', '{"collection":"aidb_e2e","op":"scroll","topK":1}');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-truncated"]', { timeout: 20000 });
  const qdrantLimited = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
  check('Qdrant honours query topK and flags truncation', qdrantLimited === 1, `${qdrantLimited} rows`);
  await page.fill('.cm-content', '{"collection":"aidb_e2e","op":"scroll","topK":20}');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="query-truncated"]')
      && document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 2,
    null,
    { timeout: 20000 },
  );

  await page.click('[data-testid="open-vector-search"]');
  await page.waitForSelector('[data-testid="vector-search-run"]', { timeout: 10000 });
  await page.fill('[data-testid="vector-search-vector"]', '[1, 0, 0]');
  await page.fill('[data-testid="vector-search-topk"]', '2');
  await page.click('[data-testid="vector-search-run"]');
  await page.waitForSelector('[data-testid="vector-result-grid"] tbody tr', { timeout: 20000 });
  const vectorRows = await page.locator('[data-testid="vector-result-grid"] tbody tr').count();
  check('Qdrant vector search returns results', vectorRows === 2, `${vectorRows} rows`);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);

  await page.click('[data-testid="open-document-write"]');
  await page.waitForSelector('[data-testid="document-write-json"]', { timeout: 10000 });
  await page.fill('[data-testid="document-write-collection"]', 'aidb_e2e');
  await page.fill(
    '[data-testid="document-write-json"]',
    JSON.stringify([
      { id: 3, vector: [0, 1, 0], payload: { name: 'Grace' } },
      { id: 4, vector: [0, 0, 1], payload: { name: 'Alan' } },
    ]),
  );
  await page.click('[data-testid="document-write-submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 4, null, { timeout: 20000 });
  check('Qdrant batch write inserts points', true);

  await page.click('[data-testid="open-document-write"]');
  await page.waitForSelector('[data-testid="document-mode-csv"]', { timeout: 10000 });
  await page.fill('[data-testid="document-write-collection"]', 'aidb_e2e');
  await page.click('[data-testid="document-mode-csv"]');
  await page.fill('[data-testid="document-csv-id"]', 'id');
  await page.fill('[data-testid="document-csv-vector"]', 'vector');
  await page.fill(
    '[data-testid="document-csv"]',
    ['id,vector,name', '5,"[0.5, 0.5, 0]",Grace', '6,"[0.6, 0.1, 0]",Alan'].join(String.fromCharCode(10)),
  );
  await page.click('[data-testid="document-write-submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 6, null, { timeout: 25000 });
  check('Qdrant CSV import adds points', true);

  await page.click('[data-testid="open-document-write"]');
  await page.waitForSelector('[data-testid="document-mode-delete"]', { timeout: 10000 });
  await page.fill('[data-testid="document-write-collection"]', 'aidb_e2e');
  await page.click('[data-testid="document-mode-delete"]');
  await page.fill('[data-testid="document-delete-ids"]', '3, 4, 5, 6');
  await page.click('[data-testid="document-write-submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 2, null, { timeout: 20000 });
  check('Qdrant delete by ids removes points', true);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'Ada' }).first().dblclick();
  await page.waitForSelector('[data-testid="doc-edit-json"]', { timeout: 10000 });
  const editedPoint = JSON.parse(await page.locator('[data-testid="doc-edit-json"]').inputValue());
  editedPoint.payload.name = 'Ada Lovelace';
  await page.fill('[data-testid="doc-edit-json"]', JSON.stringify(editedPoint, null, 2));
  await page.click('[data-testid="doc-edit-save"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('Ada Lovelace'), null, { timeout: 25000 });
  check('Qdrant point edited from the result grid keeps its vector', true);
  await page.waitForTimeout(200);

  await page.locator('.tree-node.folder-node', { hasText: '向量集合' }).last().click({ button: 'right' });
  await page.click('text=新建集合…');
  await page.waitForSelector('[data-testid="create-object-name"]', { timeout: 10000 });
  await page.fill('[data-testid="create-object-name"]', 'aidb_uicreated');
  await page.fill('[data-testid="create-object-dimension"]', '2');
  await page.click('[data-testid="create-object-submit"]');
  await page.waitForSelector('[title="向量集合 aidb_uicreated"]', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 10000 });
  check('Collection created from the tree menu closes the dialog', true);

  await page.locator('[title="向量集合 aidb_uicreated"]').click({ button: 'right' });
  await page.click('text=删除集合…');
  await page.waitForSelector('[data-testid="drop-object-confirm"]', { timeout: 10000 });
  await page.fill('[data-testid="drop-object-confirm"]', 'aidb_uicreated');
  await page.click('[data-testid="drop-object-submit"]');
  await page.waitForSelector('[title="向量集合 aidb_uicreated"]', { state: 'detached', timeout: 20000 });
  check('Collection dropped from the tree menu disappears', true);

  const openVectorInfo = async () => {
    await page.locator('[title="向量集合 aidb_e2e"]').click({ button: 'right' });
    await page.click('text=对象信息');
    await page.waitForSelector('[data-testid="create-index-open"]', { timeout: 10000 });
  };
  await openVectorInfo();
  await page.locator('[data-testid="object-info-index-name"]', { hasText: 'name' }).first().waitFor({ timeout: 10000 });
  check('Qdrant payload index shows in object info', true);
  await page.click('[data-testid="create-index-open"]');
  await page.fill('[data-testid="index-fields"]', 'weight');
  await page.selectOption('[data-testid="index-type"]', 'integer');
  await page.click('[data-testid="index-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await openVectorInfo();
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="object-info-index-name"]')].some((cell) => cell.textContent === 'weight'),
    null,
    { timeout: 20000 },
  );
  check('Qdrant payload index created from the panel', true);

  await page.locator('.tool-table tr', { hasText: 'weight' }).locator('[data-testid="index-drop-open"]').click();
  await page.fill('[data-testid="index-drop-confirm"]', 'weight');
  await page.click('[data-testid="index-drop-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await openVectorInfo();
  await page.waitForFunction(
    () => ![...document.querySelectorAll('[data-testid="object-info-index-name"]')].some((cell) => cell.textContent === 'weight'),
    null,
    { timeout: 20000 },
  );
  check('Qdrant payload index dropped from the panel', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);
}

if (TDENGINE_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'TDengine E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'tdengine');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(TDENGINE_PORT));
  await page.fill('[data-testid="connection-password"]', 'taosdata');
  await page.fill('[data-testid="connection-database"]', 'aidb_e2e');
  await page.click('[data-testid="connection-save"]');
  const tdRow = page.locator('.conn-row', { hasText: 'TDengine E2E' });
  await tdRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="TABLE meters"]', { timeout: 30000 });
  check('TDengine connection expands to stables', true);
  await page.click('[title="TABLE meters"]');
  await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
  const tdRows = await page.locator('[data-testid="data-grid"] tbody tr').count();
  check('TDengine data grid returns rows', tdRows === 2, `${tdRows} rows`);
}

if (FALKORDB_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'FalkorDB E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'falkordb');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(FALKORDB_PORT));
  await page.fill('[data-testid="connection-database"]', FALKORDB_GRAPH);
  await page.click('[data-testid="connection-save"]');
  const falkorRow = page.locator('.conn-row', { hasText: 'FalkorDB E2E' });
  await falkorRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="节点标签 Person"]', { timeout: 25000 });
  check('FalkorDB connection expands to labels', true);
  await page.click('[title="节点标签 Person"]');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  const falkorRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
  check('FalkorDB Cypher query returns nodes', falkorRows === 2, `${falkorRows} rows`);
  await page.click('[data-testid="result-mode-graph"]');
  await page.waitForSelector('[data-testid="graph-view"]', { timeout: 10000 });
  const falkorNodes = await page.locator('[data-testid="graph-node"]').count();
  check('FalkorDB graph view renders nodes', falkorNodes === 2, `${falkorNodes} nodes`);
}


if (ARANGO_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'ArangoDB E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'arangodb');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(ARANGO_PORT));
  await page.fill('[data-testid="connection-database"]', ARANGO_DB);
  await page.fill('[data-testid="connection-username"]', 'root');
  await page.fill('[data-testid="connection-password"]', ARANGO_PASSWORD);
  await page.click('[data-testid="connection-save"]');
  const arangoRow = page.locator('.conn-row', { hasText: 'ArangoDB E2E' });
  await arangoRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="文档集合 person"]', { timeout: 25000 });
  check('ArangoDB connection expands to collections', true);
  await page.click('[title="文档集合 person"]');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  const arangoRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
  check('ArangoDB AQL query returns documents', arangoRows === 2, `${arangoRows} rows`);
  await page.click('[title="边集合 knows"]');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  await page.click('[data-testid="result-mode-graph"]');
  await page.waitForSelector('[data-testid="graph-view"]', { timeout: 10000 });
  const arangoNodes = await page.locator('[data-testid="graph-node"]').count();
  check('ArangoDB graph view renders edges', arangoNodes === 2, `${arangoNodes} nodes`);
  await page.locator('[data-testid="graph-node"]').first().click();
  await page.waitForSelector('[data-testid="graph-detail"]', { timeout: 5000 });
  check('ArangoDB graph node opens property panel', true);
  await page.click('[data-testid="graph-zoom-in"]');
  const graphZoom = await page.locator('[data-testid="graph-view"]').getAttribute('data-zoom');
  check('ArangoDB graph zoom control changes scale', graphZoom === '120%', String(graphZoom));

  const exportDir = join(home, 'exports');
  const beforeExport = readdirSync(exportDir).length;
  await page.click('[data-testid="query-export"]');
  let exportedFile = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const files = readdirSync(exportDir);
    if (files.length > beforeExport) {
      exportedFile = files[files.length - 1];
      break;
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 250));
  }
  const exportedCsv = exportedFile ? await readFile(join(exportDir, exportedFile), 'utf8') : '';
  check('ArangoDB export writes CSV from the query window', exportedFile.endsWith('.csv') && /person\/ada/.test(exportedCsv), exportedFile);

  await page.locator('.tree-node.folder-node[data-engine="arangodb"]').last().click({ button: 'right' });
  await page.click('text=新建集合…');
  await page.waitForSelector('[data-testid="create-object-kind"]', { timeout: 10000 });
  await page.fill('[data-testid="create-object-name"]', 'aidb_ui_col');
  await page.selectOption('[data-testid="create-object-kind"]', 'edge');
  await page.click('[data-testid="create-object-submit"]');
  await page.waitForSelector('[title="边集合 aidb_ui_col"]', { timeout: 20000 });
  check('ArangoDB edge collection created from the tree menu', true);

  await page.locator('[title="边集合 aidb_ui_col"]').click({ button: 'right' });
  await page.click('text=删除边集合…');
  await page.waitForSelector('[data-testid="drop-object-confirm"]', { timeout: 10000 });
  await page.fill('[data-testid="drop-object-confirm"]', 'aidb_ui_col');
  await page.click('[data-testid="drop-object-submit"]');
  await page.waitForSelector('[title="边集合 aidb_ui_col"]', { state: 'detached', timeout: 20000 });
  check('ArangoDB collection dropped from the tree menu', true);

  await page.click('[title="文档集合 person"]');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 2, null, { timeout: 20000 });
  await page.click('[data-testid="open-document-write"]');
  await page.waitForSelector('[data-testid="document-write-json"]', { timeout: 10000 });
  await page.fill('[data-testid="document-write-collection"]', 'person');
  await page.fill('[data-testid="document-write-json"]', JSON.stringify({ _key: 'grace', name: 'Grace', age: 45 }));
  await page.click('[data-testid="document-write-submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 3, null, { timeout: 20000 });
  check('ArangoDB document write inserts by _key', true);

  await page.click('[data-testid="open-document-write"]');
  await page.waitForSelector('[data-testid="document-mode-delete"]', { timeout: 10000 });
  await page.fill('[data-testid="document-write-collection"]', 'person');
  await page.click('[data-testid="document-mode-delete"]');
  await page.fill('[data-testid="document-delete-ids"]', 'grace');
  await page.click('[data-testid="document-write-submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 2, null, { timeout: 20000 });
  check('ArangoDB delete by _key removes the document', true);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'Linus' }).first().dblclick();
  await page.waitForSelector('[data-testid="doc-edit-json"]', { timeout: 10000 });
  const editedArango = JSON.parse(await page.locator('[data-testid="doc-edit-json"]').inputValue());
  editedArango.name = 'Linus Torvalds';
  await page.fill('[data-testid="doc-edit-json"]', JSON.stringify(editedArango, null, 2));
  await page.click('[data-testid="doc-edit-save"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('Linus Torvalds'),
    null,
    { timeout: 25000 },
  );
  check('ArangoDB document edited from the result grid', true);
  await page.waitForTimeout(200);

  const openArangoInfo = async () => {
    await page.locator('[title="文档集合 person"]').click({ button: 'right' });
    await page.click('text=对象信息');
    await page.waitForSelector('[data-testid="create-index-open"]', { timeout: 10000 });
  };
  await openArangoInfo();
  await page.locator('[data-testid="object-info-index-name"]', { hasText: 'primary' }).first().waitFor({ timeout: 10000 });
  check('ArangoDB indexes show in object info', true);
  await page.click('[data-testid="create-index-open"]');
  await page.fill('[data-testid="index-fields"]', 'name');
  await page.click('[data-testid="index-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await openArangoInfo();
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="object-info-index-name"]')].some((cell) => cell.textContent === 'name'),
    null,
    { timeout: 20000 },
  );
  check('ArangoDB inverted index created from the panel', true);

  await page.locator('.tool-table tr', { hasText: 'name' }).locator('[data-testid="index-drop-open"]').first().click();
  await page.fill('[data-testid="index-drop-confirm"]', 'name');
  await page.click('[data-testid="index-drop-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await openArangoInfo();
  await page.waitForFunction(
    () => ![...document.querySelectorAll('[data-testid="object-info-index-name"]')].some((cell) => cell.textContent === 'name'),
    null,
    { timeout: 20000 },
  );
  check('ArangoDB index dropped from the panel', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);
}

if (ES_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'Elasticsearch E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'elasticsearch');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(ES_PORT));
  await page.click('[data-testid="connection-save"]');
  await page.locator('.conn-row', { hasText: 'Elasticsearch E2E' }).waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="索引 aidb_es_ui"]', { timeout: 25000 });
  check('Elasticsearch connection expands to indices', true);
  await page.click('[title="索引 aidb_es_ui"]');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  check('Elasticsearch search DSL returns documents', true);

  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'hello' }).first().dblclick();
  await page.waitForSelector('[data-testid="doc-edit-json"]', { timeout: 10000 });
  const editedEsDoc = JSON.parse(await page.locator('[data-testid="doc-edit-json"]').inputValue());
  editedEsDoc.message = 'hello world';
  await page.fill('[data-testid="doc-edit-json"]', JSON.stringify(editedEsDoc, null, 2));
  await page.click('[data-testid="doc-edit-save"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('hello world'), null, { timeout: 25000 });
  check('Elasticsearch document edited from the result grid', true);
  await page.waitForTimeout(200);

  const openEsInfo = async () => {
    await page.locator('[title="索引 aidb_es_ui"]').click({ button: 'right' });
    await page.click('text=对象信息');
    await page.waitForSelector('[data-testid="create-field-open"]', { timeout: 10000 });
  };
  await openEsInfo();
  await page.click('[data-testid="create-field-open"]');
  await page.fill('[data-testid="field-name"]', 'extra_ui');
  await page.selectOption('[data-testid="field-type"]', 'keyword');
  await page.click('[data-testid="field-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await openEsInfo();
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="object-info-column-name"]')].some((cell) => cell.textContent === 'extra_ui'),
    null,
    { timeout: 20000 },
  );
  check('Elasticsearch mapping field added from object info', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);

  await page.locator('[title="索引 aidb_es_ui"]').click({ button: 'right' });
  await page.click('text=删除索引…');
  await page.waitForSelector('[data-testid="drop-object-confirm"]', { timeout: 10000 });
  await page.fill('[data-testid="drop-object-confirm"]', 'aidb_es_ui');
  await page.click('[data-testid="drop-object-submit"]');
  await page.waitForSelector('[title="索引 aidb_es_ui"]', { state: 'detached', timeout: 20000 });
  check('Elasticsearch index dropped from the tree menu', true);
}

if (WEAVIATE_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'Weaviate E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'weaviate');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(WEAVIATE_PORT));
  await page.click('[data-testid="connection-save"]');
  await page.locator('.conn-row', { hasText: 'Weaviate E2E' }).waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="向量集合 AidbUiClass"]', { timeout: 25000 });
  check('Weaviate connection expands to classes', true);

  await page.click('[title="向量集合 AidbUiClass"]');
  await page.waitForSelector('[data-testid="query-run"]', { timeout: 10000 });
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForSelector('[data-testid="query-result-grid"] tbody tr', { timeout: 20000 });
  await page.locator('[data-testid="query-result-grid"] tbody tr', { hasText: 'hello' }).first().dblclick();
  await page.waitForSelector('[data-testid="doc-edit-json"]', { timeout: 10000 });
  const editedWv = JSON.parse(await page.locator('[data-testid="doc-edit-json"]').inputValue());
  editedWv.properties.title = 'hello weaviate';
  await page.fill('[data-testid="doc-edit-json"]', JSON.stringify(editedWv, null, 2));
  await page.click('[data-testid="doc-edit-save"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="query-result-grid"]')?.innerText.includes('hello weaviate'), null, { timeout: 25000 });
  check('Weaviate object edited from the result grid', true);
  await page.waitForTimeout(200);

  await page.locator('[title="向量集合 AidbUiClass"]').click({ button: 'right' });
  await page.click('text=对象信息');
  await page.locator('[data-testid="object-info-column-name"]', { hasText: 'title' }).first().waitFor({ timeout: 10000 });
  await page.click('[data-testid="create-field-open"]');
  await page.fill('[data-testid="field-name"]', 'views_ui');
  await page.selectOption('[data-testid="field-type"]', 'int');
  await page.click('[data-testid="field-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.locator('[title="向量集合 AidbUiClass"]').click({ button: 'right' });
  await page.click('text=对象信息');
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="object-info-column-name"]')].some((cell) => cell.textContent === 'views_ui'),
    null,
    { timeout: 20000 },
  );
  check('Weaviate class property added from object info', true);
  await page.locator('.modal-head .icon-btn').last().click();
  await page.waitForTimeout(200);

  await page.locator('[title="向量集合 AidbUiClass"]').click({ button: 'right' });
  await page.click('text=删除集合…');
  await page.waitForSelector('[data-testid="drop-object-confirm"]', { timeout: 10000 });
  await page.fill('[data-testid="drop-object-confirm"]', 'AidbUiClass');
  await page.click('[data-testid="drop-object-submit"]');
  await page.waitForSelector('[title="向量集合 AidbUiClass"]', { state: 'detached', timeout: 20000 });
  check('Weaviate class dropped from the tree menu', true);
}

if (INFLUXDB_PORT) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'InfluxDB E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'influxdb');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(INFLUXDB_PORT));
  await page.fill('[data-testid="connection-database"]', INFLUXDB_DB);
  await page.click('[data-testid="connection-save"]');
  const influxRow = page.locator('.conn-row', { hasText: 'InfluxDB E2E' });
  await influxRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="TABLE cpu"]', { timeout: 30000 });
  check('InfluxDB connection expands to measurements', true);
  await page.click('[title="TABLE cpu"]');
  await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
  const influxRows = await page.locator('[data-testid="data-grid"] tbody tr').count();
  // 时序库是追加写且 InfluxDB 3 不支持 DELETE，容器里的样本会跨轮累积，故只断言至少两行。
  check('InfluxDB data grid returns rows', influxRows >= 2, `${influxRows} rows`);

  await page.click('[data-testid="open-line-protocol"]');
  await page.waitForSelector('[data-testid="line-protocol-input"]', { timeout: 10000 });
  await page.fill('[data-testid="line-protocol-input"]', 'cpu,host=ui value=9.5 1700000120000000000');
  await page.click('[data-testid="line-protocol-submit"]');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 20000 });
  await page.click('[data-testid="data-refresh"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="data-grid"]')?.innerText.includes('ui'),
    null,
    { timeout: 25000 },
  );
  check('InfluxDB line-protocol write adds a sample', true);
}

if (MYSQL_TX_PORT) {
  const mysqlTx = await import('mysql2/promise');
  const root = await mysqlTx.createConnection({
    host: '127.0.0.1',
    port: MYSQL_TX_PORT,
    user: 'root',
    password: process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass',
    database: 'aidb_tx',
  });
  await root.query('DROP TABLE IF EXISTS tx_ui');
  await root.query('CREATE TABLE tx_ui (id INT PRIMARY KEY, note VARCHAR(32)) ENGINE=InnoDB');
  await root.query("INSERT INTO tx_ui VALUES (1, 'seed')");
  await root.end();

  // 关系型连接的对话框没有 database 输入框，所以 SQL 一律用限定名，不依赖默认库。
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'MySQL TX E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'mysql');
  await page.fill('[data-testid="connection-host"]', '127.0.0.1');
  await page.fill('[data-testid="connection-port"]', String(MYSQL_TX_PORT));
  await page.fill('[data-testid="connection-username"]', 'root');
  await page.fill('[data-testid="connection-password"]', process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass');
  await page.click('[data-testid="connection-save"]');
  const mysqlTxRow = page.locator('.conn-row', { hasText: 'MySQL TX E2E' });
  await mysqlTxRow.waitFor({ timeout: 20000 });
  check('MySQL connection created for the transaction check', true);

  // 选中该连接后用工具栏的全局「新建查询」，标签页必然绑定到它，不走右键菜单。
  await mysqlTxRow.click();
  await page.click('.tab-add');
  await page.waitForSelector('[data-testid="query-run"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="tx-begin"]', { timeout: 20000 });
  check('MySQL transaction controls appear in the query toolbar', true);

  const execSql = async (sql) => {
    await page.fill('.cm-content', sql);
    await page.locator('[data-testid="query-run"]').last().click();
    await page.waitForTimeout(700);
  };

  await page.click('[data-testid="tx-begin"]');
  await page.waitForSelector('[data-testid="tx-commit"]', { timeout: 15000 });
  check('MySQL transaction starts from the query toolbar', true);

  await execSql("INSERT INTO aidb_tx.tx_ui VALUES (2, 'in-tx')");
  await page.click('[data-testid="tx-rollback"]');
  await page.waitForSelector('[data-testid="tx-begin"]', { timeout: 15000 });
  check('MySQL transaction rolls back from the query toolbar', true);

  await execSql('SELECT COUNT(*) AS n FROM aidb_tx.tx_ui');
  await page.waitForSelector('[data-testid="query-result-grid"]', { timeout: 20000 });
  const rollbackGrid = await page.locator('[data-testid="query-result-grid"]').innerText();
  // 网格文本只用于展示证据；回滚是否真的生效以独立客户端查询为准（见下一条断言）。
  check('MySQL rollback query still returns the seeded rows', /1/.test(rollbackGrid), rollbackGrid.replace(/\s+/g, ' ').slice(0, 80));

  const verify = await mysqlTx.createConnection({
    host: '127.0.0.1',
    port: MYSQL_TX_PORT,
    user: 'root',
    password: process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass',
    database: 'aidb_tx',
  });
  const [rows] = await verify.query('SELECT COUNT(*) AS n FROM tx_ui');
  await verify.end();
  check('MySQL rollback left exactly the seeded row', Number(rows[0].n) === 1, `n=${rows[0].n}`);
}


if (DUCKDB_E2E) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'DuckDB E2E');
  await page.selectOption('[data-testid="connection-engine"]', 'duckdb');
  await page.fill('[data-testid="connection-database"]', duckdbPath);
  await page.click('[data-testid="connection-save"]');
  const duckRow = page.locator('.conn-row', { hasText: 'DuckDB E2E' });
  await duckRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[title="TABLE DUCK_E2E"]', { timeout: 25000 });
  check('DuckDB connection expands to tables', true);
  await page.click('[title="TABLE DUCK_E2E"]');
  await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
  const duckRows = await page.locator('[data-testid="data-grid"] tbody tr').count();
  check('DuckDB data grid returns rows', duckRows === 2, `${duckRows} rows`);
}

if (MONGO_PORT || REDIS_PORT || NEO4J_PORT || DM_PORT || QDRANT_PORT || ES_PORT || WEAVIATE_PORT || DUCKDB_E2E || TDENGINE_PORT || FALKORDB_PORT || INFLUXDB_PORT || ARANGO_PORT || TIMESCALE_PORT) {
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
