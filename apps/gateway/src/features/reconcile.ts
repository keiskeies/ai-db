import {
  buildCount,
  engineMeta,
  quoteIdent,
  quoteQualified,
  type ConnectionConfig,
  type TableInfo,
} from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { sqlLiteral } from '../exportFormat';
import { connectionSchema } from './common';
import { throwIfAborted } from '../drivers/timeout';

export type ReconSourceKind = 'table' | 'keyspace' | 'documents';
export type ReconLevel = 'counts' | 'keys' | 'fields';

export interface ReconSourceSpec {
  kind: ReconSourceKind;
  connectionId: string;
  database?: string;
  table?: string;
  collection?: string;
  /** 文档源主键字段，默认 _id。 */
  idField?: string;
  schema?: string;
  keyColumns?: string[];
  keyPattern?: string;
  keyExtract?: string;
  valueType?: 'string' | 'hash' | 'json';
  fields?: string[];
  ttl?: 'ignore' | 'warn';
}

export interface ReconMapping {
  mode:
    | 'table-table'
    | 'table-keyspace'
    | 'keyspace-keyspace'
    | 'documents-documents'
    | 'table-documents'
    | 'documents-table'
    | 'keyspace-documents'
    | 'documents-keyspace';
  left: ReconSourceSpec;
  right: ReconSourceSpec;
  keyMap?: { left?: string; right?: string };
  fieldMap?: Array<{ left: string; right: string; normalize?: 'number' | 'string' | 'boolean' | 'timestamp' | 'json' }>;
  baseSide?: 'left' | 'right' | 'none';
  ignoreTtl?: boolean;
  maxKeys?: number;
}

export interface ReconDifference {
  key: string;
  status:
    | 'missing_in_right'
    | 'extra_in_right'
    | 'value_changed'
    | 'type_drift'
    | 'null_mismatch'
    | 'duplicate_key'
    | 'expired_during_scan';
  fields?: string[];
  left?: Record<string, unknown>;
  right?: Record<string, unknown>;
  detail?: string;
}

export interface ReconResult {
  summary: {
    targets: number;
    comparedKeys: number;
    missingInRight: number;
    extraInRight: number;
    valueChanged: number;
    typeDrift: number;
    nullMismatch: number;
    skippedKeys: number;
    truncated: boolean;
    /** True only when both sources and every requested record were fully compared. */
    comparisonComplete: boolean;
  };
  target: {
    left: string;
    right: string;
    key: string;
    counts: { left: number; right: number };
    differences: ReconDifference[];
    samples: ReconDifference[];
    scanned: { left: number; right: number };
  };
  level: ReconLevel;
  repair: string[];
  /** False means comparison coverage or repair output is incomplete; execution must refuse it. */
  repairComplete: boolean;
  repairNote?: string;
  notes: string[];
  generatedAt: string;
}

interface ResolvedSource {
  spec: ReconSourceSpec;
  conn: ConnectionConfig;
  table?: TableInfo;
  schema?: string;
  document?: boolean;
  count: number;
  keys: string[];
  rawKeys: Map<string, string>;
  keyValues: Map<string, unknown[]>;
  truncated: boolean;
  scanned: number;
  skipped: number;
  complete: boolean;
}

const clamp = (value: number | undefined, min: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

export const MAX_REPAIR_COMMANDS = 5000;

function unsupported(message: string): never {
  throw Object.assign(new Error(message), { code: 'RECON_UNSUPPORTED_TYPE', status: 400 });
}

function patternError(message: string): never {
  throw Object.assign(new Error(message), { code: 'RECON_KEY_PATTERN', status: 400 });
}

const NULL_KEY_PART = '\u0000null';
const ESCAPED_KEY_PART = '\u0000str:';

function keyPart(value: unknown): string {
  if (value === null || value === undefined) return NULL_KEY_PART;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString('base64')}`;
  const text = String(value);
  return text.startsWith('\u0000') ? `${ESCAPED_KEY_PART}${text}` : text;
}

function keyString(values: unknown[] | undefined): string {
  const parts = (values ?? []).map(keyPart);
  return parts.length === 1 ? parts[0] : JSON.stringify(parts);
}

function tableKeyPredicate(engine: ConnectionConfig['engine'], columns: string[], values: unknown[] | undefined): string {
  if (!values || values.length !== columns.length) {
    throw Object.assign(new Error('对账键值不完整，已拒绝生成修复或读取条件'), { code: 'RECON_KEY_VALUES_MISSING', status: 400 });
  }
  return columns.map((column, index) => {
    const value = values[index];
    return value === null || value === undefined
      ? `${quoteIdent(column, engine)} IS NULL`
      : `${quoteIdent(column, engine)} = ${sqlLiteral(value, engine)}`;
  }).join(' AND ');
}

function keyFromRedis(raw: string, extract?: string): string | undefined {
  if (!extract?.trim()) return raw;
  let regex: RegExp;
  try {
    regex = new RegExp(extract);
  } catch {
    patternError('keyExtract 不是合法正则');
  }
  const match = regex.exec(raw);
  if (!match) return undefined;
  return match[1] ?? match[0];
}

async function queryRows(
  manager: ConnectionManager,
  connectionId: string,
  sql: string,
  database: string | undefined,
  maxRows: number,
  signal?: AbortSignal,
  options: { allowTruncated?: boolean } = {},
): Promise<{ rows: unknown[][]; messages: string[]; columns: string[]; truncated: boolean }> {
  throwIfAborted(signal);
  const batch = await manager.query(connectionId, sql, {
    database,
    maxRows,
    allowMulti: false,
    autoLimit: false,
    actor: 'user',
    signal,
  });
  throwIfAborted(signal);
  const set = batch.sets[0];
  if (set?.columns?.some((column) => column.type?.toLowerCase() === 'binary')) {
    throw Object.assign(new Error('Redis 二进制值无法无损对账、备份或修复，已拒绝执行'), { code: 'RECON_UNSUPPORTED_BINARY', status: 400 });
  }
  const truncated = set?.truncated === true;
  if (truncated && !options.allowTruncated) throw Object.assign(new Error('对账读取被截断，无法保证结果完整'), { code: 'RECON_TRUNCATED', status: 400 });
  return { rows: set?.rows ?? [], messages: [...(batch.messages ?? []), ...(set?.messages ?? [])], columns: set?.columns?.map((column) => column.name) ?? [], truncated };
}

const REDIS_SCAN_PAGE_ROWS = 5000;

async function scanRedisKeys(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  spec: ReconSourceSpec,
  maxKeys: number,
  signal?: AbortSignal,
): Promise<{ keys: string[]; rawKeys: Map<string, string>; count: number; truncated: boolean; scanned: number; skipped: number; complete: boolean }> {
  throwIfAborted(signal);
  if (!spec.keyPattern?.trim()) patternError('Redis 键空间需要 keyPattern');
  const pattern = spec.keyPattern.trim();
  const unique = new Map<string, string>();
  const seenCursors = new Set(['0']);
  let cursor = '0';
  let scanned = 0;
  let skipped = 0;
  let capped = false;
  let incompletePage = false;
  let keyCollision = false;
  do {
    const { rows, messages, truncated: pageTruncated } = await queryRows(
      manager,
      conn.id,
      `SCAN ${cursor} MATCH ${pattern} COUNT 1000`,
      spec.database,
      REDIS_SCAN_PAGE_ROWS,
      signal,
      { allowTruncated: true },
    );
    throwIfAborted(signal);
    scanned += rows.length;
    for (const row of rows) {
      throwIfAborted(signal);
      if (typeof row[0] !== 'string') {
        skipped++;
        continue;
      }
      const raw = row[0];
      const logical = keyFromRedis(raw, spec.keyExtract);
      if (logical === undefined) {
        skipped++;
        continue;
      }
      if (unique.has(logical)) {
        keyCollision = true;
        continue;
      }
      if (unique.size >= maxKeys) {
        capped = true;
        break;
      }
      unique.set(logical, raw);
    }
    const found = messages.find((message) => message.startsWith('cursor='));
    const nextCursor = found?.slice('cursor='.length).trim();
    const validCursor = nextCursor !== undefined && /^\d+$/.test(nextCursor);
    // Redis drivers mark every non-terminal SCAN page as truncated. A short page is
    // still complete; a full page with that flag cannot prove no rows were sliced.
    if (!validCursor || (pageTruncated && (nextCursor === '0' || rows.length >= REDIS_SCAN_PAGE_ROWS))
      || (nextCursor !== undefined && nextCursor !== '0' && seenCursors.has(nextCursor))) {
      incompletePage = true;
      break;
    }
    cursor = nextCursor!;
    if (cursor !== '0') seenCursors.add(cursor);
    if (capped) break;
  } while (cursor !== '0' && unique.size < maxKeys);
  const keys = [...unique.keys()];
  const truncated = cursor !== '0' || unique.size >= maxKeys || incompletePage;
  return {
    keys,
    rawKeys: unique,
    count: keys.length,
    truncated,
    scanned,
    skipped,
    complete: !truncated && skipped === 0 && !keyCollision,
  };
}

function documentEngine(conn: ConnectionConfig): boolean {
  return conn.engine === 'mongodb' || conn.engine === 'elasticsearch' || conn.engine === 'opensearch';
}

function documentName(spec: ReconSourceSpec): string {
  return (spec.collection || spec.table || '').trim();
}

async function documentCount(manager: ConnectionManager, conn: ConnectionConfig, spec: ReconSourceSpec, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  const name = documentName(spec);
  if (!name) throw Object.assign(new Error('文档源缺少 collection / index'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
  if (conn.engine === 'mongodb') {
    const { rows } = await queryRows(manager, conn.id, JSON.stringify({ collection: name, op: 'count' }), spec.database, 1, signal);
    throwIfAborted(signal);
    return Number(rows[0]?.[0] ?? 0);
  }
  const { messages } = await queryRows(
    manager,
    conn.id,
    JSON.stringify({ index: name, body: { query: { match_all: {} }, size: 0 }, size: 0 }),
    spec.database,
    1,
    signal,
  );
  throwIfAborted(signal);
  const total = messages.find((message) => message.startsWith('total='));
  return total ? Number(total.slice('total='.length)) : 0;
}

async function scanDocumentKeys(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  spec: ReconSourceSpec,
  maxKeys: number,
  signal?: AbortSignal,
): Promise<{ keys: string[]; rawKeys: Map<string, string>; count: number; truncated: boolean; scanned: number; skipped: number; complete: boolean }> {
  throwIfAborted(signal);
  const name = documentName(spec);
  if (!name) throw Object.assign(new Error('文档源缺少 collection / index'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
  const idField = spec.idField || '_id';
  let rows: unknown[][] = [];
  let total = 0;
  if (conn.engine === 'mongodb') {
    const result = await queryRows(
      manager,
      conn.id,
      JSON.stringify({ collection: name, op: 'find', projection: { [idField]: 1 }, sort: { [idField]: 1 }, limit: maxKeys + 1 }),
      spec.database,
      maxKeys + 1,
      signal,
    );
    throwIfAborted(signal);
    rows = result.rows;
    total = await documentCount(manager, conn, spec, signal);
  } else {
    const result = await queryRows(
      manager,
      conn.id,
      JSON.stringify({ index: name, body: { query: { match_all: {} }, _source: false, sort: ['_doc'] }, size: maxKeys + 1 }),
      spec.database,
      maxKeys + 1,
      signal,
    );
    throwIfAborted(signal);
    rows = result.rows;
    const totalMessage = result.messages.find((message) => message.startsWith('total='));
    total = totalMessage ? Number(totalMessage.slice('total='.length)) : Number.NaN;
  }
  const rawKeys = new Map<string, string>();
  let skipped = 0;
  let keyCollision = false;
  for (const row of rows.slice(0, maxKeys)) {
    throwIfAborted(signal);
    const id = String(row[0] ?? '');
    if (!id) {
      skipped++;
      continue;
    }
    if (rawKeys.has(id)) {
      keyCollision = true;
      continue;
    }
    rawKeys.set(id, id);
  }
  const validTotal = Number.isSafeInteger(total) && total >= 0;
  const truncated = total > maxKeys || rows.length > maxKeys;
  return {
    keys: [...rawKeys.keys()],
    rawKeys,
    count: validTotal ? total : rawKeys.size,
    truncated,
    scanned: rows.length,
    skipped,
    complete: !truncated && skipped === 0 && !keyCollision && validTotal && total === rawKeys.size && rows.length === rawKeys.size,
  };
}

async function readDocumentRecords(
  manager: ConnectionManager,
  source: ResolvedSource,
  keys: string[],
  fields: string[],
  signal?: AbortSignal,
): Promise<Map<string, Record<string, unknown>>> {
  throwIfAborted(signal);
  const name = documentName(source.spec);
  const idField = source.spec.idField || '_id';
  const out = new Map<string, Record<string, unknown>>();
  if (!name || !keys.length) return out;
  if (source.conn.engine === 'mongodb') {
    const projection: Record<string, 1> = { [idField]: 1 };
    for (const field of fields) projection[field] = 1;
    const { rows, columns } = await queryRows(
      manager,
      source.conn.id,
      JSON.stringify({ collection: name, op: 'find', filter: { [idField]: { $in: keys } }, projection, limit: keys.length }),
      source.spec.database,
      keys.length,
      signal,
    );
    throwIfAborted(signal);
    for (const row of rows) {
      throwIfAborted(signal);
      const record: Record<string, unknown> = {};
      const idIndex = columns.indexOf(idField);
      const key = String(row[idIndex >= 0 ? idIndex : 0] ?? '');
      fields.forEach((field) => {
        const index = columns.indexOf(field);
        record[field] = row[index >= 0 ? index : 0];
      });
      out.set(key, record);
    }
    return out;
  }
  const { rows, columns } = await queryRows(
    manager,
    source.conn.id,
    JSON.stringify({ index: name, body: { query: { ids: { values: keys } }, ...(fields.length ? { _source: fields } : {}) }, size: keys.length }),
    source.spec.database,
    keys.length,
    signal,
  );
  throwIfAborted(signal);
  for (const row of rows) {
    throwIfAborted(signal);
    const key = String(row[columns.indexOf('_id') >= 0 ? columns.indexOf('_id') : 0] ?? '');
    const record: Record<string, unknown> = {};
    fields.forEach((field) => {
      const index = columns.indexOf(field);
      record[field] = row[index >= 0 ? index : 0];
    });
    out.set(key, record);
  }
  return out;
}

async function resolveSource(
  store: Store,
  manager: ConnectionManager,
  spec: ReconSourceSpec,
  maxKeys: number,
  needKeys: boolean,
  signal?: AbortSignal,
): Promise<ResolvedSource> {
  throwIfAborted(signal);
  const conn = store.getConnection(spec.connectionId);
  if (!conn) throw Object.assign(new Error(`连接不存在：${spec.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
  if (spec.kind === 'documents') {
    if (!documentEngine(conn)) unsupported(`${conn.engine} 不支持以文档源的方式对账`);
    if (!documentName(spec)) throw Object.assign(new Error('文档源缺少 collection / index'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
    const idField = spec.idField || '_id';
    let result;
    if (needKeys) {
      result = await scanDocumentKeys(manager, conn, spec, maxKeys, signal);
    } else {
      const count = await documentCount(manager, conn, spec, signal);
      result = { keys: [], rawKeys: new Map<string, string>(), count, truncated: false, scanned: 0, skipped: 0, complete: Number.isSafeInteger(count) && count >= 0 };
    }
    return { spec: { ...spec, idField, keyColumns: [idField] }, conn, document: true, keyValues: new Map(), ...result };
  }
  if (spec.kind === 'table') {
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      unsupported(`${conn.engine} 不支持以表的方式对账`);
    }
    if (!spec.table?.trim()) throw Object.assign(new Error('缺少表名'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
    const schemas = await manager.schema(conn.id, spec.database, true, undefined, { signal });
    throwIfAborted(signal);
    const table = schemas.flatMap((schema) => schema.tables).find((item) => item.name.toLowerCase() === spec.table!.trim().toLowerCase());
    if (!table) throw Object.assign(new Error(`表不存在：${spec.table}`), { code: 'RECON_UNSUPPORTED_TYPE', status: 404 });
    const schema = connectionSchema(conn, table);
    const countRows = await queryRows(manager, conn.id, buildCount(conn.engine, table.name, schema), spec.database, 1, signal);
    throwIfAborted(signal);
    const count = Number(countRows.rows[0]?.[0] ?? 0);
    const keyColumns = spec.keyColumns?.length
      ? spec.keyColumns
      : (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
    if (!keyColumns.length || !needKeys) {
      return { spec: { ...spec, keyColumns }, conn, table, schema, count, keys: [], rawKeys: new Map(), keyValues: new Map(), truncated: false, scanned: 0, skipped: 0, complete: Number.isSafeInteger(count) && count >= 0 };
    }
    const columnsSql = keyColumns.map((column) => quoteIdent(column, conn.engine)).join(', ');
    const tableSql = quoteQualified([schema, table.name], conn.engine);
    const orderSql = keyColumns.map((column) => quoteIdent(column, conn.engine)).join(', ');
    const { rows } = await queryRows(manager, conn.id, `SELECT ${columnsSql} FROM ${tableSql} ORDER BY ${orderSql}`, spec.database, maxKeys + 1, signal);
    throwIfAborted(signal);
    const rawKeys = new Map<string, string>();
    const keyValues = new Map<string, unknown[]>();
    let keyCollision = false;
    for (const row of rows.slice(0, maxKeys)) {
      throwIfAborted(signal);
      const logical = keyString(row);
      if (rawKeys.has(logical)) keyCollision = true;
      rawKeys.set(logical, logical);
      keyValues.set(logical, row);
    }
    const truncated = count > maxKeys || rows.length > maxKeys;
    return {
      spec: { ...spec, keyColumns },
      conn,
      table,
      schema,
      count,
      keys: [...rawKeys.keys()],
      rawKeys,
      keyValues,
      truncated,
      scanned: rows.length,
      skipped: 0,
      complete: Number.isSafeInteger(count) && count >= 0 && !truncated && !keyCollision && count === rawKeys.size && rows.length === rawKeys.size,
    };
  }

  if (conn.engine !== 'redis') unsupported(`${conn.engine} 不支持以键空间的方式对账`);
  const result = await scanRedisKeys(manager, conn, spec, maxKeys, signal);
  return { spec, conn, keyValues: new Map(), ...result };
}

function fieldList(left: ResolvedSource, right: ResolvedSource, mapping: ReconMapping): Array<{ left: string; right: string }> {
  if (mapping.fieldMap?.length) return mapping.fieldMap;
  if (left.spec.kind === 'keyspace' && right.spec.kind === 'keyspace'
    && (left.spec.valueType ?? 'string') === 'string' && (right.spec.valueType ?? 'string') === 'string') {
    return [{ left: 'value', right: 'value' }];
  }
  const leftFields = left.table?.columns?.map((column) => column.name) ?? left.spec.fields ?? [];
  const rightFields = right.table?.columns?.map((column) => column.name) ?? right.spec.fields ?? [];
  const rightSet = new Set(rightFields.map((field) => field.toLowerCase()));
  return leftFields.filter((field) => rightSet.has(field.toLowerCase())).map((field) => ({ left: field, right: field }));
}

async function readTableRecords(
  manager: ConnectionManager,
  source: ResolvedSource,
  keys: string[],
  fields: string[],
  signal?: AbortSignal,
): Promise<Map<string, Record<string, unknown>>> {
  throwIfAborted(signal);
  if (!source.table || !source.conn) return new Map();
  const columns = [...new Set([...(source.spec.keyColumns ?? []), ...fields])];
  if (!columns.length) return new Map();
  const engine = source.conn.engine;
  const tableSql = quoteQualified([source.schema, source.table.name], engine);
  const selectSql = columns.map((column) => quoteIdent(column, engine)).join(', ');
  const keyColumns = source.spec.keyColumns ?? [];
  const rowsOut = new Map<string, Record<string, unknown>>();
  const chunks: string[][] = [];
  for (let index = 0; index < keys.length; index += 400) chunks.push(keys.slice(index, index + 400));
  for (const chunk of chunks) {
    throwIfAborted(signal);
    const conditions = chunk.map((key) => `(${tableKeyPredicate(engine, keyColumns, source.keyValues.get(key))})`);
    const where = conditions.join(' OR ');
    const { rows } = await queryRows(manager, source.conn.id, `SELECT ${selectSql} FROM ${tableSql} WHERE ${where}`, source.spec.database, Math.max(1, chunk.length * 2), signal);
    throwIfAborted(signal);
    for (const row of rows) {
      throwIfAborted(signal);
      const key = keyString(row.slice(0, keyColumns.length));
      const record: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        record[column] = row[index];
      });
      rowsOut.set(key, record);
    }
  }
  return rowsOut;
}

function readJsonPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$.')) return (value as Record<string, unknown>)?.[path];
  return path
    .slice(2)
    .split('.')
    .reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);
}

async function readRedisRecords(
  manager: ConnectionManager,
  source: ResolvedSource,
  keys: string[],
  fields: string[],
  signal?: AbortSignal,
): Promise<Map<string, Record<string, unknown>>> {
  throwIfAborted(signal);
  const out = new Map<string, Record<string, unknown>>();
  const type = source.spec.valueType ?? 'string';
  const rawKeys = keys.map((key) => source.rawKeys.get(key) ?? key);
  for (const raw of rawKeys) {
    throwIfAborted(signal);
    const { rows } = await queryRows(manager, source.conn.id, `TYPE ${quoteRedis(raw)}`, source.spec.database, 1, signal);
    throwIfAborted(signal);
    const actual = String(rows[0]?.[0] ?? 'none');
    if (actual === 'none') continue;
    if (type === 'hash' && actual !== 'hash') {
      throw Object.assign(new Error(`Redis 键 ${raw} 的实际类型是 ${actual}，不是 hash`), {
        code: 'RECON_UNSUPPORTED_TYPE',
        status: 400,
      });
    }
    if ((type === 'string' || type === 'json') && actual !== 'string') {
      throw Object.assign(new Error(`Redis 键 ${raw} 的实际类型是 ${actual}，不是 string`), {
        code: 'RECON_UNSUPPORTED_TYPE',
        status: 400,
      });
    }
  }
  if (type === 'hash') {
    for (let index = 0; index < rawKeys.length; index++) {
      throwIfAborted(signal);
      const raw = rawKeys[index];
      const logical = keys[index];
      const { rows } = await queryRows(manager, source.conn.id, `HGETALL ${quoteRedis(raw)}`, source.spec.database, 5000, signal);
      throwIfAborted(signal);
      const record: Record<string, unknown> = {};
      for (const row of rows) record[String(row[0])] = row[1];
      out.set(logical, record);
    }
    return out;
  }
  for (let index = 0; index < rawKeys.length; index += 100) {
    throwIfAborted(signal);
    const batch = rawKeys.slice(index, index + 100);
    const { rows } = await queryRows(manager, source.conn.id, `MGET ${batch.map(quoteRedis).join(' ')}`, source.spec.database, batch.length, signal);
    throwIfAborted(signal);
    batch.forEach((raw, offset) => {
      throwIfAborted(signal);
      const logical = keys[index + offset];
      const value = rows[offset]?.[0];
      if (value === null || value === undefined) return;
      if (type === 'json') {
        let parsed: unknown = value;
        if (typeof value === 'string') {
          try {
            parsed = JSON.parse(value);
          } catch {
            parsed = undefined;
          }
        }
        const record: Record<string, unknown> = {};
        for (const field of fields) record[field] = readJsonPath(parsed, field);
        out.set(logical, record);
      } else {
        out.set(logical, { value });
      }
    });
  }
  return out;
}

async function readRecords(
  manager: ConnectionManager,
  source: ResolvedSource,
  keys: string[],
  fields: string[],
  signal?: AbortSignal,
): Promise<Map<string, Record<string, unknown>>> {
  throwIfAborted(signal);
  if (source.spec.kind === 'table') return readTableRecords(manager, source, keys, fields, signal);
  if (source.spec.kind === 'documents') return readDocumentRecords(manager, source, keys, fields, signal);
  return readRedisRecords(manager, source, keys, fields, signal);
}

function normalizeValue(value: unknown, mode?: string): unknown {
  if (value === undefined || value === null) return null;
  if (mode === 'number') return Number(value);
  if (mode === 'boolean') return value === true || value === 'true' || value === '1' || value === 1;
  if (mode === 'timestamp') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (mode === 'json') {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
  return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left);
    const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  if (typeof left === 'object' && typeof right === 'object') return JSON.stringify(left) === JSON.stringify(right);
  return String(left) === String(right);
}

function compareRecord(
  key: string,
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
  fields: Array<{ left: string; right: string; normalize?: string }>,
): ReconDifference | undefined {
  if (!left && !right) return undefined;
  if (!left) return { key, status: 'missing_in_right' };
  if (!right) return { key, status: 'extra_in_right' };
  const changed: string[] = [];
  let typeDrift = false;
  let nullMismatch = false;
  for (const field of fields) {
    const l = normalizeValue(left[field.left], field.normalize);
    const r = normalizeValue(right[field.right], field.normalize);
    if (valuesEqual(l, r)) {
      if (l !== null && r !== null && typeof l !== typeof r) typeDrift = true;
      continue;
    }
    if (l === null || r === null) nullMismatch = true;
    changed.push(field.left);
  }
  if (changed.length) {
    return {
      key,
      status: nullMismatch ? 'null_mismatch' : 'value_changed',
      fields: changed,
      left: Object.fromEntries(fields.filter((field) => changed.includes(field.left)).map((field) => [field.left, left[field.left]])),
      right: Object.fromEntries(fields.filter((field) => changed.includes(field.left)).map((field) => [field.right, right[field.right]])),
    };
  }
  if (typeDrift) return { key, status: 'type_drift' };
  return undefined;
}

function repairPlan(
  left: ResolvedSource,
  right: ResolvedSource,
  differences: ReconDifference[],
  fields: Array<{ left: string; right: string }>,
  baseSide: 'left' | 'right' | 'none' | undefined,
): { repair: string[]; note?: string; complete: boolean } {
  if (!baseSide || baseSide === 'none') return { repair: [], note: '未选择基准侧，只展示差异，不生成写命令。', complete: true };
  if (baseSide === 'right') return { repair: [], note: '以右侧为基准的修复在 v1 暂不生成，请交换左右源后重跑。', complete: false };
  const repair: string[] = [];
  let complete = true;
  let capped = false;
  const push = (command: string): void => {
    if (repair.length >= MAX_REPAIR_COMMANDS) {
      complete = false;
      capped = true;
      return;
    }
    repair.push(command);
  };
  if (right.spec.kind === 'table' && right.table && right.conn) {
    const engine = right.conn.engine;
    const table = quoteQualified([right.schema, right.table.name], engine);
    const keyColumns = right.spec.keyColumns ?? [];
    for (const diff of differences) {
      if (capped) break;
      const before = repair.length;
      if (diff.status === 'missing_in_right' && diff.left) {
        const leftRecord = diff.left;
        const leftKeys = left.spec.keyColumns ?? [];
        const insertFields = [
          ...keyColumns.map((column, index) => ({ right: column, value: left.keyValues.get(diff.key)?.[index] ?? leftRecord[leftKeys[index] ?? ''] })),
          ...fields.filter((field) => !keyColumns.some((column) => column.toLowerCase() === field.right.toLowerCase())).map((field) => ({ right: field.right, value: leftRecord[field.left] })),
        ];
        if (insertFields.length) {
          const rightNames = insertFields.map((field) => quoteIdent(field.right, engine)).join(', ');
          const values = insertFields.map((field) => sqlLiteral(field.value, engine)).join(', ');
          push(`INSERT INTO ${table} (${rightNames}) VALUES (${values});`);
        }
      } else if (diff.status === 'extra_in_right' && right.table) {
        const where = tableKeyPredicate(engine, keyColumns, right.keyValues.get(diff.key));
        if (where) push(`DELETE FROM ${table} WHERE ${where};`);
      } else if (diff.left && diff.right) {
        const leftRecord = diff.left;
        const set = fields
          .filter((field) => diff.fields?.includes(field.left))
          .map((field) => `${quoteIdent(field.right, engine)} = ${sqlLiteral(leftRecord[field.left], engine)}`)
          .join(', ');
        const where = tableKeyPredicate(engine, keyColumns, right.keyValues.get(diff.key));
        if (set && where) push(`UPDATE ${table} SET ${set} WHERE ${where};`);
      }
      if (repair.length === before) complete = false;
    }
    return {
      repair,
      complete,
      note: [
        complete ? '修复命令基于左侧基准生成，执行前必须备份并人工确认。' : '部分差异无法生成修复命令，计划不完整，已拒绝自动执行。',
        capped ? `修复命令达到上限 ${MAX_REPAIR_COMMANDS}，后续步骤已省略。` : '',
      ].filter(Boolean).join(' '),
    };
  }
  if (right.spec.kind === 'keyspace') {
    const valueType = right.spec.valueType ?? 'string';
    let jsonRepairSkipped = false;
    for (const diff of differences) {
      if (capped) break;
      const before = repair.length;
      const raw = quoteRedis(right.rawKeys.get(diff.key) ?? rawRedisKey(right.spec, diff.key));
      if (diff.status === 'missing_in_right' && diff.left) {
        if (valueType === 'hash') {
          for (const field of fields) {
            const value = diff.left[field.left];
            push(value === null || value === undefined ? `HDEL ${raw} ${quoteRedis(field.right)}` : `HSET ${raw} ${quoteRedis(field.right)} ${quoteRedis(value)}`);
          }
        } else if (valueType === 'string') {
          const field = fields[0]?.left ?? 'value';
          const value = diff.left[field];
          if (value !== null && value !== undefined) push(`SET ${raw} ${quoteRedis(value)}`);
          else complete = false;
        } else {
          jsonRepairSkipped = true;
          complete = false;
        }
      } else if (diff.status === 'extra_in_right') {
        push(`DEL ${raw}`);
      } else if (diff.left) {
        if (valueType === 'hash') {
          for (const field of fields.filter((item) => diff.fields?.includes(item.left))) {
            const value = diff.left[field.left];
            push(value === null || value === undefined ? `HDEL ${raw} ${quoteRedis(field.right)}` : `HSET ${raw} ${quoteRedis(field.right)} ${quoteRedis(value)}`);
          }
        } else if (valueType === 'string') {
          const field = fields[0]?.left ?? 'value';
          const value = diff.left[field];
          if (value !== null && value !== undefined) push(`SET ${raw} ${quoteRedis(value)}`);
          else complete = false;
        } else {
          jsonRepairSkipped = true;
          complete = false;
        }
      }
      if (repair.length === before) complete = false;
    }
    return {
      repair,
      complete,
      note: [
        jsonRepairSkipped
          ? 'Redis JSON 字段差异无法安全重建完整文档，已跳过自动修复；请人工核对后写入完整 JSON。'
          : complete
            ? 'Redis 修复命令基于左侧基准生成，执行前会完整快照并人工确认。'
            : '部分 Redis 差异无法生成修复命令，计划不完整，已拒绝自动执行。',
        capped ? `修复命令达到上限 ${MAX_REPAIR_COMMANDS}，后续步骤已省略。` : '',
      ].filter(Boolean).join(' '),
    };
  }
  void left;
  return { repair: [], note: '当前源组合暂不支持生成修复命令。', complete: false };
}

function rawRedisKey(spec: ReconSourceSpec, logical: string): string {
  if (spec.keyPattern?.includes('*')) return spec.keyPattern.replace('*', logical);
  return logical;
}

function quoteRedis(value: unknown): string {
  if (value === undefined || value === null) return '""';
  if (value instanceof Uint8Array) {
    throw Object.assign(new Error('Redis 二进制值无法无损对账、备份或修复，已拒绝执行'), { code: 'RECON_UNSUPPORTED_BINARY', status: 400 });
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object' || Array.isArray(value)) return JSON.stringify(JSON.stringify(value));
  return JSON.stringify(String(value));
}

export async function reconcileData(
  store: Store,
  manager: ConnectionManager,
  mapping: ReconMapping,
  level: ReconLevel,
  signal?: AbortSignal,
): Promise<ReconResult> {
  throwIfAborted(signal);
  const maxKeys = clamp(mapping.maxKeys ?? 200_000, 1, 200_000);
  const left = await resolveSource(store, manager, mapping.left, maxKeys, level !== 'counts', signal);
  throwIfAborted(signal);
  const right = await resolveSource(store, manager, mapping.right, maxKeys, level !== 'counts', signal);
  throwIfAborted(signal);
  if (level !== 'counts') {
    const leftKeyColumns = left.spec.keyColumns ?? [];
    const rightKeyColumns = right.spec.keyColumns ?? [];
    if (left.spec.kind === 'table' && !leftKeyColumns.length) throw Object.assign(new Error('左侧没有主键，请指定业务键'), { code: 'RECON_NO_KEY', status: 400 });
    if (right.spec.kind === 'table' && !rightKeyColumns.length) throw Object.assign(new Error('右侧没有主键，请指定业务键'), { code: 'RECON_NO_KEY', status: 400 });
    if (left.spec.kind === 'keyspace' && !left.spec.keyPattern?.trim()) patternError('左侧键空间缺少键匹配规则');
    if (right.spec.kind === 'keyspace' && !right.spec.keyPattern?.trim()) patternError('右侧键空间缺少键匹配规则');
  }

  const differences: ReconDifference[] = [];
  const leftKeys = new Map(left.keys.map((key) => [key, key]));
  const rightKeys = new Map(right.keys.map((key) => [key, key]));
  let missingInRight = 0;
  let extraInRight = 0;
  for (const key of leftKeys.keys()) {
    throwIfAborted(signal);
    if (!rightKeys.has(key)) {
      missingInRight++;
      differences.push({ key, status: 'missing_in_right' });
    }
  }
  for (const key of rightKeys.keys()) {
    throwIfAborted(signal);
    if (!leftKeys.has(key)) {
      extraInRight++;
      differences.push({ key, status: 'extra_in_right' });
    }
  }

  let valueChanged = 0;
  let typeDrift = 0;
  let nullMismatch = 0;
  let comparisonComplete = left.complete && right.complete;
  let recordsComplete = true;
  const fields = fieldList(left, right, mapping);
  if (level === 'fields' && fields.length === 0) comparisonComplete = false;
  if (level !== 'counts' && mapping.baseSide === 'left') {
    const missing = differences.filter((diff) => diff.status === 'missing_in_right');
    for (let index = 0; index < missing.length; index += 500) {
      throwIfAborted(signal);
      const batch = missing.slice(index, index + 500);
      const records = await readRecords(manager, left, batch.map((diff) => diff.key), fields.map((field) => field.left), signal);
      throwIfAborted(signal);
      if (batch.some((diff) => !records.has(diff.key))) recordsComplete = false;
      for (const diff of batch) diff.left = records.get(diff.key);
    }
  }
  if (level !== 'counts' && leftKeys.size && rightKeys.size) {
    const matched = [...leftKeys.keys()].filter((key) => rightKeys.has(key));
    const leftFields = fields.map((field) => field.left);
    const rightFields = fields.map((field) => field.right);
    for (let index = 0; index < matched.length; index += 500) {
      throwIfAborted(signal);
      const batch = matched.slice(index, index + 500);
      const [leftRecords, rightRecords] = await Promise.all([
        readRecords(manager, left, batch, leftFields, signal),
        readRecords(manager, right, batch, rightFields, signal),
      ]);
      throwIfAborted(signal);
      if (batch.some((key) => !leftRecords.has(key) || !rightRecords.has(key))) recordsComplete = false;
      for (const key of batch) {
        throwIfAborted(signal);
        const diff = compareRecord(key, leftRecords.get(key), rightRecords.get(key), fields);
        if (!diff) continue;
        if (diff.status === 'value_changed') valueChanged++;
        else if (diff.status === 'type_drift') typeDrift++;
        else if (diff.status === 'null_mismatch') nullMismatch++;
        differences.push(diff);
      }
    }
  }

  comparisonComplete = comparisonComplete && recordsComplete;
  const summary = {
    targets: 1,
    comparedKeys: Math.min(left.keys.length, right.keys.length),
    missingInRight,
    extraInRight,
    valueChanged,
    typeDrift,
    nullMismatch,
    skippedKeys: left.skipped + right.skipped,
    truncated: left.truncated || right.truncated,
    comparisonComplete,
  };
  throwIfAborted(signal);
  const repair = level === 'counts'
    ? { repair: [], note: '数量级对账不生成修复命令。', complete: true }
    : repairPlan(left, right, differences, fields, mapping.baseSide);
  throwIfAborted(signal);
  return {
    summary,
    target: {
      left:
        left.spec.kind === 'table'
          ? `${left.conn.name}.${left.spec.table}`
          : left.spec.kind === 'documents'
            ? `${left.conn.name}:${documentName(left.spec)}`
            : `${left.conn.name}:${left.spec.keyPattern}`,
      right:
        right.spec.kind === 'table'
          ? `${right.conn.name}.${right.spec.table}`
          : right.spec.kind === 'documents'
            ? `${right.conn.name}:${documentName(right.spec)}`
            : `${right.conn.name}:${right.spec.keyPattern}`,
      key:
        left.spec.kind === 'table'
          ? (left.spec.keyColumns ?? []).join('+')
          : left.spec.kind === 'documents'
            ? (left.spec.idField ?? '_id')
            : left.spec.keyExtract ?? 'key',
      counts: { left: left.count, right: right.count },
      differences: differences.slice(0, 5000),
      samples: differences.slice(0, 20),
      scanned: { left: left.scanned, right: right.scanned },
    },
    level,
    repair: repair.repair,
    repairComplete: comparisonComplete && repair.complete,
    repairNote: [
      repair.note,
      comparisonComplete ? '' : '对账覆盖不完整，仅可用于只读核对；修复计划已禁用。',
    ].filter(Boolean).join(' '),
    notes: [
      ...(left.truncated || right.truncated ? [`扫描达到上限 ${maxKeys} 或未能完整结束，结果可能不完整。`] : []),
      ...(left.skipped || right.skipped ? [`${left.skipped + right.skipped} 个键无法提取或读取，已跳过。`] : []),
      ...(!comparisonComplete ? ['对账覆盖不完整，仅可用于只读核对；修复计划已禁用。'] : []),
    ],
    generatedAt: new Date().toISOString(),
  };
}
