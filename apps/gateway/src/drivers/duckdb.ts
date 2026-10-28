import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { ColumnInfo, Engine, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError } from './types';

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
    try {
      const connection = await this.connect();
      const reader = await connection.runAndReadAll(sql, params as any);
      const columns = reader.columnNames().map((name) => ({ name, type: '' }));
      const rows = reader.getRows().map((row) => row.map(normalize));
      return {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
        affected: reader.rowsChanged || undefined,
        statement: sql,
      };
    } catch (err: any) {
      throw new DbError(err?.message ?? 'DuckDB 执行失败', { code: 'DUCKDB_ERROR' });
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
