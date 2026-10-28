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
 *   npm run bench -- --connection local3306 --questions scripts/bench/questions.media.json
 */
import { readFileSync } from 'node:fs';
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
const FAIL_ON_REGRESSION = hasFlag('fail-on-regression');
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

/** 跑一轮，把 SSE 流里的工具调用、SQL、成功与否与最终回答收集出来。 */
async function runTurn(sessionId, text, connectionId) {
  const res = await fetch(`${GATEWAY}/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, mode: 'readonly', connectionId }),
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
  return {
    text: events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''),
    tools: calls.map((c) => c.tool),
    sqls,
    sqlCount: sqls.length,
    executed,
    failed: failed.map((f) => `${f.error?.code ?? '?'}: ${f.error?.message ?? ''}`),
    failedTools,
    tables: [...new Set(sqls.flatMap((s) => tablesFromSql(s)))],
    tokensIn: events.filter((e) => e.type === 'usage').reduce((s, e) => s + (e.tokensIn ?? 0), 0),
    tokensOut: events.filter((e) => e.type === 'usage').reduce((s, e) => s + (e.tokensOut ?? 0), 0),
  };
}

async function runArm(label, questions, connectionId) {
  const rows = [];
  for (const item of questions) {
    const { session } = await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ connectionId, permissionMode: 'readonly' }) });
    process.stdout.write(`  [${label}] ${item.q.slice(0, 42)}… `);
    let turn;
    try {
      turn = await runTurn(session.id, item.q, connectionId);
    } catch (err) {
      console.log(`ERROR ${err.message}`);
      rows.push({ q: item.q, expectTables: item.expectTables ?? [], error: err.message });
      continue;
    }
    const expect = (item.expectTables ?? []).map((t) => t.toLowerCase());
    const hit = expect.filter((t) => turn.tables.includes(t));
    const extra = turn.tables.filter((t) => !expect.includes(t));
    // 答上了 = 有实质回答且没有任何工具调用失败；SQL 可执行率只在真的跑了 SQL 的题上算
    const answered = turn.text.trim().length > 0 && turn.failedTools.length === 0;
    const sqlExecutable = turn.sqlCount === 0 ? null : turn.failed.length === 0;
    const tablesOk = expect.length === 0 ? null : hit.length === expect.length && (item.allowExtraTables === true || extra.length === 0);
    rows.push({ q: item.q, expectTables: expect, tables: turn.tables, hit, extra, sqlCount: turn.sqlCount, executed: turn.executed, failed: turn.failed, failedTools: turn.failedTools, answered, sqlExecutable, tablesOk, tools: turn.tools, tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, answer: turn.text.slice(0, 200) });
    console.log(`${answered ? '答上' : '未答上'} SQL ${turn.executed}/${turn.sqlCount} tables=[${turn.tables.join(',')}] ${tablesOk === null ? '' : tablesOk ? '表✓' : '表✗'}`);
    await api(`/agent/sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
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
    // SQL 可执行率只在真的跑了 SQL 的题上算，避免被「没用 SQL」稀释或美化
    sqlOk: withSql.filter((r) => r.sqlExecutable).length,
    sqlRate: withSql.length ? withSql.filter((r) => r.sqlExecutable).length / withSql.length : null,
    tablesJudged: judged.length,
    tablesCorrect: judged.filter((r) => r.tablesOk).length,
    tablesRate: judged.length ? judged.filter((r) => r.tablesOk).length / judged.length : null,
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
const database = conn.database ?? '';
console.log(`目标连接：${conn.name}（${conn.engine}${conn.host ? ` @ ${conn.host}:${conn.port ?? ''}` : ''} / ${database}）readonly=${conn.readonly} env=${conn.environment}`);
console.log(`所有回合固定 permissionMode=readonly：写与 DDL 会被 Agent 策略拒绝，目标库不会被改动。`);

const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));
if (!Array.isArray(questions) || !questions.length) { console.error('questions 文件必须是非空数组'); process.exit(2); }
const context = CONTEXT_FILE ? JSON.parse(readFileSync(CONTEXT_FILE, 'utf8')) : null;
const ctxQuery = `connectionId=${encodeURIComponent(conn.id)}&database=${encodeURIComponent(database)}`;

// ---------- Arm A：未配置业务上下文 ----------
await api(`/agent/context?${ctxQuery}`, { method: 'DELETE' }).catch(() => {});
const baseline = await api(`/agent/context?${ctxQuery}`);
if (baseline.entries.length || baseline.active) {
  console.error('无法把业务上下文清空，A 组不干净，终止。');
  process.exit(1);
}
console.log(`\n=== A 组：无业务上下文（${questions.length} 题）===`);
const armA = await runArm('A', questions, conn.id);

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
  armB = await runArm('B', questions, conn.id);
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

// ---------- 报告 ----------
const sa = summarize(armA);
const sb = armB ? summarize(armB) : null;
const line = (label, a, b) => `${label.padEnd(16)}${String(a).padStart(10)}${b === undefined ? '' : String(b).padStart(12)}`;
console.log('\n================ 对照结果 ================');
console.log(line('指标', 'A 无上下文', sb ? 'B 有上下文' : undefined));
console.log(line('题目数', sa.total, sb?.total));
console.log(line('产出 SQL', sa.producedSql, sb?.producedSql));
console.log(line('未产出 SQL', sa.noSql, sb?.noSql));
console.log(line('答上率', pct(sa.answeredRate), sb ? pct(sb.answeredRate) : undefined));
console.log(line('SQL 可执行率', pct(sa.sqlRate), sb ? pct(sb.sqlRate) : undefined));
console.log(line('表选择正确率', pct(sa.tablesRate), sb ? pct(sb.tablesRate) : undefined));
console.log(line('需人工纠正', sa.needsFixing, sb?.needsFixing));
console.log(line('tokens 合计', sa.tokens, sb?.tokens));

console.log('\n---- 逐题 ----');
for (let i = 0; i < questions.length; i++) {
  const a = armA[i];
  const b = armB?.[i];
  console.log(`\n${i + 1}. ${questions[i].q}`);
  if (questions[i].expectTables?.length) console.log(`   期望表: ${questions[i].expectTables.join(', ')}`);
  const fmt = (r) => (r.error ? `ERROR ${r.error}` : `${r.answered ? '答上' : '未答上'} SQL ${r.executed}/${r.sqlCount} 命中表=[${r.tables.join(',')}]${r.failedTools.length ? ` 失败工具=${r.failedTools.join(' | ')}` : ''}`);
  const flat = (text) => (text ?? '').replace(/\s+/g, ' ').slice(0, 150);
  console.log(`   A: ${fmt(a)}`);
  // SQL 能跑不等于答得对：把回答摘要打出来，语义陷阱题的幻觉才看得见
  console.log(`   A 答: ${flat(a.answer)}`);
  if (b) {
    console.log(`   B: ${fmt(b)}`);
    console.log(`   B 答: ${flat(b.answer)}`);
  }
}

if (sb && FAIL_ON_REGRESSION) {
  const worse = (sb.answeredRate ?? 0) < (sa.answeredRate ?? 0) || (sb.tablesRate ?? 0) < (sa.tablesRate ?? 0);
  if (worse) {
    console.log('\nREGRESSION：B 组不优于 A 组。');
    process.exit(1);
  }
  console.log('\n无回归：B 组不劣于 A 组。');
}
console.log('\n提示：本题集若来自 schema 推导而非真实业务措辞，只能验证链路，不能当作 P1 验收结论。');
