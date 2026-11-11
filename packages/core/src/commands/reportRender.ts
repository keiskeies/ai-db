/**
 * 报告 → 幻灯片的中间模型。
 *
 * 屏幕、SVG deck、pptxgenjs 三个渲染器各写一遍「放几页、截到几行、数字怎么读」必然漂移：
 * 曾经 deck 只出前 4 节而 PPTX 出全部，deck 把 12345678 截成「1234567…」而屏幕显示「1234.57 万」。
 * 所以分页与截断在这里决定一次，后端只负责把同一份结构画成 SVG 或 pptxgenjs 调用。
 */
import { computeMetricDelta, deltaIsGood, formatReportNumber } from './report';
import type { ReportBlock, ReportDelta, ReportEvidence, ReportMetric, ReportSpec } from './report';

export type ReportLocale = 'zh' | 'en';

export interface ReportCopy {
  report: string;
  executive: string;
  keyMetrics: string;
  section: string;
  assumptions: string;
  cover: string;
  page: string;
  of: string;
  sectionsUnit: string;
  pagesUnit: string;
  current: string;
  previous: string;
  compare: string;
  delta: string;
  dataTable: string;
  trend: string;
  noText: string;
  truncatedSections: string;
  truncatedMetrics: string;
  truncatedRows: string;
  truncatedPoints: string;
  footer: string;
  generatedBy: string;
  caliber: string;
  rowsUnit: string;
  durationUnit: string;
  truncatedFlag: string;
  noSql: string;
  audience: Record<string, string>;
}

const ZH: ReportCopy = {
  report: '报告',
  executive: '管理层摘要',
  keyMetrics: '关键指标',
  section: '章节',
  assumptions: '口径与假设',
  cover: 'AIDB STUDIO · REPORT',
  page: '页',
  of: '/',
  sectionsUnit: '个章节',
  pagesUnit: '页',
  current: '本期',
  previous: '上期',
  compare: '对比',
  delta: '差值',
  dataTable: '数据表',
  trend: '趋势',
  noText: '（本节无文本内容）',
  truncatedSections: '共 {n} 个章节，此处呈现前 {m} 个',
  truncatedMetrics: '共 {n} 项指标，此处呈现前 {m} 项',
  truncatedRows: '共 {n} 行，此处呈现前 {m} 行',
  truncatedPoints: '共 {n} 个数据点，此处呈现前 {m} 个',
  footer: '数字来自报告查询结果',
  generatedBy: 'AiDB Studio',
  caliber: '口径：',
  rowsUnit: '行',
  durationUnit: 'ms',
  truncatedFlag: '结果被行数上限截断',
  noSql: '该数字没有可展示的查询记录',
  audience: { executive: '管理层', business: '业务', technical: '技术' },
};

const EN: ReportCopy = {
  report: 'Report',
  executive: 'Executive summary',
  keyMetrics: 'Key metrics',
  section: 'Section',
  assumptions: 'Definitions & assumptions',
  cover: 'AIDB STUDIO · REPORT',
  page: 'p.',
  of: 'of',
  sectionsUnit: 'sections',
  pagesUnit: 'pages',
  current: 'Current',
  previous: 'Baseline',
  compare: 'Comparison',
  delta: 'Delta',
  dataTable: 'Data table',
  trend: 'Trend',
  noText: '(no narrative in this section)',
  truncatedSections: '{n} sections in total; the first {m} are shown',
  truncatedMetrics: '{n} metrics in total; the first {m} are shown',
  truncatedRows: '{n} rows in total; the first {m} are shown',
  truncatedPoints: '{n} data points in total; the first {m} are shown',
  footer: 'Figures come from the report queries',
  generatedBy: 'AiDB Studio',
  caliber: 'Definition: ',
  rowsUnit: 'rows',
  durationUnit: 'ms',
  truncatedFlag: 'result hit the row limit',
  noSql: 'no query record for this figure',
  audience: { executive: 'Executive', business: 'Business', technical: 'Technical' },
};

export function reportCopy(locale: ReportLocale = 'zh'): ReportCopy {
  return locale === 'en' ? EN : ZH;
}

function fill(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

export type DeltaTone = 'good' | 'bad' | 'neutral';

export interface DeckLine {
  text: string;
  tone: 'info' | 'warning' | 'danger';
}

export interface DeckMetric {
  label: string;
  /** 展示用读数（含 万/亿 缩写）；导出与悬停仍用 exact。 */
  value: string;
  exact: string;
  unit?: string;
  baselineLabel?: string;
  deltaText?: string;
  deltaTone: DeltaTone;
}

export interface DeckRow {
  cells: string[];
}

export interface DeckChart {
  title: string;
  chartType: 'bar' | 'line' | 'pie' | 'stacked';
  points: Array<{ label: string; value: number; baseline?: number }>;
  baselineName?: string;
  note?: string;
  /** 点数被截断时的说明；没有截断则缺省。 */
  overflow?: string;
}

export interface DeckTable {
  title?: string;
  columns: string[];
  rows: DeckRow[];
  overflow?: string;
}

export type DeckSlide =
  | {
      kind: 'cover';
      title: string;
      subtitle: string;
      meta: string;
      eyebrow: string;
    }
  | { kind: 'executive'; eyebrow: string; title: string; headline: string; takeaways: string[]; risks: string[] }
  | { kind: 'metrics'; eyebrow: string; title: string; metrics: DeckMetric[]; overflow?: string }
  | {
      kind: 'section';
      eyebrow: string;
      title: string;
      conclusion?: string;
      lines: DeckLine[];
      metrics: DeckMetric[];
      table?: DeckTable;
      chart?: DeckChart;
      /**
       * 本节其余的图与表。一页只画得下一张主图一张主表，但内容不能丢：
       * 渲染器把它们各自再出一页（PPTX 以前就是每张图一页，收敛排版时不能把图变没）。
       */
      extraCharts: DeckChart[];
      extraTables: DeckTable[];
      sourceLabel?: string;
    }
  | { kind: 'assumptions'; eyebrow: string; title: string; lines: string[] };

export interface DeckPlan {
  slides: DeckSlide[];
  copy: ReportCopy;
}

/**
 * 每种阅读对象的版面密度。
 * 管理层要的是决策与风险，明细表对他只会稀释结论；技术读者才需要明细与口径全文。
 * 这个数字以前写死在 deck 渲染里（固定 4 页），所以「选管理层」和「选技术」拿到同一份 PPT。
 * 屏幕也读这份表：三处产物只能内容详略一致，否则「第 5 页」在哪个端都不是同一件事。
 */
export interface ReportDensity {
  sections: number;
  metrics: number;
  rows: number;
  points: number;
  narrative: number;
  takeaways: number;
  risks: number;
  columns: number;
  assumptions: boolean;
}

const DENSITY: Record<string, ReportDensity> = {
  executive: { sections: 2, metrics: 4, rows: 4, points: 8, narrative: 3, takeaways: 3, risks: 2, columns: 3, assumptions: false },
  business: { sections: 4, metrics: 6, rows: 8, points: 12, narrative: 5, takeaways: 5, risks: 3, columns: 4, assumptions: true },
  technical: { sections: 8, metrics: 8, rows: 15, points: 24, narrative: 8, takeaways: 6, risks: 4, columns: 5, assumptions: true },
};

/** 阅读对象 → 版面密度。屏幕、deck、PPTX 必须共用这一个函数。 */
export function reportDensity(audience?: string): ReportDensity {
  return DENSITY[audience ?? 'business'] ?? DENSITY.business!;
}

function densityOf(spec: ReportSpec) {
  return reportDensity(spec.meta.audience);
}

/** 展示层读数：大数字走 万/亿 缩写，绝不改写原值。 */
export function formatMetricValue(value: number | string, locale: ReportLocale = 'zh'): { text: string; exact: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { text: String(value ?? '—'), exact: String(value ?? '') };
  const formatted = formatReportNumber(value, locale);
  return { text: formatted.text, exact: formatted.exact };
}

export function deltaText(delta: ReportDelta, locale: ReportLocale = 'zh'): string {
  const sign = delta.absolute > 0 ? '+' : '';
  const percent = delta.percent;
  const precise = delta.absolute.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 });
  return percent === null || percent === undefined ? `${sign}${precise}` : `${sign}${precise} (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`;
}

export function metricDeltaText(metric: ReportMetric, locale: ReportLocale = 'zh'): { text: string; tone: DeltaTone } | undefined {
  const delta = metric.delta ?? (typeof metric.baseline === 'number' && typeof metric.value === 'number' ? computeMetricDelta(metric.value, metric.baseline) : undefined);
  if (!delta) return undefined;
  return { text: deltaText(delta, locale), tone: deltaIsGood(delta.absolute, metric.goodDirection ?? 'up') };
}

/**
 * 卡片只放主基线：一页四张卡放不下第二条对比，PPT 的密度本来就该低于屏幕。
 * 同比与日均口径仍完整出现在屏幕与 Excel 里，导出不会比屏幕少信息。
 */
function toDeckMetric(metric: ReportMetric, locale: ReportLocale): DeckMetric {
  const value = formatMetricValue(metric.value, locale);
  const delta = metricDeltaText(metric, locale);
  return {
    label: metric.label,
    value: value.text,
    exact: value.exact,
    ...(metric.unit ? { unit: metric.unit } : {}),
    ...(metric.baselineLabel ? { baselineLabel: metric.baselineLabel } : {}),
    ...(delta ? { deltaText: delta.text, deltaTone: delta.tone } : { deltaTone: 'neutral' as DeltaTone }),
  };
}

function toneOf(block: ReportBlock): DeckLine['tone'] {
  return block.kind === 'callout' ? block.tone ?? 'info' : 'info';
}

function sectionLines(section: ReportSpec['sections'][number], limit: number, locale: ReportLocale): DeckLine[] {
  const lines: DeckLine[] = [];
  for (const block of section.blocks) {
    if (block.kind === 'narrative' || block.kind === 'callout') {
      if (block.text) lines.push({ text: block.text, tone: toneOf(block) });
    } else if (block.kind === 'actions') {
      for (const action of block.actions ?? []) {
        lines.push({ text: `${action.text}${action.impact ? ` (${action.impact})` : ''}${action.owner || action.due ? ` — ${[action.owner, action.due].filter(Boolean).join(' / ')}` : ''}`, tone: 'info' });
      }
    } else if (block.kind === 'comparison') {
      const left = formatMetricValue(Number(block.left?.value ?? 0), locale).text;
      const right = formatMetricValue(Number(block.right?.value ?? 0), locale).text;
      const delta = block.delta
        ? `  ·  ${deltaText(block.delta, locale)}`
        : '';
      lines.push({ text: `${block.left?.label ?? 'A'}: ${left}  ·  ${block.right?.label ?? 'B'}: ${right}${delta}`, tone: 'info' });
    }
  }
  return lines.slice(0, limit);
}

function collectMetrics(spec: ReportSpec): ReportMetric[] {
  const out: ReportMetric[] = [];
  const seen = new Set<string>();
  for (const section of spec.sections) {
    for (const block of section.blocks) {
      const metrics =
        block.kind === 'metric' ? block.metrics ?? [] : block.kind === 'comparison' ? ([block.left, block.right].filter(Boolean) as ReportMetric[]) : [];
      for (const metric of metrics) {
        const key = `${metric.label}:${metric.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(metric);
      }
    }
  }
  return out;
}

function localeOf(spec: ReportSpec): ReportLocale {
  return spec.meta.locale === 'en' ? 'en' : 'zh';
}

/** 报告 → 幻灯片计划。分页与截断的唯一出处。 */
export function planReportDeck(spec: ReportSpec): DeckPlan {
  const locale = localeOf(spec);
  const copy = reportCopy(locale);
  const density = densityOf(spec);
  const slides: DeckSlide[] = [];

  const period = spec.meta.period;
  const window = period ? period.label ?? `${period.from} ~ ${period.to}` : '';
  const sources = spec.sources.map((source) => `${source.connectionName}${source.database ? ` / ${source.database}` : ''}`).join('  ·  ');
  const audience = spec.meta.audience ? copy.audience[spec.meta.audience] ?? '' : '';
  slides.push({
    kind: 'cover',
    title: spec.title,
    eyebrow: copy.cover,
    subtitle: [window, audience, sources].filter(Boolean).join('  ·  '),
    meta: [
      `${spec.sections.length} ${copy.sectionsUnit}`,
      spec.meta.createdAt ? new Date(spec.meta.createdAt).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US') : '',
      copy.footer,
    ].filter(Boolean).join('  ·  '),
  });

  if (spec.executive) {
    slides.push({
      kind: 'executive',
      eyebrow: copy.executive,
      title: copy.executive,
      headline: spec.executive.headline,
      takeaways: spec.executive.takeaways.slice(0, density.takeaways),
      risks: (spec.executive.risks ?? []).slice(0, density.risks),
    });
  }

  const metrics = collectMetrics(spec);
  if (metrics.length) {
    slides.push({
      kind: 'metrics',
      eyebrow: copy.keyMetrics,
      title: copy.keyMetrics,
      metrics: metrics.slice(0, density.metrics).map((metric) => toDeckMetric(metric, locale)),
      ...(metrics.length > density.metrics
        ? { overflow: fill(copy.truncatedMetrics, { n: metrics.length, m: density.metrics }) }
        : {}),
    });
  }

  const sections = spec.sections.filter((section) => section.blocks.length > 0);
  for (const section of sections.slice(0, density.sections)) {
    const sectionMetrics: DeckMetric[] = [];
    const tables: DeckTable[] = [];
    const charts: DeckChart[] = [];
    for (const block of section.blocks) {
      if (block.kind === 'metric') sectionMetrics.push(...(block.metrics ?? []).map((metric) => toDeckMetric(metric, locale)));
      else if (block.kind === 'table') {
        const rows = block.rows ?? [];
        tables.push({
          ...(block.title ? { title: block.title } : {}),
          columns: (block.columns ?? []).slice(0, density.columns),
          rows: rows.slice(0, density.rows).map((row) => ({ cells: row.slice(0, density.columns).map((cell) => String(cell ?? '—')) })),
          ...(rows.length > density.rows ? { overflow: fill(copy.truncatedRows, { n: rows.length, m: density.rows }) } : {}),
        });
      } else if (block.kind === 'chart' && (block.series?.length ?? 0) >= 2) {
        const points = block.series ?? [];
        charts.push({
          title: block.title ?? copy.trend,
          chartType: block.chartType ?? 'bar',
          points: points.slice(0, density.points).map((point) => ({ ...point })),
          ...(block.baselineName ? { baselineName: block.baselineName } : {}),
          ...(block.note ? { note: block.note } : {}),
          ...(points.length > density.points ? { overflow: fill(copy.truncatedPoints, { n: points.length, m: density.points }) } : {}),
        });
      }
    }
    const [headTable, ...restTables] = tables;
    const [headChart, ...restCharts] = charts;
    slides.push({
      kind: 'section',
      eyebrow: copy.section,
      title: section.title,
      ...(section.conclusion ? { conclusion: section.conclusion } : {}),
      lines: sectionLines(section, density.narrative, locale),
      metrics: sectionMetrics.slice(0, density.metrics),
      ...(headTable ? { table: headTable } : {}),
      ...(headChart ? { chart: headChart } : {}),
      extraCharts: restCharts,
      extraTables: restTables,
      ...(section.sourceKey
        ? { sourceLabel: spec.sources.find((source) => source.key === section.sourceKey)?.label ?? '' }
        : {}),
    });
  }

  if (sections.length > density.sections) {
    // 章节被裁掉时必须让读者知道，否则他会以为报告只有这些内容。
    const note = fill(copy.truncatedSections, { n: sections.length, m: density.sections });
    const last = slides[slides.length - 1];
    if (last && last.kind === 'section') last.lines = [...last.lines, { text: note, tone: 'info' }];
    else slides.push({ kind: 'assumptions', eyebrow: copy.section, title: copy.section, lines: [note] });
  }

  const assumptions = spec.meta.assumptions ?? [];
  if (density.assumptions && assumptions.length) {
    slides.push({ kind: 'assumptions', eyebrow: copy.assumptions, title: copy.assumptions, lines: assumptions });
  }

  return { slides, copy };
}

/**
 * 把每节的额外图表 / 表格展开成独立页。
 * 两个 PPT 后端必须用同一份展开结果，否则「屏幕上第 5 页」和「文件里第 5 页」会不是同一件事。
 */
export function flattenDeckSlides(slides: DeckSlide[]): DeckSlide[] {
  const out: DeckSlide[] = [];
  for (const slide of slides) {
    if (slide.kind !== 'section') {
      out.push(slide);
      continue;
    }
    // 展开后不再留待办：渲染器拿到的一定是「一页一主题」的干净列表。
    out.push({ ...slide, extraCharts: [], extraTables: [] });
    for (const chart of slide.extraCharts) {
      out.push({ ...slide, title: `${slide.title} · ${chart.title}`, conclusion: undefined, lines: [], metrics: [], table: undefined, chart, extraCharts: [], extraTables: [] });
    }
    for (const table of slide.extraTables) {
      out.push({ ...slide, title: `${slide.title} · ${table.title ?? ''}`.trim(), conclusion: undefined, lines: [], metrics: [], table, chart: undefined, extraCharts: [], extraTables: [] });
    }
  }
  return out;
}

/**
 * 证据摘要：把一个 resultRef 翻译成一行人能读的口径说明。
 * 三个渲染端与屏幕的悬停提示共用它，否则「截断了」会在某一端被悄悄省略。
 */
export function describeEvidence(evidence: ReportEvidence | undefined, copy: ReportCopy = reportCopy('zh')): string {
  if (!evidence) return copy.noSql;
  const parts = [evidence.tool];
  if (typeof evidence.rowCount === 'number') parts.push(`${evidence.rowCount} ${copy.rowsUnit}`);
  if (evidence.truncated) parts.push(copy.truncatedFlag);
  if (typeof evidence.durationMs === 'number') parts.push(`${evidence.durationMs} ${copy.durationUnit}`);
  const headline = parts.join(' · ');
  return evidence.sql ? `${evidence.sql}${headline ? `\n${headline}` : ''}` : headline;
}

/** 报告 → 表格行（Excel）。表格块保留自己的列与原始类型，不再压成一行字符串。 */
export interface ReportSheet {
  name: string;
  columns: string[];
  rows: unknown[][];
}

export function reportSheets(spec: ReportSpec): ReportSheet[] {
  const locale = localeOf(spec);
  const copy = reportCopy(locale);
  const narrative: unknown[][] = [];
  if (spec.executive) {
    narrative.push([copy.executive, 'headline', spec.executive.headline]);
    for (const takeaway of spec.executive.takeaways) narrative.push([copy.executive, 'takeaway', takeaway]);
    for (const risk of spec.executive.risks ?? []) narrative.push([copy.executive, 'risk', risk]);
  }
  const metricRows: unknown[][] = [];
  const comparisonRows: unknown[][] = [];
  const chartRows: unknown[][] = [];
  const tables: ReportSheet[] = [];
  const used = new Set<string>();

  const sheetName = (base: string): string => {
    // Excel 的 sheet 名有 31 字符上限，且不能含 : \ / ? * [ ]
    const cleaned = base.replace(/[\\/:*?[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = cleaned;
    let index = 2;
    while (used.has(name.toLowerCase())) name = `${cleaned.slice(0, 27)} (${index++})`;
    used.add(name.toLowerCase());
    return name;
  };

  for (const section of spec.sections) {
    if (section.conclusion) narrative.push([section.title, 'conclusion', section.conclusion]);
    for (const block of section.blocks) {
      if (block.kind === 'narrative' || block.kind === 'callout') narrative.push([section.title, block.kind, block.text ?? '']);
      else if (block.kind === 'actions') {
        for (const action of block.actions ?? []) {
          narrative.push([section.title, 'action', [action.text, action.impact, action.owner, action.due].filter(Boolean).join(' | ')]);
        }
      } else if (block.kind === 'metric') {
        for (const metric of block.metrics ?? []) {
          const delta = metricDeltaText(metric, locale);
          metricRows.push([
            section.title,
            metric.label,
            metric.value,
            metric.unit ?? '',
            typeof metric.baseline === 'number' ? metric.baseline : '',
            metric.baselineLabel ?? '',
            delta?.text ?? '',
            // 环比之外的读法（同比 / 同长切片 / 日均）也要进 Excel，导出不能比屏幕少信息。
            (metric.alternativeBaselines ?? [])
              .map((item) => `${item.label}${typeof item.value === 'number' ? ` ${item.value}${item.delta ? ` (${deltaText(item.delta, locale)})` : ''}` : ''}`)
              .join(' ; '),
            metric.resultRef ? spec.meta.evidence?.[metric.resultRef]?.sql ?? '' : '',
          ]);
        }
      } else if (block.kind === 'comparison') {
        comparisonRows.push([
          section.title,
          block.title ?? copy.compare,
          block.left?.label ?? 'A',
          Number(block.left?.value ?? 0),
          block.right?.label ?? 'B',
          Number(block.right?.value ?? 0),
          block.delta ? deltaText(block.delta, locale) : '',
        ]);
      } else if (block.kind === 'chart') {
        for (const point of block.series ?? []) {
          chartRows.push([section.title, block.title ?? copy.trend, point.label, point.value, typeof point.baseline === 'number' ? point.baseline : '', block.baselineName ?? '']);
        }
      } else if (block.kind === 'table') {
        const columns = block.columns ?? [];
        tables.push({
          name: sheetName(block.title ?? section.title),
          columns,
          rows: (block.rows ?? []).map((row) => row.map((cell) => cell ?? '')),
        });
      }
    }
  }

  for (const line of spec.meta.assumptions ?? []) narrative.push([copy.assumptions, 'definition', line]);
  for (const note of spec.meta.notes ?? []) narrative.push([copy.assumptions, 'note', note]);

  const sheets: ReportSheet[] = [{ name: copy.executive, columns: [copy.section, 'kind', 'text'], rows: narrative }];
  if (metricRows.length) sheets.push({ name: copy.keyMetrics, columns: [copy.section, 'metric', 'value', 'unit', 'baseline', 'baseline_label', 'delta', 'alternative_baselines', 'sql'], rows: metricRows });
  for (const table of tables) if (table.rows.length) sheets.push(table);
  if (chartRows.length) sheets.push({ name: copy.trend, columns: [copy.section, 'chart', 'point', 'value', 'baseline', 'baseline_label'], rows: chartRows });
  if (comparisonRows.length) sheets.push({ name: copy.compare, columns: [copy.section, 'title', 'a_label', 'a_value', 'b_label', 'b_value', 'delta'], rows: comparisonRows });
  return sheets;
}
