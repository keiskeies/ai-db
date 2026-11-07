import type { AgentContextBundle, ColumnInfo, Memory, TableInfo } from '../../types';
import { applyTableVisibility, isTableDisabled } from '../context';
import { focusTablesForQuestion } from '../prompt';
import { foreignKeyColumnsOf, isDimensionColumn, isMeasureColumn, isNumericColumn, isTimeColumn, visibleColumns } from '../suggest';

/**
 * 离线推理器的语义接地层。
 *
 * 刻意复用云端提示词那套纯函数（focusTablesForQuestion / isMeasureColumn …），
 * 而不是另写一套正则：否则同一个库在离线与在线模式下会选中不同的表和列，
 * 用户维护的业务别名也只在其中一条路径上生效。
 */
export interface GroundingOptions {
  bundle?: AgentContextBundle;
  glossary?: Memory[];
  sqlExamples?: Memory[];
  memories?: Memory[];
  database?: string;
  attachments?: string[];
}

const lower = (value: string): string => value.trim().toLowerCase();
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 词边界匹配，避免 order 命中 order_items、id 命中 user_id。 */
function mentionsName(prompt: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9_])${escapeRegex(name.toLowerCase())}([^a-z0-9_]|$)`).test(prompt.toLowerCase());
}

function byLongest<T>(items: T[], length: (item: T) => number): T | undefined {
  return [...items].sort((a, b) => length(b) - length(a))[0];
}

export function groundedTables(tables: TableInfo[], opts: GroundingOptions = {}): TableInfo[] {
  return applyTableVisibility(tables, opts.bundle);
}

export function groundedColumns(table: TableInfo, opts: GroundingOptions = {}): ColumnInfo[] {
  return visibleColumns(table, opts.bundle);
}

/**
 * 按当前问题给表排序，只返回有信号的表（别名/描述/注释/术语命中，或外键邻居）。
 * 没有任何信号时返回空数组，调用方据此决定是追问还是退化到单表。
 */
export function rankTables(prompt: string, tables: TableInfo[], opts: GroundingOptions = {}): TableInfo[] {
  const visible = groundedTables(tables, opts);
  if (!prompt.trim() || !visible.length) return [];
  const byName = new Map(visible.map((table) => [lower(table.name), table]));
  const ranked = focusTablesForQuestion({
    question: prompt,
    databases: [{ name: opts.database ?? 'main', tables: visible }],
    context: opts.bundle,
    glossary: opts.glossary,
    sqlExamples: opts.sqlExamples,
    memories: opts.memories,
    attachments: opts.attachments,
    max: visible.length,
  });
  return ranked.map((name) => byName.get(lower(name))).filter((table): table is TableInfo => Boolean(table));
}

/**
 * 显式写了表名时以字面匹配为准，其余交给打分；单表库直接落定。
 * 单表兜底看的是传入的完整表数，不是过滤后的：否则禁用一张表就会让问题被静默答成另一张表。
 */
export function matchTable(prompt: string, tables: TableInfo[], opts: GroundingOptions = {}): TableInfo | undefined {
  const visible = groundedTables(tables, opts);
  if (!visible.length) return undefined;
  const explicit = byLongest(visible.filter((table) => mentionsName(prompt, table.name)), (table) => table.name.length);
  if (explicit) return explicit;
  const ranked = rankTables(prompt, visible, opts);
  if (ranked.length) return ranked[0];
  const named = prompt.match(/(?:表|table)\s*[`"']?([A-Za-z_][A-Za-z0-9_]*)/i);
  if (named) {
    const found = visible.find((table) => lower(table.name) === lower(named[1]));
    if (found) return found;
  }
  return tables.length === 1 ? visible[0] : undefined;
}

/** 问题明确指向一张被禁用的表时返回它，让调用方说清楚而不是猜一张替代表。 */
export function hiddenTableMention(prompt: string, tables: TableInfo[], opts: GroundingOptions = {}): TableInfo | undefined {
  const bundle = opts.bundle;
  if (!bundle?.disabledTables.length || !prompt.trim()) return undefined;
  const hidden = tables.filter((table) => isTableDisabled(bundle, table.name));
  if (!hidden.length) return undefined;
  const named = byLongest(hidden.filter((table) => mentionsName(prompt, table.name)), (table) => table.name.length);
  if (named) return named;
  const p = lower(prompt);
  return byLongest(
    hidden.filter((table) => {
      const alias = bundle.tableMeta[lower(table.name)]?.alias?.trim();
      return Boolean(alias && alias.length >= 2 && p.includes(lower(alias)));
    }),
    (table) => (bundle.tableMeta[lower(table.name)]?.alias ?? '').length,
  );
}

/**
 * 物理名 → 业务别名 → 原生注释，三级匹配。
 * 别名与注释按长度取最长命中，避免「金额」被「金额单位」这类短别名抢走。
 */
export function matchColumn(prompt: string, table: TableInfo, opts: GroundingOptions = {}): ColumnInfo | undefined {
  const columns = groundedColumns(table, opts);
  if (!columns.length || !prompt.trim()) return undefined;
  const physical = byLongest(columns.filter((column) => mentionsName(prompt, column.name)), (column) => column.name.length);
  if (physical) return physical;
  const p = lower(prompt);
  const meta = opts.bundle?.columnMeta[lower(table.name)] ?? {};
  const aliased = columns.filter((column) => {
    const alias = (meta[column.name] ?? meta[lower(column.name)])?.alias?.trim();
    return Boolean(alias && alias.length >= 2 && p.includes(lower(alias)));
  });
  const byAlias = byLongest(aliased, (column) => ((meta[column.name] ?? meta[lower(column.name)])?.alias ?? '').length);
  if (byAlias) return byAlias;
  const commented = columns.filter((column) => column.comment && column.comment.trim().length >= 2 && p.includes(lower(column.comment)));
  return byLongest(commented, (column) => (column.comment ?? '').length);
}

const MEASURE_HINT = /(amount|total|price|cents|money|revenue|sales|qty|quantity|num|score|duration)/i;
const DIMENSION_ORDER = ['status', 'state', 'type', 'category', 'kind', 'class', 'channel', 'source', 'level', 'grade', 'region', 'city'];
const TIME_ORDER = /(created?_?at|create_?time|created?_?time|^date$|^time$|timestamp|updated?_?at)/i;

/** 度量列：排除主键/外键/标识列后，优先用户点名的，其次业务常见命名。 */
export function pickMeasure(table: TableInfo, prompt: string, opts: GroundingOptions = {}): ColumnInfo | undefined {
  const fkColumns = foreignKeyColumnsOf(table);
  const measures = groundedColumns(table, opts).filter((column) => isMeasureColumn(column, fkColumns));
  if (!measures.length) return undefined;
  const mentioned = matchColumn(prompt, table, opts);
  if (mentioned && measures.some((column) => column.name === mentioned.name)) return mentioned;
  return measures.find((column) => MEASURE_HINT.test(column.name)) ?? measures[0];
}

export function pickDimension(table: TableInfo, prompt: string, opts: GroundingOptions = {}): ColumnInfo | undefined {
  const dimensions = groundedColumns(table, opts).filter(isDimensionColumn);
  if (!dimensions.length) return undefined;
  const mentioned = matchColumn(prompt, table, opts);
  if (mentioned && dimensions.some((column) => column.name === mentioned.name)) return mentioned;
  for (const name of DIMENSION_ORDER) {
    const found = dimensions.find((column) => lower(column.name) === name);
    if (found) return found;
  }
  return dimensions[0];
}

export function pickTimeColumn(table: TableInfo, prompt: string, opts: GroundingOptions = {}): ColumnInfo | undefined {
  const times = groundedColumns(table, opts).filter(isTimeColumn);
  if (!times.length) return undefined;
  const mentioned = matchColumn(prompt, table, opts);
  if (mentioned && times.some((column) => column.name === mentioned.name)) return mentioned;
  return times.find((column) => TIME_ORDER.test(column.name)) ?? times[0];
}

/** 散点轴要的是任意两个数值列，不能用 pickMeasure（它会排除标识列）。 */
export function numericColumns(table: TableInfo, opts: GroundingOptions = {}): ColumnInfo[] {
  return groundedColumns(table, opts).filter(isNumericColumn);
}