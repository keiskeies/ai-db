/**
 * 时间窗解析：报表里的「本周 / 上月 / 近 90 天」必须由网关确定性地翻译成日期边界，
 * 而不是让模型猜「今天」是几号——它没有时钟，猜出来的区间会让整份报告口径失真。
 *
 * 约定：
 * - from / to 都是 `YYYY-MM-DD`，且 **to 是包含在内的最后一天**（拼 SQL 时转成半开区间）。
 * - 未结束的自然周期（本月 / 本季度 / 今年）截止到今天，并用 `partial` 标出；
 *   此时基线取上一周期的「同期切片」，长度与本期一致，避免把「还没过完」读成下滑。
 */

export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** 这个数字窗从哪来：用户显式给的、话术里解析的、还是兜底的。 */
export type PeriodSource = 'explicit' | 'phrase' | 'default';

export interface TimeWindow {
  from: string;
  to: string;
  /** 业务读法，例如「本月（2026-11-01 ~ 2026-11-02）」。 */
  label: string;
}

export interface ResolvedPeriod {
  current: TimeWindow;
  /** 同口径的对比基线；无法给出可比基线时缺省。 */
  previous?: TimeWindow;
  /** 趋势图的建议分桶粒度，按跨度推断，与 current 的自然周期无关。 */
  grain: TimeGrain;
  /** 本期是否还没走完（结束日就是今天）。决定「环比」该怎么读。 */
  partial: boolean;
  source: PeriodSource;
  /** 解析时使用的「今天」，让提示词与报告能自证口径。 */
  today: string;
  /** 基线读法：环比（相邻周期）/ 同比（去年同期）。 */
  baselineKind: 'chain' | 'year';
}

export interface PeriodInput {
  /** 表单的 period 槽位：`{from,to}`、`[from,to]`、`'2026-10-01 ~ 2026-10-31'`、`'2026-10'` 或 `'上月'`。 */
  period?: unknown;
  /** 报告主题或自然语言，用于解析「本周」「近 90 天」等话术。 */
  topic?: string;
  /** 注入时钟，便于测试与跨时区回归。 */
  now?: Date | string;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_ONLY_RE = /^(\d{4})$/;

interface Day {
  y: number;
  m: number;
  d: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function isoOf(day: Day): string {
  return `${pad(day.y, 4)}-${pad(day.m)}-${pad(day.d)}`;
}

function toDay(iso: string): Day {
  const [y, m, d] = iso.split('-').map(Number);
  return { y: y as number, m: m as number, d: d as number };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toOrdinal(iso: string): number {
  const day = toDay(iso);
  return Math.round(Date.UTC(day.y, day.m - 1, day.d) / DAY_MS);
}

function fromOrdinal(ordinal: number): string {
  const date = new Date(ordinal * DAY_MS);
  return isoOf({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
}

/** 只接受 `YYYY-MM-DD`，并校验真实日期（2 月 30 日必须失败，不能静默漂到 3 月）。 */
export function parseDateText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = DATE_RE.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function addDays(iso: string, offset: number): string {
  return fromOrdinal(toOrdinal(iso) + offset);
}

/** 月末自动截断：3 月 31 日往前一个月是 2 月 28/29 日，不是 3 月 3 日。 */
function addMonths(iso: string, offset: number): string {
  const day = toDay(iso);
  const total = day.y * 12 + (day.m - 1) + offset;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return isoOf({ y: year, m: month, d: Math.min(day.d, daysInMonth(year, month)) });
}

function addYears(iso: string, offset: number): string {
  return addMonths(iso, offset * 12);
}

function diffDays(from: string, to: string): number {
  return toOrdinal(to) - toOrdinal(from);
}

function weekdayOf(iso: string): number {
  const day = toDay(iso);
  // 0=周日 … 6=周六
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
}

/** 业务周从周一开始：周日起算会让「本周」在周一时只装下一天的数据。 */
function startOfWeek(iso: string): string {
  return addDays(iso, -((weekdayOf(iso) + 6) % 7));
}

const endOfWeek = (iso: string) => addDays(startOfWeek(iso), 6);
const startOfMonth = (iso: string) => {
  const day = toDay(iso);
  return isoOf({ y: day.y, m: day.m, d: 1 });
};
const endOfMonth = (iso: string) => {
  const day = toDay(iso);
  return isoOf({ y: day.y, m: day.m, d: daysInMonth(day.y, day.m) });
};
const startOfQuarter = (iso: string) => {
  const day = toDay(iso);
  return isoOf({ y: day.y, m: Math.floor((day.m - 1) / 3) * 3 + 1, d: 1 });
};
const endOfQuarter = (iso: string) => endOfMonth(addMonths(startOfQuarter(iso), 2));
const startOfYear = (iso: string) => `${toDay(iso).y}-01-01`;
const endOfYear = (iso: string) => `${toDay(iso).y}-12-31`;

interface GrainSpec {
  name: string;
  start: (iso: string) => string;
  end: (iso: string) => string;
  /** 上一个同粒度周期的起始日。 */
  priorStart: (periodStart: string) => string;
  /** 是否走「同比」（年粒度用去年同期，其余用相邻周期）。 */
  yearBaseline: boolean;
}

const GRAINS: Record<TimeGrain, GrainSpec> = {
  day: {
    name: '本日',
    start: (iso) => iso,
    end: (iso) => iso,
    priorStart: (from) => addDays(from, -1),
    yearBaseline: false,
  },
  week: {
    name: '本周',
    start: startOfWeek,
    end: endOfWeek,
    priorStart: (from) => addDays(from, -7),
    yearBaseline: false,
  },
  month: {
    name: '本月',
    start: startOfMonth,
    end: endOfMonth,
    priorStart: (from) => addMonths(from, -1),
    yearBaseline: false,
  },
  quarter: {
    name: '本季度',
    start: startOfQuarter,
    end: endOfQuarter,
    priorStart: (from) => addMonths(from, -3),
    yearBaseline: false,
  },
  year: {
    name: '今年',
    start: startOfYear,
    end: endOfYear,
    priorStart: (from) => addYears(from, -1),
    yearBaseline: true,
  },
};

/**
 * 自然周期窗口：未结束就截止到今天。
 * 基线把本期两端各自平移一个周期得到，因此月末自动对齐（3/1~3/31 → 2/1~2/29），
 * 本期不完整时也不会出现「本期 2 天 vs 基线整月」这种假下滑。
 * 未来周期（例如「下周」）原样保留，不往回夹——夹了会得到 from > to 的空窗。
 */
function grainWindow(grain: TimeGrain, anchor: string, today: string, name?: string): ResolvedPeriod & { previous: TimeWindow } {
  const spec = GRAINS[grain];
  const from = spec.start(anchor);
  const rawTo = spec.end(anchor);
  const includesToday = diffDays(from, today) >= 0 && diffDays(today, rawTo) >= 0;
  const to = includesToday ? today : rawTo;
  const priorFrom = spec.priorStart(from);
  const priorTo = addPeriods(to, grain, -1);
  const baselineWord = spec.yearBaseline ? '同比 去年同期' : '环比 上期';
  const current: TimeWindow = { from, to, label: `${name ?? spec.name}（${from} ~ ${to}）` };
  const previous: TimeWindow = { from: priorFrom, to: priorTo, label: `${baselineWord}（${priorFrom} ~ ${priorTo}）` };
  return {
    current,
    previous,
    grain: grainForSpan(from, to, grain),
    // 结束日落在今天或之后：最后一天还在写入（或整个周期还没到），不能当作完整周期对比。
    partial: diffDays(today, to) >= 0,
    source: 'phrase',
    today,
    baselineKind: spec.yearBaseline ? 'year' : 'chain',
  };
}

/**
 * 图表分桶粒度：太细则趋势只剩几个点，太粗则看不见波动。
 * hint 是该窗口的自然周期，用来把「按周看的 6 周」正确分成周桶。
 */
export function grainForSpan(from: string, to: string, hint?: TimeGrain): TimeGrain {
  const span = Math.max(1, diffDays(from, to) + 1);
  if (hint === 'week') return span <= 14 ? 'day' : 'week';
  if (hint === 'month') return span <= 45 ? 'day' : 'month';
  if (hint === 'quarter') return span <= 130 ? 'week' : 'month';
  if (hint === 'year') return span <= 400 ? 'month' : 'year';
  if (span <= 120) return 'day';
  if (span <= 800) return 'month';
  return 'year';
}

/**
 * 滚动窗口：以今天结尾，向前推 N 个自然单位（按日历对齐，所以「近 3 个月」含本月）。
 * 基线取**等长的前一段**，而不是「上一批月份」——后者在本期不完整时会少几天，
 * 让环比凭空变成下滑，这正是报表里最常见的假警报。
 */
function rollingWindow(count: number, unit: Exclude<TimeGrain, 'quarter'>, name: string, today: string): ResolvedPeriod & { previous: TimeWindow } {
  const back = (anchor: string, units: number) =>
    unit === 'day' ? addDays(anchor, -units) : unit === 'week' ? addDays(anchor, -7 * units) : unit === 'month' ? addMonths(anchor, -units) : addYears(anchor, -units);
  const naturalStart = (anchor: string) => (unit === 'day' ? anchor : unit === 'week' ? startOfWeek(anchor) : unit === 'month' ? startOfMonth(anchor) : startOfYear(anchor));
  const from = naturalStart(back(today, count - 1));
  const span = diffDays(from, today) + 1;
  const priorFrom = addDays(from, -span);
  const priorTo = addDays(from, -1);
  const current: TimeWindow = { from, to: today, label: `${name}（${from} ~ ${today}）` };
  const previous: TimeWindow = { from: priorFrom, to: priorTo, label: `环比 前 ${span} 天（${priorFrom} ~ ${priorTo}）` };
  return {
    current,
    previous,
    grain: grainForSpan(from, today, unit),
    // 滚动窗口以今天结尾，今天的数据通常还没跑完，因此始终算部分周期。
    partial: true,
    source: 'phrase',
    today,
    baselineKind: 'chain',
  };
}

/** 话术规则：grain + 偏移，或具名区段（上半年 / 第 N 季度），或滚动窗口。 */
interface PhraseRule {
  pattern: RegExp;
  grain?: TimeGrain;
  offset?: number;
  name?: string;
  /** 具名区段：直接由匹配结果给出起止日期，例如上半年、第 3 季度、Q2。 */
  segment?: (match: RegExpExecArray, today: string) => { from: string; to: string; name: string } | undefined;
  rolling?: { unit: Exclude<TimeGrain, 'quarter'>; defaultCount: number };
}

const CN_QUARTER: Record<string, 1 | 2 | 3 | 4> = { 一: 1, 二: 2, 三: 3, 四: 4 };

function quarterRange(year: number, index: number): { from: string; to: string } {
  const start = (index - 1) * 3 + 1;
  const from = `${pad(year, 4)}-${pad(start)}-01`;
  return { from, to: endOfMonth(addMonths(from, 2)) };
}

function namedQuarter(match: RegExpExecArray, today: string): { from: string; to: string; name: string } | undefined {
  const raw = match[1] ?? match[2];
  const index = raw === undefined ? undefined : CN_QUARTER[raw] ?? Number(raw);
  if (!index || index < 1 || index > 4) return undefined;
  const year = toDay(today).y;
  const range = quarterRange(year, index);
  // 未来季度原样保留；过去与当前季度都截止到「今天与区间末的较早者」。
  const to = range.to > today && range.from <= today ? today : range.to;
  return { from: range.from, to, name: `第 ${index} 季度` };
}

function namedHalf(match: RegExpExecArray, today: string): { from: string; to: string; name: string } {
  const half = match[1] === '下' || /second/i.test(match[0]) ? 2 : 1;
  const year = toDay(today).y;
  const from = `${pad(year, 4)}-${half === 1 ? '01' : '07'}-01`;
  const rawTo = `${pad(year, 4)}-${half === 1 ? '06-30' : '12-31'}`;
  const to = rawTo > today && from <= today ? today : rawTo;
  return { from, to, name: half === 1 ? '上半年' : '下半年' };
}

/**
 * 顺序敏感：先匹配「本期」写法，再匹配偏移周期，最后才是未来周期。
 * 本期优先是因为「本月与上月对比」这类主题应锚定本月（上月本来就是它的环比基线）；
 * 而「上上月」必须排在「上月」之前，否则子串会先命中短的那条。
 */
const PHRASE_RULES: PhraseRule[] = [
  { pattern: /本周|这周|这个?(?:周|星期)|本星期|this\s*week|week\s*to\s*date|wtd/i, grain: 'week', offset: 0 },
  { pattern: /上上周|上上个?(?:周|星期)/, grain: 'week', offset: -2, name: '上上周' },
  { pattern: /上周|上个?(?:周|星期)|last\s*week/i, grain: 'week', offset: -1, name: '上周' },
  { pattern: /下周|下个?(?:周|星期)|next\s*week/i, grain: 'week', offset: 1, name: '下周' },

  { pattern: /本月|这个?月|当月|本月份|this\s*month|month\s*to\s*date|mtd/i, grain: 'month', offset: 0 },
  { pattern: /上上月/, grain: 'month', offset: -2, name: '上上月' },
  { pattern: /上个?月|上一个月|last\s*month/i, grain: 'month', offset: -1, name: '上月' },
  { pattern: /下个月|下月|next\s*month/i, grain: 'month', offset: 1, name: '下月' },

  // 具名区段排在自然周期之前：「第 3 季度」不该按「本季度」锚定当前季度。
  { pattern: /(上|下)半[年段]/, segment: namedHalf },
  { pattern: /first\s*half|second\s*half/i, segment: namedHalf },
  { pattern: /第\s*([1-4一二三四])\s*(?:个)?季度/, segment: namedQuarter },
  { pattern: /\bq\s*([1-4])\b/i, segment: namedQuarter },

  { pattern: /今年|本年|this\s*year|year\s*to\s*date|ytd/i, grain: 'year', offset: 0 },
  { pattern: /前年|year\s*before\s*last/i, grain: 'year', offset: -2, name: '前年' },
  { pattern: /去年|(?<![上下半])上年|上一年|last\s*year/i, grain: 'year', offset: -1, name: '去年' },
  { pattern: /明年|下个?年|next\s*year/i, grain: 'year', offset: 1, name: '明年' },

  { pattern: /本季度|本季|当季|这个?季(?:度)?|这季度|this\s*quarter|quarter\s*to\s*date|qtd/i, grain: 'quarter', offset: 0 },
  { pattern: /上(?:个)?季(?:度)?|last\s*quarter/i, grain: 'quarter', offset: -1, name: '上季度' },

  { pattern: /今天|今日|today/i, grain: 'day', offset: 0, name: '今天' },
  { pattern: /昨(?:天|日)|yesterday/i, grain: 'day', offset: -1, name: '昨天' },
  { pattern: /前天/, grain: 'day', offset: -2, name: '前天' },

  // 「近期 / 最近 / 过去一段时间」这类没有数字的说法：按兜底长度给窗口，比硬套自然周期更贴近意图。
  { pattern: /近期|最近|过去的一?段时间/, rolling: { unit: 'day', defaultCount: 30 } },
];

/** 滚动窗口话术：近 N 天/周/个月/年。「前天」不含数字，不会被这条吃掉。 */
const ROLLING = /(?:近|最近|过去|前|last|past|previous)\s*(\d+)\s*(天|日|周|星期|个月|月|年|days?|day|weeks?|week|months?|month|years?|year|d|w|m|y)/i;
const ROLLING_IN = /(\d+)\s*(天|日|周|个月|月|年)(?:之?内|以内|范围内)/;
// 「上半年 / 下半年」是具名区段，不是「近半年」，所以必须排除。
const HALF_YEAR = /(?<![上下])半年|六个?月|half\s*year/i;

interface RollingPhrase {
  count: number;
  unit: Exclude<TimeGrain, 'quarter'>;
  name: string;
}

const UNIT_WORDS: Array<[RegExp, Exclude<TimeGrain, 'quarter'>, string]> = [
  [/^(天|日|d|day|days)$/, 'day', '天'],
  [/^(周|星期|w|week|weeks)$/, 'week', '周'],
  [/^(个月|月|m|month|months)$/, 'month', '个月'],
  [/^(年|y|year|years)$/, 'year', '年'],
];

function rollingPhrase(text: string): RollingPhrase | undefined {
  const match = ROLLING.exec(text) ?? ROLLING_IN.exec(text);
  if (match) {
    const count = Number(match[1]);
    const raw = (match[2] ?? '').toLowerCase();
    const hit = UNIT_WORDS.find(([pattern]) => pattern.test(raw));
    // 上限 400 天等量级：更大的数字通常是误输入，交给自然周期或兜底更稳。
    if (hit && count > 0 && count <= 400) {
      return { count, unit: hit[1], name: `近 ${count} ${hit[2]}` };
    }
  }
  if (HALF_YEAR.test(text)) return { count: 6, unit: 'month', name: '近 6 个月' };
  return undefined;
}

function explicitRange(value: string): { from: string; to: string; label: string } | undefined {
  const trimmed = value.trim();
  const pair = /^(\d{4}-\d{2}-\d{2})\s*(?:~|～|至|-{1,2}|—|\/|to)\s*(\d{4}-\d{2}-\d{2})$/i.exec(trimmed);
  if (pair) {
    const a = parseDateText(pair[1]);
    const b = parseDateText(pair[2]);
    if (a && b) return a <= b ? { from: a, to: b, label: '自定义区间' } : { from: b, to: a, label: '自定义区间' };
    return undefined;
  }
  const month = YEAR_MONTH_RE.exec(trimmed);
  if (month) {
    const year = Number(month[1]);
    const num = Number(month[2]);
    if (year >= 1000 && num >= 1 && num <= 12) {
      const from = `${month[1]}-${month[2]}-01`;
      return { from, to: endOfMonth(from), label: `${year} 年 ${num} 月` };
    }
    return undefined;
  }
  const day = parseDateText(trimmed);
  if (day) return { from: day, to: day, label: '指定日期' };
  const year = YEAR_ONLY_RE.exec(trimmed);
  if (year && Number(year[1]) >= 1000 && Number(year[1]) <= 9999) {
    return { from: `${year[1]}-01-01`, to: `${year[1]}-12-31`, label: `${year[1]} 年` };
  }
  return undefined;
}

function fromExplicit(range: { from: string; to: string; label: string }, today: string): ResolvedPeriod {
  const span = Math.max(1, diffDays(range.from, range.to) + 1);
  const priorFrom = addDays(range.from, -span);
  const priorTo = addDays(range.from, -1);
  return {
    current: { from: range.from, to: range.to, label: `${range.label}（${range.from} ~ ${range.to}）` },
    previous: { from: priorFrom, to: priorTo, label: `环比 前 ${span} 天（${priorFrom} ~ ${priorTo}）` },
    grain: grainForSpan(range.from, range.to),
    partial: diffDays(today, range.to) >= 0,
    source: 'explicit',
    today,
    baselineKind: 'chain',
  };
}

const FALLBACK: RollingPhrase = { count: 30, unit: 'day', name: '近 30 天' };

/**
 * 解析顺序：显式日期区间 → period 话术 → 主题话术 → 兜底近 30 天。
 * 每一步失败都继续下一步：绝不因为「说不清时间」而拒绝出报告。
 */
export function resolvePeriod(input: PeriodInput = {}): ResolvedPeriod {
  const today = todayOf(input.now);

  if (typeof input.period === 'string') {
    const typed = explicitRange(input.period);
    if (typed) return fromExplicit(typed, today);
  } else if (Array.isArray(input.period)) {
    const typed = explicitRange([input.period[0], input.period[1]].filter((value) => typeof value === 'string').join(' ~ '));
    if (typed) return fromExplicit(typed, today);
  } else if (input.period && typeof input.period === 'object') {
    const record = input.period as Record<string, unknown>;
    const from = parseDateText(record.from ?? record.start ?? record.begin ?? record.fromDate);
    const to = parseDateText(record.to ?? record.end ?? record.endDate ?? record.until ?? record.finish);
    if (from && to) return fromExplicit(from <= to ? { from, to, label: '自定义区间' } : { from: to, to: from, label: '自定义区间' }, today);
    if (from && !to) return fromExplicit({ from, to: from, label: '指定日期' }, today);
    if (to && !from) return fromExplicit({ from: to, to, label: '指定日期' }, today);
  }

  for (const text of [typeof input.period === 'string' ? input.period : undefined, input.topic]) {
    if (!text) continue;
    const rolling = rollingPhrase(text);
    if (rolling) return { ...rollingWindow(rolling.count, rolling.unit, rolling.name, today), source: 'phrase' };
    for (const rule of PHRASE_RULES) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      if (rule.rolling) {
        // 「近 / 最近 / 过去」但没给出可解析的数字：按兜底长度，而不是退回自然周期。
        return { ...rollingWindow(rule.rolling.defaultCount, rule.rolling.unit, `近 ${rule.rolling.defaultCount} 天`, today), source: 'phrase' };
      }
      if (rule.segment) {
        const named = rule.segment(match, today);
        if (!named) continue;
        return { ...segmentWindow(named, today), source: 'phrase' };
      }
      if (!rule.grain) continue;
      const anchor = addPeriods(today, rule.grain, rule.offset ?? 0);
      return { ...grainWindow(rule.grain, anchor, today, rule.name), source: 'phrase' };
    }
  }

  return { ...rollingWindow(FALLBACK.count, FALLBACK.unit, FALLBACK.name, today), source: 'default' };
}

/**
 * 具名区段（上半年 / 第 N 季度）：基线取去年同期同区段，
 * 因为「第 3 季度比第 2 季度」是季节性差异，直接环比会把旺季读成暴涨。
 */
function segmentWindow(named: { from: string; to: string; name: string }, today: string): ResolvedPeriod & { previous: TimeWindow } {
  const partial = diffDays(named.from, today) >= 0 && diffDays(today, named.to) >= 0;
  const priorFrom = addYears(named.from, -1);
  const priorTo = addYears(named.to, -1);
  const current: TimeWindow = { from: named.from, to: named.to, label: `${named.name}（${named.from} ~ ${named.to}）` };
  const previous: TimeWindow = { from: priorFrom, to: priorTo, label: `同比 去年${named.name}（${priorFrom} ~ ${priorTo}）` };
  return {
    current,
    previous,
    grain: grainForSpan(named.from, named.to, 'quarter'),
    partial,
    source: 'phrase',
    today,
    baselineKind: 'year',
  };
}

function addPeriods(anchor: string, grain: TimeGrain, offset: number): string {
  if (offset === 0) return anchor;
  if (grain === 'day') return addDays(anchor, offset);
  if (grain === 'week') return addDays(anchor, offset * 7);
  if (grain === 'month') return addMonths(anchor, offset);
  if (grain === 'quarter') return addMonths(anchor, offset * 3);
  return addYears(anchor, offset);
}

function todayOf(now: Date | string | undefined): string {
  if (typeof now === 'string') {
    const literal = parseDateText(now);
    if (literal) return literal;
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return isoOf({ y: parsed.getFullYear(), m: parsed.getMonth() + 1, d: parsed.getDate() });
    return todayOf(undefined);
  }
  const date = now ?? new Date();
  return isoOf({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
}

const BUCKET_LABEL: Record<TimeGrain, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'month',
  year: 'year',
};

/** 给提示词用的口径块：模型照抄边界即可，不需要推断「今天」。 */
export function formatPeriodForPrompt(period: ResolvedPeriod): string {
  const lines = [
    '## 统计时间窗（网关已解析，所有查询必须按这个口径过滤）',
    `- 本期：${period.current.from} ~ ${period.current.to} · ${period.current.label}`,
    period.previous ? `- 基线：${period.previous.from} ~ ${period.previous.to} · ${period.previous.label}` : '- 基线：无（只报本期值）',
    `- 今天：${period.today} · 趋势图建议分桶：${BUCKET_LABEL[period.grain]}`,
    period.partial
      ? '- 本期尚未结束：与基线比较只能用同样长度的切片；不得把「还没过完」解读成下滑，也不要在结论里预测整期。'
      : '- 本期已完整结束，可与基线直接比较。',
  ];
  return lines.join('\n');
}

/** 报告脚注里给读者看的一句话。 */
export function formatPeriodForReader(period: ResolvedPeriod): string {
  const baseline = period.previous ? `，对比${period.previous.label.split('（')[0]?.trim() ?? '上一周期'}` : '';
  return `统计区间 ${period.current.from} ~ ${period.current.to}${period.partial ? '（本期未结束）' : ''}${baseline}`;
}
