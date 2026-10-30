#!/usr/bin/env node
/**
 * 问数准确率对照实验（docs/08-agent-accuracy-plan.md §9）。
 *
 * 同一组业务问题跑两遍：A 组「未配置业务上下文」，B 组「配置了别名 / 描述 / 关系 / 术语」，
 * 对比 SQL 可执行率、表选择正确率与人工纠正需求。
 *
 * 全程只用 permissionMode=readonly，写操作会被 Agent 策略直接拒绝——
 * 对真实业务库（例如 local3306 的 media）也只读，不做任何变更。
 *
 * 用法：
 *   npm run bench -- --connection demo --questions scripts/bench/questions.demo.json --context scripts/bench/context.demo.json
 *   npm run bench -- --connection local3306 --database ziyou_mall_center --questions scripts/bench/questions.ziyou-mall.draft.json
 *   npm run bench -- --connection local3306 --questions scripts/bench/questions.media.json
 *   # 只校验题集/上下文与 schema 是否一致，不调用模型
 *   npm run bench -- --connection local3306 --database ziyou_mall_center \
 *     --questions scripts/bench/questions.ziyou-mall.json \
 *     --context scripts/bench/context.ziyou-mall.json --validate-only
 * 省略 --database 时使用连接默认库；会话与每轮执行都会带上同一个库。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tablesFromSql } from '@aidb/core';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const GATEWAY = arg('gateway', process.env.AIDB_GATEWAY ?? 'http://localhost:8787');
const TOKEN = arg('token', process.env.AIDB_TOKEN ?? 'dev-token');
const CONN = arg('connection', '');
const QUESTIONS_FILE = arg('questions', '');
const CONTEXT_FILE = arg('context', '');
const KEEP = hasFlag('keep');
const VALIDATE_ONLY = hasFlag('validate-only');
const FAIL_ON_REGRESSION = hasFlag('fail-on-regression');
const ARMS = arg('arms', 'ab');
const ONLY_B = ARMS === 'b';
const FOCUS = arg('focus', '');
const OUT = arg('out', '');
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

if (!CONN || !QUESTIONS_FILE) {
  console.error('必须提供 --connection 与 --questions。示例见文件头注释。');
  process.exit(2);
}

const api = async (path, init = {}) => {
  const res = await fetch(`${GATEWAY}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${typeof body === 'string' ? body : JSON.stringify(body?.error ?? body)}`);
  return body;
};

/** 开发期 gateway 可能因文件监听/重启短暂离线，等它回来再重试。 */
async function waitForGateway(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${GATEWAY}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** 跑一轮，把 SSE 流里的工具调用、SQL、成功与否与最终回答收集出来。 */
async function runTurn(sessionId, text, connectionId, database) {
  const res = await fetch(`${GATEWAY}/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, mode: 'readonly', connectionId, database }),
  });
  if (!res.ok || !res.body) throw new Error(`turn failed: ${res.status}`);
  const raw = await res.text();
  const events = [...raw.matchAll(/^data: (\{[\s\S]*?\})$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  const calls = [];
  const results = new Map();
  for (const ev of events) {
    if (ev.type === 'tool_call') calls.push({ tool: ev.tool, args: ev.args ?? {}, callId: ev.callId });
    if (ev.type === 'tool_result') results.set(ev.callId, ev.result);
  }
  const sqls = calls.map((c) => (typeof c.args.sql === 'string' ? c.args.sql : '')).filter(Boolean);
  const sqlResults = calls.filter((c) => typeof c.args.sql === 'string').map((c) => results.get(c.callId));
  const executed = sqlResults.filter((r) => r?.ok === true).length;
  const failed = sqlResults.filter((r) => r && r.ok === false);
  // 用 inspect_schema / sample_rows 正确答题也会一条 SQL 都不跑，不能因此判失败
  const failedTools = calls.filter((c) => results.get(c.callId)?.ok === false).map((c) => `${c.tool}: ${results.get(c.callId)?.error?.code ?? '?'}`);
  const errors = events.filter((e) => e.type === 'error').map((e) => `${e.code ?? '?'}: ${e.message ?? ''}`);
  const lastSqlOk = sqlResults.length ? Boolean(sqlResults.at(-1)?.ok) : null;
  return {
    text: events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''),
    tools: calls.map((c) => c.tool),
    sqls,
    sqlCount: sqls.length,
    executed,
    lastSqlOk,
    repaired: failed.length > 0 && lastSqlOk === true,
    failed: failed.map((f) => `${f.error?.code ?? '?'}: ${f.error?.message ?? ''}`),
    failedTools,
    errors,
    tables: [...new Set(sqls.flatMap((s) => tablesFromSql(s)))],
    tokensIn: events.filter((e) => e.type === 'usage').reduce((s, e) => s + (e.tokensIn ?? 0), 0),
    tokensOut: events.filter((e) => e.type === 'usage').reduce((s, e) => s + (e.tokensOut ?? 0), 0),
  };
}

const providerDown = (turn) =>
  turn.errors.some((e) => /PROVIDER_HTTP|queue is full|50[234]/.test(e)) ||
  (!turn.text.trim() && turn.tools.length === 0);

async function runArm(label, questions, connectionId, database) {
  const rows = [];
  for (const item of questions) {
    let turn = null;
    let lastError = '';
    let attempts = 0;
    for (attempts = 1; attempts <= 5; attempts += 1) {
      let session;
      process.stdout.write(`  [${label}]${attempts > 1 ? `(#${attempts})` : ''} ${item.q.slice(0, 42)}… `);
      try {
        const created = await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ connectionId, database, permissionMode: 'readonly' }) });
        session = created.session;
        turn = await runTurn(session.id, item.q, connectionId, database);
      } catch (err) {
        lastError = err.message;
        turn = null;
      } finally {
        if (session) await api(`/agent/sessions/${session.id}`, { method: 'DELETE' }).catch(() => undefined);
      }
      if (turn && !providerDown(turn)) break;
      lastError = turn?.errors.join('; ') || lastError || '空响应';
      console.log(`重试（${lastError}）`);
      if (/terminated|ECONNREFUSED|fetch failed|socket hang up/i.test(lastError)) {
        process.stdout.write('  等待 gateway 恢复… ');
        const healthy = await waitForGateway();
        console.log(healthy ? '已恢复' : '仍不可用');
      }
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempts));
    }
    if (!turn || providerDown(turn)) {
      console.log(`  → 放弃：${lastError}`);
      rows.push({ q: item.q, expectTables: item.expectTables ?? [], error: lastError, attempts });
      continue;
    }
    const expect = (item.expectTables ?? []).map((t) => t.toLowerCase());
    const hit = expect.filter((t) => turn.tables.includes(t));
    const extra = turn.tables.filter((t) => !expect.includes(t));
    // 答上了 = 有实质回答且没有任何工具调用失败；SQL 可执行率只在真的跑了 SQL 的题上算
    const answered = turn.text.trim().length > 0 && turn.failedTools.length === 0;
    const otherFailures = turn.failedTools.filter((tool) => !tool.startsWith('run_sql:'));
    const resolved = turn.text.trim().length > 0 && otherFailures.length === 0 && (turn.sqlCount === 0 || turn.lastSqlOk === true);
    const sqlExecutable = turn.sqlCount === 0 ? null : turn.failed.length === 0;
    const tablesOk = expect.length === 0 ? null : hit.length === expect.length && (item.allowExtraTables === true || extra.length === 0);
    const tablesHit = expect.length === 0 ? null : hit.length === expect.length;
    rows.push({ q: item.q, expectTables: expect, tables: turn.tables, hit, extra, sqlCount: turn.sqlCount, executed: turn.executed, failed: turn.failed, failedTools: turn.failedTools, errors: turn.errors, attempts, answered, resolved, repaired: turn.repaired, lastSqlOk: turn.lastSqlOk, sqlExecutable, tablesOk, tablesHit, tools: turn.tools, tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, answer: turn.text.slice(0, 200) });
    console.log(`${answered ? '答上' : resolved ? '已解决(修复)' : '未答上'} SQL ${turn.executed}/${turn.sqlCount}${turn.repaired ? ' 修复✓' : ''} tables=[${turn.tables.join(',')}] ${tablesOk === null ? '' : tablesOk ? '表✓' : '表✗'}`);
  }
  return rows;
}

function summarize(rows) {
  const scored = rows.filter((r) => !r.error);
  const withSql = scored.filter((r) => r.sqlCount > 0);
  const judged = scored.filter((r) => r.tablesOk !== null);
  return {
    total: rows.length,
    errored: rows.length - scored.length,
    producedSql: withSql.length,
    noSql: scored.length - withSql.length,
    // 「答上了」的分母是全部题目：没产出 SQL 但用 inspect/sample 答对，也算答上
    answered: scored.filter((r) => r.answered).length,
    answeredRate: scored.length ? scored.filter((r) => r.answered).length / scored.length : null,
    resolved: scored.filter((r) => r.resolved).length,
    resolvedRate: scored.length ? scored.filter((r) => r.resolved).length / scored.length : null,
    // SQL 可执行率只在真的跑了 SQL 的题上算，避免被「没用 SQL」稀释或美化
    sqlOk: withSql.filter((r) => r.sqlExecutable).length,
    sqlRate: withSql.length ? withSql.filter((r) => r.sqlExecutable).length / withSql.length : null,
    finalSqlOk: withSql.filter((r) => r.lastSqlOk).length,
    finalSqlRate: withSql.length ? withSql.filter((r) => r.lastSqlOk).length / withSql.length : null,
    repaired: scored.filter((r) => r.repaired).length,
    tablesJudged: judged.length,
    tablesCorrect: judged.filter((r) => r.tablesOk).length,
    tablesRate: judged.length ? judged.filter((r) => r.tablesOk).length / judged.length : null,
    tablesHit: judged.filter((r) => r.tablesHit).length,
    tablesHitRate: judged.length ? judged.filter((r) => r.tablesHit).length / judged.length : null,
    needsFixing: scored.filter((r) => !r.answered || r.tablesOk === false).length,
    tokens: scored.reduce((s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0),
  };
}

const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

// ---------- resolve target ----------
const { connections } = await api('/connections');
const conn = connections.find((c) => c.id === CONN || c.name.toLowerCase().includes(CONN.toLowerCase()));
if (!conn) {
  console.error(`找不到连接 "${CONN}"。可用：${connections.map((c) => c.name).join(' | ')}`);
  process.exit(2);
}
const database = arg('database', '') || conn.database || '';
console.log(`目标连接：${conn.name}（${conn.engine}${conn.host ? ` @ ${conn.host}:${conn.port ?? ''}` : ''} / ${database}）readonly=${conn.readonly} env=${conn.environment}`);
console.log(`所有回合固定 permissionMode=readonly：写与 DDL 会被 Agent 策略拒绝，目标库不会被改动。`);

const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));
if (!Array.isArray(questions) || !questions.length) { console.error('questions 文件必须是非空数组'); process.exit(2); }
const context = CONTEXT_FILE ? JSON.parse(readFileSync(CONTEXT_FILE, 'utf8')) : null;

// ---------- 只校验题集 / 上下文与真实 schema 是否对得上（不调用模型） ----------
if (VALIDATE_ONLY) {
  const { schemas } = await api(`/connections/${conn.id}/schema?database=${encodeURIComponent(database)}`);
  const tables = new Map((schemas ?? []).flatMap((s) => s.tables ?? []).map((t) => [t.name.toLowerCase(), t]));
  const columnsOf = (name) => new Set(((tables.get(name.toLowerCase())?.columns) ?? []).map((c) => c.name.toLowerCase()));
  const problems = [];
  const expected = new Set();
  for (const [index, item] of questions.entries()) {
    for (const name of item.expectTables ?? []) {
      expected.add(name);
      if (!tables.has(name.toLowerCase())) problems.push(`题 ${index + 1} 期望表不存在：${name}`);
    }
  }
  let contextTables = 0;
  let contextColumns = 0;
  if (context) {
    for (const name of Object.keys(context.tables ?? {})) {
      contextTables += 1;
      if (!tables.has(name.toLowerCase())) problems.push(`上下文表不存在：${name}`);
    }
    for (const key of Object.keys(context.columns ?? {})) {
      contextColumns += 1;
      const [table, column] = key.split('.');
      if (!tables.has(table?.toLowerCase())) problems.push(`上下文列的表不存在：${key}`);
      else if (!columnsOf(table).has(column?.toLowerCase())) problems.push(`上下文列不存在：${key}`);
    }
    for (const rel of context.relations ?? []) {
      if (!columnsOf(rel.table).has(rel.column?.toLowerCase())) problems.push(`关系源列不存在：${rel.table}.${rel.column}`);
      if (!columnsOf(rel.refTable).has(rel.refColumn?.toLowerCase())) problems.push(`关系目标列不存在：${rel.refTable}.${rel.refColumn}`);
    }
  }
  console.log(`schema=${tables.size} 表；题集引用=${expected.size} 表；上下文=${contextTables} 表 / ${contextColumns} 列 / ${context?.relations?.length ?? 0} 关系`);
  if (problems.length) {
    console.error(`VALIDATE FAIL（${problems.length}）`);
    for (const problem of problems) console.error('  - ' + problem);
    process.exitCode = 1;
  } else {
    console.log('VALIDATE OK：题集与上下文中的表、列、关系都能在真实 schema 中找到。');
  }
}

if (!VALIDATE_ONLY) {
const ctxQuery = `connectionId=${encodeURIComponent(conn.id)}&database=${encodeURIComponent(database)}`;

// 固定候选表检索开关：auto（默认）/ on / off。实验结束后恢复原值。
let originalFocus;
if (FOCUS) {
  const current = await api('/settings');
  originalFocus = current.settings.agent.schemaFocus ?? 'auto';
  await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { ...current.settings.agent, schemaFocus: FOCUS } }) });
  console.log(`schemaFocus=${FOCUS}（原值 ${originalFocus}）`);
}

await api(`/agent/context?${ctxQuery}`, { method: 'DELETE' }).catch(() => {});
let armA = [];
if (!ONLY_B) {
  const baseline = await api(`/agent/context?${ctxQuery}`);
  if (baseline.entries.length || baseline.active) {
    console.error('无法把业务上下文清空，A 组不干净，终止。');
    process.exit(1);
  }
  console.log(`\n=== A 组：无业务上下文（${questions.length} 题）===`);
  armA = await runArm('A', questions, conn.id, database);
} else {
  console.log(`\n=== B-only：跳过 A 组（${questions.length} 题，focus=${FOCUS || 'auto'}）===`);
}

// ---------- Arm B：配置业务上下文 ----------
let armB = null;
let memoryIds = [];
if (context) {
  for (const [table, meta] of Object.entries(context.tables ?? {})) {
    await api('/agent/context/entry', { method: 'PUT', body: JSON.stringify({ connectionId: conn.id, database, kind: 'table', table, alias: meta.alias, description: meta.description, enabled: meta.enabled ?? true }) });
  }
  for (const [key, meta] of Object.entries(context.columns ?? {})) {
    const [table, column] = key.split('.');
    await api('/agent/context/entry', { method: 'PUT', body: JSON.stringify({ connectionId: conn.id, database, kind: 'column', table, column, alias: meta.alias, description: meta.description }) });
  }
  for (const rel of context.relations ?? []) {
    await api('/agent/context/relation', { method: 'PUT', body: JSON.stringify({ connectionId: conn.id, database, ...rel }) });
  }
  for (const term of context.glossary ?? []) {
    const created = await api('/agent/memories', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, database, kind: 'glossary', title: term.title, content: term.content, importance: 0.9 }) });
    if (created?.memory?.id) memoryIds.push(created.memory.id);
  }
  for (const example of context.sqlExamples ?? []) {
    const created = await api('/agent/memories', { method: 'POST', body: JSON.stringify({ connectionId: conn.id, database, kind: 'sql_example', title: example.title, content: example.content, importance: 0.9 }) });
    if (created?.memory?.id) memoryIds.push(created.memory.id);
  }
  const applied = await api(`/agent/context?${ctxQuery}`);
  console.log(`\n=== B 组：已配置业务上下文（${applied.entries.length} 条覆盖，${memoryIds.length} 条术语/示例，active=${applied.active}）===`);
  armB = await runArm('B', questions, conn.id, database);
} else {
  console.log('\n（未提供 --context，跳过 B 组）');
}

// ---------- 还原：不要让实验残留改变用户后续的 Agent 行为 ----------
if (!KEEP) {
  await api(`/agent/context?${ctxQuery}`, { method: 'DELETE' }).catch(() => {});
  for (const id of memoryIds) await api(`/agent/memories/${id}`, { method: 'DELETE' }).catch(() => {});
  const after = await api(`/agent/context?${ctxQuery}`);
  console.log(`\n已还原：业务上下文 ${after.entries.length} 条，实验用记忆已删除 ${memoryIds.length} 条。`);
} else {
  console.log('\n--keep：保留本次配置的业务上下文与记忆。');
}
if (FOCUS) {
  const current = await api('/settings');
  await api('/settings', { method: 'PUT', body: JSON.stringify({ agent: { ...current.settings.agent, schemaFocus: originalFocus ?? 'auto' } }) });
  console.log(`已恢复 schemaFocus=${originalFocus ?? 'auto'}`);
}

// ---------- 报告 ----------
const sa = armA.length ? summarize(armA) : null;
const sb = armB ? summarize(armB) : null;
const line = (label, a, b) => `${label.padEnd(16)}${String(a).padStart(10)}${b === undefined ? '' : String(b).padStart(12)}`;
if (!sa) {
  console.log(`\n================ B-only 结果（focus=${FOCUS || 'auto'}） ================`);
  const rows = [
    ['题目数', sb?.total],
    ['答上率（严格）', pct(sb?.answeredRate ?? null)],
    ['答上率（含修复）', pct(sb?.resolvedRate ?? null)],
    ['SQL 首次可执行率', pct(sb?.sqlRate ?? null)],
    ['SQL 最终可执行率', pct(sb?.finalSqlRate ?? null)],
    ['自动修复成功', sb?.repaired],
    ['表选择（严格）', pct(sb?.tablesRate ?? null)],
    ['表命中（忽略多余）', pct(sb?.tablesHitRate ?? null)],
    ['需人工纠正', sb?.needsFixing],
    ['tokens 合计', sb?.tokens],
  ];
  for (const [label, value] of rows) console.log(`${String(label).padEnd(20)}${String(value ?? '—').padStart(12)}`);
} else {
console.log('\n================ 对照结果 ================');
console.log(line('指标', 'A 无上下文', sb ? 'B 有上下文' : undefined));
console.log(line('题目数', sa.total, sb?.total));
console.log(line('产出 SQL', sa.producedSql, sb?.producedSql));
console.log(line('未产出 SQL', sa.noSql, sb?.noSql));
console.log(line('答上率（严格）', pct(sa.answeredRate), sb ? pct(sb.answeredRate) : undefined));
console.log(line('答上率（含修复）', pct(sa.resolvedRate), sb ? pct(sb.resolvedRate) : undefined));
console.log(line('SQL 首次可执行率', pct(sa.sqlRate), sb ? pct(sb.sqlRate) : undefined));
console.log(line('SQL 最终可执行率', pct(sa.finalSqlRate), sb ? pct(sb.finalSqlRate) : undefined));
console.log(line('自动修复成功', sa.repaired, sb?.repaired));
console.log(line('表选择（严格）', pct(sa.tablesRate), sb ? pct(sb.tablesRate) : undefined));
console.log(line('表命中（忽略多余）', pct(sa.tablesHitRate), sb ? pct(sb.tablesHitRate) : undefined));
console.log(line('需人工纠正', sa.needsFixing, sb?.needsFixing));
console.log(line('tokens 合计', sa.tokens, sb?.tokens));
}

console.log('\n---- 逐题 ----');
for (let i = 0; i < questions.length; i++) {
  const a = armA[i];
  const b = armB?.[i];
  console.log(`\n${i + 1}. ${questions[i].q}`);
  if (questions[i].expectTables?.length) console.log(`   期望表: ${questions[i].expectTables.join(', ')}`);
  const fmt = (r) => (r.error ? `ERROR ${r.error}` : `${r.answered ? '答上' : '未答上'} SQL ${r.executed}/${r.sqlCount} 命中表=[${r.tables.join(',')}]${r.failedTools.length ? ` 失败工具=${r.failedTools.join(' | ')}` : ''}`);
  const flat = (text) => (text ?? '').replace(/\s+/g, ' ').slice(0, 150);
  if (a) {
    console.log(`   A: ${fmt(a)}`);
    // SQL 能跑不等于答得对：把回答摘要打出来，语义陷阱题的幻觉才看得见
    console.log(`   A 答: ${flat(a.answer)}`);
  }
  if (b) {
    console.log(`   B: ${fmt(b)}`);
    console.log(`   B 答: ${flat(b.answer)}`);
  }
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ focus: FOCUS || 'auto', arms: ARMS, summary: { a: sa, b: sb }, rows: { a: armA, b: armB } }, null, 2));
  console.log(`\n结果已写入 ${OUT}`);
}

if (sb && sa && FAIL_ON_REGRESSION) {
  const worse = (sb.answeredRate ?? 0) < (sa.answeredRate ?? 0) || (sb.tablesRate ?? 0) < (sa.tablesRate ?? 0);
  if (worse) {
    console.log('\nREGRESSION：B 组不优于 A 组。');
    process.exit(1);
  }
  console.log('\n无回归：B 组不劣于 A 组。');
}
console.log('\n提示：本题集若来自 schema 推导而非真实业务措辞，只能验证链路，不能当作 P1 验收结论。');
}
