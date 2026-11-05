import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ConnectionConfig, PipelineRunInfo, PipelineSpec } from '@aidb/core';
import { createGateway } from '../src/server';
import { Store } from '../src/store';
import { ToolExecutor } from '../src/executor';
import { listenRandom } from './helpers';

/**
 * 数据流处理的端到端验证：真实 HTTP 上游（带翻页与增量断点）→ map 清洗 →
 * 内置 DuckDB 聚合 → 写入 SQLite → 推送下游接口。走 REST，不碰内部函数，
 * 所以这条用例同时验证契约、路由、编排器与三类执行器。
 */

const home = mkdtempSync(join(tmpdir(), 'aidb-pipeline-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const TOKEN = 'pipeline-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'pipeline-secret',
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

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const SOURCE = [
  { id: 1, city: '上海', amt: 10, status: 'paid' },
  { id: 2, city: '上海', amt: 20, status: 'paid' },
  { id: 3, city: '北京', amt: 30, status: 'new' },
  { id: 4, city: '北京', amt: 5, status: 'paid' },
];

let pushed: unknown[][] = [];

/** 假上游：支持 page/page_size 翻页、since 增量、以及 /hook 收数据。 */
const upstream: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/orders') {
    const since = Number(url.searchParams.get('since') ?? 0);
    const list = SOURCE.filter((item) => item.id > since);
    const size = Number(url.searchParams.get('page_size') ?? 99);
    const page = Number(url.searchParams.get('page') ?? 1);
    const items = list.slice((page - 1) * size, page * size);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { items, total: list.length }, next_cursor: page * size < list.length ? String(page + 1) : null }));
    return;
  }
  if (url.pathname === '/hook' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      pushed.push(JSON.parse(body) as unknown[]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});
const upstreamPort = await listenRandom(upstream);
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

after(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

let demo: ConnectionConfig;

test('前置：拿到可写的 demo SQLite 连接', async () => {
  const boot = await api<{ connections: ConnectionConfig[] }>('/bootstrap');
  demo = boot.body.connections.find((item) => item.engine === 'sqlite')!;
  assert.ok(demo, 'demo 连接存在');
});

test('GET /pipelines/meta 暴露步骤目录与脚本开关', async () => {
  const meta = await api<{ steps: Array<{ type: string; role: string }>; scriptsEnabled: boolean; enabled: boolean }>('/pipelines/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.steps.length, 8);
  assert.deepEqual(meta.body.steps.map((step) => step.role), ['source', 'source', 'transform', 'transform', 'transform', 'transform', 'sink', 'sink']);
  assert.equal(meta.body.enabled, true);
  assert.equal(meta.body.scriptsEnabled, false, '脚本步骤默认关闭');
});

test('契约校验：非法 spec 逐条报问题，不保存半成品', async () => {
  const bad = await api('/pipelines', {
    method: 'POST',
    body: JSON.stringify({ name: '坏的', spec: { version: 1, steps: [{ id: 'a', type: 'map', with: {} }] } }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'PIPELINE_SPEC_INVALID');
  assert.match(bad.body.error.message, /第一步必须取数/);

  const empty = await api('/pipelines', { method: 'POST', body: JSON.stringify({ name: '空的', spec: { version: 1, steps: [] } }) });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error.message, /至少需要一个步骤/);
});

async function createPipeline(name: string, spec: PipelineSpec): Promise<string> {
  const created = await api<{ pipeline: { id: string } }>('/pipelines', { method: 'POST', body: JSON.stringify({ name, spec }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.pipeline.id;
}

test('接口取数 → 清洗 → DuckDB 聚合 → 写库 → 推送下游', async () => {
  const id = await createPipeline('订单汇总', {
    version: 1,
    params: [{ key: 'minAmt', default: 5 }],
    steps: [
      {
        id: 'pull',
        type: 'http.fetch',
        label: '拉订单',
        with: {
          url: `${upstreamBase}/orders`,
          method: 'GET',
          extract: '$.data.items',
          paginate: 'page',
          pageParam: 'page',
          sizeParam: 'page_size',
          pageSize: 2,
          maxPages: 5,
        },
      },
      { id: 'clean', type: 'map', with: { filter: "@.amt >= {{ params.minAmt }} && @.status == 'paid'", project: { id: '@.id', city: '@.city', amt: '@.amt' } } },
      { id: 'agg', type: 'sql', with: { sql: 'SELECT city, SUM(amt) AS amount, COUNT(*) AS orders FROM input GROUP BY city ORDER BY amount DESC' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_city_amount', mode: 'replace', createMissing: true } },
      { id: 'send', type: 'http.push', with: { url: `${upstreamBase}/hook`, batchRows: 5 } },
    ],
  });

  pushed = [];
  const run = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(run.status, 200);
  assert.equal(run.body.run.status, 'ok', JSON.stringify(run.body.run.steps));
  const steps = run.body.run.steps;
  assert.equal(steps[0].outRows, 4, '翻页把 4 条都取回来了');
  assert.equal(steps[0].meta?.pages, 3, '每页 2 条：两页取满后再探一页确认结束');
  assert.equal(steps[1].outRows, 3, 'amt>=5 且 paid 的剩 3 条（北京那条 new 被过滤掉）');
  assert.equal(steps[2].columns?.join(','), 'city,amount,orders');
  assert.equal(steps[2].outRows, 2);
  assert.equal(steps[2].sample?.[0].city, '上海', '上海 30 > 北京 5，按金额降序');
  assert.equal(Number(steps[2].sample?.[0].amount), 30);
  assert.equal(steps[3].meta?.written, 2);
  assert.equal(pushed.length, 1);
  assert.equal((pushed[0] as unknown[]).length, 2, '推给下游的是聚合后的两行');

  const verify = await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT city, amount FROM pipeline_city_amount ORDER BY amount DESC' }) });
  const rows = verify.body.batch.sets[0].rows as (string | number)[][];
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], '上海');
  assert.equal(Number(rows[0][1]), 30);
  assert.equal(Number(rows[1][1]), 5);

  const history = await api<{ runs: PipelineRunInfo[] }>(`/pipelines/${id}/runs`);
  assert.equal(history.body.runs.length, 1);
  assert.equal(history.body.runs[0].steps.length, 5);
  assert.ok(history.body.runs[0].durationMs! > 0);
});

test('增量断点：第二次只取新增，且不回填空批次', async () => {
  const id = await createPipeline('增量订单', {
    version: 1,
    steps: [
      { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items', stateField: 'id', stateParam: 'since' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_increment', mode: 'append', createMissing: true } },
    ],
  });
  const first = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(first.body.run.status, 'ok');
  assert.equal(first.body.run.steps[0].outRows, 4);
  assert.equal(first.body.run.steps[0].meta?.pages, 1, '不翻页时只请求一次');

  const second = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(second.body.run.status, 'ok');
  assert.equal(second.body.run.steps[0].outRows, 0, '比 id=4 更大的数据还没有，应该取到 0 行');
  assert.equal(second.body.run.steps[1].meta?.written, undefined, '空批次不写入，也就不会清空目标表');

  const pipelines = await api<{ pipelines: Array<{ id: string; state: Record<string, unknown> }> }>('/pipelines');
  const mine = pipelines.body.pipelines.find((item) => item.id === id)!;
  assert.equal(Number(mine.state.max), 4, '断点留在最大值 4');

  const count = await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) AS c FROM pipeline_increment' }) });
  assert.equal(Number(count.body.batch.sets[0].rows[0][0]), 4, '两次运行合计仍是 4 行，没有重复追加');

  const reset = await api(`/pipelines/${id}/state/reset`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(reset.status, 200);
  const afterReset = await api<{ pipelines: Array<{ id: string; state: Record<string, unknown> }> }>('/pipelines');
  assert.equal(Object.keys(afterReset.body.pipelines.find((item) => item.id === id)!.state).length, 0);
});

test('试运行：跑到第 2 步，目标端只渲染不执行', async () => {
  const id = await createPipeline('试运行', {
    version: 1,
    steps: [
      { id: 'pull', type: 'db.query', with: { connectionId: demo.id, sql: 'SELECT status, total_cents FROM orders LIMIT 40', maxRows: 40 } },
      { id: 'agg', type: 'sql', with: { sql: 'SELECT status, SUM(total_cents) AS amount FROM input GROUP BY status' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_trial_target', mode: 'replace', createMissing: true } },
    ],
  });
  const trial = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/trial`, { method: 'POST', body: JSON.stringify({ index: 1 }) });
  assert.equal(trial.status, 200);
  assert.equal(trial.body.run.status, 'ok');
  assert.equal(trial.body.run.steps.length, 2, '只跑到第 2 步');
  assert.ok((trial.body.run.steps[1].sample?.length ?? 0) > 0, '样本行给界面看');
  assert.equal(trial.body.run.steps[1].columns?.includes('amount'), true);

  const full = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/trial`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(full.body.run.steps[2].preview?.includes('INSERT INTO'), true, '写入步骤要能预览出 SQL');
  const check = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_trial_target'" }),
  });
  assert.equal((check.body.batch.sets[0].rows as unknown[]).length, 0, '试运行不能建表');

  const runs = await api<{ runs: PipelineRunInfo[] }>(`/pipelines/${id}/runs`);
  assert.equal(runs.body.runs.length, 0, '试运行不进历史');
});

test('按主键先删后插：同一主键重跑不产生重复', async () => {
  const id = await createPipeline('合并写入', {
    version: 1,
    steps: [
      { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_merged', mode: 'delete_insert', keyColumns: ['id'], createMissing: true } },
    ],
  });
  const first = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(first.body.run.status, 'ok');
  const second = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(second.body.run.status, 'ok');
  const count = await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) AS c FROM pipeline_merged' }) });
  assert.equal(Number(count.body.batch.sets[0].rows[0][0]), 4, '两次运行后仍是 4 行');
});

test('脚本步骤：未开启时拒绝执行，开启后按契约做纯数据变换', async () => {
  const spec: PipelineSpec = {
    version: 1,
    params: [{ key: 'tag', default: 'nightly' }],
    steps: [
      { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items' } },
      { id: 'js', type: 'script.js', with: { code: 'function transform(rows, ctx) {\n  return rows.map((row) => ({ ...row, tag: ctx.params.tag, doubled: row.amt * 2 }));\n}' } },
    ],
  };
  const id = await createPipeline('脚本加工', spec);
  const blocked = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.run.status, 'error', '脚本关闭时这一步要失败');
  assert.match(blocked.body.run.error ?? '', /脚本步骤未开启/);

  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, features: { ...settings.features, pipelineScripts: true } });
  const ran = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.run.status, 'ok', JSON.stringify(ran.body.run.steps));
  assert.equal(ran.body.run.steps[1].sample?.[0].tag, 'nightly');
  assert.equal(Number(ran.body.run.steps[1].sample?.[0].doubled), 20);

  const python = await api<{ python: { ok: boolean } }>('/pipelines/meta');
  if (python.body.python.ok) {
    const pyId = await createPipeline('Python 加工', {
      version: 1,
      steps: [
        { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items' } },
        { id: 'py', type: 'script.py', with: { code: 'def transform(rows, ctx):\n    return [{**row, "amt": row["amt"] * 1.1, "tag": ctx["params"]["tag"]} for row in rows]' } },
      ],
    });
    const pyRun = await api<{ run: PipelineRunInfo }>(`/pipelines/${pyId}/run`, { method: 'POST', body: JSON.stringify({ params: { tag: 'py' } }) });
    assert.equal(pyRun.body.run.status, 'ok', JSON.stringify(pyRun.body.run.steps));
    assert.equal(pyRun.body.run.steps[1].sample?.[0].tag, 'py');
    assert.equal(Number(pyRun.body.run.steps[1].sample?.[0].amt).toFixed(1), '11.0');
  }

  const restore = gateway.store.getSettings();
  gateway.store.saveSettings({ ...restore, features: { ...restore.features, pipelineScripts: false } });
});

test('脚本越界：没有定义 transform 时给出可读错误而不是空结果', async () => {
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, features: { ...settings.features, pipelineScripts: true } });
  try {
    const id = await createPipeline('坏脚本', {
      version: 1,
      steps: [
        { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items' } },
        { id: 'js', type: 'script.js', with: { code: 'const unused = 1;' } },
      ],
    });
    const ran = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(ran.status, 200);
    assert.equal(ran.body.run.status, 'error');
    assert.match(ran.body.run.error ?? '', /transform/);
  } finally {
    const restore = gateway.store.getSettings();
    gateway.store.saveSettings({ ...restore, features: { ...restore.features, pipelineScripts: false } });
  }
});

test('上游 5xx 失败要中断并写进运行历史，不能假装成功', async () => {
  const id = await createPipeline('会失败的', {
    version: 1,
    steps: [
      { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/missing`, extract: '$' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_never', createMissing: true } },
    ],
  });
  const ran = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.run.status, 'error');
  assert.match(ran.body.run.error ?? '', /404/);
  assert.equal(ran.body.run.steps[1].status, 'skipped');
  const runs = await api<{ runs: PipelineRunInfo[] }>(`/pipelines/${id}/runs`);
  assert.equal(runs.body.runs[0].status, 'error');
});

test('凭证：密钥只存 id，spec 里不出现明文', async () => {
  const created = await api<{ credential: { id: string; name: string } }>('/pipelines/credentials', {
    method: 'POST',
    body: JSON.stringify({ name: '测试 Bearer', kind: 'bearer', secret: { token: 'super-secret' } }),
  });
  assert.equal(created.status, 201);
  const listed = await api<{ credentials: Array<{ id: string; summary?: string }> }>('/pipelines/credentials');
  assert.equal(listed.body.credentials.some((item) => JSON.stringify(item).includes('super-secret')), false, '列表里不能带出密钥');

  const id = await createPipeline('带凭证', {
    version: 1,
    steps: [{ id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items', auth: 'bearer', credential: created.body.credential.id } }],
  });
  const ran = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(ran.body.run.status, 'ok', JSON.stringify(ran.body.run.steps));

  const stored = await api<{ pipelines: Array<{ id: string; spec: PipelineSpec }> }>('/pipelines');
  const specText = JSON.stringify(stored.body.pipelines.find((item) => item.id === id)!.spec);
  assert.equal(specText.includes('super-secret'), false, 'spec 只记 credential id');

  const missing = await createPipeline('指向不存在的凭证', {
    version: 1,
    steps: [{ id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, auth: 'bearer', credential: 'nope' } }],
  });
  const failed = await api<{ run: PipelineRunInfo }>(`/pipelines/${missing}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.match(failed.body.run.error ?? '', /凭证不存在/, '引用被删掉的凭证时不能静默匿名访问');

  assert.equal((await api(`/pipelines/credentials/${created.body.credential.id}`, { method: 'DELETE' })).status, 204);
});

test('自动化任务：一个任务按顺序跑选中的多条流水线', async () => {
  const a = await createPipeline('任务流水线A', {
    version: 1,
    steps: [
      { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_job_a', mode: 'replace', createMissing: true } },
    ],
  });
  const b = await createPipeline('任务流水线B', {
    version: 1,
    steps: [
      { id: 'pull', type: 'db.query', with: { connectionId: demo.id, sql: 'SELECT id FROM pipeline_job_a' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_job_b', mode: 'replace', createMissing: true } },
    ],
  });
  const broken = await createPipeline('任务流水线坏的', {
    version: 1,
    steps: [{ id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/nope`, extract: '$' } }],
  });

  const missing = await api('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: '没选流水线', connectionId: demo.id, type: 'pipeline', intervalSeconds: 3600 }),
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'PIPELINE_REQUIRED');
  assert.match(missing.body.error.message, /至少要选一条/);

  const created = await api<{ job: { id: string; type: string; payload?: { pipelineIds: string[] } } }>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: '夜间同步', connectionId: demo.id, type: 'pipeline', payload: { pipelineIds: [a, b] }, intervalSeconds: 3600 }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.job.type, 'pipeline');
  assert.deepEqual(created.body.job.payload?.pipelineIds, [a, b]);

  const ran = await api<{ ok: boolean; message: string }>(`/jobs/${created.body.job.id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.ok, true, ran.body.message);
  assert.match(ran.body.message, /2\/2 条成功/);
  const count = await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) AS c FROM pipeline_job_b' }) });
  assert.equal(Number(count.body.batch.sets[0].rows[0][0]), 4, 'B 依赖 A 建的表，顺序跑才有数据');

  // 一条坏的不应拖垮整批：给出 1/2 并把任务标失败，但好的那条照常写完。
  const mixed = await api<{ job: { id: string } }>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ name: '含失败项', connectionId: demo.id, type: 'pipeline', payload: { pipelineIds: [broken, a] }, intervalSeconds: 3600 }),
  });
  const mixedRun = await api<{ ok: boolean; message: string }>(`/jobs/${mixed.body.job.id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(mixedRun.body.ok, false);
  assert.match(mixedRun.body.message, /1\/2 条成功/);
  const jobs = await api<{ jobs: Array<{ id: string; type: string; lastStatus?: string; lastError?: string }> }>('/jobs');
  const mine = jobs.body.jobs.find((item) => item.id === mixed.body.job.id)!;
  assert.equal(mine.type, 'pipeline');
  assert.equal(mine.lastStatus, 'error');
  assert.match(mine.lastError ?? '', /404/);
  const stillThere = await api('/query', { method: 'POST', body: JSON.stringify({ connectionId: demo.id, sql: 'SELECT COUNT(*) AS c FROM pipeline_job_a' }) });
  assert.equal(Number(stillThere.body.batch.sets[0].rows[0][0]), 4, '坏的那条不影响后面的流水线');

  for (const id of [a, b, broken]) await api(`/pipelines/${id}`, { method: 'DELETE' });
  await api(`/jobs/${created.body.job.id}`, { method: 'DELETE' });
  await api(`/jobs/${mixed.body.job.id}`, { method: 'DELETE' });
});

test('v8 老库升级：重建 jobs 后旧任务保留，且能存 pipeline 类型与载荷', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-jobs-migrate-'));
  const dbPath = join(dir, 'legacy.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, connection_id TEXT NOT NULL, database_name TEXT,
    type TEXT NOT NULL CHECK (type IN ('query','backup')), sql TEXT,
    interval_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT, last_status TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.exec("INSERT INTO jobs (id,name,connection_id,type,sql,interval_seconds,enabled,created_at,updated_at) VALUES ('j-1','每小时统计','c-1','query','SELECT 1',3600,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  legacy.exec('PRAGMA user_version = 8');
  legacy.close();

  const store = new Store(dbPath, 'secret');
  try {
    const restored = store.getJob('j-1');
    assert.equal(restored?.name, '每小时统计');
    assert.equal(restored?.sql, 'SELECT 1', '重建表不能把 SQL 搬丢');
    assert.equal(restored?.type, 'query');

    const flow = store.createPipeline({ name: '迁移配套', spec: { version: 1, steps: [{ id: 'a', type: 'db.query', with: { connectionId: 'c-1', sql: 'SELECT 1' } }] } });
    const job = store.createJob({ name: '夜间数据流', connectionId: 'c-1', type: 'pipeline', payload: { pipelineIds: [flow.id] }, intervalSeconds: 3600 });
    assert.deepEqual(store.getJob(job.id)?.payload?.pipelineIds, [flow.id]);
    assert.equal(store.listJobs().length, 2, 'CHECK 已放开到 pipeline');

    store.deleteJob(job.id);
    store.deletePipeline(flow.id);
  } finally {
    store.close();
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(Number(check.prepare('PRAGMA user_version').get()!.user_version), 9, '迁移把版本推到 9');
    check.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent 工具 manage_pipeline：validate 拦坏 spec，dryRun 不写库，样本不外泄给模型', async () => {
  const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());
  const ctx = { sessionId: 'pipeline-tool', connectionId: demo.id } as Parameters<ToolExecutor['execute']>[1];
  const spec = {
    version: 1,
    steps: [
      { id: 'fetch', type: 'db.query', with: { connectionId: demo.id, sql: 'SELECT status, COUNT(*) AS n FROM orders GROUP BY status' } },
      { id: 'land', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_tool_stat', mode: 'replace', createMissing: true } },
    ],
  };

  const bad = await executor.execute({ id: 't-bad', name: 'manage_pipeline', args: { action: 'validate', spec: { version: 1, steps: [{ id: 'a', type: 'nope', with: {} }] } } }, ctx);
  assert.equal(bad.meta.state, 'failed');
  assert.match((bad.data as { issues: Array<{ message: string }> }).issues[0].message, /未知步骤类型/);

  const rejected = await executor.execute({ id: 't-create-bad', name: 'manage_pipeline', args: { action: 'create', name: '坏的', spec: { version: 1, steps: [{ id: 'm', type: 'map', with: {} }] } } }, ctx);
  assert.equal(rejected.ok, false, '第一步不取数的 spec 不能落库');
  assert.equal(rejected.error?.code, 'PIPELINE_SPEC_INVALID');

  const created = await executor.execute({ id: 't-create', name: 'manage_pipeline', args: { action: 'create', name: '工具建的数据流', spec } }, ctx);
  assert.equal(created.ok, true, created.error?.message);
  const id = String((created.data as { id: string }).id);

  const dry = await executor.execute({ id: 't-dry', name: 'manage_pipeline', args: { action: 'run', id, dryRun: true } }, ctx);
  assert.equal(dry.ok, true, dry.error?.message);
  const drySteps = (dry.data as { steps: Array<{ status: string; preview?: string; sample?: unknown }> }).steps;
  assert.equal(drySteps[1].status, 'ok');
  assert.match(drySteps[1].preview ?? '', /INSERT INTO/);
  assert.equal(drySteps[0].sample, undefined, '样本行不进工具结果，白烧 token');
  const probe = await gateway.manager.query(demo.id, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_tool_stat'", { actor: 'user' });
  assert.equal(probe.sets[0].rows.length, 0, 'dryRun 不能建表');

  const real = await executor.execute({ id: 't-run', name: 'manage_pipeline', args: { action: 'run', id } }, ctx);
  assert.equal(real.meta.state, 'ok', JSON.stringify((real.data as { steps: unknown[] }).steps));
  assert.equal(real.meta.rowsAffected, 4);
  const counted = await gateway.manager.query(demo.id, 'SELECT COUNT(*) AS c FROM pipeline_tool_stat', { actor: 'user' });
  assert.equal(Number(counted.sets[0].rows[0][0]), 4);

  const listed = await executor.execute({ id: 't-list', name: 'manage_pipeline', args: { action: 'list' } }, ctx);
  assert.ok((listed.data as { pipelines: Array<{ id: string }> }).pipelines.some((item) => item.id === id));

  const byName = await executor.execute({ id: 't-name', name: 'manage_pipeline', args: { action: 'run', name: '工具建的数据流' } }, ctx);
  assert.equal(byName.ok, true, byName.error?.message ?? '模型只记得名字时也要能找到');

  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, features: { ...settings.features, pipelines: false } });
  try {
    const blocked = await executor.execute({ id: 't-blocked', name: 'manage_pipeline', args: { action: 'list' } }, ctx);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, 'FEATURE_DISABLED');
  } finally {
    const restore = gateway.store.getSettings();
    gateway.store.saveSettings({ ...restore, features: { ...restore.features, pipelines: true } });
  }

  const deleted = await executor.execute({ id: 't-del', name: 'manage_pipeline', args: { action: 'delete', id } }, ctx);
  assert.equal(deleted.ok, true);
  assert.equal(gateway.store.getPipeline(id), undefined);
});

test('主键列不在写入列里：建表前就失败，不留半张表', async () => {
  const id = await createPipeline('主键对不上', {
    version: 1,
    steps: [
      { id: 'fetch', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_bad_key', mode: 'delete_insert', keyColumns: ['dt'], createMissing: true } },
    ],
  });
  const first = await api<{ run: PipelineRunInfo }>(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(first.body.run.status, 'error');
  assert.match(first.body.run.error ?? '', /主键列不在要写入的数据里：dt/);
  const check = await api('/query', {
    method: 'POST',
    body: JSON.stringify({ connectionId: demo.id, sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_bad_key'" }),
  });
  assert.equal((check.body.batch.sets[0].rows as unknown[]).length, 0, '不该建出一张缺主键的表');
});

test('删除流水线连同历史一起清掉', async () => {
  const id = await createPipeline('待删除', {
    version: 1,
    steps: [
      { id: 'pull', type: 'http.fetch', with: { url: `${upstreamBase}/orders`, extract: '$.data.items' } },
      { id: 'save', type: 'db.write', with: { connectionId: demo.id, table: 'pipeline_dropped', createMissing: true } },
    ],
  });
  await api(`/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal((await api<{ runs: unknown[] }>(`/pipelines/${id}/runs`)).body.runs.length, 1);
  assert.equal((await api(`/pipelines/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api<{ runs: unknown[] }>(`/pipelines/${id}/runs`)).status, 404);
});
