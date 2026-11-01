import type { DatabaseSchema, QueryHistoryItem, TableInfo } from '@aidb/core';
import { engineMeta, suggestionLabel } from '@aidb/core';
import type { QuestionSuggestion } from '@aidb/core';
import { api } from './api';
import { sqlPreview } from './format';
import type { ConnectionConfig } from '@aidb/core';

/**
 * 欢迎页 = 「当前库的家」。
 *
 * 这个文件只做一件事：把「用户此刻在看的这个库」算清楚，并给出首页要用的派生事实。
 * 首页渲染不再各自去猜作用域 —— 它们只读这里的结果，避免同一个页面里
 * 一半按连接过滤、一半按全局过滤（这正是改造前「杂乱」的根因）。
 */

/** 首页的作用域：一个连接 + 一个确切的库（文件型连接的库名就是文件路径）。 */
export interface HomeScope {
  connection: ConnectionConfig;
  /** 关系型多库引擎里选中的库；文件型/无库概念时为空串。 */
  database: string;
  /** 这个库是否真的被内省过（表清单已加载）。 */
  loaded: boolean;
  schemas: DatabaseSchema[];
}

export interface TableFact {
  table: TableInfo;
  database: string;
  rows?: number;
  columns: number;
  /** 没有主键的表（关系型才判断）。 */
  noPk: boolean;
  /** 既无主键也无唯一索引 —— 真正无法安全定位单行。 */
  keyless: boolean;
}

export interface HomeFacts {
  tables: TableFact[];
  tableCount: number;
  viewCount: number;
  rowTotal: number;
  /** 有行数估算的表数量，用来判断总量是否可信。 */
  rowKnown: number;
  noPkCount: number;
  keylessCount: number;
  emptyCount: number;
  /** 被外键引用的表名集合，用于「关系最密的表」排序。 */
  fanIn: Map<string, number>;
  /** 最大的表（按行数估算），可能是用户最关心的。 */
  largest?: TableFact;
}

export function isRelational(connection?: ConnectionConfig): boolean {
  if (!connection) return false;
  const meta = engineMeta(connection.engine);
  return meta.model === 'relational';
}

/**
 * 选中的库：优先用户在首页显式选的那个，其次 Agent 当前瞄准的库，
 * 最后退到连接自带默认库，再退到唯一库。
 */
export function resolveHomeDatabase(
  connection: ConnectionConfig | undefined,
  schemas: DatabaseSchema[] | undefined,
  preferred: string,
): string {
  if (!connection) return '';
  const names = (schemas ?? []).map((schema) => schema.name);
  if (preferred && names.includes(preferred)) return preferred;
  if (connection.database && names.includes(connection.database)) return connection.database;
  if (names.length === 1) return names[0];
  return names[0] ?? '';
}

/**
 * 首页只认「这个库」的 schema。多库引擎下 schemas 里其它库的表不能混进来，
 * 否则「对象 320」这种数字会跨越 20 个库，用户点进去却不是这个库。
 */
export function scopeSchemas(
  connection: ConnectionConfig | undefined,
  schemas: DatabaseSchema[] | undefined,
  database: string,
): DatabaseSchema[] {
  const list = schemas ?? [];
  if (!connection) return [];
  if (!database) return list;
  const hit = list.filter((schema) => schema.name === database);
  return hit.length ? hit : [];
}

export function computeFacts(schemas: DatabaseSchema[], relational: boolean): HomeFacts {
  const tables: TableFact[] = [];
  const fanIn = new Map<string, number>();
  for (const schema of schemas) {
    for (const table of schema.tables) {
      const columns = table.columns?.length ?? 0;
      const pk = Boolean(table.columns?.some((column) => column.primaryKey));
      const unique = Boolean(table.indexes?.some((index) => index.unique || index.primary));
      for (const fk of table.foreignKeys ?? []) {
        fanIn.set(fk.refTable, (fanIn.get(fk.refTable) ?? 0) + 1);
      }
      tables.push({
        table,
        database: schema.name,
        rows: table.rowEstimate,
        columns,
        noPk: relational ? !pk : false,
        keyless: relational ? !pk && !unique : false,
      });
    }
  }
  // 大的在前：首页要回答「这个库里最重的是什么」，而不是按字母序
  tables.sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || a.table.name.localeCompare(b.table.name));
  const rowValues = tables.map((item) => item.rows).filter((rows): rows is number => typeof rows === 'number');
  return {
    tables,
    tableCount: tables.filter((item) => item.table.type !== 'view').length,
    viewCount: tables.filter((item) => item.table.type === 'view').length,
    rowTotal: rowValues.reduce((sum, rows) => sum + rows, 0),
    rowKnown: rowValues.length,
    noPkCount: tables.filter((item) => item.noPk).length,
    keylessCount: tables.filter((item) => item.keyless).length,
    emptyCount: tables.filter((item) => item.rows === 0).length,
    fanIn,
    largest: tables.find((item) => typeof item.rows === 'number' && item.rows > 0),
  };
}

/** 「最近跑过」优先显示成功的、非结构性查询；SQLite 内省那几条没有信息量。 */
const NOISE = /^\s*(select\s+name\s+from\s+(sqlite_master|pg_catalog)|show\s+(tables|databases)|pragma|start\s+transaction|begin|commit|rollback)\b/i;

export function interestingHistory(items: QueryHistoryItem[], limit = 4): QueryHistoryItem[] {
  const clean = items.filter((item) => !NOISE.test(item.sql));
  const pool = clean.length ? clean : items;
  const seen = new Set<string>();
  const out: QueryHistoryItem[] = [];
  for (const item of pool) {
    const key = sqlPreview(item.sql, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export interface HomeSuggestion extends QuestionSuggestion {
  label: string;
}

/**
 * AI 建议走 /agent/suggest：它是真按这个库的表、列名和最近查询算出来的，
 * 比首页原来那 4 条写死的 prompt 强得多。失败就退成空数组，首页不因此报错。
 */
export async function loadSuggestions(connectionId: string, database: string, limit = 4): Promise<HomeSuggestion[]> {
  try {
    const { suggestions } = await api.suggest({ connectionId, database: database || undefined, limit });
    return suggestions.map((item) => ({ ...item, label: suggestionLabel(item.kind) }));
  } catch {
    return [];
  }
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString();
}

/** 引擎在界面上的短名：标题栏已经写了 DEV · SQLITE，这里不重复大写。 */
export function engineLabel(connection?: ConnectionConfig): string {
  if (!connection) return '';
  return engineMeta(connection.engine).label;
}
