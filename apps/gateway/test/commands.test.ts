import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';
import { CommandRunner } from '../src/commands/runner';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-commands-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const leftPath = join(home, 'left.sqlite');
const rightPath = join(home, 'right.sqlite');

const left = new DatabaseSync(leftPath);
left.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL);
  CREATE TABLE recon_users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
  CREATE TABLE no_pk (value TEXT);
  CREATE TABLE dup_idx (id INTEGER PRIMARY KEY, a TEXT);
  CREATE INDEX idx_dup_1 ON dup_idx(a);
  CREATE INDEX idx_dup_2 ON dup_idx(a);
  INSERT INTO recon_users (id, name, email) VALUES
    (1, 'Ada', 'ada@example.com'),
    (2, 'Bob', 'bob@example.com'),
    (3, 'Cid', 'cid@example.com'),
    (4, 'Dee', 'dee@example.com');
  INSERT INTO no_pk (value) VALUES ('x'), ('x');
`);
left.close();
const right = new DatabaseSync(rightPath);
right.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT);
  CREATE TABLE recon_users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
  CREATE TABLE no_pk (value TEXT);
  CREATE TABLE dup_idx (id INTEGER PRIMARY KEY, a TEXT);
  CREATE INDEX idx_dup_1 ON dup_idx(a);
  CREATE INDEX idx_dup_2 ON dup_idx(a);
  INSERT INTO recon_users (id, name, email) VALUES
    (1, 'Ada', 'ada@example.com'),
    (2, 'Bobby', 'bob@example.com'),
    (3, 'Cid', 'cid@example.com'),
    (5, 'Eve', 'eve@example.com');
  INSERT INTO no_pk (value) VALUES ('x'), ('x');
`);
right.close();

const TOKEN = 'commands-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'commands-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const port = (gateway.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

const leftConn = gateway.store.createConnection({ name: 'Left SQLite', engine: 'sqlite', database: leftPath });
const rightConn = gateway.store.createConnection({ name: 'Right SQLite', engine: 'sqlite', database: rightPath });

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function streamRun(runId: string, after = 0): Promise<any[]> {
  // A replay fixture can spend seconds seeding SQLite; always use a fresh socket.
  const text = await new Promise<string>((resolve, reject) => {
    const req = request(`${base}/api/commands/runs/${runId}/events?after=${after}`, { headers, agent: false }, (res) => {
      assert.equal(res.statusCode, 200);
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data));
}

test('命令注册表可被桌面/移动端读取', async () => {
  const { status, body } = await api('/commands');
  assert.equal(status, 200);
  assert.ok(body.commands.some((command: any) => command.id === 'diff'));
  assert.ok(body.commands.some((command: any) => command.id === 'recon'));
  assert.ok(body.commands.every((command: any) => typeof command.title.zh === 'string'));
  const report = body.commands.find((command: any) => command.id === 'report');
  const slots = new Map<string, any>(report.slots.map((slot: any) => [slot.key, slot]));
  // 输出格式只列出真正能落盘的：PDF 走桌面端导出，不在命令里假装支持。
  assert.deepEqual(
    (slots.get('format') as any).options.map((option: any) => option.value),
    ['screen', 'xlsx', 'pptx'],
  );
  assert.deepEqual(
    (slots.get('audience') as any).options.map((option: any) => option.value),
    ['executive', 'business', 'technical'],
  );
});

test('/report 选择 Excel 时，运行成功后把文件真正落盘', async () => {
  const started = await api('/commands/report/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id, label: '左' }],
        topic: '本月订单概览',
        format: 'xlsx',
      },
    }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const succeeded = events.find((event) => event.type === 'step_succeeded');
  assert.match(succeeded.summary, /已导出 XLSX/);
  const path = /已导出 XLSX：(.+)$/.exec(succeeded.summary)?.[1] ?? '';
  assert.ok(path && existsSync(path), `导出文件不存在：${path}`);
  assert.match(path, /\.xlsx$/);
});

test('/diff 生成差异产物，并可通过 SSE 观察完成', async () => {
  const started = await api('/commands/diff/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id, label: '左' }, { connectionId: rightConn.id, label: '右' }],
        includeDrops: true,
      },
      saveAs: { title: '结构对比测试' },
    }),
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.run.command, 'diff');
  const runId = started.body.run.id;
  const events = await streamRun(runId);
  const finished = events.find((event) => event.type === 'run_finished');
  assert.equal(finished.status, 'succeeded');
  const ready = events.find((event) => event.type === 'artifact_ready');
  assert.equal(ready.artifactType, 'diff');

  const artifact = await api(`/artifacts/${ready.artifactId}`);
  assert.equal(artifact.status, 200);
  assert.equal(artifact.body.artifact.type, 'diff');
  assert.equal(artifact.body.artifact.title, '结构对比测试');

  const runs = await api(`/artifacts/${ready.artifactId}/runs`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.runs.length, 1);
  const result = runs.body.runs[0].result;
  assert.equal(result.sourceTables, 5);
  assert.equal(result.targetTables, 5);
  assert.ok(result.tables.some((table: any) => table.name === 'users' && table.status === 'changed'));
  assert.ok(result.tables.some((table: any) => table.name === 'orders' && table.status === 'added'));
  assert.ok(result.tables.some((table: any) => table.name === 'audit' && table.status === 'removed'));
  assert.ok(result.summary.statements > 0);
});

test('产物可重跑，并追加运行记录而不是新建产物', async () => {
  const list = await api('/artifacts?type=diff');
  const artifactId = list.body.artifacts[0].id;
  const started = await api(`/artifacts/${artifactId}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(started.status, 202);
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const runs = await api(`/artifacts/${artifactId}/runs`);
  assert.equal(runs.body.runs.length, 2);
});

test('源数量不合法时返回 INVALID_INPUT', async () => {
  const { status, body } = await api('/commands/diff/runs', {
    method: 'POST',
    body: JSON.stringify({ input: { sources: [{ connectionId: leftConn.id }] } }),
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_INPUT');
  assert.equal(body.error.field, 'sources');
});

test('/recon 做键级 / 字段级对账并生成修复命令', async () => {
  const started = await api('/commands/recon/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id, label: '左' }, { connectionId: rightConn.id, label: '右' }],
        level: 'fields',
        maxKeys: 100,
        mapping: {
          mode: 'table-table',
          left: { kind: 'table', connectionId: leftConn.id, table: 'recon_users', keyColumns: ['id'] },
          right: { kind: 'table', connectionId: rightConn.id, table: 'recon_users', keyColumns: ['id'] },
          fieldMap: [
            { left: 'name', right: 'name' },
            { left: 'email', right: 'email' },
          ],
          baseSide: 'left',
          maxKeys: 100,
        },
      },
      saveAs: { title: '用户对账测试' },
    }),
  });
  assert.equal(started.status, 202);
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const runs = await api(`/artifacts/${artifactId}/runs`);
  const result = runs.body.runs[0].result;
  assert.equal(result.summary.missingInRight, 1);
  assert.equal(result.summary.extraInRight, 1);
  assert.equal(result.summary.valueChanged, 1);
  assert.ok(result.target.differences.some((diff: any) => diff.key === '4' && diff.status === 'missing_in_right'));
  assert.ok(result.target.differences.some((diff: any) => diff.key === '5' && diff.status === 'extra_in_right'));
  assert.ok(result.target.differences.some((diff: any) => diff.key === '2' && diff.status === 'value_changed'));
  assert.ok(result.repair.some((sql: string) => sql.startsWith('INSERT INTO')));
  assert.ok(result.repair.some((sql: string) => sql.startsWith('UPDATE')));
  assert.ok(result.repair.some((sql: string) => sql.startsWith('DELETE FROM')));
});

test('/recon 在 counts 级别不要求主键，只返回数量', async () => {
  const started = await api('/commands/recon/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id }, { connectionId: rightConn.id }],
        level: 'counts',
        mapping: {
          mode: 'table-table',
          left: { kind: 'table', connectionId: leftConn.id, table: 'orders' },
          right: { kind: 'table', connectionId: rightConn.id, table: 'audit' },
        },
      },
    }),
  });
  assert.equal(started.status, 202);
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const runs = await api(`/artifacts/${artifactId}/runs`);
  const result = runs.body.runs[0].result;
  assert.equal(result.level, 'counts');
  assert.deepEqual(result.target.counts, { left: 0, right: 0 });
  assert.equal(result.repair.length, 0);
});

test('/recon 在键级对账且无主键时明确失败', async () => {
  const started = await api('/commands/recon/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id }, { connectionId: rightConn.id }],
        level: 'keys',
        mapping: {
          mode: 'table-table',
          left: { kind: 'table', connectionId: leftConn.id, table: 'no_pk' },
          right: { kind: 'table', connectionId: rightConn.id, table: 'no_pk' },
        },
      },
    }),
  });
  assert.equal(started.status, 202);
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'failed');
  const failed = events.find((event) => event.type === 'step_failed');
  assert.equal(failed.error.code, 'RECON_NO_KEY');
});

async function runReport(topic: string): Promise<any> {
  const started = await api('/commands/report/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id, label: '左' }, { connectionId: rightConn.id, label: '右' }],
        topic,
        format: 'screen',
      },
    }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const runs = await api(`/artifacts/${artifactId}/runs`);
  return runs.body.runs[0].result;
}

test('/report 生成确定性报告，按语义选择 sections / comparison', async () => {
  const sectionsReport = await runReport('分别看看两个库的数据情况');
  assert.equal(sectionsReport.layout, 'sections');
  assert.equal(sectionsReport.sources.length, 2);
  assert.ok(sectionsReport.sections.length >= 3);
  const overview = sectionsReport.sections[0];
  assert.equal(overview.id, 'overview');
  // 概览先给业务指标，规模指标单独成块；两者都在概览里。
  const metrics = overview.blocks.filter((block: any) => block.kind === 'metric').flatMap((block: any) => block.metrics);
  assert.ok(metrics.some((metric: any) => metric.label === '数据源' && metric.value === 2));
  assert.ok(overview.blocks.some((block: any) => block.kind === 'metric' && block.title === '数据规模'));
  assert.ok(sectionsReport.sections.some((section: any) => section.blocks.some((block: any) => block.kind === 'table')));
  // 时间窗由网关解析并写进元数据，报告读得出「统计的是哪一段」。
  assert.match(sectionsReport.meta.period.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(sectionsReport.meta.period.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof sectionsReport.executive.headline, 'string');
  assert.ok(sectionsReport.executive.headline.length > 0);
  assert.ok(Array.isArray(sectionsReport.executive.takeaways));
  assert.ok(sectionsReport.meta.assumptions.some((line: string) => /统计区间/.test(line)));

  const comparisonReport = await runReport('对比两个库的数据量');
  assert.equal(comparisonReport.layout, 'comparison');
  assert.ok(comparisonReport.sections.some((section: any) => section.id === 'comparison'));
  const compareBlock = comparisonReport.sections
    .flatMap((section: any) => section.blocks)
    .find((block: any) => block.kind === 'comparison');
  assert.ok(compareBlock.left.value >= 0);
  assert.ok(compareBlock.right.value >= 0);
  assert.ok(compareBlock.delta);

  const merged = await runReport('合并两个库的数据量');
  assert.equal(merged.layout, 'merged');
  assert.ok(merged.sections.some((section: any) => section.id === 'merged'));

  const mixed = await runReport('生成一份综合周报');
  assert.equal(mixed.layout, 'mixed');
  assert.ok(mixed.sections.length >= 3);
});

test('/compare 用同口径 SQL 计算差值与百分比', async () => {
  const started = await api('/commands/compare/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id, label: '左库' }, { connectionId: rightConn.id, label: '右库' }],
        metric: '订单量',
        leftLabel: '本周',
        rightLabel: '上周',
        queryA: 'SELECT 10 AS n',
        queryB: 'SELECT 15 AS n',
      },
    }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const runs = await api(`/artifacts/${artifactId}/runs`);
  const result = runs.body.runs[0].result;
  assert.equal(result.layout, 'comparison');
  const block = result.sections[0].blocks.find((item: any) => item.kind === 'comparison');
  assert.equal(block.left.value, 10);
  assert.equal(block.right.value, 15);
  assert.equal(block.delta.absolute, 5);
  assert.equal(block.delta.percent, 50);
});

test('/fix 体检发现无主键表，并生成修复计划（不自动执行）', async () => {
  const check = await api('/commands/fix/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id, label: '左库' }],
        mode: 'check',
      },
    }),
  });
  assert.equal(check.status, 202, JSON.stringify(check.body));
  const checkEvents = await streamRun(check.body.run.id);
  assert.equal(checkEvents.find((event) => event.type === 'run_finished').status, 'succeeded');
  const checkArtifact = checkEvents.find((event) => event.type === 'artifact_ready').artifactId;
  const checkRuns = await api(`/artifacts/${checkArtifact}/runs`);
  const checkResult = checkRuns.body.runs[0].result;
  assert.equal(checkResult.mode, 'check');
  assert.ok(checkResult.findings.some((finding: any) => finding.code === 'NO_PRIMARY_KEY' && finding.table === 'no_pk'));
  assert.equal(checkResult.plan.length, 0);

  const repair = await api('/commands/fix/runs', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sources: [{ connectionId: leftConn.id, label: '左库' }],
        mode: 'repair',
      },
    }),
  });
  assert.equal(repair.status, 202, JSON.stringify(repair.body));
  const repairEvents = await streamRun(repair.body.run.id);
  assert.equal(repairEvents.find((event) => event.type === 'run_finished').status, 'succeeded');
  const repairArtifact = repairEvents.find((event) => event.type === 'artifact_ready').artifactId;
  const repairRuns = await api(`/artifacts/${repairArtifact}/runs`);
  const repairResult = repairRuns.body.runs[0].result;
  assert.equal(repairResult.mode, 'repair');
  assert.ok(repairResult.plan.length > 0);
  assert.ok(repairResult.plan.every((step: any) => step.sql && step.risk));
  assert.match(repairResult.note, /不自动执行/);
});


test('报告产物可导出 XLSX 与中性 PPTX', async () => {
  const list = await api('/artifacts?type=report');
  assert.ok(list.body.artifacts.length > 0);
  const artifactId = list.body.artifacts[0].id;
  const xlsx = await api(`/artifacts/${artifactId}/export?format=xlsx`);
  assert.equal(xlsx.status, 200, JSON.stringify(xlsx.body));
  assert.ok(xlsx.body.bytes > 0);
  assert.ok(existsSync(xlsx.body.path));
  const pptx = await api(`/artifacts/${artifactId}/export?format=pptx`);
  assert.equal(pptx.status, 200, JSON.stringify(pptx.body));
  assert.ok(pptx.body.bytes > 0);
  assert.ok(existsSync(pptx.body.path));
  const head = readFileSync(pptx.body.path).subarray(0, 2).toString('latin1');
  assert.equal(head, 'PK');
});

test('产物支持定时刷新配置', async () => {
  const list = await api('/artifacts?type=report');
  const artifactId = list.body.artifacts[0].id;
  const created = await api(`/artifacts/${artifactId}/schedule`, {
    method: 'POST',
    body: JSON.stringify({ intervalSeconds: 3600 }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.schedule.intervalSeconds, 3600);
  const fetched = await api(`/artifacts/${artifactId}/schedule`);
  assert.equal(fetched.body.schedule.intervalSeconds, 3600);
  const deleted = await api(`/artifacts/${artifactId}/schedule`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  const after = await api(`/artifacts/${artifactId}/schedule`);
  assert.equal(after.body.schedule, null);
});


test('新增的 schema_diff / recon_data / transfer_data 全局工具可执行', async () => {
  const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());
  const ctx = { sessionId: 'tool-test', connectionId: leftConn.id };
  const diff = await executor.execute(
    { id: 't-diff', name: 'schema_diff', args: { sourceConnectionId: leftConn.id, targetConnectionId: rightConn.id } },
    ctx,
  );
  assert.equal(diff.ok, true, diff.error?.message);
  assert.ok((diff.data as any).tables.length >= 3);

  const recon = await executor.execute(
    {
      id: 't-recon',
      name: 'recon_data',
      args: {
        left: { kind: 'table', connectionId: leftConn.id, table: 'recon_users', keyColumns: ['id'] },
        right: { kind: 'table', connectionId: rightConn.id, table: 'recon_users', keyColumns: ['id'] },
        fieldMap: [{ left: 'name', right: 'name' }],
        level: 'counts',
      },
    },
    ctx,
  );
  assert.equal(recon.ok, true, recon.error?.message);
  assert.equal((recon.data as any).level, 'counts');

  await gateway.manager.query(leftConn.id, 'CREATE TABLE IF NOT EXISTS tool_transfer (id INTEGER PRIMARY KEY, name TEXT)', {
    database: leftConn.database,
    allowMulti: false,
    autoLimit: false,
    actor: 'user',
  });
  await gateway.manager.query(leftConn.id, "INSERT OR REPLACE INTO tool_transfer (id, name) VALUES (1, 'one'), (2, 'two')", {
    database: leftConn.database,
    allowMulti: false,
    autoLimit: false,
    actor: 'user',
  });
  const transfer = await executor.execute(
    {
      id: 't-transfer',
      name: 'transfer_data',
      args: { sourceConnectionId: leftConn.id, targetConnectionId: rightConn.id, tables: ['tool_transfer'], mode: 'replace' },
    },
    ctx,
  );
  assert.equal(transfer.ok, true, transfer.error?.message);
  const after = await gateway.manager.query(rightConn.id, 'SELECT COUNT(*) AS n FROM tool_transfer', {
    database: rightConn.database,
    allowMulti: false,
    autoLimit: false,
    actor: 'user',
  });
  assert.equal(Number(after.sets[0].rows[0][0]), 2);
});


test('/fix 在备份后执行修复计划', async () => {
  const started = await api('/commands/fix/runs', {
    method: 'POST',
    body: JSON.stringify({ input: { sources: [{ connectionId: leftConn.id }], mode: 'repair' } }),
  });
  assert.equal(started.status, 202);
  const events = await streamRun(started.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const runs = await api(`/artifacts/${artifactId}/runs`);
  const plan = runs.body.runs[0].result.plan;
  const dropIndexIndex = plan.findIndex((step: any) => /DROP INDEX/i.test(step.sql));
  assert.ok(dropIndexIndex >= 0, JSON.stringify(plan));

  const executed = await api(`/artifacts/${artifactId}/fix/execute`, {
    method: 'POST',
    body: JSON.stringify({ confirm: 'EXECUTE', backup: true, steps: [dropIndexIndex] }),
  });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.ok(executed.body.backupPath);
  assert.equal(executed.body.failed, 0);
  assert.ok(executed.body.executed > 0);
  assert.equal(executed.body.verification.ok, true);
  assert.match(executed.body.verification.summary, /体检完成/);
  const db = new DatabaseSync(leftPath, { readOnly: true } as unknown as ConstructorParameters<typeof DatabaseSync>[1]);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dup_idx'").all();
  db.close();
  assert.equal(indexes.length, 1);
});

test('定时调度器会重跑报告产物', async () => {
  const list = await api('/artifacts?type=report');
  const artifactId = list.body.artifacts[0].id;
  const before = (await api(`/artifacts/${artifactId}/runs`)).body.runs.length;
  await api(`/artifacts/${artifactId}/schedule`, { method: 'POST', body: JSON.stringify({ intervalSeconds: 60 }) });
  await gateway.scheduler.tick();
  const started = Date.now();
  let after = before;
  while (Date.now() - started < 8000) {
    after = (await api(`/artifacts/${artifactId}/runs`)).body.runs.length;
    if (after > before) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await api(`/artifacts/${artifactId}/schedule`, { method: 'DELETE' });
  assert.ok(after > before, `runs ${before} -> ${after}`);
});


test('/fix 在只读连接上拒绝执行计划', async () => {
  const readonly = gateway.store.createConnection({ name: 'Readonly SQLite', engine: 'sqlite', database: leftPath, readonly: true });
  const check = await api('/commands/fix/runs', {
    method: 'POST',
    body: JSON.stringify({ input: { sources: [{ connectionId: readonly.id }], mode: 'repair' } }),
  });
  assert.equal(check.status, 202);
  const events = await streamRun(check.body.run.id);
  assert.equal(events.find((event) => event.type === 'run_finished').status, 'succeeded');
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const executed = await api(`/artifacts/${artifactId}/fix/execute`, {
    method: 'POST',
    body: JSON.stringify({ confirm: 'EXECUTE', backup: true }),
  });
  assert.equal(executed.status, 403);
  assert.equal(executed.body.error.code, 'SOURCE_READONLY');
});

test('/fix dry-run 只返回计划，不执行也不要求备份', async () => {
  const started = await api('/commands/fix/runs', {
    method: 'POST',
    body: JSON.stringify({ input: { sources: [{ connectionId: leftConn.id }], mode: 'repair' } }),
  });
  const events = await streamRun(started.body.run.id);
  const artifactId = events.find((event) => event.type === 'artifact_ready').artifactId;
  const before = (await api(`/artifacts/${artifactId}/runs`)).body.runs.length;
  const preview = await api(`/artifacts/${artifactId}/fix/execute`, {
    method: 'POST',
    body: JSON.stringify({ confirm: 'EXECUTE', backup: false, dryRun: true }),
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.dryRun, true);
  assert.equal(preview.body.executed, 0);
  assert.ok(preview.body.results.length > 0);
  const after = (await api(`/artifacts/${artifactId}/runs`)).body.runs.length;
  assert.equal(after, before);
});


test('命令取消等底层 schema 退出后才落终态，且不补写成功审计', async () => {
  let release!: () => void;
  let bothStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  let schemaCalls = 0;
  const slowManager = {
    // 故意忽略 signal：取消不能假装让一个仍然运行的 Promise 立刻结束。
    schema: async () => {
      schemaCalls += 1;
      if (schemaCalls === 2) bothStarted();
      await gate;
      return [];
    },
  } as any;
  const runner = new CommandRunner(gateway.store, slowManager);
  const sources = [{ connectionId: leftConn.id }, { connectionId: rightConn.id }];
  const canceled = runner.start('diff', { sources });
  await started;
  let waiterSettled = false;
  const pending = runner.waitForRun(canceled.id).then((info) => {
    waiterSettled = true;
    return info;
  });
  assert.equal(runner.cancel(canceled.id), true);
  assert.equal(runner.cancel(canceled.id), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(waiterSettled, false);
  assert.equal(runner.get(canceled.id)?.status, 'running');
  assert.equal(gateway.store.getArtifactRun(canceled.id)?.status, 'running');

  release();
  await runner.waitForExecution(canceled.id);
  assert.equal((await pending)?.status, 'canceled');
  assert.equal(gateway.store.getArtifactRun(canceled.id)?.status, 'canceled');
  assert.equal(gateway.store.getArtifactRun(canceled.id)?.result, null);
  const events = runner.events(canceled.id);
  assert.equal(events.filter((event) => event.type === 'run_finished').length, 1);
  assert.equal(events.some((event) => event.type === 'step_succeeded' || event.type === 'artifact_ready'), false);
  const audits = gateway.store.listAudit({ limit: 1000 }).filter((entry) => entry.tool === 'command.diff' && (entry.meta as any)?.runId === canceled.id);
  assert.deepEqual(audits, [], '底层工作退出后也不能补写 command.diff 成功审计');
});

test('recon 取消信号贯通到 manager.query，底层退出前不落终态', async () => {
  let release!: () => void;
  let queryStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { queryStarted = resolve; });
  let queryCalls = 0;
  let querySignal: AbortSignal | undefined;
  const table = { name: 'recon_users', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] };
  const manager = {
    schema: async () => [{ name: 'main', tables: [table] }],
    query: async (_id: string, _sql: string, options: any) => {
      queryCalls += 1;
      querySignal = options.signal;
      if (queryCalls === 1) {
        queryStarted();
        await gate;
      }
      return { sets: [{ rows: [[1]], columns: [{ name: 'count', type: 'INTEGER' }] }] };
    },
  } as any;
  const runner = new CommandRunner(gateway.store, manager);
  const run = runner.start('recon', {
    sources: [{ connectionId: leftConn.id }, { connectionId: rightConn.id }],
    level: 'counts',
    mapping: {
      mode: 'table-table',
      left: { kind: 'table', connectionId: leftConn.id, table: 'recon_users' },
      right: { kind: 'table', connectionId: rightConn.id, table: 'recon_users' },
    },
  });
  await started;
  assert.equal(runner.cancel(run.id), true);
  assert.equal(querySignal?.aborted, true);
  assert.equal(runner.get(run.id)?.status, 'running');
  release();
  await runner.waitForExecution(run.id);
  assert.equal(runner.get(run.id)?.status, 'canceled');
  const audits = gateway.store.listAudit({ limit: 1000 }).filter((entry) => entry.tool === 'command.recon' && (entry.meta as any)?.runId === run.id);
  assert.deepEqual(audits, []);
});

test('queued run 只有在 execute 未启动时才能立即取消', async () => {
  let schemaCalls = 0;
  const runner = new CommandRunner(gateway.store, {
    schema: async () => { schemaCalls += 1; return []; },
  } as any);
  const run = runner.start('diff', { sources: [{ connectionId: leftConn.id }, { connectionId: rightConn.id }] });
  assert.equal(runner.cancel(run.id), true);
  assert.equal(runner.get(run.id)?.status, 'canceled');
  await runner.waitForExecution(run.id);
  assert.equal(schemaCalls, 0);
  assert.deepEqual(runner.events(run.id).map((event) => event.type), ['run_started', 'run_finished']);
  assert.equal(gateway.store.getArtifactRun(run.id)?.status, 'canceled');
});

test('导出期间取消不会发布成功事件或留下导出文件', async () => {
  const exportDir = join(home, 'cancel-export');
  mkdirSync(exportDir, { recursive: true });
  let runner!: CommandRunner;
  let runId = '';
  const originalUpdate = gateway.store.updateArtifactRun.bind(gateway.store);
  (gateway.store as any).updateArtifactRun = (id: string, patch: any) => {
    const updated = originalUpdate(id, patch);
    // executeStep 已完成、导出即将开始；此时持久 run 必须仍是非终态。
    if (id === runId && patch.status === 'running' && patch.result !== undefined) runner.cancel(runId);
    return updated;
  };
  try {
    runner = new CommandRunner(gateway.store, gateway.manager, undefined, undefined, exportDir);
    const run = runner.start('report', {
      sources: [{ connectionId: leftConn.id }],
      topic: '取消导出回归',
      format: 'xlsx',
    });
    runId = run.id;
    const finished = await runner.waitForRun(run.id);
    assert.equal(finished?.status, 'canceled');
    assert.equal(gateway.store.getArtifactRun(run.id)?.status, 'canceled');
    assert.equal(gateway.store.getArtifactRun(run.id)?.result, null);
    const events = runner.events(run.id);
    assert.equal(events.some((event) => event.type === 'step_succeeded' || event.type === 'artifact_ready'), false);
    assert.equal(events.some((event) => event.type === 'run_finished' && event.status === 'succeeded'), false);
    assert.deepEqual(readdirSync(exportDir), [], '取消的导出不能留下临时文件或已发布文件');
  } finally {
    (gateway.store as any).updateArtifactRun = originalUpdate;
  }
});

test('命令 SSE 在持久事件裁剪后先发送 replay_truncated 标记', async () => {
  const artifact = gateway.store.createArtifact({
    type: 'report', title: 'replay gap', spec: { version: 1, type: 'report', title: 'replay gap', command: 'report', sources: [], input: {} },
  });
  const run = gateway.store.addArtifactRun({ artifactId: artifact.id, status: 'running', input: {}, steps: [] });
  for (let seq = 1; seq <= 505; seq += 1) {
    gateway.store.appendCommandEvent(run.id, seq, { type: 'step_progress', runId: run.id, stepId: 'report', message: String(seq) } as any);
  }
  gateway.store.appendCommandEvent(run.id, 506, { type: 'run_finished', runId: run.id, status: 'succeeded', durationMs: 1 } as any);
  gateway.store.updateArtifactRun(run.id, { status: 'succeeded', finishedAt: new Date().toISOString() });
  const events = await streamRun(run.id);
  assert.equal(events[0]?.type, 'replay_truncated');
  assert.equal(events[0]?.runId, run.id);
  assert.equal(events[0]?.firstSeq, 7);
  assert.equal(events[0]?.lastSeq, 506);
  assert.equal(events.filter((event) => event.type === 'step_progress').length, 499);
  assert.equal(events.at(-1)?.type, 'run_finished');

  const contiguous = await streamRun(run.id, 6);
  assert.equal(contiguous[0]?.type, 'step_progress');
  assert.equal(contiguous.some((event) => event.type === 'replay_truncated'), false);
});

test('跑得久的运行不会被时长取消：慢到原来的上限之上也照样跑完', async () => {
  // 原来这里断言的是「timeoutMs: 40 到点自动 canceled」。那个总时长上限已经删掉
  // （见 runner.ts 顶部注释），这条测试改成钉住删掉之后的行为：比原来的上限还慢的运行，
  // 只要没人按取消，就必须正常跑完。
  let schemaCalls = 0;
  const slowManager = {
    schema: async () => {
      schemaCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return [];
    },
  } as any;
  const runner = new CommandRunner(gateway.store, slowManager);
  const sources = [{ connectionId: leftConn.id }, { connectionId: rightConn.id }];
  const run = runner.start('diff', { sources });
  // 轮询等到终态；总时长远超任何曾经存在过的秒级上限
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !['succeeded', 'failed', 'canceled'].includes(runner.get(run.id)?.status ?? '')) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const finished = runner.get(run.id);
  assert.notEqual(finished?.status, 'canceled', '没人按取消，运行不该是 canceled');
  assert.equal(finished?.status, 'succeeded', `运行没有跑完：${finished?.status}`);
  assert.ok(schemaCalls > 0);
  const events = runner.events(run.id);
  const finishedEvent = events.find((event) => event.type === 'run_finished');
  assert.equal(finishedEvent?.status, 'succeeded');
  assert.equal(
    events.some((event) => event.type === 'error' && event.code === 'COMMAND_TIMEOUT'),
    false,
    'COMMAND_TIMEOUT 这个原因码已经不存在了',
  );
});

test('运行时长这个概念已经从运行器里删掉了', async () => {
  const runnerModule = await import('../src/commands/runner.js');
  // StartCommandOptions 里不再有 timeoutMs：调用方无法再给一次运行设总时长
  type StartOptions = Parameters<CommandRunner['start']>[2];
  type HasKey<T, K extends string> = T extends unknown ? (K extends keyof T ? true : false) : false;
  const hasTimeout: HasKey<StartOptions, 'timeoutMs'> = false;
  assert.equal(hasTimeout, false);
  // 也不再导出任何调阈值的旋钮——没有阈值可调
  assert.equal((runnerModule as Record<string, unknown>).commandStallMs, undefined);
  assert.equal((runnerModule as Record<string, unknown>).COMMAND_STALL_MS, undefined);
});

