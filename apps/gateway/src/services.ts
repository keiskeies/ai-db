import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  buildCreateIndex,
  buildCreateTable,
  buildInsert,
  engineMeta,
  engineUsesSchema,
  isSqlEngine,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  type ColumnDef,
  type ConnectionConfig,
  type Engine,
  type IndexDef,
  type TableInfo,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { DbError } from './drivers';
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

export function sqlLiteral(value: unknown, engine: Engine): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return engine === 'postgresql' || engine === 'cockroachdb' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
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

export async function dumpDatabase(
  store: Store,
  manager: ConnectionManager,
  config: GatewayConfig,
  connectionId: string,
  database?: string,
  label?: string,
): Promise<{ path: string; bytes: number; tables: number; rows: number }> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const schemas = await manager.schema(connectionId, database, true);
  const driver = await manager.rawDriver(connectionId);
  const lines: string[] = [
    `-- AiDB Studio backup`,
    `-- connection: ${conn.name} (${conn.engine})`,
    `-- database: ${database ?? conn.database ?? ''}`,
    `-- created: ${new Date().toISOString()}`,
    '',
  ];
  let tableCount = 0;
  let rowCount = 0;
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
      lines.push(`-- table ${table.name}`);
      lines.push(buildCreateTable(conn.engine, { table: table.name, columns: columnDefs, indexes: [], schema: engineUsesSchema(conn.engine) ? table.schema : undefined }));
      for (const idx of indexes) {
        lines.push(buildCreateIndex(conn.engine, table.name, idx, engineUsesSchema(conn.engine) ? table.schema : undefined) + ';');
      }
      const target = quoteQualified([engineUsesSchema(conn.engine) ? table.schema : undefined, table.name], conn.engine);
      const result = await driver.run(`SELECT * FROM ${target}`, { database: conn.database });
      const names = result.columns.map((c) => c.name);
      for (let i = 0; i < result.rows.length; i += 300) {
        const chunk = result.rows.slice(i, i + 300);
        lines.push(toSqlInserts(conn.engine, table.name, names, chunk, engineUsesSchema(conn.engine) ? table.schema : undefined));
        rowCount += chunk.length;
      }
      lines.push('');
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = (database ?? conn.database ?? conn.name).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const path = join(config.backupDir, `${conn.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}-${safeName}-${stamp}.sql`);
  writeFileSync(path, lines.join('\n'), 'utf8');
  const bytes = statSync(path).size;
  store.addBackup({ connectionId, database, path, format: 'sql', bytes, label });
  return { path, bytes, tables: tableCount, rows: rowCount };
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
