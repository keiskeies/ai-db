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

/** ORA-00904：11g 上查询了 12c 才存在的列。 */
function missingColumn(err: any): boolean {
  return Number(err?.errorNum) === 904 || /ORA-00904/i.test(String(err?.message ?? ''));
}

const thickMode = { attempted: false, ready: false };

/** thin 模式最低支持 12.1；给了 Instant Client 目录就切到 thick 模式，11g 也能连。 */
function ensureThickMode(): void {
  if (thickMode.attempted) return;
  thickMode.attempted = true;
  const libDir = String(process.env.AIDB_ORACLE_CLIENT_DIR ?? '').trim();
  if (!libDir) return;
  try {
    oracledb.initOracleClient({ libDir });
    thickMode.ready = true;
  } catch {
    /* 初始化失败继续走 thin，连接报错时给出可执行的提示 */
  }
}

export function oracleVersionHint(err: any): string | undefined {
  const message = String(err?.message ?? '');
  if (!/not supported by node-oracledb in Thin mode|DPY-3050|server version/i.test(message)) return undefined;
  return thickMode.ready
    ? undefined
    : 'Oracle 11g 及以下需要 Oracle Instant Client（thick 模式）：设置 AIDB_ORACLE_CLIENT_DIR 指向解压目录后重启 Bridge，或升级到 12.1+';
}

export class OracleDriver implements Driver {
  engine = 'oracle' as const;
  private pools = new Map<string, oracledb.Pool>();
  /** 跨请求事务：会话 id → 被固定的池内连接。 */
  private txConnections = new Map<string, oracledb.Connection>();
  private owner: string;

  constructor(private opts: OracleOptions) {
    this.owner = (opts.user || '').toUpperCase();
  }

  private async pool(database?: string): Promise<oracledb.Pool> {
    ensureThickMode();
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
      const hint = oracleVersionHint(err);
      return { ok: false, latencyMs: Date.now() - started, message: hint ? `${err.message}（${hint}）` : err.message };
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async listDatabases(): Promise<string[]> {
    const pool = await this.pool();
    const connection = await pool.getConnection();
    try {
      let result;
      try {
        result = await connection.execute(
          "SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username",
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
      } catch (err) {
        // ORACLE_MAINTAINED 是 12c 新增列，11g 不认识。
        if (!missingColumn(err)) throw err;
        result = await connection.execute('SELECT username FROM all_users ORDER BY username', [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
      }
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
      // IDENTITY_COLUMN 是 12c 新增列；11g 先去掉它，至少把表与普通列显示出来。
      const columns: any = await (async () => {
        const sql = (identity: boolean) => `SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, DATA_PRECISION, DATA_SCALE,
                NULLABLE, DATA_DEFAULT${identity ? ', IDENTITY_COLUMN' : ', NULL AS IDENTITY_COLUMN'}
         FROM ALL_TAB_COLUMNS WHERE OWNER = :1 ORDER BY TABLE_NAME, COLUMN_ID`;
        try {
          return await connection.execute(sql(true), [this.owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        } catch (err) {
          if (!missingColumn(err)) return { rows: [] };
          try {
            return await connection.execute(sql(false), [this.owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });
          } catch {
            return { rows: [] };
          }
        }
      })();
      // 索引和外键只是补充信息：权限受限或旧版本视图缺失时，不能连带对象树一起失败。
      const indexes: any = await connection
        .execute(
          `SELECT i.OWNER, i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, c.COLUMN_NAME,
                (SELECT k.CONSTRAINT_TYPE FROM ALL_CONSTRAINTS k
                  WHERE k.OWNER = i.OWNER AND k.CONSTRAINT_NAME = i.INDEX_NAME AND k.TABLE_NAME = i.TABLE_NAME) AS CONSTRAINT_TYPE
         FROM ALL_INDEXES i
         JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME
         WHERE i.OWNER = :1 ORDER BY i.TABLE_NAME, i.INDEX_NAME, c.COLUMN_POSITION`,
          [this.owner],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        )
        .catch(() => ({ rows: [] }));
      const fks: any = await connection
        .execute(
          `SELECT c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, cc.COLUMN_NAME, rc.TABLE_NAME AS REF_TABLE, rcc.COLUMN_NAME AS REF_COLUMN
         FROM ALL_CONSTRAINTS c
         JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
         JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
         JOIN ALL_CONS_COLUMNS rcc ON rcc.OWNER = r.OWNER AND rcc.CONSTRAINT_NAME = r.CONSTRAINT_NAME AND rcc.POSITION = cc.POSITION
         WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = :1
         ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`,
          [this.owner],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        )
        .catch(() => ({ rows: [] }));

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
      if (opts.timeoutMs && opts.timeoutMs > 0) connection.callTimeout = opts.timeoutMs;
      const result = await connection.execute(sql, params as any[], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
        maxRows: opts.maxRows && opts.maxRows > 0 ? opts.maxRows + 1 : undefined,
      });
      return this.toResult(result, started, sql, opts.maxRows);
    } catch (err: any) {
      throw new DbError(err.message ?? 'Oracle 执行失败', { code: err.code ?? 'ORACLE_ERROR' });
    } finally {
      connection.callTimeout = 0;
      await connection.close().catch(() => undefined);
    }
  }

  private toResult(result: oracledb.Result<unknown>, started: number, sql: string, maxRows?: number): QueryResult {
    if (result.metaData?.length) {
      const columns = result.metaData.map((meta) => ({ name: meta.name, type: meta.dbTypeName }));
      const all = (result.rows ?? []) as Array<Record<string, unknown>>;
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
    return { columns: [], rows: [], rowCount: 0, affected: result.rowsAffected ?? 0, durationMs: Date.now() - started, statement: sql };
  }

  /** 开启跨请求事务：签出一条池内连接固定住，事务期间不自动提交。 */
  async beginTransaction(sessionId: string, database?: string): Promise<void> {
    if (this.txConnections.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    const pool = await this.pool(database);
    const connection = await pool.getConnection();
    this.txConnections.set(sessionId, connection);
  }

  async runInTransaction(sessionId: string, sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const connection = this.txConnections.get(sessionId);
    if (!connection) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const started = Date.now();
    try {
      if (opts.timeoutMs && opts.timeoutMs > 0) connection.callTimeout = opts.timeoutMs;
      const result = await connection.execute(sql, params as any[], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: false,
        maxRows: opts.maxRows && opts.maxRows > 0 ? opts.maxRows + 1 : undefined,
      });
      connection.callTimeout = 0;
      return this.toResult(result, started, sql, opts.maxRows);
    } catch (err: any) {
      throw new DbError(err.message ?? 'Oracle 事务执行失败', { code: err.code ?? 'ORACLE_ERROR' });
    }
  }

  async commitTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, true);
  }

  async rollbackTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, false);
  }

  private async finishTransaction(sessionId: string, commit: boolean): Promise<void> {
    const connection = this.txConnections.get(sessionId);
    if (!connection) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    this.txConnections.delete(sessionId);
    try {
      if (commit) await connection.commit();
      else await connection.rollback();
    } catch (err: any) {
      throw new DbError(err?.message ?? `${commit ? '提交' : '回滚'}事务失败`, { code: commit ? 'TX_COMMIT' : 'TX_ROLLBACK' });
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const [sessionId] of this.txConnections) {
      await this.finishTransaction(sessionId, false).catch(() => undefined);
    }
    await Promise.all([...this.pools.values()].map((pool) => pool.close(0).catch(() => undefined)));
    this.pools.clear();
  }
}
