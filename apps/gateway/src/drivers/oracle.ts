import oracledb from 'oracledb';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, toRowArray } from './types';

export interface OracleOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

export class OracleDriver implements Driver {
  engine = 'oracle' as const;
  private pools = new Map<string, oracledb.Pool>();
  private owner: string;

  constructor(private opts: OracleOptions) {
    this.owner = (opts.user || '').toUpperCase();
  }

  private async pool(database?: string): Promise<oracledb.Pool> {
    const service = database || this.opts.database || 'ORCL';
    let pool = this.pools.get(service);
    if (!pool) {
      const created = (await oracledb.createPool({
        user: this.opts.user,
        password: this.opts.password,
        connectString: `${this.opts.host}:${this.opts.port}/${service}`,
        poolMin: 0,
        poolMax: 3,
        poolTimeout: 60,
        connectTimeout: 10,
      } as oracledb.PoolAttributes)) as unknown as oracledb.Pool;
      pool = created;
      this.pools.set(service, created);
    }
    return pool;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    let connection: oracledb.Connection | undefined;
    try {
      const pool = await this.pool();
      connection = await pool.getConnection();
      const result = await connection.execute('SELECT banner FROM v$version WHERE ROWNUM = 1', [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const row = (result.rows?.[0] ?? {}) as { BANNER?: string };
      return { ok: true, version: row.BANNER ?? 'Oracle Database', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async listDatabases(): Promise<string[]> {
    const pool = await this.pool();
    const connection = await pool.getConnection();
    try {
      const result = await connection.execute(
        "SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username",
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      return (result.rows ?? []).map((row: any) => String(row.USERNAME));
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  async describe(): Promise<TableInfo[]> {
    const pool = await this.pool();
    const connection = await pool.getConnection();
    try {
      const tables = await connection.execute(
        `SELECT OWNER, TABLE_NAME, 'TABLE' AS KIND, NUM_ROWS FROM ALL_TABLES WHERE OWNER = :1
         UNION ALL
         SELECT OWNER, VIEW_NAME AS TABLE_NAME, 'VIEW' AS KIND, NULL AS NUM_ROWS FROM ALL_VIEWS WHERE OWNER = :1`,
        [this.owner, this.owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const columns = await connection.execute(
        `SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, DATA_PRECISION, DATA_SCALE,
                NULLABLE, DATA_DEFAULT, IDENTITY_COLUMN
         FROM ALL_TAB_COLUMNS WHERE OWNER = :1 ORDER BY TABLE_NAME, COLUMN_ID`,
        [this.owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const indexes = await connection.execute(
        `SELECT i.OWNER, i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, c.COLUMN_NAME,
                (SELECT k.CONSTRAINT_TYPE FROM ALL_CONSTRAINTS k
                  WHERE k.OWNER = i.OWNER AND k.CONSTRAINT_NAME = i.INDEX_NAME AND k.TABLE_NAME = i.TABLE_NAME) AS CONSTRAINT_TYPE
         FROM ALL_INDEXES i
         JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME
         WHERE i.OWNER = :1 ORDER BY i.TABLE_NAME, i.INDEX_NAME, c.COLUMN_POSITION`,
        [this.owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const fks = await connection.execute(
        `SELECT c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, cc.COLUMN_NAME, rc.TABLE_NAME AS REF_TABLE, rcc.COLUMN_NAME AS REF_COLUMN
         FROM ALL_CONSTRAINTS c
         JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
         JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
         JOIN ALL_CONS_COLUMNS rcc ON rcc.OWNER = r.OWNER AND rcc.CONSTRAINT_NAME = r.CONSTRAINT_NAME AND rcc.POSITION = cc.POSITION
         WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = :1
         ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`,
        [this.owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );

      const map = new Map<string, TableInfo>();
      for (const row of (tables.rows ?? []) as any[]) {
        map.set(String(row.TABLE_NAME), {
          name: String(row.TABLE_NAME),
          schema: String(row.OWNER),
          type: row.KIND === 'VIEW' ? 'view' : 'table',
          rowEstimate: row.NUM_ROWS === null || row.NUM_ROWS === undefined ? undefined : Number(row.NUM_ROWS),
          columns: [],
          indexes: [],
          foreignKeys: [],
        });
      }
      const primaryCols = new Set<string>();
      for (const row of (indexes.rows ?? []) as any[]) {
        const table = map.get(String(row.TABLE_NAME));
        if (!table) continue;
        const idxs = table.indexes as IndexInfo[];
        let idx = idxs.find((item) => item.name === String(row.INDEX_NAME));
        if (!idx) {
          idx = { name: String(row.INDEX_NAME), columns: [], unique: row.UNIQUENESS === 'UNIQUE', primary: row.CONSTRAINT_TYPE === 'P' };
          idxs.push(idx);
        }
        idx.columns.push(String(row.COLUMN_NAME));
        if (row.CONSTRAINT_TYPE === 'P') primaryCols.add(`${row.TABLE_NAME}.${row.COLUMN_NAME}`);
      }
      for (const row of (columns.rows ?? []) as any[]) {
        const table = map.get(String(row.TABLE_NAME));
        if (!table) continue;
        const dataType = String(row.DATA_TYPE);
        const charLen = Number(row.CHAR_LENGTH ?? row.DATA_LENGTH ?? 0);
        const precision = Number(row.DATA_PRECISION ?? 0);
        const scale = Number(row.DATA_SCALE ?? 0);
        let type = dataType;
        if (/CHAR|VARCHAR/i.test(dataType) && charLen > 0) type += `(${charLen})`;
        else if (dataType === 'NUMBER' && precision > 0) type += `(${precision}${scale ? `,${scale}` : ''})`;
        (table.columns as ColumnInfo[]).push({
          name: String(row.COLUMN_NAME),
          type,
          nullable: row.NULLABLE === 'Y',
          defaultValue: row.DATA_DEFAULT ?? null,
          primaryKey: primaryCols.has(`${row.TABLE_NAME}.${row.COLUMN_NAME}`),
          autoIncrement: row.IDENTITY_COLUMN === 'YES',
        });
      }
      const fkMap = new Map<string, ForeignKeyInfo>();
      for (const row of (fks.rows ?? []) as any[]) {
        const key = `${row.TABLE_NAME}.${row.CONSTRAINT_NAME}`;
        let fk = fkMap.get(key);
        if (!fk) {
          fk = { name: String(row.CONSTRAINT_NAME), columns: [], refTable: String(row.REF_TABLE), refColumns: [] };
          fkMap.set(key, fk);
        }
        fk.columns.push(String(row.COLUMN_NAME));
        fk.refColumns.push(String(row.REF_COLUMN));
      }
      for (const [key, fk] of fkMap) {
        map.get(key.split('.')[0])?.foreignKeys?.push(fk);
      }
      return [...map.values()];
    } catch (err: any) {
      throw new DbError(err.message, { code: 'ORACLE_METADATA_ERROR' });
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    const pool = await this.pool(opts.database);
    const connection = await pool.getConnection();
    try {
      const result = await connection.execute(sql, params as any[], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
        maxRows: opts.maxRows && opts.maxRows > 0 ? opts.maxRows + 1 : undefined,
      });
      if (result.metaData?.length) {
        const columns = result.metaData.map((meta) => ({ name: meta.name, type: meta.dbTypeName }));
        const all = (result.rows ?? []) as Array<Record<string, unknown>>;
        const limit = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : all.length;
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
      return { columns: [], rows: [], rowCount: 0, affected: result.rowsAffected ?? 0, durationMs: Date.now() - started, statement: sql };
    } catch (err: any) {
      throw new DbError(err.message ?? 'Oracle 执行失败', { code: err.code ?? 'ORACLE_ERROR' });
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.close(0).catch(() => undefined)));
    this.pools.clear();
  }
}
