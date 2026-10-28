import type { AgentContextBundle, AgentContextEntry, Memory } from '../types';
import { EMPTY_AGENT_CONTEXT_BUNDLE } from '../types';

export interface BundleOptions {
  connectionId?: string;
  database?: string;
}

const lower = (value: string): string => value.trim().toLowerCase();

/**
 * 把扁平的覆盖项聚合成 prompt 可直接消费的结构。
 *
 * 表名/列名一律小写归一后作为 key——MySQL 在 Windows 下大小写不敏感、
 * PostgreSQL 全小写、Oracle 全大写，不归一会漏配。
 */
export function bundleAgentContext(entries: AgentContextEntry[], opts: BundleOptions = {}): AgentContextBundle {
  const bundle: AgentContextBundle = {
    connectionId: opts.connectionId ?? '',
    database: opts.database ?? '',
    disabledTables: [],
    disabledColumns: {},
    tableMeta: {},
    columnMeta: {},
    relations: [],
  };
  const disabledTables = new Set<string>();
  const disabledColumns = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!entry || !entry.table) continue;
    const table = lower(entry.table);
    const hasSemantics = Boolean(entry.alias?.trim() || entry.description?.trim());

    if (entry.kind === 'relation') {
      const refTable = entry.refTable?.trim();
      const leftColumn = entry.column?.trim();
      const rightColumn = entry.refColumn?.trim();
      if (!refTable || !leftColumn || !rightColumn) continue;
      bundle.relations.push({
        leftTable: entry.table.trim(),
        leftColumn,
        rightTable: refTable,
        rightColumn: rightColumn,
        description: entry.description?.trim() || undefined,
      });
      continue;
    }

    if (entry.kind === 'column') {
      const column = entry.column?.trim();
      if (!column) continue;
      if (!entry.enabled) {
        const set = disabledColumns.get(table) ?? new Set<string>();
        set.add(lower(column));
        disabledColumns.set(table, set);
      }
      if (hasSemantics) {
        const perTable = bundle.columnMeta[table] ?? {};
        perTable[column] = { alias: entry.alias?.trim() || undefined, description: entry.description?.trim() || undefined };
        bundle.columnMeta[table] = perTable;
      }
      continue;
    }

    // kind === 'table'
    if (!entry.enabled) disabledTables.add(table);
    if (hasSemantics) bundle.tableMeta[table] = { alias: entry.alias?.trim() || undefined, description: entry.description?.trim() || undefined };
  }

  bundle.disabledTables = [...disabledTables].sort();
  for (const [table, columns] of disabledColumns) bundle.disabledColumns[table] = [...columns].sort();
  return bundle;
}

export function emptyBundle(opts: BundleOptions = {}): AgentContextBundle {
  return { ...EMPTY_AGENT_CONTEXT_BUNDLE, connectionId: opts.connectionId ?? '', database: opts.database ?? '' };
}

export function isTableDisabled(bundle: AgentContextBundle | undefined, table: string): boolean {
  return Boolean(bundle?.disabledTables.includes(lower(table)));
}

export function isColumnDisabled(bundle: AgentContextBundle | undefined, table: string, column: string): boolean {
  return Boolean(bundle?.disabledColumns[lower(table)]?.includes(lower(column)));
}

/** 表别名优先取用户配置的，其次取数据库原生 comment。 */
export function tableAlias(bundle: AgentContextBundle | undefined, table: string, nativeComment?: string): string | undefined {
  return bundle?.tableMeta[lower(table)]?.alias || nativeComment || undefined;
}

/**
 * 过滤掉用户禁用的表。必须在「上下文 schema」与「inspect_schema 返回值」两个来源合并之后调用，
 * 否则工具返回的完整表清单会把禁用表重新带回来。
 */
export function applyTableVisibility<T extends { name: string }>(tables: T[], bundle?: AgentContextBundle): T[] {
  if (!bundle || !bundle.disabledTables.length) return tables;
  return tables.filter((t) => !isTableDisabled(bundle, t.name));
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 用术语词典把用户话里的简称展开成业务全称。
 * 离线推理器靠字面匹配找表，展开后才能把「JS 的资产数」对上 sys_asset 表。
 */
export function expandTerms(prompt: string, glossary?: Memory[]): string {
  if (!glossary?.length || !prompt) return prompt;
  let out = prompt;
  for (const memory of glossary) {
    const term = memory.title.trim();
    if (term.length < 1) continue;
    const boundary = `(^|[^A-Za-z0-9_\\u4e00-\\u9fff])${escapeRegex(term)}(?![A-Za-z0-9_\\u4e00-\\u9fff])`;
    out = out.replace(new RegExp(boundary, 'gi'), (_match, prefix: string) => `${prefix}${term} ${memory.content.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return out;
}

/** 按业务别名把自然语言映射到表；找不到返回 undefined，交由调用方继续其它策略。 */
export function findTableByAlias(prompt: string, tables: Array<{ name: string }>, bundle?: AgentContextBundle): string | undefined {
  if (!bundle) return undefined;
  const p = lower(prompt);
  let best: { name: string; length: number } | undefined;
  for (const table of tables) {
    const alias = bundle.tableMeta[lower(table.name)]?.alias?.trim();
    if (!alias || alias.length < 2) continue;
    if (p.includes(lower(alias)) && (!best || alias.length > best.length)) best = { name: table.name, length: alias.length };
  }
  return best?.name;
}
