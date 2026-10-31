import {
  buildMonthlySeriesExpr,
  createProvider,
  DASHBOARD_CARD_LIMIT,
  quoteIdent,
  tablesFromSql,
  type DashboardCardInput,
  type DashboardChartType,
  type Engine,
  type QueryResult,
} from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { assertDashboardSql, disabledTablesTouched } from './dashboards';
import { flattenTables, readBrief, type TableFact } from './databaseBrief';

const TRIAL_ROWS = 200;
const CHART_TYPES: DashboardChartType[] = ['bar', 'stacked', 'line', 'pie', 'scatter', 'heatmap', 'radar'];
const TIME_TYPE = /(date|datetime|timestamp|time)\b/i;
/** 业务时间：创建 / 下单 / 支付 / 退款时间，不是「最后修改时间」。 */
const BUSINESS_TIME = /(create|order|pay|refund|settle|apply|trade|bill|sign|start|end|_date|_time|date|time|日期|时间)/i;
const SKIP_TIME = /^(utime|update_time|updated_at|modify_time|sync_time)$/i;
/** 金额优先：业务人员看的是钱，不是行数。 */
const MONEY = /(amount|money|price|fee|total|pay|refund|income|cost|balance|withdraw|settle|sales|gmv|turnover|surplus|bonus|discount|金额|价|费|款)/i;
const NUMERIC_TYPE = /(int|decimal|numeric|double|float|money|real)/i;
const DIM_NAME = /(status|state|type|channel|way|kind|class|category|cate|city|province|region|source|platform|method|level|name|title|brand|shop)/i;
const SKIP_DIM = /(_id$|^id$|uuid|guid|url|json|content|remark|note|phone|mobile|address|password|token|version|flag$|_flag$|^del|invalid|sn$|no$|code$|time$|date$|timestamp$)/i;
const FACT_NAME = /(order|trade|pay|refund|fund|withdraw|flow|bill|settle|statistic|condition|record|detail|item|recharge|coupon|exchange|share|apply|evaluation|product|shop|user|订单|流水|统计|资金)/i;
const SOFT_DELETE = /^(invalid|del_flag|del_status|is_deleted|deleted|del)$/i;
/** 交易事件表优先：业务人员要的是「发生了什么」，不是「配置了什么」。 */
const EVENT_NAME = /(order|refund|pay|withdraw|trade|flow|bill|settle|recharge|apply|delivery|share|exchange|condition|statistic)/i;
const CONFIG_NAME = /(config|template|_dict|dict$|classify|_type$|category|partition|snapshot|log$|_history|operate_history|reason|banner|advertis|menu|auth|role|tenant)/i;
const AUDIT_COLUMN = /^(creator|updater|updator|operator|create_user|update_user|audit_user|operate_user.*|refund_user_id|buyer_id|seller_id|tenant_code|invalid|version|sort|snapshot)$/i;

export interface GenerateDraftInput {
  store: Store;
  manager: ConnectionManager;
  connectionId: string;
  database?: string;
  briefPath?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface GenerateDraftResult {
  cards: DashboardCardInput[];
  usedModel: boolean;
  notes: string[];
}

interface Candidate {
  title: string;
  sql: string;
  chartType: DashboardChartType;
  x?: string;
  y?: string;
  timeColumn?: string;
  origin: 'brief' | 'favorite' | 'metric' | 'model';
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tableRef(fact: TableFact, engine: Engine): string {
  return fact.displayName
    .replace(/["`\[\]]/g, '')
    .split('.')
    .filter(Boolean)
    .map((part) => quoteIdent(part, engine))
    .join('.');
}

/** 「订单表 / 退款订单信息表」→「订单」「退款订单」：卡片标题里不出现库名和表名。 */
function tableLabel(fact: TableFact): string {
  const comment = (fact.table.comment ?? '').trim();
  const base = comment || fact.name.replace(/^t_/i, '');
  return base.replace(/(信息表|记录表|数据表|明细表|表)$/u, '').trim() || base;
}

function columnsOf(fact: TableFact) {
  return (fact.table.columns ?? []).filter((column) => !column.generated);
}

function businessTimeOf(fact: TableFact): string | undefined {
  const all = columnsOf(fact).filter((column) => !SKIP_TIME.test(column.name));
  const typed = all.filter((column) => TIME_TYPE.test(column.type ?? ''));
  // SQLite / 部分 ORM 把日期存成 TEXT，只认类型会把整张订单表判成「没有时间列」
  const texty = all.filter((column) => !TIME_TYPE.test(column.type ?? '') && /(char|text|varchar)/i.test(column.type ?? ''));
  const pick = (list: { name: string; comment?: string }[]) =>
    list.find((column) => /(create|order|pay|refund|settle|_date$|date$)/i.test(column.name))?.name ??
    list.find((column) => BUSINESS_TIME.test(column.name))?.name ??
    list[0]?.name;
  return pick(typed) ?? pick(texty);
}

function moneyOf(fact: TableFact): string | undefined {
  const numeric = columnsOf(fact).filter(
    (column) => NUMERIC_TYPE.test(column.type ?? '') && !column.primaryKey && !/(_id$|^id$|version|sort|level|score|_num$|count$|_type$)/i.test(column.name),
  );
  return (
    numeric.find((column) => /(total_amount|order_amount|transaction_amount|sale_total_amount|pay_amount|amount|money)/i.test(column.name))?.name ??
    numeric.find((column) => MONEY.test(column.name))?.name ??
    numeric.find((column) => /(decimal|double|float|money)/i.test(column.type ?? ''))?.name
  );
}

function dimensionOf(fact: TableFact, exclude: string[] = []): string | undefined {
  const columns = columnsOf(fact).filter(
    (column) => !exclude.includes(column.name) && !SKIP_DIM.test(column.name) && !AUDIT_COLUMN.test(column.name),
  );
  const dimensional = columns.filter((column) => DIM_NAME.test(column.name) || /(char|text|enum)/i.test(column.type ?? ''));
  const commented = dimensional.filter((column) => column.comment);
  return (commented.find((column) => /(状态|类型|渠道|分类|城市|名称|方式|等级|品牌)/u.test(column.comment ?? '')) ?? commented[0] ?? dimensional[0])?.name;
}

function dimensionLabel(fact: TableFact, column: string): string {
  const info = columnsOf(fact).find((item) => item.name === column);
  const label = (info?.comment ?? column).replace(/(表|字段)$/u, '').trim();
  // 「此次流水变动的类型」这种长备注当标题会毁掉整块板
  return label.length <= 8 ? label : column;
}

function softDeleteFilter(fact: TableFact, engine: Engine): string {
  const column = columnsOf(fact).find((item) => SOFT_DELETE.test(item.name) && /int|tiny|bool|bit/i.test(item.type ?? ''));
  return column ? `WHERE ${quoteIdent(column.name, engine)} = 0` : '';
}

function factScore(fact: TableFact, ranked: string[]): number {
  let score = 0;
  const time = businessTimeOf(fact);
  const money = moneyOf(fact);
  if (time) score += 2;
  if (money) score += 4;
  if (time && money) score += 3;
  if (FACT_NAME.test(fact.name)) score += 2;
  if (EVENT_NAME.test(fact.name)) score += 6;
  if (CONFIG_NAME.test(fact.name)) score -= 8;
  if ((fact.table.rowEstimate ?? 0) > 50) score += 1;
  if (fact.table.comment) score += 1;
  const index = ranked.indexOf(fact.displayName);
  if (index >= 0) score += Math.max(0, 6 - index);
  return score;
}

/**
 * 确定性业务候选：以「钱 + 时间 + 维度」为核心，每张事实表给一条月度趋势（单量 + 金额）
 * 和一条维度 Top 10。不再产出「某表按某列的数据量」这种 DBA 自检图。
 */
export function metricCandidates(facts: TableFact[], engine: Engine, ranked: string[], limit: number): Candidate[] {
  const out: Candidate[] = [];
  const usable = facts
    .filter((fact) => (fact.table.rowEstimate ?? 1) > 10 && businessTimeOf(fact) && columnsOf(fact).length > 2)
    .sort((a, b) => factScore(b, ranked) - factScore(a, ranked));
  for (const fact of usable) {
    if (out.length >= limit) break;
    const table = tableRef(fact, engine);
    const time = businessTimeOf(fact)!;
    const money = moneyOf(fact);
    const filter = softDeleteFilter(fact, engine);
    const label = tableLabel(fact);
    const bucket = buildMonthlySeriesExpr(engine, time);
    const measure = money ? `, SUM(${quoteIdent(money, engine)}) AS amount` : '';
    out.push({
      title: `${label}月度趋势${money ? '（金额 / 单量）' : '（数量）'}`,
      sql: `SELECT * FROM (SELECT ${bucket} AS period, COUNT(*) AS cnt${measure} FROM ${table} ${filter} GROUP BY period ORDER BY period DESC LIMIT 12) recent ORDER BY period`,
      chartType: 'line',
      x: 'period',
      y: money ? 'amount' : 'cnt',
      timeColumn: 'period',
      origin: 'metric',
    });
    const dim = dimensionOf(fact, [time, ...(money ? [money] : [])]);
    if (dim && out.length < limit) {
      out.push({
        title: `${label}：按${dimensionLabel(fact, dim)}的${money ? '金额' : '数量'} Top 10`,
        sql: `SELECT ${quoteIdent(dim, engine)} AS dim_value, COUNT(*) AS cnt${measure} FROM ${table} ${filter} GROUP BY dim_value ORDER BY ${money ? 'amount' : 'cnt'} DESC LIMIT 10`,
        chartType: 'bar',
        x: 'dim_value',
        y: money ? 'amount' : 'cnt',
        origin: 'metric',
      });
    }
  }
  return out;
}

/** 从 AI_DB.md §4/§7 取人工确认过的口径 SQL；带占位符或非只读的模板直接丢。 */
export function briefCandidates(markdown: string, limit: number): Candidate[] {
  const out: Candidate[] = [];
  for (const block of markdown.split(/\n(?=## )/g)) {
    if (!/^## (4|7)\./.test(block)) continue;
    const lines = block.split('\n');
    let title = '';
    for (let index = 0; index < lines.length; index++) {
      const heading = /^#{3,4}\s+(.+)$/.exec(lines[index]);
      if (heading) {
        title = heading[1].trim();
        continue;
      }
      if (!/^```sql\s*$/i.test(lines[index])) continue;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      const sql = body.join('\n').trim();
      if (!sql || /<[a-z_一-龥]+>/i.test(sql) || assertDashboardSql(sql)) continue;
      out.push({ title: title.slice(0, 60) || '指标口径', sql, chartType: 'bar', origin: 'brief' });
      title = '';
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function favoriteTitle(sql: string): string {
  const comment = /^\s*(?:--|\/\*)\s*(.+)$/m.exec(sql);
  const name = comment?.[1]?.trim();
  if (name && name.length <= 40) return name;
  const first = sql.replace(/\s+/g, ' ').trim();
  return first.slice(0, 36) + (first.length > 36 ? '…' : '');
}

/**
 * 模型经常边解释边给 JSON，也会被 maxTokens 截断。
 * 所以除了正常解析，还要能从「数组被截断」的文本里把已经完整的对象捞出来——
 * 否则明明写对了业务口径，却整批丢掉退回模板图。
 */
function parseJsonArray(text: string): any[] {
  const cleaned = text.replace(/^[\s\S]*?(?=\[)/, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  if (start < 0) return [];
  let slice = cleaned.slice(start);
  const attempts: string[] = [];
  const end = slice.lastIndexOf(']');
  if (end > 0) attempts.push(slice.slice(0, end + 1));
  // 截断兜底：退到最后一个完整的 }，去掉尾逗号后补上 ]
  for (let scan = slice.length; scan > 0; scan--) {
    const brace = slice.lastIndexOf('}', scan);
    if (brace <= 0) break;
    attempts.push(`${slice.slice(0, brace).replace(/,\s*$/, '')}]`);
    scan = brace;
    if (attempts.length > 6) break;
  }
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* 继续尝试下一个截断点 */
    }
  }
  return [];
}

/** 给模型的表清单：只给业务相关列，上百张表 × 几十列会把 prompt 撑爆。 */
function catalogForModel(facts: TableFact[], ranked: string[], limit = 14): string {
  const usable = facts
    .filter((fact) => (fact.table.rowEstimate ?? 1) > 10 && (FACT_NAME.test(fact.name) || moneyOf(fact) || businessTimeOf(fact)))
    .sort((a, b) => factScore(b, ranked) - factScore(a, ranked))
    .slice(0, limit);
  return usable
    .map((fact) => {
      const columns = columnsOf(fact)
        .filter((column) => MONEY.test(column.name) || DIM_NAME.test(column.name) || TIME_TYPE.test(column.type ?? '') || /(count|num|qty|score)/i.test(column.name))
        .slice(0, 14)
        .map((column) => `${column.name}:${column.type}${column.comment ? `(${column.comment})` : ''}`)
        .join(', ');
      return `- ${fact.displayName}${fact.table.comment ? ` [${fact.table.comment}]` : ''} 约 ${fact.table.rowEstimate ?? '?'} 行 | ${columns}`;
    })
    .join('\n');
}

function modelPrompt(input: { database?: string; catalog: string; glossary: string[]; limit: number }): string {
  return [
    '你在为数据库客户端配置一块「仪表板」。使用者是业务 / 运营人员，不是开发者。',
    '他们每天早上想看的是：钱（成交额 / GMV / 退款 / 提现）、单量、转化与占比、Top N，以及这些指标的月度或每日走势。',
    '请针对下面的表，写出他们最该长期盯住的业务问题，并给出可执行 SQL。',
    'SQL 规则：',
    '- 单条只读 SELECT；必须聚合（GROUP BY + COUNT/SUM/AVG），不要查明细行。',
    "- 时间趋势必须按天或按月分桶（例如 DATE_FORMAT(col, '%Y-%m')），禁止按原始时间戳分组——那样每个点都是 1，图毫无意义。",
    '- 有软删除列（invalid / del_flag / del_status）时要在 WHERE 里过滤 = 0。',
    '- 金额优先 SUM(金额列)，别只给 COUNT(*)；一条 SQL 可以同时给单量和金额。',
    '- 分布类查询挑真正有业务含义的维度（状态 / 类型 / 渠道 / 支付方式 / 城市 / 商品名），不要挑布尔开关或 del_status。',
    `- 最多 ${input.limit} 条；标题用简短中文业务口径，不要出现表名、字段名、库名。`,
    '- chart_type 取 bar | stacked | line | pie | scatter | heatmap | radar；时间序列用 line，禁止 pie。',
    '- x / y / time_column 必须是 SQL 结果里真实存在的列名（建议起别名 period / cnt / amount / dim_value）。',
    '- 只能用列表里出现过的表和字段，不许编造。',
    input.glossary.length ? `术语表：\n${input.glossary.join('\n')}` : '',
    input.database ? `当前库：${input.database}` : '',
    '表与字段：',
    input.catalog,
    '只输出 JSON 数组：[{"title":"...","sql":"SELECT ...","chart_type":"line","x":"period","y":"amount","time_column":"period"}]',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 信息量闸门：跑通了不等于值得看。
 * 「一根柱子占满 100%」「每个时间点只有 1 行」这类图，宁可不出。
 */
export function trialVerdict(
  set: QueryResult | undefined,
  card: { x?: string; y?: string; chartType: DashboardChartType },
): string | undefined {
  if (!set || !set.rows.length) return '没有返回数据';
  const names = set.columns.map((column) => column.name);
  const xIndex = card.x ? names.indexOf(card.x) : 0;
  const yIndex = card.y
    ? names.indexOf(card.y)
    : names.findIndex((_, index) => index !== xIndex && set.rows.some((row) => Number.isFinite(Number(row[index]))));
  if (xIndex < 0 || yIndex < 0) return '找不到 x/y 列';
  const xs = set.rows.map((row) => String(row[xIndex] ?? ''));
  const distinct = new Set(xs).size;
  const values = set.rows.map((row) => Number(row[yIndex])).filter((value) => Number.isFinite(value));
  if (!values.length) return 'y 列不是数值';
  if (values.every((value) => value === 0)) return '数值全是 0';
  if (distinct < 2) return '分类只有一个取值';
  if (card.chartType === 'line') {
    if (set.rows.length < 3) return '趋势点太少';
    if (/:/.test(xs[0] ?? '') && distinct === set.rows.length) return '按原始时间戳分组，需要按天 / 月分桶';
  } else {
    const total = values.reduce((sum, value) => sum + Math.abs(value), 0);
    if (total > 0 && Math.max(...values.map(Math.abs)) / total > 0.99) return '一个取值占了 99% 以上，没有分布可言';
  }
  return undefined;
}

/**
 * 草稿生成：模型按业务写 SQL（首选）→ brief 里人工确认过的口径 → 确定性「钱 + 时间 + 维度」模板兜底；
 * 每个候选都要过只读校验 + 试跑 + 信息量闸门，不合格的不进板。
 */
export async function generateDashboardDrafts(input: GenerateDraftInput): Promise<GenerateDraftResult> {
  const { store, manager, connectionId } = input;
  const notes: string[] = [];
  const conn = store.getConnection(connectionId);
  if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const engine = conn.engine as Engine;
  const database = input.database ?? conn.database;
  const limit = Math.min(input.limit ?? 8, DASHBOARD_CARD_LIMIT);
  const settings = store.getSettings();
  const bundle = store.agentContextBundle(connectionId, database);
  const disabled = bundle.disabledTables;

  const schemas = await manager.schema(connectionId, database);
  const facts = flattenTables(schemas).filter((fact) => !disabled.some((table) => table.toLowerCase() === fact.displayName.toLowerCase()));
  if (!facts.length) return { cards: [], usedModel: false, notes: ['当前库没有可见的表，或全部表已在 Agent 上下文中禁用。'] };

  const history = store.listHistory({ connectionId, limit: 200 });
  const counts = new Map<string, number>();
  for (const item of history) {
    for (const table of tablesFromSql(item.sql)) {
      const hit = facts.find(
        (fact) => fact.displayName.toLowerCase() === table.toLowerCase() || fact.displayName.toLowerCase().endsWith(`.${table.toLowerCase()}`),
      );
      if (hit) counts.set(hit.displayName, (counts.get(hit.displayName) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((entry) => entry[0]);
  const seen = new Set(
    store
      .listDashboardCards(connectionId, database)
      .filter((card) => card.pinned)
      .map((card) => normalized(card.sql)),
  );

  const pool: Candidate[] = [];
  const push = (candidate: Candidate) => {
    if (!candidate.title || !candidate.sql) return;
    if (seen.has(normalized(candidate.sql))) return;
    if (pool.some((item) => normalized(item.sql) === normalized(candidate.sql))) return;
    pool.push(candidate);
  };

  const briefPath = input.briefPath ?? store.getDatabaseBrief(connectionId, database)?.path;
  const markdown = briefPath ? await readBrief(briefPath).catch(() => null) : null;
  if (!markdown) notes.push('这个库还没有 AI_DB.md（跑一次 /init 能带上人工确认的口径），本次按表结构与字段备注推断。');

  const modelCards: Candidate[] = [];
  let usedModel = false;
  if (settings.agent.provider !== 'local') {
    try {
      const provider = createProvider(settings.agent);
      const glossary = store.listMemories({ kind: 'glossary', limit: 12 }).map((memory) => `- ${memory.title}：${memory.content}`);
      let text = '';
      for await (const event of provider.stream(
        {
          system: '你是数据库仪表板助手，只输出 JSON 数组。',
          messages: [{ role: 'user', content: modelPrompt({ database, catalog: catalogForModel(facts, ranked), glossary, limit }) }],
          tools: [],
          temperature: 0.2,
          maxTokens: 6000,
        },
        input.signal ?? new AbortController().signal,
      )) {
        if (event.type === 'text') text += event.text;
      }
      for (const raw of parseJsonArray(text)) {
        const sql = typeof raw?.sql === 'string' ? raw.sql.trim() : '';
        if (!sql) continue;
        modelCards.push({
          title: String(raw?.title ?? '业务指标').slice(0, 60),
          sql,
          chartType: CHART_TYPES.includes(raw?.chart_type) ? (raw.chart_type as DashboardChartType) : 'bar',
          x: typeof raw?.x === 'string' ? raw.x : undefined,
          y: typeof raw?.y === 'string' ? raw.y : undefined,
          timeColumn: typeof raw?.time_column === 'string' && raw.time_column.trim() ? raw.time_column.trim() : undefined,
          origin: 'model',
        });
      }
      usedModel = modelCards.length > 0;
      if (!usedModel) notes.push(`模型返回的内容解析不出 JSON（前 120 字：${text.replace(/\s+/g, ' ').slice(0, 120)}）`);
    } catch (err) {
      notes.push(`模型生成失败，已改用确定性业务指标候选：${err instanceof Error ? err.message : String(err)}`.slice(0, 160));
    }
  }

  for (const candidate of modelCards) push(candidate);
  if (markdown) for (const candidate of briefCandidates(markdown, limit)) push(candidate);
  for (const candidate of metricCandidates(facts, engine, ranked, limit)) push(candidate);
  for (const item of history) {
    if (!item.favorite || item.status !== 'ok') continue;
    if (item.database && database && item.database !== database) continue;
    const sql = item.sql.trim();
    if (sql.length > 1500) continue;
    push({ title: favoriteTitle(sql), sql, chartType: 'bar', origin: 'favorite' });
  }

  const cards: DashboardCardInput[] = [];
  for (const candidate of pool) {
    if (cards.length >= limit) break;
    const guard = assertDashboardSql(candidate.sql);
    const blocked = disabledTablesTouched(candidate.sql, disabled);
    if (guard || blocked.length) {
      notes.push(`「${candidate.title}」不入板：${guard ?? `引用了已禁用的表 ${blocked.join('、')}`}`);
      continue;
    }
    let set: QueryResult | undefined;
    try {
      const batch = await manager.query(connectionId, candidate.sql, {
        database,
        maxRows: TRIAL_ROWS,
        timeoutMs: settings.queryTimeoutMs,
        allowMulti: false,
        autoLimit: settings.autoLimit,
        actor: 'user',
      });
      set = batch.sets[0];
    } catch (err) {
      notes.push(`「${candidate.title}」试跑失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 140));
      continue;
    }
    const names = (set?.columns ?? []).map((column) => column.name);
    const x = candidate.x && names.includes(candidate.x) ? candidate.x : names[0];
    const y =
      candidate.y && names.includes(candidate.y)
        ? candidate.y
        : names.find((name, index) => index > 0 && (set?.rows ?? []).some((row) => Number.isFinite(Number(row[index]))));
    const verdict = trialVerdict(set, { x, y, chartType: candidate.chartType });
    if (verdict) {
      notes.push(`「${candidate.title}」不值得看（${verdict}），已跳过。`);
      continue;
    }
    const timeColumn = candidate.timeColumn && names.includes(candidate.timeColumn) ? candidate.timeColumn : /period|month|day|date|week/i.test(x ?? '') ? x : undefined;
    const chartType = timeColumn && candidate.chartType === 'pie' ? 'line' : candidate.chartType;
    cards.push({
      connectionId,
      database,
      title: candidate.title,
      sql: candidate.sql,
      chartType,
      x,
      y,
      timeColumn,
      span: 1,
      source: 'ai',
      pinned: false,
      lastResult: { columns: (set?.columns ?? []).map((column) => ({ name: column.name })), rows: set?.rows ?? [] },
    });
  }

  if (!cards.length) notes.push('所有候选都没通过试跑或信息量闸门，仪表板保持原样。');
  return { cards, usedModel, notes };
}
