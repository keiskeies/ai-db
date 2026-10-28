import { MongoClient } from 'mongodb';
import type { Collection, Document, Filter, Sort } from 'mongodb';
import type { ColumnInfo, Engine, MqlQuery, QueryResult, StructuredQuery, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions, StructuredQueryDriver } from './types';
import { DbError } from './types';

export interface MongoOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);

function bsonKind(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  if (Buffer.isBuffer(value)) return 'binary';
  if (typeof value === 'object') {
    const name = (value as { _bsontype?: string })._bsontype;
    if (name === 'ObjectId') return 'objectId';
    if (name === 'Decimal128') return 'decimal';
    if (name === 'Long') return 'long';
    if (name === 'Binary') return 'binary';
    if (name === 'Timestamp') return 'timestamp';
    return 'object';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'long';
  return typeof value;
}

function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const name = (value as { _bsontype?: string })._bsontype;
    if (name === 'ObjectId') return String(value);
    if (name === 'Decimal128' || name === 'Long' || name === 'Timestamp') return String(value);
    if (name === 'Binary') return `<binary>`;
    try {
      return JSON.stringify(value, (_key, child) => {
        if (child && typeof child === 'object') {
          const bson = (child as { _bsontype?: string })._bsontype;
          if (bson) return String(child);
          if (child instanceof Date) return child.toISOString();
        }
        if (typeof child === 'bigint') return child.toString();
        return child;
      });
    } catch {
      return String(value);
    }
  }
  return value;
}

function flattenFields(doc: Record<string, unknown>, prefix = '', depth = 0, out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [key, value] of Object.entries(doc)) {
    const name = prefix ? `${prefix}.${key}` : key;
    const bson = value && typeof value === 'object' ? (value as { _bsontype?: string })._bsontype : undefined;
    if (!bson && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && depth < 1) {
      flattenFields(value as Record<string, unknown>, name, depth + 1, out);
      continue;
    }
    out.set(name, value);
  }
  return out;
}

function inferColumns(docs: Record<string, unknown>[]): ColumnInfo[] {
  const stats = new Map<string, { present: number; nulls: number; types: Map<string, number> }>();
  for (const doc of docs) {
    const flat = flattenFields(doc);
    for (const [name, value] of flat) {
      const entry = stats.get(name) ?? { present: 0, nulls: 0, types: new Map<string, number>() };
      entry.present += 1;
      const kind = bsonKind(value);
      if (kind === 'null') entry.nulls += 1;
      entry.types.set(kind, (entry.types.get(kind) ?? 0) + 1);
      stats.set(name, entry);
    }
  }
  const columns: ColumnInfo[] = [];
  for (const [name, entry] of stats) {
    const types = [...entry.types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const primary = types.filter(([kind]) => kind !== 'null');
    columns.push({
      name,
      type: primary.map(([kind]) => kind).join(' | ') || 'null',
      nullable: entry.nulls > 0 || entry.present < docs.length,
      primaryKey: name === '_id',
    });
  }
  columns.sort((a, b) => Number(b.primaryKey) - Number(a.primaryKey) || a.name.localeCompare(b.name));
  return columns.slice(0, 120);
}

function resultFromDocuments(docs: Record<string, unknown>[], started: number, statement: string, truncated: boolean): QueryResult {
  const columnNames: string[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columnNames.push(key);
    }
  }
  const ordered = ['_id', ...columnNames.filter((name) => name !== '_id')].filter((name) => seen.has(name)).slice(0, 120);
  const columns = ordered.map((name) => {
    const sample = docs.map((doc) => doc[name]).find((value) => value !== undefined && value !== null);
    const kind = bsonKind(sample);
    return {
      name,
      type: kind,
      kind: kind === 'object' || kind === 'array' ? ('json' as const) : ('scalar' as const),
    };
  });
  const rows = docs.map((doc) => ordered.map((name) => serialize(doc[name])));
  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    truncated,
    statement,
    resultKind: 'documents',
  };
}

export function normalizeMql(value: unknown): MqlQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DbError('MongoDB 查询需要 JSON 对象，例如 {"collection":"users","op":"find","filter":{}}', { code: 'MQL_PARSE' });
  }
  const raw = value as Record<string, unknown>;
  const collection = typeof raw.collection === 'string' ? raw.collection : undefined;
  if (!collection) throw new DbError('MongoDB 查询缺少 collection', { code: 'MQL_COLLECTION' });
  const op =
    raw.op === 'aggregate' || raw.op === 'count' || raw.op === 'distinct' || raw.op === 'find'
      ? raw.op
      : Array.isArray(raw.pipeline)
        ? 'aggregate'
        : raw.field
          ? 'distinct'
          : 'find';
  const query: MqlQuery = { language: 'mql', collection, op };
  if (raw.filter && typeof raw.filter === 'object' && !Array.isArray(raw.filter)) query.filter = raw.filter as Record<string, unknown>;
  if (Array.isArray(raw.pipeline)) query.pipeline = raw.pipeline as Record<string, unknown>[];
  if (raw.projection && typeof raw.projection === 'object' && !Array.isArray(raw.projection)) query.projection = raw.projection as Record<string, unknown>;
  if (raw.sort && typeof raw.sort === 'object' && !Array.isArray(raw.sort)) query.sort = raw.sort as Record<string, unknown>;
  if (typeof raw.limit === 'number') query.limit = raw.limit;
  if (typeof raw.skip === 'number') query.skip = raw.skip;
  if (typeof raw.field === 'string') query.field = raw.field;
  return query;
}

export class MongoDriver implements StructuredQueryDriver {
  engine: Engine = 'mongodb';
  private client?: MongoClient;
  private connected?: Promise<MongoClient>;

  constructor(private opts: MongoOptions) {}

  private uri(): string {
    if (this.opts.host.startsWith('mongodb://') || this.opts.host.startsWith('mongodb+srv://')) return this.opts.host;
    const auth = this.opts.user
      ? `${encodeURIComponent(this.opts.user)}:${encodeURIComponent(this.opts.password ?? '')}@`
      : '';
    const database = this.opts.database ? `/${encodeURIComponent(this.opts.database)}` : '';
    const params = new URLSearchParams();
    if (this.opts.ssl) params.set('tls', 'true');
    const query = params.toString();
    return `mongodb://${auth}${this.opts.host || '127.0.0.1'}:${this.opts.port || 27017}${database}${query ? `?${query}` : ''}`;
  }

  private connect(): Promise<MongoClient> {
    if (!this.connected) {
      this.client = new MongoClient(this.uri(), {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        maxPoolSize: 5,
        appName: 'AiDB Studio',
      });
      this.connected = this.client.connect().catch((err) => {
        this.connected = undefined;
        void this.client?.close().catch(() => undefined);
        this.client = undefined;
        throw err;
      });
    }
    return this.connected;
  }

  private async database(name?: string): Promise<string> {
    if (name) return name;
    if (this.opts.database) return this.opts.database;
    const names = await this.listDatabases();
    return names.find((item) => !SYSTEM_DATABASES.has(item)) ?? names[0] ?? 'admin';
  }

  private async collection(name: string, database?: string): Promise<Collection<Document>> {
    const client = await this.connect();
    return client.db(await this.database(database)).collection(name);
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const client = await this.connect();
      const info = await client.db('admin').command({ buildInfo: 1 });
      return { ok: true, version: `MongoDB ${String(info.version ?? '')}`.trim(), latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    try {
      const client = await this.connect();
      const result = await client.db('admin').admin().listDatabases();
      return result.databases.map((item) => item.name).sort((a, b) => a.localeCompare(b));
    } catch (err: any) {
      throw new DbError(err?.message ?? 'MongoDB 列出数据库失败', { code: err?.codeName ?? 'MONGO_ERROR' });
    }
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const dbName = await this.database(database);
    const client = await this.connect();
    const db = client.db(dbName);
    try {
      const collections = await db.listCollections({}, { nameOnly: false }).toArray();
      const tables: TableInfo[] = [];
      const batchSize = 6;
      for (let start = 0; start < collections.length && tables.length < 200; start += batchSize) {
        const batch = collections.slice(start, start + batchSize);
        const described = await Promise.all(
          batch.map(async (coll): Promise<TableInfo | null> => {
            if (coll.type !== 'collection' && coll.type !== 'view') return null;
            const table: TableInfo = {
              name: coll.name,
              type: coll.type === 'view' ? 'view' : 'table',
              kind: 'collection',
            };
            try {
              table.rowEstimate = await db.collection(coll.name).estimatedDocumentCount();
            } catch {
              /* views and restricted collections may not allow counts */
            }
            if (coll.type === 'collection') {
              try {
                const sample = (await db.collection(coll.name).find({}, { limit: 30 }).toArray()) as Record<string, unknown>[];
                table.columns = inferColumns(sample);
              } catch {
                /* sampling is best effort */
              }
            }
            return table;
          }),
        );
        for (const table of described) if (table) tables.push(table);
      }
      return tables.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      throw new DbError(err?.message ?? `无法读取 MongoDB 数据库 ${dbName}`, { code: err?.codeName ?? 'MONGO_ERROR' });
    }
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'mql') throw new DbError('MongoDB 驱动只接受 MQL 查询', { code: 'MQL_ONLY' });
    const started = Date.now();
    const limit = Math.max(1, Math.min(opts.maxRows && opts.maxRows > 0 ? opts.maxRows : query.limit ?? 100, 1000));
    const statement = JSON.stringify(query);
    try {
      const coll = await this.collection(query.collection, opts.database);
      if (query.op === 'count') {
        const count = await coll.countDocuments((query.filter ?? {}) as Filter<Document>);
        return {
          columns: [{ name: 'count', type: 'long' }],
          rows: [[count]],
          rowCount: 1,
          durationMs: Date.now() - started,
          statement,
          resultKind: 'table',
        };
      }
      if (query.op === 'distinct') {
        if (!query.field) throw new DbError('distinct 缺少字段名', { code: 'MQL_FIELD' });
        const values = await coll.distinct(query.field, (query.filter ?? {}) as Filter<Document>);
        const rows = values.slice(0, limit).map((value) => [serialize(value)]);
        return {
          columns: [{ name: query.field, type: bsonKind(values[0]) }],
          rows,
          rowCount: rows.length,
          durationMs: Date.now() - started,
          truncated: values.length > rows.length,
          statement,
          resultKind: 'documents',
        };
      }
      if (query.op === 'aggregate') {
        const pipeline = [...(query.pipeline ?? [])] as Document[];
        if (!pipeline.some((stage) => '$limit' in stage || '$count' in stage || '$facet' in stage)) pipeline.push({ $limit: limit });
        const cursor = coll.aggregate(pipeline, { allowDiskUse: true, maxTimeMS: opts.timeoutMs });
        const docs = (await cursor.toArray()) as Record<string, unknown>[];
        return resultFromDocuments(docs.slice(0, limit), started, statement, docs.length >= limit);
      }
      const cursor = coll
        .find((query.filter ?? {}) as Filter<Document>, {
          projection: query.projection as Document | undefined,
          sort: query.sort as Sort | undefined,
          limit,
          skip: query.skip,
        })
        .maxTimeMS(opts.timeoutMs ?? 30000);
      const docs = (await cursor.toArray()) as Record<string, unknown>[];
      return resultFromDocuments(docs.slice(0, limit), started, statement, docs.length >= limit);
    } catch (err: any) {
      if (err instanceof DbError) throw err;
      throw new DbError(err?.message ?? 'MongoDB 查询失败', { code: err?.codeName ?? err?.code ?? 'MONGO_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sql);
    } catch {
      throw new DbError('MongoDB 查询需要 JSON，例如 {"collection":"users","op":"find","filter":{}}', { code: 'MQL_PARSE' });
    }
    return this.executeQuery(normalizeMql(parsed), opts);
  }

  async runParams(): Promise<QueryResult> {
    throw new DbError('MongoDB 不支持参数化 SQL，请使用结构化 MQL 查询', { code: 'MQL_ONLY' });
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.connected = undefined;
  }
}
