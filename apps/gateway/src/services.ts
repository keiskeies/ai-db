import { createReadStream, createWriteStream, existsSync, readFileSync, realpathSync, rmSync, statSync, statfsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  buildCreateIndex,
  buildCreateTable,
  buildInsert,
  dialectOf,
  engineMeta,
  engineUsesSchema,
  isSqlEngine,
  placeholder,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  splitStatements,
  type ColumnDef,
  type ConnectionConfig,
  type DatabaseSchema,
  type DialectId,
  type Engine,
  type IndexDef,
  type QueryBatchResult,
  type QueryResult,
  type TableInfo,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { DbError, type Driver } from './drivers';
import { throwIfAborted } from './drivers/timeout';
import { estimateRowBytes, supportsRowStream, supportsTransaction, type TransactionDriver } from './drivers/types';
import { toCsv, toSqlInserts, type ExportFormat } from './exportFormat';
import type { ConnectionManager } from './manager';
import type { Store } from './store';

// 导出格式化已下沉到叶子模块 exportFormat（services ↔ xlsx 解环）；此处再导出保持既有消费面不变。
export { toCsv, toSqlInserts, sqlLiteral } from './exportFormat';
export type { ExportFormat, ExportInput } from './exportFormat';

/** INSERT 脚本依赖 SQL 方言；非 SQL 引擎只能导出行数据。 */
export function assertExportable(engine: Engine, format: ExportFormat): void {
  if (format === 'sql' && !isSqlEngine(engine)) {
    throw new DbError(`${engineMeta(engine).label} 不支持导出为 INSERT 脚本`, { code: 'UNSUPPORTED_ENGINE', hint: '请改用 CSV / JSON / XML' });
  }
}

/** 非 SQL 引擎没有「整表 SELECT」，导出必须由调用方给出语句。 */
export function exportNeedsStatement(engine: Engine): never {
  throw new DbError(`${engineMeta(engine).label} 导出需要查询语句`, {
    code: 'INVALID_INPUT',
    hint: '请先在查询窗口执行一条语句，再导出结果',
  });
}

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export function resolveInsideDir(dir: string, candidate?: string): string {
  const target = candidate ? resolve(candidate) : dir;
  const rel = relative(resolve(dir), target);
  if (rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new DbError(`路径必须在 ${dir} 内`, { code: 'PATH_NOT_ALLOWED' });
  }
  return target;
}

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function resolveImportFile(config: GatewayConfig, requestedPath: string): string {
  try {
    const root = realpathSync(resolve(config.importDir));
    const path = realpathSync(resolve(requestedPath));
    if (!isInside(root, path)) throw new DbError('导入文件必须位于导入目录内', { code: 'PATH_NOT_ALLOWED' });
    const extension = extname(path).toLowerCase();
    if (extension !== '.csv' && extension !== '.tsv') throw new DbError('导入文件仅支持 .csv 或 .tsv', { code: 'INVALID_INPUT' });
    const info = statSync(path);
    if (!info.isFile()) throw new DbError('导入路径不是普通文件', { code: 'INVALID_INPUT' });
    if (info.size > MAX_IMPORT_BYTES) throw new DbError('导入文件不能超过 64MB', { code: 'FILE_TOO_LARGE' });
    return path;
  } catch (err: any) {
    if (err instanceof DbError) throw err;
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw new DbError('导入文件不存在', { code: 'FILE_NOT_FOUND', status: 404 });
    throw new DbError('无法读取导入文件', { code: 'INVALID_INPUT', status: 400 });
  }
}

export interface ImportOptions {
  csv?: string;
  path?: string;
  table: string;
  hasHeader: boolean;
  delimiter?: string;
  mapping?: Array<{ column: string; sourceIndex?: number }>;
  database?: string;
  executionId?: string;
  signal?: AbortSignal;
}

export function coerceValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  const t = type.toLowerCase();
  if (value === '') return /char|text|json|uuid|blob/.test(t) ? '' : null;
  if (/bool/.test(t)) return /^(1|true|yes|y)$/i.test(value);
  if (/int|serial/.test(t)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (/numeric|decimal|real|double|float/.test(t)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  errors: string[];
  columns: string[];
}

function coerce(value: string, type: string): unknown {
  const t = type.toLowerCase();
  if (value === '') return /char|text|json/.test(t) ? '' : null;
  if (/bool/.test(t)) return /^(1|true|yes|y)$/i.test(value);
  if (/int|serial/.test(t)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (/numeric|decimal|real|double|float/.test(t)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/** CSV 批量导入向量/搜索集合：列名即字段，id/vector 单独指定。 */
export interface DocumentImportOptions {
  collection: string;
  csv?: string;
  path?: string;
  hasHeader?: boolean;
  delimiter?: string;
  idColumn?: string;
  vectorColumn?: string;
  executionId?: string;
  signal?: AbortSignal;
}

function coerceCell(value: string): unknown {
  const text = value.trim();
  if (!text) return null;
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return value;
    }
  }
  return value;
}

function parseVectorCell(value: string): number[] | null {
  const text = value.trim();
  if (!text) return null;
  const candidates = text.startsWith('[') ? [text] : [text, `[${text}]`];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const numbers = parsed.map(Number).filter((n) => Number.isFinite(n));
        if (numbers.length === parsed.length && numbers.length) return numbers;
      }
    } catch {
      /* 继续尝试下一种写法 */
    }
  }
  const split = text.split(/[;\s]+/).map((part) => Number(part)).filter((n) => Number.isFinite(n));
  return split.length ? split : null;
}

export async function importDocuments(
  store: Store,
  manager: ConnectionManager,
  config: GatewayConfig,
  connectionId: string,
  opts: DocumentImportOptions,
): Promise<{ imported: number; skipped: number; errors: string[]; collection: string }> {
  throwIfAborted(opts.signal);
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  if (conn.readonly) throw new DbError('只读连接禁止导入', { code: 'READONLY', status: 403 });
  const content = opts.csv?.trim() || (opts.path ? readFileSync(resolveImportFile(config, opts.path), 'utf8') : '');
  if (!content.trim()) throw new DbError('CSV 内容为空', { code: 'EMPTY_CSV' });
  const delimiter = opts.delimiter === '\\t' ? '\t' : opts.delimiter || ',';
  const parsed = parseCsv(content, delimiter);
  if (!parsed.length) throw new DbError('CSV 没有可导入的行', { code: 'EMPTY_CSV' });
  const headerRow = opts.hasHeader === false ? undefined : parsed[0];
  const dataRows = opts.hasHeader === false ? parsed : parsed.slice(1);
  if (!dataRows.length) throw new DbError('CSV 只有表头，没有数据行', { code: 'EMPTY_CSV' });
  if (dataRows.length > 5000) throw new DbError('单次导入最多 5000 行，请拆分文件', { code: 'TOO_MANY_ROWS' });
  const names = (column: string, index: number) => (headerRow?.[index]?.trim() || `col${index + 1}` || column).trim();

  const idIndex = opts.idColumn
    ? (headerRow ?? []).findIndex((name) => name.trim().toLowerCase() === opts.idColumn!.trim().toLowerCase())
    : -1;
  const vectorIndex = opts.vectorColumn
    ? (headerRow ?? []).findIndex((name) => name.trim().toLowerCase() === opts.vectorColumn!.trim().toLowerCase())
    : -1;
  if (opts.idColumn && idIndex < 0) throw new DbError(`找不到 id 列：${opts.idColumn}`, { code: 'CSV_MAPPING' });
  if (opts.vectorColumn && vectorIndex < 0) throw new DbError(`找不到 vector 列：${opts.vectorColumn}`, { code: 'CSV_MAPPING' });

  const model = engineMeta(conn.engine).model;
  const idKey = engineMeta(conn.engine).languages.includes('aql')
    ? '_key'
    : model === 'search' || model === 'document'
      ? '_id'
      : 'id';
  const documents: Record<string, unknown>[] = [];
  const errors: string[] = [];
  dataRows.forEach((row, offset) => {
    const line = offset + (opts.hasHeader === false ? 1 : 2);
    if (row.every((cell) => !cell.trim())) return;
    const document: Record<string, unknown> = {};
    if (idIndex >= 0) {
      const raw = row[idIndex].trim();
      if (!raw) {
        errors.push(`第 ${line} 行：id 为空`);
        return;
      }
      document[idKey] = raw;
    }
    if (vectorIndex >= 0) {
      const vector = parseVectorCell(row[vectorIndex]);
      if (!vector) {
        errors.push(`第 ${line} 行：vector 不是数组，例如 "[0.1, 0.2]"`);
        return;
      }
      document.vector = vector;
    }
    row.forEach((cell, index) => {
      if (index === idIndex || index === vectorIndex) return;
      document[names('', index)] = coerceCell(cell);
    });
    documents.push(document);
  });
  if (!documents.length) {
    throw new DbError(errors[0] ?? 'CSV 中没有可导入的数据行', { code: 'EMPTY_CSV', hint: '检查 id 列与 vector 列是否指向真实表头' });
  }

  let imported = 0;
  const batchSize = 200;
  for (let start = 0; start < documents.length; start += batchSize) {
    throwIfAborted(opts.signal);
    const chunk = documents.slice(start, start + batchSize);
    try {
      const result = await manager.writeDocuments(connectionId, { collection: opts.collection, documents: chunk }, {
        database: conn.database,
        actor: 'user',
        executionId: opts.executionId,
        signal: opts.signal,
      });
      throwIfAborted(opts.signal);
      imported += result.upserted;
    } catch (err: any) {
      if (err?.code === 'ABORTED') throw err;
      errors.push(`第 ${start + 1}-${start + chunk.length} 行：${err?.message ?? '写入失败'}`);
    }
  }
  return { imported, skipped: documents.length - imported, errors: errors.slice(0, 20), collection: opts.collection };
}

export async function importCsv(
  store: Store,
  manager: ConnectionManager,
  config: GatewayConfig,
  connectionId: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  throwIfAborted(opts.signal);
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  if (conn.readonly) throw new DbError('只读连接禁止导入', { code: 'READONLY', status: 403 });
  const { table } = await manager.findTable(connectionId, opts.database ?? conn.database, opts.table);
  const content = opts.csv ?? (opts.path ? readFileSync(resolveImportFile(config, opts.path), 'utf8') : '');
  if (!content.trim()) throw new DbError('CSV 内容为空', { code: 'EMPTY_CSV' });
  const delimiter = opts.delimiter === '\\t' ? '\t' : opts.delimiter || ',';
  const parsed = parseCsv(content, delimiter);
  if (!parsed.length) throw new DbError('CSV 没有可导入的行', { code: 'EMPTY_CSV' });
  const headerRow = opts.hasHeader ? parsed[0] : undefined;
  const dataRows = opts.hasHeader ? parsed.slice(1) : parsed;
  if (!dataRows.length) throw new DbError('CSV 只有表头，没有数据行', { code: 'EMPTY_CSV' });
  if (dataRows.length > 5000) throw new DbError('单次导入最多 5000 行，请拆分文件', { code: 'TOO_MANY_ROWS' });

  const tableColumns = table.columns ?? [];
  let columns: string[];
  let indexes: number[];
  if (opts.mapping?.length) {
    columns = opts.mapping.map((m) => m.column);
    indexes = opts.mapping.map((m) => m.sourceIndex ?? (headerRow ? headerRow.findIndex((h) => h.trim().toLowerCase() === m.column.toLowerCase()) : columns.indexOf(m.column)));
  } else if (headerRow) {
    const pairs: Array<[string, number]> = [];
    headerRow.forEach((h, i) => {
      const match = tableColumns.find((c) => c.name.toLowerCase() === h.trim().toLowerCase());
      if (match) pairs.push([match.name, i]);
    });
    columns = pairs.map((p) => p[0]);
    indexes = pairs.map((p) => p[1]);
  } else {
    columns = tableColumns.filter((c) => !c.autoIncrement).slice(0, dataRows[0].length).map((c) => c.name);
    indexes = columns.map((_, i) => i);
  }
  if (!columns.length) throw new DbError('没有匹配到任何目标列，请提供 mapping', { code: 'NO_COLUMNS' });
  if (new Set(columns).size !== columns.length) throw new DbError('列映射存在重复目标列', { code: 'DUPLICATE_COLUMN' });
  for (const col of columns) {
    if (!tableColumns.some((c) => c.name === col)) throw new DbError(`目标列不存在：${col}`, { code: 'UNKNOWN_COLUMN' });
  }
  if (indexes.some((i) => i < 0)) throw new DbError('无法确定列映射，请显式提供 sourceIndex', { code: 'BAD_MAPPING' });

  const typeByColumn = new Map(tableColumns.map((c) => [c.name, c.type]));
  const params: unknown[] = [];
  const errors: string[] = [];
  for (const [rowIndex, row] of dataRows.entries()) {
    throwIfAborted(opts.signal);
    for (const [colIdx, column] of columns.entries()) {
      const raw = row[indexes[colIdx]] ?? '';
      params.push(coerce(raw, typeByColumn.get(column) ?? 'text'));
    }
    if (row.length < Math.max(...indexes) + 1) errors.push(`第 ${rowIndex + 1} 行列数不足`);
  }
  if (errors.length) return { inserted: 0, skipped: dataRows.length, errors, columns };

  const sql = buildInsert(conn.engine, table.name, columns, dataRows.length, engineUsesSchema(conn.engine) ? table.schema : undefined);
  throwIfAborted(opts.signal);
  try {
    const result = await manager.runParams(connectionId, sql, params, {
      database: opts.database ?? conn.database,
      actor: 'user',
      executionId: opts.executionId,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { inserted: result.affected ?? dataRows.length, skipped: 0, errors: [], columns };
  } catch (err: any) {
    if (err?.code === 'ABORTED') throw err;
    throw new DbError(`导入失败，已回滚：${err.message}`, { code: 'IMPORT_FAILED', hint: '检查列类型与 CSV 内容是否匹配' });
  }
}

type RestoreIdentifierPart = { value: string; sql: string; quoted: boolean };
type RestoreObjectName = { schema?: RestoreIdentifierPart; name: RestoreIdentifierPart };

/** 解析一个或两个标识符；引号内允许转义引号/方括号，点号留在标识符内部。 */
function parseRestoreObjectName(input: string, dialect: DialectId): RestoreObjectName | undefined {
  const parts: RestoreIdentifierPart[] = [];
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/.test(input[offset] ?? '')) offset++;
  };
  while (parts.length < 2) {
    skipWhitespace();
    const start = offset;
    const quote = input[offset];
    const quoted = quote === '"' || (quote === '`' && ['mysql', 'clickhouse', 'sqlite'].includes(dialect)) || (quote === '[' && ['mssql', 'sqlite'].includes(dialect));
    let value = '';
    if (quoted) {
      const closingQuote = quote === '[' ? ']' : quote;
      offset++;
      let closed = false;
      while (offset < input.length) {
        if (input[offset] === closingQuote) {
          if (input[offset + 1] === closingQuote) {
            value += closingQuote;
            offset += 2;
            continue;
          }
          offset++;
          closed = true;
          break;
        }
        value += input[offset++];
      }
      if (!closed) return undefined;
    } else {
      const bare = input.slice(offset).match(/^[A-Za-z_][\w$#]*/);
      if (!bare) return undefined;
      value = bare[0];
      offset += value.length;
    }
    if (!value) return undefined;
    parts.push({ value, sql: input.slice(start, offset), quoted });
    skipWhitespace();
    if (input[offset] !== '.') break;
    offset++;
    // 备份只生成 schema.table；三段引用不能截成前两段后生成危险的 DROP。
    if (parts.length === 2) return undefined;
  }
  if (parts.length === 1) return { name: parts[0] };
  return { schema: parts[0], name: parts[1] };
}

/**
 * 恢复对象身份不能全局 lower：
 * - PostgreSQL 仅裸标识符折叠为小写，引号标识符保持精确大小写；
 * - SQL Server 由目标库 collation 决定（CS/BIN 精确，CI 折叠）；
 * - Oracle/DM 裸标识符折叠为大写，引号标识符精确；
 * - MySQL/SQLite 维持既有的不区分大小写匹配。
 */
function restoreIdentifierKey(part: RestoreIdentifierPart, dialect: DialectId, sqlServerCaseSensitive: boolean): string {
  if (dialect === 'postgres') return part.quoted ? part.value : part.value.toLowerCase();
  if (dialect === 'mssql') return sqlServerCaseSensitive ? part.value : part.value.toLowerCase();
  if (dialect === 'oracle' || dialect === 'dm') return part.quoted ? part.value : part.value.toUpperCase();
  if (dialect === 'clickhouse') return part.value;
  return part.value.toLowerCase();
}

function restoreObjectKey(object: RestoreObjectName, dialect: DialectId, sqlServerCaseSensitive: boolean): string {
  return JSON.stringify([
    object.schema ? restoreIdentifierKey(object.schema, dialect, sqlServerCaseSensitive) : null,
    restoreIdentifierKey(object.name, dialect, sqlServerCaseSensitive),
  ]);
}

/** catalog 返回的是数据库中的规范名；PostgreSQL/CS SQL Server 下必须按原样精确匹配。 */
function restoreTargetObjectKey(schema: string | undefined, name: string, dialect: DialectId, sqlServerCaseSensitive: boolean): string {
  return restoreObjectKey({
    schema: schema === undefined ? undefined : { value: schema, sql: schema, quoted: true },
    name: { value: name, sql: name, quoted: true },
  }, dialect, sqlServerCaseSensitive);
}

/** 按完整 SQL 语句解析 CREATE TABLE/VIEW，避免把 INSERT 字符串或注释里的同名文本当成对象。 */
function restoreObjectNames(engine: Engine, dump: string, sqlServerCaseSensitive = true): { views: RestoreObjectName[]; tables: RestoreObjectName[] } {
  const dialect = dialectOf(engine);
  const views = new Map<string, RestoreObjectName>();
  const tables = new Map<string, RestoreObjectName>();
  for (const statement of splitStatements(dump, engine)) {
    const code = statement.replace(/^(?:\s|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
    const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(code);
    if (!match) continue;
    const object = parseRestoreObjectName(code.slice(match[0].length), dialect);
    if (!object) continue;
    const key = restoreObjectKey(object, dialect, sqlServerCaseSensitive);
    (match[1].toUpperCase() === 'VIEW' ? views : tables).set(key, object);
  }
  return { views: [...views.values()], tables: [...tables.values()] };
}

export function restoreDropStatements(engine: Engine, dump: string, sqlServerCaseSensitive = true): string[] {
  const dialect = dialectOf(engine);
  if (!['sqlite', 'mysql', 'postgres', 'mssql', 'oracle', 'dm', 'clickhouse'].includes(dialect)) return [];
  const { views, tables } = restoreObjectNames(engine, dump, sqlServerCaseSensitive);
  const sqlName = (object: RestoreObjectName) => [object.schema?.sql, object.name.sql].filter(Boolean).join('.');
  const supportsIfExists = dialect === 'mysql' || dialect === 'postgres' || dialect === 'mssql' || dialect === 'sqlite' || dialect === 'clickhouse';
  const cascade = dialect === 'postgres' ? ' CASCADE' : dialect === 'oracle' || dialect === 'dm' ? ' CASCADE CONSTRAINTS' : '';
  const drops = [
    ...[...views].map((name) => `DROP VIEW ${supportsIfExists ? 'IF EXISTS ' : ''}${sqlName(name)}${cascade};`),
    ...[...tables].map((name) => `DROP TABLE ${supportsIfExists ? 'IF EXISTS ' : ''}${sqlName(name)}${cascade};`),
  ];
  if (!drops.length) return [];
  if (dialect === 'mysql') return ['SET FOREIGN_KEY_CHECKS=0;', ...drops, 'SET FOREIGN_KEY_CHECKS=1;'];
  if (dialect === 'sqlite') return ['PRAGMA foreign_keys=OFF;', ...drops, 'PRAGMA foreign_keys=ON;'];
  return drops;
}

const DUMP_CHUNK_ROWS = 2000;
/**
 * 单条 INSERT 批的字节预算。只按行数切批时，单行数 MB 的大字段表一批就能拼出 GB 级巨串
 * （行数据 + 转义副本 + join 结果同时在堆），备份因此 OOM。行数上限保留为辅助闸。
 */
const DUMP_BATCH_BYTES = 4 * 1024 * 1024;
// 支持 LIMIT/OFFSET 或 FETCH 分页的方言；influxdb 无分页语法，保持整表读。duckdb 复用 sqlite dialect。
const OFFSET_DIALECTS = new Set<DialectId>(['sqlite', 'mysql', 'postgres', 'mssql', 'clickhouse', 'tdengine']);
const KEYSET_DIALECTS = new Set<DialectId>(['sqlite', 'mysql', 'postgres', 'mssql', 'clickhouse', 'oracle', 'dm']);

type DumpPlan = { mode: 'single' } | { mode: 'offset'; order: string[] } | { mode: 'keyset'; column: string };

/**
 * 备份读取计划：单列主键走 keyset（不会像 OFFSET 那样越往后越慢），复合主键走 OFFSET。
 * 没有唯一键时宁可一次性读完：靠非唯一列排序分页会漏行或重复行。
 */
export function dumpReadPlan(engine: Engine, table: TableInfo): DumpPlan {
  const dialect = dialectOf(engine);
  if (!OFFSET_DIALECTS.has(dialect)) return { mode: 'single' };
  const pk = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
  if (pk.length === 1 && KEYSET_DIALECTS.has(dialect)) return { mode: 'keyset', column: pk[0] };
  if (pk.length) return { mode: 'offset', order: pk };
  return { mode: 'single' };
}

export function dumpPageSql(engine: Engine, base: string, order: string[], limit: number, offset: number): string {
  const orderBy = ` ORDER BY ${order.map((name) => quoteIdent(name, engine)).join(', ')}`;
  if (dialectOf(engine) === 'mssql') return `${base}${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  return `${base}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
}

export function dumpKeysetSql(engine: Engine, base: string, column: string, limit: number, cursor: unknown): string {
  const quoted = quoteIdent(column, engine);
  const where = cursor === undefined ? '' : ` WHERE ${quoted} > ${placeholder(engine, 1)}`;
  const orderBy = ` ORDER BY ${quoted}`;
  if (dialectOf(engine) === 'mssql') return `${base}${where}${orderBy} OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`;
  // oracle/dm 的 keyset 用 FETCH FIRST：无裸 LIMIT 语法。
  if (dialectOf(engine) === 'oracle' || dialectOf(engine) === 'dm') return `${base}${where}${orderBy} FETCH FIRST ${limit} ROWS ONLY`;
  return `${base}${where}${orderBy} LIMIT ${limit}`;
}

export async function writeTableRows(
  write: (text: string) => Promise<void>,
  driver: Driver,
  engine: Engine,
  table: TableInfo,
  base: string,
  database: string | undefined,
  signal?: AbortSignal,
  read?: (sql: string, params: unknown[], database: string | undefined) => Promise<QueryResult>,
): Promise<number> {
  throwIfAborted(signal);
  const run = read ?? ((sql: string, params: unknown[], db: string | undefined) => driver.run(sql, { database: db, signal }));
  const runParams = read ?? ((sql: string, params: unknown[], db: string | undefined) => driver.runParams(sql, params, { database: db, signal }));
  const schema = engineUsesSchema(engine) ? table.schema : undefined;
  let names: string[] | undefined;
  let rowCount = 0;
  const emitRows = async (columns: Array<{ name: string }>, rows: unknown[][]) => {
    if (!names) names = columns.map((column) => column.name);
    let start = 0;
    let bytes = 0;
    for (let i = 0; i < rows.length; i += 1) {
      throwIfAborted(signal);
      bytes += estimateRowBytes(rows[i]);
      if (bytes >= DUMP_BATCH_BYTES || i - start + 1 >= DUMP_CHUNK_ROWS) {
        await write(toSqlInserts(engine, table.name, names, rows.slice(start, i + 1), schema));
        rowCount += i - start + 1;
        start = i + 1;
        bytes = 0;
      }
    }
    if (start < rows.length) {
      await write(toSqlInserts(engine, table.name, names, rows.slice(start), schema));
      rowCount += rows.length - start;
    }
  };
  // 流式驱动一条 SELECT 读完整表：单语句快照天然一致，不会像分页那样漏行/重行，
  // 无主键表也不再整表缓冲。批由驱动按字节产出，这里再按同一预算切 INSERT。
  if (supportsRowStream(driver) && !read) {
    for await (const batch of driver.iterateRows(base, [], { database, signal })) {
      throwIfAborted(signal);
      await emitRows(batch.columns, batch.rows);
    }
    return rowCount;
  }
  const plan = dumpReadPlan(engine, table);
  if (plan.mode === 'single') {
    const result = await run(base, [], database);
    throwIfAborted(signal);
    await emitRows(result.columns, result.rows);
    return rowCount;
  }
  if (plan.mode === 'offset') {
    for (let offset = 0; ; offset += DUMP_CHUNK_ROWS) {
      throwIfAborted(signal);
      const result = await run(dumpPageSql(engine, base, plan.order, DUMP_CHUNK_ROWS, offset), [], database);
      throwIfAborted(signal);
      await emitRows(result.columns, result.rows);
      if (result.rows.length < DUMP_CHUNK_ROWS) return rowCount;
    }
  }
  let cursor: unknown;
  for (;;) {
    throwIfAborted(signal);
    const sql = dumpKeysetSql(engine, base, plan.column, DUMP_CHUNK_ROWS, cursor);
    const result = cursor === undefined
      ? await run(sql, [], database)
      : await runParams(sql, [cursor], database);
    throwIfAborted(signal);
    await emitRows(result.columns, result.rows);
    if (result.rows.length < DUMP_CHUNK_ROWS) return rowCount;
    const index = result.columns.findIndex((column) => column.name.toLowerCase() === plan.column.toLowerCase());
    const last = result.rows[result.rows.length - 1];
    if (index < 0 || !last || last[index] === null || last[index] === undefined) throw new DbError('无法可靠继续备份分页', { code: 'BACKUP_TRUNCATED' });
    cursor = last[index];
  }
}

/** 备份落盘的默认值白名单：无参内置函数或数字/字符串字面量，其余（含 :: 强转等）无法证明可安全重放，丢弃。 */
const SAFE_DEFAULT_FN = new Set(['nextval', 'now', 'current_timestamp', 'current_date', 'current_time', 'current_user', 'getdate', 'getutcdate', 'sysdate', 'uuid', 'uuid_generate_v4', 'gen_random_uuid', 'random', 'strftime']);
export function safeDefaultToDump(value: string): string | undefined {
  const s = value.trim();
  const numeric = /^\d+(\.\d+)?$/.test(s);
  const quoted = /^'[^']*'$/.test(s);
  if (numeric || quoted) return s;
  const m = s.match(/^(\w+)\(\)$/);
  if (m && SAFE_DEFAULT_FN.has(m[1].toLowerCase())) return s;
  return undefined;
}

const MIN_BACKUP_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024 * 1024;
const BACKUP_RETENTION_COUNT = 20;
const BACKUP_RETENTION_DAYS = 30;

export function backupCapacityByteLimit(availableBytes: number): number {
  if (availableBytes < MIN_BACKUP_FREE_BYTES) throw new DbError('备份目录可用空间不足 1GB', { code: 'BACKUP_CAPACITY' });
  return Math.min(MAX_BACKUP_BYTES, availableBytes - MIN_BACKUP_FREE_BYTES);
}

async function viewDefinition(txDriver: TransactionDriver, txId: string, conn: ConnectionConfig, table: TableInfo, database: string | undefined, signal?: AbortSignal, executionId?: string): Promise<string> {
  const ref = quoteQualified([engineUsesSchema(conn.engine) ? table.schema : undefined, table.name], conn.engine);
  const dialect = dialectOf(conn.engine);
  let sql: string;
  let column = 1;
  if (dialect === 'sqlite') {
    sql = `SELECT sql FROM sqlite_master WHERE type='view' AND name=${quoteLiteral(table.name)}`;
    column = 0;
  } else if (dialect === 'mysql') {
    sql = `SHOW CREATE VIEW ${ref}`;
  } else if (dialect === 'postgres') {
    sql = `SELECT pg_get_viewdef(${quoteLiteral(ref)}::regclass, true)`;
    column = 0;
  } else if (dialect === 'mssql') {
    sql = `SELECT definition FROM sys.sql_modules WHERE object_id=OBJECT_ID(${quoteLiteral(ref)})`;
    column = 0;
  } else if (dialect === 'oracle' || dialect === 'dm') {
    sql = `SELECT TEXT FROM USER_VIEWS WHERE VIEW_NAME=${quoteLiteral(table.name.toUpperCase())}`;
    column = 0;
  } else if (dialect === 'clickhouse') {
    sql = `SHOW CREATE VIEW ${ref}`;
  } else {
    throw new DbError(`${engineMeta(conn.engine).label} 暂不支持备份视图定义`, { code: 'NATIVE_BACKUP_REQUIRED' });
  }
  const result = await txDriver.runInTransaction(txId, sql, [], { database, maxRows: 1, timeoutMs: 120_000, signal, executionId });
  const definition = String(result.rows[0]?.[column] ?? '').trim();
  if (!definition) throw new DbError(`无法读取视图定义：${table.name}`, { code: 'NATIVE_BACKUP_REQUIRED' });
  return /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(definition) ? definition : `CREATE VIEW ${ref} AS ${definition}`;
}

function consistentBackupUnsupported(message: string, cause?: unknown): DbError {
  return Object.assign(new DbError(message, { code: 'CONSISTENT_BACKUP_UNSUPPORTED' }), cause === undefined ? {} : { cause });
}

/** SQLite 的所有 describe/query 都固定在同一子进程连接上，可在事务内直接读取 schema。 */
async function sqliteSchemaInTransaction(
  txDriver: TransactionDriver,
  txId: string,
  database: string | undefined,
  signal?: AbortSignal,
  executionId?: string,
): Promise<TableInfo[]> {
  const run = async (sql: string): Promise<QueryResult> => {
    const result = await txDriver.runInTransaction(txId, sql, [], { database, timeoutMs: 30_000, signal, executionId });
    if (result.truncated) throw consistentBackupUnsupported('SQLite 结构元数据不完整，无法证明一致性备份');
    return result;
  };
  const objects = await run("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const tables: TableInfo[] = [];
  for (const object of objects.rows) {
    const name = String(object[0]);
    const quoted = quoteIdent(name, 'sqlite');
    const columnRows = (await run(`PRAGMA table_info(${quoted})`)).rows;
    const columns = columnRows.map((row) => ({
      name: String(row[1]),
      type: String(row[2] || 'TEXT'),
      nullable: Number(row[3]) === 0,
      defaultValue: row[4] === null ? null : String(row[4]),
      primaryKey: Number(row[5]) > 0,
      autoIncrement: false,
    }));
    if (/AUTOINCREMENT/i.test(String(object[2] ?? ''))) {
      const primary = columns.find((column) => column.primaryKey);
      if (primary) primary.autoIncrement = true;
    }
    const indexes: NonNullable<TableInfo['indexes']> = [];
    const foreignKeys: NonNullable<TableInfo['foreignKeys']> = [];
    if (object[1] === 'table') {
      for (const row of (await run(`PRAGMA index_list(${quoted})`)).rows) {
        const indexName = String(row[1]);
        if (indexName.startsWith('sqlite_autoindex_')) continue;
        const indexColumns = (await run(`PRAGMA index_info(${quoteIdent(indexName, 'sqlite')})`)).rows;
        indexes.push({
          name: indexName,
          columns: indexColumns.map((column) => String(column[2])),
          unique: Number(row[2]) === 1,
          primary: String(row[3]) === 'pk',
        });
      }
      const foreignKeyMap = new Map<number, NonNullable<TableInfo['foreignKeys']>[number]>();
      for (const row of (await run(`PRAGMA foreign_key_list(${quoted})`)).rows) {
        const id = Number(row[0]);
        const foreignKey = foreignKeyMap.get(id) ?? {
          name: `fk_${name}_${id}`,
          columns: [],
          refTable: String(row[2]),
          refColumns: [],
          onDelete: String(row[6] ?? ''),
          onUpdate: String(row[5] ?? ''),
        };
        foreignKey.columns.push(String(row[3]));
        foreignKey.refColumns.push(String(row[4]));
        foreignKeyMap.set(id, foreignKey);
      }
      foreignKeys.push(...foreignKeyMap.values());
    }
    tables.push({
      name,
      type: object[1] === 'view' ? 'view' : 'table',
      schema: 'main',
      columns,
      indexes,
      foreignKeys,
    });
  }
  return tables;
}

function groupTransactionSchemas(conn: ConnectionConfig, database: string | undefined, tables: TableInfo[]): DatabaseSchema[] {
  const dbKey = database ?? conn.database ?? (conn.engine === 'sqlite' ? 'main' : '');
  if (!engineUsesSchema(conn.engine)) return [{ name: dbKey || 'main', tables }];
  const groups = new Map<string, TableInfo[]>();
  const fallback = conn.engine === 'sqlserver'
    ? 'dbo'
    : conn.engine === 'oracle'
      ? (conn.username ?? '').toUpperCase()
      : conn.engine === 'dm'
        ? (conn.username ?? 'SYSDBA').toUpperCase()
        : dbKey || 'public';
  for (const table of tables) {
    const key = table.schema ?? fallback;
    groups.set(key, [...(groups.get(key) ?? []), table]);
  }
  if (!groups.size) groups.set(dbKey || fallback || 'public', []);
  return [...groups.entries()].map(([name, list]) => ({ name, tables: list }));
}

async function schemaInTransaction(
  txDriver: TransactionDriver,
  engine: Engine,
  conn: ConnectionConfig,
  txId: string,
  database: string | undefined,
  signal?: AbortSignal,
  executionId?: string,
): Promise<DatabaseSchema[]> {
  throwIfAborted(signal);
  try {
    let tables: TableInfo[];
    if (typeof txDriver.describeInTransaction === 'function') {
      tables = await txDriver.describeInTransaction(txId, database, { timeoutMs: 30_000, signal, executionId });
    } else if (engine === 'sqlite') {
      tables = await sqliteSchemaInTransaction(txDriver, txId, database, signal, executionId);
    } else {
      throw consistentBackupUnsupported(`${engineMeta(engine).label} 驱动不支持事务内结构读取，无法保证备份快照一致`);
    }
    throwIfAborted(signal);
    return groupTransactionSchemas(conn, database, tables);
  } catch (err: any) {
    if (err?.code === 'ABORTED' || err?.code === 'CONSISTENT_BACKUP_UNSUPPORTED') throw err;
    throw consistentBackupUnsupported(`${engineMeta(engine).label} 无法在备份事务内读取一致的结构元数据`, err);
  }
}

function backupTransactionSetting(dialect: DialectId): string | undefined {
  if (dialect === 'postgres') return 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
  if (dialect === 'mssql') return 'SET TRANSACTION ISOLATION LEVEL SNAPSHOT';
  if (dialect === 'oracle' || dialect === 'dm') return 'SET TRANSACTION READ ONLY';
  return undefined;
}

async function applyBackupTransactionSetting(
  txDriver: TransactionDriver,
  txId: string,
  engine: Engine,
  database: string | undefined,
  signal?: AbortSignal,
  executionId?: string,
): Promise<void> {
  const sql = backupTransactionSetting(dialectOf(engine));
  if (!sql) return;
  throwIfAborted(signal);
  try {
    await txDriver.runInTransaction(txId, sql, [], { database, timeoutMs: 30_000, signal, executionId });
  } catch (err: any) {
    if (err?.code === 'ABORTED') throw err;
    throw consistentBackupUnsupported(`${engineMeta(engine).label} 无法在事务读取前设置一致快照，已拒绝备份`, err);
  }
}

export async function dumpDatabase(
  store: Store,
  manager: ConnectionManager,
  config: GatewayConfig,
  connectionId: string,
  database?: string,
  label?: string,
  signal?: AbortSignal,
  executionId?: string,
): Promise<{ id: string; createdAt: string; path: string; bytes: number; tables: number; rows: number }> {
  throwIfAborted(signal);
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const free = statfsSync(config.backupDir);
  const backupByteLimit = backupCapacityByteLimit(free.bavail * free.bsize);
  const driver = await manager.rawDriver(connectionId);
  const txDriver = supportsTransaction(driver) ? driver : undefined;
  if (!txDriver) throw new DbError(`${engineMeta(conn.engine).label} 无法提供一致性快照，请使用原生备份工具`, { code: 'CONSISTENT_BACKUP_UNSUPPORTED' });
  if (conn.engine !== 'sqlite' && typeof txDriver.describeInTransaction !== 'function') {
    throw consistentBackupUnsupported(`${engineMeta(conn.engine).label} 驱动不支持事务内结构读取，无法保证备份快照一致`);
  }
  const txId = `backup-${randomUUID()}`;
  const dialect = dialectOf(conn.engine);
  const targetDatabase = database ?? conn.database;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = (targetDatabase ?? conn.name).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const path = join(config.backupDir, `${conn.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}-${safeName}-${stamp}-${randomUUID().slice(0, 8)}.sql`);
  let transactionOpen = false;
  let stream: ReturnType<typeof createWriteStream> | undefined;
  let tableCount = 0;
  let rowCount = 0;
  let completed = false;
  try {
    throwIfAborted(signal);
    await txDriver.beginTransaction(txId, targetDatabase);
    transactionOpen = true;
    // 必须早于任何事务内读取；PostgreSQL/Oracle/DM 的晚 SET 会直接失败，SQL Server 的元数据也会脱离快照。
    await applyBackupTransactionSetting(txDriver, txId, conn.engine, targetDatabase, signal, executionId);
    if (dialect === 'mysql') {
      const isolation = await txDriver.runInTransaction(txId, 'SELECT @@transaction_isolation', [], { database: targetDatabase, timeoutMs: 30_000, signal, executionId });
      if (!String(isolation.rows[0]?.[0] ?? '').toUpperCase().includes('REPEATABLE-READ')) throw new DbError('MySQL 未启用 REPEATABLE READ，无法创建一致性备份', { code: 'CONSISTENT_BACKUP_UNSUPPORTED' });
      if (!targetDatabase) throw new DbError('MySQL 一致性备份必须指定数据库', { code: 'CONSISTENT_BACKUP_UNSUPPORTED' });
    }
    const schemas = await schemaInTransaction(txDriver, conn.engine, conn, txId, targetDatabase, signal, executionId);
    if (dialect === 'mysql' && schemas.some((schema) => schema.tables.some((table) => table.type === 'view'))) {
      throw new DbError('MySQL 含视图的数据库请使用 mysqldump 原生备份，AiDB 备份仅覆盖可原子恢复的表', { code: 'NATIVE_BACKUP_REQUIRED' });
    }
    if (dialect === 'mysql') {
      const engines = await txDriver.runInTransaction(
        txId,
        `SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=${quoteLiteral(targetDatabase!)} AND TABLE_TYPE='BASE TABLE'`,
        [],
        { database: targetDatabase, timeoutMs: 30_000, signal, executionId },
      );
      if (engines.truncated) throw new DbError('MySQL 表引擎元数据不完整，无法证明一致性备份', { code: 'CONSISTENT_BACKUP_UNSUPPORTED' });
      const transactionalEngines = new Set(['innodb', 'ndb']);
      const expectedTables = new Set(schemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table').map((table) => table.name.toLowerCase()));
      const checkedTables = new Set<string>();
      for (const row of engines.rows) {
        const tableName = String(row[0] ?? '');
        const tableEngine = String(row[1] ?? '').toLowerCase();
        if (!tableName || !transactionalEngines.has(tableEngine)) {
          throw new DbError(`MySQL 表 ${tableName || '(未知)'} 使用非事务引擎 ${tableEngine || '(未知)'}，无法创建一致性备份；请先转换为 InnoDB/NDB 或使用原生备份工具`, { code: 'CONSISTENT_BACKUP_UNSUPPORTED' });
        }
        checkedTables.add(tableName.toLowerCase());
      }
      if (checkedTables.size !== expectedTables.size || [...expectedTables].some((name) => !checkedTables.has(name))) {
        throw new DbError('MySQL 表引擎元数据与表清单不一致，无法证明一致性备份', { code: 'CONSISTENT_BACKUP_UNSUPPORTED' });
      }
    }
    const unsupportedObjects = dialect === 'sqlite'
      ? "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND upper(sql) LIKE 'CREATE VIRTUAL TABLE%'"
      : dialect === 'mysql'
        ? "SELECT (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()) + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()) AS count"
        : dialect === 'postgres'
          ? "SELECT (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema')) + (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p') AND n.nspname NOT IN ('pg_catalog','information_schema')) + (SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')) AS count"
          : dialect === 'mssql'
            ? "SELECT (SELECT COUNT(*) FROM sys.triggers) + (SELECT COUNT(*) FROM sys.sql_modules WHERE type IN ('P','FN','IF','TF')) + (SELECT COUNT(*) FROM sys.sequences) + (SELECT COUNT(*) FROM sys.synonyms) AS count"
            : dialect === 'oracle' || dialect === 'dm'
              ? 'SELECT (SELECT COUNT(*) FROM USER_SEQUENCES) + (SELECT COUNT(*) FROM USER_TRIGGERS) + (SELECT COUNT(*) FROM USER_PROCEDURES) + (SELECT COUNT(*) FROM USER_MVIEWS) AS count FROM DUAL'
              : undefined;
    if (unsupportedObjects) {
      const objects = await txDriver.runInTransaction(txId, unsupportedObjects, [], {
        database: targetDatabase,
        timeoutMs: 30_000,
        signal,
        executionId,
      });
      if (objects.truncated || Number(objects.rows[0]?.[0] ?? 0) > 0) {
        throw new DbError(`${engineMeta(conn.engine).label} 含 AiDB 尚不能完整重放的序列、例程或触发器，请使用原生备份工具`, { code: 'NATIVE_BACKUP_REQUIRED' });
      }
    }
    stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    const output = stream;
    let streamError: Error | undefined;
    output.on('error', (err) => { streamError = err; });
    let bytesWritten = 0;
    const write = async (text: string) => {
      throwIfAborted(signal);
      if (streamError) throw streamError;
      bytesWritten += Buffer.byteLength(text) + 1;
      if (bytesWritten > backupByteLimit) throw new DbError('备份超过目录可用空间或 20GB 上限，请使用数据库原生备份工具', { code: 'BACKUP_CAPACITY' });
      await new Promise<void>((resolveWrite, rejectWrite) => {
        output.write(`${text}\n`, (err) => (err ? rejectWrite(err) : resolveWrite()));
      });
      throwIfAborted(signal);
    };
    await write(`-- AiDB Studio backup`);
    await write(`-- connection: ${conn.name} (${conn.engine})`);
    await write(`-- database: ${targetDatabase ?? ''}`);
    await write(`-- consistency: transaction snapshot`);
    await write(`-- created: ${new Date().toISOString()}`);
    await write('');
    if (dialect === 'mysql') await write('SET FOREIGN_KEY_CHECKS=0;');
    for (const schema of schemas) {
      for (const table of schema.tables) {
        throwIfAborted(signal);
        if (table.type !== 'table') continue;
        const columns = table.columns ?? [];
        if (!columns.length) throw new DbError(`无法读取表结构：${table.name}`, { code: 'NATIVE_BACKUP_REQUIRED' });
        tableCount++;
        const columnDefs: ColumnDef[] = columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          defaultValue: c.defaultValue !== undefined && c.defaultValue !== null ? safeDefaultToDump(String(c.defaultValue)) : undefined,
          primaryKey: c.primaryKey,
          autoIncrement: c.autoIncrement,
        }));
        const indexes: IndexDef[] = (table.indexes ?? []).filter((i) => !i.primary).map((i) => ({ name: i.name, columns: i.columns, unique: i.unique }));
        await write(`-- table ${table.name}`);
        await write(buildCreateTable(conn.engine, {
          table: table.name,
          columns: columnDefs,
          indexes: [],
          foreignKeys: table.foreignKeys,
          schema: engineUsesSchema(conn.engine) && dialect !== 'mysql' ? table.schema : undefined,
          comment: table.comment,
        }) + ';');
        for (const idx of indexes) await write(buildCreateIndex(conn.engine, table.name, idx, engineUsesSchema(conn.engine) && dialect !== 'mysql' ? table.schema : undefined) + ';');
        const target = quoteQualified([engineUsesSchema(conn.engine) ? table.schema : undefined, table.name], conn.engine);
        rowCount += await writeTableRows(
          write,
          driver,
          conn.engine,
          table,
          `SELECT * FROM ${target}`,
          targetDatabase,
          signal,
          async (sql, params, db) => {
            const result = await txDriver.runInTransaction(txId, sql, params, { database: db, timeoutMs: 120_000, signal, executionId });
            if (result.truncated) throw new DbError(`备份读取被截断：${table.name}`, { code: 'BACKUP_TRUNCATED' });
            return result;
          },
        );
        await write('');
      }
    }
    for (const schema of schemas) {
      for (const view of schema.tables.filter((table) => table.type === 'view')) {
        const definition = await viewDefinition(txDriver, txId, conn, view, targetDatabase, signal, executionId);
        await write(`${definition.replace(/;\s*$/, '')};`);
      }
    }
    if (conn.engine === 'sqlite') {
      const triggers = await txDriver.runInTransaction(txId, "SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL", [], { database: targetDatabase, maxRows: 1000, timeoutMs: 30_000, signal, executionId });
      if (triggers.truncated) throw new DbError('SQLite 触发器元数据不完整，无法创建一致性备份', { code: 'NATIVE_BACKUP_REQUIRED' });
      for (const row of triggers.rows) await write(String(row[0]).replace(/;\s*$/, '') + ';');
    }
    if (dialect === 'mysql') await write('SET FOREIGN_KEY_CHECKS=1;');
    await txDriver.commitTransaction(txId);
    transactionOpen = false;
    completed = true;
  } finally {
    if (transactionOpen) await txDriver.rollbackTransaction(txId).catch(() => undefined);
    if (stream && !stream.closed) {
      try {
        await new Promise<void>((resolveClose, rejectClose) => {
          stream!.once('close', () => resolveClose());
          stream!.once('error', rejectClose);
          stream!.end();
        });
      } catch (err) {
        if (!completed) throw err;
      }
    }
    if (!completed) rmSync(path, { force: true });
  }
  throwIfAborted(signal);
  const bytes = statSync(path).size;
  const record = store.addBackup({ connectionId, database, path, format: 'sql', bytes, label });
  const backups = store.listBackups(connectionId).filter((backup) => backup.database === database);
  const expiredBefore = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [index, old] of backups.entries()) {
    if (index < BACKUP_RETENTION_COUNT && Date.parse(old.createdAt) >= expiredBefore) continue;
    rmSync(old.path, { force: true });
    store.deleteBackup(old.id);
  }
  return { id: record.id, createdAt: record.createdAt, path, bytes, tables: tableCount, rows: rowCount };
}

const RESTORE_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * 判断 buffer 内是否已出现「引号外」的语句结束分号。
 * 逐条读出备份脚本时，INSERT 的值可能包含 JSON/多行文本（字符串内有真实换行和分号），
 * 只按「行尾分号」切会把一条语句拦腰截断；这里按单双引号/反引号/行注释状态跟踪。
 */
function lineEndsStatement(text: string): boolean {
  let quote: '' | "'" | '"' | '`' = '';
  let lineComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      lineComment = true;
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (text[i + 1] === quote) {
          i++;
          continue; // '' / "" 转义
        }
        quote = '';
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === ';') return true;
  }
  return false;
}

/**
 * 逐条读出备份脚本。AiDB 的 dump 一条语句一行（CREATE TABLE 会跨行），
 * 以「引号外的分号」作为边界，多行字符串值不会把语句拆坏；无分号 EOF 时整体flush。
 */
export async function* readSqlStatements(path: string, signal?: AbortSignal): AsyncGenerator<string> {
  throwIfAborted(signal);
  const input = createReadStream(path, { encoding: 'utf8' });
  const onAbort = () => input.destroy();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const lines = createInterface({ input, crlfDelay: Infinity });
  let buffer = '';
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
      buffer = buffer ? `${buffer}\n${line}` : line;
      if (lineEndsStatement(buffer)) {
        yield buffer.trim();
        buffer = '';
      }
    }
    throwIfAborted(signal);
    if (buffer.trim()) yield buffer.trim();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    input.destroy();
    lines.close();
  }
}

const MAX_RESTORE_BYTES = 2 * 1024 * 1024 * 1024;
const RESTORE_ALLOWED = /^(?:CREATE\s+(?:(?:UNIQUE\s+)?INDEX|TABLE|TRIGGER|VIEW)\b|CREATE\s+OR\s+REPLACE\s+VIEW\b|INSERT\s+INTO\b|SET\s+FOREIGN_KEY_CHECKS\s*=)/i;

async function validateRestoreFile(path: string, engine: Engine, signal?: AbortSignal): Promise<{ headers: string[]; statements: number }> {
  const info = statSync(path);
  if (!info.isFile() || extname(path).toLowerCase() !== '.sql') throw new DbError('恢复文件必须是 .sql 备份', { code: 'INVALID_INPUT' });
  if (info.size > MAX_RESTORE_BYTES) throw new DbError('恢复文件超过 2GB，请使用数据库原生恢复工具', { code: 'FILE_TOO_LARGE' });
  const headers: string[] = [];
  let statements = 0;
  for await (const statement of readSqlStatements(path, signal)) {
    if (splitStatements(statement, engine).length !== 1) throw new DbError('备份中包含多条语句或未闭合的字符串', { code: 'INVALID_BACKUP' });
    const code = statement.replace(/^(?:\s*--[^\n]*\n)+/, '').trimStart();
    if (!RESTORE_ALLOWED.test(code)) throw new DbError(`备份包含不受支持的语句：${code.slice(0, 60)}`, { code: 'INVALID_BACKUP' });
    if (dialectOf(engine) === 'mysql' && /\b(?:TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INTO|ON|REFERENCES)\s+(?:`(?:[^`]|``)+`|[\w$]+)\s*\./i.test(code)) {
      throw new DbError('MySQL 暂存恢复不接受带库名的对象引用，请重新生成 AiDB 备份或使用 mysqldump', { code: 'INVALID_BACKUP' });
    }
    if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\b/i.test(code)) headers.push(code);
    statements++;
  }
  return { headers, statements };
}

async function assertRestoreDependenciesSupported(
  manager: ConnectionManager,
  connectionId: string,
  engine: Engine,
  database: string | undefined,
  options: { signal?: AbortSignal; executionId?: string },
): Promise<void> {
  const dialect = dialectOf(engine);
  const sql = dialect === 'postgres'
    ? "SELECT (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('S','m','f','p') AND n.nspname NOT IN ('pg_catalog','information_schema')) + (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p') AND n.nspname NOT IN ('pg_catalog','information_schema')) + (SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')) AS count"
    : dialect === 'mssql'
      ? "SELECT (SELECT COUNT(*) FROM sys.sequences) + (SELECT COUNT(*) FROM sys.synonyms) + (SELECT COUNT(*) FROM sys.triggers) + (SELECT COUNT(*) FROM sys.sql_modules WHERE type IN ('P','FN','IF','TF')) AS count"
      : dialect === 'sqlite'
        ? "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'"
        : undefined;
  if (!sql) return;
  try {
    const result = await manager.query(connectionId, sql, { database, allowMulti: false, autoLimit: false, actor: 'user', signal: options.signal, executionId: options.executionId });
    const set = result.sets[0];
    if (!set || set.truncated || Number(set.rows[0]?.[0] ?? 0) > 0) {
      throw new DbError(`${engineMeta(engine).label} 目标库包含 AiDB 无法完整重放的序列、例程、触发器或其他依赖对象，已拒绝可能级联删除的恢复；请使用原生备份恢复工具`, { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
    }
  } catch (err: any) {
    if (err instanceof DbError && err.code === 'ATOMIC_RESTORE_UNSUPPORTED') throw err;
    throw Object.assign(new DbError(`无法完整核对 ${engineMeta(engine).label} 恢复依赖，已拒绝非原子恢复；请使用原生备份恢复工具`, { code: 'ATOMIC_RESTORE_UNSUPPORTED' }), { cause: err });
  }
}

async function restoreTransactional(
  manager: ConnectionManager,
  connectionId: string,
  engine: Engine,
  database: string | undefined,
  path: string,
  drops: string[],
  options: { signal?: AbortSignal; executionId?: string },
  timeoutMs: number,
): Promise<number> {
  const txId = `restore-${randomUUID()}`;
  const sqlite = engine === 'sqlite';
  if (sqlite) await manager.query(connectionId, 'PRAGMA foreign_keys=OFF', { database, allowMulti: false, autoLimit: false, actor: 'user', signal: options.signal, executionId: options.executionId });
  await manager.beginTransaction(txId, connectionId, { database, actor: 'user', signal: options.signal, executionId: options.executionId });
  let committed = false;
  let statements = 0;
  try {
    if (engine === 'postgresql' || engine === 'cockroachdb') {
      await manager.query(connectionId, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', { database, allowMulti: false, autoLimit: false, actor: 'user', sessionId: txId, signal: options.signal, executionId: options.executionId });
    }
    if (engine === 'sqlserver') {
      await manager.query(connectionId, 'SET XACT_ABORT ON', { database, allowMulti: false, autoLimit: false, actor: 'user', sessionId: txId, signal: options.signal, executionId: options.executionId });
    }
    const execute = async (statement: string) => {
      await manager.query(connectionId, statement, {
        database,
        allowMulti: false,
        autoLimit: false,
        timeoutMs,
        actor: 'user',
        sessionId: txId,
        signal: options.signal,
        executionId: options.executionId,
      });
      statements++;
    };
    for (const statement of drops.filter((item) => !/^PRAGMA\b/i.test(item))) await execute(statement);
    for await (const statement of readSqlStatements(path, options.signal)) await execute(statement);
    await manager.commitTransaction(txId, 'user');
    committed = true;
    return statements;
  } catch (err) {
    if (!committed) {
      try {
        await manager.rollbackTransaction(txId, 'user');
      } catch (rollbackErr: any) {
        throw Object.assign(new Error(`恢复失败且回滚失败：${rollbackErr?.message ?? rollbackErr}`), { code: 'RESTORE_ROLLBACK_FAILED', cause: rollbackErr });
      }
    }
    throw err;
  } finally {
    if (sqlite) await manager.query(connectionId, 'PRAGMA foreign_keys=ON', { database, allowMulti: false, autoLimit: false, actor: 'user', executionId: options.executionId }).catch(() => undefined);
  }
}

async function restoreMysqlStaging(
  manager: ConnectionManager,
  connectionId: string,
  engine: Engine,
  database: string,
  path: string,
  headers: string[],
  options: { signal?: AbortSignal; executionId?: string },
  timeoutMs: number,
): Promise<{ statements: number; messages: string[] }> {
  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(headers.join('\n'))) {
    throw new DbError('MySQL 含视图的备份请使用 mysqldump 原生恢复，AiDB 暂不进行非原子换库', { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
  }
  const protectedDatabases = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
  if (protectedDatabases.has(database.toLowerCase())) throw new DbError('禁止恢复系统数据库', { code: 'INVALID_INPUT' });
  const suffix = randomUUID().replace(/-/g, '').slice(0, 16);
  const staging = `aidb_restore_${suffix}`;
  const rollback = `aidb_rollback_${suffix}`;
  const run = (sql: string, db?: string) => manager.query(connectionId, sql, {
    database: db,
    allowMulti: false,
    autoLimit: false,
    timeoutMs,
    actor: 'user',
    signal: options.signal,
    executionId: options.executionId,
  });
  let stagingCreated = false;
  let rollbackCreated = false;
  let targetCreated = false;
  let swapAttempted = false;
  const messages: string[] = [];
  const cleanup = (sql: string) => manager.query(connectionId, sql, {
    allowMulti: false,
    autoLimit: false,
    timeoutMs,
    actor: 'user',
    executionId: options.executionId,
  });
  const unsupportedObjects = async (db: string): Promise<void> => {
    const result = await run(
      `SELECT 'trigger' AS object_type, TRIGGER_NAME AS object_name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=${quoteLiteral(db)}`
      + ` UNION ALL SELECT 'routine', ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=${quoteLiteral(db)}`
      + ` UNION ALL SELECT 'event', EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA=${quoteLiteral(db)}`
      + ` UNION ALL SELECT 'non-table', TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=${quoteLiteral(db)} AND TABLE_TYPE <> 'BASE TABLE'`,
      db,
    );
    const set = result.sets[0];
    if (!set || set.truncated) throw new DbError(`无法完整核对 ${db} 的恢复依赖对象，已拒绝非原子恢复`, { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
    if (set.rows.length) {
      const names = set.rows.map((row) => `${row[0] ?? 'object'} ${row[1] ?? ''}`).join(', ');
      throw new DbError(`${db} 包含 AiDB 暂存换表无法完整迁移的对象（${names}），已拒绝非原子恢复；请使用 mysqldump 或先移除这些依赖`, { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
    }
  };
  const outcomeError = (cause: unknown, state: string): DbError => Object.assign(
    new DbError(
      `MySQL 原子换表结果无法确认（${state}）。为避免误删旧数据，已停止自动清理并保留暂存库 ${staging}${rollbackCreated ? ` 和回滚库 ${rollback}` : ''}；请人工核对目标库、暂存库和回滚库的表名与数据后再删除。原始错误：${(cause as Error)?.message ?? cause}`,
      { code: 'ATOMIC_RESTORE_OUTCOME_UNKNOWN' },
    ),
    { cause },
  );
  try {
    await run(`CREATE DATABASE ${quoteIdent(staging, engine)} CHARACTER SET utf8mb4`);
    stagingCreated = true;
    let pending = '';
    let statements = 0;
    const flush = async () => {
      if (!pending.trim()) return;
      const script = pending;
      pending = '';
      const executed = await manager.execScript(connectionId, script, {
        database: staging,
        timeoutMs,
        actor: 'user',
        signal: options.signal,
        executionId: options.executionId,
      });
      if (!executed) throw new DbError('MySQL 驱动不支持暂存恢复', { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
    };
    for await (const statement of readSqlStatements(path, options.signal)) {
      pending += `${statement}\n`;
      statements++;
      if (pending.length >= RESTORE_BATCH_BYTES) await flush();
    }
    await flush();
    const stagedTables = (await manager.schema(connectionId, staging, true, 30000, { signal: options.signal, executionId: options.executionId }))
      .flatMap((schema) => schema.tables)
      .filter((table) => table.type === 'table');
    if (!stagedTables.length) throw new DbError('备份没有可恢复的表', { code: 'INVALID_BACKUP' });
    const databases = new Set((await manager.listDatabases(connectionId)).map((name) => name.toLowerCase()));
    const targetExists = databases.has(database.toLowerCase());
    const targetTables = targetExists
      ? (await manager.schema(connectionId, database, true, 30000, { signal: options.signal, executionId: options.executionId })).flatMap((schema) => schema.tables).filter((table) => table.type === 'table')
      : [];
    const targetNames = new Set(targetTables.map((table) => table.name.toLowerCase()));
    const stagedNames = new Set(stagedTables.map((table) => table.name.toLowerCase()));
    const preservedNames = new Set([...targetNames].filter((name) => !stagedNames.has(name)));
    const blockingReference = targetTables.find((table) => !stagedNames.has(table.name.toLowerCase()) && (table.foreignKeys ?? []).some((foreignKey) => stagedNames.has(foreignKey.refTable.toLowerCase())));
    if (blockingReference) throw new DbError(`目标表 ${blockingReference.name} 引用待替换表但不在备份中，已拒绝非原子恢复`, { code: 'ATOMIC_RESTORE_UNSUPPORTED' });

    // RENAME TABLE 不会迁移例程/事件/触发器，DROP DATABASE 又会级联删除旧表触发器。
    // 这些对象无法由当前备份完整重放时必须先失败，不能做“看似成功”的部分恢复。
    await unsupportedObjects(staging);
    if (targetExists) await unsupportedObjects(database);
    if (targetExists) {
      const references = await run(
        `SELECT CONSTRAINT_SCHEMA, TABLE_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE`
        + ` WHERE CONSTRAINT_SCHEMA=${quoteLiteral(database)} OR REFERENCED_TABLE_SCHEMA=${quoteLiteral(database)}`,
        database,
      );
      const set = references.sets[0];
      if (!set || set.truncated) throw new DbError('无法完整核对 MySQL 外键依赖，已拒绝非原子恢复', { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
      for (const row of set.rows) {
        const constraintSchema = String(row[0] ?? '').toLowerCase();
        const tableName = String(row[1] ?? '').toLowerCase();
        const referencedSchema = String(row[2] ?? '').toLowerCase();
        const referencedTable = String(row[3] ?? '').toLowerCase();
        const internal = constraintSchema === database.toLowerCase()
          && referencedSchema === database.toLowerCase()
          && stagedNames.has(tableName)
          && stagedNames.has(referencedTable);
        if (!internal) throw new DbError(`MySQL 外键 ${constraintSchema}.${tableName} 依赖 ${referencedSchema}.${referencedTable}，超出本次完整替换范围，已拒绝非原子恢复`, { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
      }
    }

    const sameNames = (actual: Set<string>, expected: Set<string>) => actual.size === expected.size && [...expected].every((name) => actual.has(name));
    const tableNames = async (db: string) => new Set((await manager.schema(connectionId, db, true, 30000))
      .flatMap((schema) => schema.tables)
      .filter((table) => table.type === 'table')
      .map((table) => table.name.toLowerCase()));
    const verifySwap = async (): Promise<'complete' | 'incomplete' | 'unknown'> => {
      try {
        const databases = new Set((await manager.listDatabases(connectionId)).map((name) => name.toLowerCase()));
        const required = [database.toLowerCase(), staging.toLowerCase(), ...(rollbackCreated ? [rollback.toLowerCase()] : [])];
        if (required.some((name) => !databases.has(name))) return 'incomplete';
        const [targetNow, stagingNow, rollbackNow] = await Promise.all([
          tableNames(database),
          tableNames(staging),
          rollbackCreated ? tableNames(rollback) : Promise.resolve(new Set<string>()),
        ]);
        const expectedTarget = new Set([...stagedNames, ...preservedNames]);
        const expectedRollback = new Set([...stagedNames].filter((name) => targetNames.has(name)));
        return sameNames(targetNow, expectedTarget) && stagingNow.size === 0 && sameNames(rollbackNow, expectedRollback) ? 'complete' : 'incomplete';
      } catch {
        return 'unknown';
      }
    };
    const renames: string[] = [];
    if (targetExists) {
      await run(`CREATE DATABASE ${quoteIdent(rollback, engine)} CHARACTER SET utf8mb4`);
      rollbackCreated = true;
      for (const table of stagedTables) {
        if (targetNames.has(table.name.toLowerCase())) renames.push(`${quoteQualified([database, table.name], engine)} TO ${quoteQualified([rollback, table.name], engine)}`);
      }
    } else {
      await run(`CREATE DATABASE ${quoteIdent(database, engine)} CHARACTER SET utf8mb4`);
      targetCreated = true;
    }
    for (const table of stagedTables) renames.push(`${quoteQualified([staging, table.name], engine)} TO ${quoteQualified([database, table.name], engine)}`);
    const swap = `SET FOREIGN_KEY_CHECKS=0;\nRENAME TABLE ${renames.join(', ')};\nSET FOREIGN_KEY_CHECKS=1;`;
    swapAttempted = true;
    let swapError: unknown;
    try {
      const executed = await manager.execScript(connectionId, swap, { database, timeoutMs, actor: 'user', signal: options.signal, executionId: options.executionId });
      if (!executed) throw new DbError('MySQL 驱动不支持原子换表', { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
    } catch (err) {
      // RENAME TABLE 可能已提交但 ACK 丢失。此时绝不能根据 promoted=false 进入 DROP 清理。
      swapError = err;
    }
    if (swapError) throw outcomeError(swapError, '换表脚本未收到成功确认');

    const state = await verifySwap();
    if (state !== 'complete') throw outcomeError(new Error(`换表后状态核对为 ${state}`), `换表后状态核对为 ${state}`);
    manager.invalidate(connectionId, 'user');
    if (rollbackCreated) {
      try {
        await run(`DROP DATABASE ${quoteIdent(rollback, engine)}`);
        rollbackCreated = false;
      } catch {
        messages.push(`旧数据清理确认失败：回滚库 ${rollback} 可能仍存在，请人工核对目标库与回滚库后再删除`);
      }
    }
    if (stagingCreated) {
      try {
        await cleanup(`DROP DATABASE IF EXISTS ${quoteIdent(staging, engine)}`);
        stagingCreated = false;
      } catch {
        messages.push(`暂存库 ${staging} 清理确认失败，请人工核对后再删除`);
      }
    }
    return { statements, messages };
  } finally {
    // 只有从未尝试换表时，才可安全清理本函数创建的暂存库/空回滚库/空目标库。
    // 一旦尝试 RENAME，任何错误路径都保留现场，等待人工核对。
    if (!swapAttempted) {
      if (stagingCreated) await cleanup(`DROP DATABASE IF EXISTS ${quoteIdent(staging, engine)}`).catch(() => undefined);
      if (rollbackCreated) await cleanup(`DROP DATABASE IF EXISTS ${quoteIdent(rollback, engine)}`).catch(() => undefined);
      if (targetCreated) await cleanup(`DROP DATABASE IF EXISTS ${quoteIdent(database, engine)}`).catch(() => undefined);
    }
  }
}

async function restoreSqlServerCaseSensitive(
  manager: ConnectionManager,
  connectionId: string,
  database: string,
  options: { signal?: AbortSignal; executionId?: string },
): Promise<boolean> {
  try {
    const result = await manager.query(
      connectionId,
      "SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS collation",
      { database, allowMulti: false, autoLimit: false, actor: 'user', signal: options.signal, executionId: options.executionId },
    );
    const set = result.sets[0];
    const collation = String(set?.rows[0]?.[0] ?? '').trim();
    if (!set || set.truncated || !collation) throw new Error('未返回目标数据库排序规则');
    return /(?:^|_)(?:CS|BIN2?)(?:_|$)/i.test(collation);
  } catch (err: any) {
    throw Object.assign(new DbError('无法确认 SQL Server 目标数据库排序规则，已拒绝可能误判对象身份的恢复', { code: 'ATOMIC_RESTORE_UNSUPPORTED' }), { cause: err });
  }
}

export async function restoreBackupFile(
  store: Store,
  manager: ConnectionManager,
  connectionId: string,
  path: string,
  database?: string,
  options: { signal?: AbortSignal; executionId?: string } = {},
): Promise<QueryBatchResult> {
  throwIfAborted(options.signal);
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('备份对应的连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const started = Date.now();
  const timeoutMs = store.getSettings().queryTimeoutMs;
  const inspected = await validateRestoreFile(path, conn.engine, options.signal);
  const dialect = dialectOf(conn.engine);
  const targetDatabase = database ?? conn.database;
  let sqlServerCaseSensitive = true;
  let statements = inspected.statements;
  const messages: string[] = [];
  if (dialect === 'sqlite' || dialect === 'mysql' || dialect === 'postgres' || dialect === 'mssql') {
    if (!targetDatabase && dialect !== 'sqlite') throw new DbError('恢复必须指定目标数据库', { code: 'INVALID_INPUT' });
    const databases = dialect === 'sqlite' ? [targetDatabase ?? ''] : await manager.listDatabases(connectionId);
    if (dialect === 'sqlite' || databases.some((name) => name.toLowerCase() === targetDatabase!.toLowerCase())) {
      if (dialect === 'mssql') sqlServerCaseSensitive = await restoreSqlServerCaseSensitive(manager, connectionId, targetDatabase!, options);
      const objects = restoreObjectNames(conn.engine, inspected.headers.join('\n'), sqlServerCaseSensitive);
      const expected = new Set([...objects.tables, ...objects.views].map((object) => restoreObjectKey(object, dialect, sqlServerCaseSensitive)));
      const targetSchemas = await manager.schema(connectionId, targetDatabase, true, 30000, { signal: options.signal, executionId: options.executionId });
      const extra = targetSchemas.flatMap((schema) => schema.tables).find((table) => {
        if (table.type !== 'table' && table.type !== 'view') return false;
        const schema = engineUsesSchema(conn.engine) && dialect !== 'mysql' ? table.schema : undefined;
        return !expected.has(restoreTargetObjectKey(schema, table.name, dialect, sqlServerCaseSensitive));
      });
      if (extra) throw new DbError(`目标数据库包含备份外的对象 ${extra.schema ? `${extra.schema}.` : ''}${extra.name}，已拒绝非完整恢复`, { code: 'RESTORE_OBJECT_MISMATCH' });
    }
  }
  if (dialect === 'mysql') {
    if (!targetDatabase) throw new DbError('MySQL 恢复必须指定目标数据库', { code: 'INVALID_INPUT' });
    const restored = await restoreMysqlStaging(manager, connectionId, conn.engine, targetDatabase, path, inspected.headers, options, timeoutMs);
    statements = restored.statements;
    messages.push(...restored.messages);
  } else if (['sqlite', 'postgres', 'mssql'].includes(dialect) && supportsTransaction(await manager.rawDriver(connectionId))) {
    await assertRestoreDependenciesSupported(manager, connectionId, conn.engine, targetDatabase, options);
    const drops = restoreDropStatements(conn.engine, inspected.headers.join('\n'), sqlServerCaseSensitive);
    statements = await restoreTransactional(manager, connectionId, conn.engine, targetDatabase, path, drops, options, timeoutMs);
  } else if (dialect === 'sqlite' && typeof (await manager.rawDriver(connectionId)).execScript === 'function') {
    throw new DbError('SQLite 驱动缺少事务能力，已拒绝恢复', { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
  } else {
    throw new DbError(`${engineMeta(conn.engine).label} 暂不支持 AiDB 原子恢复，请使用数据库原生备份恢复工具`, { code: 'ATOMIC_RESTORE_UNSUPPORTED' });
  }
  messages.push(`备份已原子恢复 · ${statements} 条语句`);
  return { sets: [], messages, durationMs: Date.now() - started };
}

export function auditCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '\uFEFF';
  const columns = Object.keys(rows[0]);
  return toCsv(columns, rows.map((r) => columns.map((c) => r[c])));
}

export function safeBasename(p: string): string {
  return basename(p);
}

export function ensureExportDir(dir: string): string {
  if (!existsSync(dir)) throw new DbError(`导出目录不存在：${dir}`, { code: 'EXPORT_DIR' });
  return dirname(join(dir, 'x'));
}
