// mssql 是 CJS 包：命名空间导入在 Node ESM/tsx 下拿不到 ConnectionPool（只有 esbuild 打包才正常），
// 因此用默认导入取运行时值，类型走 import type。
import mssql from 'mssql';
import type { ConnectionPool, Transaction } from 'mssql';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, toRowArray } from './types';

export interface SqlServerOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

interface PgAgg {
  tables: Map<string, TableInfo>;
}

export class SqlServerDriver implements Driver {
  engine = 'sqlserver' as const;
  private pools = new Map<string, ConnectionPool>();
  /** 跨请求事务：会话 id → 已开启的 mssql 事务。 */
  private txTransactions = new Map<string, Transaction>();

  constructor(private opts: SqlServerOptions) {}

  private async pool(database?: string): Promise<ConnectionPool> {
    const key = database || this.opts.database || 'master';
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new mssql.ConnectionPool({
        server: this.opts.host,
        port: this.opts.port,
        user: this.opts.user,
        password: this.opts.password ?? '',
        database: key,
        options: {
          encrypt: Boolean(this.opts.ssl),
          trustServerCertificate: false,
          enableArithAbort: true,
        },
        pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
        connectionTimeout: 10000,
        requestTimeout: 30000,
      });
      await pool.connect();
      this.pools.set(key, pool);
    }
    return pool;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const pool = await this.pool();
      const result = await pool.request().query('SELECT @@VERSION AS v');
      const v = (result.recordset?.[0]?.v as string | undefined)?.split('\n')[0];
      return { ok: true, version: v ?? 'SQL Server', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    }
  }

  async listDatabases(): Promise<string[]> {
    const pool = await this.pool('master');
    const result = await pool.request().query('SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name');
    return (result.recordset ?? []).map((row: Record<string, string>) => row.name);
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const pool = await this.pool(database);
    try {
      const tablesRes = await pool.request().query(`
        SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_SCHEMA, TABLE_NAME`);
      const columnsRes = await pool.request().query(`
        SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
               CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
               COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
        FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`);
      const indexesRes = await pool.request().query(`
        SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name, i.is_unique, i.is_primary_key,
               c.name AS column_name, ic.key_ordinal
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.name IS NOT NULL ORDER BY t.name, i.name, ic.key_ordinal`);
      const fkRes = await pool.request().query(`
        SELECT fk.name AS constraint_name, sch.name AS schema_name, t.name AS table_name, c.name AS column_name,
               rt.name AS ref_table, rc.name AS ref_column
        FROM sys.foreign_keys fk
        JOIN sys.tables t ON t.object_id = fk.parent_object_id
        JOIN sys.schemas sch ON sch.schema_id = t.schema_id
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
        JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        ORDER BY t.name, fk.name, fkc.constraint_column_id`);
      const estRes = await pool.request().query(`
        SELECT s.name AS schema_name, t.name AS table_name, SUM(p.rows) AS row_count
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
        GROUP BY s.name, t.name`);

      const aggregates = new Map<string, PgAgg['tables']>();
      const key = (schema: string, table: string) => `${schema}.${table}`;
      for (const row of tablesRes.recordset ?? []) {
        const map = aggregates.get(row.TABLE_SCHEMA) ?? new Map<string, TableInfo>();
        aggregates.set(row.TABLE_SCHEMA, map);
        map.set(row.TABLE_NAME, {
          name: row.TABLE_NAME,
          schema: row.TABLE_SCHEMA,
          type: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
          columns: [],
          indexes: [],
          foreignKeys: [],
        });
      }
      const primaryCols = new Set<string>();
      for (const row of indexesRes.recordset ?? []) {
        const table = aggregates.get(row.schema_name)?.get(row.table_name);
        if (!table) continue;
        const idxs = table.indexes as IndexInfo[];
        let idx = idxs.find((item) => item.name === row.index_name);
        if (!idx) {
          idx = { name: row.index_name, columns: [], unique: Boolean(row.is_unique), primary: Boolean(row.is_primary_key) };
          idxs.push(idx);
        }
        if (!idx.columns.includes(row.column_name)) idx.columns.push(row.column_name);
        if (row.is_primary_key) primaryCols.add(`${row.schema_name}.${row.table_name}.${row.column_name}`);
      }
      for (const row of columnsRes.recordset ?? []) {
        const table = aggregates.get(row.TABLE_SCHEMA)?.get(row.TABLE_NAME);
        if (!table) continue;
        const charLen = Number(row.CHARACTER_MAXIMUM_LENGTH);
        const precision = Number(row.NUMERIC_PRECISION);
        const scale = Number(row.NUMERIC_SCALE);
        let type = String(row.DATA_TYPE);
        if (charLen > 0 && /char|varchar|binary|varbinary/i.test(type)) type += charLen === -1 ? '(max)' : `(${charLen})`;
        else if (precision > 0) type += `(${precision}${scale ? `,${scale}` : ''})`;
        (table.columns as ColumnInfo[]).push({
          name: row.COLUMN_NAME,
          type,
          nullable: row.IS_NULLABLE === 'YES',
          defaultValue: row.COLUMN_DEFAULT ?? null,
          primaryKey: primaryCols.has(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}.${row.COLUMN_NAME}`),
          autoIncrement: Number(row.IS_IDENTITY) === 1,
        });
      }
      for (const row of estRes.recordset ?? []) {
        const table = aggregates.get(row.schema_name)?.get(row.table_name);
        if (table) table.rowEstimate = Number(row.row_count ?? 0);
      }
      const fkMap = new Map<string, ForeignKeyInfo>();
      for (const row of fkRes.recordset ?? []) {
        const mapKey = key(row.schema_name, row.table_name) + '.' + row.constraint_name;
        let fk = fkMap.get(mapKey);
        if (!fk) {
          fk = { name: row.constraint_name, columns: [], refTable: row.ref_table, refColumns: [] };
          fkMap.set(mapKey, fk);
        }
        fk.columns.push(row.column_name);
        fk.refColumns.push(row.ref_column);
      }
      for (const [mapKey, fk] of fkMap) {
        const [schema, table] = mapKey.split('.');
        aggregates.get(schema)?.get(table)?.foreignKeys?.push(fk);
      }
      return [...aggregates.values()].flatMap((map) => [...map.values()]);
    } catch (err: any) {
      throw new DbError(err.message, { code: 'MSSQL_METADATA_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    try {
      const pool = await this.pool(opts.database);
      const request = pool.request();
      if (opts.timeoutMs && opts.timeoutMs > 0) (request as unknown as { requestTimeout: number }).requestTimeout = opts.timeoutMs;
      params.forEach((value, index) => request.input(`p${index + 1}`, value as any));
      const result = await request.query(sql);
      return this.toResult(result, started, sql, opts.maxRows);
    } catch (err: any) {
      throw new DbError(err.message ?? 'SQL Server 执行失败', { code: err.code ?? 'MSSQL_ERROR' });
    }
  }

  private toResult(result: any, started: number, sql: string, maxRows?: number): QueryResult {
    const sets = (result.recordsets ?? []) as Array<Record<string, any>[]>;
    const last = sets.length ? sets[sets.length - 1] : undefined;
    if (last) {
      const fields = Object.values((last as any).columns ?? {}) as Array<{ name: string; type?: { declaration?: string } }>;
      const columns = fields.map((field) => ({ name: field.name, type: field.type?.declaration }));
      const all = last as Array<Record<string, unknown>>;
      const limit = maxRows && maxRows > 0 ? maxRows : all.length;
      const rows = all.slice(0, limit);
      return {
        columns,
        rows: toRowArray(columns, rows),
        rowCount: rows.length,
        durationMs: Date.now() - started,
        truncated: all.length > rows.length,
        statement: sql,
      };
    }
    const affected = (result.rowsAffected ?? []).reduce((a: number, b: number) => a + (b || 0), 0);
    return { columns: [], rows: [], rowCount: 0, affected, durationMs: Date.now() - started, statement: sql };
  }

  /** 开启跨请求事务：mssql 的 Transaction 会独占池内一条连接直到提交/回滚。 */
  async beginTransaction(sessionId: string, database?: string): Promise<void> {
    if (this.txTransactions.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    const pool = await this.pool(database);
    const transaction = new mssql.Transaction(pool);
    await transaction.begin();
    this.txTransactions.set(sessionId, transaction);
  }

  async runInTransaction(sessionId: string, sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const transaction = this.txTransactions.get(sessionId);
    if (!transaction) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const started = Date.now();
    try {
      const request = new mssql.Request(transaction);
      if (opts.timeoutMs && opts.timeoutMs > 0) (request as unknown as { requestTimeout: number }).requestTimeout = opts.timeoutMs;
      params.forEach((value, index) => request.input(`p${index + 1}`, value as any));
      const result = await request.query(sql);
      return this.toResult(result, started, sql, opts.maxRows);
    } catch (err: any) {
      throw new DbError(err.message ?? 'SQL Server 事务执行失败', { code: err.code ?? 'MSSQL_ERROR' });
    }
  }

  async commitTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, true);
  }

  async rollbackTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, false);
  }

  private async finishTransaction(sessionId: string, commit: boolean): Promise<void> {
    const transaction = this.txTransactions.get(sessionId);
    if (!transaction) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    this.txTransactions.delete(sessionId);
    try {
      if (commit) await transaction.commit();
      else await transaction.rollback();
    } catch (err: any) {
      throw new DbError(err?.message ?? `${commit ? '提交' : '回滚'}事务失败`, { code: commit ? 'TX_COMMIT' : 'TX_ROLLBACK' });
    }
  }

  async close(): Promise<void> {
    for (const [sessionId] of this.txTransactions) {
      await this.finishTransaction(sessionId, false).catch(() => undefined);
    }
    await Promise.all([...this.pools.values()].map((pool) => pool.close().catch(() => undefined)));
    this.pools.clear();
  }
}
