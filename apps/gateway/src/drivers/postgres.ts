import pg from 'pg';
import type { Pool } from 'pg';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, toRowArray } from './types';

const { Pool: PgPool } = pg;

export interface PgOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

const OIDS: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  114: 'json',
  700: 'real',
  701: 'double precision',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema')`;

export class PostgresDriver implements Driver {
  engine: 'postgresql' | 'cockroachdb';
  private pools = new Map<string, Pool>();

  constructor(private opts: PgOptions, engine: 'postgresql' | 'cockroachdb' = 'postgresql') {
    this.engine = engine;
  }

  private pool(database?: string): Pool {
    const key = database ?? this.opts.database ?? 'postgres';
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new PgPool({
        host: this.opts.host,
        port: this.opts.port,
        user: this.opts.user,
        password: this.opts.password,
        database: key,
        ssl: this.opts.ssl ? { rejectUnauthorized: true } : undefined,
        max: 3,
        connectionTimeoutMillis: 10000,
        application_name: 'AiDB Studio',
      });
      pool.on('error', () => undefined);
      this.pools.set(key, pool);
    }
    return pool;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const res = await this.pool().query('SELECT version() AS v');
      return { ok: true, version: res.rows[0]?.v?.split(' ').slice(0, 2).join(' ') ?? 'PostgreSQL', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    }
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.pool().query('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
    return res.rows.map((r: { datname: string }) => r.datname);
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const pool = this.pool(database);
    try {
      const tablesRes = await pool.query(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ${SYSTEM_SCHEMAS} ORDER BY table_schema, table_name`,
      );
      const columnsRes = await pool.query(
        `SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema NOT IN ${SYSTEM_SCHEMAS} ORDER BY table_schema, table_name, ordinal_position`,
      );
      const indexesRes = await pool.query(`
        SELECT n.nspname AS schema, t.relname AS table, i.relname AS index, ix.indisunique AS unique,
               ix.indisprimary AS primary, a.attname AS column, array_position(ix.indkey, a.attnum) AS ord
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY t.relname, i.relname, ord`);
      const fksRes = await pool.query(`
        SELECT tc.table_schema AS schema, tc.table_name AS table, tc.constraint_name AS name,
               kcu.column_name AS column, ccu.table_name AS ref_table, ccu.column_name AS ref_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY tc.table_schema, tc.table_name, tc.constraint_name`);
      const estRes = await pool.query(`
        SELECT n.nspname AS schema, c.relname AS table, c.reltuples AS estimate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`);

      const tables = new Map<string, TableInfo>();
      for (const r of tablesRes.rows as Array<Record<string, any>>) {
        const key = `${r.table_schema}.${r.table_name}`;
        tables.set(key, {
          name: r.table_name,
          schema: r.table_schema,
          type: String(r.table_type).includes('VIEW') ? 'view' : 'table',
          columns: [],
          indexes: [],
          foreignKeys: [],
        });
      }
      for (const r of estRes.rows as Array<Record<string, any>>) {
        const t = tables.get(`${r.schema}.${r.table}`);
        if (t) t.rowEstimate = Math.max(0, Math.round(Number(r.estimate)));
      }
      const primaryCols = new Map<string, Set<string>>();
      for (const r of indexesRes.rows as Array<Record<string, any>>) {
        if (r.primary) {
          const key = `${r.schema}.${r.table}`;
          const set = primaryCols.get(key) ?? new Set<string>();
          set.add(r.column);
          primaryCols.set(key, set);
        }
      }
      for (const r of columnsRes.rows as Array<Record<string, any>>) {
        const t = tables.get(`${r.table_schema}.${r.table_name}`);
        if (!t) continue;
        const pkSet = primaryCols.get(`${r.table_schema}.${r.table_name}`);
        (t.columns as ColumnInfo[]).push({
          name: r.column_name,
          type: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type,
          nullable: r.is_nullable === 'YES',
          defaultValue: r.column_default ?? null,
          primaryKey: Boolean(pkSet?.has(r.column_name)),
        });
      }
      const indexMap = new Map<string, IndexInfo>();
      for (const r of indexesRes.rows as Array<Record<string, any>>) {
        const key = `${r.schema}.${r.table}.${r.index}`;
        let idx = indexMap.get(key);
        if (!idx) {
          idx = { name: r.index, columns: [], unique: Boolean(r.unique), primary: Boolean(r.primary) };
          indexMap.set(key, idx);
        }
        idx.columns.push(r.column);
      }
      for (const [key, idx] of indexMap) {
        const [schema, table] = key.split('.');
        tables.get(`${schema}.${table}`)?.indexes?.push(idx);
      }
      const fkMap = new Map<string, ForeignKeyInfo>();
      for (const r of fksRes.rows as Array<Record<string, any>>) {
        const key = `${r.schema}.${r.table}.${r.name}`;
        let fk = fkMap.get(key);
        if (!fk) {
          fk = { name: r.name, columns: [], refTable: r.ref_table, refColumns: [] };
          fkMap.set(key, fk);
        }
        fk.columns.push(r.column);
        fk.refColumns.push(r.ref_column);
      }
      for (const [key, fk] of fkMap) {
        const [schema, table] = key.split('.');
        tables.get(`${schema}.${table}`)?.foreignKeys?.push(fk);
      }
      return [...tables.values()];
    } catch (err: any) {
      throw new DbError(err.message, { code: 'PG_METADATA_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    try {
      const res = (await this.pool(opts.database).query({
        text: sql,
        values: params,
        query_timeout: opts.timeoutMs,
      } as any)) as import('pg').QueryResult<Record<string, unknown>>;
      const columns = (res.fields ?? []).map((f) => ({ name: f.name, type: OIDS[f.dataTypeID] ?? String(f.dataTypeID) }));
      const all = res.rows as Array<Record<string, unknown>>;
      const limit = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : all.length;
      const rows = all.slice(0, limit);
      return {
        columns,
        rows: toRowArray(columns, rows),
        rowCount: rows.length,
        affected: res.rowCount ?? undefined,
        durationMs: Date.now() - started,
        truncated: all.length > rows.length,
        statement: sql,
      };
    } catch (err: any) {
      throw new DbError(err.message ?? 'PostgreSQL 执行失败', { code: err.code ?? 'PG_ERROR' });
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}
