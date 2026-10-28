import type { Engine, QueryResult, StructuredQuery, TableInfo, VectorQuery } from '@aidb/core';

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
