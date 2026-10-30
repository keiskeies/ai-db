import {
  buildCount,
  engineMeta,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  type ConnectionConfig,
  type TableInfo,
} from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';

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
  truncated: boolean;
  scanned: number;
  skipped: number;
}

const clamp = (value: number | undefined, min: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

function unsupported(message: string): never {
  throw Object.assign(new Error(message), { code: 'RECON_UNSUPPORTED_TYPE', status: 400 });
}

function patternError(message: string): never {
  throw Object.assign(new Error(message), { code: 'RECON_KEY_PATTERN', status: 400 });
}

function keyString(values: unknown[] | undefined): string {
  return (values ?? []).map((value) => (value === null || value === undefined ? '' : String(value).trim())).join('\u0000');
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
): Promise<{ rows: unknown[][]; messages: string[]; columns: string[] }> {
  const batch = await manager.query(connectionId, sql, {
    database,
    maxRows,
    allowMulti: false,
    autoLimit: false,
    actor: 'user',
  });
  const set = batch.sets[0];
  return { rows: set?.rows ?? [], messages: [...(batch.messages ?? []), ...(set?.messages ?? [])], columns: set?.columns?.map((column) => column.name) ?? [] };
}

async function scanRedisKeys(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  spec: ReconSourceSpec,
  maxKeys: number,
): Promise<{ keys: string[]; rawKeys: Map<string, string>; count: number; truncated: boolean; scanned: number; skipped: number }> {
  if (!spec.keyPattern?.trim()) patternError('Redis 键空间需要 keyPattern');
  const pattern = spec.keyPattern.trim();
  const unique = new Map<string, string>();
  let cursor = '0';
  let scanned = 0;
  let skipped = 0;
  do {
    const { rows, messages } = await queryRows(
      manager,
      conn.id,
      `SCAN ${cursor} MATCH ${pattern} COUNT 1000`,
      spec.database,
      1000,
    );
    scanned += rows.length;
    for (const row of rows) {
      const raw = String(row[0] ?? '');
      if (!raw) continue;
      const logical = keyFromRedis(raw, spec.keyExtract);
      if (logical === undefined) {
        skipped++;
        continue;
      }
      if (!unique.has(logical)) unique.set(logical, raw);
      if (unique.size >= maxKeys) break;
    }
    const found = messages.find((message) => message.startsWith('cursor='));
    cursor = found ? found.slice('cursor='.length) : '0';
  } while (cursor !== '0' && unique.size < maxKeys);
  const keys = [...unique.keys()];
  return {
    keys,
    rawKeys: unique,
    count: keys.length,
    truncated: cursor !== '0' || unique.size >= maxKeys,
    scanned,
    skipped,
  };
}

function documentEngine(conn: ConnectionConfig): boolean {
  return conn.engine === 'mongodb' || conn.engine === 'elasticsearch' || conn.engine === 'opensearch';
}

function documentName(spec: ReconSourceSpec): string {
  return (spec.collection || spec.table || '').trim();
}

async function documentCount(manager: ConnectionManager, conn: ConnectionConfig, spec: ReconSourceSpec): Promise<number> {
  const name = documentName(spec);
  if (!name) throw Object.assign(new Error('文档源缺少 collection / index'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
  if (conn.engine === 'mongodb') {
    const { rows } = await queryRows(manager, conn.id, JSON.stringify({ collection: name, op: 'count' }), spec.database, 1);
    return Number(rows[0]?.[0] ?? 0);
  }
  const { messages } = await queryRows(
    manager,
    conn.id,
    JSON.stringify({ index: name, body: { query: { match_all: {} }, size: 0 }, size: 0 }),
    spec.database,
    1,
  );
  const total = messages.find((message) => message.startsWith('total='));
  return total ? Number(total.slice('total='.length)) : 0;
}

async function scanDocumentKeys(
  manager: ConnectionManager,
  conn: ConnectionConfig,
  spec: ReconSourceSpec,
  maxKeys: number,
): Promise<{ keys: string[]; rawKeys: Map<string, string>; count: number; truncated: boolean; scanned: number; skipped: number }> {
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
    );
    rows = result.rows;
    total = await documentCount(manager, conn, spec);
  } else {
    const result = await queryRows(
      manager,
      conn.id,
      JSON.stringify({ index: name, body: { query: { match_all: {} }, _source: false, sort: ['_doc'] }, size: maxKeys + 1 }),
      spec.database,
      maxKeys + 1,
    );
    rows = result.rows;
    const totalMessage = result.messages.find((message) => message.startsWith('total='));
    total = totalMessage ? Number(totalMessage.slice('total='.length)) : rows.length;
  }
  const rawKeys = new Map<string, string>();
  for (const row of rows.slice(0, maxKeys)) {
    const id = String(row[0] ?? '');
    if (id) rawKeys.set(id, id);
  }
  return {
    keys: [...rawKeys.keys()],
    rawKeys,
    count: total || rawKeys.size,
    truncated: total > maxKeys || rows.length > maxKeys,
    scanned: rows.length,
    skipped: 0,
  };
}

async function readDocumentRecords(
  manager: ConnectionManager,
  source: ResolvedSource,
  keys: string[],
  fields: string[],
): Promise<Map<string, Record<string, unknown>>> {
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
    );
    for (const row of rows) {
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
  );
  for (const row of rows) {
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
): Promise<ResolvedSource> {
  const conn = store.getConnection(spec.connectionId);
  if (!conn) throw Object.assign(new Error(`连接不存在：${spec.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
  if (spec.kind === 'documents') {
    if (!documentEngine(conn)) unsupported(`${conn.engine} 不支持以文档源的方式对账`);
    if (!documentName(spec)) throw Object.assign(new Error('文档源缺少 collection / index'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
    const idField = spec.idField || '_id';
    const result = needKeys
      ? await scanDocumentKeys(manager, conn, spec, maxKeys)
      : { keys: [], rawKeys: new Map(), count: await documentCount(manager, conn, spec), truncated: false, scanned: 0, skipped: 0 };
    return { spec: { ...spec, idField, keyColumns: [idField] }, conn, document: true, ...result };
  }
  if (spec.kind === 'table') {
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      unsupported(`${conn.engine} 不支持以表的方式对账`);
    }
    if (!spec.table?.trim()) throw Object.assign(new Error('缺少表名'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
    const schemas = await manager.schema(conn.id, spec.database, true);
    const table = schemas.flatMap((schema) => schema.tables).find((item) => item.name.toLowerCase() === spec.table!.trim().toLowerCase());
    if (!table) throw Object.assign(new Error(`表不存在：${spec.table}`), { code: 'RECON_UNSUPPORTED_TYPE', status: 404 });
    const schema = connectionSchema(conn, table);
    const countRows = await queryRows(manager, conn.id, buildCount(conn.engine, table.name, schema), spec.database, 1);
    const count = Number(countRows.rows[0]?.[0] ?? 0);
    const keyColumns = spec.keyColumns?.length
      ? spec.keyColumns
      : (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
    if (!keyColumns.length || !needKeys) {
      return { spec: { ...spec, keyColumns }, conn, table, schema, count, keys: [], rawKeys: new Map(), truncated: false, scanned: 0, skipped: 0 };
    }
    const columnsSql = keyColumns.map((column) => quoteIdent(column, conn.engine)).join(', ');
    const tableSql = quoteQualified([schema, table.name], conn.engine);
    const orderSql = keyColumns.map((column) => quoteIdent(column, conn.engine)).join(', ');
    const { rows } = await queryRows(manager, conn.id, `SELECT ${columnsSql} FROM ${tableSql} ORDER BY ${orderSql}`, spec.database, maxKeys + 1);
    const rawKeys = new Map<string, string>();
    for (const row of rows.slice(0, maxKeys)) {
      const logical = keyString(row);
      if (logical) rawKeys.set(logical, logical);
    }
    return {
      spec: { ...spec, keyColumns },
      conn,
      table,
      schema,
      count,
      keys: [...rawKeys.keys()],
      rawKeys,
      truncated: count > maxKeys || rows.length > maxKeys,
      scanned: rows.length,
      skipped: 0,
    };
  }

  if (conn.engine !== 'redis') unsupported(`${conn.engine} 不支持以键空间的方式对账`);
  const result = await scanRedisKeys(manager, conn, spec, maxKeys);
  return { spec, conn, ...result };
}

function fieldList(left: ResolvedSource, right: ResolvedSource, mapping: ReconMapping): Array<{ left: string; right: string }> {
  if (mapping.fieldMap?.length) return mapping.fieldMap;
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
): Promise<Map<string, Record<string, unknown>>> {
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
    const conditions = chunk.map((key) => {
      const parts = key.split('\u0000');
      if (keyColumns.length === 1) return `${quoteIdent(keyColumns[0], engine)} = ${quoteLiteral(parts[0] ?? '')}`;
      return `(${keyColumns.map((column, i) => `${quoteIdent(column, engine)} = ${quoteLiteral(parts[i] ?? '')}`).join(' AND ')})`;
    });
    const where = keyColumns.length === 1 && chunk.length ? `${quoteIdent(keyColumns[0], engine)} IN (${chunk.map((key) => quoteLiteral(key)).join(', ')})` : conditions.join(' OR ');
    const { rows } = await queryRows(manager, source.conn.id, `SELECT ${selectSql} FROM ${tableSql} WHERE ${where}`, source.spec.database, Math.max(1, chunk.length * 2));
    for (const row of rows) {
      const key = keyString(row.slice(0, keyColumns.length));
      const record: Record<string, unknown> = {};
      columns.slice(keyColumns.length).forEach((column, index) => {
        record[column] = row[keyColumns.length + index];
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
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const type = source.spec.valueType ?? 'string';
  const rawKeys = keys.map((key) => source.rawKeys.get(key) ?? key);
  for (const raw of rawKeys) {
    const { rows } = await queryRows(manager, source.conn.id, `TYPE ${quoteRedis(raw)}`, source.spec.database, 1);
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
      const raw = rawKeys[index];
      const logical = keys[index];
      const { rows } = await queryRows(manager, source.conn.id, `HGETALL ${quoteRedis(raw)}`, source.spec.database, 5000);
      const record: Record<string, unknown> = {};
      for (const row of rows) record[String(row[0])] = row[1];
      out.set(logical, record);
    }
    return out;
  }
  for (let index = 0; index < rawKeys.length; index += 100) {
    const batch = rawKeys.slice(index, index + 100);
    const { rows } = await queryRows(manager, source.conn.id, `MGET ${batch.map(quoteRedis).join(' ')}`, source.spec.database, batch.length);
    batch.forEach((raw, offset) => {
      const logical = keys[index + offset];
      const value = rows[offset]?.[0];
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
): Promise<Map<string, Record<string, unknown>>> {
  if (source.spec.kind === 'table') return readTableRecords(manager, source, keys, fields);
  if (source.spec.kind === 'documents') return readDocumentRecords(manager, source, keys, fields);
  return readRedisRecords(manager, source, keys, fields);
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
  if (left === null || left === undefined) return right === null || right === undefined || right === '';
  if (right === null || right === undefined) return left === '';
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
): { repair: string[]; note?: string } {
  if (!baseSide || baseSide === 'none') return { repair: [], note: '未选择基准侧，只展示差异，不生成写命令。' };
  if (baseSide === 'right') return { repair: [], note: '以右侧为基准的修复在 v1 暂不生成，请交换左右源后重跑。' };
  const repair: string[] = [];
  if (right.spec.kind === 'table' && right.table && right.conn) {
    const engine = right.conn.engine;
    const table = quoteQualified([right.schema, right.table.name], engine);
    const keyColumns = right.spec.keyColumns ?? [];
    for (const diff of differences) {
      if (diff.status === 'missing_in_right' && diff.left) {
        const values = fields.map((field) => quoteLiteral(String(diff.left?.[field.left] ?? ''))).join(', ');
        const rightNames = fields.map((field) => quoteIdent(field.right, engine)).join(', ');
        repair.push(`INSERT INTO ${table} (${rightNames}) VALUES (${values});`);
      } else if (diff.status === 'extra_in_right' && right.table) {
        const parts = diff.key.split('\u0000');
        const where = keyColumns.map((column, index) => `${quoteIdent(column, engine)} = ${quoteLiteral(parts[index] ?? '')}`).join(' AND ');
        if (where) repair.push(`DELETE FROM ${table} WHERE ${where};`);
      } else if (diff.left && diff.right) {
        const set = fields
          .filter((field) => diff.fields?.includes(field.left))
          .map((field) => `${quoteIdent(field.right, engine)} = ${quoteLiteral(String(diff.left?.[field.left] ?? ''))}`)
          .join(', ');
        const parts = diff.key.split('\u0000');
        const where = keyColumns.map((column, index) => `${quoteIdent(column, engine)} = ${quoteLiteral(parts[index] ?? '')}`).join(' AND ');
        if (set && where) repair.push(`UPDATE ${table} SET ${set} WHERE ${where};`);
      }
    }
    return { repair, note: '修复命令基于左侧基准生成，执行前必须备份并人工确认。' };
  }
  if (right.spec.kind === 'keyspace') {
    for (const diff of differences) {
      const raw = right.rawKeys.get(diff.key) ?? rawRedisKey(right.spec, diff.key);
      if (diff.status === 'missing_in_right' && diff.left) {
        if ((right.spec.valueType ?? 'string') === 'hash') {
          for (const field of fields) repair.push(`HSET ${raw} ${field.right} ${quoteRedis(diff.left[field.left])}`);
        } else {
          const field = fields[0]?.left ?? 'value';
          repair.push(`SET ${raw} ${quoteRedis(diff.left[field])}`);
        }
      } else if (diff.status === 'extra_in_right') {
        repair.push(`DEL ${raw}`);
      } else if (diff.left) {
        for (const field of fields.filter((item) => diff.fields?.includes(item.left))) {
          repair.push(`HSET ${raw} ${field.right} ${quoteRedis(diff.left[field.left])}`);
        }
      }
    }
    return { repair, note: 'Redis 修复命令只展示、不执行；v1 不写 Redis。' };
  }
  void left;
  return { repair: [], note: '当前源组合暂不支持生成修复命令。' };
}

function rawRedisKey(spec: ReconSourceSpec, logical: string): string {
  if (spec.keyPattern?.includes('*')) return spec.keyPattern.replace('*', logical);
  return logical;
}

function quoteRedis(value: unknown): string {
  if (value === undefined || value === null) return '""';
  return JSON.stringify(String(value));
}

export async function reconcileData(
  store: Store,
  manager: ConnectionManager,
  mapping: ReconMapping,
  level: ReconLevel,
): Promise<ReconResult> {
  const maxKeys = clamp(mapping.maxKeys ?? 200_000, 1, 200_000);
  const left = await resolveSource(store, manager, mapping.left, maxKeys, level !== 'counts');
  const right = await resolveSource(store, manager, mapping.right, maxKeys, level !== 'counts');
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
    if (!rightKeys.has(key)) {
      missingInRight++;
      differences.push({ key, status: 'missing_in_right' });
    }
  }
  for (const key of rightKeys.keys()) {
    if (!leftKeys.has(key)) {
      extraInRight++;
      differences.push({ key, status: 'extra_in_right' });
    }
  }

  let valueChanged = 0;
  let typeDrift = 0;
  let nullMismatch = 0;
  const fields = fieldList(left, right, mapping);
  if (level !== 'counts' && mapping.baseSide === 'left') {
    const missing = differences.filter((diff) => diff.status === 'missing_in_right').slice(0, 1000);
    if (missing.length) {
      const records = await readRecords(manager, left, missing.map((diff) => diff.key), fields.map((field) => field.left));
      for (const diff of missing) diff.left = records.get(diff.key);
    }
  }
  if (level !== 'counts' && leftKeys.size && rightKeys.size) {
    const matched = [...leftKeys.keys()].filter((key) => rightKeys.has(key));
    const leftFields = fields.map((field) => field.left);
    const rightFields = fields.map((field) => field.right);
    for (let index = 0; index < matched.length; index += 500) {
      const batch = matched.slice(index, index + 500);
      const [leftRecords, rightRecords] = await Promise.all([
        readRecords(manager, left, batch, leftFields),
        readRecords(manager, right, batch, rightFields),
      ]);
      for (const key of batch) {
        const diff = compareRecord(key, leftRecords.get(key), rightRecords.get(key), fields);
        if (!diff) continue;
        if (diff.status === 'value_changed') valueChanged++;
        else if (diff.status === 'type_drift') typeDrift++;
        else if (diff.status === 'null_mismatch') nullMismatch++;
        differences.push(diff);
      }
    }
  }

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
  };
  const repair = level === 'counts'
    ? { repair: [], note: '数量级对账不生成修复命令。' }
    : repairPlan(left, right, differences, fields, mapping.baseSide);
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
    repairNote: repair.note,
    notes: [
      ...(left.truncated || right.truncated ? [`扫描达到上限 ${maxKeys}，结果可能不完整。`] : []),
      ...(left.skipped || right.skipped ? [`${left.skipped + right.skipped} 个键不匹配提取规则，已跳过。`] : []),
    ],
    generatedAt: new Date().toISOString(),
  };
}
