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

/** 文档型 / 向量 / 搜索驱动实现的批量写入入口；SQL 引擎走 DML。 */
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
  /** ArangoDB：建边集合而不是文档集合。 */
  edge?: boolean;
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
  deleteKeys(keys: string[], database?: string): Promise<{ deleted: number }>;
  dropIndex(name: string, database?: string): Promise<{ name: string; dropped: boolean }>;
}

export function supportsKeyDetail(driver: Driver): driver is RedisKeyDriver {
  return typeof (driver as RedisKeyDriver).describeKey === 'function';
}

/** 文档型驱动的结构化索引管理：不走 SQL DDL。 */
export interface CollectionIndexInput {
  collection: string;
  name?: string;
  columns: string[];
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  /** Qdrant payload 索引类型：keyword / integer / float / text / bool / geo。 */
  type?: string;
}

export interface CollectionIndexDriver extends Driver {
  createIndex(input: CollectionIndexInput, opts?: RunOptions): Promise<{ name: string; created: boolean }>;
  dropIndex(input: { collection: string; name: string }, opts?: RunOptions): Promise<{ name: string; dropped: boolean }>;
}

export function supportsCollectionIndexes(driver: Driver): driver is CollectionIndexDriver {
  return (
    typeof (driver as CollectionIndexDriver).createIndex === 'function' &&
    typeof (driver as CollectionIndexDriver).dropIndex === 'function'
  );
}

/** 有显式 schema 的非关系型驱动：给已有对象追加字段。 */
export interface CreateFieldInput {
  object: string;
  name: string;
  type: string;
}

export interface FieldAddDriver extends Driver {
  createField(input: CreateFieldInput, opts?: RunOptions): Promise<{ name: string; type: string; added: boolean }>;
}

export function supportsFieldAdd(driver: Driver): driver is FieldAddDriver {
  return typeof (driver as FieldAddDriver).createField === 'function';
}

/** 文档型驱动的单读取：编辑对话框需要原文而不是表格单元格的字符串化结果。 */
export interface DocumentReadDriver extends Driver {
  getDocument(collection: string, id: string, database?: string): Promise<{ id: string; document: string }>;
}

export function supportsDocumentRead(driver: Driver): driver is DocumentReadDriver {
  return typeof (driver as DocumentReadDriver).getDocument === 'function';
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
