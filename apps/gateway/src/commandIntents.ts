/**
 * 斜杠命令是“目的信号”，不是 shell 子命令。
 * 这些提示只约束目标、工具选择和交付形态，不要求用户补参数、写 SQL 或打开表单。
 */

export interface CommandIntent {
  id: string;
  defaultTask: string;
  instruction: string;
}

const COMMON = `The user may not know SQL or the schema. Do not ask them to write SQL, pick tools, fill forms, or provide connection ids that already exist in context. Infer the target from their words, the current connection/database, attached tables, schema, memories and recent conversation. If a required target truly cannot be inferred, ask ONE short question in chat — never open a form. For a second source, list_connections is allowed: use its exact id, never a database name or file path as the id. Use tools for every query and number; never invent schema or values.`;

export const COMMAND_INTENTS: Record<string, CommandIntent> = {
  compare: {
    id: 'compare',
    defaultTask: '对比当前库中最值得关注的两种数据（根据当前表和对话自行判断，例如最近两个时间段、两个分组、两个查询或两个连接）；如果没有足够信息，先问一个简短问题。',
    instruction: `## Command mode: /compare — data comparison

${COMMON}

Goal: the user wants to understand DIFFERENCES, not read a SQL tutorial.
Workflow:
1. Identify the two sides: time periods, segments, two queries, or two connections/databases. If only one side is named, infer the natural baseline from the session/schema; otherwise ask one short question.
2. Use the same metric definition/filters on both sides. Prefer one aggregate SQL that returns A, B, Δ and Δ% (or run each side and a third calculation query) so the delta comes from a tool result, not mental arithmetic.
3. If the two sides are different engines/sources and the question is data consistency (e.g. MySQL vs Redis), call recon_data and show mismatched keys/fields instead of pretending a JOIN is possible.

Deliver:
- A compact comparison table: metric | A | B | Δ | Δ% (or matched/missing/extra/different counts for consistency).
- A grouped bar chart via render_chart type=bar with ys when the numbers are comparable; use pie only for one total's composition, never to compare periods.
- 2–4 findings naming the biggest differences, plus the metric definition/caveat.
No form, no asking the user to choose columns unless the ambiguity is real.`,
  },
  diff: {
    id: 'diff',
    defaultTask: '对比当前连接/库与另一个可用连接/库的结构差异；如果无法确定对比对象，先问一个简短问题。',
    instruction: `## Command mode: /diff — schema structure difference

${COMMON}

Goal: explain what differs structurally between two databases, and what it takes to align them.
Workflow:
1. Identify source and target connections/databases from the conversation. Call list_connections if you need the available ids; infer the most plausible pair.
2. Call schema_diff with the exact ids. Limit to named tables when the user names them; otherwise report the overall diff. If the user means two tables inside the SAME database, inspect both schemas and compare columns/indexes directly instead of fabricating a second connection.
3. Separate added / removed / changed tables, then columns, indexes and foreign keys.

Deliver:
- Summary counts and a table of changed objects.
- Destructive changes called out explicitly (drops, type narrowing, data loss risk).
- Target-dialect DDL for alignment, clearly marked as a proposal; do not execute DDL unless the user explicitly asks and approval permits it.
Do not pretend a non-relational engine has SQL schema diff; explain the limitation and use object-level comparison instead.`,
  },
  recon: {
    id: 'recon',
    defaultTask: '对当前库与另一个可用数据源做一致性对账，找出不一致的键与字段；如果无法确定对端，先问一个简短问题。',
    instruction: `## Command mode: /recon — cross-source data reconciliation

${COMMON}

Goal: find where two sources disagree, at row/key/field level, and show evidence — not just totals.
Workflow:
1. Identify left and right sources: SQL table, Redis keyspace, Mongo/ES documents. Call list_connections if needed.
2. Infer the key mapping from foreign keys, id patterns, names and user wording; state the mapping/assumptions. If a key genuinely cannot be inferred, ask one short question.
3. Call recon_data with the mapping. Use a bounded sample/limit for large sources.

Deliver:
- Counts: matched, different, missing-left, missing-right.
- Concrete mismatches: key, left value, right value, and which fields differ (bounded, e.g. first 20 rows), plus the total count.
- Separate "same" from "different" explicitly; do not claim consistency when there are missing keys.
- Never fabricate rows or compute totals by hand; quote recon_data output.
Offer repair suggestions only after showing the evidence.`,
  },
  fix: {
    id: 'fix',
    defaultTask: '对当前库做一次健康检查，找出可修复的问题并给出可执行修复 SQL，不要自动改库。',
    instruction: `## Command mode: /fix — database health check and repair plan

${COMMON}

Goal: find real problems, explain the blast radius, and give exact repair SQL — not generic best practices.
Workflow:
1. Run audit_database and/or check_data_quality on the current connection/database. If the user names a table, focus there; otherwise inspect the schema and prioritize the core tables.
2. For each finding, show severity, concrete evidence (counts/ratios/sample SQL) and an executable repair statement.
3. Do not execute writes automatically. If the user explicitly asks to apply a fix, state the blast radius, take a backup where supported, and rely on the approval mechanism; verify afterwards with a query.
4. If there are no findings, say so plainly instead of inventing work.

Deliver a short findings table (severity | problem | evidence | repair SQL), ordered by risk, then the verification SQL.`,
  },
  report: {
    id: 'report',
    defaultTask: '围绕当前库生成一份数据报告；如果用户没有给主题，就做整体数据概览。',
    instruction: `## Command mode: /report — data report for a business reader

${COMMON}

Goal: the user wants something they can send to their boss. Deliver a decision-ready report, not a wall of SQL and not a database inventory.
The system prompt already carries the resolved statistical window (本期 / 基线 / 今天). Query exactly that window; if the user names a different period, follow the user and say which dates you used.

Workflow:
1. Infer the topic and audience from the user's words and session context. If a topic is genuinely absent, produce a useful overview of the current database rather than asking for a form.
2. Inspect the schema, then gather numbers with bounded aggregate SQL. Every metric needs its previous-period (or year-over-year) value from the same filters — run the baseline query, do not do the subtraction by hand.
3. Pick charts by data shape — do not default to bar. Use line for ordered trends, bar for category comparison, stacked for parts of a total across an ordered axis, pie for one whole with 3–8 non-negative slices, heatmap for one measure across two categorical dimensions (e.g. weekday × hour), radar for 3–8 same-unit metrics of one record, and scatter for correlation between two numeric columns. A report may mix types across sections; if no type fits, skip the chart. Use run_sql/analyze_chart for exploration; call render_chart only for a chart that belongs in the final answer — every rendered chart stays in the transcript, so do not render a draft and then a near-duplicate final chart. A chart that repeats the sentence above it is noise.
4. Structure the answer conclusion-first: a top-line summary of 2–3 sentences with the numbers that matter (each paired with its baseline), then 2–5 sections. Each section opens with a one-sentence conclusion, then its evidence.
5. Finish with what to watch next and 1–3 concrete next actions (owner/timeframe only when the data or the user says so). Mark anything you have not proven as a hypothesis.

Wording rules:
- Write for a business reader: no table names, column names, SQL verbs or row-count jargon in titles and conclusions; keep those in a short 口径 footnote.
- Use 万/亿 for large readable numbers, but never change the underlying value.
- If the data cannot answer the question (missing time column, empty tables, disabled tables), say so plainly and offer what you can report instead.

Do not paste raw result sets into the answer; link the SQL in the transcript and show the conclusion.
No form, no asking the user to pick a template.`,
  },
};

export function commandIntent(id: string | undefined): CommandIntent | undefined {
  return id ? COMMAND_INTENTS[id.toLowerCase()] : undefined;
}

export interface ParsedCommand {
  id: string;
  /** 命令后面的自然语言；裸命令为空。 */
  argument?: string;
  /** 真正发给模型的任务：用户话术，缺省用命令的默认任务。 */
  task: string;
  intent: CommandIntent;
}

export function parseCommandIntent(text: string): ParsedCommand | null {
  const match = /^\/(report|compare|diff|recon|fix)(?:\s+([\s\S]+))?$/i.exec(text.trim());
  if (!match) return null;
  const intent = commandIntent(match[1]);
  if (!intent) return null;
  const argument = match[2]?.trim() || undefined;
  return { id: intent.id, ...(argument ? { argument } : {}), task: argument || intent.defaultTask, intent };
}
