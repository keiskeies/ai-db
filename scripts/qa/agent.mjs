import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { api, check, fail, pass, record, saveReport, section, sse, truncate } from './lib.mjs';

const HOME = process.env.AIDB_HOME ?? join(homedir(), '.aidb');
const DEMO_FILE = join(HOME, 'demo', 'demo-retail.sqlite');
const MIRROR_FILE = join(HOME, 'demo', 'demo-retail-mirror.sqlite');
const SANDBOX_FILE = join(HOME, 'demo', 'qa-agent-sandbox.sqlite');
const REPORT = join(process.cwd(), 'docs', 'test-artifacts', 'agent.json');

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
  const existing = list.json.connections.find((c) => c.name === name && c.database === file);
  if (existing) return existing;
  const res = await api('POST', '/connections', { name, engine: 'sqlite', color: 'purple', environment: 'dev', groupName: 'QA 临时', database: file, readonly: false, note: 'QA Agent 业务测试临时连接，结束后删除。', ...extra });
  if (res.status !== 201) throw new Error(`创建连接失败 ${res.status}`);
  return res.json.connection;
}

async function createSession(connectionId, database, permissionMode = 'auto') {
  const res = await api('POST', '/agent/sessions', { connectionId, database, title: 'QA 业务测试', permissionMode });
  if (res.status !== 201) throw new Error(`创建会话失败 ${res.status}: ${res.text.slice(0, 200)}`);
  return res.json.session.id;
}

async function deleteSession(id) {
  if (id) await api('DELETE', `/agent/sessions/${id}`);
}

function summarizeTurn(events) {
  const toolCalls = events.filter((e) => e.type === 'tool_call');
  const toolResults = events.filter((e) => e.type === 'tool_result');
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  const done = events.find((e) => e.type === 'done');
  const error = events.find((e) => e.type === 'error');
  const aborted = events.find((e) => e.type === 'aborted');
  const usage = events.find((e) => e.type === 'usage');
  return {
    tools: toolCalls.map((e) => ({ tool: e.tool, args: e.args, risk: e.risk })),
    toolNames: toolCalls.map((e) => e.tool),
    results: toolResults.map((e) => ({ tool: e.tool, ok: e.result?.ok, summary: e.result?.summary, error: e.result?.error })),
    text,
    done,
    error,
    aborted,
    usage,
    chart: toolCalls.filter((e) => ['render_chart', 'forecast_chart'].includes(e.tool)).map((e) => ({ tool: e.tool, type: e.args?.type, x: e.args?.x, y: e.args?.y })),
  };
}

async function ask(sessionId, text, { timeoutMs = 240000, mode, approvals = 'allow' } = {}) {
  const events = await sse(`/agent/sessions/${sessionId}/turns`, { text, mode }, {
    timeoutMs,
    onEvent: async (event) => {
      if (event.type === 'approval_required' && approvals === 'allow') {
        await api('POST', `/agent/approvals/${event.approvalId}`, { decision: 'allow', scope: 'session' });
      }
    },
  });
  return { ...events, summary: summarizeTurn(events.events) };
}

async function runCase(cases, name, sessionFactory, prompt, validate, options = {}) {
  const sessionId = await sessionFactory();
  const started = Date.now();
  const res = await ask(sessionId, prompt, options);
  const s = res.summary;
  const elapsed = Date.now() - started;
  const outcome = {
    name,
    prompt,
    elapsed,
    tools: s.toolNames,
    chart: s.chart,
    text: s.text.slice(0, 1200),
    error: s.error ?? null,
    done: Boolean(s.done),
    toolErrors: s.results.filter((r) => r.ok === false),
    usage: s.usage ?? null,
  };
  cases.push(outcome);
  check(`${name}: turn finished`, s.done && !s.error, { error: s.error, aborted: s.aborted, elapsed, tools: s.toolNames });
  check(`${name}: used tools`, s.toolNames.length > 0 || /\/init/.test(prompt), { tools: s.toolNames, text: s.text.slice(0, 300) });
  check(`${name}: tool calls succeeded`, s.results.every((r) => r.ok !== false), { failures: s.results.filter((r) => r.ok === false), tools: s.toolNames });
  if (validate) {
    try {
      const out = validate(s, outcome);
      if (out !== true) record(`${name}: business expectation`, false, out ?? { tools: s.toolNames, chart: s.chart, text: s.text.slice(0, 500) });
      else pass(`${name}: business expectation`);
    } catch (err) {
      record(`${name}: business expectation`, false, `validator threw: ${err.message}`);
    }
  }
  console.log(`   → ${elapsed}ms · tools=${s.toolNames.join(',') || 'none'} · chart=${JSON.stringify(s.chart)} · error=${s.error?.code ?? 'none'}`);
  await deleteSession(sessionId);
  return s;
}

const sqlOf = (s) => s.tools.filter((t) => t.tool === 'run_sql' || t.tool === 'render_chart' || t.tool === 'forecast_chart' || t.tool === 'analyze_chart').map((t) => String(t.args?.sql ?? '')).join('\n');

async function main() {
  const startedAt = Date.now();
  const cases = [];
  const created = [];
  let sandbox;
  try {
    snapshot(DEMO_FILE, SANDBOX_FILE);
    const list = (await api('GET', '/connections')).json.connections;
    const demo = list.find((c) => c.name === 'Demo · 零售业务库');
    const mirror = list.find((c) => c.name === 'Demo2 · 零售镜像库');
    if (!demo || !mirror) throw new Error('demo connections missing');
    sandbox = await ensureConnection('QA · Agent 沙箱', SANDBOX_FILE);
    created.push(sandbox);
    const schema = (await api('GET', `/connections/${demo.id}/schema`)).json.schemas[0]?.name ?? 'main';
    const sessionFactory = async (mode = 'auto') => {
      const id = await createSession(demo.id, schema, mode);
      return id;
    };

    section('agent-business');
    await runCase(cases, '月度 GMV 趋势', () => sessionFactory(), '帮我看看最近半年每个月的成交金额（GMV）走势怎么样，用折线图展示。', (s) => {
      const sql = sqlOf(s);
      const lineChart = s.chart.some((c) => c.type === 'line');
      if (!/orders/.test(sql)) return { reason: 'SQL 未使用 orders 表', tools: s.toolNames, sql: sql.slice(0, 300) };
      if (!lineChart) return { reason: '未产出折线图', chart: s.chart, tools: s.toolNames, text: s.text.slice(0, 300) };
      return true;
    });

    await runCase(cases, '类目销售排行', () => sessionFactory(), '哪些商品类目卖得最好？给我销售额前 10 名的类目和销量，做成柱状图。', (s) => {
      const sql = sqlOf(s);
      const barChart = s.chart.some((c) => c.type === 'bar');
      if (!/order_items/.test(sql)) return { reason: 'SQL 未使用 order_items 明细表', sql: sql.slice(0, 300), tools: s.toolNames };
      if (!barChart) return { reason: '未产出柱状图', chart: s.chart, tools: s.toolNames, text: s.text.slice(0, 300) };
      return true;
    });

    await runCase(cases, '渠道退款率', () => sessionFactory(), '上个月各渠道的退款率是多少？按退款率从高到低排序，给我一张对比图。', (s) => {
      const sql = sqlOf(s);
      if (!/orders/.test(sql)) return { reason: 'SQL 未使用 orders', sql: sql.slice(0, 300) };
      if (!/refund|status/.test(sql)) return { reason: 'SQL 未涉及退款口径', sql: sql.slice(0, 300) };
      if (!s.text.includes('%') && !/退款率/.test(s.text)) return { reason: '答案未给出退款率数值', text: s.text.slice(0, 400) };
      return true;
    });

    await runCase(cases, '沉睡高价值会员', () => sessionFactory(), '帮我找出最近 90 天没有下单、但历史消费超过 5000 元的高价值会员，列出会员号、姓名、手机号和最近一次下单时间。', (s) => {
      const sql = sqlOf(s);
      if (!/customers/.test(sql)) return { reason: 'SQL 未使用 customers', sql: sql.slice(0, 300) };
      if (!/(orders|MAX\()/i.test(sql)) return { reason: 'SQL 未基于订单时间筛选', sql: sql.slice(0, 300) };
      return true;
    });

    await runCase(cases, '订单数据质量', () => sessionFactory(), '订单表里哪些字段有空值或者异常数据？帮我检查一下并给出清单。', (s) => {
      const expected = ['profile_column', 'check_data_quality', 'audit_database', 'run_sql'];
      if (!s.toolNames.some((t) => expected.includes(t))) return { reason: '未调用质量检查类工具', tools: s.toolNames };
      return true;
    });

    await runCase(cases, '两库结构差异', () => sessionFactory(), '对比零售业务库（Demo · 零售业务库）和镜像库（Demo2 · 零售镜像库）的订单表结构，告诉我有什么不同。', (s) => {
      const expected = ['schema_diff', 'inspect_schema'];
      if (!s.toolNames.some((t) => expected.includes(t))) return { reason: '未调用结构对比工具', tools: s.toolNames };
      const text = s.text;
      if (!/(orders|订单)/.test(text) && !s.toolNames.includes('schema_diff')) return { reason: '未覆盖订单表', text: text.slice(0, 400) };
      return true;
    });

    await runCase(cases, '订单行数对账', () => sessionFactory(), '订单表在业务库和镜像库里行数差多少？为什么会不一致，给我数据证据。', (s) => {
      const expected = ['recon_data', 'run_sql', 'analyze_chart'];
      if (!s.toolNames.some((t) => expected.includes(t))) return { reason: '未执行对账/统计查询', tools: s.toolNames };
      if (!/\d{3,}/.test(s.text)) return { reason: '答案没有具体行数', text: s.text.slice(0, 400) };
      return true;
    });

    await runCase(cases, '退款原因饼图', () => sessionFactory(), '退款的订单里，主要原因分布是什么？画个饼图。', (s) => {
      const pie = s.chart.some((c) => c.type === 'pie');
      if (!pie) return { reason: '未产出饼图', chart: s.chart, tools: s.toolNames, text: s.text.slice(0, 300) };
      return true;
    });

    await runCase(cases, '销售额预测', () => sessionFactory(), '根据最近三个月的每日成交金额，预测下个月每一天的销售额趋势。', (s) => {
      const forecast = s.toolNames.includes('forecast_chart');
      if (!forecast) return { reason: '未调用 forecast_chart', tools: s.toolNames };
      return true;
    });

    await runCase(cases, '城市客单价 SQL', () => sessionFactory(), '帮我统计每个城市的客单价，按客单价从高到低取前 10 名。', (s) => {
      const sql = sqlOf(s);
      if (!/customers|cities/.test(sql)) return { reason: 'SQL 未关联城市维度', sql: sql.slice(0, 300), tools: s.toolNames };
      if (!/AVG|SUM\s*\(\s*.*\)\s*\/|pay_cents/i.test(sql)) return { reason: 'SQL 未计算客单价', sql: sql.slice(0, 300) };
      return true;
    });

    await runCase(cases, '/chart 渠道占比', () => sessionFactory(), '/chart 各渠道的 GMV 占比', (s) => {
      if (!s.chart.length) return { reason: '未产出图表', tools: s.toolNames, text: s.text.slice(0, 300) };
      return true;
    });

    await runCase(cases, '/report 经营报告', () => sessionFactory(), '/report 生成一份上个月的经营分析报告，包含收入和订单趋势。', (s) => {
      if (!s.text || s.text.length < 40) return { reason: '报告内容过短', text: s.text.slice(0, 200), tools: s.toolNames };
      return true;
    });

    await runCase(cases, '/init 数据库说明', () => sessionFactory(), '/init', (s) => {
      if (!s.text || s.text.length < 20) return { reason: '/init 没有产出说明', text: s.text.slice(0, 200) };
      return true;
    }, { timeoutMs: 300000 });

    section('agent-write');
    const writeSession = await createSession(sandbox.id, 'main', 'auto');
    const write = await ask(writeSession, '在这个库里新建一张客户反馈表 customer_feedback，字段：id 自增主键、customer_id 整数、content 文本、rating 整数、created_at 文本。然后插入 3 条中文示例数据。', { timeoutMs: 300000 });
    const ws = write.summary;
    record('agent write: turn finished', ws.done && !ws.error, { error: ws.error, tools: ws.toolNames, text: ws.text.slice(0, 300) });
    const verify = await api('POST', '/query', { connectionId: sandbox.id, sql: 'SELECT COUNT(*) FROM customer_feedback' });
    record('agent write: table created with rows', verify.status === 200 && Number(verify.json?.batch?.sets?.[0]?.rows?.[0]?.[0]) >= 3, { status: verify.status, count: verify.json?.batch?.sets?.[0]?.rows?.[0]?.[0], error: verify.json?.error, tools: ws.toolNames });
    cases.push({ name: '写操作：建表并插入', prompt: '新建 customer_feedback 并插入 3 条示例', elapsed: 0, tools: ws.toolNames, chart: ws.chart, text: ws.text.slice(0, 1200), error: ws.error, done: Boolean(ws.done), toolErrors: ws.results.filter((r) => r.ok === false) });
    await deleteSession(writeSession);

    section('agent-approval');
    const approvalSession = await createSession(sandbox.id, 'main', 'ask');
    let approval = null;
    const approvalEvents = await sse(`/agent/sessions/${approvalSession}/turns`, { text: '把 customer_feedback 表里 rating 小于 3 的记录删掉。' }, {
      timeoutMs: 300000,
      onEvent: async (event) => {
        if (event.type === 'approval_required') {
          approval = event;
          await api('POST', `/agent/approvals/${event.approvalId}`, { decision: 'deny', scope: 'once' });
        }
      },
    });
    record('ask mode raises approval for destructive write', Boolean(approval), { events: [...new Set(approvalEvents.events.map((e) => e.type))], error: approvalEvents.events.find((e) => e.type === 'error') });
    if (approval) {
      const resolved = approvalEvents.events.find((e) => e.type === 'approval_resolved');
      record('approval deny resolved', resolved?.decision === 'deny', { resolved, events: [...new Set(approvalEvents.events.map((e) => e.type))] });
      const deniedResults = approvalEvents.events.filter((e) => e.type === 'tool_result' && e.result?.ok === false);
      record('denied action did not execute', deniedResults.length >= 1 || approvalEvents.events.some((e) => e.type === 'done'), { deniedResults: deniedResults.map((r) => r.result?.error) });
    }
    await deleteSession(approvalSession);

    section('agent-session-api');
    const session = await api('POST', '/agent/sessions', { connectionId: demo.id, database: schema, title: 'QA 会话管理' });
    record('session create', session.status === 201 && session.json.session.id, { status: session.status });
    if (session.json?.session?.id) {
      const sid = session.json.session.id;
      await expectPatch(sid);
      const messages = await api('GET', `/agent/sessions/${sid}`);
      record('session detail readable', messages.status === 200 && Array.isArray(messages.json.messages), { status: messages.status });
      await deleteSession(sid);
      const gone = await api('GET', `/agent/sessions/${sid}`);
      record('session delete', gone.status === 404, { status: gone.status });
    }
    const suggest = await api('GET', `/agent/suggest?connectionId=${demo.id}&database=${schema}`);
    record('agent suggestions', suggest.status === 200, { status: suggest.status, body: truncate(suggest.json) });
    const models = await api('POST', '/agent/models', { kind: 'openai', baseUrl: 'http://127.0.0.1:1994/v1' });
    record('agent model discovery', models.status === 200 && Array.isArray(models.json.models), { status: models.status, models: models.json?.models?.slice(0, 6), error: models.json?.error });

    async function expectPatch(sid) {
      const patch = await api('PATCH', `/agent/sessions/${sid}`, { title: 'QA 会话管理（已改名）', permissionMode: 'readonly' });
      record('session patch', patch.status === 200 && patch.json.session.title.includes('QA'), { status: patch.status, body: truncate(patch.json) });
    }

    /* ---------------- summary ---------------- */
    saveReport(REPORT, { model: 'openai/qwen3.8-flash-next', elapsedMs: Date.now() - startedAt, cases });
  } finally {
    for (const conn of created) await api('DELETE', `/connections/${conn.id}`);
    for (const suffix of ['', '-wal', '-shm']) rmSync(SANDBOX_FILE + suffix, { force: true });
    if (!existsSync(REPORT)) saveReport(REPORT, { elapsedMs: Date.now() - startedAt, cases });
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
