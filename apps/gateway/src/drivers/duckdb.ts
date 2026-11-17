import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { ColumnInfo, Engine, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, estimateRowBytes, MAX_RESULT_BYTES } from './types';

/** 查询默认超时：到期调 connection.interrupt() 真正终止 DuckDB 内部执行。 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export class DuckdbDriver implements Driver {
  engine: Engine = 'duckdb';
  private instance?: DuckDBInstance;
  private connection?: DuckDBConnection;
  private opening?: Promise<DuckDBConnection>;

  constructor(private path: string, private readonly: boolean) {}

  private async connect(): Promise<DuckDBConnection> {
    if (this.connection) return this.connection;
    if (!this.opening) {
      this.opening = DuckDBInstance.create(this.path, this.readonly ? { access_mode: 'READ_ONLY' } : {})
        .then(async (instance) => {
          this.instance = instance;
          const connection = await instance.connect();
          this.connection = connection;
          return connection;
        })
        .catch((err) => {
          this.opening = undefined;
          throw err;
        });
    }
    return this.opening;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const connection = await this.connect();
      const reader = await connection.runAndReadAll('SELECT version() AS version');
      const version = String(reader.getRowObjects()[0]?.version ?? 'DuckDB');
      return { ok: true, version: `DuckDB ${version}`, latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['main'];
  }

  async describe(): Promise<TableInfo[]> {
    try {
      const connection = await this.connect();
      const tables = await connection.runAndReadAll(`
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
        ORDER BY table_schema, table_name`);
      const columns = await connection.runAndReadAll(`
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
        ORDER BY table_schema, table_name, ordinal_position`);
      const columnsByTable = new Map<string, ColumnInfo[]>();
      for (const row of columns.getRowObjects()) {
        const key = `${row.table_schema}.${row.table_name}`;
        const list = columnsByTable.get(key) ?? [];
        list.push({
          name: String(row.column_name),
          type: String(row.data_type ?? ''),
          nullable: String(row.is_nullable).toUpperCase() === 'YES',
          defaultValue: row.column_default === undefined || row.column_default === null ? null : String(row.column_default),
          primaryKey: false,
          autoIncrement: false,
        });
        columnsByTable.set(key, list);
      }
      return tables.getRowObjects().map((row) => {
        const key = `${row.table_schema}.${row.table_name}`;
        return {
          name: String(row.table_name),
          type: String(row.table_type).toUpperCase() === 'VIEW' ? 'view' : 'table',
          schema: String(row.table_schema),
          columns: columnsByTable.get(key) ?? [],
        } satisfies TableInfo;
      });
    } catch (err: any) {
      throw new DbError(err?.message ?? '无法读取 DuckDB 结构', { code: 'DUCKDB_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    const ms = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_QUERY_TIMEOUT_MS;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const connection = await this.connect();
      // 看门狗到期 interrupt()：DuckDB 在引擎内部终止查询，fetchChunk 随之报错。
      timer = setTimeout(() => {
        timedOut = true;
        try {
          connection.interrupt();
        } catch {
          /* 连接可能已关闭 */
        }
      }, ms);
      // 流式读取（@duckdb/node-api 2.x 的 stream + fetchChunk）：不再 runAndReadAll 整表进堆。
      const result = await connection.stream(sql, params as any);
      try {
        const columns = result.columnNames().map((name) => ({ name, type: '' }));
        const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : Number.POSITIVE_INFINITY;
        const rows: unknown[][] = [];
        let bytes = 0;
        let truncated = false;
        for (;;) {
          const chunk = await result.fetchChunk();
          // 实测（2.0.0-r.1）：结果耗尽时 fetchChunk 返回空 chunk 而不是 null，
          // 与库内 fetchAllChunks 的终止条件一致，只判 null 会死循环。
          if (!chunk || chunk.rowCount === 0 || timedOut) break;
          for (const raw of chunk.getRows()) {
            const row = raw.map(normalize);
            const size = estimateRowBytes(row);
            // 首行即使单独超预算也保留；此后严格执行行数/字节双上限（对齐 mysql 的 64MB 语义）。
            if (rows.length >= maxRows || (rows.length > 0 && bytes + size > MAX_RESULT_BYTES)) {
              truncated = true;
              break;
            }
            rows.push(row);
            bytes += size;
            if (bytes >= MAX_RESULT_BYTES) {
              truncated = true;
              break;
            }
          }
          if (truncated || timedOut) break;
        }
        return {
          columns,
          rows,
          rowCount: rows.length,
          durationMs: Date.now() - started,
          truncated: truncated || undefined,
          affected: result.rowsChanged || undefined,
          statement: sql,
        };
      } finally {
        // 2.0 语义：未读完的流式结果必须 closeSync，否则连接被阻塞无法执行下一条语句。
        result.closeSync();
      }
    } catch (err: any) {
      if (timedOut) throw new DbError(`DuckDB 查询超时（${ms}ms）`, { code: 'DUCKDB_TIMEOUT', status: 504 });
      throw new DbError(err?.message ?? 'DuckDB 执行失败', { code: 'DUCKDB_ERROR' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    try {
      this.connection?.closeSync();
    } catch {
      /* ignore */
    }
    try {
      this.instance?.closeSync();
    } catch {
      /* ignore */
    }
    this.connection = undefined;
    this.instance = undefined;
    this.opening = undefined;
  }
}
