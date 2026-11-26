import type { Engine, QueryResult, RedisKeyDetail, StructuredQuery, TableInfo, VectorQuery } from '@aidb/core';

export interface RunOptions {
  maxRows?: number;
  database?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 取消关联 id；直驱事务读取用它保留执行归属，管理器仍负责实际取消。 */
  executionId?: string;
}

export interface DriverTestResult {
  ok: boolean;
  version?: string;
  latencyMs: number;
  message?: string;
  code?: string;
}

export interface Driver {
  engine: Engine;
  test(): Promise<DriverTestResult>;
  listDatabases(): Promise<string[]>;
  describe(database?: string): Promise<TableInfo[]>;
  run(sql: string, opts?: RunOptions): Promise<QueryResult>;
  runParams(sql: string, params: unknown[], opts?: RunOptions): Promise<QueryResult>;
  /** 一次性执行多语句脚本（备份恢复等大脚本），避免逐条语句的往返开销。 */
  execScript?(sql: string, database?: string, opts?: RunOptions): Promise<void>;
  close(): Promise<void>;
}

/** 非 SQL 驱动实现的结构化查询入口；SQL 驱动不需要实现。 */
export interface StructuredQueryDriver extends Driver {
  executeQuery(query: StructuredQuery, opts?: RunOptions): Promise<QueryResult>;
}

/** 流式迭代的一批行：columns 每批都带（首批即确定），rows 为按 columns 对齐的数组行。 */
export interface RowBatch {
  columns: Array<{ name: string; type?: string }>;
  rows: unknown[][];
}

/**
 * 全保真逐批读取入口（备份/迁移这类不能截断数据的场景）。
 * 驱动按批 yield，调用方消费完一批才拉下一批，整表不进堆；
 * 不实现它的驱动继续走 run() 分页/整表读的老路径。
 */
export interface RowStreamDriver extends Driver {
  iterateRows(sql: string, params?: unknown[], opts?: RunOptions): AsyncGenerator<RowBatch>;
}

export function supportsRowStream(driver: Driver): driver is RowStreamDriver {
  return typeof (driver as RowStreamDriver).iterateRows === 'function';
}

/**
 * 保留结果的累计字节上限（各驱动共用）。行数上限挡不住大字段宽表：单行数 MB × 5000 行就是 GB 级，
 * 全量缓冲时一次 SELECT * 即可打穿默认 ~4GB 堆。超限即停止保留并标记 truncated。
 */
export const MAX_RESULT_BYTES = 64 * 1024 * 1024;

/**
 * 单元格占用字节估算（按 JS 堆口径，UTF-16 长度近似）。
 * 用于结果/批次的字节预算：行数上限挡不住单行数 MB 的大字段表。
 */
export function estimateValueBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof Date) return 8;
  try {
    return JSON.stringify(value)?.length ?? 8;
  } catch {
    return 8;
  }
}

export function estimateRowBytes(row: unknown[]): number {
  let total = 16;
  for (const cell of row) total += estimateValueBytes(cell);
  return total;
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
export interface CreateRedisKeyInput {
  key: string;
  type: 'string' | 'hash' | 'list' | 'set' | 'zset';
  /** string 为标量；hash/zset 为对象；list/set 为数组。 */
  value: unknown;
  ttl?: number | null;
}

export interface RedisKeyDriver extends Driver {
  describeKey(key: string, database?: string, limit?: number): Promise<RedisKeyDetail>;
  createKey(input: CreateRedisKeyInput, database?: string): Promise<{ key: string; type: string; ttl: number }>;
  setKeyValue(key: string, value: string, database?: string): Promise<{ key: string; type: string; ttl: number }>;
  setHashField(key: string, field: string, value: string, database?: string): Promise<{ key: string; field: string; created: boolean }>;
  deleteHashField(key: string, field: string, database?: string): Promise<{ key: string; field: string; deleted: boolean; keyGone: boolean }>;
  addKeyMember(key: string, member: string, score?: number, database?: string): Promise<{ key: string; type: string; added: boolean }>;
  removeKeyMember(key: string, member: string, database?: string): Promise<{ key: string; member: string; deleted: number; keyGone: boolean }>;
  setListItem(key: string, index: number, value: string, database?: string): Promise<{ key: string; index: number; value: string }>;
  deleteKeys(keys: string[], database?: string): Promise<{ deleted: number }>;
  dropIndex(name: string, database?: string): Promise<{ name: string; dropped: boolean }>;
  setTtl(key: string, seconds: number | null, database?: string): Promise<{ key: string; ttl: number }>;
  renameKey(from: string, to: string, database?: string): Promise<{ from: string; to: string }>;
}

export function supportsKeyDetail(driver: Driver): driver is RedisKeyDriver {
  return typeof (driver as RedisKeyDriver).describeKey === 'function';
}

/** 固定得住单条连接的驱动才能做跨请求事务（目前只有 MySQL）。 */
export interface TransactionDriver extends Driver {
  beginTransaction(sessionId: string, database?: string): Promise<void>;
  runInTransaction(sessionId: string, sql: string, params: unknown[], opts?: RunOptions): Promise<QueryResult>;
  /**
   * 在已固定的事务连接上读取结构元数据。一致性备份只认这个入口，禁止回落 describe()/连接池。
   * 未实现的驱动仍可用于普通跨请求事务，但不能为备份快照提供结构清单。
   */
  describeInTransaction?(sessionId: string, database?: string, opts?: RunOptions): Promise<TableInfo[]>;
  commitTransaction(sessionId: string): Promise<void>;
  rollbackTransaction(sessionId: string): Promise<void>;
}

export function supportsTransaction(driver: Driver): driver is TransactionDriver {
  const candidate = driver as TransactionDriver;
  return (
    typeof candidate.beginTransaction === 'function' &&
    typeof candidate.runInTransaction === 'function' &&
    typeof candidate.commitTransaction === 'function' &&
    typeof candidate.rollbackTransaction === 'function'
  );
}

/** 时序引擎的行协议写入入口（InfluxDB v3 的 SQL 只读）。 */
export interface LineProtocolDriver extends Driver {
  writeLineProtocol(lines: string[], database?: string, timeoutMs?: number): Promise<{ written: number }>;
}

export function supportsLineProtocol(driver: Driver): driver is LineProtocolDriver {
  return typeof (driver as LineProtocolDriver).writeLineProtocol === 'function';
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
