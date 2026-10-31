import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright-core';
import zlib from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDist = join(root, 'apps', 'desktop', 'dist');
const mobileDist = join(root, 'apps', 'mobile', 'dist');
const gatewayEntry = join(root, 'apps', 'gateway', 'dist', 'index.js');
const shots = join(root, 'docs', 'screenshots');

// 生成最小 xlsx（ZIP + deflate + sharedStrings），用于导入联机用例
function writeXlsx(path) {
  const files = {
    'xl/sharedStrings.xml': `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${['user_id', 'status', 'channel', 'total_cents', 'created_at', 'xlsx-e2e', 'paid', '2026-01-04T00:00:00.000Z'].map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${['A', 'B', 'C', 'D', 'E'].map((c, i) => `<c r="${c}1" t="s"><v>${i}</v></c>`).join('')}</row><row r="2"><c r="A2"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2" t="s"><v>5</v></c><c r="D2"><v>4500</v></c><c r="E2" t="s"><v>7</v></c></row></sheetData></worksheet>`,
  };
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...parts, centralBuf, eocd]));
}

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

// Chromium 拒绝连接 WHATWG 禁用端口（6000、6665-6669、10080…），随机端口撞上会让 page.goto 直接 ERR_UNSAFE_PORT。
const FETCH_BLOCKED_PORTS = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

function freePort() {
  return new Promise((res, rej) => {
    const server = createNetServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => (FETCH_BLOCKED_PORTS.has(port) ? res(freePort()) : res(port)));
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
check('52 agent tools', boot.tools.length === 52, String(boot.tools.length));
const builtinMcp = (await api('/mcp/servers')).body.servers.filter((server) => server.builtin);
check('built-in MCP servers seeded', ['filesystem', 'git', 'web'].every((kind) => builtinMcp.some((server) => server.builtin === kind)), builtinMcp.map((server) => server.builtin).join(','));

const MONGO_PORT = process.env.AIDB_TEST_MONGO_PORT ? Number(process.env.AIDB_TEST_MONGO_PORT) : undefined;
const REDIS_PORT = process.env.AIDB_TEST_REDIS_PORT ? Number(process.env.AIDB_TEST_REDIS_PORT) : undefined;
const NEO4J_PORT = process.env.AIDB_TEST_NEO4J_PORT ? Number(process.env.AIDB_TEST_NEO4J_PORT) : undefined;
const NEO4J_PASSWORD = process.env.AIDB_TEST_NEO4J_PASSWORD ?? 'testpass';
const DM_PORT = process.env.AIDB_TEST_DM_PORT ? Number(process.env.AIDB_TEST_DM_PORT) : undefined;
const DM_PASSWORD = process.env.AIDB_TEST_DM_PASSWORD ?? 'SYSDBA';
const QDRANT_PORT = process.env.AIDB_TEST_QDRANT_PORT ? Number(process.env.AIDB_TEST_QDRANT_PORT) : undefined;
const MYSQL_TX_PORT = process.env.AIDB_TEST_MYSQL_PORT ? Number(process.env.AIDB_TEST_MYSQL_PORT) : undefined;
const SSH_PORT = process.env.AIDB_TEST_SSH_PORT ? Number(process.env.AIDB_TEST_SSH_PORT) : undefined;
const SSH_TARGET_HOST = process.env.AIDB_TEST_SSH_TARGET_HOST;
const SSH_TARGET_PORT = process.env.AIDB_TEST_SSH_TARGET_PORT ? Number(process.env.AIDB_TEST_SSH_TARGET_PORT) : 3306;
const SSH_USER = process.env.AIDB_TEST_SSH_USER ?? 'root';
const SSH_PASSWORD = process.env.AIDB_TEST_SSH_PASSWORD ?? 'testpass';
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
{
  const rawShot = page.screenshot.bind(page);
  page.screenshot = async (options) => {
    try { return await rawShot(options); } catch (err) { console.log(`WARN screenshot ${options?.path ?? ''}: ${err.message}`); return Buffer.alloc(0); }
  };
}
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
const engineGroups = await page.locator('[data-testid="connection-engine"]').evaluate((el) => [...el.querySelectorAll('optgroup')].map((group) => ({ label: group.label, ids: [...group.querySelectorAll('option')].map((option) => option.value) })));
check(
  'engine picker groups engines by model and family',
  engineGroups.length >= 8
    && engineGroups.some((group) => group.label.includes('MySQL') && group.ids.includes('mysql'))
    && engineGroups.some((group) => group.label.includes('PostgreSQL') && group.ids.includes('postgresql'))
    && engineGroups.some((group) => group.label.includes('文档') && group.ids.includes('mongodb'))
    && engineGroups.some((group) => group.label.includes('向量') && group.ids.includes('qdrant'))
    && engineGroups.some((group) => group.label.includes('图') && group.ids.includes('neo4j')),
  engineGroups.map((group) => group.label).join(' / '),
);
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

  await page.click('[data-testid="query-history"]');
  await page.waitForSelector('[data-testid="history-search"]', { timeout: 5000 });
  await page.fill('[data-testid="history-search"]', 'SELECT');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length >= 1, null, { timeout: 8000 });
  check('query history search filters matches', true);
  await page.fill('[data-testid="history-search"]', 'zzz-no-hit');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 0, null, { timeout: 8000 });
  check('query history search can end empty', true);
  await page.fill('[data-testid="history-search"]', '');
  await page.locator('.history-item').first().locator('[data-testid^="history-favorite-"]').click();
  await page.waitForFunction(() => document.querySelector('.history-item [data-testid^="history-favorite-"]')?.classList.contains('favorited'), null, { timeout: 8000 });
  check('history entry can be favorited', true);
  await page.click('[data-testid="history-favorite-only"]');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length >= 1, null, { timeout: 8000 });
  const favoriteFilterOk = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.history-item')];
    return items.length > 0 && items.every((item) => item.querySelector('[data-testid^="history-favorite-"]')?.classList.contains('favorited'));
  });
  check('history favorite filter shows only starred entries', favoriteFilterOk);
  await page.click('[data-testid="history-favorite-only"]');
  await page.locator('.history-item').first().locator('[data-testid^="history-favorite-"]').click();

  await page.fill('.cm-content', 'select 1 as n from aidb_tx.tx_ui');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Shift+F');
  await page.waitForFunction(() => (document.querySelector('.cm-content')?.textContent ?? '').includes('SELECT 1 AS n'), null, { timeout: 5000 });
  check('Ctrl+Shift+F formats SQL in the editor', true);

  await page.fill('.cm-content', 'SELECT 1 AS a; SELECT 2 AS b;');
  await page.keyboard.press('Control+Shift+Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid="query-result-grid"] thead')?.innerText.includes('b'), null, { timeout: 15000 });
  const statementHeader = await page.locator('[data-testid="query-result-grid"] thead').innerText();
  check('Ctrl+Shift+Enter runs the statement under the cursor', statementHeader.includes('b') && !statementHeader.includes('a'), statementHeader.replace(/\s+/g, ' ').slice(0, 40));

  await page.selectOption('[data-testid="query-limit"]', '100');
  await page.fill('.cm-content', 'WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 150) SELECT n FROM seq');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 100, null, { timeout: 15000 });
  check('query row limit caps at 100', true);
  await page.selectOption('[data-testid="query-limit"]', '500');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="query-result-grid"] tbody tr').length === 150, null, { timeout: 15000 });
  check('query row limit can be raised to 500', true);

  await page.fill('.cm-content', 'WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 500) SELECT n FROM seq');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(() => {
    const count = document.querySelectorAll('[data-testid^="grid-row-"]').length;
    return count > 0 && count < 100;
  }, null, { timeout: 20000 });
  const renderedWindow = await page.locator('[data-testid^="grid-row-"]').count();
  check('large results render a window instead of all rows', renderedWindow < 100, `${renderedWindow} rows`);
  await page.evaluate(() => {
    let el = document.querySelector('[data-testid="query-result-grid"]');
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 10) el.scrollTop = el.scrollHeight;
      el = el.parentElement;
    }
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="grid-row-499"]') !== null, null, { timeout: 8000 });
  check('scrolling to the end renders the last row', true);

  await page.selectOption('[data-testid="query-export-format"]', 'xlsx');
  const queryExportPromise = page.waitForResponse((res) => res.url().includes('/api/export') && (res.request().postData() ?? '').includes('"format":"xlsx"'), { timeout: 20000 }).catch(() => null);
  await page.click('[data-testid="query-export"]');
  const queryExportResponse = await queryExportPromise;
  check('query result export supports XLSX', Boolean(queryExportResponse && queryExportResponse.status() === 200), queryExportResponse ? String(queryExportResponse.status()) : 'no response');

  const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.keyboard.press('Control+S');
  const sqlDownload = await downloadPromise;
  check('Ctrl+S downloads the current SQL', Boolean(sqlDownload && sqlDownload.suggestedFilename().endsWith('.sql')), sqlDownload?.suggestedFilename() ?? 'no download');

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

if (SSH_PORT && SSH_TARGET_HOST) {
  await page.click('[data-testid="sidebar-new-connection"]');
  await page.waitForSelector('[data-testid="connection-engine"]', { timeout: 10000 });
  await page.fill('[data-testid="connection-name"]', 'MySQL over SSH');
  await page.selectOption('[data-testid="connection-engine"]', 'mysql');
  await page.fill('[data-testid="connection-host"]', SSH_TARGET_HOST);
  await page.fill('[data-testid="connection-port"]', String(SSH_TARGET_PORT));
  await page.fill('[data-testid="connection-username"]', 'root');
  await page.check('[data-testid="ssh-enabled"]');
  await page.fill('[data-testid="ssh-host"]', '127.0.0.1');
  await page.fill('[data-testid="ssh-port"]', String(SSH_PORT));
  await page.fill('[data-testid="ssh-user"]', SSH_USER);
  await page.fill('[data-testid="ssh-password"]', SSH_PASSWORD);
  // 密码最后填：复选框重渲染会覆盖此前由自动化写入、但 React 状态未同步的密码值
  await page.fill('[data-testid="connection-password"]', process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass');
  check('SSH form keeps the database password', (await page.inputValue('[data-testid="connection-password"]')) === (process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass'));
  await page.click('[data-testid="connection-save"]');
  const sshRow = page.locator('.conn-row', { hasText: 'MySQL over SSH' });
  await sshRow.waitFor({ timeout: 30000 });
  check('MySQL connection created through the SSH tunnel', true);

  await sshRow.click();
  await page.click('.tab-add');
  await page.waitForSelector('[data-testid="query-run"]', { timeout: 20000 });
  // 多标签场景下显式绑定到隧道连接，避免标签页复用上一个连接的上下文
  await page.selectOption('[data-testid="query-connection"]', { label: 'MySQL over SSH' });
  const sshBound = await page.locator('[data-testid="query-connection"]').last().evaluate((el) => el.selectedOptions[0]?.textContent ?? '');
  check('SSH query tab is bound to the tunnel connection', sshBound.includes('MySQL over SSH'), sshBound);
  await page.fill('.cm-content', 'SELECT 1 AS n');
  await page.locator('[data-testid="query-run"]').last().click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="query-result-grid"] tbody tr') || document.querySelector('.messages-panel .err')),
    null,
    { timeout: 30000 },
  );
  const sshError = await page.locator('.messages-panel .err').count();
  const sshGrid = sshError ? await page.locator('.messages-panel .err').first().innerText() : await page.locator('[data-testid="query-result-grid"] tbody tr').first().innerText();
  check('Query over the SSH tunnel returns a row', !sshError && /1/.test(sshGrid), sshGrid.replace(/\s+/g, ' ').slice(0, 60));
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
const toolboxLabels = await page.locator('.tools-nav button').allInnerTexts();
check('database toolbox does not list agent features', !toolboxLabels.some((text) => /Skills|MCP|通知渠道|命令工作流/.test(text)), toolboxLabels.join(' | '));
await page.locator('.tools-modal .modal-head .icon-btn').click();
await page.waitForTimeout(200);
await page.click('[data-testid="open-settings"]');
await page.locator('.settings-nav button').filter({ hasText: '通知' }).click();
await page.waitForFunction(() => document.querySelector('.settings-content')?.textContent?.includes('飞书群机器人'), null, { timeout: 10000 });
const platformButtons = await page.locator('.settings-content .btn').allInnerTexts();
check('notification presets cover seven platforms', ['飞书群机器人','企业微信群机器人','钉钉群机器人','Slack','Discord','Telegram','QQ（OneBot HTTP）'].every((label) => platformButtons.includes(label)), platformButtons.join('|'));
check('settings notification channels panel renders', true);
await page.locator('.settings-nav button').filter({ hasText: 'MCP' }).click();
await page.waitForFunction(() => document.querySelector('.settings-content')?.textContent?.includes('新增 MCP Server'), null, { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.settings-content .transfer-row').length >= 3, null, { timeout: 10000 });
const mcpText = await page.locator('.settings-content').evaluate((el) => el.textContent ?? '');
check('built-in MCP cards render', mcpText.includes('文件系统') && mcpText.includes('内置') && mcpText.includes('Git'), mcpText.slice(0, 160));
const fsCard = page.locator('.settings-content .panel > div').filter({ hasText: '文件系统' }).first();
await fsCard.locator('input').first().fill(home);
await fsCard.getByRole('button', { name: '添加' }).click();
await page.waitForFunction((value) => document.querySelector('.settings-content')?.textContent?.includes(value), home, { timeout: 10000 });
await fsCard.getByRole('button', { name: '发现工具' }).click();
await page.waitForFunction(() => document.querySelector('.settings-content')?.textContent?.includes('read_file'), null, { timeout: 10000 });
check('built-in filesystem tools are discoverable', true);
check('settings MCP panel renders', true);

// Agent 工具目录（只读）
await page.locator('.settings-content [data-testid="agent-tool-catalog"] .panel-head').click();
await page.waitForFunction(() => document.querySelectorAll('.settings-content .agent-catalog-row').length > 0, null, { timeout: 10000 });
const catalogRows = await page.locator('.settings-content .agent-catalog-row').count();
const catalogGroups = await page.locator('.settings-content .agent-catalog-group-head').count();
check(
  'agent tool catalog lists every tool grouped by capability',
  catalogRows === 52 && catalogGroups >= 8,
  `rows=${catalogRows} groups=${catalogGroups}`,
);
const catalogText = await page.locator('.settings-content [data-testid="agent-tool-catalog"]').evaluate((el) => el.textContent ?? '');
check('run_sql appears in the catalog with its multi-statement constraint', /run_sql/.test(catalogText) && catalogText.includes('允许多语句'));
check('catalog marks MCP tools as gated by the MCP switch', catalogText.includes('总开关'));
await page.locator('.settings-content [data-testid="agent-tool-catalog"] input[aria-label="过滤 Agent 工具"]').fill('事务');
await page.waitForFunction(() => document.querySelectorAll('.settings-content .agent-catalog-row').length === 7, null, { timeout: 5000 });
const filteredRows = await page.locator('.settings-content .agent-catalog-row').count();
check('catalog filter narrows to the matching group', filteredRows === 7, `rows=${filteredRows}`);
await page.locator('.settings-content [data-testid="agent-tool-catalog"] input[aria-label="过滤 Agent 工具"]').fill('');
const catalogToggles = await page.locator('.settings-content [data-testid="agent-tool-catalog"] input[type="checkbox"], .settings-content [data-testid="agent-tool-catalog"] button').count();
check('catalog is read-only (no switches or buttons inside)', catalogToggles === 0, `controls=${catalogToggles}`);
await page.locator('.settings-content [data-testid="agent-tool-catalog"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, 'desktop-agent-tools.png') });
await page.locator('.settings-nav button').filter({ hasText: '网络搜索' }).click();
await page.waitForFunction(() => document.querySelector('.settings-content')?.textContent?.includes('已启用后端'), null, { timeout: 10000 });
await page.waitForSelector('.settings-content .search-backend', { timeout: 10000 });
const searchText = await page.locator('.settings-content').evaluate((el) => el.textContent ?? '');
check('search settings render 11 backends', searchText.includes('已启用后端') && ['Exa', 'Parallel', 'DuckDuckGo', 'SearXNG', 'Brave', 'Tavily', 'Serper', 'Mojeek', 'DeepSeek', 'Anthropic', 'OpenAI'].every((label) => searchText.includes(label)), searchText.slice(0, 160));
const searchBackends = await page.locator('.settings-content .search-backend').count();
const checkedBackends = await page.locator('.settings-content .search-backend input:checked').count();
check('search panel lists every backend with four free defaults', searchBackends === 11 && checkedBackends === 4, `${searchBackends} rows / ${checkedBackends} checked`);
check('search panel groups global params and result strategy', searchText.includes('全局参数') && searchText.includes('结果策略') && searchText.includes('numResults') && searchText.includes('backendTimeoutMs'));
const searchKeyInputs = await page.locator('.settings-content .search-key input').count();
check('search panel exposes seven key fields plus searxng', searchKeyInputs === 8, `${searchKeyInputs} key inputs`);
check('search settings have no key required for free backends', searchText.includes('已配置密钥：0/7'), searchText.slice(0, 160));
await page.screenshot({ path: join(shots, 'desktop-search-settings.png') });
// A key typed here must land in the encrypted vault and never echo back into the page.
const braveKey = page.locator('.settings-content .search-key input[aria-label="brave API Key"]');
await braveKey.fill('brave-e2e-key');
await page.locator('.settings-content .search-actions button.btn.primary').click();
await page.waitForFunction(() => document.querySelector('.settings-content')?.textContent?.includes('已配置密钥：1/7'), null, { timeout: 10000 });
const afterKeyText = await page.locator('.settings-content').evaluate((el) => el.textContent ?? '');
check('search key saves without echoing secret', afterKeyText.includes('已配置密钥：1/7') && !afterKeyText.includes('brave-e2e-key'));
check('settings search panel renders', true);
await page.locator('.settings-content .search-key input[aria-label="brave API Key"]').fill('__CLEAR__');
await page.locator('.settings-content .search-actions button.btn.primary').click();
await page.waitForFunction(() => document.querySelector('.settings-content')?.textContent?.includes('已配置密钥：0/7'), null, { timeout: 10000 });
check('search key can be cleared', true);
const searchBackendBefore = (await api('/search/backends')).body;
await page.locator('.settings-content .search-actions button').filter({ hasText: '重置状态' }).click();
await page.waitForFunction(() => document.body.textContent?.includes('已重置后端健康状态'), null, { timeout: 10000 });
const searchBackendAfter = (await api('/search/backends')).body;
check('search health telemetry resets', searchBackendAfter.health.every((item) => item.status === 'idle' && item.failures === 0) && searchBackendBefore.backends.length === 11, JSON.stringify(searchBackendAfter.health.slice(0, 2)));
check('reset button drives the health endpoint', true);
await page.locator('.settings-nav button').filter({ hasText: 'Skills' }).click();
await page.waitForFunction(() => document.querySelector('.settings-content')?.textContent?.includes('3 个可用'), null, { timeout: 10000 });
const settingsSkillsText = await page.locator('.settings-content').innerText();
check('built-in skills are preinstalled', settingsSkillsText.includes('3 个内置'), settingsSkillsText.slice(0, 120));
check('settings Skills panel renders', true);
await page.locator('.settings-modal .modal-head .icon-btn').click();
await page.waitForTimeout(200);

await page.click('[data-testid="welcome-open-demo"]');
await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 15000 });
const gridRows = await page.locator('[data-testid="data-grid"] tbody tr').count();
check('data grid opens demo table', gridRows === 100, `${gridRows} rows`);
check('data grid shows row numbers', (await page.locator('[data-testid="grid-row-0"] td').first().innerText()) === '1');

await page.click('[data-testid="data-columns"]');
await page.waitForSelector('[data-testid="columns-panel"]', { timeout: 5000 });
await page.uncheck('[data-testid="column-toggle-status"]');
await page.locator('.modal-head .icon-btn').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="columns-panel"]'), null, { timeout: 5000 });
const headersHidden = await page.locator('[data-testid="data-grid"] thead').innerText();
check('column visibility hides a column', !headersHidden.includes('status'), headersHidden.replace(/\s+/g, ' ').slice(0, 80));
await page.click('[title="TABLE users"]');
await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
await page.click('[title="TABLE orders"]');
await page.waitForFunction(() => (document.querySelector('[data-testid="data-grid"] thead')?.innerText ?? '').includes('user_id'), null, { timeout: 20000 });
const headersAfterSwitch = await page.locator('[data-testid="data-grid"] thead').innerText();
check('column visibility persists per table', !headersAfterSwitch.includes('status'), headersAfterSwitch.replace(/\s+/g, ' ').slice(0, 80));
await page.click('[data-testid="data-columns"]');
await page.waitForSelector('[data-testid="columns-panel"]', { timeout: 5000 });
await page.check('[data-testid="column-toggle-status"]');
await page.locator('.modal-head .icon-btn').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="columns-panel"]'), null, { timeout: 5000 });
const headersShown = await page.locator('[data-testid="data-grid"] thead').innerText();
check('column visibility restores a column', headersShown.includes('status'), headersShown.replace(/\s+/g, ' ').slice(0, 80));

await page.click('[data-testid="data-sort"]');
await page.waitForSelector('[data-testid="sort-row-0"]', { timeout: 5000 });
await page.selectOption('[data-testid="sort-column-0"]', 'status');
await page.click('[data-testid="sort-add"]');
await page.selectOption('[data-testid="sort-column-1"]', 'total_cents');
await page.selectOption('[data-testid="sort-dir-1"]', 'desc');
const sortRequestPromise = page.waitForRequest((req) => req.url().includes('/api/data?')
  && req.url().includes('orderBy=status%2Ctotal_cents')
  && req.url().includes('orderDir=asc%2Cdesc'), { timeout: 10000 });
await page.click('[data-testid="sort-apply"]');
const multiSortRequest = await sortRequestPromise.catch(() => null);
check('multi-column sort is sent to the data API', Boolean(multiSortRequest), multiSortRequest ? decodeURIComponent(multiSortRequest.url()).slice(0, 120) : 'request not observed');
await page.waitForTimeout(700);
await page.click('[data-testid="data-sort"]');
await page.waitForSelector('[data-testid="sort-row-0"]', { timeout: 5000 });
await page.click('[data-testid="sort-clear"]');
await page.waitForTimeout(700);

await page.click('[data-testid="data-form-mode"]');
await page.waitForSelector('[data-testid="data-form-view"]', { timeout: 5000 });
await page.waitForFunction(() => (document.querySelector('[data-testid="form-field-id"]')?.value ?? '') !== '', null, { timeout: 5000 });
const formId = await page.inputValue('[data-testid="form-field-id"]');
check('form view shows the selected row', formId !== '', `id=${formId}`);
const formTotal = await page.inputValue('[data-testid="form-field-total_cents"]');
await page.fill('[data-testid="form-field-channel"]', 'form-e2e');
await page.click('[data-testid="form-save"]');
await page.waitForFunction(() => document.querySelector('[data-testid="form-field-channel"]')?.value === 'form-e2e', null, { timeout: 15000 });
await page.click('[data-testid="data-form-mode"]');
await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 10000 });
await page.waitForFunction(() => document.querySelector('[data-testid="data-grid"]')?.innerText.includes('form-e2e'), null, { timeout: 15000 });
check('form view saves the edited row', true, `id=${formId} total=${formTotal}`);

const jsonImportPath = join(home, 'import-e2e.json');
writeFileSync(jsonImportPath, JSON.stringify([{ user_id: 1, status: 'paid', channel: 'json-e2e', total_cents: 4200, created_at: '2026-01-01T00:00:00.000Z' }]));
const xmlImportPath = join(home, 'import-e2e.xml');
writeFileSync(xmlImportPath, '<rows><row><user_id>2</user_id><status>paid</status><channel>xml-e2e</channel><total_cents>4300</total_cents><created_at>2026-01-02T00:00:00.000Z</created_at></row></rows>');
await page.setInputFiles('[data-testid="data-import-file"]', jsonImportPath);
await page.waitForSelector('[data-testid="import-confirm"]', { timeout: 5000 });
check('JSON import preview maps columns', (await page.locator('.modal').innerText()).includes('json-e2e'));
await page.click('[data-testid="import-confirm"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="import-confirm"]'), null, { timeout: 20000 });
await page.waitForTimeout(900);
const jsonImportResult = await api(`/data?connectionId=${demo.id}&table=orders&limit=5&where=${encodeURIComponent("channel='json-e2e'")}`);
check('JSON import inserts a row', jsonImportResult.status === 200 && jsonImportResult.body.total >= 1, `total=${jsonImportResult.body?.total}`);

await page.setInputFiles('[data-testid="data-import-file"]', xmlImportPath);
await page.waitForSelector('[data-testid="import-confirm"]', { timeout: 5000 });
check('XML import preview maps columns', (await page.locator('.modal').innerText()).includes('xml-e2e'));
await page.click('[data-testid="import-confirm"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="import-confirm"]'), null, { timeout: 20000 });
await page.waitForTimeout(900);
const xmlImportResult = await api(`/data?connectionId=${demo.id}&table=orders&limit=5&where=${encodeURIComponent("channel='xml-e2e'")}`);
check('XML import inserts a row', xmlImportResult.status === 200 && xmlImportResult.body.total >= 1, `total=${xmlImportResult.body?.total}`);

const printExpected = (await api(`/data?connectionId=${demo.id}&table=orders&limit=1`)).body.total;
await page.click('[data-testid="data-print"]');
await page.waitForSelector('[data-testid="print-frame"]', { timeout: 30000 });
const printFrame = page.frameLocator('[data-testid="print-frame"]');
await printFrame.locator('table tbody tr').first().waitFor({ timeout: 10000 });
const printRowCount = await printFrame.locator('table tbody tr').count();
check('print preview renders the whole table', printRowCount === printExpected, `${printRowCount}/${printExpected}`);
check('print preview shows the table title', (await printFrame.locator('h1').innerText()).includes('orders'));
await page.locator('.modal-head .icon-btn').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="print-frame"]'), null, { timeout: 5000 });

const xlsxImportPath = join(home, 'import-e2e.xlsx');
writeXlsx(xlsxImportPath);
await page.setInputFiles('[data-testid="data-import-file"]', xlsxImportPath);
await page.waitForSelector('[data-testid="import-confirm"]', { timeout: 5000 });
check('XLSX import preview maps columns', (await page.locator('.modal').innerText()).includes('xlsx-e2e'));
await page.click('[data-testid="import-confirm"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="import-confirm"]'), null, { timeout: 20000 });
await page.waitForTimeout(900);
const xlsxImportResult = await api(`/data?connectionId=${demo.id}&table=orders&limit=5&where=${encodeURIComponent("channel='xlsx-e2e'")}`);
check('XLSX import inserts a row', xlsxImportResult.status === 200 && xlsxImportResult.body.total >= 1, `total=${xlsxImportResult.body?.total}`);

const exportResponsePromise = page.waitForResponse((res) => res.url().includes('/api/export') && (res.request().postData() ?? '').includes('"format":"xlsx"'), { timeout: 20000 }).catch(() => null);
await page.click('[data-testid="data-export"]');
await page.locator('[data-testid="context-menu"] .context-item', { hasText: 'XLSX' }).click();
const exportedXlsx = await exportResponsePromise;
check('XLSX export writes a workbook', Boolean(exportedXlsx && exportedXlsx.status() === 200), exportedXlsx ? String(exportedXlsx.status()) : 'no response');

const spreadsheetPath = join(home, 'spreadsheet-e2e.xml');
writeFileSync(spreadsheetPath, '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Data"><Table><Row><Cell><Data ss:Type="String">user_id</Data></Cell><Cell><Data ss:Type="String">status</Data></Cell><Cell><Data ss:Type="String">channel</Data></Cell><Cell><Data ss:Type="String">total_cents</Data></Cell><Cell><Data ss:Type="String">created_at</Data></Cell></Row><Row><Cell><Data ss:Type="Number">6</Data></Cell><Cell><Data ss:Type="String">paid</Data></Cell><Cell><Data ss:Type="String">spreadsheet-e2e</Data></Cell><Cell><Data ss:Type="Number">4600</Data></Cell><Cell><Data ss:Type="String">2026-01-05T00:00:00.000Z</Data></Cell></Row></Table></Worksheet></Workbook>');
await page.setInputFiles('[data-testid="data-import-file"]', spreadsheetPath);
await page.waitForSelector('[data-testid="import-confirm"]', { timeout: 5000 });
check('Excel 2003 XML preview maps columns', (await page.locator('.modal').innerText()).includes('spreadsheet-e2e'));
await page.click('[data-testid="import-confirm"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="import-confirm"]'), null, { timeout: 20000 });
await page.waitForTimeout(900);
const spreadsheetResult = await api(`/data?connectionId=${demo.id}&table=orders&limit=5&where=${encodeURIComponent("channel='spreadsheet-e2e'")}`);
check('Excel 2003 XML import inserts a row', spreadsheetResult.status === 200 && spreadsheetResult.body.total >= 1, `total=${spreadsheetResult.body?.total}`);

await page.setInputFiles('[data-testid="data-import-file"]', join(root, 'scripts', 'fixtures', 'legacy-e2e.xls'));
await page.waitForSelector('[data-testid="import-confirm"]', { timeout: 5000 });
check('legacy XLS preview maps columns', (await page.locator('.modal').innerText()).includes('legacy-xls-e2e'));
await page.click('[data-testid="import-confirm"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="import-confirm"]'), null, { timeout: 20000 });
await page.waitForTimeout(900);
const legacyXlsResult = await api(`/data?connectionId=${demo.id}&table=orders&limit=5&where=${encodeURIComponent("channel='legacy-xls-e2e'")}`);
check('legacy XLS import inserts a row', legacyXlsResult.status === 200 && legacyXlsResult.body.total >= 1, `total=${legacyXlsResult.body?.total}`);

await page.selectOption('[data-testid="data-page-size"]', '500');
await page.waitForFunction(() => (document.querySelector('.grid-foot')?.textContent ?? '').includes('1-500'), null, { timeout: 20000 });
await page.evaluate(() => {
  let el = document.querySelector('[data-testid="data-grid"]');
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 10) el.scrollTop = el.scrollHeight;
    el = el.parentElement;
  }
});
await page.waitForSelector('[data-testid="grid-row-499"]', { timeout: 15000 });
check('windowed data grid reaches the last row of a 500-row page', true);
await page.locator('[data-testid="grid-row-499"] td').nth(5).dblclick();
await page.waitForSelector('[data-testid="grid-row-499"] td.editing input', { timeout: 5000 });
await page.locator('[data-testid="grid-row-499"] td.editing input').fill('deep-edit');
await page.keyboard.press('Enter');
await page.waitForTimeout(1000);
const deepEdit = await api(`/data?connectionId=${demo.id}&table=orders&limit=5&where=${encodeURIComponent("channel='deep-edit'")}`);
check('editing a deep row persists after windowed render', deepEdit.status === 200 && deepEdit.body.total >= 1, `total=${deepEdit.body?.total}`);
await page.selectOption('[data-testid="data-page-size"]', '100');
await page.waitForTimeout(600);

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

await page.locator('[title="TABLE orders"]').click({ button: 'right' });
await page.waitForSelector('.context-menu', { timeout: 5000 });
await page.locator('.context-menu').getByText('打印表').click();
await page.waitForSelector('[data-testid="print-frame"]', { timeout: 15000 });
check('table context menu opens print preview', true);
await page.locator('.modal-head .icon-btn').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="print-frame"]'), null, { timeout: 5000 });

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
await page.keyboard.type('SELECT status, COUNT(*) AS n, SUM(total_cents) AS total FROM orders GROUP BY status ORDER BY n DESC;');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('[data-testid="query-result-grid"]', { timeout: 20000 });
const queryRows = await page.locator('[data-testid="query-result-grid"] tbody tr').count();
check('SQL editor runs with Ctrl+Enter', queryRows >= 4, `${queryRows} rows`);
await page.screenshot({ path: join(shots, 'desktop-query.png') });

await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('SELECT * FROM ord');
await page.waitForSelector('.cm-tooltip-autocomplete', { timeout: 8000 });
const completionText = await page.locator('.cm-tooltip-autocomplete').innerText();
check('SQL editor completes table names from the schema', /orders/i.test(completionText), completionText.replace(/\s+/g, ' ').slice(0, 60));
const selectedCompletion = (await page.locator('.cm-tooltip-autocomplete li[aria-selected]').innerText()).trim();
await page.keyboard.press('Tab');
await page.waitForFunction(
  (label) => {
    const text = (document.querySelector('.cm-content')?.textContent ?? '').trim().toUpperCase();
    return text.endsWith(`FROM ${label}`.toUpperCase()) && !document.querySelector('.cm-tooltip-autocomplete');
  },
  selectedCompletion,
  { timeout: 8000 },
);
check('Tab accepts the highlighted completion', true, selectedCompletion);
await page.keyboard.press('Escape');

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
await page.click('[data-testid="chart-extra-total"]');
await page.waitForSelector('[data-testid="chart-series-legend"]', { timeout: 5000 });
const legendItems = await page.locator('[data-testid="chart-series-legend"] span').count();
check('multi-series chart shows both series in the legend', legendItems === 2, `${legendItems} series`);
const multiBars = await page.locator('.query-chart-panel [data-testid="chart-svg"] rect').count();
check('multi-series chart renders grouped bars', multiBars >= queryRows * 2, `${multiBars} bars`);
const barXs = await page.$$eval('.query-chart-panel [data-testid="chart-svg"] rect', (els) => els.slice(0, 2).map((el) => Number(el.getAttribute('x'))));
check('grouped bars put series side by side', barXs.length === 2 && barXs[0] !== barXs[1], barXs.join(','));
await page.click('[data-testid="chart-type-stacked"]');
await page.waitForFunction(() => document.querySelector('.query-chart-panel [data-testid="chart-svg"]')?.getAttribute('data-stacked') === 'true', null, { timeout: 5000 });
const stackedXs = await page.$$eval('.query-chart-panel [data-testid="chart-svg"] rect', (els) => els.slice(0, 2).map((el) => Number(el.getAttribute('x'))));
check('stacked bars share the same column', stackedXs.length === 2 && stackedXs[0] === stackedXs[1], stackedXs.join(','));
await page.click('[data-testid="chart-type-bar"]');
await page.click('[data-testid="chart-dual"]');
await page.waitForFunction(() => document.querySelector('.query-chart-panel [data-testid="chart-svg"]')?.getAttribute('data-dual') === 'true', null, { timeout: 5000 });
check('dual-axis chart draws a right axis', (await page.locator('.query-chart-panel [data-testid="chart-axis-right"]').count()) === 1);
check('dual-axis chart draws the secondary line', (await page.locator('.query-chart-panel [data-testid="chart-dual-line"]').count()) === 1);

// 新增图形：热力 = 度量行 × 分类列；雷达 = 分类轴 + 多度量；散点 = 两个数值列
await page.click('[data-testid="chart-type-heatmap"]');
await page.waitForSelector('.query-chart-panel [data-testid="chart-heatmap-cell"]', { timeout: 5000 });
const heatCells = await page.locator('.query-chart-panel [data-testid="chart-heatmap-cell"]').count();
check('heatmap renders a category × measure matrix', heatCells >= queryRows, `${heatCells} cells`);
// 热力图：格内数值必须和背景亮度反色，否则高亮格会看不见
await page.waitForSelector('.query-chart-panel .heat-cell-value', { timeout: 5000 });
const heatContrast = await page.locator('.query-chart-panel .chart-card').evaluate((card) => {
  const rgb = (value) => (value.match(/\d+/g) ?? []).map(Number);
  const lum = ([r = 0, g = 0, b = 0]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return [...card.querySelectorAll('[data-testid="chart-heatmap-cell"]')]
    .map((rect) => {
      const text = rect.parentElement?.querySelector('.heat-cell-value');
      if (!text) return null;
      const textFill = text.getAttribute('fill') ?? '';
      return { ok: lum(rgb(rect.getAttribute('fill') ?? '')) > 0.45 ? textFill === '#10201c' : textFill === '#f2fbf8', textFill };
    })
    .filter(Boolean);
});
check('heatmap values switch text color by cell brightness', heatContrast.length > 0 && heatContrast.every((item) => item.ok), heatContrast.slice(0, 4).map((item) => item.textFill).join(' '));
await page.click('[data-testid="chart-type-radar"]');
await page.waitForSelector('.query-chart-panel [data-testid="chart-radar-shape"]', { timeout: 5000 });
const radarShapes = await page.locator('.query-chart-panel [data-testid="chart-radar-shape"]').count();
check('radar draws one polygon per measure', radarShapes === 2, `${radarShapes} shapes`);
await page.click('[data-testid="chart-type-scatter"]');
await page.waitForFunction(() => document.querySelector('.query-chart-panel [data-testid="chart-svg"]')?.getAttribute('data-scatter') === 'true', null, { timeout: 5000 });
const scatterPoints = await page.locator('.query-chart-panel [data-testid="chart-scatter"] circle').count();
check('scatter plot auto-picks numeric x/y and draws points', scatterPoints >= 2, `${scatterPoints} points`);
await page.click('[data-testid="chart-type-bar"]');
await page.waitForSelector('.query-chart-panel [data-testid="chart-svg"] rect', { timeout: 5000 });
const chartCsvPromise = page.waitForResponse((res) => res.url().includes('/api/export') && (res.request().postData() ?? '').includes('"format":"csv"'), { timeout: 20000 }).catch(() => null);
await page.click('[data-testid="chart-export-csv"]');
const chartCsvResponse = await chartCsvPromise;
check('query chart exports CSV from the toolbar', Boolean(chartCsvResponse && chartCsvResponse.status() === 200), chartCsvResponse ? String(chartCsvResponse.status()) : 'no response');
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

// 记录一轮里状态条出现过的文案，验证它会随阶段变化
await page.evaluate(() => {
  window.__activityLabels = new Set();
  window.__activityObserver = new MutationObserver(() => {
    const label = document.querySelector('[data-testid="agent-activity"] .activity-label')?.textContent;
    if (label) window.__activityLabels.add(label);
  });
  window.__activityObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
});
await page.fill('[data-testid="agent-input"]', '看看有哪些表');
await page.click('[data-testid="agent-send"]');
await page.waitForSelector('[data-testid="agent-activity"]', { timeout: 10000 });
check('live activity bar appears while the agent works', (await page.locator('[data-testid="agent-activity"] .activity-label').textContent()) !== '');
await page.waitForFunction(() => document.querySelector('.agent-transcript')?.textContent?.includes('张表'), { timeout: 25000 });
await page.waitForFunction(() => !document.querySelector('[data-testid="agent-activity"]'), { timeout: 10000 });
const activityLabels = await page.evaluate(() => {
  window.__activityObserver?.disconnect();
  return [...(window.__activityLabels ?? [])];
});
check('activity label changes as the turn advances', activityLabels.length >= 2, activityLabels.join(' | '));
check('agent inspects schema', (await page.locator('[data-testid="tool-card"]').count()) > 0);
await page.screenshot({ path: join(shots, 'desktop-agent.png') });
await page.fill('[data-testid="agent-input"]', '/chart');
await page.waitForFunction(() => document.querySelector('.popover')?.textContent?.includes('/chart'), null, { timeout: 10000 });
await page.locator('[data-testid="agent-input"]').press('Tab');
check('slash command completes with Tab', (await page.locator('[data-testid="agent-input"]').inputValue()) === '/chart ');
await page.fill('[data-testid="agent-input"]', '');
await page.fill('[data-testid="agent-input"]', '/report 数据概览');
await page.locator('[data-testid="agent-input"]').press('Enter');
await page.waitForFunction(() => document.querySelector('.agent-transcript')?.textContent?.includes('/report 数据概览'), null, { timeout: 10000 });
check('report runs inline without modal', (await page.locator('.modal').count()) === 0);
await page.waitForSelector('.answer-actions', { timeout: 30000 });
const inlineAnswer = await page.locator('.agent-transcript').innerText();
check('answer offers copy and PDF export', inlineAnswer.includes('复制') && inlineAnswer.includes('导出 PDF') && !inlineAnswer.includes('导出 HTML') && !inlineAnswer.includes('导出 Markdown'));
await page.fill('[data-testid="agent-input"]', '/report');
await page.locator('[data-testid="agent-input"]').press('Enter');
await page.waitForTimeout(300);
check('bare /report keeps command token', (await page.locator('[data-testid="agent-input"]').inputValue()) === '/report ');
check('bare /report does not open source form', (await page.locator('.modal').count()) === 0);
await page.fill('[data-testid="agent-input"]', '');

await page.fill('[data-testid="agent-input"]', '/comp');
await page.waitForFunction(() => document.querySelector('.popover')?.textContent?.includes('/compare'), null, { timeout: 10000 });
await page.locator('[data-testid="agent-input"]').press('Tab');
check(
  'command completion inserts a purpose token without a form',
  (await page.locator('[data-testid="agent-input"]').inputValue()) === '/compare ' && (await page.locator('.modal').count()) === 0,
);
await page.fill('[data-testid="agent-input"]', '');

await page.fill('[data-testid="agent-input"]', '/in');
await page.waitForFunction(() => document.querySelector('.popover')?.textContent?.includes('/init'), null, { timeout: 10000 });
check('slash popover offers /init', (await page.locator('.popover').innerText()).includes('/init'));
await page.fill('[data-testid="agent-input"]', '/init');
await page.locator('[data-testid="agent-input"]').press('Enter');
await page.waitForFunction(() => document.querySelector('.agent-transcript')?.textContent?.includes('AI_DB.md 已生成'), null, { timeout: 60000 });
check('/init runs inline without a modal', (await page.locator('.modal').count()) === 0);
const initAnswer = await page.locator('.msg-assistant .content').last().innerText();
const initPath = /([A-Za-z]:\\[^\r\n]+?AI_DB\.md)/.exec(initAnswer)?.[1]?.trim();
check('/init reports the generated AI_DB.md path', Boolean(initPath), initAnswer.split('\n').slice(0, 6).join(' | '));
const initMarkdown = initPath ? await readFile(initPath, 'utf8') : '';
check(
  'AI_DB.md contains the onboarding sections and a complete inventory',
  initMarkdown.includes('## 1. 这个库是干什么的') &&
    initMarkdown.includes('## 3. 核心表手册') &&
    initMarkdown.includes('## 9. 附录：全量表清单') &&
    initMarkdown.includes('<!-- aidb:inventory') &&
    initMarkdown.includes('orders'),
  initPath ? `${initMarkdown.length}B` : 'no file',
);
await page.fill('[data-testid="agent-input"]', '');

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

const settledChart = await page.locator('[data-testid="agent-chart"] [data-testid="chart-svg"], [data-testid="agent-chart"] .pie-row').first().boundingBox();
check('agent chart is a stable 300px tall', Boolean(settledChart) && Math.abs(settledChart.height - 300) <= 1, settledChart ? `${Math.round(settledChart.width)}x${Math.round(settledChart.height)}` : 'no chart');

// 固定高度：面板拖宽、窗口压矮、切换类型都不应改变绘图区高度
const agentSplit = await page.locator('[data-testid="splitter-agent"]').boundingBox();
await page.mouse.move(agentSplit.x + 2, agentSplit.y + 200);
await page.mouse.down();
await page.mouse.move(agentSplit.x - 300, agentSplit.y + 200, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
await page.setViewportSize({ width: 1440, height: 620 });
await page.waitForTimeout(700);
const shortChart = await page.locator('[data-testid="agent-chart"] [data-testid="chart-svg"], [data-testid="agent-chart"] .pie-row').first().boundingBox();
check('agent chart keeps its 300px height in a short transcript', Boolean(shortChart) && Math.abs(shortChart.height - 300) <= 1, shortChart ? `${Math.round(shortChart.width)}x${Math.round(shortChart.height)}` : 'no chart');

// 本轮刚生成的图表在最后；前面的 /report 可能也带图表
const liveChartCard = page.locator('[data-testid="agent-chart"] .chart-card').last();
// AI 图表按数据结构限制可选类型：status 分类 4 类、单度量 => line/stacked/scatter/heatmap 不可用
const unsuitable = [];
for (const type of ['line', 'stacked', 'scatter', 'heatmap']) {
  const button = liveChartCard.locator(`[data-testid="chart-type-${type}"]`);
  unsuitable.push({ type, disabled: await button.isDisabled(), title: await button.getAttribute('title') });
}
check(
  'AI charts disable unsuitable types with a reason',
  unsuitable.every((item) => item.disabled && /：/.test(item.title ?? '')),
  unsuitable.map((item) => `${item.type}:${item.title}`).join(' | '),
);
const chartTypeHeights = [];
for (const type of ['pie', 'radar', 'bar']) {
  await liveChartCard.locator(`[data-testid="chart-type-${type}"]`).click();
  await page.waitForTimeout(120);
  const body = await liveChartCard.locator('[data-testid="chart-svg"], .pie-row').first().boundingBox();
  chartTypeHeights.push({ type, height: body?.height ?? 0 });
}
check(
  'chart height stays 300px for suitable AI chart types',
  chartTypeHeights.every((item) => Math.abs(item.height - 300) <= 1),
  chartTypeHeights.map((item) => `${item.type}:${Math.round(item.height)}`).join(' '),
);

// 花瓣饼图：每瓣有直接指向的标签和引线，百分比合计为 100，hover 立即出精确 tooltip
await liveChartCard.locator('[data-testid="chart-type-pie"]').click();
await page.waitForSelector('[data-testid="chart-rose-petal"]', { timeout: 5000 });
const petalCount = await liveChartCard.locator('[data-testid="chart-rose-petal"]').count();
const roseLabelCount = await liveChartCard.locator('[data-testid="chart-rose-label"]').count();
const roseLeaderCount = await liveChartCard.locator('[data-testid="chart-rose-leader"]').count();
check(
  'rose pie draws petals with direct labels and leaders',
  petalCount > 0 && petalCount <= 8 && roseLabelCount === petalCount && roseLeaderCount === petalCount,
  `${petalCount} petals · ${roseLabelCount} labels · ${roseLeaderCount} leaders`,
);
const petalTips = await liveChartCard.locator('[data-testid="chart-rose-petal"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-tip') ?? ''));
const petalPercent = petalTips.reduce((sum, tip) => {
  const value = /（([\d.]+)%）/.exec(tip)?.[1];
  return sum + (value ? Number(value) : tip.includes('（<0.1%）') ? 0.05 : 0);
}, 0);
check('rose pie percentages add up to 100', petalTips.length > 0 && Math.abs(petalPercent - 100) <= 0.8, `${petalPercent.toFixed(1)}%`);
await liveChartCard.locator('[data-testid="chart-rose-petal"]').first().hover();
await page.waitForSelector('[data-testid="chart-hover-tip"]', { timeout: 5000 });
const roseTip = (await page.locator('[data-testid="chart-hover-tip"]').textContent()) ?? '';
check('rose petal hover shows an immediate tooltip', /%/.test(roseTip) && /\d/.test(roseTip), roseTip.replace(/\s+/g, ' ').slice(0, 60));

await liveChartCard.locator('[data-testid="chart-type-bar"]').click();
await page.waitForTimeout(200);
await liveChartCard.locator('[data-testid="chart-svg"] rect[data-tip]').first().hover();
await page.waitForSelector('[data-testid="chart-hover-tip"]', { timeout: 5000 });
const barTip = (await page.locator('[data-testid="chart-hover-tip"]').textContent()) ?? '';
check('bar hover shows exact values', /\d/.test(barTip), barTip.replace(/\s+/g, ' ').slice(0, 60));

// 手动上滑后停止跟随，回到底部按钮可以跳回最新输出
await page.locator('.agent-transcript').evaluate((el) => { el.scrollTop = 0; });
await page.waitForTimeout(250);
check('scrolling up reveals the jump-to-bottom button', await page.locator('[data-testid="agent-scroll-bottom"]').isVisible());
await page.locator('[data-testid="agent-scroll-bottom"]').click();
await page.waitForTimeout(700);
const bottomGap = await page.locator('.agent-transcript').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
check('jump button returns to the latest output', bottomGap <= 4, `${Math.round(bottomGap)}px from bottom`);
await page.setViewportSize({ width: 1440, height: 900 });
await page.locator('[data-testid="splitter-agent"]').dblclick();
await page.waitForTimeout(600);
await page.screenshot({ path: join(shots, 'desktop-chart.png') });

// ---------------- P3 图表三 tab / 工具条 / PNG ----------------
// 锚点用 chart-tabs 而不是 chart-card：切到「明细」时图表卡会卸载，用它定位会瞬间失效
const chartToolCard = page.locator('[data-testid="agent-chart"]').last();
check('chart result offers 图表/明细/SQL tabs', (await chartToolCard.locator('[data-testid="chart-tabs"] button').count()) === 3, await chartToolCard.locator('[data-testid="chart-tabs"] button').allTextContents().then((t) => t.join('|')).catch(() => ''));
await chartToolCard.locator('[data-testid="chart-tab-rows"]').click();
check('明细 tab exposes the rows the tool already returned', (await chartToolCard.locator('.tool-table tbody tr').count()) > 0, `${await chartToolCard.locator('.tool-table tbody tr').count()} rows`);
await chartToolCard.locator('[data-testid="chart-tab-sql"]').click();
check('SQL tab shows the chart SQL', /select/i.test((await chartToolCard.locator('.sql-block').first().textContent()) ?? ''));
await chartToolCard.locator('[data-testid="chart-tab-chart"]').click();
check('switching back restores the chart', (await chartToolCard.locator('[data-testid="chart-svg"]').count()) === 1);
const chartCard = chartToolCard.locator('[data-testid="chart-card"]');
check('chart toolbar is shared into the agent card', (await chartCard.locator('[data-testid="chart-toolbar"]').count()) === 1);
await chartCard.locator('[data-testid="chart-type-pie"]').click();
check('chart type switches without a round trip', /PIE/.test((await chartCard.locator('.chart-kind').textContent()) ?? ''));
await chartCard.locator('[data-testid="chart-type-bar"]').click();
const pngDownload = page.waitForEvent('download', { timeout: 15000 });
await chartCard.locator('[data-testid="chart-export-png"]').click();
const pngPath = await (await pngDownload).path();
const pngHead = (await readFile(pngPath)).subarray(0, 4);
check('chart PNG export produces a real PNG', pngHead[0] === 0x89 && pngHead[1] === 0x50 && pngHead[2] === 0x4e && pngHead[3] === 0x47, `${pngHead.toString('hex')} ${(await statSync(pngPath)).size}B`);

// ---------------- P4 执行过程内直接看结果数据 ----------------
// 前面的 /chart 与 /report 走的是 render_chart / 命令工具，不产生 run_sql 卡；
// 这里先跑一条明确的 SELECT，保证执行过程里有 SQL 工具卡和真实结果行可展开。
await page.fill('[data-testid="agent-input"]', 'SELECT * FROM orders LIMIT 5');
await page.click('[data-testid="agent-send"]');
await page.waitForFunction(
  () => [...document.querySelectorAll('[data-testid="tool-card"]')].some((el) => el.textContent?.includes('run_sql')),
  null,
  { timeout: 30000 },
);
await page.waitForFunction(() => !document.querySelector('[data-testid="agent-activity"]'), null, { timeout: 10000 });
check('重复的执行详情入口已移除', (await page.locator('[data-testid="exec-toggle"]').count()) === 0);
await page.locator('[data-testid="execution-section"]').evaluateAll((els) => els.forEach((el) => el.setAttribute('open', '')));
const sqlToolCards = page.locator('[data-testid="tool-card"]').filter({ hasText: 'run_sql' });
check('执行过程提供 run_sql 工具卡', (await sqlToolCards.count()) > 0, `${await sqlToolCards.count()} cards`);
let resultRows = 0;
for (let index = 0; index < Math.min(await sqlToolCards.count(), 5); index++) {
  const card = sqlToolCards.nth(index);
  if ((await card.locator('.tool-body').count()) === 0) await card.locator('.tool-head').click();
  resultRows = Math.max(resultRows, await card.locator('.tool-table tbody tr').count());
}
check('展开工具卡能看到真实结果行', resultRows > 0, `${resultRows} rows`);

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
// 空会话建议可能因动画/重渲染而短暂不稳定，直接在 DOM 上触发点击，随后等待输入框同步。
await suggestChips.first().evaluate((el) => el.click());
await page.waitForFunction(() => (document.querySelector('[data-testid="agent-input"]')?.value ?? '').length > 4, null, { timeout: 5000 });
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

// ---------------- 仪表板：每库一块板的活查询卡片 ----------------
const dashList = async () => (await api(`/dashboards/cards?connectionId=${demo.id}`)).body?.cards ?? [];
for (const card of await dashList()) await api(`/dashboards/cards/${card.id}`, { method: 'DELETE' });
const rejectedCard = await api('/dashboards/cards', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, title: '危险卡片', sql: 'DELETE FROM orders' }) });
check('dashboard rejects non-read-only card', rejectedCard.status === 400 && JSON.stringify(rejectedCard.body).includes('DASHBOARD_NOT_READ_ONLY'), `${rejectedCard.status}`);
const multiCard = await api('/dashboards/cards', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, title: '多语句', sql: 'SELECT 1; SELECT 2' }) });
check('dashboard rejects multi-statement card', multiCard.status === 400, `${multiCard.status}`);
const madeCard = await api('/dashboards/cards', {
  method: 'POST',
  body: JSON.stringify({
    connectionId: demo.id,
    title: '月度订单',
    sql: "SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS orders, SUM(total_cents) AS amount FROM orders GROUP BY month ORDER BY month",
    chartType: 'line',
    timeColumn: 'month',
  }),
});
check('dashboard card created', madeCard.status === 200 && Boolean(madeCard.body?.card?.id), `${madeCard.status}`);

await page.locator('.tree-node', { hasText: 'Demo' }).first().click().catch(() => undefined);
await page.waitForTimeout(400);
await page.click('[data-testid="open-dashboard"]');
await page.waitForSelector('[data-testid="tab-dashboard"]', { timeout: 10000 });
await page.waitForSelector('[data-testid="dashboard-card"]', { timeout: 20000 });
await page.waitForSelector('[data-testid="dashboard-card"] [data-testid="chart-svg"]', { timeout: 20000 });
const dashCharts = await page.locator('[data-testid="dashboard-card"] [data-testid="chart-svg"]').count();
check('dashboard renders charts from live SQL', dashCharts >= 1, `${dashCharts} charts`);
const dashBox = await page.locator('[data-testid="dashboard-card"] [data-testid="chart-svg"]').first().boundingBox();
check('dashboard chart respects the 300px cap', Boolean(dashBox) && dashBox.height > 80 && dashBox.height <= 302, `${Math.round(dashBox?.height ?? 0)}px`);
const dashSeries = await page.locator('[data-testid="dashboard-card"] [data-testid="chart-series-legend"] span').count();
check('multi-measure card draws every numeric column', dashSeries >= 2, `${dashSeries} series`);
check('mismatched measures get a right axis instead of a flat line', (await page.locator('[data-testid="dashboard-card"] [data-testid="chart-axis-right"]').count()) === 1);

// 新建卡片：一句需求 → AI/离线口径生成 SQL → 试跑预览 → 保存为固定卡
await page.click('[data-testid="dashboard-add"]');
await page.fill('[data-testid="dashboard-card-prompt"]', '按状态统计订单');
await page.click('[data-testid="dashboard-card-compose"]');
await page
  .waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="dashboard-card-compose"]');
      return Boolean(button) && !/生成中/.test(button.textContent ?? '');
    },
    null,
    { timeout: 30000 },
  )
  .catch(() => undefined);
const composedSql = await page.locator('[data-testid="dashboard-card-sql"]').inputValue();
const composedPreview = await page.locator('[data-testid="dashboard-card-preview"]').count();
check('composer turns a sentence into SQL and previews it', composedSql.length > 20 && composedPreview === 1, `${composedSql.slice(0, 50)} preview=${composedPreview}`);
const beforeComposeSave = (await dashList()).length;
await page.click('[data-testid="dashboard-card-save"]');
await page
  .waitForFunction((count) => document.querySelectorAll('[data-testid="dashboard-card"]').length === count + 1, beforeComposeSave, { timeout: 20000 })
  .catch(() => undefined);
const composedCard = (await dashList()).find((card) => card.source === 'ai');
check('AI-composed card saves its column hints', Boolean(composedCard?.x && composedCard?.y), JSON.stringify(composedCard ?? {}).slice(0, 140));
if (composedCard) await api(`/dashboards/cards/${composedCard.id}`, { method: 'DELETE' });

const rangeCount = await page.locator('[data-testid="dashboard-range"]').count();
check('board time range appears once a card declares a time column', rangeCount === 1, `${rangeCount}`);
if (rangeCount) {
  await page.selectOption('[data-testid="dashboard-range"]', '7d');
  await page.waitForTimeout(1500);
  check('range switch keeps the board alive', (await page.locator('[data-testid="dashboard-card"]').count()) >= 1);
  await page.selectOption('[data-testid="dashboard-range"]', 'all');
  await page.waitForTimeout(800);
}
await page.click('[data-testid="dashboard-generate"]');
await page
  .waitForFunction(() => document.querySelectorAll('[data-testid="dashboard-card"][data-pinned="0"]').length > 0, null, { timeout: 150000 })
  .catch(() => undefined);
const draftNodes = await page.locator('[data-testid="dashboard-card"][data-pinned="0"]').count();
const pinnedNodes = await page.locator('[data-testid="dashboard-card"][data-pinned="1"]').count();
check('AI drafts generated without a curated brief', draftNodes >= 1, `${draftNodes} drafts`);
check('pinned cards survive generation', pinnedNodes >= 1, `${pinnedNodes} pinned`);
const draftCharts = await page.locator('[data-testid="dashboard-card"][data-pinned="0"] [data-testid="chart-svg"]').count();
check('every draft card passed its trial run before entering the board', draftCharts === draftNodes, `${draftCharts}/${draftNodes}`);
const boardTotal = await dashList();
check('board stays within the 12-card limit', boardTotal.length <= 12, `${boardTotal.length} cards`);
await page.click('[data-testid="dashboard-discard"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="dashboard-card"][data-pinned="0"]').length === 0, null, { timeout: 20000 });
check('discard clears drafts and keeps pinned cards', (await page.locator('[data-testid="dashboard-card"]').count()) === pinnedNodes);
const scheduleOn = await api('/dashboards/schedule', { method: 'PUT', body: JSON.stringify({ connectionId: demo.id, intervalSeconds: 300 }) });
check('scheduled refresh stores an interval with a 60s floor', scheduleOn.status === 200 && scheduleOn.body?.schedule?.intervalSeconds === 300, JSON.stringify(scheduleOn.body?.schedule ?? {}).slice(0, 120));
const scheduleList = await api(`/dashboards/cards?connectionId=${demo.id}`);
check('board still lists cards while a schedule is active', scheduleList.status === 200, `${(scheduleList.body?.cards ?? []).length} cards`);
await api('/dashboards/schedule', { method: 'PUT', body: JSON.stringify({ connectionId: demo.id, intervalSeconds: 0 }) });
const scheduleOff = await api('/dashboards/schedule?connectionId=' + demo.id);
check('scheduled refresh can be turned off again', scheduleOff.body?.schedule === null, JSON.stringify(scheduleOff.body));
const reportOut = await api('/dashboards/report', { method: 'POST', body: JSON.stringify({ connectionId: demo.id }) });
const reportId = reportOut.body?.artifact?.id;
check('board exports a report artifact', reportOut.status === 200 && Boolean(reportId), `${reportOut.status} ${JSON.stringify(reportOut.body ?? {}).slice(0, 90)}`);
if (reportId) {
  const deck = await api(`/artifacts/${reportId}/export?format=pptx`);
  check('report artifact renders a real PPTX deck', deck.status === 200 && (deck.body?.bytes ?? 0) > 1000, `${deck.status} ${deck.body?.bytes ?? 0} bytes`);
}
await page.screenshot({ path: join(shots, 'desktop-dashboard.png') }).catch(() => undefined);

// ---------------- Mobile (Expo web build) ----------------
const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mobile = await mobileContext.newPage();
{
  const rawShot = mobile.screenshot.bind(mobile);
  mobile.screenshot = async (options) => {
    try { return await rawShot(options); } catch (err) { console.log(`WARN screenshot ${options?.path ?? ''}: ${err.message}`); return Buffer.alloc(0); }
  };
}
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
await mobile.getByTestId('m-commands').click();
await mobile.getByTestId('m-command-report').click();
check('mobile command picker inserts a purpose token', (await mobile.getByTestId('m-chat-input').inputValue()) === '/report ');
check('mobile command picker does not open a form', (await mobile.getByPlaceholder('例如：本周订单与履约情况').count()) === 0);
await mobile.screenshot({ path: join(shots, 'mobile-command-report.png') });
await mobile.getByTestId('m-chat-input').fill('');

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

    // 深链会先打开数据页，欢迎页不再存在；两种情况都从工具栏新建查询
    if (await window.locator('[data-testid="welcome-new-query"]').count()) {
      await window.click('[data-testid="welcome-new-query"]');
    } else {
      await window.click('.tab-add');
    }
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

// 解压 PDF 内容流，检查是否真的画出了彩色：Chrome 打印默认丢背景色，饼图会整块变白，
// 只有字节头正确并不算过。scn 表示 conic-gradient 被输出为 pattern，rg 是普通填充色。
function pdfColorEvidence(bytes) {
  const raw = bytes.toString('latin1');
  const streams = [];
  let index = 0;
  while ((index = raw.indexOf('stream', index)) >= 0) {
    let start = index + 'stream'.length;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    index = end + 'endstream'.length;
    try {
      streams.push(zlib.inflateSync(bytes.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1'));
    } catch {
      /* 非 Flate 流，跳过 */
    }
  }
  const content = streams.join('\n');
  const fills = [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  return {
    chromatic: fills.some((rgb) => Math.max(...rgb) - Math.min(...rgb) > 0.05),
    gradient: /\b(?:scn|SCN)\b/.test(content),
  };
}

// 回答导出 PDF 走主进程 printToPDF + 原生另存为，渲染进程侧没有 download 事件可取证。
// 这里把 showSaveDialog 钉到临时路径，再从窗口里真实调用一次 preload API。
async function electronPdfExport(app, window) {
  const saveTo = join(tmpdir(), `aidb-e2e-electron-${Date.now()}.pdf`);
  try {
    await app.evaluate(({ dialog }, target) => {
      global.__pdfDialog = null;
      const original = dialog.showSaveDialog.bind(dialog);
      global.__pdfRestore = () => { dialog.showSaveDialog = original; };
      dialog.showSaveDialog = async (_win, maybeOptions) => {
        const options = maybeOptions ?? _win;
        global.__pdfDialog = { filters: options?.filters ?? null, defaultPath: options?.defaultPath ?? '' };
        return { canceled: false, filePath: target };
      };
    }, saveTo);
    const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><style>
      html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      body{font-family:"Segoe UI",sans-serif;padding:28px;color:#0f172a}
      h1{font-size:22px;margin:0 0 8px}
      .chart{border:1px solid #cbd5e1;border-radius:8px;padding:12px;margin-top:14px}
      .pie{width:120px;height:120px;border-radius:50%;background:conic-gradient(#0891b2 0deg 180deg,#e0af63 180deg 360deg)}
      .swatch{display:inline-block;width:16px;height:16px;background:#22c55e}
    </style></head><body>
      <h1>AiDB 回答导出 PDF 验证</h1>
      <p>桌面端 printToPDF 渲染中文、SVG 与饼图的 conic-gradient。</p>
      <div class="chart"><svg width="480" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect x="30" y="60" width="80" height="120" fill="#0891b2"/>
        <rect x="160" y="100" width="80" height="80" fill="#22c55e"/>
        <rect x="290" y="30" width="80" height="150" fill="#f59e0b"/>
      </svg></div>
      <div class="pie"></div><span class="swatch"></span>
    </body></html>`;
    const result = await window.evaluate((payload) => window.aidbDesktop.exportPdf(payload), { html, name: 'aidb-e2e-answer.pdf' });
    if (!result?.ok) return `FAIL exportPdf result ${JSON.stringify(result).slice(0, 160)}`;
    const bytes = await readFile(saveTo);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return `FAIL not a PDF (${bytes.subarray(0, 8).toString('hex')})`;
    if (bytes.length < 2000) return `FAIL PDF suspiciously small (${bytes.length}B)`;
    const color = pdfColorEvidence(bytes);
    if (!color.chromatic) return 'FAIL PDF lost CSS background colors (no chromatic fill)';
    if (!color.gradient) return 'FAIL pie conic-gradient pattern missing from PDF';
    const dialogInfo = await app.evaluate(() => global.__pdfDialog);
    const filtered = Array.isArray(dialogInfo?.filters) && dialogInfo.filters.some((f) => f.extensions?.includes('pdf'));
    if (!filtered) return `FAIL save dialog without a PDF filter (${JSON.stringify(dialogInfo?.filters)})`;
    if (!dialogInfo.defaultPath.toLowerCase().endsWith('.pdf')) return `FAIL default name is not .pdf (${dialogInfo.defaultPath})`;
    return `OK ${bytes.length}B ${dialogInfo.defaultPath.split(/[\\/]/).pop()}`;
  } catch (err) {
    return `FAIL ${String(err).split('\n')[0].slice(0, 180)}`;
  } finally {
    await app.evaluate(() => global.__pdfRestore?.()).catch(() => undefined);
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
  let pdfDetail = 'not attempted';
  let lastError = '';
  for (let attempt = 1; attempt <= 2 && !electronOk; attempt++) {
    let app;
    try {
      const openPayload = Buffer.from(JSON.stringify({ table: 'orders' })).toString('base64');
      app = await electron.launch({ executablePath: electronBinary, args: [join(root, 'apps/desktop'), '--no-sandbox', `--open-table=${openPayload}`], env, timeout: 90000 });
      const window = await app.firstWindow();
      await window.waitForSelector('[data-testid="app-root"]', { timeout: 45000 });
      await window.waitForTimeout(1500);
      electronOk = (await window.locator('.conn-row').count()) >= 1;
      if (electronOk) {
        const openedTable = await window
          .waitForFunction(() => (document.querySelector('.tab.active')?.textContent ?? '').toLowerCase().includes('orders'), null, { timeout: 25000 })
          .then(() => true)
          .catch(() => false);
        check('electron deep link opens the table', openedTable);
        const shortcut = await window.evaluate((id) => window.aidbDesktop?.createTableShortcut({ connectionId: id, table: 'orders', name: 'AIDB-E2E-Shortcut' }), demo.id);
        let shortcutArgs = '';
        if (shortcut?.ok && shortcut.path) {
          shortcutArgs = await app.evaluate(({ shell }, file) => {
            try { return shell.readShortcutLink(file).args ?? ''; } catch { return ''; }
          }, shortcut.path);
          try { unlinkSync(shortcut.path); } catch { /* ignore */ }
        }
        check('electron can create a table shortcut', Boolean(shortcut?.ok && /--open-table=/.test(shortcutArgs)), `${shortcut?.ok} ${shortcutArgs.slice(0, 60)}`);
        const secondPayload = Buffer.from(JSON.stringify({ table: 'users' })).toString('base64');
        const second = spawn(electronBinary, [join(root, 'apps/desktop'), '--no-sandbox', `--open-table=${secondPayload}`], { env, stdio: 'ignore' });
        const secondExit = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 20000);
          second.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code ?? -1);
          });
        });
        const forwarded = await window
          .waitForFunction(() => (document.querySelector('.tab.active')?.textContent ?? '').toLowerCase().includes('users'), null, { timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        check('second launch reuses the window and forwards the deep link', secondExit === 0 && forwarded, `exit=${secondExit} forwarded=${forwarded}`);
        await window.screenshot({ path: join(shots, 'electron-desktop.png') });
        exportDetail = await electronPngExport(app, window);
        pdfDetail = await electronPdfExport(app, window);
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
  check('electron 回答导出真 PDF（含图表 HTML）', electronOk && pdfDetail.startsWith('OK'), pdfDetail);
} else {
  console.log('SKIP  electron shell — no Electron binary installed');
}

// ---------------- 连接分组折叠 ----------------
const demoGroup = page.locator('[data-testid="group-toggle-示例"]');
check('connection groups render a collapse toggle', (await demoGroup.count()) === 1);
await demoGroup.click();
await page.waitForFunction(() => ![...document.querySelectorAll('.conn-row')].some((el) => (el.textContent ?? '').includes('Demo · Shop DB')), null, { timeout: 5000 });
check('collapsed group hides its connections', true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForSelector('[data-testid="group-toggle-示例"]', { timeout: 20000 });
const stillCollapsed = await page.evaluate(() => ![...document.querySelectorAll('.conn-row')].some((el) => (el.textContent ?? '').includes('Demo · Shop DB')));
check('collapsed group stays collapsed after reload', stillCollapsed);
await page.locator('[data-testid="group-toggle-示例"]').click();
await page.waitForFunction(() => [...document.querySelectorAll('.conn-row')].some((el) => (el.textContent ?? '').includes('Demo · Shop DB')), null, { timeout: 5000 });

const orderPeer = await api('/connections', {
  method: 'POST',
  body: JSON.stringify({ name: 'E2E 排序同组', engine: 'sqlite', database: demo.database, groupName: '示例' }),
});
const orderGroup = await api('/connections', {
  method: 'POST',
  body: JSON.stringify({ name: 'E2E 排序分组', engine: 'sqlite', database: demo.database, groupName: '组E2E' }),
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForFunction(
  () => document.querySelectorAll('.group-label').length >= 2 && document.querySelectorAll('.conn-row').length >= 2,
  null,
  { timeout: 15000 },
);
const listGroups = () => page.$$eval('.group-label', (els) => els.map((el) => {
  const clone = el.cloneNode(true);
  clone.querySelector('.group-count')?.remove();
  return (clone.textContent ?? '').trim();
}));
const groupsBefore = await listGroups();
check('groups render in the saved order', groupsBefore.length >= 2, groupsBefore.join('|'));
await page.locator('.group-label').first().dragTo(page.locator('.group-label').nth(1));
await page.waitForTimeout(500);
const groupsAfter = await listGroups();
check('dragging a group header reorders groups', groupsAfter[0] === groupsBefore[1] && groupsAfter[1] === groupsBefore[0], `${groupsBefore.join('|')} -> ${groupsAfter.join('|')}`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForSelector('.group-label', { timeout: 15000 });
const groupsReloaded = await listGroups();
check('group order persists across reload', groupsReloaded[0] === groupsAfter[0] && groupsReloaded[1] === groupsAfter[1], groupsReloaded.join('|'));

const firstConnIds = () => page.$$eval('.conn-row', (els) => els.slice(0, 2).map((el) => el.getAttribute('data-testid')));
const connsBefore = await firstConnIds();
check('connections render in a stable order', connsBefore.length === 2, connsBefore.join('|'));
await page.locator('.conn-row').first().dragTo(page.locator('.conn-row').nth(1));
await page.waitForTimeout(500);
const connsAfter = await firstConnIds();
check('dragging a connection reorders it within the group', connsAfter[0] === connsBefore[1] && connsAfter[1] === connsBefore[0], `${connsBefore.join('|')} -> ${connsAfter.join('|')}`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForSelector('.conn-row', { timeout: 15000 });
const connsReloaded = await firstConnIds();
check('connection order persists across reload', connsReloaded[0] === connsAfter[0], connsReloaded.join('|'));
await api(`/connections/${orderPeer.body.connection.id}`, { method: 'DELETE' });
await api(`/connections/${orderGroup.body.connection.id}`, { method: 'DELETE' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });

// ---------------- 分组重命名与删除 ----------------
const groupConn = await api('/connections', { method: 'POST', body: JSON.stringify({ name: 'Group E2E', engine: 'sqlite', database: demo.database, groupName: '组A' }) });
check('group test connection created', groupConn.status === 201, String(groupConn.status));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForSelector('[data-testid="group-toggle-组A"]', { timeout: 20000 });
await page.locator('[data-testid="group-toggle-组A"]').click({ button: 'right' });
await page.waitForSelector('.context-menu', { timeout: 5000 });
page.once('dialog', (dialog) => dialog.accept('组B'));
await page.locator('.context-menu').getByText('重命名分组').click();
await page.waitForSelector('[data-testid="group-toggle-组B"]', { timeout: 15000 });
check('group rename from the sidebar persists', true);
await page.locator('[data-testid="group-toggle-组B"]').click({ button: 'right' });
await page.waitForSelector('.context-menu', { timeout: 5000 });
page.once('dialog', (dialog) => dialog.accept());
await page.locator('.context-menu').getByText('删除分组').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="group-toggle-组B"]'), null, { timeout: 15000 });
const movedConn = (await api('/connections')).body.connections.find((item) => item.name === 'Group E2E');
check('group delete moves connections to 默认', movedConn?.groupName === '默认', movedConn?.groupName ?? 'missing');
await page.locator(`[data-testid="connection-${groupConn.body.connection.id}"]`).dragTo(page.locator('[data-testid="group-toggle-示例"]'));
await page.waitForTimeout(900);
const draggedConn = (await api('/connections')).body.connections.find((item) => item.id === groupConn.body.connection.id);
check('dragging a connection onto a group moves it', draggedConn?.groupName === '示例', draggedConn?.groupName ?? 'missing');
await api(`/connections/${groupConn.body.connection.id}`, { method: 'DELETE' });

// ---------------- 只读连接：UI 收口写入入口 ----------------
await api(`/connections/${demo.id}`, { method: 'PUT', body: JSON.stringify({ readonly: true }) });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
await page.waitForTimeout(700);
await page.click('[data-testid="welcome-open-demo"]');
await page.waitForSelector('[data-testid="data-grid"] tbody tr', { timeout: 20000 });
const readonlyWriteEntry = (await page.locator('[data-testid="data-add-row"]').isDisabled())
  && (await page.locator('[data-testid="data-paste-rows"]').isDisabled())
  && (await page.locator('[data-testid="data-find-replace"]').isDisabled())
  && (await page.locator('[data-testid="data-duplicate-rows"]').isDisabled());
check('readonly connection disables write entry points', readonlyWriteEntry);
await page.locator('[data-testid="grid-row-0"] td').nth(2).dblclick();
await page.waitForTimeout(300);
check('readonly connection keeps cells non-editable', (await page.locator('[data-testid="grid-row-0"] td.editing').count()) === 0);

// ---------------- Cleanup & report ----------------
await api(`/connections/${demo.id}`, { method: 'PUT', body: JSON.stringify({ readonly: false }) });
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
