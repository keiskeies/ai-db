import { createReadStream, createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  quoteLiteral,
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
import { toXlsx } from './xlsx';
import type { ConnectionManager } from './manager';
import type { Store } from './store';

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xml' | 'xlsx';

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

function escapeCsv(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  return '\uFEFF' + [columns.map(escapeCsv).join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\r\n') + '\r\n';
}

const BINARY_LITERAL: Record<string, (hex: string) => string> = {
  postgres: (hex) => `decode('${hex}', 'hex')`,
  mssql: (hex) => `0x${hex}`,
  oracle: (hex) => `hextoraw('${hex}')`,
  dm: (hex) => `hextoraw('${hex}')`,
  clickhouse: (hex) => `unhex('${hex}')`,
  tdengine: (hex) => `x'${hex}'`,
  influxdb: (hex) => `decode('${hex}')`,
  mysql: (hex) => `X'${hex}'`,
  sqlite: (hex) => `X'${hex}'`,
};

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** 本地墙钟时间：PG 的 timestamp（无时区）按会话时区解析，转成 UTC 会整体偏移。 */
function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function localOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function dateLiteral(date: Date, dialect: DialectId): string {
  const stamp = localStamp(date);
  // Oracle 与达梦的默认日期格式不是 ISO，裸字符串会按 NLS 解析失败。
  if (dialect === 'oracle' || dialect === 'dm') return `TO_TIMESTAMP(${quoteLiteral(stamp)}, 'YYYY-MM-DD HH24:MI:SS.FF3')`;
  if (dialect === 'mssql') return quoteLiteral(`${stamp.slice(0, 10)}T${stamp.slice(11)}`);
  if (dialect === 'influxdb') return quoteLiteral(date.toISOString());
  // PG 带偏移：timestamptz 保留瞬时，timestamp 会忽略偏移并保留墙钟。
  if (dialect === 'postgres') return quoteLiteral(`${stamp}${localOffset(date)}`);
  return quoteLiteral(stamp);
}

function binaryLiteral(value: Uint8Array, engine: Engine, dialect: DialectId): string {
  const hex = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  // DuckDB 的 BLOB 字面量不是标准 X'…'。
  if (engine === 'duckdb') return `'\\x${hex}'::BLOB`;
  return (BINARY_LITERAL[dialect] ?? BINARY_LITERAL.mysql)(hex);
}

export function sqlLiteral(value: unknown, engine: Engine): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  // 按方言判断，不能只认 postgresql/cockroachdb；Kingbase/openGauss/Timescale 等别名同样不接受 1/0 写 boolean。
  if (typeof value === 'boolean') return dialectOf(engine) === 'postgres' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0';
  if (value instanceof Date) return dateLiteral(value, dialectOf(engine));
  // node:sqlite 的 BLOB 是 Uint8Array，不是 Buffer；按对象 JSON 化会得到 {"0":1,…} 这种垃圾。
  if (value instanceof Uint8Array) return binaryLiteral(value, engine, dialectOf(engine));
  // PG 驱动把数组列返回成 JS 数组，JSON 串无法隐式转成 integer[] 等数组类型。
  if (Array.isArray(value)) {
    if (dialectOf(engine) !== 'postgres') return quoteLiteral(JSON.stringify(value));
    return value.length ? `ARRAY[${value.map((item) => sqlLiteral(item, engine)).join(', ')}]` : `'{}'`;
  }
  if (typeof value === 'object') return quoteLiteral(JSON.stringify(value));
  return quoteLiteral(String(value));
}

export function toSqlInserts(engine: Engine, table: string, columns: string[], rows: unknown[][], schema?: string): string {
  const target = quoteQualified([schema, table], engine);
  const cols = columns.map((c) => quoteIdent(c, engine)).join(', ');
  return rows.map((row) => `INSERT INTO ${target} (${cols}) VALUES (${row.map((v) => sqlLiteral(v, engine)).join(', ')});`).join('\n');
}

export interface ExportInput {
  dir: string;
  format: ExportFormat;
  columns: string[];
  rows: unknown[][];
  tableName?: string;
  engine: Engine;
  baseName?: string;
}

export function writeExportFile(input: ExportInput): { path: string; bytes: number; rows: number } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeBase = (input.baseName || input.tableName || 'query').replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const path = join(input.dir, `${safeBase}-${stamp}.${input.format}`);
  let content: string | Buffer;
  if (input.format === 'csv') content = toCsv(input.columns, input.rows);
  else if (input.format === 'xml') {
    const escapeXml = (value: unknown) => {
      if (value === null || value === undefined) return '';
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    const tag = (value: string) => {
      const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, '_');
      return /^[A-Za-z_]/.test(cleaned) ? cleaned : `col_${cleaned}`;
    };
    const xmlRows = input.rows
      .map(
        (row) =>
          '  <row>' +
          input.columns.map((column, index) => `<${tag(column)}>${escapeXml(row[index])}</${tag(column)}>`).join('') +
          '</row>',
      )
      .join('\n');
    content = `<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n${xmlRows}\n</rows>\n`;
  }
  else if (input.format === 'xlsx') {
    content = toXlsx(input.columns, input.rows);
  }
  else if (input.format === 'json') {
    content = JSON.stringify(
      input.rows.map((row) => Object.fromEntries(input.columns.map((c, i) => [c, row[i] === undefined ? null : row[i]]))),
      null,
      2,
    );
  } else {
    content =
      `-- AiDB Studio export (${new Date().toISOString()})\n` +
      toSqlInserts(input.engine, input.tableName || 'exported_data', input.columns, input.rows) +
      '\n';
  }
  if (typeof content === 'string') writeFileSync(path, content, 'utf8');
  else writeFileSync(path, content);
  return { path, bytes: statSync(path).size, rows: input.rows.length };
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
    const chunk = documents.slice(start, start + batchSize);
    try {
      const result = await manager.writeDocuments(connectionId, { collection: opts.collection, documents: chunk }, { database: conn.database, actor: 'user' });
      imported += result.upserted;
    } catch (err: any) {
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
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  if (conn.readonly) throw new DbError('只读连接禁止导入', { code: 'READONLY', status: 403 });
  const { table } = await manager.findTable(connectionId, conn.database, opts.table);
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
    for (const [colIdx, column] of columns.entries()) {
      const raw = row[indexes[colIdx]] ?? '';
      params.push(coerce(raw, typeByColumn.get(column) ?? 'text'));
    }
    if (row.length < Math.max(...indexes) + 1) errors.push(`第 ${rowIndex + 1} 行列数不足`);
  }
  if (errors.length) return { inserted: 0, skipped: dataRows.length, errors, columns };

  const sql = buildInsert(conn.engine, table.name, columns, dataRows.length, engineUsesSchema(conn.engine) ? table.schema : undefined);
  try {
    const result = await manager.runParams(connectionId, sql, params, { database: conn.database, actor: 'user' });
    return { inserted: result.affected ?? dataRows.length, skipped: 0, errors: [], columns };
  } catch (err: any) {
    throw new DbError(`导入失败，已回滚：${err.message}`, { code: 'IMPORT_FAILED', hint: '检查列类型与 CSV 内容是否匹配' });
  }
}

/**
 * 备份是完整的 DDL + INSERT 脚本，直接重放会撞上“表已存在”。
 * 恢复前先按脚本里的对象生成 DROP 语句；不支持的方言保持原行为。
 */
export function restoreDropStatements(engine: Engine, dump: string): string[] {
  const dialect = dialectOf(engine);
  if (!['sqlite', 'mysql', 'postgres', 'mssql'].includes(dialect)) return [];
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|`(?:[^`]|``)+`|\[[^\]]+\]|[A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)/gi;
  const views = new Set<string>();
  const tables = new Set<string>();
  for (const match of dump.matchAll(pattern)) {
    const kind = match[1].toUpperCase();
    const name = match[2].trim();
    (kind === 'VIEW' ? views : tables).add(name);
  }
  const cascade = dialect === 'postgres' ? ' CASCADE' : '';
  const drops = [
    ...[...views].map((name) => `DROP VIEW IF EXISTS ${name}${cascade};`),
    ...[...tables].map((name) => `DROP TABLE IF EXISTS ${name}${cascade};`),
  ];
  if (!drops.length) return [];
  if (dialect === 'mysql') return ['SET FOREIGN_KEY_CHECKS=0;', ...drops, 'SET FOREIGN_KEY_CHECKS=1;'];
  if (dialect === 'sqlite') return ['PRAGMA foreign_keys=OFF;', ...drops, 'PRAGMA foreign_keys=ON;'];
  return drops;
}

const DUMP_CHUNK_ROWS = 2000;
const OFFSET_DIALECTS = new Set<DialectId>(['sqlite', 'mysql', 'postgres', 'mssql', 'clickhouse', 'tdengine']);
const KEYSET_DIALECTS = new Set<DialectId>(['sqlite', 'mysql', 'postgres', 'mssql', 'clickhouse']);

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
  return `${base}${where}${orderBy} LIMIT ${limit}`;
}

async function writeTableRows(
  write: (text: string) => Promise<void>,
  driver: Driver,
  engine: Engine,
  table: TableInfo,
  base: string,
  database: string | undefined,
): Promise<number> {  const plan = dumpReadPlan(engine, table);
  const schema = engineUsesSchema(engine) ? table.schema : undefined;
  let names: string[] | undefined;
  let rowCount = 0;
  const emit = async (result: QueryResult) => {
    if (!names) names = result.columns.map((column) => column.name);
    for (let i = 0; i < result.rows.length; i += DUMP_CHUNK_ROWS) {
      const chunk = result.rows.slice(i, i + DUMP_CHUNK_ROWS);
      await write(toSqlInserts(engine, table.name, names, chunk, schema));
      rowCount += chunk.length;
    }
  };
  if (plan.mode === 'single') {
    await emit(await driver.run(base, { database }));
    return rowCount;
  }
  if (plan.mode === 'offset') {
    for (let offset = 0; ; offset += DUMP_CHUNK_ROWS) {
      const result = await driver.run(dumpPageSql(engine, base, plan.order, DUMP_CHUNK_ROWS, offset), { database });
      await emit(result);
      if (result.rows.length < DUMP_CHUNK_ROWS) return rowCount;
    }
  }
  let cursor: unknown;
  for (;;) {
    const sql = dumpKeysetSql(engine, base, plan.column, DUMP_CHUNK_ROWS, cursor);
    const result = cursor === undefined
      ? await driver.run(sql, { database })
      : await driver.runParams(sql, [cursor], { database });
    await emit(result);
    if (result.rows.length < DUMP_CHUNK_ROWS) return rowCount;
    const index = result.columns.findIndex((column) => column.name.toLowerCase() === plan.column.toLowerCase());
    const last = result.rows[result.rows.length - 1];
    if (index < 0 || !last || last[index] === null || last[index] === undefined) return rowCount;
    cursor = last[index];
  }
}

export async function dumpDatabase(  store: Store,
  manager: ConnectionManager,
  config: GatewayConfig,
  connectionId: string,
  database?: string,
  label?: string,
): Promise<{ id: string; createdAt: string; path: string; bytes: number; tables: number; rows: number }> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const schemas = await manager.schema(connectionId, database, true);
  const driver = await manager.rawDriver(connectionId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = (database ?? conn.database ?? conn.name).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const path = join(config.backupDir, `${conn.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}-${safeName}-${stamp}.sql`);
  // 边读边写：整库备份不能再把「全部行 + 全部 INSERT 文本 + join 后的巨型字符串」同时留在内存里。
  const stream = createWriteStream(path, { flags: 'w' });
  const write = (text: string) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      stream.write(`${text}\n`, (err) => (err ? rejectWrite(err) : resolveWrite()));
    });
  let tableCount = 0;
  let rowCount = 0;
  try {
    await write(`-- AiDB Studio backup`);
    await write(`-- connection: ${conn.name} (${conn.engine})`);
    await write(`-- database: ${database ?? conn.database ?? ''}`);
    await write(`-- created: ${new Date().toISOString()}`);
    await write('');
    for (const schema of schemas) {
      for (const table of schema.tables) {
        if (table.type !== 'table') continue;
        const columns = table.columns ?? [];
        if (!columns.length) continue;
        tableCount++;
        const columnDefs: ColumnDef[] = columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          defaultValue: c.defaultValue !== undefined && c.defaultValue !== null && !/[()]|::/.test(String(c.defaultValue)) ? String(c.defaultValue) : undefined,
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
        rowCount += await writeTableRows(write, driver, conn.engine, table, `SELECT * FROM ${target}`, database ?? conn.database);
        await write('');
      }
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      stream.once('close', () => resolveClose());
      stream.once('error', rejectClose);
      stream.end();
    });
  }
  const bytes = statSync(path).size;
  const record = store.addBackup({ connectionId, database, path, format: 'sql', bytes, label });
  return { id: record.id, createdAt: record.createdAt, path, bytes, tables: tableCount, rows: rowCount };
}

const RESTORE_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * 逐条读出备份脚本。AiDB 的 dump 一条语句一行（CREATE TABLE 会跨行），
 * 因此以「行尾分号」作为边界即可，不必把整个文件读进内存再 split。
 */
export async function* readSqlStatements(path: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let buffer = '';
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    buffer = buffer ? `${buffer}\n${line}` : line;
    if (trimmed.endsWith(';')) {
      yield buffer.trim();
      buffer = '';
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

export async function restoreBackupFile(
  store: Store,
  manager: ConnectionManager,
  connectionId: string,
  path: string,
  database?: string,
): Promise<QueryBatchResult> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('备份对应的连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const started = Date.now();
  const timeoutMs = store.getSettings().queryTimeoutMs;
  // 第一遍只留 CREATE 的表头，用来生成 DROP；第二遍才真正回放，避免整库脚本进内存。
  const headers: string[] = [];
  for await (const statement of readSqlStatements(path)) {
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
    if (!pending.trim()) return;
    const script = pending;
    pending = '';
    if (viaScript) {
      // SQLite / DuckDB 走整段脚本：几十万条 INSERT 逐条执行会阻塞事件循环十几分钟。
      await manager.execScript(connectionId, `BEGIN;\n${script}\nCOMMIT;`, { database, timeoutMs, actor: 'user' });
    } else {
      const batch = await manager.query(connectionId, script, { database, allowMulti: true, autoLimit: false, timeoutMs, actor: 'user' });
      sets.push(...batch.sets);
    }
  };
  pending = drops.length ? `${drops.join('\n')}\n` : '';
  for await (const statement of readSqlStatements(path)) {
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
