import type { ColumnInfo, Engine, TableInfo } from '../../types';
import type { ChartKind } from '../../analysis/chartFit';
import type { TimeBucketGrain } from '../../sql/ddl';
import type { CompiledQuery, ColumnRef, FilterSpec, JoinSpec, MeasureSpec, QuerySpec, TimeBucketSpec } from './query';
import { compileQuery, findJoinPath, joinEdges } from './query';
import type { GroundingOptions } from './schema';
import { groundedColumns, groundedTables, matchColumn, matchTable, namesTable, pickDimension, pickMeasure, pickTimeColumn, rankTables } from './schema';
import type { Forbidden } from './business';
import { NO_FORBIDDEN, forbiddenTableReason, isColumnForbidden, isTableForbidden } from './business';
import type { TimeGrain } from '../../commands/timeWindow';
import { resolvePeriod } from '../../commands/timeWindow';
import { columnLabel, foreignKeyColumnsOf, isNumericColumn, isTimeColumn, tableLabel } from '../suggest';

/**
 * 离线推理器的自然语言解析：把一句话拆成查询模型的槽位，再交给编译器。
 *
 * 只做有把握的抽取——每个槽位都是确定性话术 + 接地层选列。宁可留空让上层定点追问，
 * 也不猜一个语义不明的条件：猜出来的 WHERE 会让数字看着合理，其实全错。
 * 中英话术都收：界面默认英文，解析器不能只认中文。
 */

export interface PlanProbe {
  table: string;
  column: string;
  /** 用户原话里的取值说法，例如 paid / 已支付。 */
  raw: string;
}

export interface PlanOutcome {
  status: 'ready' | 'probe' | 'gap';
  spec?: QuerySpec;
  compiled?: CompiledQuery;
  /** 结果列的业务名，按 SELECT 顺序，明细查询用它做表头。 */
  labels?: string[];
  /** 第一列业务名（图表/结论里当作「横轴」念出来）。 */
  axisLabel?: string;
  measureLabel?: string;
  probe?: PlanProbe;
  /** 直接把这句话问回去，不再甩 help 清单。 */
  gap?: string;
  /** 抽取到但没能落地的条件，结论里要交代。 */
  dropped?: string[];
  /** 用户点名的图种（热力/雷达/堆叠…）；没点名时不设，由上层按数据形态选。 */
  chart?: ChartKind;
}

export interface PlanInput {
  /** 已经过术语展开的问题原文。 */
  question: string;
  engine: Engine;
  /** 完整表清单（含被隐藏的），接地层负责过滤。 */
  tables: TableInfo[];
  grounding: GroundingOptions;
  now?: Date | string;
  /** 上一轮有界探测回来的取值。 */
  probe?: { table: string; column: string; values: Array<string | number> };
  /** 本轮已经探测过一次：不再换列追探测，一句话最多一条探测查询。 */
  probeDone?: boolean;
  /** 反例推出的禁用集合，缺省表示没有配置反例。 */
  forbidden?: Forbidden;
  /**
   * 上一问已经问清楚的口径。追问（「那按城市呢」「只看已支付的」）不会重复点名表和度量，
   * 没点名的槽位沿用它，点名的以本轮为准——没有这一层，离线模式每一句都是新会话。
   */
  focus?: QuerySpec;
  /**
   * 只为算 focus 而重放历史问题时置位：重放发不出探测查询，所以对不上真实取值的条件直接放弃，
   * 宁可让追问少继承一个条件，也不能把「已支付」当成字面量查出一个空答案。
   */
  replay?: boolean;
}

/** 候选表池：FROM 起点在前，JOIN 进来的表追加在后，选列时按这个顺序优先。 */
interface Pool {
  tables: TableInfo[];
  joins: JoinSpec[];
  grounding: GroundingOptions;
}

const GRAIN_PHRASES: Array<[RegExp, TimeBucketGrain]> = [
  [/(每小时|每\s*个?\s*小时|按小时|逐小时|hourly|by hour)/i, 'hour'],
  [/(每天|每日|按天|逐日|日趋势|daily|by day|per day)/i, 'day'],
  [/(每周|每\s*个?\s*周|按周|逐周|周趋势|weekly|by week)/i, 'week'],
  [/(每月|每\s*个?\s*月|按月|逐月|月度|月趋势|monthly|by month)/i, 'month'],
  [/(每季|每季度|按季|逐季|季度趋势|quarterly|by quarter)/i, 'quarter'],
  [/(每年|每\s*个?\s*年|按年|逐年|年度|yearly|by year)/i, 'year'],
];

const TREND_WORDS = /(趋势|走势|变化|波动|trend|over time|history)/i;
const COUNT_WORDS = /(多少|总数|条数|行数|个数|有几|how many|\bcount\b|number of)/i;
const DISTINCT_WORDS = /(多少种|多少个不同|去重|不同取值|distinct|unique)/i;
const SUM_WORDS = /(合计|总和|求和|总额|总金额|总计|累计|销售额|金额|营收|收入|\bgmv\b|\bsum\b|\btotal\b)/i;
const AVG_WORDS = /(平均|均值|人均|客单价|均摊|\bavg\b|average|\bmean\b)/i;
const MIN_WORDS = /(最低|最小|最少|最便宜|\bmin\b|lowest|smallest)/i;
const MAX_WORDS = /(最高|最大|最多|最贵|峰值|\bmax\b|highest|largest)/i;
const DETAIL_WORDS = /(明细|清单|逐条|哪几|详情|detail)/i;
const GROUP_WORDS = /(分组|分别|分布|占比|各|哪些|group by)/i;
/** 「前 10 笔」「金额最高的 10 笔订单」——量词紧跟数字才是行数，否则是「近 3 个月」这类时间话术。 */
const ROW_LIMIT = /(?:前\s*(\d{1,3})\s*(?:笔|条|个|名|行|单)|(?:最(?:高|大|多|低|小|便宜|贵)的|top)\s*(\d{1,3})\s*(?:笔|条|行|单))/i;

/** 这些词长得像「X 为 Y」的右值，其实是疑问或聚合话术，不能当取值。 */
const NOT_A_VALUE = /^(什么|哪些|多少|如何|怎么|为什么|情况|数据|结果|时候|时间|平均|总计|合计|分布|占比|样子?|the|what|which|how|many|much|data|table|total|sum|avg)$/i;
/** 「个月 / 3 天 / 半年」这种时间残片，是滚动窗口的尾巴或粒度说法，不是任何一列的取值。 */
const TIME_FRAGMENT = /^(?:\d+|半|几|[上下这本整])?[个]?(?:月|周|天|日|年|小时|分钟|季度)$/i;

/**
 * 明确承接上一问的说法。
 *
 * 本轮没点名表时一定按追问处理；点了表名还得靠这几个词区分——
 * 「orders 的金额合计」是重新起一句话，「orders 那只看已支付的」才是接着上一句改条件。
 */
const FOLLOW_UP = /^(那|则|再|换|只|同样|其中|去掉|不限|全部|所有)|呢[？?]?\s*$/i;

/** 这句话是在接上一问，还是重新起了一句话。 */
export function isFollowUp(text: string): boolean {
  return FOLLOW_UP.test(text.trim());
}

/**
 * 一句话里的多个问题：「先算总数，再算金额合计」。
 *
 * 只认显式的承接连接词，不按逗号切：「近 3 个月，按城市统计」是一句话两个槽位，
 * 切开就把一个查询拆成两个查不出的半句。切完还要求每段自己像个问题（有聚合动词或点名表），
 * 否则「统计金额合计，以及占比」的尾巴会变成一条独立的空查询。
 */
const CLAUSE_CONNECTOR = /(?:，|,|；|;)?\s*(?:以及|并且|同时|然后再|再|然后|接着|最后)\s*/;
const QUERY_LIKE = /(统计|汇总|合计|总和|求和|平均|均值|多少|行数|条数|趋势|走势|占比|分布|排名|明细|清单|前\s*\d+|最高|最低|最大|最小|查|看|算|total|sum|avg|count|how many|trend|top|detail)/i;

export function splitClauses(text: string): string[] {
  const parts = text
    .split(CLAUSE_CONNECTOR)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return [];
  return parts.every((part) => QUERY_LIKE.test(part)) ? parts : [];
}

const GRAIN_FROM_TIME: Record<TimeGrain, TimeBucketGrain> = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };

function grainPhrase(text: string): TimeBucketGrain | undefined {
  for (const [pattern, grain] of GRAIN_PHRASES) if (pattern.test(text)) return grain;
  return undefined;
}

function limitOf(question: string): number | undefined {
  const leading = /(?:前|排名前|top|最多的|最高的|最低的)\s*(\d{1,3})/i.exec(question);
  // 只认「笔/条/行/单」：「个/月/年」出现在数字后面通常是「近 3 个月」这类时间话术。
  const trailing = /(\d{1,3})\s*(?:笔|条|行|单)/.exec(question);
  const value = Number(leading?.[1] ?? trailing?.[1] ?? '');
  return value > 0 && value <= 1000 ? value : undefined;
}

function columnOf(pool: Pool, ref: ColumnRef): ColumnInfo | undefined {
  const table = pool.tables.find((item) => item.name.toLowerCase() === ref.table.toLowerCase());
  return table ? groundedColumns(table, pool.grounding).find((column) => column.name === ref.column) : undefined;
}

function refLabel(pool: Pool, ref: ColumnRef): string {
  const table = pool.tables.find((item) => item.name.toLowerCase() === ref.table.toLowerCase());
  const column = columnOf(pool, ref);
  return table && column ? columnLabel(pool.grounding.bundle, table, column) : ref.column;
}

/** 在候选表里找一列：主表优先，其次 JOIN 进来的表，避免把 orders.status 认成 users.status。 */
function findColumn(word: string, pool: Pool, main: TableInfo): ColumnRef | undefined {
  const term = word.trim();
  if (!term) return undefined;
  const ordered = [main, ...pool.tables.filter((table) => table.name !== main.name)];
  for (const table of ordered) {
    const column = matchColumn(term, table, pool.grounding);
    if (column) return { table: table.name, column: column.name };
  }
  const p = term.toLowerCase();
  for (const table of ordered) {
    const direct = groundedColumns(table, pool.grounding).find((column) => column.name.toLowerCase() === p);
    if (direct) return { table: table.name, column: direct.name };
  }
  return undefined;
}

const DIMENSION_CN = /(?:按照?|依照|每个|各个|各|分别按?|不同|分组(?:按|为)?|统计按)\s*([^，,。；;\s问]{1,14})/;
const DIMENSION_EN = /(?:by|per|each|grouped\s+by)\s+([A-Za-z_][A-Za-z0-9_]{1,20})/i;

/**
 * 常见业务说法 → 物理列名。库里既没有注释也没配别名时（内置 demo 库、老库）的最后一级兜底；
 * 有注释或别名时接地层会先命中，轮不到这张表。
 */
const COLUMN_WORDS: Record<string, string> = {
  状态: 'status',
  类型: 'type',
  类别: 'category',
  分类: 'category',
  渠道: 'channel',
  来源: 'source',
  等级: 'level',
  级别: 'level',
  城市: 'city',
  地区: 'region',
  省份: 'province',
  国家: 'country',
  名称: 'name',
  标题: 'title',
  金额: 'amount',
  价格: 'price',
  数量: 'quantity',
  年龄: 'age',
  邮箱: 'email',
  手机: 'phone',
  用户: 'user',
  产品: 'product',
  时间: 'created_at',
  日期: 'created_at',
};

function prefixes(phrase: string): string[] {
  const cleaned = phrase.replace(/[\s]/g, '');
  if (!cleaned) return [];
  const out: string[] = [];
  // 「用户的城市」这种带所属关系的说法，真正要的是最后一段；整段和尾段都要试。
  const tail = cleaned.split(/的/).filter(Boolean);
  const push = (segment: string, start: number, end: number): void => {
    if (alignedInSegment(segment, start, end)) out.push(segment.slice(start, end));
  };
  for (const segment of [...tail, cleaned]) {
    for (let length = Math.min(segment.length, 8); length >= 1; length--) push(segment, 0, length);
    for (let start = Math.max(0, segment.length - 8); start < segment.length - 1; start++) push(segment, start, segment.length);
  }
  const unique = [...new Set(out)];
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

/**
 * 截断只为中文而设（词与词之间没有边界）：英文从单词中间切一刀会造出假列名，
 * 「paid」切成「id」就被当成 orders.id，把整句的度量都带错了。
 */
function alignedInSegment(segment: string, start: number, end: number): boolean {
  const word = (ch: string | undefined): boolean => Boolean(ch && /[a-z0-9_]/i.test(ch));
  return !(word(segment[start - 1]) && word(segment[start])) && !(word(segment[end - 1]) && word(segment[end]));
}

/** 先按整段话术找列，找不到再从最长片段开始缩：「订单状态」优先于「状态」。 */
function findByPhrase(phrase: string, pool: Pool, main: TableInfo): ColumnRef | undefined {
  for (const word of [phrase, ...prefixes(phrase)]) {
    const direct = findColumn(word, pool, main);
    if (direct) return direct;
    const mapped = COLUMN_WORDS[word];
    if (mapped) {
      const hit = findColumn(mapped, pool, main);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * 「各城市的已支付订单」残片是「城市已支付」：整段去比列名会先命中 city，
 * 于是「已支付」这个条件被静默丢掉，数字看着合理其实少了一半。
 * 剥掉最短的那段列名前缀，剩下的才是取值；剥不出一个仍然像取值的残片就原样返回，交给后面的守卫。
 */
/** 这一段说法是不是正好就是某列的名字/别名/注释：剥前缀只能用精确匹配，模糊前缀会把「城市和月」也当成列。 */
function exactColumnWord(word: string, pool: Pool): boolean {
  return pool.tables.some((table) =>
    groundedColumns(table, pool.grounding).some((column) => {
      const meta = pool.grounding.bundle?.columnMeta[table.name.toLowerCase()]?.[column.name];
      return [column.name, meta?.alias?.trim(), column.comment?.trim()].some((surface) => Boolean(surface && surface.length >= 2 && surface.toLowerCase() === word.toLowerCase()));
    }),
  );
}

function stripColumnPrefix(raw: string, pool: Pool, main: TableInfo): string {
  for (let end = 2; end <= raw.length - 2; end++) {
    const head = raw.slice(0, end);
    if (!exactColumnWord(head, pool)) continue;
    const rest = raw.slice(end);
    // 残片里还挂着另一根轴、时间粒度或聚合动词（「城市和月份看」）时不是在说取值：两轴说法交给维度解析。
    if (/[和与跟、×]|(?:月份?|周|天|日|年|季度)|(?:看|画|绘|统计|汇总|合计|金额|数量)/.test(rest)) continue;
    if (rest.length >= 2 && !findByPhrase(rest, pool, main)) return rest;
  }
  return raw;
}

/**
 * 用户点名的图种。没点名时返回 undefined，由上层按数据形态选（chartSuitability 是唯一口径）。
 * 散点走自己的逐行取数模板，不在聚合规划器里。
 */
export function chartKindOf(question: string): ChartKind | undefined {
  if (/(热力|heatmap)/i.test(question)) return 'heatmap';
  if (/(雷达|radar)/i.test(question)) return 'radar';
  if (/(堆叠|堆积|stacked)/i.test(question)) return 'stacked';
  if (/(散点|scatter|相关性|correlation)/i.test(question)) return 'scatter';
  if (/(饼|占比|构成|pie)/i.test(question)) return 'pie';
  if (/(折线|趋势|走势|line|trend)/i.test(question)) return 'line';
  if (/(柱状|条形|bar)/i.test(question)) return 'bar';
  return undefined;
}

/** 两根轴之间的连接词：「按城市和渠道」「城市 × 渠道」。 */
const AXIS_CONNECTOR = /(?:×|\b[xX]\b|和|与|跟|以及|、|,|，)/;
const DIMENSION_PAIR = /(?:按照?|依照|每个|各个|各|分别按?|不同|分组(?:按|为)?|统计按)\s*([^，,。；;问]{1,30})/;

function cleanDimension(raw: string, question: string): string | undefined {
  // 「按月看金额走势」的「按」是粒度，不是维度：这里开头就是时间单位说明这句话在说分桶，
  // 继续解析会把「看订单金额」当成列名，凭空多出一个 GROUP BY。
  if (grainPhrase(question) && /^(?:每|各)?(?:小时|天|日|周|月|季|季度|年)/.test(raw)) return undefined;
  // 「按状态统计订单的金额合计」里，维度词到第一个聚合动词就结束；留着尾巴会匹配到别的列。
  const cut = raw.split(/(?:统计|汇总|分布|占比|合计|平均|排名|排序|趋势|走势|多少|求和|明细|看|画|绘|热力|heatmap|雷达|radar|堆叠|stacked)/i)[0] ?? '';
  // 「按城市的金额合计」要的是城市：尾巴上那段「的金额」是度量说法，留着会让整段先去比
  // 列注释，结果命中 amount_cents 而不是 city。只在带「的」时剥掉，「按金额统计」本身仍以金额分组。
  // 「各城市的订单金额合计」同理：度量前可以带限定词（订单/交易/消费），「的」已经说明尾巴不是维度。
  const head = cut.replace(/的[^的]{0,8}(?:金额|数量|总额|总金额|销售额|销量|收入|支出|成本|利润|价格|笔数|单量)$/, '');
  const text = head.replace(/[呢吧啊嘛了]+$/, '').replace(/[\s的]+$/g, '');
  return text.length >= 1 ? text : undefined;
}

function dimensionPhrase(question: string): string | undefined {
  const raw = DIMENSION_CN.exec(question)?.[1] ?? DIMENSION_EN.exec(question)?.[1];
  return raw ? cleanDimension(raw, question) : undefined;
}

/**
 * 热力图的两根分类轴：「按城市和渠道」「城市 × 月份」。
 * 只返回说法，落列由 dimensionRef 那套（含跨表 JOIN）负责；凑不出两根就交给上层追问，
 * 不拿同一根轴充数——那会画出一条对角线，看着像图其实没有信息。
 */
function dimensionPair(question: string): [string, string] | undefined {
  const raw = DIMENSION_PAIR.exec(question)?.[1];
  if (!raw || !AXIS_CONNECTOR.test(raw)) return undefined;
  const parts = raw.split(AXIS_CONNECTOR).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const first = cleanDimension(parts[0]!, question);
  const second = parts.slice(1).map((part) => cleanDimension(part, question)).find(Boolean);
  return first && second && first !== second ? [first, second] : undefined;
}

/**
 * 问题里点到的数值列，按出现先后排。堆叠/雷达要多个同单位度量（「金额和数量」），
 * 逐个 split 再找列会被前缀里的维度词截胡（「按城市看金额」先命中 city），所以直接扫列名/别名/注释。
 */
function mentionedMeasures(question: string, pool: Pool, main: TableInfo): ColumnRef[] {
  const p = question.toLowerCase();
  const hits: Array<{ ref: ColumnRef; at: number }> = [];
  for (const table of [main, ...pool.tables.filter((item) => item.name !== main.name)]) {
    const fk = foreignKeyColumnsOf(table);
    for (const column of groundedColumns(table, pool.grounding)) {
      if (column.primaryKey || fk.has(column.name.toLowerCase()) || !isNumericColumn(column)) continue;
      const meta = pool.grounding.bundle?.columnMeta[table.name.toLowerCase()]?.[column.name];
      const words = [column.name, meta?.alias?.trim(), column.comment?.trim()].filter((word): word is string => Boolean(word && word.length >= 2));
      const at = Math.min(...words.map((word) => p.indexOf(word.toLowerCase())).filter((index) => index >= 0));
      if (Number.isFinite(at)) hits.push({ ref: { table: table.name, column: column.name }, at });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.ref);
}

/** 「按城市堆叠各状态的金额」：堆叠的分项来自另一个分类列（各状态→status）。 */
function stackSplitPhrase(question: string): string | undefined {
  const raw = /各\s*([^，,。；;\s]{1,12})/.exec(question)?.[1];
  if (!raw) return undefined;
  return cleanDimension(raw, question);
}

/** 时间粒度词单独当一根轴（「按城市和月份看热力图」）。 */
const GRAIN_CN: Record<TimeBucketGrain, string> = { hour: '小时', day: '天', week: '周', month: '月', quarter: '季度', year: '年' };
const AXIS_GRAIN: Record<string, TimeBucketGrain> = { 小时: 'hour', 天: 'day', 日: 'day', 周: 'week', 星期: 'week', 月: 'month', 月份: 'month', 季度: 'quarter', 年: 'year', 年份: 'year' };

function axisGrain(word: string): TimeBucketGrain | undefined {
  return AXIS_GRAIN[word] ?? grainPhrase(word);
}

/**
 * 堆叠的每一段落成一条条件聚合。
 *
 * 「各状态的金额」→ 每个状态一列（status IN (...) 的 SUM），一条 SQL 出全部段；
 * 「金额和数量」→ 用户直接点了多个度量，按列排开。
 * 状态取值只能来自列注释枚举或有界探测，取不到就问，不硬造字面量。
 */
function stackedMeasures(input: {
  question: string;
  pool: Pool;
  main: TableInfo;
  input: PlanInput;
  dimension: ColumnRef | undefined;
  measure: MeasureSpec | undefined;
  dropped: string[];
}): { measures?: MeasureSpec[]; probe?: PlanProbe; gap?: string } {
  const splitWord = stackSplitPhrase(input.question);
  if (splitWord) {
    const split = findByPhrase(splitWord, input.pool, input.main);
    if (split && !sameRef(split, input.dimension)) {
      const values = knownValues(split, input.pool, input.input);
      if (values.length >= 2) {
        const fn = input.measure?.fn === 'count' ? 'count' : input.measure?.fn ?? 'count';
        return {
          measures: values.slice(0, 6).map((value) => ({
            fn,
            col: input.measure?.col,
            where: { col: split, values: [value] },
            alias: String(value),
          })),
        };
      }
      // 注释里没有枚举：发一次有界探测拿真实取值，再按真实取值拆段。
      if (!input.input.replay && !input.input.probeDone) {
        return { probe: { table: split.table, column: split.column, raw: splitWord } };
      }
      return { gap: `堆叠图要按 \`${split.table}.${split.column}\` 的取值拆段，但我没读到它的实际取值。先把取值说明白（例如「已支付、已退款」），或者换用另一个分类列。` };
    }
  }
  const named = mentionedMeasures(input.question, input.pool, input.main).filter((ref) => !sameRef(ref, input.dimension));
  if (named.length >= 2) {
    const fn = aggregateFn(input.question) ?? 'sum';
    return { measures: named.slice(0, 5).map((col) => ({ fn, col })) };
  }
  return { gap: '堆叠图要按一个分类列拆段（例如「各状态的金额」），或者直接点两个及以上的度量列（例如「金额和数量」）。这一问我没认出第二段。' };
}

function sameRef(a: ColumnRef | undefined, b: ColumnRef | undefined): boolean {
  return Boolean(a && b && a.table.toLowerCase() === b.table.toLowerCase() && a.column.toLowerCase() === b.column.toLowerCase());
}

/** 把一句维度说法落成一列：先按列名/别名/注释找，主表没有再看恰好一张关联表并有真实连接路径。 */
function resolveDimensionWord(word: string, pool: Pool, main: TableInfo, visible: TableInfo[], dropped: string[]): ColumnRef | undefined {
  const found = findByPhrase(word, pool, main);
  if (found) return found;
  const bridged = bridgeDimension(word, pool, main, visible);
  if (bridged.ref) return bridged.ref;
  dropped.push(bridged.gap ?? `没有「${word}」这一列`);
  return undefined;
}

function dimensionRef(question: string, pool: Pool, main: TableInfo, visible: TableInfo[], dropped: string[]): { ref?: ColumnRef; gap?: string } {
  const word = dimensionPhrase(question);
  if (word) {
    const found = findByPhrase(word, pool, main);
    if (found) return { ref: found };
    // 维度列常常属于关联表（订单按「用户的城市」分组）。这一列只在一张表里、
    // 而且外键/登记关联真的连得上时才 JOIN；否则照旧说「没有这一列」。
    const bridged = bridgeDimension(word, pool, main, visible);
    if (bridged.gap) return bridged;
    if (bridged.ref) return { ref: bridged.ref };
    dropped.push(`没有「${word}」这一列`);
    return {};
  }
  if (GROUP_WORDS.test(question)) {
    const picked = pickDimension(main, question, pool.grounding);
    if (picked) return { ref: { table: main.name, column: picked.name } };
  }
  return {};
}

const VALUE_EQ_CN = /([^，,。；;\s]{0,12})(?:为|是|等于)\s*([^，,。；;]{1,20})/;
const VALUE_EQ_EN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|==|is|equals)\s*["']?([A-Za-z0-9_%\u4e00-\u9fff-]{1,24})["']?/i;
const VALUE_LIKE = /(?:包含|含有|名叫|叫做|开头是)\s*([^，,。；;]{1,20})/;

interface ValueSlot {
  columnHint?: string;
  raw: string;
  like: boolean;
}

/**
 * 「已支付订单」这类把取值写在名词前的说法。
 * 只在它既不是聚合/时间/疑问话术、又对不上任何列名、也不是表名/别名的一部分时才当取值候选，
 * 且宁可多发一次有界只读探测，也不硬猜 SQL 字面量。
 */
const LEAD_STOP = /(?:统计|汇总|查询|查一下|看看|帮我|请|计算|分析|一共|总共|分别|按照?|每个|各个|各|不同|金额|数量|总数|趋势|分布|占比|合计|平均|排名|最|近|最近|过去|未来|今年|去年|所有|全部|这些|那些)/g;

function tableNouns(main: TableInfo, grounding: GroundingOptions): string[] {
  const alias = grounding.bundle?.tableMeta[main.name.toLowerCase()]?.alias?.trim();
  return [alias, main.comment, DEFAULT_NOUNS[main.name.toLowerCase()]].filter((noun): noun is string => Boolean(noun && noun.length >= 2));
}

const DEFAULT_NOUNS: Record<string, string> = { orders: '订单', users: '用户', products: '产品', tasks: '任务', events: '事件', logs: '日志', payments: '付款' };

/**
 * 「销售订单」整体是某张表的表名/别名时，不该把「销售」拆成取值。
 * 只认整体相等或表名以它开头：反向包含必然成立（拼接串当然含「订单」），会把所有前置取值都吃掉。
 */
function isPartOfTableName(raw: string, noun: string, pool: Pool): boolean {
  const joined = `${raw}${noun}`.toLowerCase();
  return pool.tables.some((table) => [table.name, ...tableNouns(table, pool.grounding)].some((name) => name.toLowerCase() === joined || name.toLowerCase().startsWith(joined)));
}

function valueSlots(question: string, pool: Pool, main: TableInfo): ValueSlot[] {
  const out: ValueSlot[] = [];
  const en = VALUE_EQ_EN.exec(question);
  if (en) out.push({ columnHint: en[1], raw: en[2], like: false });
  const like = VALUE_LIKE.exec(question);
  if (like?.[1]) out.push({ raw: like[1].trim(), like: true });
  const cn = VALUE_EQ_CN.exec(question);
  const value = cn?.[2]?.trim();
  if (value && !NOT_A_VALUE.test(value) && !grainPhrase(value) && numeric(value) === undefined) {
    out.push({ columnHint: cn?.[1]?.trim() || undefined, raw: value, like: false });
  }

  const dimension = dimensionPhrase(question);
  for (const noun of tableNouns(main, pool.grounding)) {
    // 允许空格：「统计 paid 订单」里的取值前后是有空格的，只允许中文连续字符会漏掉英文取值。
    const before = new RegExp(`([^，,。；;]{1,20})(?:的)?${noun}`).exec(question)?.[1];
    if (!before) continue;
    // 「近 3 个月已支付订单」的取值前面还挂着时间窗：不先摘掉，剩下的「3个月已支付」
    // 会因为开头那个数字被当成数量话术整段丢掉。
    const cleaned = (before.split(LEAD_STOP).filter(Boolean).pop() ?? '').replace(/[\s的]+/g, '').replace(SEQUENCE_PREFIX, '').replace(/^\d*[个]?(?:月|周|天|日|年|小时|分钟|季度)/, '');
    // 「各城市的已支付订单」里维度词和取值是粘在一起的：维度已经由 dimensionRef 解析（必要时 JOIN），
    // 残片「城市已支付」留着会先命中 city 这一列，整条取值被当成列名丢掉——数字就少了「已支付」这个条件。
    // 只在本轮真的点了维度时才剥，且剥最短的那段列名：「城市已支付」剥成「已支付」，而不是整段当列名。
    const raw = dimension ? stripColumnPrefix(cleaned, pool, main) : cleaned;
    if (raw.length < 2 || raw.length > 12) continue;
    if (NOT_A_VALUE.test(raw) || TIME_FRAGMENT.test(raw) || grainPhrase(raw) || numeric(raw) !== undefined) continue;
    if (raw === dimension || findByPhrase(raw, pool, main)) continue;
    if (isPartOfTableName(raw, noun, pool)) continue;
    // 「用户的城市」是在说另一张表的列，不是取值：交给 JOIN + 维度解析，别在这里当字面量。
    if (otherTableNoun(raw, main, pool)) continue;
    if (out.some((slot) => slot.raw === raw)) continue;
    out.push({ raw, like: false });
  }

  // 「只看已退款的」这种追问里没有表名可挂，取值只能整句摘。
  // 先排掉换粒度/换分组的做法（「那换成按月呢」「那按城市呢」）：那些句子该走
  // 继承 + 维度解析，硬摘残片会凭空造出一个查不到东西的条件。
  if (!out.length && FOLLOW_UP.test(question) && !grainPhrase(question) && !dimensionPhrase(question)) {
    const residue = question
      .replace(/^(?:那就|那|则|再|同样|其中)?(?:就?只?看|只要|换成|改为)?/, '')
      .replace(/[呢吧啊嘛]?[？?。！]?$/, '')
      .trim();
    const raw = (residue.split(LEAD_STOP).filter(Boolean).pop() ?? '').replace(/[\s的]+/g, '');
    if (raw.length >= 2 && raw.length <= 12 && !NOT_A_VALUE.test(raw) && !TIME_FRAGMENT.test(raw) && !grainPhrase(raw) && numeric(raw) === undefined && !findByPhrase(raw, pool, main) && !namesAnyTable(raw, pool)) {
      out.push({ raw, like: false });
    }
  }
  return out;
}

/** 残片其实是在说一张表（「全部订单的金额合计」的「订单」）：那是主语，不是任何一列的取值。 */
function namesAnyTable(raw: string, pool: Pool): boolean {
  const p = raw.toLowerCase();
  for (const table of pool.tables) {
    if (table.name.toLowerCase() === p) return true;
    if (tableNouns(table, pool.grounding).some((noun) => noun.toLowerCase() === p)) return true;
  }
  return Object.values(DEFAULT_NOUNS).some((noun) => noun.toLowerCase() === p);
}

/** 「先算总额，再按城市拆分」这类承接词：挂在句首是指令，不是任何一列的取值。 */
const SEQUENCE_PREFIX = /^(?:首先|先|再来?|再|然后|接着|最后|以及|并且|同时|并)/;

function otherTableNoun(raw: string, main: TableInfo, pool: Pool): boolean {
  return pool.tables.some(
    (table) =>
      table.name !== main.name &&
      tableNouns(table, pool.grounding).some((noun) => raw.includes(noun)) ||
      Object.entries(DEFAULT_NOUNS).some(([name, noun]) => name !== main.name.toLowerCase() && raw.includes(noun)),
  );
}

/** 话术取值 → 真实取值：忽略大小写完全相同优先，其次互为包含。 */
function resolveValue(raw: string, values: Array<string | number>): string | number | undefined {
  const target = raw.trim().toLowerCase();
  if (!target) return undefined;
  const exact = values.find((value) => String(value).trim().toLowerCase() === target);
  if (exact !== undefined) return exact;
  return values.find((value) => {
    const text = String(value).trim().toLowerCase();
    return text.length >= 2 && (text.includes(target) || target.includes(text));
  });
}

function numeric(text: string): number | undefined {
  const match = /(-?\d+(?:\.\d+)?)/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function rangeFilter(question: string, ref: ColumnRef): FilterSpec | undefined {
  const between = /(?:介于|从)\s*(-?\d+(?:\.\d+)?)\s*(?:到|至|~)\s*(-?\d+(?:\.\d+)?)/.exec(question);
  if (between) return { col: ref, op: 'between', values: [Number(between[1]), Number(between[2])] };
  const upper = /(?:小于等于|不超过|不高于|以内|最多|<=|小于|低于|不足|少于)\s*(-?\d+(?:\.\d+)?)/.exec(question);
  if (upper) {
    const strict = /(小于|低于|不足|少于)/.test(upper[0]) && !/(小于等于|不超过|不高于|以内|最多)/.test(upper[0]);
    return { col: ref, op: strict ? 'lt' : 'lte', values: [Number(upper[1])] };
  }
  const lower = /(?:大于等于|不低于|至少|不少于|以上|>=|大于|超过|高于)\s*(-?\d+(?:\.\d+)?)/.exec(question);
  if (lower) {
    const strict = /(大于|超过|高于)/.test(lower[0]) && !/(大于等于|不低于|至少|不少于|以上)/.test(lower[0]);
    return { col: ref, op: strict ? 'gt' : 'gte', values: [Number(lower[1])] };
  }
  return undefined;
}

function nullFilter(question: string, pool: Pool, main: TableInfo, dropped: string[]): FilterSpec | undefined {
  const notNull = /(不为空|非空|有值|not null)/i.test(question);
  if (!notNull && !/(为空|空值|没有值|没填|is null|missing)/i.test(question)) return undefined;
  const word = /([^，,。；;\s]{1,12})(?:为空|是空|不是空|非空|有值)/i.exec(question)?.[1];
  const found = word ? findColumn(word, pool, main) : undefined;
  if (found) return { col: found, op: notNull ? 'not_null' : 'is_null' };
  const first = groundedColumns(main, pool.grounding).find((column) => !column.primaryKey && column.nullable);
  if (!first) return undefined;
  dropped.push('只说了空值，我按第一个可空列来判');
  return { col: { table: main.name, column: first.name }, op: notNull ? 'not_null' : 'is_null' };
}

function aggregateFn(question: string): MeasureSpec['fn'] | undefined {
  if (DISTINCT_WORDS.test(question)) return 'count_distinct';
  if (SUM_WORDS.test(question)) return 'sum';
  if (AVG_WORDS.test(question)) return 'avg';
  if (MIN_WORDS.test(question)) return 'min';
  if (MAX_WORDS.test(question)) return 'max';
  if (COUNT_WORDS.test(question)) return 'count';
  return undefined;
}

/** 去掉聚合/分组/时间话术，剩下的部分才是列名候选。 */
function columnWords(question: string): string {
  const grainSource = GRAIN_PHRASES.map(([pattern]) => pattern.source).join('|');
  return question
    .replace(new RegExp(grainSource, 'i'), ' ')
    .replace(DISTINCT_WORDS, ' ')
    .replace(SUM_WORDS, ' ')
    .replace(AVG_WORDS, ' ')
    .replace(MIN_WORDS, ' ')
    .replace(MAX_WORDS, ' ')
    .replace(COUNT_WORDS, ' ')
    .slice(0, 80);
}

function measureOf(question: string, pool: Pool, main: TableInfo, dimension: ColumnRef | undefined, dropped: string[]): MeasureSpec | undefined {
  const fn = aggregateFn(question);
  const named = findByPhrase(columnWords(question), pool, main);
  const namedNumeric = named ? columnOf(pool, named) : undefined;

  if (fn === 'count') return { fn: 'count' };
  if (fn === 'count_distinct') return { fn: 'count_distinct', col: named ?? dimension };

  if (fn && named && namedNumeric && isNumericColumn(namedNumeric)) return { fn, col: named };
  if (fn) {
    const fallback = pickMeasure(main, question, pool.grounding);
    if (!fallback) {
      dropped.push(`\`${main.name}\` 里没有可用于 ${fn.toUpperCase()} 的数值列`);
      return undefined;
    }
    return { fn, col: { table: main.name, column: fallback.name } };
  }
  return undefined;
}

function timeRef(question: string, pool: Pool, main: TableInfo): ColumnRef | undefined {
  for (const table of [main, ...pool.tables.filter((item) => item.name !== main.name)]) {
    const column = pickTimeColumn(table, question, pool.grounding);
    if (column) return { table: table.name, column: column.name };
  }
  return undefined;
}

function detailRefs(pool: Pool, main: TableInfo, measure: MeasureSpec | undefined): { refs: ColumnRef[]; orderRef: ColumnRef | undefined } {
  const columns = groundedColumns(main, pool.grounding);
  const fk = foreignKeyColumnsOf(main);
  const out: ColumnRef[] = [];
  const push = (ref: ColumnRef | undefined): void => {
    if (ref && !out.some((item) => item.table === ref.table && item.column === ref.column)) out.push(ref);
  };
  for (const column of columns.filter((item) => item.primaryKey)) push({ table: main.name, column: column.name });
  if (measure?.col) push(measure.col);
  for (const column of columns.filter((item) => isNumericColumn(item) && !item.primaryKey && !fk.has(item.name.toLowerCase())).slice(0, 2)) push({ table: main.name, column: column.name });
  for (const column of columns.filter((item) => /name|title|subject/i.test(item.name)).slice(0, 1)) push({ table: main.name, column: column.name });
  const time = columns.find(isTimeColumn);
  if (time) push({ table: main.name, column: time.name });
  // 外键列垫到最后：明细里两列 xxx_id 不如一列金额、一列时间有用，凑不满 5 列时再补上。
  for (const column of columns.filter((item) => fk.has(item.name.toLowerCase())).slice(0, Math.max(0, 5 - out.length))) push({ table: main.name, column: column.name });
  const refs = out.slice(0, 5);
  return { refs, orderRef: measure?.col ?? (time ? { table: main.name, column: time.name } : refs[refs.length - 1]) };
}

/** 用户点名的第二张表 → JOIN。路径只能来自外键或手工登记的关联，连不上就问。 */
function connect(question: string, main: TableInfo, visible: TableInfo[], pool: Pool): string | undefined {
  const wanted = visible.filter((table) => table.name !== main.name && mentions(table, question, pool.grounding)).slice(0, 2);
  if (!wanted.length) return undefined;
  const edges = joinEdges(visible, pool.grounding.bundle?.relations ?? []);
  for (const table of wanted) {
    const path = findJoinPath(main.name, table.name, edges);
    if (!path) {
      return `我要把 \`${main.name}\` 和 \`${table.name}\` 连起来，但它们之间既没有外键，也没在「Agent 上下文 → 表关联」里登记。告诉我用哪两个字段连，例如 \`${main.name}.xxx_id = ${table.name}.id\`。`;
    }
    for (const join of path) {
      if (pool.joins.some((item) => item.right === join.right)) continue;
      pool.joins.push(join);
      const added = visible.find((item) => item.name.toLowerCase() === join.right.toLowerCase());
      if (added) pool.tables.push(added);
    }
  }
  return undefined;
}

function mentions(table: TableInfo, question: string, grounding: GroundingOptions): boolean {
  const p = question.toLowerCase();
  if (p.includes(table.name.toLowerCase())) return true;
  return tableNouns(table, grounding).some((noun) => noun.length >= 2 && p.includes(noun.toLowerCase()));
}

/**
 * 维度列不在主表时，沿外键或登记过的关联找一张确实有这一列的表连过来。
 * 只认「恰好一张表有这一列」且「连接路径真实存在」两个条件同时成立：
 * 多张表都有同名列就还有歧义，路径靠猜会静默放大行数，两者都宁可照旧说没有这一列。
 */
function bridgeDimension(word: string, pool: Pool, main: TableInfo, visible: TableInfo[]): { ref?: ColumnRef; gap?: string } {
  const phrases = [word, ...prefixes(word)];
  const owners = visible.filter((table) => table.name !== main.name && phrases.some((phrase) => matchColumn(phrase, table, pool.grounding)));
  if (owners.length !== 1) return {};
  const edges = joinEdges(visible, pool.grounding.bundle?.relations ?? []);
  const path = findJoinPath(main.name, owners[0].name, edges);
  if (!path) {
    return { gap: `「${word}」在 \`${owners[0].name}\` 里，但 \`${main.name}\` 和它之间既没有外键，也没在「Agent 上下文 → 表关联」里登记。告诉我用哪两个字段连，例如 \`${main.name}.xxx_id = ${owners[0].name}.id\`。` };
  }
  for (const join of path) {
    if (pool.joins.some((item) => item.right === join.right)) continue;
    pool.joins.push(join);
    const added = visible.find((item) => item.name.toLowerCase() === join.right.toLowerCase());
    if (added) pool.tables.push(added);
  }
  return { ref: findByPhrase(word, pool, main) };
}

/** 注释/别名里写了候选值时先直接用它，省掉一次探测。 */
function knownValues(ref: ColumnRef, pool: Pool, input: PlanInput): Array<string | number> {
  if (input.probe && input.probe.table === ref.table && input.probe.column === ref.column) return input.probe.values;
  const meta = pool.grounding.bundle?.columnMeta[ref.table.toLowerCase()]?.[ref.column];
  const table = pool.tables.find((item) => item.name.toLowerCase() === ref.table.toLowerCase());
  const column = table ? groundedColumns(table, pool.grounding).find((item) => item.name === ref.column) : undefined;
  // 库里自带的列注释常常就写着取值枚举（「状态：已支付, 已退款」），不必为它发一条探测查询。
  const hint = (meta?.description ?? meta?.alias ?? column?.comment ?? '').replace(/^[^：:]{1,12}[：:]\s*/, '');
  const parts = hint.split(/[、,，/|]/).map((part) => part.trim()).filter((part) => part.length >= 1 && part.length <= 20);
  // 写着 `PAID=已支付` 这类编码对照时，存的到底是码还是中文注释猜不准：让上层发一次探测拿真实值。
  if (parts.some((part) => /[=＝]/.test(part))) return [];
  return parts.length >= 2 ? parts.slice(0, 12) : [];
}

/** 取值对不上任何列名时，退到最像枚举的那一列。 */
function columnForValue(pool: Pool, main: TableInfo): ColumnRef | undefined {
  const ENUM_TYPE = /enum|set|char|varchar|text/i;
  for (const table of pool.tables) {
    const column = groundedColumns(table, pool.grounding).find(
      (item) => !item.primaryKey && ENUM_TYPE.test(item.type) && /(状态|类型|类别|渠道|等级|来源|status|state|type|category|kind|channel)/i.test(`${item.name} ${item.comment ?? ''}`),
    );
    if (column) return { table: table.name, column: column.name };
  }
  const loose = groundedColumns(main, pool.grounding).find((item) => !item.primaryKey && ENUM_TYPE.test(item.type));
  return loose ? { table: main.name, column: loose.name } : undefined;
}

/**
 * 取值过滤。对不上真实取值、且这一列还没探测过时返回一次有界探测——
 * profile_column 只取 top 5 + distinct 计数，代价是一条只读聚合，换来的是「已支付」不再被当成字面量。
 */
function valueFilters(question: string, pool: Pool, main: TableInfo, input: PlanInput, dropped: string[]): { filters: FilterSpec[]; probe?: PlanProbe; unresolved?: { ref: ColumnRef; raw: string; candidates: Array<string | number> } } {
  const filters: FilterSpec[] = [];
  for (const slot of valueSlots(question, pool, main)) {
    const hint = slot.columnHint ? findColumn(slot.columnHint, pool, main) : undefined;
    // 说法本身更像某一列的名字时，不要把它当取值瞎凑条件。
    if (!hint && findColumn(slot.raw, pool, main) && !slot.like) {
      dropped.push(`「${slot.raw}」更像列名而不是取值，这个条件我没加上`);
      continue;
    }
    const ref = hint ?? findColumn(slot.raw, pool, main) ?? columnForValue(pool, main);
    if (!ref) {
      dropped.push(`不确定「${slot.raw}」是哪一列的取值`);
      continue;
    }
    const alreadyProbed = input.probe && input.probe.table === ref.table && input.probe.column === ref.column;
    const candidates = knownValues(ref, pool, input);
    const resolved = resolveValue(slot.raw, candidates);
    if (resolved !== undefined) {
      filters.push({ col: ref, op: slot.like ? 'like' : 'eq', values: [resolved], source: slot.raw });
      continue;
    }
    // 重放只是给追问算焦点，发不出探测查询：对不上真实取值就放弃这个条件。
    // 少继承一个条件只是口径宽一点，硬猜字面量会查出一个看起来合理的空答案。
    if (input.replay) continue;
    const column = columnOf(pool, ref);
    const mayProbe = !slot.like && !alreadyProbed && !input.probeDone && candidates.length < 2 && column && !isNumericColumn(column) && !isTimeColumn(column);
    if (mayProbe) return { filters, probe: { table: ref.table, column: ref.column, raw: slot.raw } };
    if (slot.like) {
      filters.push({ col: ref, op: 'like', values: [slot.raw], source: slot.raw });
      continue;
    }
    // 探测过仍对不上：猜一个保证查空（或查错）的条件比不查更糟，交回上层列出候选让用户挑。
    if (alreadyProbed) return { filters, unresolved: { ref, raw: slot.raw, candidates } };
    filters.push({ col: ref, op: 'eq', values: [slot.raw], source: slot.raw });
  }
  return { filters };
}

/**
 * 反例禁用的列直接从表定义里摘掉：下游每个选列函数（matchColumn / pickMeasure /
 * pickDimension / detailRefs）都只看得见允许的列，不必各自加判断。
 */
function allowedColumns(tables: TableInfo[], forbidden: Forbidden): TableInfo[] {
  if (!forbidden.columns.size) return tables;
  return tables.map((table) => {
    if (isTableForbidden(forbidden, table.name)) return table;
    const kept = (table.columns ?? []).filter((column) => !isColumnForbidden(forbidden, table.name, column.name));
    return kept.length === (table.columns?.length ?? 0) ? table : { ...table, columns: kept };
  });
}

/**
 * 追问沿用的口径：本轮没说的槽位继承上一问，说了的以本轮为准。
 *
 * 只在「本轮没点到任何表」或「点到的还是同一张表」时继承——换表就是换了话题，
 * 把上一问的时间窗和度量带过去会给出一个看起来合理其实无关的数字。
 */
function inheritFrom(focus: QuerySpec | undefined, main: TableInfo): QuerySpec | undefined {
  if (!focus) return undefined;
  if (focus.table.toLowerCase() !== main.name.toLowerCase()) return undefined;
  return focus;
}

/**
 * 解析 + 编译。status 为 gap 时不执行任何查询，只把 gap 这句话问回去；
 * 为 probe 时需要上层先发一次有界只读探测，再带着取值重新规划。
 */
export function planQuery(input: PlanInput): PlanOutcome {
  const { question, engine, grounding } = input;
  const forbidden = input.forbidden ?? NO_FORBIDDEN;
  const usable = allowedColumns(input.tables, forbidden);
  const visible = groundedTables(usable, grounding).filter((table) => !isTableForbidden(forbidden, table.name));
  if (!visible.length) return { status: 'gap', gap: '当前库没有可用的表，或全部被「Agent 上下文」隐藏了。' };

  const spelled = visible.find((table) => namesTable(question, table, grounding));
  const carried = visible.find((table) => table.name.toLowerCase() === (input.focus?.table ?? '').toLowerCase());
  // 追问没点名表时用上一问的表：让打分去猜会挑中碰巧有同名列的另一张表，
  // 「那按城市呢」就答成了 users 的城市分布而不是上一问那份订单口径。
  const main = spelled ?? carried ?? matchTable(question, usable, grounding);
  if (!main) {
    const near = rankTables(question, visible, grounding).slice(0, 6).map((table) => `\`${table.name}\``);
    return { status: 'gap', gap: `我不确定你要查哪张表。${near.length ? `和这个问题最接近的是 ${near.join('、')}，` : ''}说清表名即可。` };
  }
  // 用户维护的反例是硬约束：离线没有模型兜底，只有真的不查才算生效。
  const blocked = forbiddenTableReason(forbidden, main.name);
  if (blocked) return { status: 'gap', gap: `你的业务上下文里登记了这条反例，所以我不查 \`${main.name}\`。\n\n> ${blocked}\n\n要改这张表本身，请到 工具箱 → Agent 上下文 → 术语与示例 调整这条反例；或者告诉我换用哪张表。` };

  // 只有「这句确实是在追问」时才继承：本轮点名了另一张表就是换了话题，
  // 把上一问的条件带过去会给出一个看起来合理其实无关的数字。
  const followUp = !spelled || FOLLOW_UP.test(question);
  const focus = followUp ? inheritFrom(input.focus, main) : undefined;
  const pool: Pool = { tables: [main], joins: [], grounding };
  if (focus) {
    for (const join of focus.joins) {
      const added = visible.find((table) => table.name.toLowerCase() === join.right.toLowerCase());
      if (!added) continue;
      pool.joins.push(join);
      pool.tables.push(added);
    }
  }
  const joinGap = connect(question, main, visible, pool);
  if (joinGap) return { status: 'gap', gap: joinGap };

  const dropped: string[] = [];
  const filters: FilterSpec[] = [];
  const chart = chartKindOf(question);
  const period = resolvePeriod({ topic: question, now: input.now });
  const bucketGrain = grainPhrase(question);
  const windowed = period.source !== 'default';

  const time = bucketGrain || windowed || TREND_WORDS.test(question) ? timeRef(question, pool, main) : undefined;
  if (windowed && time) {
    filters.push({ col: time, op: 'between', window: { from: period.current.from, to: period.current.to }, source: period.current.label });
  }

  const dimension = dimensionRef(question, pool, main, visible, dropped);
  if (dimension.gap) return { status: 'gap', gap: dimension.gap };
  const measure = measureOf(question, pool, main, dimension.ref, dropped);

  const values = valueFilters(question, pool, main, input, dropped);
  if (values.probe) return { status: 'probe', probe: values.probe };
  if (values.unresolved) {
    const { ref, raw, candidates } = values.unresolved;
    const options = candidates.length ? candidates.map((value) => `\`${value}\``).join('、') : '(这张表没查出常见取值)';
    return {
      status: 'gap',
      gap: `我把 \`${ref.table}.${ref.column}\` 的实际取值读回来了，里面没有「${raw}」。这张表常见取值是 ${options}。你要的是其中哪一个，还是这一列本身选错了？`,
    };
  }
  filters.push(...values.filters);

  const range = measure?.col ? rangeFilter(question, measure.col) : undefined;
  if (range) filters.push(range);
  else {
    const nulls = nullFilter(question, pool, main, dropped);
    if (nulls) filters.push(nulls);
  }

  // 追问继承：本轮没说的才继承，说了的以本轮为准。继承列必须本轮仍然可见，
  // 否则（表被隐藏、列被反例禁掉）宁可不继承，也不能编译出一条查不到的 SQL。
  const seen = new Set(pool.tables.map((item) => item.name.toLowerCase()));
  const alive = (ref: ColumnRef | undefined): boolean => Boolean(ref && seen.has(ref.table.toLowerCase()) && columnOf(pool, ref));
  if (focus && !/^(全部|所有|不限)|去掉(上面|刚才)?的?(?:条件|筛选)/.test(question)) {
    const touched = new Set(filters.map((filter) => `${filter.col.table.toLowerCase()}.${filter.col.column.toLowerCase()}`));
    for (const filter of focus.filters) {
      if (!alive(filter.col)) continue;
      const key = `${filter.col.table.toLowerCase()}.${filter.col.column.toLowerCase()}`;
      // 本轮又点了同一列就以本轮为准；时间窗只在本轮也给了窗口时才让位。
      if (touched.has(key) && (!filter.window || filters.some((item) => item.window))) continue;
      filters.push(filter);
    }
  }

  const limit = limitOf(question);
  const rowLimit = ROW_LIMIT.exec(question);
  const detailLimit = rowLimit ? Number(rowLimit[1] ?? rowLimit[2]) : undefined;
  const isDetail = Boolean(DETAIL_WORDS.test(question) || detailLimit);
  // 「全部订单的金额合计」「去掉刚才的条件」是在清空上一问的口径，不是接着它往下说。
  const reset = /^(全部|所有|不限)|去掉(上面|刚才)?的?(?:条件|筛选|限制)/.test(question);
  // 本轮要了一根新轴（点名维度、或「看分布」这种兜底维度）就不再把上一问的时间桶拖上，
  // 否则「那按城市呢」会答成「每月每城市」这张谁都没要的二维表。
  const ownAxis = Boolean(dimension.ref);
  const spec: QuerySpec = { table: main.name, joins: pool.joins, filters, groupBy: [], measures: [] };

  if (chart === 'heatmap') {
    // 热力图不是 (x, y) 序列：两根分类轴 + 一个度量。缺一根就定点追问，
    // 拿同一根轴凑两遍会画出一条对角线，看着像图其实没有信息。
    const pair = dimensionPair(question);
    if (!pair) return { status: 'gap', gap: '热力图需要两根分类轴，例如「按城市和渠道统计金额热力图」。' };
    const dims: ColumnRef[] = [];
    let bucket: TimeBucketSpec | undefined;
    for (const word of pair) {
      const grain = axisGrain(word);
      if (grain && !bucket) {
        // 「按城市和月份」的时间轴不一定挂时间窗：这时 timeRef 还没算过，就地取一次。
        const bucketCol = time ?? timeRef(question, pool, main);
        if (bucketCol) {
          bucket = { col: bucketCol, grain };
          continue;
        }
      }
      const ref = resolveDimensionWord(word, pool, main, visible, dropped);
      if (ref && !dims.some((item) => sameRef(item, ref))) dims.push(ref);
    }
    if (dims.length + (bucket ? 1 : 0) < 2) {
      return { status: 'gap', gap: `热力图要两根不同的分类轴，这一问我只认出 ${dims.map((ref) => `\`${ref.column}\``).join('、') || '零根'}${bucket ? `，外加按${GRAIN_CN[bucket.grain]}分桶` : ''}。另一根按哪一列分组？` };
    }
    if (bucket) spec.timeBucket = bucket;
    spec.groupBy = dims.slice(0, bucket ? 1 : 2);
    spec.measures = [measure ?? { fn: 'count' }];
    spec.limit = 200;
  } else if (isDetail) {
    const detail = detailRefs(pool, main, measure);
    // 「换成前 20 笔」这类追问没点名新列：沿用上一问的投影和排序列，别换一套列。
    const carried = !dimension.ref && !measure ? (focus?.detail ?? []).filter(alive) : [];
    spec.detail = carried.length ? carried : detail.refs;
    spec.orderByRef = focus?.orderByRef && alive(focus.orderByRef) && carried.length ? focus.orderByRef : detail.orderRef;
    spec.orderBy = { alias: 'value', desc: !MIN_WORDS.test(question) };
    spec.limit = detailLimit ?? limit ?? 10;
  } else {
    if (time && bucketGrain) spec.timeBucket = { col: time, grain: bucketGrain };
    else if (time && windowed) spec.timeBucket = { col: time, grain: GRAIN_FROM_TIME[period.grain] };
    // 「那按城市呢」是要换一根轴：本轮点了维度就别再把上一问的时间桶拖上，否则答成「每月每城市」。
    else if (focus?.timeBucket && !bucketGrain && !windowed && !ownAxis && !reset && !TREND_WORDS.test(question) && alive(focus.timeBucket.col)) spec.timeBucket = focus.timeBucket;
    if (dimension.ref) spec.groupBy = [dimension.ref];
    // 「只看已支付的」这类追问只改条件，分组跟着上一问走；上一问同时有时间和维度时两个都留，
    // 「每月每城市」是它原本的口径。纯计数不继承分组，否则「有多少行」会变成一张分组表。
    else if (focus?.groupBy.length && !reset && aggregateFn(question) !== 'count' && focus.groupBy.every(alive)) spec.groupBy = focus.groupBy;
    spec.measures = measure ? [measure] : !reset && focus?.measures.length && focus.measures.every((item) => !item.col || alive(item.col)) ? focus.measures : [{ fn: 'count' }];
    spec.limit = limit ?? (spec.timeBucket ? 40 : spec.groupBy.length ? 20 : 1);
    // 降序是编译器给的默认；只有「最低/最少」这类问法需要反过来。
    if (MIN_WORDS.test(question)) spec.orderBy = { alias: 'value', desc: false };
  }

  // 堆叠要「每一段一列」：要么按一个分类列拆（各状态的金额），要么用户直接点了两个同单位度量。
  if (chart === 'stacked' && !isDetail) {
    const stack = stackedMeasures({ question, pool, main, input, dimension: dimension.ref, measure, dropped });
    if (stack.gap) return { status: 'gap', gap: stack.gap };
    if (stack.probe) return { status: 'probe', probe: stack.probe };
    spec.measures = stack.measures!;
    spec.limit = 24;
  }
  // 雷达图 3–8 根轴：超了会被 chartSuitability 降级，不如先截到上限。
  // 「金额和数量」这种多点名的度量按 ys 一并传，和云端模型的用法一致。
  if (chart === 'radar' && !isDetail) {
    const named = mentionedMeasures(question, pool, main).filter((ref) => !sameRef(ref, dimension.ref));
    if (named.length >= 2) spec.measures = named.slice(0, 5).map((col) => ({ fn: aggregateFn(question) ?? 'sum', col }));
    if (spec.groupBy.length && spec.measures.length === 1) spec.limit = 8;
  }

  const compiled = compileQuery(engine, spec);
  const tableText = tableLabel(grounding.bundle, main);
  const axisRefs = spec.detail ?? [...(spec.timeBucket ? [spec.timeBucket.col] : []), ...spec.groupBy];
  const valueLabel = (m: MeasureSpec): string => (m.col ? refLabel(pool, m.col) : `${tableText}数`);
  const labels = [...axisRefs.map((ref) => refLabel(pool, ref)), ...spec.measures.map(valueLabel)];
  return {
    status: 'ready',
    spec,
    compiled,
    labels,
    axisLabel: axisRefs[0] ? refLabel(pool, axisRefs[0]) : undefined,
    measureLabel: spec.measures[0] ? valueLabel(spec.measures[0]) : undefined,
    dropped: dropped.length ? dropped : undefined,
    ...(chart ? { chart } : {}),
  };
}
