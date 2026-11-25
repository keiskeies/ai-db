import type { AgentContextBundle, ColumnInfo, DatabaseSchema, Memory, TableInfo } from '../types';
import { expandTerms, isColumnDisabled, isTableDisabled } from '../agent/context';
import { focusTablesForQuestion } from '../agent/prompt';

export type ReportMode = 'overview' | 'diagnosis' | 'target' | 'opportunity' | 'comparison' | 'technical';
export type ReportAnalysis = 'metrics' | 'trend' | 'composition' | 'comparison' | 'attribution' | 'anomaly' | 'target' | 'forecast' | 'detail' | 'actions';
export type ReportColumnRole = 'metric' | 'dimension' | 'time' | 'id' | 'other';

export interface ReportGroundedColumn {
  name: string;
  type: string;
  role: ReportColumnRole;
  alias?: string;
  description?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface ReportGroundedTable {
  database: string;
  name: string;
  kind: string;
  alias?: string;
  description?: string;
  matchReason: string;
  columns: ReportGroundedColumn[];
}

export interface ReportGroundedJoin {
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  source: 'foreign-key' | 'context';
  cardinality?: string;
}

export interface ReportAnalysisStep {
  id: string;
  title: string;
  analyses: ReportAnalysis[];
  tables: string[];
  columns: string[];
  deliverable: string;
}

export interface ReportBrief {
  version: 1;
  originalTopic: string;
  normalizedTopic: string;
  mode: ReportMode;
  audience: 'executive' | 'business' | 'technical';
  objective: string;
  questions: string[];
  mentionedMetrics: string[];
  mentionedDimensions: string[];
  baselines: string[];
  analyses: ReportAnalysis[];
  coverage: {
    minMetrics: number;
    maxMetrics: number;
    minCharts: number;
    maxCharts: number;
    requireAttribution: boolean;
    requireTarget: boolean;
    requireAnomaly: boolean;
  };
  clarification?: string;
  grounding: {
    tables: ReportGroundedTable[];
    joins: ReportGroundedJoin[];
    businessTerms: Array<{ term: string; synonyms: string[]; definition: string }>;
  };
  plan: ReportAnalysisStep[];
}

export interface ReportBriefInput {
  topic: string;
  audience?: ReportBrief['audience'];
  databases?: DatabaseSchema[];
  context?: AgentContextBundle;
  glossary?: Memory[];
  sqlExamples?: Memory[];
  focusTables?: string[];
  compare?: boolean;
}

const METRIC_TERMS = ['订单量', '订单额', '成交额', '客单价', '收入', '营收', '利润', '成本', '退款', '活跃用户', '留存', '转化率', '销量', '库存', '履约', '毛利', '用户数'];
const DIMENSION_TERMS = ['渠道', '地区', '商品', '类目', '客户', '用户', '门店', '商家', '产品', '部门', '来源', '品牌', '品类', '区域', '类型'];
const TIME_WORD = /(^|[_\s.-])(date|time|datetime|timestamp|created|updated|deleted|paid|shipped|delivered)([_\s.-]|$)/i;
const TIME_TYPE = /(date|time|timestamp|interval)/i;
const ID_WORD = /(^|[_\s.-])(id|uuid|key|code|no)([_\s.-]|$)/i;
const METRIC_TYPE = /(int|decimal|numeric|float|double|real|money|number|bigserial|serial)/i;
const TEXT_TYPE = /(char|text|json|xml|blob|binary|uuid|enum)/i;
const MAX_TABLES = 12;
const MAX_COLUMNS = 48;
const MAX_TERMS = 12;

function has(value: string, term: string): boolean {
  return value.toLowerCase().includes(term.toLowerCase());
}

function compact(value: unknown, max = 160): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function detectMode(topic: string, compare: boolean): ReportMode {
  if (compare || /对比|比较|合并|vs\.?|versus|compare/i.test(topic)) return 'comparison';
  if (/数据质量|完整性|唯一性|新鲜度|空值|重复|延迟|质量|quality|freshness|completeness/i.test(topic)) return 'technical';
  if (/目标|计划|达标|完成率|差距|KPI|target|goal|quota/i.test(topic)) return 'target';
  if (/为什么|为何|下滑|下降|下跌|跌|异常|异动|原因|复盘|问题|诊断|why|drop|decline|anomaly/i.test(topic)) return 'diagnosis';
  if (/增长|提升|机会|潜力|优化|找空间|growth|opportunity|potential/i.test(topic)) return 'opportunity';
  return 'overview';
}

function inferAnalyses(mode: ReportMode, topic: string): ReportAnalysis[] {
  const analyses: ReportAnalysis[] = ['metrics', 'trend', 'composition', 'attribution', 'detail', 'actions'];
  if (mode === 'comparison') analyses.unshift('comparison');
  if (mode === 'target') analyses.push('target');
  if (mode === 'diagnosis' || mode === 'technical') analyses.push('anomaly');
  if (/预测|预估| forecast|forecast|projection/i.test(topic)) analyses.push('forecast');
  return [...new Set(analyses)];
}

function questionsFor(mode: ReportMode): string[] {
  switch (mode) {
    case 'diagnosis': return ['变化或异常发生在什么时候、幅度多大？', '主要集中在哪些业务维度？', '哪些维度贡献了主要变化？'];
    case 'target': return ['当前值与目标差距多大？', '哪些维度贡献了缺口？', '优先追赶哪些部分？'];
    case 'opportunity': return ['哪些维度仍有增长空间？', '潜力与当前规模是否匹配？', '最值得优先投入的方向是什么？'];
    case 'comparison': return ['两侧按同一口径相差多少？', '差异集中在哪些维度？', '差异是否由统计范围或数据质量造成？'];
    case 'technical': return ['数据规模、完整性和唯一性如何？', '是否存在异常值、空值或重复？', '哪些问题最值得优先处理？'];
    default: return ['当前业务表现如何？', '趋势和结构发生了什么变化？', '主要风险、机会与下一步是什么？'];
  }
}

function objectiveFor(mode: ReportMode): string {
  switch (mode) {
    case 'diagnosis': return '解释核心指标变化的主要来源，并区分事实与待验证假设。';
    case 'target': return '量化目标完成情况与缺口，给出可执行的追赶重点。';
    case 'opportunity': return '识别有证据支持的增长空间，并按影响与规模排序。';
    case 'comparison': return '用同口径比较两侧差异，定位差异来源。';
    case 'technical': return '评估数据可用性与质量风险，给出可验证的处理优先级。';
    default: return '形成结论先行的业务概览，覆盖规模、趋势、结构、风险与行动。';
  }
}

function columnRole(column: ColumnInfo): ReportColumnRole {
  if (column.primaryKey || ID_WORD.test(column.name)) return 'id';
  if (TIME_WORD.test(column.name) || TIME_TYPE.test(column.type)) return 'time';
  if (METRIC_TYPE.test(column.type) && !ID_WORD.test(column.name)) return 'metric';
  if (TEXT_TYPE.test(column.type)) return 'dimension';
  return 'other';
}

function tableText(table: TableInfo, context?: AgentContextBundle): string {
  const meta = context?.tableMeta[table.name.toLowerCase()];
  const columns = context?.columnMeta[table.name.toLowerCase()] ?? {};
  return compact([
    meta?.alias,
    meta?.description,
    table.comment,
    ...(table.columns ?? []).flatMap((column) => [columns[column.name]?.alias, columns[column.name]?.description, column.comment]),
  ].filter(Boolean).join(' '), 1000);
}

function matchReason(table: TableInfo, context: AgentContextBundle | undefined, focus: string[], topic: string): string {
  if (focus.some((name) => name.toLowerCase() === table.name.toLowerCase())) return '用户指定';
  const text = tableText(table, context).toLowerCase();
  if (text && has(text, topic)) return '业务别名/注释匹配';
  return 'Schema 语义候选';
}

function qualified(database: string, table: string): string {
  return database ? `${database}.${table}` : table;
}

function defaultTables(database: DatabaseSchema): TableInfo[] {
  return [...(database.tables ?? [])]
    .filter((table) => table.type !== 'view')
    .sort((a, b) => (b.rowEstimate ?? 0) - (a.rowEstimate ?? 0))
    .slice(0, 6);
}

function buildGrounding(input: ReportBriefInput): ReportBrief['grounding'] {
  const databases = input.databases ?? [];
  const focus = (input.focusTables ?? []).map(String);
  const grounded: ReportGroundedTable[] = [];

  for (const database of databases) {
    const primary = databases.length === 1 || database === databases[0];
    const context = primary ? input.context : undefined;
    const available = (database.tables ?? []).filter((table) => !isTableDisabled(context, table.name));
    if (!available.length) continue;
    let focused = focusTablesForQuestion({
      question: input.topic,
      databases: [database],
      context,
      glossary: input.glossary,
      sqlExamples: input.sqlExamples,
      attachments: focus,
      max: MAX_TABLES,
    });
    if (!focused.length) focused = defaultTables(database).map((table) => table.name);
    const selected = available.filter((table) => focused.some((name) => name.toLowerCase() === table.name.toLowerCase()));
    for (const table of selected) {
      const meta = context?.tableMeta[table.name.toLowerCase()];
      const columns = (table.columns ?? [])
        .filter((column) => !isColumnDisabled(context, table.name, column.name))
        .slice(0, MAX_COLUMNS)
        .map((column) => {
          const columnMeta = context?.columnMeta[table.name.toLowerCase()]?.[column.name];
          return {
            name: column.name,
            type: compact(column.type, 60),
            role: columnRole(column),
            ...(columnMeta?.alias ? { alias: compact(columnMeta.alias) } : {}),
            ...(columnMeta?.description || column.comment ? { description: compact(columnMeta?.description || column.comment) } : {}),
            nullable: column.nullable,
            primaryKey: column.primaryKey,
          };
        });
      grounded.push({
        database: database.name,
        name: table.name,
        kind: table.kind || table.type,
        ...(meta?.alias || table.comment ? { alias: compact(meta?.alias || table.comment) } : {}),
        ...(meta?.description ? { description: compact(meta.description) } : {}),
        matchReason: matchReason(table, context, focus, input.topic),
        columns,
      });
    }
  }

  const tables = grounded.slice(0, MAX_TABLES);
  const selectedNames = new Set(tables.map((table) => qualified(table.database, table.name).toLowerCase()));
  const joins: ReportGroundedJoin[] = [];
  const seenJoins = new Set<string>();
  const addJoin = (join: ReportGroundedJoin) => {
    const key = [join.leftTable, join.leftColumn, join.rightTable, join.rightColumn, join.source].join('|').toLowerCase();
    if (!seenJoins.has(key)) {
      seenJoins.add(key);
      joins.push(join);
    }
  };
  for (const database of databases) {
    const context = databases.length === 1 || database === databases[0] ? input.context : undefined;
    const selected = (database.tables ?? []).filter((table) =>
      !isTableDisabled(context, table.name) && selectedNames.has(qualified(database.name, table.name).toLowerCase()));
    for (const table of selected) {
      for (const fk of table.foreignKeys ?? []) {
        const rightName = qualified(database.name, fk.refTable);
        if (!selectedNames.has(rightName.toLowerCase())) continue;
        for (const [index, column] of fk.columns.entries()) {
          addJoin({ leftTable: qualified(database.name, table.name), leftColumn: column, rightTable: rightName, rightColumn: fk.refColumns[index] ?? '', source: 'foreign-key', cardinality: 'N:1' });
        }
      }
    }
    if (!context || context.database.toLowerCase() !== database.name.toLowerCase()) continue;
    for (const relation of context.relations ?? []) {
      const left = qualified(database.name, relation.leftTable);
      const right = qualified(database.name, relation.rightTable);
      if (!selectedNames.has(left.toLowerCase()) || !selectedNames.has(right.toLowerCase())) continue;
      addJoin({ leftTable: left, leftColumn: relation.leftColumn, rightTable: right, rightColumn: relation.rightColumn, source: 'context', cardinality: 'unknown' });
    }
  }

  const businessTerms = (input.glossary ?? []).slice(0, MAX_TERMS).map((term) => ({
    term: compact(term.title, 80),
    synonyms: (term.synonyms ?? []).map((synonym) => compact(synonym, 40)).filter(Boolean).slice(0, 8),
    definition: compact(term.content, 240),
  }));
  return { tables, joins: joins.slice(0, 40), businessTerms };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildPlan(brief: Omit<ReportBrief, 'plan'>, grounding: ReportBrief['grounding']): ReportAnalysisStep[] {
  const tables = grounding.tables.map((table) => qualified(table.database, table.name));
  const fields = grounding.tables.flatMap((table) => table.columns.map((column) => `${qualified(table.database, table.name)}.${column.name}`));
  const metrics = grounding.tables.flatMap((table) => table.columns.filter((column) => column.role === 'metric').map((column) => `${qualified(table.database, table.name)}.${column.name}`));
  const dimensions = grounding.tables.flatMap((table) => table.columns.filter((column) => column.role === 'dimension').map((column) => `${qualified(table.database, table.name)}.${column.name}`));
  const times = grounding.tables.flatMap((table) => table.columns.filter((column) => column.role === 'time').map((column) => `${qualified(table.database, table.name)}.${column.name}`));
  const ids = grounding.tables.flatMap((table) => table.columns.filter((column) => column.role === 'id').map((column) => `${qualified(table.database, table.name)}.${column.name}`));
  const conditional: ReportAnalysis[] = brief.analyses.filter((analysis) => ['comparison', 'attribution', 'anomaly', 'target', 'forecast'].includes(analysis));
  return [
    { id: 'bind', title: '对象与口径绑定', analyses: ['metrics'], tables, columns: unique(fields), deliverable: '确认业务词到表/字段的映射、表粒度、时间列、维度列和 JOIN 路径；不匹配时先检查结构。' },
    { id: 'kpis', title: '核心指标与基线', analyses: ['metrics'], tables, columns: unique([...metrics, ...times]), deliverable: `${brief.coverage.minMetrics}–${brief.coverage.maxMetrics} 个核心 KPI，并补齐同比/环比/目标基线。` },
    { id: 'shape', title: '趋势与结构', analyses: ['trend', 'composition'], tables, columns: unique([...metrics, ...dimensions, ...times]), deliverable: '至少两张有区分度的图：时间趋势 + 构成/分组；类别过多时 Top N + 其他。' },
    { id: 'explain', title: '变化解释与条件分析', analyses: conditional.length ? conditional : ['attribution'], tables, columns: unique([...metrics, ...dimensions, ...times, ...ids]), deliverable: conditional.includes('anomaly') ? '输出归因明细和异常窗口；事实与假设分开。' : conditional.includes('target') ? '输出目标完成率、缺口和缺口维度。' : conditional.includes('comparison') ? '输出同口径两侧差异与差异维度。' : '输出维度/本期/上期/变化/贡献度明细。' },
    { id: 'deliver', title: '汇总与行动', analyses: ['actions'], tables: [], columns: [], deliverable: '结论先行，列出风险与 1–3 条有证据的可执行建议；无法回答的分析明确说明原因。' },
  ];
}

export function buildReportBrief(input: ReportBriefInput): ReportBrief {
  const topic = compact(input.topic || '整体数据概览', 500);
  const glossary = input.glossary ?? [];
  const normalizedTopic = compact(expandTerms(topic, glossary), 1000);
  const audience = input.audience ?? (/老板|管理层|高管|executive/i.test(topic) ? 'executive' : /技术|开发|数据质量|technical/i.test(topic) ? 'technical' : 'business');
  const mode = detectMode(topic, Boolean(input.compare));
  const analyses = inferAnalyses(mode, topic);
  const grounding = buildGrounding({ ...input, topic: normalizedTopic });
  const termText = grounding.businessTerms.map((term) => `${term.term} ${term.synonyms.join(' ')}`).join(' ');
  const mentionedMetrics = unique([
    ...METRIC_TERMS.filter((term) => has(topic, term)),
    ...grounding.businessTerms.filter((term) => has(topic, term.term) || term.synonyms.some((synonym) => has(topic, synonym))).map((term) => term.term),
  ]);
  const mentionedDimensions = unique([...DIMENSION_TERMS.filter((term) => has(topic, term)), ...(termText ? DIMENSION_TERMS.filter((term) => has(termText, term)) : [])]);
  const baselines = unique([
    ...(['环比', '同比', '目标', '上期', '上周', '上月', '去年同期', 'baseline', 'target'].filter((term) => has(topic, term))),
    '环比', '同比',
  ]);
  const minMetrics = mode === 'comparison' ? 2 : audience === 'technical' ? 6 : 4;
  const maxMetrics = audience === 'technical' ? 8 : 6;
  const core: Omit<ReportBrief, 'plan'> = {
    version: 1,
    originalTopic: topic,
    normalizedTopic,
    mode,
    audience,
    objective: objectiveFor(mode),
    questions: questionsFor(mode),
    mentionedMetrics,
    mentionedDimensions,
    baselines,
    analyses,
    coverage: {
      minMetrics,
      maxMetrics,
      minCharts: 2,
      maxCharts: audience === 'executive' ? 3 : 4,
      requireAttribution: mode === 'diagnosis' || mode === 'opportunity',
      requireTarget: mode === 'target',
      requireAnomaly: mode === 'diagnosis' || mode === 'technical',
    },
    grounding,
    ...(!grounding.tables.length ? { clarification: '当前 schema 没有可用业务表；请确认连接、目标库或 Agent 上下文中的表是否被禁用。' } : {}),
  };
  return { ...core, plan: buildPlan(core, grounding) };
}

function columnLine(role: string, columns: ReportGroundedColumn[]): string {
  return columns.length ? `  - ${role}: ${columns.map((column) => `${column.name}:${column.type}${column.alias ? `→${column.alias}` : ''}${column.description ? `[${column.description}]` : ''}`).join('; ')}` : '';
}

export function formatReportBriefForPrompt(brief: ReportBrief): string {
  const lines = [
    '## Report brief (schema-grounded)',
    `Objective: ${brief.objective}`,
    `Mode: ${brief.mode} · Audience: ${brief.audience}`,
    `Questions: ${brief.questions.join(' / ')}`,
    `Mentioned metrics: ${brief.mentionedMetrics.join(' / ') || '由 schema 与术语确认'}`,
    `Mentioned dimensions: ${brief.mentionedDimensions.join(' / ') || '由 schema 与术语确认'}`,
    `Baselines: ${brief.baselines.join(' / ')}`,
    `Coverage: ${brief.coverage.minMetrics}–${brief.coverage.maxMetrics} KPIs, ${brief.coverage.minCharts}–${brief.coverage.maxCharts} meaningful charts; omissions must be explained.`,
    '',
    '### Candidate schema objects — candidates, not confirmed definitions',
  ];
  for (const table of brief.grounding.tables) {
    const name = qualified(table.database, table.name);
    lines.push(`- ${name} [${table.kind}] · ${table.matchReason}${table.alias ? ` · 业务名=${table.alias}` : ''}${table.description ? ` · ${table.description}` : ''}`);
    for (const role of ['metric', 'dimension', 'time', 'id', 'other']) {
      const line = columnLine(role, table.columns.filter((column) => column.role === role));
      if (line) lines.push(line);
    }
  }
  if (!brief.grounding.tables.length) lines.push('- 未匹配到可用表；第一步必须检查连接/schema，不得猜表。');
  lines.push('', '### Allowed join paths');
  if (brief.grounding.joins.length) {
    for (const join of brief.grounding.joins) lines.push(`- ${join.leftTable}.${join.leftColumn} → ${join.rightTable}.${join.rightColumn} (${join.source}${join.cardinality ? `, ${join.cardinality}` : ''})`);
  } else lines.push('- 未发现明确 JOIN 路径；优先单表聚合，不猜关联键。');
  if (brief.grounding.businessTerms.length) {
    lines.push('', '### Business terms and aliases');
    for (const term of brief.grounding.businessTerms) lines.push(`- ${term.term}${term.synonyms.length ? ` (${term.synonyms.join(' / ')})` : ''} → ${term.definition}`);
  }
  lines.push('', '### Analysis plan (objects and fields bound)');
  for (const [index, step] of brief.plan.entries()) {
    lines.push(`${index + 1}. ${step.title} [${step.analyses.join(', ')}]`);
    lines.push(`   Tables: ${step.tables.join(', ') || '无，使用已验证结果汇总'}`);
    lines.push(`   Fields: ${step.columns.join(', ') || '无'}`);
    lines.push(`   Output: ${step.deliverable}`);
  }
  if (brief.clarification) lines.push('', `Clarification: ${brief.clarification}`);
  lines.push('', 'Binding rules: confirm the business-word → table/column mapping before querying; verify grain, filters and units with inspect_schema/profile_column/sample_rows or an existing standard SQL; if a candidate is wrong, state the corrected mapping; never join across sources or invent join keys.');
  return lines.join('\n');
}
