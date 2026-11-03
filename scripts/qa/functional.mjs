import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { api, check, checkEqual, expectError, expectOk, fail, pass, record, saveReport, section, sse, truncate } from './lib.mjs';

const HOME = process.env.AIDB_HOME ?? join(homedir(), '.aidb');
const DEMO_FILE = join(HOME, 'demo', 'demo-retail.sqlite');
const MIRROR_FILE = join(HOME, 'demo', 'demo-retail-mirror.sqlite');
const SANDBOX_FILE = join(HOME, 'demo', 'qa-sandbox.sqlite');
const TARGET_FILE = join(HOME, 'demo', 'qa-target.sqlite');
const REPORT = join(process.cwd(), 'docs', 'test-artifacts', 'functional.json');
const SCRATCH = 'qa_widgets';

function snapshot(source, target) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(target + suffix, { force: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

async function ensureConnection(name, file, extra = {}) {
  const list = await api('GET', '/connections');
  const existing = list.json.connections.find((c) => c.database === file && c.name === name);
  if (existing) return existing;
  const res = await api('POST', '/connections', { name, engine: 'sqlite', color: 'purple', environment: 'dev', groupName: 'QA 临时', database: file, readonly: false, note: 'QA 自动化测试临时连接，测试结束后自动删除。', ...extra });
  if (res.status !== 201) throw new Error(`创建连接失败 ${res.status}: ${res.text.slice(0, 200)}`);
  return res.json.connection;
}

async function dropConnection(id) {
  if (id) await api('DELETE', `/connections/${id}`);
}

async function query(connectionId, sql, opts = {}) {
  const res = await api('POST', '/query', { connectionId, sql, ...opts });
  return res;
}

async function tool(name, args, connectionId, database) {
  return api('POST', `/agent/tools/${name}`, { args, connectionId, database });
}

async function main() {
  const startedAt = Date.now();
  const health = await api('GET', '/health');
  if (health.status !== 200) throw new Error('gateway not reachable');

  const connections = (await api('GET', '/connections')).json.connections;
  const demo = connections.find((c) => c.name === 'Demo · 零售业务库');
  const mirror = connections.find((c) => c.name === 'Demo2 · 零售镜像库');
  if (!demo || !mirror) throw new Error('demo/demo2 connections missing');

  snapshot(DEMO_FILE, SANDBOX_FILE);
  for (const suffix of ['', '-wal', '-shm']) rmSync(TARGET_FILE + suffix, { force: true });
  const empty = new DatabaseSync(TARGET_FILE);
  empty.close();

  let sandbox;
  let readonly;
  let target;
  const createdMemories = [];
  let snippetId;
  let jobId;
  let channelId;
  let mcpId;
  let originalSettings;

  try {
    sandbox = await ensureConnection('QA · 沙箱库', SANDBOX_FILE);
    readonly = await ensureConnection('QA · 只读沙箱', SANDBOX_FILE, { readonly: true, name: 'QA · 只读沙箱' });
    // ensureConnection matches by name+file above; readonly connection has a different name
    target = await ensureConnection('QA · 迁移目标', TARGET_FILE);

    const schemaRes = await api('GET', `/connections/${demo.id}/schema?refresh=1`);
    const demoDatabase = schemaRes.json.schemas[0]?.name ?? 'main';
    const schemaTables = schemaRes.json.schemas[0]?.tables ?? [];

    // ------------------------------------------------------------------ meta
    section('meta');
    await expectOk('health ok', 'GET', '/health', undefined, (j) => j.ok === true && j.demoReady === true);
    await expectOk('bootstrap exposes 52 tools', 'GET', '/bootstrap', undefined, (j) => (Array.isArray(j.tools) ? j.tools.length : 0) === 52);
    await expectOk('bootstrap has sessions/settings', 'GET', '/bootstrap', undefined, (j) => j.settings && Array.isArray(j.sessions));
    await expectOk('settings readable', 'GET', '/settings', undefined, (j) => typeof j.settings?.defaultLimit === 'number');
    originalSettings = (await api('GET', '/settings')).json.settings;
    await expectOk('settings update', 'PUT', '/settings', { defaultLimit: 150 }, (j) => j.settings.defaultLimit === 150);
    await expectOk('settings persisted', 'GET', '/settings', undefined, (j) => j.settings.defaultLimit === 150);
    await expectOk('settings restore', 'PUT', '/settings', { defaultLimit: originalSettings.defaultLimit }, (j) => j.settings.defaultLimit === originalSettings.defaultLimit);

    // ----------------------------------------------------------- connections
    section('connections');
    await expectOk('connections list', 'GET', '/connections', undefined, (j) => j.connections.length >= 6);
    await expectOk('connection test', 'POST', `/connections/${demo.id}/test`, undefined, (j) => j.ok === true || j.result?.ok === true);
    await expectOk('draft connection test', 'POST', '/connections/test', { engine: 'sqlite', database: DEMO_FILE }, (j) => j.ok === true || j.result?.ok === true);
    await expectOk('connection update note', 'PUT', `/connections/${sandbox.id}`, { note: 'QA 沙箱（自动化）' }, (j) => j.connection.note.includes('QA'));
    const before = Date.now();
    const schemaTiming = await api('GET', `/connections/${demo.id}/schema?refresh=1`);
    record('schema refresh speed < 3s', schemaTiming.ms < 3000, { ms: schemaTiming.ms }, 'connections');

    // ---------------------------------------------------------------- schema
    section('schema');
    await expectOk('schema lists 40 objects', 'GET', `/connections/${demo.id}/schema`, undefined, (j) => (j.schemas[0]?.tables?.length ?? 0) === 40);
    const ordersTable = schemaTables.find((t) => t.name === 'orders');
    check('orders columns parsed', ordersTable?.columns?.length >= 18, { columns: ordersTable?.columns?.length });
    check('orders pk detected', ordersTable?.columns?.some((c) => c.name === 'id' && c.primaryKey), ordersTable?.columns?.slice(0, 3));
    check('orders FK detected', (ordersTable?.foreignKeys?.length ?? 0) >= 1, ordersTable?.foreignKeys);
    check('orders index detected', (ordersTable?.indexes?.length ?? 0) >= 2, ordersTable?.indexes);
    check('view present', schemaTables.some((t) => t.name === 'v_order_summary' && t.type === 'view'), schemaTables.filter((t) => t.type === 'view').map((t) => t.name));
    check('composite pk table present', schemaTables.some((t) => t.name === 'inventory'), undefined);
    await expectOk('tables endpoint', 'GET', `/connections/${demo.id}/tables`, undefined, (j) => Array.isArray(j.tables) && j.tables.length === 40);
    await expectOk('databases endpoint', 'GET', `/connections/${demo.id}/databases`, undefined, (j) => Array.isArray(j.databases) && j.databases.length >= 1);
    await expectOk('schema refresh', 'GET', `/connections/${demo.id}/schema?refresh=1`, undefined, (j) => j.schemas.length >= 1);

    // ----------------------------------------------------------------- query
    section('query');
    await expectOk('select count orders', 'POST', '/query', { connectionId: demo.id, sql: 'SELECT COUNT(*) AS n FROM orders' }, (j) => {
      const value = j.batch.sets[0].rows[0][0];
      return Number(value) === 25000;
    });
    await expectOk('select joins business question', 'POST', '/query', { connectionId: demo.id, sql: "SELECT c.name AS category, ROUND(SUM(oi.qty*oi.unit_price_cents)/100.0,2) AS sales FROM order_items oi JOIN products p ON p.id=oi.product_id JOIN categories c ON c.id=p.category_id GROUP BY c.name ORDER BY sales DESC LIMIT 5" }, (j) => j.batch.sets[0].rows.length === 5);
    await expectOk('auto limit caps big table rows', 'POST', '/query', { connectionId: demo.id, sql: 'SELECT * FROM web_events' }, (j) => j.batch.sets[0].rows.length === originalSettings.defaultLimit);
    const autoLimited = await api('POST', '/query', { connectionId: demo.id, sql: 'SELECT * FROM web_events' });
    record('auto-limit result flagged truncated', autoLimited.json?.batch?.sets?.[0]?.truncated === true, { truncated: autoLimited.json?.batch?.sets?.[0]?.truncated, rowCount: autoLimited.json?.batch?.sets?.[0]?.rowCount, statement: autoLimited.json?.batch?.sets?.[0]?.statement });
    await expectOk('explicit limit', 'POST', '/query', { connectionId: demo.id, sql: 'SELECT * FROM orders', limit: 25 }, (j) => j.batch.sets[0].rows.length === 25);
    await expectOk('short multi statement runs', 'POST', '/query', { connectionId: demo.id, sql: 'SELECT 1 AS a; SELECT 2 AS b' }, (j) => j.batch.sets.length === 2);
    const tooMany = Array.from({ length: 201 }, (_, i) => `SELECT ${i} AS n`).join('; ');
    await expectError('oversized script needs allowMulti', 'POST', '/query', { connectionId: demo.id, sql: tooMany }, [400, 403], undefined);
    await expectOk('oversized script allowed with allowMulti', 'POST', '/query', { connectionId: demo.id, sql: tooMany, allowMulti: true }, (j) => j.batch.sets.length === 201);
    const badQuery = await api('POST', '/query', { connectionId: demo.id, sql: 'SELECT * FROM no_such_table' });
    record('bad SQL returns 4xx/5xx with code', badQuery.status >= 400 && Boolean(badQuery.json?.error?.code), { status: badQuery.status, error: badQuery.json?.error });
    await expectOk('explain plan', 'POST', '/query', { connectionId: demo.id, sql: 'EXPLAIN QUERY PLAN SELECT * FROM orders WHERE status = ?' }, (j) => Array.isArray(j.batch?.sets?.[0]?.rows));

    // --------------------------------------------------------------- tx flow
    section('transactions');
    const tableDdl = `CREATE TABLE ${SCRATCH} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT 1, note TEXT)`;
    await expectOk('scratch table created', 'POST', '/ddl/execute', { connectionId: sandbox.id, statements: [tableDdl] }, (j) => j.batch.sets.length >= 0);
    const txSession = `qa-tx-${Date.now()}`;
    await expectOk('tx begin', 'POST', '/tx/begin', { connectionId: sandbox.id, sessionId: txSession }, () => true);
    await expectOk('tx insert in session', 'POST', '/query', { connectionId: sandbox.id, sessionId: txSession, sql: `INSERT INTO ${SCRATCH} (name,price_cents) VALUES ('tx-rollback', 100)` }, () => true);
    await expectOk('tx rollback', 'POST', '/tx/rollback', { sessionId: txSession }, () => true);
    const afterRollback = await query(sandbox.id, `SELECT COUNT(*) FROM ${SCRATCH} WHERE name='tx-rollback'`);
    record('rollback removes row', Number(afterRollback.json?.batch?.sets?.[0]?.rows?.[0]?.[0]) === 0, afterRollback.json?.error ?? afterRollback.json?.batch?.sets?.[0]?.rows);
    const txSession2 = `qa-tx-${Date.now()}-2`;
    await expectOk('tx begin #2', 'POST', '/tx/begin', { connectionId: sandbox.id, sessionId: txSession2 }, () => true);
    await expectOk('tx insert #2', 'POST', '/query', { connectionId: sandbox.id, sessionId: txSession2, sql: `INSERT INTO ${SCRATCH} (name,price_cents) VALUES ('tx-commit', 200)` }, () => true);
    await expectOk('tx commit', 'POST', '/tx/commit', { sessionId: txSession2 }, () => true);
    const afterCommit = await query(sandbox.id, `SELECT COUNT(*) FROM ${SCRATCH} WHERE name='tx-commit'`);
    record('commit persists row', Number(afterCommit.json?.batch?.sets?.[0]?.rows?.[0]?.[0]) === 1, afterCommit.json?.error ?? afterCommit.json?.batch?.sets?.[0]?.rows);

    // ----------------------------------------------------------- grid + rows
    section('grid-edit');
    const boolInsert = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'insert', values: { name: 'BoolRow', price_cents: 500, active: true } });
    record('grid insert boolean value', boolInsert.status === 200, { status: boolInsert.status, error: boolInsert.json?.error });
    const insert = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'insert', values: { name: 'Alpha', price_cents: 500 } });
    record('row insert', insert.status === 200, { status: insert.status, body: truncate(insert.json) });
    const listed = await query(sandbox.id, `SELECT id,name,price_cents FROM ${SCRATCH} WHERE name='Alpha'`);
    const alphaId = listed.json?.batch?.sets?.[0]?.rows?.[0]?.[0];
    check('inserted row visible', Boolean(alphaId), listed.json?.error ?? listed.json?.batch?.sets?.[0]?.rows);
    const update = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'update', values: { price_cents: 777 }, key: { id: alphaId } });
    record('row update by pk', update.status === 200, { status: update.status, body: truncate(update.json) });
    const boolUpdate = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'update', values: { active: false }, key: { id: alphaId } });
    record('grid update boolean value', boolUpdate.status === 200, { status: boolUpdate.status, error: boolUpdate.json?.error });
    const updated = await query(sandbox.id, `SELECT price_cents FROM ${SCRATCH} WHERE id=${Number(alphaId)}`);
    record('update persisted', Number(updated.json?.batch?.sets?.[0]?.rows?.[0]?.[0]) === 777, updated.json?.error ?? updated.json?.batch?.sets?.[0]?.rows);
    const missingKey = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'update', values: { price_cents: 1 }, key: { name: 'Alpha' } });
    record('update without pk rejected', missingKey.status === 400, { status: missingKey.status, error: missingKey.json?.error });
    const many = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'insertMany', rows: [{ name: 'B1', price_cents: 10 }, { name: 'B2', price_cents: 20 }, { name: 'B3', price_cents: 30 }] });
    record('insertMany', many.status === 200, { status: many.status, body: truncate(many.json) });
    const page = await api('GET', `/data?connectionId=${sandbox.id}&table=${SCRATCH}&limit=2&offset=0&orderBy=id&orderDir=desc`);
    record('data paging', page.status === 200 && page.json.batch.sets[0].rows.length === 2 && page.json.total >= 4, { status: page.status, total: page.json?.total, rows: page.json?.batch?.sets?.[0]?.rows?.length });
    const filtered = await api('GET', `/data?connectionId=${sandbox.id}&table=${SCRATCH}&where=${encodeURIComponent("name IN ('B1','B2','B3')")}&limit=10`);
    record('data filter', filtered.status === 200 && filtered.json.batch.sets[0].rows.length === 3, { status: filtered.status, total: filtered.json?.total });
    const del = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'delete', key: { id: alphaId } });
    record('row delete', del.status === 200, { status: del.status, body: truncate(del.json) });
    const delMany = await api('POST', '/rows', { connectionId: sandbox.id, table: SCRATCH, op: 'deleteMany', keys: [{ id: 1 }, { id: 2 }] });
    record('deleteMany tolerates absent keys', delMany.status === 200, { status: delMany.status, body: truncate(delMany.json) });

    // ------------------------------------------------------------------- DDL
    section('ddl');
    const preview = await api('POST', '/ddl/preview', { connectionId: sandbox.id, table: 'qa_orders_v2', columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true },
      { name: 'order_no', type: 'TEXT', nullable: false },
      { name: 'amount_cents', type: 'INTEGER', nullable: false, defaultValue: '0' },
      { name: 'created_at', type: 'TEXT' },
    ], indexes: [{ name: 'ix_qa_orders_v2_no', columns: ['order_no'], unique: true }] });
    record('ddl preview create', preview.status === 200 && preview.json.statements?.length >= 1, { status: preview.status, body: truncate(preview.json) });
    const executed = await api('POST', '/ddl/execute', { connectionId: sandbox.id, statements: preview.json?.statements ?? [] });
    record('ddl execute create', executed.status === 200, { status: executed.status, body: truncate(executed.json) });
    const refreshed = await api('GET', `/connections/${sandbox.id}/schema?refresh=1`);
    const created = refreshed.json.schemas[0].tables.find((t) => t.name === 'qa_orders_v2');
    check('created table visible with index', created && created.columns.length === 4 && (created.indexes?.length ?? 0) >= 1, created);
    await expectError('field create is NoSQL-only on SQLite', 'POST', '/fields/create', { connectionId: sandbox.id, object: 'qa_orders_v2', name: 'remark', type: 'text' }, [400], 'UNSUPPORTED_ENGINE');
    const alter = await api('POST', '/ddl/execute', { connectionId: sandbox.id, statements: ['ALTER TABLE qa_orders_v2 ADD COLUMN remark TEXT'] });
    record('SQLite ALTER TABLE ADD COLUMN via DDL', alter.status === 200, { status: alter.status, body: truncate(alter.json) });
    const afterField = await api('GET', `/connections/${sandbox.id}/schema?refresh=1`);
    check('field visible', afterField.json.schemas[0].tables.find((t) => t.name === 'qa_orders_v2')?.columns.some((c) => c.name === 'remark'), undefined);
    await expectError('collection index create is NoSQL-only on SQLite', 'POST', '/indexes/create', { connectionId: sandbox.id, collection: 'qa_orders_v2', name: 'ix_qa_orders_v2_created', columns: ['created_at'] }, [400], 'UNSUPPORTED_ENGINE');
    await expectOk('SQL index create via DDL', 'POST', '/ddl/execute', { connectionId: sandbox.id, statements: ['CREATE INDEX ix_qa_orders_v2_created ON qa_orders_v2 (created_at)'] }, (j) => j.batch.sets.length >= 0);
    await expectOk('SQL index drop via DDL', 'POST', '/ddl/execute', { connectionId: sandbox.id, statements: ['DROP INDEX ix_qa_orders_v2_created'] }, (j) => j.batch.sets.length >= 0);
    await expectOk('object drop via table ops', 'POST', '/tables/ops', { connectionId: sandbox.id, table: 'qa_orders_v2', op: 'drop' }, (j) => j.statements || j.batch || j.message);
    const afterDrop = await api('GET', `/connections/${sandbox.id}/schema?refresh=1`);
    check('dropped table gone', !afterDrop.json.schemas[0].tables.some((t) => t.name === 'qa_orders_v2'), undefined);

    // ---------------------------------------------------------- table ops
    section('table-ops');
    await expectOk('table rename', 'POST', '/tables/ops', { connectionId: sandbox.id, table: SCRATCH, op: 'rename', newName: 'qa_widgets_renamed' });
    const renamed = await query(sandbox.id, "SELECT name FROM sqlite_master WHERE type='table' AND name='qa_widgets_renamed'");
    record('rename persisted', renamed.json?.batch?.sets?.[0]?.rows?.length === 1, renamed.json?.batch?.sets?.[0]?.rows);
    await expectOk('table duplicate', 'POST', '/tables/ops', { connectionId: sandbox.id, table: 'qa_widgets_renamed', op: 'duplicate', newName: 'qa_widgets_copy', withData: true });
    const dupCount = await query(sandbox.id, 'SELECT COUNT(*) FROM qa_widgets_copy');
    record('duplicate copies rows', Number(dupCount.json.batch.sets[0].rows[0][0]) >= 1, dupCount.json?.batch?.sets?.[0]?.rows);
    await expectOk('table truncate', 'POST', '/tables/ops', { connectionId: sandbox.id, table: 'qa_widgets_copy', op: 'truncate' });
    const truncCount = await query(sandbox.id, 'SELECT COUNT(*) FROM qa_widgets_copy');
    record('truncate empties table', Number(truncCount.json.batch.sets[0].rows[0][0]) === 0, truncCount.json?.batch?.sets?.[0]?.rows);
    await expectOk('table maintenance', 'POST', '/tables/ops', { connectionId: sandbox.id, table: 'qa_widgets_renamed', op: 'maintenance', action: 'vacuum' });
    await expectOk('table drop', 'POST', '/tables/ops', { connectionId: sandbox.id, table: 'qa_widgets_copy', op: 'drop' });
    const dbOps = await api('POST', '/databases/ops', { connectionId: sandbox.id, database: 'qa_new_db', op: 'create' });
    record('database ops graceful on sqlite', dbOps.status < 500, { status: dbOps.status, body: truncate(dbOps.json) });

    // -------------------------------------------------------------- replace
    section('data-replace');
    await expectOk('replace preview', 'POST', '/data/replace', { connectionId: sandbox.id, table: 'qa_widgets_renamed', column: 'name', find: 'B', replace: 'B-', preview: true }, (j) => j.preview !== undefined);
    await expectOk('replace apply', 'POST', '/data/replace', { connectionId: sandbox.id, table: 'qa_widgets_renamed', column: 'name', find: 'B', replace: 'B-' }, (j) => j.affected >= 1);

    // ------------------------------------------------------------ import/export
    section('import-export');
    for (const format of ['csv', 'json', 'sql', 'xml', 'xlsx']) {
      const res = await api('POST', '/export', { connectionId: demo.id, format, table: 'coupons', limit: 20 });
      const file = res.json?.file;
      let size = 0;
      try { size = file?.path ? statSync(file.path).size : 0; } catch {}
      record(`export ${format}`, res.status === 200 && size > 0 && file.rows === 20, { status: res.status, file: file ? { rows: file.rows, bytes: file.bytes, size } : truncate(res.json) });
    }
    const exportQuery = await api('POST', '/export', { connectionId: demo.id, format: 'csv', sql: 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status', limit: 100 });
    record('export from SQL', exportQuery.status === 200 && exportQuery.json.file.bytes > 0, truncate(exportQuery.json));
    await expectOk('import csv', 'POST', '/import', { connectionId: sandbox.id, table: 'qa_widgets_renamed', csv: 'name,price_cents,active\nCSV-A,111,1\nCSV-B,222,0\nCSV-C,333,1\n', hasHeader: true }, (j) => j.result.inserted === 3);
    const importCount = await query(sandbox.id, "SELECT COUNT(*) FROM qa_widgets_renamed WHERE name LIKE 'CSV-%'");
    record('import persisted rows', Number(importCount.json.batch.sets[0].rows[0][0]) === 3, importCount.json?.batch?.sets?.[0]?.rows);
    const importBad = await api('POST', '/import', { connectionId: sandbox.id, table: 'qa_widgets_renamed', csv: 'x,y\n1,2\n', hasHeader: true, mapping: [{ column: 'name', sourceIndex: 0 }, { column: 'name', sourceIndex: 1 }] });
    record('duplicate mapping rejected', importBad.status === 400, { status: importBad.status, error: importBad.json?.error });

    // --------------------------------------------------------------- generate
    section('generate-data');
    const dry = await api('POST', '/generate', { connectionId: sandbox.id, table: 'qa_widgets_renamed', rows: 5, dryRun: true });
    record('generate dry-run', dry.status === 200 && dry.json.result.dryRun === true && dry.json.result.inserted === 0, { status: dry.status, body: truncate(dry.json) });
    const gen = await api('POST', '/generate', { connectionId: sandbox.id, table: 'qa_widgets_renamed', rows: 5 });
    record('generate inserts rows', gen.status === 200 && gen.json.result.inserted === 5, { status: gen.status, body: truncate(gen.json) });

    // -------------------------------------------------------------- backups
    section('backups');
    const backup = await api('POST', '/backups', { connectionId: sandbox.id, label: 'qa-backup' });
    record('backup created', backup.status === 201 && backup.json.backup?.bytes > 0, { status: backup.status, body: truncate(backup.json) });
    const backupId = backup.json?.backup?.id;
    const backups = await api('GET', `/backups?connectionId=${sandbox.id}`);
    record('backup listed', backups.status === 200 && backups.json.backups.some((b) => b.id === backupId), { status: backups.status });
    await query(sandbox.id, 'DELETE FROM qa_widgets_renamed');
    const emptied = await query(sandbox.id, 'SELECT COUNT(*) FROM qa_widgets_renamed');
    const restore = await api('POST', `/backups/${backupId}/restore`);
    const restored = await query(sandbox.id, 'SELECT COUNT(*) FROM qa_widgets_renamed');
    record('restore brings rows back', restore.status === 200 && Number(restored.json.batch.sets[0].rows[0][0]) > 0, { status: restore.status, before: emptied.json?.batch?.sets?.[0]?.rows, after: restored.json?.batch?.sets?.[0]?.rows, body: truncate(restore.json) });

    // ------------------------------------------------------------------ jobs
    section('jobs');
    const job = await api('POST', '/jobs', { name: 'qa-count-orders', connectionId: demo.id, type: 'query', sql: 'SELECT COUNT(*) FROM orders', intervalSeconds: 30, enabled: true });
    record('job created', job.status === 201 && job.json.job?.id, { status: job.status, body: truncate(job.json) });
    jobId = job.json?.job?.id;
    const runJob = await api('POST', `/jobs/${jobId}/run`);
    record('job run', runJob.status === 200 && runJob.json.ok === true, { status: runJob.status, body: truncate(runJob.json) });
    await expectOk('job update', 'PUT', `/jobs/${jobId}`, { enabled: false }, (j) => j.job.enabled === false);
    await expectOk('job delete', 'DELETE', `/jobs/${jobId}`, undefined, () => true);

    // ------------------------------------------------------------ dashboards
    section('dashboards');
    const card = await api('POST', '/dashboards/cards', { connectionId: demo.id, database: demoDatabase, title: '渠道 GMV', sql: 'SELECT channel, SUM(pay_cents) AS gmv FROM orders GROUP BY channel ORDER BY gmv DESC', chartType: 'bar' });
    record('dashboard card create', card.status < 300 && card.json.card?.id, { status: card.status, body: truncate(card.json) });
    const cardId = card.json?.card?.id;
    const previewDash = await api('POST', '/dashboards/preview', { connectionId: demo.id, sql: 'SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status' });
    record('dashboard preview', previewDash.status === 200 && previewDash.json.preview?.rows?.length > 0, { status: previewDash.status, body: truncate(previewDash.json) });
    const refresh = await api('POST', '/dashboards/refresh', { connectionId: demo.id, database: demoDatabase });
    record('dashboard refresh', refresh.status === 200 && Array.isArray(refresh.json.results), { status: refresh.status, body: truncate(refresh.json) });
    const compose = await api('POST', '/dashboards/compose', { connectionId: demo.id, database: demoDatabase, prompt: '按月统计最近半年的成交金额趋势' });
    record('dashboard compose (model)', compose.status === 200 && compose.json.sql?.length > 0, { status: compose.status, body: truncate(compose.json) });
    if (compose.status === 200) {
      record('compose picks line chart for time series', compose.json.chartType === 'line', { chartType: compose.json.chartType, sql: compose.json.sql });
    }
    const report = await api('POST', '/dashboards/report', { connectionId: demo.id, database: demoDatabase });
    record('dashboard report artifact', report.status === 200 && report.json.artifact?.id, { status: report.status, body: truncate(report.json) });
    await expectOk('dashboard schedule read', 'GET', `/dashboards/schedule?connectionId=${demo.id}&database=${demoDatabase}`, undefined, () => true);
    await expectOk('dashboard schedule write', 'PUT', '/dashboards/schedule', { connectionId: demo.id, database: demoDatabase, intervalSeconds: 0, enabled: false }, () => true);
    await expectOk('dashboard card delete', 'DELETE', `/dashboards/cards/${cardId}`, undefined, () => true);

    // ------------------------------------------------- capabilities/metadata
    section('capabilities');
    await expectOk('capabilities list', 'GET', '/capabilities', undefined, (j) => j.capabilities.length >= 10);
    await expectOk('capability detail', 'GET', '/capabilities/transfer', undefined, (j) => j.capability?.id === 'transfer');
    const dict = await api('GET', `/dictionary?connectionId=${demo.id}`);
    record('dictionary markdown', dict.status === 200 && dict.json.dictionary.markdown.includes('orders') && dict.json.dictionary.tableCount >= 34, { status: dict.status, tables: dict.json?.dictionary?.tableCount });
    const objects = await api('GET', `/objects?connectionId=${demo.id}`);
    record('advanced objects responds', objects.status === 200 && typeof objects.json.objects?.supported === 'boolean', { status: objects.status, objects: truncate(objects.json?.objects) });
    record('sqlite triggers surfaced', (objects.json?.objects?.triggers?.length ?? 0) >= 2, { triggers: objects.json?.objects?.triggers });
    const tableOptions = await api('GET', `/table-options?connectionId=${demo.id}&table=orders`);
    record('table options responds', tableOptions.status === 200 && Array.isArray(tableOptions.json.options), { status: tableOptions.status, body: truncate(tableOptions.json) });
    const users = await api('GET', `/users?connectionId=${demo.id}`);
    record('users endpoint graceful', users.status === 200 && typeof users.json.supported === 'boolean', { status: users.status, body: truncate(users.json) });
    const monitor = await api('GET', `/monitor?connectionId=${demo.id}`);
    record('monitor responds', monitor.status === 200 && monitor.json.monitor, { status: monitor.status, body: truncate(monitor.json) });

    // -------------------------------------------------------------- search
    section('search');
    const objSearch = await api('POST', '/search', { connectionId: demo.id, query: 'order', scope: 'objects' });
    record('search objects', objSearch.status === 200 && objSearch.json.objects?.length > 0, { status: objSearch.status, objects: objSearch.json?.objects?.slice(0, 5) });
    const dataSearch = await api('POST', '/search', { connectionId: demo.id, query: 'SO2025', scope: 'data' });
    record('search data', dataSearch.status === 200 && Array.isArray(dataSearch.json.data), { status: dataSearch.status, body: truncate(dataSearch.json) });
    const backends = await api('GET', '/search/backends');
    record('search backends listed', backends.status === 200 && backends.json.backends, { status: backends.status });
    const probe = await api('POST', '/search/backends/searxng/probe');
    record('search backend probe', probe.status === 200 && probe.json.health, { status: probe.status, body: truncate(probe.json) });

    // ------------------------------------------------------- agent context/memory
    section('agent-context');
    await expectOk('context entry upsert', 'PUT', '/agent/context/entry', { connectionId: demo.id, database: demoDatabase, table: 'orders', kind: 'table', description: '订单主表：每行一笔订单，pay_cents 为实付金额（分）', alias: '订单' }, (j) => j.entry);
    await expectOk('context relation upsert', 'PUT', '/agent/context/relation', { connectionId: demo.id, database: demoDatabase, table: 'orders', column: 'customer_id', refTable: 'customers', refColumn: 'id', description: '订单所属客户' }, (j) => j.entry);
    await expectOk('context bundle read', 'GET', `/agent/context?connectionId=${demo.id}&database=${demoDatabase}`, undefined, (j) => Array.isArray(j.entries) && j.entries.some((entry) => entry.table === 'orders'));
    await expectOk('context bulk enable', 'POST', '/agent/context/bulk', { connectionId: demo.id, database: demoDatabase, tables: ['customers', 'products'], enabled: true }, (j) => typeof j.touched === 'number');
    const mem = await api('POST', '/agent/memories', { title: 'QA 记忆：GMV 口径', content: 'GMV 使用 orders.pay_cents 汇总，排除 cancelled。', kind: 'fact', connectionId: demo.id, database: demoDatabase });
    record('memory create', mem.status === 201 && mem.json.memory?.id, { status: mem.status, body: truncate(mem.json) });
    if (mem.json?.memory?.id) createdMemories.push(mem.json.memory.id);
    const memSearch = await api('GET', '/agent/memories?q=GMV');
    record('memory search', memSearch.status === 200 && memSearch.json.memories?.length >= 1, { status: memSearch.status });
    if (mem.json?.memory?.id) await expectOk('memory update', 'PUT', `/agent/memories/${mem.json.memory.id}`, { importance: 0.9 }, (j) => j.memory.importance === 0.9);

    // ----------------------------------------------------------- notifications
    section('notifications');
    const channel = await api('POST', '/notifications/channels', { name: 'QA 通道', type: 'feishu', config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/qa-invalid-token' } });
    record('notification channel create', channel.status === 201 && channel.json.channel?.id, { status: channel.status, body: truncate(channel.json) });
    channelId = channel.json?.channel?.id;
    const listedChannels = await api('GET', '/notifications/channels');
    record('notification channel listed', listedChannels.status === 200 && listedChannels.json.channels.some((c) => c.id === channelId), { status: listedChannels.status });
    const testChannel = await api('POST', `/notifications/channels/${channelId}/test`);
    record('notification test reports failure gracefully', testChannel.status === 200 && testChannel.json.result?.ok === false, { status: testChannel.status, body: truncate(testChannel.json) });
    await expectOk('notification channel delete', 'DELETE', `/notifications/channels/${channelId}`, undefined, () => true);

    // ------------------------------------------------------------------- mcp
    section('mcp');
    const servers = await api('GET', '/mcp/servers');
    record('mcp servers listed', servers.status === 200 && servers.json.servers.length >= 3, { status: servers.status, body: truncate(servers.json) });
    const builtin = servers.json?.servers?.find((s) => s.builtin);
    if (builtin) {
      const toolsRes = await api('GET', `/mcp/servers/${builtin.id}/tools`);
      record('builtin mcp tools listed', toolsRes.status === 200 && toolsRes.json.tools?.length > 0, { status: toolsRes.status, body: truncate(toolsRes.json) });
    }
    const mcpCreate = await api('POST', '/mcp/servers', { name: 'qa-dummy', command: 'node', args: ['-e', 'console.error("x")'], enabled: false });
    record('mcp server create', mcpCreate.status === 201 && mcpCreate.json.server?.id, { status: mcpCreate.status, body: truncate(mcpCreate.json) });
    mcpId = mcpCreate.json?.server?.id;
    if (mcpId) await expectOk('mcp server delete', 'DELETE', `/mcp/servers/${mcpId}`, undefined, () => true);

    // ----------------------------------------------------------------- skills
    section('skills');
    const skills = await api('GET', '/skills');
    record('skills listed', skills.status === 200 && Array.isArray(skills.json.skills), { status: skills.status, body: truncate(skills.json) });
    const firstSkill = skills.json?.skills?.[0];
    if (firstSkill) {
      const skillDetail = await api('GET', `/skills/${firstSkill.id}`);
      record('skill detail', skillDetail.status === 200 && skillDetail.json.skill, { status: skillDetail.status, body: truncate(skillDetail.json) });
      const skillFile = await api('GET', `/skills/${firstSkill.id}/file?path=SKILL.md`);
      record('skill file read', skillFile.status === 200, { status: skillFile.status, body: truncate(skillFile.json ?? skillFile.text) });
    }

    // -------------------------------------------------------- direct read tools
    section('agent-tools-direct');
    const toolsList = await api('GET', '/agent/tools');
    record('tools endpoint lists 52', toolsList.status === 200 && toolsList.json.tools.length === 52, { status: toolsList.status, count: toolsList.json?.tools?.length });
    const direct = [
      ['list_connections', {}],
      ['inspect_schema', { connectionId: demo.id, database: demoDatabase, tables: ['orders', 'customers'] }],
      ['search_objects', { connectionId: demo.id, database: demoDatabase, query: 'pay_cents' }],
      ['sample_rows', { connectionId: demo.id, database: demoDatabase, table: 'customers', limit: 3 }],
      ['profile_column', { connectionId: demo.id, database: demoDatabase, table: 'customers', column: 'mobile' }],
      ['explain_sql', { connectionId: demo.id, database: demoDatabase, sql: 'SELECT * FROM orders WHERE status = \'completed\'' }],
      ['check_data_quality', { connectionId: demo.id, database: demoDatabase, table: 'customers' }],
      ['audit_database', { connectionId: demo.id, database: demoDatabase }],
      ['render_chart', { connectionId: demo.id, database: demoDatabase, sql: 'SELECT channel, SUM(pay_cents) AS gmv FROM orders GROUP BY channel ORDER BY gmv DESC', type: 'bar', x: 'channel', y: 'gmv' }],
      ['analyze_chart', { connectionId: demo.id, database: demoDatabase, sql: 'SELECT channel, SUM(pay_cents) AS gmv FROM orders GROUP BY channel ORDER BY gmv DESC', x: 'channel', y: 'gmv', topN: 3 }],
      ['forecast_chart', { connectionId: demo.id, database: demoDatabase, sql: "SELECT substr(created_at,1,7) AS month, SUM(pay_cents) AS gmv FROM orders WHERE status='completed' GROUP BY month ORDER BY month", x: 'month', y: 'gmv', periods: 3 }],
      ['get_query_history', { limit: 5 }],
      ['update_plan', { items: [{ text: 'QA 步骤一', status: 'done' }, { text: 'QA 步骤二', status: 'todo' }] }],
      ['memory_write', { kind: 'fact', title: 'QA 工具记忆', content: '订单表实付金额字段为 pay_cents。', scopeType: 'connection', scopeKey: demo.id }],
      ['memory_search', { query: 'pay_cents' }],
      ['backup_database', { connectionId: sandbox.id, label: 'qa-tool-backup' }],
      ['skill_list', {}],
      ['mcp_list_servers', {}],
      ['mcp_list_tools', { server: builtin?.id ?? 'builtin' }],
      ['recon_data', { left: { kind: 'table', connectionId: demo.id, database: demoDatabase, table: 'orders', keyColumns: ['id'] }, right: { kind: 'table', connectionId: mirror.id, database: demoDatabase, table: 'orders', keyColumns: ['id'] }, level: 'counts' }],
      ['schema_diff', { sourceConnectionId: demo.id, sourceDatabase: demoDatabase, targetConnectionId: mirror.id, targetDatabase: demoDatabase, tables: ['orders', 'product_reviews'] }],
    ];
    for (const [name, args] of direct.filter(([name]) => !['mcp_list_servers', 'mcp_list_tools'].includes(name))) {
      const res = await tool(name, args, demo.id, demoDatabase);
      const body = res.json?.result;
      record(`tool ${name}`, res.status === 200 && body?.ok === true, { status: res.status, error: body?.error ?? res.json?.error, summary: body?.summary });
      if (name === 'memory_write' && body?.ok) {
        const mems = await api('GET', '/agent/memories?q=QA 工具记忆');
        for (const m of mems.json?.memories ?? []) createdMemories.push(m.id);
      }
    }
    for (const name of ['mcp_list_servers', 'mcp_list_tools']) {
      const res = await tool(name, {}, demo.id, demoDatabase);
      record(`tool ${name} excluded from outbound bridge`, res.status === 403 && res.json?.error?.code === 'TOOL_NOT_EXPOSED', { status: res.status, error: res.json?.error });
    }
    const writeTool = await tool('transfer_data', { sourceConnectionId: demo.id, targetConnectionId: target.id, tables: ['brands'] }, demo.id, demoDatabase);
    record('direct write tool blocked (TOOL_READ_ONLY)', writeTool.status === 403 && writeTool.json?.error?.code === 'TOOL_READ_ONLY', { status: writeTool.status, error: writeTool.json?.error });

    // --------------------------------------------------------------- readonly
    section('readonly-guard');
    await expectOk('readonly select allowed', 'POST', '/query', { connectionId: readonly.id, sql: 'SELECT COUNT(*) FROM orders' }, (j) => Number(j.batch.sets[0].rows[0][0]) === 25000);
    await expectError('readonly write query blocked', 'POST', '/query', { connectionId: readonly.id, sql: "UPDATE orders SET remark='x' WHERE id=1" }, [403], undefined);
    await expectError('readonly row insert blocked', 'POST', '/rows', { connectionId: readonly.id, table: SCRATCH, op: 'insert', values: { name: 'x' } }, [403], undefined);
    await expectError('readonly import blocked', 'POST', '/import', { connectionId: readonly.id, table: SCRATCH, csv: 'name\nx\n', hasHeader: true }, [403], undefined);
    await expectError('readonly generate blocked', 'POST', '/generate', { connectionId: readonly.id, table: SCRATCH, rows: 2 }, [403], undefined);
    const readonlyDry = await api('POST', '/generate', { connectionId: readonly.id, table: 'orders', rows: 1, dryRun: true });
    record('readonly generate dry-run allowed', readonlyDry.status === 200, { status: readonlyDry.status, body: truncate(readonlyDry.json) });
    await expectOk('readonly export allowed', 'POST', '/export', { connectionId: readonly.id, format: 'csv', table: 'orders', limit: 5 }, (j) => j.file?.rows === 5);
    await expectOk('readonly backup allowed', 'POST', '/backups', { connectionId: readonly.id, label: 'qa-ro' }, (j) => Boolean(j.backup?.path));

    // ------------------------------------------------- migration/compare/sync
    section('migration');
    const schemaCompare = await api('POST', '/schema/compare', { sourceId: demo.id, sourceDatabase: demoDatabase, targetId: mirror.id, targetDatabase: demoDatabase });
    record('schema compare status', schemaCompare.status === 200, { status: schemaCompare.status, body: truncate(schemaCompare.json) });
    const diff = schemaCompare.json?.diff;
    record('schema compare finds differences', diff && diff.summary && (diff.summary.added + diff.summary.removed + diff.summary.changed) > 0, diff?.summary);
    record('schema compare detects missing tables', diff?.tables?.some((t) => /product_reviews|customer_avatars|legacy_order_export/.test(t.name ?? t.table ?? '')), { tables: diff?.tables?.slice?.(0, 6) });
    const dataCompare = await api('POST', '/data/compare', { sourceId: demo.id, sourceDatabase: demoDatabase, targetId: mirror.id, targetDatabase: demoDatabase, tables: ['orders', 'customers', 'products', 'coupons', 'product_reviews'] });
    record('data compare status', dataCompare.status === 200, { status: dataCompare.status, body: truncate(dataCompare.json) });
    const cmpRows = dataCompare.json?.result?.rows ?? [];
    record('data compare detects order drift', cmpRows.find((r) => r.table === 'orders')?.status === 'different', cmpRows);
    record('data compare detects missing table', cmpRows.find((r) => r.table === 'product_reviews')?.status === 'missing', cmpRows);

    const transferSmall = await api('POST', '/transfer', { sourceConnectionId: demo.id, sourceDatabase: demoDatabase, targetConnectionId: target.id, targetDatabase: demoDatabase, tables: ['brands', 'coupons'], mode: 'replace', createMissing: true });
    record('transfer small tables', transferSmall.status === 200 && transferSmall.json.result.results.every((r) => r.status === 'ok'), { status: transferSmall.status, body: truncate(transferSmall.json) });
    const targetBrands = await query(target.id, 'SELECT COUNT(*) FROM brands');
    record('transfer target row count', Number(targetBrands.json?.batch?.sets?.[0]?.rows?.[0]?.[0]) === 25, targetBrands.json?.batch?.sets?.[0]?.rows);

    const targetSchema = await api('GET', `/connections/${target.id}/schema?refresh=1`);
    const targetCompare = await api('POST', '/schema/compare', { sourceId: demo.id, sourceDatabase: demoDatabase, targetId: target.id, targetDatabase: demoDatabase });
    const statements = targetCompare.json?.diff?.sql ?? [];
    record('schema diff produces DDL for empty target', statements.length >= 30, { statements: statements.length, summary: targetCompare.json?.diff?.summary });
    const sync = await api('POST', '/schema/sync', { connectionId: target.id, database: demoDatabase, statements });
    record('schema sync executes diff', sync.status === 200, { status: sync.status, body: truncate(sync.json) });
    const targetSchemaAfter = await api('GET', `/connections/${target.id}/schema?refresh=1`);
    record('schema sync creates all tables', (targetSchemaAfter.json?.schemas?.[0]?.tables?.length ?? 0) >= 34, { tables: targetSchemaAfter.json?.schemas?.[0]?.tables?.length });
    void targetSchema;

    const transferStart = Date.now();
    const full = await api('POST', '/transfer', { sourceConnectionId: demo.id, sourceDatabase: demoDatabase, targetConnectionId: target.id, targetDatabase: demoDatabase, mode: 'replace', createMissing: true });
    const transferMs = Date.now() - transferStart;
    record('full transfer completes', full.status === 200 && full.json.result.results.filter((r) => r.status === 'error').length === 0, { status: full.status, ms: transferMs, totalRows: full.json?.result?.totalRows, errors: full.json?.result?.results?.filter((r) => r.status === 'error').slice(0, 3) });
    const verifyPairs = [['orders', 25000], ['order_items', 62596], ['customers', 3000], ['web_events', 60000]];
    for (const [table, expected] of verifyPairs) {
      const res = await query(target.id, `SELECT COUNT(*) FROM ${table}`);
      record(`full transfer ${table} rows`, Number(res.json?.batch?.sets?.[0]?.rows?.[0]?.[0]) === expected, { actual: res.json?.batch?.sets?.[0]?.rows?.[0]?.[0], expected });
    }
    const sameCompare = await api('POST', '/data/compare', { sourceId: demo.id, sourceDatabase: demoDatabase, targetId: target.id, targetDatabase: demoDatabase, tables: ['orders', 'brands', 'customers'] });
    record('data compare after full transfer matches', (sameCompare.json?.result?.rows ?? []).every((r) => r.status === 'same'), sameCompare.json?.result?.rows);

    const stream = await sse('/transfer/stream', { sourceConnectionId: demo.id, sourceDatabase: demoDatabase, targetConnectionId: target.id, targetDatabase: demoDatabase, tables: ['customers'], mode: 'replace', limit: 1000 });
    const streamTypes = stream.events.map((e) => e.type);
    record('transfer stream emits progress events', stream.status === 200 && streamTypes.includes('table-start') && streamTypes.includes('done'), { status: stream.status, types: [...new Set(streamTypes)] });
    const streamedCount = await query(target.id, 'SELECT COUNT(*) FROM customers');
    record('transfer stream honors limit', Number(streamedCount.json?.batch?.sets?.[0]?.rows?.[0]?.[0]) === 1000, streamedCount.json?.batch?.sets?.[0]?.rows);

    // -------------------------------------------------- history/audit/snippets
    section('history-audit');
    const history = await api('GET', `/history?connectionId=${demo.id}&limit=50`);
    record('history recorded', history.status === 200 && history.json.items.length > 0, { status: history.status, count: history.json?.items?.length });
    if (history.json?.items?.length) {
      const fav = await api('POST', `/history/${history.json.items[0].id}/favorite`, { favorite: true });
      record('history favorite', fav.status === 200 && fav.json.favorite === true, { status: fav.status, body: truncate(fav.json) });
    }
    const audit = await api('GET', '/audit?limit=20');
    record('audit entries', audit.status === 200 && Array.isArray(audit.json.entries) && audit.json.entries.length > 0, { status: audit.status, count: audit.json?.entries?.length });
    const auditCsv = await api('GET', '/audit?format=csv&limit=5');
    record('audit csv export', auditCsv.status === 200 && auditCsv.text.includes(','), { status: auditCsv.status, head: auditCsv.text.slice(0, 120) });
    const snippet = await api('POST', '/snippets', { name: 'QA 订单汇总', sql: 'SELECT status, COUNT(*) FROM orders GROUP BY status', tags: ['qa'] });
    record('snippet create', snippet.status === 201 && snippet.json.snippet?.id, { status: snippet.status, body: truncate(snippet.json) });
    snippetId = snippet.json?.snippet?.id;
    const snippets = await api('GET', '/snippets');
    record('snippet listed', snippets.status === 200 && snippets.json.snippets.some((s) => s.id === snippetId), { status: snippets.status });
    if (snippetId) await expectOk('snippet delete', 'DELETE', `/snippets/${snippetId}`, undefined, () => true);
    const historyClear = await api('DELETE', `/history?connectionId=${demo.id}`);
    record('history clear', historyClear.status === 204, { status: historyClear.status });

    // -------------------------------------------------------------- commands
    section('commands');
    const commands = await api('GET', '/commands');
    record('commands listed', commands.status === 200 && commands.json.commands.length === 6, { status: commands.status, ids: commands.json?.commands?.map((c) => c.id) });
    const diffRun = await api('POST', '/commands/diff/runs', { input: { sources: [{ connectionId: demo.id, database: demoDatabase, label: '业务库' }, { connectionId: mirror.id, database: demoDatabase, label: '镜像库' }], includeDrops: false } });
    record('command /diff accepted', diffRun.status === 202 && diffRun.json.run?.id, { status: diffRun.status, body: truncate(diffRun.json) });
    if (diffRun.json?.run?.id) {
      const runId = diffRun.json.run.id;
      let run;
      for (let i = 0; i < 60; i++) {
        run = await api('GET', `/commands/runs/${runId}`);
        if (['succeeded', 'failed', 'cancelled'].includes(run.json?.run?.status)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      record('command /diff finished', ['succeeded', 'failed'].includes(run?.json?.run?.status), { status: run?.json?.run?.status, error: run?.json?.run?.error });
      record('command /diff succeeded', run?.json?.run?.status === 'succeeded', { status: run?.json?.run?.status, error: run?.json?.run?.error });
    }
    const reconRun = await api('POST', '/commands/recon/runs', { input: { sources: [{ connectionId: demo.id, database: demoDatabase, label: '业务库' }, { connectionId: mirror.id, database: demoDatabase, label: '镜像库' }], mapping: { mode: 'table-table', left: { kind: 'table', connectionId: demo.id, database: demoDatabase, table: 'orders', keyColumns: ['id'] }, right: { kind: 'table', connectionId: mirror.id, database: demoDatabase, table: 'orders', keyColumns: ['id'] }, fieldMap: [{ left: 'status', right: 'status' }, { left: 'pay_cents', right: 'pay_cents' }] }, level: 'counts', maxKeys: 50000 } });
    record('command /recon accepted', reconRun.status === 202 && reconRun.json.run?.id, { status: reconRun.status, body: truncate(reconRun.json) });
    if (reconRun.json?.run?.id) {
      const runId = reconRun.json.run.id;
      let run;
      for (let i = 0; i < 90; i++) {
        run = await api('GET', `/commands/runs/${runId}`);
        if (['succeeded', 'failed', 'cancelled'].includes(run.json?.run?.status)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      record('command /recon finished', ['succeeded', 'failed'].includes(run?.json?.run?.status), { status: run?.json?.run?.status, error: run?.json?.run?.error });
      record('command /recon succeeded', run?.json?.run?.status === 'succeeded', { status: run?.json?.run?.status, error: run?.json?.run?.error });
    }
    const badMapping = await api('POST', '/commands/recon/runs', { input: { sources: [{ connectionId: demo.id }, { connectionId: mirror.id }], mapping: { key: ['id'] }, level: 'counts' } });
    let badRunStatus = badMapping.status;
    let badRunError = badMapping.json?.error;
    if (badMapping.status === 202 && badMapping.json?.run?.id) {
      let badRun;
      for (let i = 0; i < 20; i++) {
        badRun = await api('GET', `/commands/runs/${badMapping.json.run.id}`);
        if (['succeeded', 'failed', 'cancelled'].includes(badRun.json?.run?.status)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      badRunStatus = badRun?.json?.run?.status;
      badRunError = badRun?.json?.run?.error;
    }
    record('recon rejects malformed mapping with a clear error', badMapping.status === 400 || /INVALID_INPUT|缺少|必填|mapping/i.test(JSON.stringify(badRunError)), { status: badMapping.status, runStatus: badRunStatus, error: badRunError });
  } finally {
    // cleanup first (best effort), then report
    try {
      for (const id of createdMemories) await api('DELETE', `/agent/memories/${id}`);
      if (channelId) await api('DELETE', `/notifications/channels/${channelId}`);
      if (mcpId) await api('DELETE', `/mcp/servers/${mcpId}`);
      if (jobId) await api('DELETE', `/jobs/${jobId}`);
      if (snippetId) await api('DELETE', `/snippets/${snippetId}`);
      await dropConnection(sandbox?.id);
      await dropConnection(readonly?.id);
      await dropConnection(target?.id);
    } catch (err) {
      console.error('cleanup error', err.message);
    }
    for (const file of [SANDBOX_FILE, TARGET_FILE]) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(file + suffix, { force: true }); } catch {}
      }
    }
    saveReport(REPORT, { base: 'http://127.0.0.1:8787', elapsedMs: Date.now() - startedAt, demoConnection: demo.id, mirrorConnection: mirror.id });
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
