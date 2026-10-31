import {
  compressSchema,
  createProvider,
  DASHBOARD_CHART_TYPES,
  engineMeta,
  focusTablesForQuestion,
  formatBusinessContext,
  formatMemoriesForPrompt,
  tablesFromSql,
  type DashboardChartType,
  type DashboardComposeResult,
  type DashboardPreview,
  type DatabaseSchema,
  type Engine,
} from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { assertDashboardSql, disabledTablesTouched } from './dashboards';
import { briefCandidates, metricCandidates } from './dashboardGenerate';
import { flattenTables, readBrief } from './databaseBrief';

/** 预览和卡片刷新使用同一条只读路径；多拉的行对图表没有意义。 */
const PREVIEW_ROWS = 200;
const GENERATION_ATTEMPTS = 2;
/** AI_DB.md 只带口径相关章节，别把整份交接文档塞进 prompt。 */
const BRIEF_SECTIONS = /^## (3|4|5|7)\./;
const BRIEF_CHARS = 4500;

interface Suggestion {
  title: string;
  sql: string;
  chartType: DashboardChartType;
  x?: string;
  y?: string;
  timeColumn?: string;
  origin: 'model' | 'brief' | 'metric';
}

export interface ComposeInput {
  store: Store;
  manager: ConnectionManager;
  connectionId: string;
  database?: string;
  prompt: string;
}

export interface PreviewInput {
  store: Store;
  manager: ConnectionManager;
  connectionId: string;
  database?: string;
  sql: string;
}

/** 只读 + 禁用表 + 执行，三层与卡片刷新完全一致；错误留在结果里给表单内联展示。 */
export async function previewDashboardSql(input: PreviewInput): Promise<DashboardPreview> {
  const guard = assertDashboardSql(input.sql);
  if (guard) return { columns: [], rows: [], rowCount: 0, durationMs: 0, error: guard };
  const blocked = disabledTablesTouched(input.sql, input.store.agentContextBundle(input.connectionId, input.database).disabledTables);
  if (blocked.length) {
    return { columns: [], rows: [], rowCount: 0, durationMs: 0, error: `这些表已在 Agent 上下文中禁用：${blocked.join('、')}` };
  }
  const settings = input.store.getSettings();
  try {
    const batch = await input.manager.query(input.connectionId, input.sql, {
      database: input.database,
      maxRows: PREVIEW_ROWS,
      timeoutMs: settings.queryTimeoutMs,
      allowMulti: false,
      autoLimit: settings.autoLimit,
      actor: 'user',
    });
    const set = batch.sets[0];
    if (!set) return { columns: [], rows: [], rowCount: 0, durationMs: batch.durationMs, error: '查询没有返回结果集' };
    return {
      columns: set.columns.map((column) => ({ name: column.name })),
      rows: set.rows,
      rowCount: set.rowCount,
      durationMs: set.durationMs ?? batch.durationMs,
      truncated: set.truncated,
    };
  } catch (err) {
    return { columns: [], rows: [], rowCount: 0, durationMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function briefExcerpt(markdown: string): string {
  const parts: string[] = [];
  let used = 0;
  for (const block of markdown.split(/\n(?=## )/g)) {
    if (!BRIEF_SECTIONS.test(block)) continue;
    const body = block.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!body) continue;
    if (used + body.length > BRIEF_CHARS) {
      const remain = BRIEF_CHARS - used;
      if (remain > 200) parts.push(body.slice(0, remain) + '…');
      break;
    }
    parts.push(body);
    used += body.length;
  }
  return parts.join('\n\n');
}

function modelSystemPrompt(): string {
  return [
    '你是 AiDB Studio 的仪表板取数助手。用户会用一句业务需求描述想长期盯住的指标，你要为当前数据库写一条可在仪表板中反复刷新的查询。',
    '硬性规则：',
    '- 只输出一个 JSON 对象，不要 markdown 代码围栏，不要输出思考过程或解释。',
    '- sql 必须是单条只读 SELECT，不能包含任何写操作或多条语句。',
    '- sql 必须聚合（GROUP BY + COUNT/SUM/AVG 等），不要返回原始明细行；除非需求本身就是总行数、总数这类单值。',
    '- 时间趋势必须按天或按月分桶，禁止直接按原始时间戳分组——那样每个点都是 1。',
    '- 金额优先 SUM(金额列)，计数用 COUNT(*)。',
    '- 只能使用 Schema 中出现的表和字段；需要关联时按 Schema 里的外键或 Joins 写。',
    '- 结果列使用简短英文别名，x / y / time_column 必须是结果里真实存在的列名。',
    '- 分类分布用 ORDER BY 度量 DESC 并 LIMIT 10~20。',
    '- title 用简洁中文业务口径，不出现表名、字段名、库名。',
    `- chart_type 取 ${DASHBOARD_CHART_TYPES.join(' | ')}；时间序列用 line，分类对比用 bar，占比用 pie（最多 8 类）。`,
  ].join('\n');
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (!depth) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, index + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function parseSuggestion(text: string, prompt: string): Suggestion | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  const sql = typeof raw.sql === 'string' ? raw.sql.trim() : '';
  if (!sql) return undefined;
  const chartType = DASHBOARD_CHART_TYPES.includes(raw.chart_type as DashboardChartType)
    ? (raw.chart_type as DashboardChartType)
    : 'bar';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 60) : prompt.slice(0, 30);
  return {
    title,
    sql,
    chartType,
    x: typeof raw.x === 'string' && raw.x.trim() ? raw.x.trim() : undefined,
    y: typeof raw.y === 'string' && raw.y.trim() ? raw.y.trim() : undefined,
    timeColumn: typeof raw.time_column === 'string' && raw.time_column.trim() ? raw.time_column.trim() : undefined,
    origin: 'model',
  };
}

async function requestSuggestion(input: {
  store: Store;
  schemas: DatabaseSchema[];
  connectionId: string;
  database?: string;
  prompt: string;
  feedback?: string;
  signal?: AbortSignal;
}): Promise<Suggestion> {
  const { store, schemas, connectionId, database, prompt } = input;
  const conn = store.getConnection(connectionId);
  if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const context = store.agentContextBundle(connectionId, database);
  const recall = store.recallForTurn(prompt, { connectionId, database });
  const focus = focusTablesForQuestion({
    question: prompt,
    databases: schemas,
    context,
    memories: recall.memories,
    glossary: recall.glossary,
    sqlExamples: recall.sqlExamples,
    max: 8,
  });
  const business = formatBusinessContext({ context, glossary: recall.glossary, sqlExamples: recall.sqlExamples });
  const briefPath = store.getDatabaseBrief(connectionId, database)?.path;
  const markdown = briefPath ? await readBrief(briefPath).catch(() => null) : null;
  const brief = markdown ? briefExcerpt(markdown) : '';
  const content = [
    `需求：${prompt}`,
    `当前引擎：${conn.engine}（${engineMeta(conn.engine).label}）；SQL 必须使用该方言。${database ? `当前库：${database}` : ''}`,
    recall.memories.length ? `## 相关记忆\n${formatMemoriesForPrompt(recall.memories)}` : '',
    brief ? `## 数据库交接文档（AI_DB.md，口径参考）\n${brief}` : '',
    business ? `## 业务上下文\n${business}` : '',
    `## Schema\n${compressSchema(schemas, focus, 10, context)}`,
    input.feedback ? `## 上一版失败原因\n${input.feedback}\n请修正后重新输出完整 JSON。` : '',
    '## 输出（只输出这个 JSON 对象）\n{"title":"...","sql":"SELECT ...","chart_type":"bar","x":"...","y":"...","time_column":"..."}',
  ]
    .filter(Boolean)
    .join('\n\n');

  const settings = store.getSettings();
  const provider = createProvider(settings.agent);
  let text = '';
  for await (const event of provider.stream(
    {
      system: modelSystemPrompt(),
      messages: [{ role: 'user', content }],
      tools: [],
      temperature: 0.2,
      maxTokens: 3000,
    },
    input.signal ?? new AbortController().signal,
  )) {
    if (event.type === 'text') text += event.text;
  }
  const suggestion = parseSuggestion(text, prompt);
  if (!suggestion) {
    throw Object.assign(new Error(`模型没有返回可解析的 JSON（前 120 字：${text.replace(/\s+/g, ' ').slice(0, 120) || '空响应'}）`), {
      code: 'MODEL_BAD_OUTPUT',
      status: 502,
    });
  }
  return suggestion;
}

function promptTerms(prompt: string): string[] {
  const latin = prompt.toLowerCase().match(/[a-z][a-z0-9_]{1,}/g) ?? [];
  const runs = prompt.match(/[\u4e00-\u9fff]+/g) ?? [];
  const cjk = new Set<string>();
  for (const run of runs) {
    if (run.length <= 6) cjk.add(run);
    for (let index = 0; index + 2 <= run.length; index++) cjk.add(run.slice(index, index + 2));
  }
  const noisy = new Set(['统计', '数据', '查询', '显示', '看看', '想要', '需要', '一下', '每天', '每日', '近', '的', '按', '和', '与']);
  return [...new Set([...latin, ...cjk])].filter((term) => !noisy.has(term));
}

const CN_COLUMN_HINTS: Array<[RegExp, RegExp]> = [
  [/订单|单量|成交/, /order|trade|bill/],
  [/状态/, /status|state/],
  [/金额|营收|销售额|成交额|gmv|收入/, /amount|money|total|price|cents|revenue|gmv/],
  [/渠道|来源/, /channel|source/],
  [/用户|客户|会员/, /user|customer|member/],
  [/商品|产品|货品/, /product|item|goods/],
  [/日期|时间|每天|每日|按天|按月|月度|趋势|走势/, /date|time|day|month|period/],
  [/分类|类型/, /categor|type|class/],
];

function scoreCandidate(prompt: string, terms: string[], candidate: Suggestion, focusTables: string[]): number {
  const title = candidate.title.toLowerCase();
  const sql = candidate.sql.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    else if (sql.includes(term)) score += 1;
  }
  // 中文需求 → 英文字段名：离线模式没有模型，只能靠这张小映射表把「按状态」对到 status。
  for (const [chinese, english] of CN_COLUMN_HINTS) {
    if (chinese.test(prompt) && english.test(`${title} ${sql}`)) score += 3;
  }
  // 与 Agent 同一套表聚焦逻辑：中文「订单」能召回 orders，避免只做字面匹配。
  if (focusTables.some((table) => sql.includes(table.toLowerCase()))) score += 8;
  const wantsSeries = /(趋势|走势|每天|每日|按天|按月|月度|时间)/.test(prompt);
  const wantsDistribution = /(按|分组|分布|占比|top\s*\d*|排行|前\s*\d+|最多|最高)/i.test(prompt);
  if (wantsSeries && candidate.chartType === 'line') score += 3;
  if (wantsDistribution && candidate.chartType === 'bar') score += 3;
  if (/(占比|比例|饼)/.test(prompt) && candidate.chartType === 'pie') score += 2;
  return score;
}

/**
 * 离线兜底：不假装理解任意自然语言，只在用户需求能对上 brief 口径或内置「钱 + 时间 + 维度」
 * 模板时给一条候选，并在 notes 里说清这是模板结果。对不上就明确报错，不糊一条错 SQL。
 */
async function offlineSuggestion(input: {
  store: Store;
  schemas: DatabaseSchema[];
  connectionId: string;
  database?: string;
  prompt: string;
}): Promise<Suggestion | undefined> {
  const conn = input.store.getConnection(input.connectionId);
  if (!conn) return undefined;
  const facts = flattenTables(input.schemas);
  const history = input.store.listHistory({ connectionId: input.connectionId, limit: 200 });
  const counts = new Map<string, number>();
  for (const item of history) {
    for (const table of tablesFromSql(item.sql)) {
      const hit = facts.find(
        (fact) => fact.displayName.toLowerCase() === table.toLowerCase() || fact.displayName.toLowerCase().endsWith(`.${table.toLowerCase()}`),
      );
      if (hit) counts.set(hit.displayName, (counts.get(hit.displayName) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const pool: Suggestion[] = metricCandidates(facts, conn.engine as Engine, ranked, 12).map((candidate) => ({ ...candidate, origin: 'metric' }));
  const briefPath = input.store.getDatabaseBrief(input.connectionId, input.database)?.path;
  const markdown = briefPath ? await readBrief(briefPath).catch(() => null) : null;
  if (markdown) {
    for (const candidate of briefCandidates(markdown, 8)) pool.push({ ...candidate, origin: 'brief' });
  }
  if (!pool.length) return undefined;
  const recall = input.store.recallForTurn(input.prompt, { connectionId: input.connectionId, database: input.database });
  const focusTables = focusTablesForQuestion({
    question: input.prompt,
    databases: input.schemas,
    context: input.store.agentContextBundle(input.connectionId, input.database),
    memories: recall.memories,
    glossary: recall.glossary,
    sqlExamples: recall.sqlExamples,
    max: 6,
  });
  const terms = promptTerms(input.prompt);
  const scored = pool.map((candidate) => ({ candidate, score: scoreCandidate(input.prompt, terms, candidate, focusTables) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) return undefined;
  // 离线模板的标题是「orders：按status」，对业务用户没意义；直接用需求本身当标题。
  return { ...best.candidate, title: input.prompt.trim().slice(0, 40) || best.candidate.title };
}

function alignSuggestion(suggestion: Suggestion, preview: DashboardPreview): Suggestion {
  const names = preview.columns.map((column) => column.name);
  if (!names.length) return suggestion;
  const x = suggestion.x && names.includes(suggestion.x) ? suggestion.x : names[0];
  const y =
    suggestion.y && names.includes(suggestion.y)
      ? suggestion.y
      : names.find((name, index) => index > 0 && preview.rows.some((row) => Number.isFinite(Number(row[index]))));
  const timeColumn =
    suggestion.timeColumn && names.includes(suggestion.timeColumn)
      ? suggestion.timeColumn
      : x && /period|month|day|date|week/i.test(x)
        ? x
        : undefined;
  return { ...suggestion, x, y, timeColumn };
}

/**
 * 一句话需求 → 单卡 SQL：
 * 模型按 Schema/口径写 SQL → 只读闸门 → 试跑；失败把错误回喂给模型修正一次。
 * 模型不可用或失败时退回 brief/指标模板；仍无匹配则明确报错。
 */
export async function composeDashboardCard(input: ComposeInput): Promise<DashboardComposeResult> {
  const prompt = input.prompt.trim();
  const conn = input.store.getConnection(input.connectionId);
  if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const database = input.database ?? conn.database;
  const notes: string[] = [];
  const schemas = await input.manager.schema(conn.id, database);
  const settings = input.store.getSettings();
  let usedModel = false;
  let suggestion: Suggestion | undefined;
  let preview: DashboardPreview | undefined;
  let previewSql: string | undefined;

  if (settings.agent.provider !== 'local') {
    let feedback: string | undefined;
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
      try {
        suggestion = await requestSuggestion({
          store: input.store,
          schemas,
          connectionId: conn.id,
          database,
          prompt,
          feedback,
        });
      } catch (err: any) {
        notes.push(`模型生成失败：${err?.message ?? String(err)}`.slice(0, 200));
        suggestion = undefined;
        break;
      }
      usedModel = true;
      const guard = assertDashboardSql(suggestion.sql);
      if (guard) {
        feedback = `只读校验未通过：${guard}。sql 必须是单条只读 SELECT。`;
        if (attempt + 1 < GENERATION_ATTEMPTS) notes.push('模型给的语句不是单条只读查询，已要求重写一次。');
        continue;
      }
      preview = await previewDashboardSql({
        store: input.store,
        manager: input.manager,
        connectionId: conn.id,
        database,
        sql: suggestion.sql,
      });
      previewSql = suggestion.sql;
      if (!preview.error) break;
      feedback = `试跑失败：${preview.error.slice(0, 500)}。请基于同样的 Schema 修正 SQL。`;
      if (attempt + 1 < GENERATION_ATTEMPTS) notes.push('首次 SQL 试跑未通过，已把错误回喂给模型修正一次。');
    }
    if (suggestion && preview?.error && !feedback) {
      notes.push(`SQL 试跑失败：${preview.error}`.slice(0, 220));
    }
  } else {
    notes.push('当前是本地离线模式：按内置指标模板 / AI_DB.md 口径匹配生成，质量有限；在设置里配置模型后会按需求精确编写 SQL。');
  }

  if (!suggestion) {
    suggestion = await offlineSuggestion({
      store: input.store,
      schemas,
      connectionId: conn.id,
      database,
      prompt,
    });
    if (suggestion) notes.push(`离线模式按「${suggestion.origin === 'brief' ? 'AI_DB.md 口径' : '内置指标模板'}」匹配到一条候选，请核对口径。`);
  }

  if (!suggestion) {
    throw Object.assign(
      new Error('这句话暂时无法在离线模式下转成 SQL'),
      {
        code: 'MODEL_UNAVAILABLE',
        status: 400,
        hint: '在「设置 → AI 模型」配置一个可用模型后重试；也可以直接手写 SQL 再点预览。',
      },
    );
  }

  if (!preview || previewSql !== suggestion.sql) {
    // 模型两次都失败，或离线候选尚未试跑：给出最后一条 SQL 的真实试跑结果，让用户看到错在哪。
    preview = await previewDashboardSql({
      store: input.store,
      manager: input.manager,
      connectionId: conn.id,
      database,
      sql: suggestion.sql,
    });
    if (preview.error) notes.push(`试跑失败：${preview.error}`.slice(0, 220));
  }

  const aligned = alignSuggestion(suggestion, preview);
  return {
    usedModel,
    title: aligned.title,
    sql: aligned.sql,
    chartType: aligned.chartType,
    x: aligned.x,
    y: aligned.y,
    timeColumn: aligned.timeColumn,
    preview,
    notes: [...new Set(notes)],
  };
}
