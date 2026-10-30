import { randomUUID } from 'node:crypto';
import {
  AgentRuntime,
  compressSchema,
  createProvider,
  getTool,
  providerTools,
  type CommandSourceInput,
  type ProviderTool,
  type ReportBlock,
  type ReportLayout,
  type ReportSection,
  type ReportSourceRef,
  type ReportSpec,
  type ToolDefinition,
  type ToolResult,
} from '@aidb/core';
import type { ToolExecutor } from '../executor';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

const REPORT_TOOLS = [
  'inspect_schema',
  'search_objects',
  'run_sql',
  'explain_sql',
  'sample_rows',
  'profile_column',
  'analyze_chart',
  'forecast_chart',
  'render_chart',
  'memory_search',
  'update_plan',
];

const COMPOSE_REPORT: ToolDefinition = {
  name: 'compose_report',
  description:
    'Submit the final report specification. Call exactly once when you have gathered all numbers. Every numeric value in metric/chart/table blocks must come from a previous tool result; never calculate or invent numbers.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'layout', 'sections'],
    properties: {
      title: { type: 'string' },
      layout: { type: 'string', enum: ['sections', 'comparison', 'merged', 'mixed'] },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          required: ['title', 'blocks'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            sourceKey: { type: 'string' },
            blocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  summarize: () => '提交报告规格',
};

const TOOL_DEFS = new Map<string, ToolDefinition>(
  providerTools().filter((tool) => REPORT_TOOLS.includes(tool.name)).map((tool) => [tool.name, getTool(tool.name)!]),
);
TOOL_DEFS.set('compose_report', COMPOSE_REPORT);

function providerToolsForReport(): ProviderTool[] {
  return [...TOOL_DEFS.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

function collectNumbers(value: unknown, out: Set<number>, depth = 0): void {
  if (depth > 8 || out.size > 5000) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectNumbers(item, out, depth + 1);
  }
}

function hasNumber(out: Set<number>, value: unknown): boolean {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return true;
  for (const known of out) {
    if (Math.abs(known - numeric) <= Math.max(0.000001, Math.abs(known) * 1e-9)) return true;
  }
  return false;
}

function invalid(message: string): ToolResult {
  return { ok: false, summary: '报告规格不合法', error: { code: 'INVALID_REPORT_SPEC', message }, meta: { durationMs: 0 } };
}

export function normalizeReportBlock(
  raw: any,
  numbers: Set<number>,
  refNumbers: Map<string, Set<number>>,
  requireRef: boolean,
): ReportBlock | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'block 必须是对象' };
  const kind = raw.kind;
  const blockRef = typeof raw.resultRef === 'string' ? raw.resultRef : undefined;
  const checkRef = (ref: string | undefined, label: string): Set<number> | { error: string } => {
    if (!ref) {
      if (requireRef) return { error: `${label} 缺少 resultRef` };
      return numbers;
    }
    const refSet = refNumbers.get(ref);
    if (!refSet) return { error: `${label} 的 resultRef 不存在：${ref}` };
    return refSet;
  };
  if (kind === 'narrative') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) return { error: 'narrative 缺少 text' };
    return { kind, text: raw.text.trim() };
  }
  if (kind === 'callout') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) return { error: 'callout 缺少 text' };
    return { kind, text: raw.text.trim(), tone: raw.tone === 'warning' || raw.tone === 'danger' ? raw.tone : 'info' };
  }
  if (kind === 'metric') {
    const metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
    if (!metrics.length) return { error: 'metric 缺少 metrics' };
    const out: any[] = [];
    for (const metric of metrics) {
      const label = String(metric?.label ?? '');
      if (!label) continue;
      const ref = typeof metric?.resultRef === 'string' ? metric.resultRef : blockRef;
      const refSet = checkRef(ref, `指标 ${label}`);
      if ('error' in refSet) return refSet;
      if (!hasNumber(refSet, metric?.value)) return { error: `指标 ${label} 的数字没有对应 resultRef 的来源` };
      out.push({
        label,
        value: metric?.value,
        unit: metric?.unit === undefined ? undefined : String(metric.unit),
        resultRef: ref,
      });
    }
    if (!out.length) return { error: 'metric 缺少有效指标' };
    return { kind, resultRef: blockRef, metrics: out };
  }
  if (kind === 'table') {
    const refSet = checkRef(blockRef, 'table');
    if ('error' in refSet) return refSet;
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    for (const row of rows) {
      if (!Array.isArray(row)) return { error: 'table.rows 必须是数组' };
      for (const cell of row) {
        if (!hasNumber(refSet, cell)) return { error: '表格数字没有对应 resultRef 的来源' };
      }
    }
    return {
      kind,
      resultRef: blockRef,
      title: raw.title === undefined ? undefined : String(raw.title),
      columns: Array.isArray(raw.columns) ? raw.columns.map(String) : [],
      rows: rows.map((row: unknown[]) => row.map((cell) => (cell === null || cell === undefined ? null : String(cell)))),
    };
  }
  if (kind === 'chart') {
    const refSet = checkRef(blockRef, 'chart');
    if ('error' in refSet) return refSet;
    const series = Array.isArray(raw.series) ? raw.series : [];
    if (!series.length) return { error: 'chart 缺少 series' };
    for (const point of series) {
      if (!hasNumber(refSet, point?.value)) return { error: '图表数字没有对应 resultRef 的来源' };
    }
    return {
      kind,
      resultRef: blockRef,
      title: raw.title === undefined ? undefined : String(raw.title),
      chartType: raw.chartType === 'line' || raw.chartType === 'pie' ? raw.chartType : 'bar',
      series: series.map((point: any) => ({ label: String(point?.label ?? ''), value: Number(point?.value) })),
    };
  }
  if (kind === 'comparison') {
    const left = raw.left ?? {};
    const right = raw.right ?? {};
    const leftRef = typeof left.resultRef === 'string' ? left.resultRef : blockRef;
    const rightRef = typeof right.resultRef === 'string' ? right.resultRef : blockRef;
    const leftSet = checkRef(leftRef, 'comparison.left');
    if ('error' in leftSet) return leftSet;
    const rightSet = checkRef(rightRef, 'comparison.right');
    if ('error' in rightSet) return rightSet;
    if (!hasNumber(leftSet, left.value) || !hasNumber(rightSet, right.value)) {
      return { error: 'comparison 的数字没有对应 resultRef 的来源' };
    }
    const l = Number(left.value);
    const r = Number(right.value);
    return {
      kind,
      resultRef: blockRef,
      title: raw.title === undefined ? undefined : String(raw.title),
      left: { label: String(left.label ?? 'A'), value: l, resultRef: leftRef },
      right: { label: String(right.label ?? 'B'), value: r, resultRef: rightRef },
      delta: { absolute: r - l, percent: l ? ((r - l) / l) * 100 : null },
    };
  }
  return { error: `不支持的 block kind：${String(kind)}` };
}

export interface AgentReportInput {
  sources: CommandSourceInput[];
  topic: string;
  tables?: string[];
  mode?: 'report' | 'compare';
  leftLabel?: string;
  rightLabel?: string;
  queryA?: string;
  queryB?: string;
}

export async function generateAgentReport(
  store: Store,
  manager: ConnectionManager,
  executor: ToolExecutor,
  input: AgentReportInput,
  signal?: AbortSignal,
): Promise<ReportSpec> {
  const settings = store.getSettings();
  if (settings.agent.provider === 'local') throw Object.assign(new Error('本地推理器不生成 Agent 报告'), { code: 'MODEL_REQUIRED', status: 400 });
  const provider = createProvider(settings.agent);
  const schemas: Array<{ source: CommandSourceInput; connection: any; schemas: any[]; label: string }> = [];
  for (const [index, source] of input.sources.entries()) {
    const connection = store.getConnection(source.connectionId);
    if (!connection) throw Object.assign(new Error(`连接不存在：${source.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
    const loaded = await manager.schema(connection.id, source.database, true);
    schemas.push({
      source,
      connection,
      schemas: loaded,
      label: source.label?.trim() || connection.name || `源 ${index + 1}`,
    });
  }
  const sourceRefs: ReportSourceRef[] = schemas.map((item, index) => ({
    key: `s${index + 1}`,
    connectionId: item.connection.id,
    connectionName: item.connection.name,
    database: item.source.database ?? item.connection.database,
    engine: item.connection.engine,
    label: item.label,
  }));
  const schemaText = schemas
    .map((item) => {
      const focus = input.tables?.length ? input.tables : [];
      return `### Source [${item.connection.id}] ${item.label} (${item.connection.engine})\n${compressSchema(item.schemas, focus, 12)}`;
    })
    .join('\n\n');
  const connectionsText = sourceRefs
    .map((source) => `- [${source.connectionId}] label=${source.label} engine=${source.engine} database=${source.database ?? ''}`)
    .join('\n');

  const compare = input.mode === 'compare';
  const header = compare
    ? `You are AiDB Compare Agent. Compare the two sides using the selected data sources.
Metric: ${input.topic}
Side A: ${input.leftLabel ?? 'A'}
Side B: ${input.rightLabel ?? 'B'}
${input.queryA ? `Side A SQL (use exactly): ${input.queryA}` : 'Generate a Side A SQL with a single numeric result.'}
${input.queryB ? `Side B SQL (use exactly): ${input.queryB}` : 'Generate a Side B SQL with a single numeric result.'}
${input.tables?.length ? `Focus tables: ${input.tables.join(', ')}` : ''}`
    : `You are AiDB Report Agent. Generate a report for the user's topic using the selected data sources.
Topic: ${input.topic}
${input.tables?.length ? `Focus tables: ${input.tables.join(', ')}` : ''}`;
  const system = `${header}

## Connections
${connectionsText}

## Schema
${schemaText}

Rules:
- Use only read-only tools (inspect_schema, search_objects, run_sql, explain_sql, sample_rows, profile_column, analyze_chart, forecast_chart, render_chart, memory_search, update_plan).
- Inspect schema before writing SQL when unsure. Keep SQL bounded; use aggregate SQL for summaries.
- Never calculate totals, deltas, ratios or shares by hand. Use one aggregate SQL or analyze_chart; quote its numbers verbatim. The app computes comparison deltas from the submitted left/right values.
- Report chart blocks support bar / line / pie only. Choose line for an ordered time axis, bar for category comparisons, and pie only for 2–6 non-negative parts of one whole. Other render_chart types (stacked/scatter/heatmap/radar) are for exploration during the turn, not for compose_report blocks; never force them into a pie just to add a chart.
- Do not join across different sources. Each source is queried separately; if the user asks for a merged total, aggregate per source and label the result.
- ${compare ? 'This is a comparison: use layout comparison and include a comparison block with the two numeric results. Both queries must use the same aggregation and filters; only the compared period/segment may differ.' : 'Choose the layout from the user semantics: sections for per-source sections, comparison for side-by-side comparison, merged for summed totals, mixed for a broad report. Do not ask the user which layout.'}
- The ONLY acceptable completion is a successful compose_report tool call. A plain-text answer is invalid and will be discarded.
- When ready, call compose_report exactly once. Every data block (metric/table/chart/comparison) MUST include resultRef = the tool call id shown in the tool result; every numeric value must come from that referenced result. The app rejects missing or wrong references.
- If the data cannot answer the question, still call compose_report with a narrative-only section that states the concrete missing table/column; do not answer with prose.
- Example metric block: {"kind":"metric","resultRef":"<tool-call-id>","metrics":[{"label":"2024 订单数","value":12345,"resultRef":"<tool-call-id>"}]}
- After compose_report succeeds, give one short sentence. Reply in the user's language.`;

  let captured: ReportSpec | undefined;
  let composeError = '';
  const knownNumbers = new Set<number>();
  const toolNumbers = new Map<string, Set<number>>();
  const runtime = new AgentRuntime({
    provider,
    maxSteps: Math.min(40, Math.max(20, (settings.agent.maxSteps || 12) * 2)),
    temperature: settings.agent.temperature,
    generateId: () => randomUUID(),
    tools: providerToolsForReport(),
    getTool: (name) => TOOL_DEFS.get(name),
    buildSystem: () => system,
    requestApproval: async () => ({ decision: 'deny', scope: 'once' }),
    emit: (event) => {
      if (event.type === 'tool_result' && event.tool === 'compose_report' && !event.result.ok) {
        composeError = event.result.error?.message ?? event.result.summary;
      }
    },
    executeTool: async (call, abort) => {
      if (call.name === 'compose_report') {
        const args = call.args as any;
        const numbers = knownNumbers;
        if (typeof args?.title !== 'string' || !args.title.trim()) return invalid('缺少 title');
        const layout: ReportLayout = ['sections', 'comparison', 'merged', 'mixed'].includes(args.layout) ? args.layout : 'sections';
        if (!Array.isArray(args.sections) || !args.sections.length) return invalid('缺少 sections');
        const sections: ReportSection[] = [];
        for (const [index, rawSection] of args.sections.slice(0, 30).entries()) {
          const blocks: ReportBlock[] = [];
          for (const rawBlock of Array.isArray(rawSection?.blocks) ? rawSection.blocks.slice(0, 30) : []) {
            const block = normalizeReportBlock(rawBlock, numbers, toolNumbers, true);
            if ('error' in block) return invalid(`第 ${index + 1} 节：${block.error}`);
            blocks.push(block);
          }
          sections.push({
            id: String(rawSection?.id ?? `section-${index + 1}`),
            title: String(rawSection?.title ?? `章节 ${index + 1}`),
            sourceKey: rawSection?.sourceKey === undefined ? undefined : String(rawSection.sourceKey),
            blocks,
          });
        }
        captured = {
          version: 1,
          title: args.title.trim(),
          layout,
          sources: sourceRefs,
          sections,
          meta: {
            intent: input.topic,
            createdAt: new Date().toISOString(),
            notes: [...(Array.isArray(args.notes) ? args.notes.map(String) : []), compare ? '对比由 Agent 查数，差值由应用计算。' : '报告由 Agent 查数并生成。'],
          },
        };
        return {
          ok: true,
          summary: `报告规格已提交：${sections.length} 个章节`,
          data: { title: captured.title, layout, sections: sections.length },
          meta: { durationMs: 0 },
        };
      }
      const result = await executor.execute(call, {
        sessionId: `report:${input.topic}`,
        connectionId: typeof call.args.connectionId === 'string' ? call.args.connectionId : undefined,
        database: typeof call.args.database === 'string' ? call.args.database : undefined,
        signal: abort,
      });
      if (result.ok && ['run_sql', 'analyze_chart', 'forecast_chart', 'render_chart', 'sample_rows', 'profile_column'].includes(call.name)) {
        const refSet = new Set<number>();
        collectNumbers(result.data, refSet);
        toolNumbers.set(call.id, refSet);
        for (const value of refSet) knownNumbers.add(value);
      }
      return result;
    },
  });

  const result = await runtime.run({
    sessionId: `${compare ? 'compare' : 'report'}:${Date.now()}`,
    userText: input.topic,
    mode: 'readonly',
    environment: 'dev',
    connectionReadonly: false,
    history: [],
    context: {
      connection: schemas[0]?.connection,
      databases: schemas[0]?.schemas,
      sources: schemas.map((item) => ({ connection: item.connection, databases: item.schemas, label: item.label })),
    },
  });
  if (result.status !== 'done') throw Object.assign(new Error(result.error?.message ?? '报告生成失败'), { code: result.error?.code ?? 'MODEL_REPORT_FAILED', status: 502 });
  if (!captured) throw Object.assign(new Error(`模型没有提交报告规格${composeError ? `：${composeError}` : ''}`), { code: 'MODEL_REPORT_FAILED', status: 502 });
  return captured;
}
