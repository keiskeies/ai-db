/**
 * 报告的质量闸口。
 *
 * 「结论先行、数字要有参照、正文不出现表名」这些原则以前只写在提示词里，
 * 模型不遵守也没有任何后果。这里把它们变成机器可判定的检查：
 * 硬伤直接退回让模型重写，软伤如实记进 meta.qualityNotes 让读者知情。
 *
 * 判定必须保守——闸口误报会让整份报告生成失败，比放行一条瑕疵严重得多。
 */
import type { ReportBlock, ReportSection, ReportSpec } from './report';
import type { ReportAnalysis, ReportBrief } from './reportBrief';

export interface ReportQualityResult {
  /** 阻断性问题：退回给模型重写。 */
  errors: string[];
  /** 非阻断提示：写进 meta.qualityNotes。 */
  notes: string[];
}

/** 时间分桶标签的形态：2026-11、2026-11-03、2026-W45、2026、11-03。 */
const BUCKET_LABEL = /^(\d{4}(-\d{1,2}){0,2}|\d{4}-W\d{1,2}|\d{1,2}-\d{1,2}|W\d{1,2}|Q[1-4]|\d{4}[年/-]\d{1,2}[月日]?)$/i;
const DATE_LIKE = /\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?/;
const JARGON_SQL = /\b(COUNT|SUM|AVG|GROUP\s+BY|WHERE|JOIN|DISTINCT|HAVING|ORDER\s+BY)\s*\(|\b(is_deleted|deleted_at|rowEstimate|row_estimate)\b|\bCOUNT\(\*\)\b/i;
const VAGUE_ACTION = /^\s*(建议|应该|需要|加强|提升|优化|关注|重视|完善|进一步|加强沟通|持续)(关注|跟进|提升|优化|改善|努力)?\s*$/;

interface SectionScan {
  section: ReportSection;
  hasNumber: boolean;
  numericBlocks: number;
}

function blockNumbers(block: ReportBlock): number[] {
  const out: number[] = [];
  if (block.kind === 'metric') {
    for (const metric of block.metrics ?? []) {
      if (typeof metric.value === 'number') out.push(metric.value);
      if (typeof metric.baseline === 'number') out.push(metric.baseline);
    }
  } else if (block.kind === 'chart') {
    for (const point of block.series ?? []) {
      out.push(point.value);
      if (typeof point.baseline === 'number') out.push(point.baseline);
    }
    for (const series of block.extraSeries ?? []) out.push(...series.values.filter(Number.isFinite));
    for (const point of block.scatter ?? []) out.push(point.x, point.y);
    for (const row of block.heatmap?.values ?? []) out.push(...row.filter(Number.isFinite));
  } else if (block.kind === 'comparison') {
    for (const side of [block.left, block.right]) {
      if (side && typeof side.value === 'number') out.push(side.value);
    }
  } else if (block.kind === 'table') {
    for (const row of block.rows ?? []) {
      for (const cell of row) if (typeof cell === 'number') out.push(cell);
    }
  }
  return out;
}

function collectTerms(spec: ReportSpec): string[] {
  const terms = new Set<string>();
  for (const source of spec.sources) {
    if (source.database && source.database.length >= 3) terms.add(source.database.toLowerCase());
  }
  return [...terms];
}

/**
 * 标识符分级。
 * 带下划线/点号的名字（created_at、orders.amount）出现在正文里几乎一定是泄漏，可以直接拒；
 * 但 month、name、status 这类普通单词列名，英文叙述里正常出现（"this month"）——
 * 拿它硬拒会把一份好报告反复打回。所以强标识符进 errors，弱词名只进 notes。
 */
function splitTerms(forbidden: string[]): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  for (const raw of forbidden) {
    const term = raw.toLowerCase();
    if (term.length < 3) continue;
    if (/[._]/.test(term) || /^(is|has)_[a-z]/.test(term)) hard.push(term);
    else soft.push(term);
  }
  return { hard, soft };
}

function isVagueAction(text: string): boolean {
  const cleaned = text.replace(/[。.!！?？]/g, '').trim();
  if (cleaned.length <= 6) return true;
  if (VAGUE_ACTION.test(cleaned)) return true;
  // 「优化履约流程」这类没有数字、没有对象、没有时限的动宾短语，读者无法据此行动。
  const hasTarget = /[0-9０-９]|%|万|亿|元|率|量|额|数/.test(cleaned);
  const hasVerb = /(补|加|改|拆|建|下线|上线|清理|补齐|修|扩容|限流|缓存|索引|分区|回访|催收|拦截|召回)/.test(cleaned);
  return !hasTarget && !hasVerb;
}

function hasException(exceptions: string[], analysis: ReportAnalysis | 'metrics' | 'charts' | 'binding'): boolean {
  const aliases: Record<string, string[]> = {
    metrics: ['指标', 'KPI', 'metric'],
    charts: ['图表', 'chart'],
    trend: ['趋势', '时间', 'trend'],
    composition: ['结构', '构成', 'composition'],
    comparison: ['对比', 'comparison'],
    attribution: ['归因', '维度', 'attribution'],
    anomaly: ['异常', '离群', 'anomaly'],
    target: ['目标', 'target'],
    forecast: ['预测', 'forecast'],
    detail: ['明细', 'detail'],
    actions: ['建议', '行动', 'action'],
    binding: ['对象', '表', '字段', 'schema', 'binding'],
  };
  const terms = aliases[analysis] ?? [];
  return exceptions.some((exception) => terms.some((term) => exception.toLowerCase().includes(term.toLowerCase())));
}

export function checkReportCoverage(spec: ReportSpec, brief?: ReportBrief, exceptions: string[] = []): ReportQualityResult {
  const errors: string[] = [];
  const notes: string[] = [];
  if (!brief) return { errors, notes };
  const blocks = spec.sections.flatMap((section) => section.blocks);
  const metricCount = blocks.filter((block) => block.kind === 'metric').flatMap((block) => block.metrics ?? []).length;
  const chartCount = blocks.filter((block) => block.kind === 'chart').length;
  const hasNumbers = blocks.some((block) => blockNumbers(block).length > 0);
  if (hasNumbers && metricCount < brief.coverage.minMetrics && !hasException(exceptions, 'metrics')) {
    errors.push(`核心指标只有 ${metricCount} 个，低于需求计划要求的 ${brief.coverage.minMetrics} 个；数据不足时请给出具体 coverageExceptions`);
  }
  if (chartCount < brief.coverage.minCharts && !hasException(exceptions, 'charts')) {
    notes.push(`只有 ${chartCount} 张图，低于通常需要的 ${brief.coverage.minCharts} 张；如数据形状不支持，请说明原因`);
  }
  if (chartCount > brief.coverage.maxCharts) notes.push(`共有 ${chartCount} 张图，超过建议上限 ${brief.coverage.maxCharts} 张；请删除不改变判断的重复图`);

  const covered = (analysis: ReportAnalysis): boolean => {
    if (analysis === 'metrics') return metricCount > 0;
    if (analysis === 'trend') return blocks.some((block) => block.kind === 'chart' && (block.chartType === 'line' || block.chartType === 'stacked'));
    if (analysis === 'composition') return blocks.some((block) => block.kind === 'chart' && (block.chartType === 'pie' || block.chartType === 'bar'));
    if (analysis === 'comparison') return blocks.some((block) => block.kind === 'comparison');
    if (analysis === 'attribution') return blocks.some((block) => block.kind === 'table' && (block.columns ?? []).some((column) => /本期|上期|变化|贡献/.test(column)));
    if (analysis === 'anomaly') return blocks.some((block) => /异常|离群|outlier/i.test(`${block.note ?? ''} ${block.title ?? ''}`));
    if (analysis === 'target') return blocks.some((block) => block.kind === 'metric' && (block.metrics ?? []).some((metric) => /目标/.test(metric.baselineLabel ?? '') || (metric.alternativeBaselines ?? []).some((baseline) => /目标/.test(baseline.label))));
    if (analysis === 'forecast') return blocks.some((block) => /预测|forecast/i.test(block.note ?? ''));
    if (analysis === 'detail') return blocks.some((block) => block.kind === 'table');
    return blocks.some((block) => block.kind === 'actions');
  };
  for (const analysis of brief.analyses) {
    if (!covered(analysis) && !hasException(exceptions, analysis)) notes.push(`需求计划中的「${analysis}」尚未覆盖；如数据不支持，请写明具体原因`);
  }
  if ((brief.coverage.requireAttribution || brief.coverage.requireTarget || brief.coverage.requireAnomaly) && exceptions.length && !brief.analyses.every((analysis) => covered(analysis) || hasException(exceptions, analysis))) {
    notes.push(`条件分析例外：${exceptions.join('；')}`);
  }

  const evidence = Object.values(spec.meta.evidence ?? {});
  if (evidence.length && brief.grounding.tables.length) {
    const evidenceText = evidence.map((item) => `${item.args?.table ?? ''} ${item.sql ?? ''}`).join('\n').toLowerCase();
    const used = brief.grounding.tables.some((table) => evidenceText.includes(table.name.toLowerCase()));
    if (!used && !hasException(exceptions, 'binding')) notes.push('查询证据未命中需求计划中的候选表；请确认业务词到 schema 对象的绑定是否正确');
  }
  return { errors, notes };
}

export function checkReportQuality(spec: ReportSpec, forbidden: string[] = []): ReportQualityResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const sections = spec.sections;
  if (!sections.length) return { errors: ['报告没有任何章节'], notes };

  const scans: SectionScan[] = sections.map((section) => {
    const numbers = section.blocks.flatMap(blockNumbers);
    return {
      section,
      hasNumber: numbers.length > 0,
      numericBlocks: section.blocks.filter((block) => block.kind === 'metric' || block.kind === 'chart' || block.kind === 'table' || block.kind === 'comparison').length,
    };
  });

  // 硬伤 1：全是文字没有数字的报告不是数据报告。
  if (!scans.some((scan) => scan.hasNumber)) errors.push('整份报告没有任何数字：至少需要一节用 metric / chart / table 给出查询结果');

  // 硬伤 2：headline 空洞。
  const headline = spec.executive?.headline ?? '';
  if (headline && !/[\d０-９]/.test(headline) && !/未|无|没有|不能|缺少|无法/.test(headline)) {
    errors.push('executive.headline 必须带上最关键的那个数字，或者明确说明为什么给不出数字');
  }

  const { hard, soft } = splitTerms([...collectTerms(spec), ...forbidden]);
  const leaksHard = new Set<string>();
  const leaksSoft = new Set<string>();
  const scanText = (where: string, text: string) => {
    if (!text) return;
    const lower = text.toLowerCase();
    for (const term of hard) if (lower.includes(term)) leaksHard.add(`${where} → ${term}`);
    for (const term of soft) if (lower.includes(term)) leaksSoft.add(`${where} → ${term}`);
    if (JARGON_SQL.test(text)) leaksHard.add(`${where} → SQL 术语`);
  };
  scanText('标题', headline);
  for (const takeaway of spec.executive?.takeaways ?? []) scanText('要点', takeaway);
  for (const [index, scan] of scans.entries()) {
    const section = scan.section;
    // 章节没有结论。
    if (!section.conclusion) notes.push(`第 ${index + 1} 节「${section.title}」缺少一句话结论`);
    // 章节既没结论也没数字，只是把数据摆在那儿。
    if (!section.conclusion && !scan.hasNumber) errors.push(`第 ${index + 1} 节「${section.title}」既没有结论也没有数字，读者无从判断`);
    // 图表只重复结论，或章节堆了太多图。
    const charts = section.blocks.filter((block) => block.kind === 'chart');
    if (charts.length >= 4) notes.push(`第 ${index + 1} 节有 ${charts.length} 张图，只保留会改变读者判断的那几张`);
    scanText(section.title, section.title);
    scanText(section.title, section.conclusion ?? '');
    for (const block of section.blocks) {
      scanText(`块「${block.title ?? block.kind}」`, block.title ?? '');
      if (block.kind === 'actions') {
        for (const action of block.actions ?? []) {
          if (isVagueAction(action.text)) notes.push(`建议「${action.text.slice(0, 20)}」太笼统，读者无法据此行动`);
        }
      }
      // 折线图的时间轴没有分桶（一条记录一个点）。
      if (block.kind === 'chart' && (block.chartType === 'line' || block.chartType === 'stacked')) {
        const points = block.series ?? [];
        if (points.length >= 6) {
          const bucketed = points.filter((point) => BUCKET_LABEL.test(point.label.trim())).length;
          const rawTimestamps = points.filter((point) => DATE_LIKE.test(point.label) && /\d{1,2}:\d{2}/.test(point.label)).length;
          if (rawTimestamps >= Math.ceil(points.length / 2)) notes.push(`图「${block.title ?? ''}」的横轴是原始时间戳，按天/周/月分桶后才看得出趋势`);
          else if (bucketed < Math.ceil(points.length * 0.6)) notes.push(`图「${block.title ?? ''}」的横轴标签不像时间分桶，读者可能读不出趋势`);
        }
      }
      if (block.kind === 'chart' && (block.extraSeries?.some((series) => series.values.length !== (block.series ?? []).length))) {
        notes.push(`图「${block.title ?? ''}」的附加系列与主系列长度不一致`);
      }
      if (block.kind === 'chart' && block.chartType === 'radar' && ((block.series?.length ?? 0) < 3 || (block.series?.length ?? 0) > 8)) {
        notes.push(`图「${block.title ?? ''}」的雷达维度应控制在 3–8 个`);
      }
      if (block.kind === 'chart' && block.chartType === 'heatmap') {
        const width = block.heatmap?.xLabels.length ?? 0;
        if (!width || (block.heatmap?.values.some((row) => row.length !== width) ?? false)) notes.push(`图「${block.title ?? ''}」的热力矩阵不完整`);
      }
    }
  }

  if (leaksHard.size) {
    errors.push(`标题与结论里出现了技术术语（表名/列名/SQL）：${[...leaksHard].slice(0, 4).join('；')}。把它们移到 assumptions/notes`);
  }
  if (leaksSoft.size && !leaksHard.size) {
    notes.push(`标题或结论里出现了疑似字段名：${[...leaksSoft].slice(0, 4).join('；')}。确认读者能看懂，否则改用业务说法`);
  }

  // 核心指标没有参照点。
  const headlineMetrics = sections
    .slice(0, 2)
    .flatMap((section) => section.blocks)
    .filter((block) => block.kind === 'metric')
    .flatMap((block) => block.metrics ?? []);
  const withoutBaseline = headlineMetrics.filter((metric) => metric.baseline === undefined);
  if (headlineMetrics.length >= 2 && withoutBaseline.length === headlineMetrics.length) {
    notes.push('首屏指标全部没有对比基线：孤立的数字对读者没有意义，请补上环比/同比/目标');
  }

  // 同一个标签出现两个不同的值 = 口径漂移的信号。
  const byLabel = new Map<string, Set<string>>();
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'metric') continue;
      for (const metric of block.metrics ?? []) {
        const values = byLabel.get(metric.label) ?? new Set<string>();
        values.add(String(metric.value));
        byLabel.set(metric.label, values);
      }
    }
  }
  for (const [label, values] of byLabel) {
    if (values.size > 1) notes.push(`指标「${label}」在报告里出现了 ${values.size} 个不同的值，请确认口径是否一致`);
  }

  return { errors, notes };
}
