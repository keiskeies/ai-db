import type { Engine, QueryResult, RedisKeyDetail, StructuredQuery, TableInfo, VectorQuery } from '@aidb/core';

export interface RunOptions {
  maxRows?: number;
  database?: string;
  timeoutMs?: number;
}

export interface DriverTestResult {
  ok: boolean;
  version?: string;
  latencyMs: number;
  message?: string;
}

export interface Driver {
  engine: Engine;
  test(): Promise<DriverTestResult>;
  listDatabases(): Promise<string[]>;
  describe(database?: string): Promise<TableInfo[]>;
  run(sql: string, opts?: RunOptions): Promise<QueryResult>;
  runParams(sql: string, params: unknown[], opts?: RunOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

/** 非 SQL 驱动实现的结构化查询入口；SQL 驱动不需要实现。 */
export interface StructuredQueryDriver extends Driver {
  executeQuery(query: StructuredQuery, opts?: RunOptions): Promise<QueryResult>;
}

export function supportsStructuredQuery(driver: Driver): driver is StructuredQueryDriver {
  return typeof (driver as StructuredQueryDriver).executeQuery === 'function';
}

export interface VectorQueryDriver extends StructuredQueryDriver {
  vectorSearch(query: VectorQuery, opts?: RunOptions): Promise<QueryResult>;
}

export function supportsVectorSearch(driver: Driver): driver is VectorQueryDriver {
  return typeof (driver as VectorQueryDriver).vectorSearch === 'function';
}

export interface WriteDocumentInput {
  collection: string;
  documents: Record<string, unknown>[];
}

export interface WriteDocumentResult {
  ids: string[];
  upserted: number;
}

export interface DeleteDocumentsInput {
  collection: string;
  ids: string[];
}

/** 向量/搜索驱动实现的写入入口；SQL 与文档型驱动不实现。 */
export interface DocumentWriteDriver extends StructuredQueryDriver {
  upsertDocuments(input: WriteDocumentInput, opts?: RunOptions): Promise<WriteDocumentResult>;
  deleteDocuments(input: DeleteDocumentsInput, opts?: RunOptions): Promise<{ deleted: number }>;
}

export function supportsDocumentWrite(driver: Driver): driver is DocumentWriteDriver {
  return (
    typeof (driver as DocumentWriteDriver).upsertDocuments === 'function' &&
    typeof (driver as DocumentWriteDriver).deleteDocuments === 'function'
  );
}

export interface CreateObjectField {
  name: string;
  type: string;
}

export interface CreateObjectInput {
  name: string;
  /** 向量集合维度；搜索索引与 Weaviate class 可省略。 */
  dimension?: number;
  distance?: string;
  fields?: CreateObjectField[];
}

/** 向量/搜索/文档驱动的对象生命周期入口（非 SQL DDL，专用对话框与工具使用）。 */
export interface ObjectCreateDriver extends Driver {
  createObject(input: CreateObjectInput, opts?: RunOptions): Promise<{ name: string; kind: string }>;
  dropObject(name: string, opts?: RunOptions): Promise<{ name: string; dropped: boolean }>;
}

export function supportsObjectCreate(driver: Driver): driver is ObjectCreateDriver {
  return typeof (driver as ObjectCreateDriver).createObject === 'function';
}

/** 键值引擎的键详情（类型感知查看器）。 */
export interface RedisKeyDriver extends Driver {
  describeKey(key: string, database?: string, limit?: number): Promise<RedisKeyDetail>;
}

export function supportsKeyDetail(driver: Driver): driver is RedisKeyDriver {
  return typeof (driver as RedisKeyDriver).describeKey === 'function';
}

export interface ConnectionRecord {
  config: import('@aidb/core').ConnectionConfig;
  secret: import('@aidb/core').ConnectionSecret;
}

export class DbError extends Error {
  code: string;
  hint?: string;
  status: number;
  constructor(message: string, opts: { code?: string; hint?: string; status?: number } = {}) {
    super(message);
    this.name = 'DbError';
    this.code = opts.code ?? 'DB_ERROR';
    this.hint = opts.hint;
    this.status = opts.status ?? 400;
  }
}

export function toRowArray(columns: Array<{ name: string }>, rows: Record<string, unknown>[]): unknown[][] {
  return rows.map((row) => columns.map((c) => row[c.name]));
}
