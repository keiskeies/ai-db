import mysql from 'mysql2/promise';
import type { Pool, FieldPacket, ResultSetHeader } from 'mysql2/promise';
import { engineMeta } from '@aidb/core';
import type { ColumnInfo, Engine, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, toRowArray } from './types';

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

const MYSQL_TYPES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VAR_STRING',
  254: 'STRING',
};

export class MysqlDriver implements Driver {
  engine: Engine;
  private pools = new Map<string, Pool>();

  constructor(private opts: MysqlOptions, engine: Engine = 'mysql') {
    this.engine = engine;
  }

  private pool(database?: string): Pool {
    const key = database ?? this.opts.database ?? '';
    let pool = this.pools.get(key);
    if (!pool) {
      pool = mysql.createPool({
        host: this.opts.host,
        port: this.opts.port,
        user: this.opts.user,
        password: this.opts.password,
        database: key || undefined,
        ssl: this.opts.ssl ? { rejectUnauthorized: true } : undefined,
        waitForConnections: true,
        connectionLimit: 3,
        connectTimeout: 10000,
        dateStrings: true,
        supportBigNumbers: true,
        multipleStatements: false,
        charset: 'utf8mb4',
      });
      this.pools.set(key, pool);
    }
    return pool;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const [rows] = await this.pool().query('SELECT VERSION() AS v');
      const v = (rows as Array<{ v: string }>)[0]?.v;
      return { ok: true, version: `${engineMeta(this.engine).label} ${v}`, latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    }
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.pool().query('SHOW DATABASES');
    return (rows as Array<Record<string, string>>).map((r) => r.Database ?? Object.values(r)[0]);
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const db = database ?? this.opts.database;
    if (!db) throw new DbError('MySQL 连接未指定数据库', { code: 'NO_DATABASE' });
    const pool = this.pool(db);
    try {
      const [tableRows] = await pool.query(
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [db],
      );
      const [columnRows] = await pool.query(
        'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
        [db],
      );
      const [indexRows] = await pool.query(
        'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE, INDEX_COMMENT FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
        [db],
      );
      const [fkRows] = await pool.query(
        'SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, REFERENCED_TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME',
        [db],
      );
      const [fkRuleRows] = await pool.query(
        'SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?',
        [db],
      );
      const tables = new Map<string, TableInfo>();
      for (const row of tableRows as Array<Record<string, any>>) {
        tables.set(row.TABLE_NAME, {
          name: row.TABLE_NAME,
          type: String(row.TABLE_TYPE).includes('VIEW') ? 'view' : 'table',
          schema: db,
          rowEstimate: row.TABLE_ROWS !== null ? Number(row.TABLE_ROWS) : undefined,
          columns: [],
          indexes: [],
          foreignKeys: [],
          comment: row.TABLE_COMMENT || undefined,
        });
      }
      for (const row of columnRows as Array<Record<string, any>>) {
        const t = tables.get(row.TABLE_NAME);
        if (!t) continue;
        const extra = String(row.EXTRA ?? '');
        (t.columns as ColumnInfo[]).push({
          name: row.COLUMN_NAME,
          type: row.COLUMN_TYPE,
          nullable: row.IS_NULLABLE === 'YES',
          defaultValue: row.COLUMN_DEFAULT === null ? null : String(row.COLUMN_DEFAULT),
          primaryKey: row.COLUMN_KEY === 'PRI',
          autoIncrement: /auto_increment/i.test(extra),
          comment: row.COLUMN_COMMENT || undefined,
          generated: /virtual generated/i.test(extra) ? 'virtual' : /stored generated/i.test(extra) ? 'stored' : undefined,
        });
      }
      const indexMap = new Map<string, IndexInfo>();
      for (const row of indexRows as Array<Record<string, any>>) {
        const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
        let idx = indexMap.get(key);
        if (!idx) {
          idx = {
            name: row.INDEX_NAME,
            columns: [],
            unique: Number(row.NON_UNIQUE) === 0,
            primary: row.INDEX_NAME === 'PRIMARY',
            method: row.INDEX_TYPE || undefined,
            comment: row.INDEX_COMMENT || undefined,
          };
          indexMap.set(key, idx);
        }
        idx.columns.push(row.COLUMN_NAME);
      }
      for (const [key, idx] of indexMap) {
        const table = tables.get(key.split('.')[0]);
        if (table) (table.indexes as IndexInfo[]).push(idx);
      }
      const fkRules = new Map<string, { onDelete: string; onUpdate: string }>();
      for (const row of fkRuleRows as Array<Record<string, any>>) {
        fkRules.set(String(row.CONSTRAINT_NAME), { onDelete: String(row.DELETE_RULE ?? ''), onUpdate: String(row.UPDATE_RULE ?? '') });
      }
      const fkMap = new Map<string, ForeignKeyInfo>();
      for (const row of fkRows as Array<Record<string, any>>) {
        const key = `${row.TABLE_NAME}.${row.CONSTRAINT_NAME}`;
        let fk = fkMap.get(key);
        if (!fk) {
          const rules = fkRules.get(String(row.CONSTRAINT_NAME));
          fk = {
            name: row.CONSTRAINT_NAME,
            columns: [],
            refTable: row.REFERENCED_TABLE_NAME,
            refColumns: [],
            refSchema: row.REFERENCED_TABLE_SCHEMA || undefined,
            onDelete: rules?.onDelete || undefined,
            onUpdate: rules?.onUpdate || undefined,
          };
          fkMap.set(key, fk);
        }
        fk.columns.push(row.COLUMN_NAME);
        fk.refColumns.push(row.REFERENCED_COLUMN_NAME);
      }
      for (const [key, fk] of fkMap) {
        const table = tables.get(key.split('.')[0]);
        if (table) (table.foreignKeys as ForeignKeyInfo[]).push(fk);
      }
      return [...tables.values()];
    } catch (err: any) {
      throw new DbError(err.message, { code: 'MYSQL_METADATA_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    try {
      const [rows, fields] = await this.pool(opts.database).query({ sql, values: params, timeout: opts.timeoutMs });
      if (Array.isArray(rows)) {
        const fieldList = (Array.isArray(fields) ? fields : []) as FieldPacket[];
        const columns = fieldList.map((f) => ({ name: f.name, type: MYSQL_TYPES[f.type ?? -1] ?? String(f.type ?? '') }));
        const all = rows as Array<Record<string, unknown>>;
        const limit = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : all.length;
        const sliced = all.slice(0, limit);
        return {
          columns,
          rows: toRowArray(columns, sliced),
          rowCount: sliced.length,
          durationMs: Date.now() - started,
          truncated: all.length > sliced.length,
          statement: sql,
        };
      }
      const header = rows as ResultSetHeader;
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affected: header.affectedRows ?? 0,
        lastInsertId: header.insertId,
        durationMs: Date.now() - started,
        statement: sql,
      };
    } catch (err: any) {
      throw new DbError(err.message ?? 'MySQL 执行失败', { code: err.code ?? 'MYSQL_ERROR', hint: err.sqlMessage ? undefined : undefined });
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}
