import { createReadStream, createWriteStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
  quoteQualified,
  type ColumnDef,
  type ConnectionConfig,
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
import { estimateRowBytes, supportsRowStream } from './drivers/types';
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

export function resolveImportFile(config: GatewayConfig, requestedPath: string): string {
  const path = resolve(requestedPath);
  const allowedRoots = [resolve(config.importDir), resolve(config.home)];
  const allowed = allowedRoots.some((root) => {
    const rel = relative(root, path);
    return !rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`);
  });
  if (!allowed) throw new DbError('导入文件必须位于导入目录或 AiDB 数据目录内', { code: 'PATH_NOT_ALLOWED' });
  if (!existsSync(path) || !statSync(path).isFile()) throw new DbError(`文件不存在：${path}`, { code: 'FILE_NOT_FOUND' });
  return path;
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

/**
 * 备份是完整的 DDL + INSERT 脚本，直接重放会撞上「表已存在」。
 * 恢复前先按脚本里的对象生成 DROP 语句；不支持的方言保持原行为。
 */
export function restoreDropStatements(engine: Engine, dump: string): string[] {
  const dialect = dialectOf(engine);
  if (!['sqlite', 'mysql', 'postgres', 'mssql', 'oracle', 'dm', 'clickhouse'].includes(dialect)) return [];
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|`(?:[^`]|``)+`|\[[^\]]+\]|[A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)/gi;
  const views = new Set<string>();
  const tables = new Set<string>();
  for (const match of dump.matchAll(pattern)) {
    const kind = match[1].toUpperCase();
    const name = match[2].trim();
    (kind === 'VIEW' ? views : tables).add(name);
  }
  // mssql/oracle/dm/clickhouse 弃置方言特性：oracle/dm 无 IF EXISTS，需要时先查存在性（用简单可回退策略）。
  // 这里统一按「IF EXISTS / 无 IF 回退」生成，避免恢复撞「已存在」。
  const supportsIfExists = dialect === 'mysql' || dialect === 'postgres' || dialect === 'mssql' || dialect === 'sqlite' || dialect === 'clickhouse';
  const cascade = dialect === 'postgres' ? ' CASCADE' : dialect === 'oracle' || dialect === 'dm' ? ' CASCADE CONSTRAINTS' : '';
  const drops = [
    ...[...views].map((name) => `DROP VIEW ${supportsIfExists ? 'IF EXISTS ' : ''}${name}${cascade};`),
    ...[...tables].map((name) => `DROP TABLE ${supportsIfExists ? 'IF EXISTS ' : ''}${name}${cascade};`),
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
  if (supportsRowStream(driver)) {
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
    if (index < 0 || !last || last[index] === null || last[index] === undefined) return rowCount;
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
  const schemas = await manager.schema(connectionId, database, true, 30000, { signal, executionId });
  throwIfAborted(signal);
  const driver = await manager.rawDriver(connectionId);
  throwIfAborted(signal);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = (database ?? conn.database ?? conn.name).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const path = join(config.backupDir, `${conn.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}-${safeName}-${stamp}-${randomUUID().slice(0, 8)}.sql`);
  // 边读边写：整库备份不能再把「全部行 + 全部 INSERT 文本 + join 后的巨型字符串」同时留在内存里。
  const stream = createWriteStream(path, { flags: 'w' });
  const write = async (text: string) => {
    throwIfAborted(signal);
    await new Promise<void>((resolveWrite, rejectWrite) => {
      stream.write(`${text}\n`, (err) => (err ? rejectWrite(err) : resolveWrite()));
    });
    throwIfAborted(signal);
  };
  let tableCount = 0;
  let rowCount = 0;
  let completed = false;
  try {
    await write(`-- AiDB Studio backup`);
    await write(`-- connection: ${conn.name} (${conn.engine})`);
    await write(`-- database: ${database ?? conn.database ?? ''}`);
    await write(`-- created: ${new Date().toISOString()}`);
    await write('');
    for (const schema of schemas) {
      for (const table of schema.tables) {
        throwIfAborted(signal);
        if (table.type !== 'table') continue;
        const columns = table.columns ?? [];
        if (!columns.length) continue;
        tableCount++;
        const columnDefs: ColumnDef[] = columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          defaultValue: c.defaultValue !== undefined && c.defaultValue !== null ? safeDefaultToDump(String(c.defaultValue)) : undefined,
          primaryKey: c.primaryKey,
          autoIncrement: c.autoIncrement,
        }));
        const indexes: IndexDef[] = (table.indexes ?? [])
          .filter((i) => !i.primary)
          .map((i) => ({ name: i.name, columns: i.columns, unique: i.unique }));
        await write(`-- table ${table.name}`);
        await write(buildCreateTable(conn.engine, { table: table.name, columns: columnDefs, indexes: [], schema: engineUsesSchema(conn.engine) ? table.schema : undefined }) + ';');
        for (const idx of indexes) {
          await write(buildCreateIndex(conn.engine, table.name, idx, engineUsesSchema(conn.engine) ? table.schema : undefined) + ';');
        }
        const target = quoteQualified([engineUsesSchema(conn.engine) ? table.schema : undefined, table.name], conn.engine);
        // 备份的是哪个库就用哪个库读数据；写死 conn.database 会把非默认库的备份读成默认库的表。
        rowCount += await writeTableRows(
          write,
          driver,
          conn.engine,
          table,
          `SELECT * FROM ${target}`,
          database ?? conn.database,
          signal,
          async (sql, params, db) => {
            const options = { database: db, allowMulti: false, autoLimit: false, actor: 'user' as const, executionId, signal };
            const result = params.length
              ? await manager.runParams(connectionId, sql, params, options)
              : (await manager.query(connectionId, sql, options)).sets[0];
            if (!result) throw new DbError('备份读取没有返回结果', { code: 'BACKUP_READ_EMPTY' });
            return result;
          },
        );
        await write('');
      }
    }
    completed = true;
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      stream.once('close', () => resolveClose());
      stream.once('error', rejectClose);
      stream.end();
    });
    if (!completed) rmSync(path, { force: true });
  }
  throwIfAborted(signal);
  const bytes = statSync(path).size;
  const record = store.addBackup({ connectionId, database, path, format: 'sql', bytes, label });
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
  // 第一遍只留 CREATE 的表头，用来生成 DROP；第二遍才真正回放，避免整库脚本进内存。
  const headers: string[] = [];
  for await (const statement of readSqlStatements(path, options.signal)) {
    if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\b/i.test(statement)) headers.push(statement.split('\n', 1)[0]);
  }
  const drops = restoreDropStatements(conn.engine, headers.join('\n'));
  const driver = await manager.rawDriver(connectionId);
  const viaScript = typeof driver.execScript === 'function';
  const sets: QueryResult[] = [];
  const messages: string[] = [];
  let pending = '';
  let statements = 0;
  const flush = async () => {
    throwIfAborted(options.signal);
    if (!pending.trim()) return;
    const script = pending;
    pending = '';
    if (viaScript) {
      // SQLite / DuckDB 走整段脚本：几十万条 INSERT 逐条执行会阻塞事件循环十几分钟。
      await manager.execScript(connectionId, `BEGIN;\n${script}\nCOMMIT;`, {
        database,
        timeoutMs,
        actor: 'user',
        signal: options.signal,
        executionId: options.executionId,
      });
    } else {
      const batch = await manager.query(connectionId, script, {
        database,
        allowMulti: true,
        autoLimit: false,
        timeoutMs,
        actor: 'user',
        signal: options.signal,
        executionId: options.executionId,
      });
      sets.push(...batch.sets);
    }
  };
  pending = drops.length ? `${drops.join('\n')}\n` : '';
  for await (const statement of readSqlStatements(path, options.signal)) {
    throwIfAborted(options.signal);
    pending += `${statement}\n`;
    statements += 1;
    if (pending.length >= RESTORE_BATCH_BYTES) await flush();
  }
  await flush();
  messages.push(viaScript ? `备份已恢复 · ${statements} 条语句` : `备份已恢复 · ${statements} 条语句 · ${sets.length} 个结果集`);
  return { sets, messages, durationMs: Date.now() - started };
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
