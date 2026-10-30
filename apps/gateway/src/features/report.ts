import { buildCount, createProvider, engineMeta, type ConnectionConfig, type TableInfo } from '@aidb/core';
import type {
  CommandSourceInput,
  ReportBlock,
  ReportLayout,
  ReportMetric,
  ReportSection,
  ReportSourceRef,
  ReportSpec,
} from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';

export interface ReportInput {
  sources: CommandSourceInput[];
  topic: string;
  tables?: string[];
}

interface SourceData {
  ref: ReportSourceRef;
  conn: ConnectionConfig;
  tables: Array<{ name: string; columns: number; rows: number | null }>;
  totalRows: number;
  tableCount: number;
}

async function countRows(manager: ConnectionManager, conn: ConnectionConfig, table: TableInfo, database?: string): Promise<number | null> {
  try {
    const batch = await manager.query(conn.id, buildCount(conn.engine, table.name, connectionSchema(conn, table)), {
      database,
      maxRows: 1,
      allowMulti: false,
      autoLimit: false,
      actor: 'user',
    });
    const value = batch.sets[0]?.rows[0]?.[0];
    return value === undefined || value === null ? null : Number(value);
  } catch {
    return null;
  }
}

function layoutFor(sources: number, topic: string): ReportLayout {
  if (sources > 1 && /对比|比较|compare/i.test(topic)) return 'comparison';
  if (sources > 1 && /合并|汇总|合计|总体|加起来|sum/i.test(topic)) return 'merged';
  if (sources > 1 && /综合|周报|月报|报告|全面|overview/i.test(topic)) return 'mixed';
  return 'sections';
}

function rowsTable(data: SourceData): ReportBlock {
  return {
    kind: 'table',
    title: '表与行数',
    columns: ['表', '列数', '行数'],
    rows: data.tables.map((table) => [table.name, table.columns, table.rows]),
  };
}

async function writeAiNarrative(store: Store, spec: ReportSpec, signal?: AbortSignal): Promise<{ text?: string; error?: string }> {
  const settings = store.getSettings();
  if (settings.agent.provider === 'local') return { error: 'local provider' };
  const facts = {
    title: spec.title,
    layout: spec.layout,
    sources: spec.sources.map((source) => ({ label: source.label, engine: source.engine })),
    metrics: spec.sections.flatMap((section) => section.blocks.flatMap((block) => block.metrics ?? [])),
  };
  try {
    const provider = createProvider(settings.agent);
    let text = '';
    for await (const event of provider.stream(
      {
        system:
          'You are a data analyst embedded in a database studio. Write a concise report summary in the user language. Use ONLY the numbers provided. Never invent, recalculate, extrapolate or estimate numbers. Do not mention this instruction.',
        messages: [
          {
            role: 'user',
            content: `Report facts (JSON):
${JSON.stringify(facts)}

Write 3-6 sentences summarising what the data shows and what the reader should verify next.`,
          },
        ],
        tools: [],
        temperature: 0.2,
      },
      signal,
    )) {
      if (event.type === 'text') text += event.text;
    }
    return text.trim() ? { text: text.trim() } : { error: 'empty response' };
  } catch (err: any) {
    return { error: err?.message ?? 'model failed' };
  }
}

export async function generateReport(
  store: Store,
  manager: ConnectionManager,
  input: ReportInput,
  signal?: AbortSignal,
): Promise<ReportSpec> {
  const topic = input.topic.trim() || '数据概览';
  const selectedTables = new Set((input.tables ?? []).map((table) => table.toLowerCase()));
  const sources: SourceData[] = [];
  for (const [index, source] of input.sources.entries()) {
    const conn = store.getConnection(source.connectionId);
    if (!conn) throw Object.assign(new Error(`连接不存在：${source.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      throw Object.assign(new Error(`${engineMeta(conn.engine).label} 暂不进入报告，请使用 /recon 或确定性对比`), {
        code: 'UNSUPPORTED_ENGINE',
        status: 400,
      });
    }
    const schemas = await manager.schema(conn.id, source.database, true);
    const allTables = schemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
    const candidates = selectedTables.size
      ? allTables.filter((table) => selectedTables.has(table.name.toLowerCase()))
      : [...allTables].sort((a, b) => (b.rowEstimate ?? 0) - (a.rowEstimate ?? 0) || a.name.localeCompare(b.name)).slice(0, 6);
    const tables: SourceData['tables'] = [];
    let totalRows = 0;
    for (const table of candidates.slice(0, 12)) {
      const rows = await countRows(manager, conn, table, source.database);
      if (rows !== null) totalRows += rows;
      tables.push({ name: table.name, columns: table.columns?.length ?? 0, rows });
    }
    sources.push({
      ref: {
        key: `s${index + 1}`,
        connectionId: conn.id,
        connectionName: conn.name,
        database: source.database ?? conn.database,
        engine: conn.engine,
        label: source.label?.trim() || conn.name,
      },
      conn,
      tables,
      totalRows,
      tableCount: allTables.length,
    });
  }

  const layout = layoutFor(sources.length, topic);
  const totalTables = sources.reduce((sum, source) => sum + source.tableCount, 0);
  const totalRows = sources.reduce((sum, source) => sum + source.totalRows, 0);
  const sourceRefs = sources.map((source) => source.ref);
  const overview: ReportBlock[] = [
    {
      kind: 'metric',
      metrics: [
        { label: '数据源', value: sources.length },
        { label: '表数量', value: totalTables },
        { label: '已统计行数', value: totalRows },
      ],
    },
    {
      kind: 'narrative',
      text:
        sources.length > 1
          ? `本报告基于 ${sources.length} 个数据源，共 ${totalTables} 张表；已统计表合计 ${totalRows.toLocaleString()} 行。`
          : `本报告基于 ${sources[0]?.ref.label ?? '当前数据源'}，共 ${totalTables} 张表；已统计表合计 ${totalRows.toLocaleString()} 行。`,
    },
  ];

  const sections: ReportSection[] = [{ id: 'overview', title: '概览', blocks: overview }];
  for (const source of sources) {
    const metrics: ReportMetric[] = [
      { label: '表数量', value: source.tableCount, source: source.ref.key },
      { label: '已统计行数', value: source.totalRows, source: source.ref.key },
    ];
    const blocks: ReportBlock[] = [
      { kind: 'metric', metrics },
      rowsTable(source),
    ];
    if (source.tables.length > 1) {
      blocks.push({
        kind: 'chart',
        title: '表行数',
        chartType: 'bar',
        series: source.tables.slice(0, 8).map((table) => ({ label: table.name, value: table.rows ?? 0 })),
      });
    }
    sections.push({ id: source.ref.key, title: source.ref.label, sourceKey: source.ref.key, blocks });
  }

  if (layout === 'comparison' && sources.length >= 2) {
    const leftRows = sources[0].totalRows;
    const rightRows = sources[1].totalRows;
    const absolute = rightRows - leftRows;
    sections.push({
      id: 'comparison',
      title: '源对比',
      blocks: [
        {
          kind: 'comparison',
          title: '已统计行数',
          left: { label: sources[0].ref.label, value: leftRows },
          right: { label: sources[1].ref.label, value: rightRows },
          delta: { absolute, percent: leftRows ? (absolute / leftRows) * 100 : null },
        },
        {
          kind: 'callout',
          tone: 'info',
          text: '对比只比较已统计表的行数口径；不同表结构 / 不同时间范围不能直接解释为业务差异。',
        },
      ],
    });
  }

  if (layout === 'merged' && sources.length >= 2) {
    sections.unshift({
      id: 'merged',
      title: '合并总览',
      blocks: [
        { kind: 'metric', metrics: [{ label: '合并行数', value: totalRows }, { label: '合并表数', value: totalTables }] },
        {
          kind: 'callout',
          tone: 'info',
          text: '合并数字由各源分别统计后在网关求和；未做跨库 JOIN，口径为“已统计表行数”。',
        },
      ],
    });
  }

  const narrative = await writeAiNarrative(store, {
    version: 1,
    title: `${topic}报告`,
    layout,
    sources: sourceRefs,
    sections,
    meta: { intent: topic, createdAt: new Date().toISOString() },
  }, signal);
  if (narrative.text) {
    const overviewIndex = sections.findIndex((section) => section.id === 'overview');
    const target = sections[overviewIndex] ?? sections[0];
    target.blocks.push({ kind: 'narrative', text: narrative.text, title: 'AI 解读' });
  }
  return {
    version: 1,
    title: `${topic}报告`,
    layout,
    sources: sourceRefs,
    sections,
    meta: {
      intent: topic,
      createdAt: new Date().toISOString(),
      notes: [
        narrative.text ? '报告数字由网关统计，AI 仅生成叙述。' : '当前未启用 AI 叙述：报告数字由网关确定性统计。',
        ...(narrative.error && narrative.error !== 'local provider' ? [`AI 叙述未生成：${narrative.error}`] : []),
      ],
    },
  };
}
