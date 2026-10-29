import dmdb from 'dmdb';
import type { ColumnInfo, Engine, IndexInfo, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError } from './types';

export interface DmOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
}

function metaList(metaData: unknown): dmdb.Metadata[] {
  if (!Array.isArray(metaData) || !metaData.length) return [];
  return (Array.isArray(metaData[0]) ? metaData[0] : metaData) as dmdb.Metadata[];
}

function rowsOf(result: { rows?: unknown[] }): Array<Record<string, unknown>> {
  return (result.rows ?? []) as Array<Record<string, unknown>>;
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const lob = value as { getData?: () => Promise<unknown> };
    if (typeof lob.getData === 'function') return '<lob>';
    return value;
  }
  return value;
}

function dmHint(err: any): string | undefined {
  const message = String(err?.message ?? '');
  if (/digital envelope routines|ERR_OSSL_EVP_UNSUPPORTED/i.test(message)) {
    return '达梦驱动使用 DES-CFB 登录加密，需要 Node 启动参数 --openssl-legacy-provider；桌面端 Bridge 已内置，独立部署请添加该参数';
  }
  return undefined;
}

export class DmDriver implements Driver {
  engine: Engine = 'dm';
  private poolClient?: dmdb.Pool;
  private connecting?: Promise<dmdb.Pool>;
  /** 跨请求事务：会话 id → 被固定的池内连接。 */
  private txConnections = new Map<string, dmdb.Connection>();

  constructor(private opts: DmOptions) {}

  private async pool(): Promise<dmdb.Pool> {
    if (this.poolClient) return this.poolClient;
    if (!this.connecting) {
      const user = encodeURIComponent(this.opts.user ?? 'SYSDBA');
      const password = encodeURIComponent(this.opts.password ?? '');
      const connectString = `dm://${user}:${password}@${this.opts.host || '127.0.0.1'}:${this.opts.port || 5236}`;
      this.connecting = dmdb
        .createPool({
          connectString,
          poolMax: 3,
          poolMin: 0,
          poolTimeout: 60,
          testOnBorrow: true,
          validationQuery: 'SELECT 1 FROM DUAL',
        })
        .then((pool) => {
          this.poolClient = pool;
          return pool;
        })
        .catch((err) => {
          this.connecting = undefined;
          throw err;
        });
    }
    return this.connecting;
  }

  private async withConnection<T>(fn: (connection: dmdb.Connection) => Promise<T>): Promise<T> {
    const pool = await this.pool();
    const connection = await pool.getConnection();
    try {
      return await fn(connection);
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  private async execute(sql: string, params: unknown[], opts: RunOptions = {}): Promise<{ result: dmdb.Result<Record<string, unknown>>; columns: { name: string; type?: string }[] }> {
    return this.withConnection(async (connection) => {
      const result = (await connection.execute(sql, params, {
        autoCommit: true,
        maxRows: opts.maxRows,
        outFormat: dmdb.OUT_FORMAT_OBJECT,
      })) as dmdb.Result<Record<string, unknown>>;
      const columns = metaList(result.metaData).map((meta) => ({ name: meta.name, type: meta.dbTypeName }));
      return { result, columns };
    });
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      await this.withConnection(async (connection) => {
        await connection.ping();
        await connection.execute('SELECT 1 AS ok FROM DUAL');
      });
      return { ok: true, version: '达梦 DM8', latencyMs: Date.now() - started };
    } catch (err: any) {
      const hint = dmHint(err);
      return { ok: false, latencyMs: Date.now() - started, message: `${err?.message ?? '连接失败'}${hint ? `（${hint}）` : ''}` };
    }
  }

  async listDatabases(): Promise<string[]> {
    try {
      const { result } = await this.execute('SELECT DISTINCT OWNER AS NAME FROM ALL_TABLES ORDER BY OWNER', [], { maxRows: 500 });
      const names = (result.rows ?? []).map((row) => String(row.NAME ?? row.name ?? '').trim()).filter(Boolean);
      if (names.length) return names;
    } catch {
      /* fall through to current user */
    }
    const { result } = await this.execute('SELECT USER AS NAME FROM DUAL', [], { maxRows: 1 });
    return [String(result.rows?.[0]?.NAME ?? result.rows?.[0]?.name ?? 'SYSDBA')];
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const schema = (database || this.opts.database || (await this.currentUser())).toUpperCase();
    try {
      return await this.withConnection(async (connection) => {
        const tables = await connection.execute(
          'SELECT TABLE_NAME AS NAME, NUM_ROWS AS ROW_EST FROM ALL_TABLES WHERE OWNER = ? ORDER BY TABLE_NAME',
          [schema],
          { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 5000 },
        );
        const views = await connection.execute(
          'SELECT VIEW_NAME AS NAME FROM ALL_VIEWS WHERE OWNER = ? ORDER BY VIEW_NAME',
          [schema],
          { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 5000 },
        );
        const columns = await connection.execute(
          `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE, DATA_DEFAULT
           FROM ALL_TAB_COLUMNS WHERE OWNER = ? ORDER BY TABLE_NAME, COLUMN_ID`,
          [schema],
          { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 100000 },
        );
        const indexes = await connection.execute(
          `SELECT i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, c.COLUMN_NAME, c.COLUMN_POSITION
           FROM ALL_INDEXES i
           JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME
           WHERE i.OWNER = ? ORDER BY i.TABLE_NAME, i.INDEX_NAME, c.COLUMN_POSITION`,
          [schema],
          { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 100000 },
        );
        const primary = await connection.execute(
          `SELECT cc.TABLE_NAME, cc.COLUMN_NAME
           FROM ALL_CONSTRAINTS c
           JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
           WHERE c.OWNER = ? AND c.CONSTRAINT_TYPE = 'P'`,
          [schema],
          { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 100000 },
        );

        const viewNames = new Set(rowsOf(views).map((row) => String(row.NAME ?? row.name)));
        const columnsByTable = new Map<string, ColumnInfo[]>();
        const pkByTable = new Map<string, Set<string>>();
        for (const row of rowsOf(primary)) {
          const table = String(row.TABLE_NAME ?? row.table_name ?? '');
          const column = String(row.COLUMN_NAME ?? row.column_name ?? '');
          if (!pkByTable.has(table)) pkByTable.set(table, new Set());
          pkByTable.get(table)!.add(column);
        }
        for (const row of rowsOf(columns)) {
          const table = String(row.TABLE_NAME ?? row.table_name ?? '');
          const name = String(row.COLUMN_NAME ?? row.column_name ?? '');
          const dataType = String(row.DATA_TYPE ?? row.data_type ?? '');
          const precision = Number(row.DATA_PRECISION ?? row.data_precision ?? 0);
          const scale = Number(row.DATA_SCALE ?? row.data_scale ?? 0);
          const type = /NUMBER|DECIMAL|NUMERIC/i.test(dataType) && precision
            ? `${dataType}(${precision}${scale ? `,${scale}` : ''})`
            : dataType;
          const list = columnsByTable.get(table) ?? [];
          list.push({
            name,
            type,
            nullable: String(row.NULLABLE ?? row.nullable ?? 'Y').toUpperCase() === 'Y',
            defaultValue:
              row.DATA_DEFAULT === undefined || row.DATA_DEFAULT === null || String(row.DATA_DEFAULT).toLowerCase() === 'null'
                ? null
                : String(row.DATA_DEFAULT),
            primaryKey: pkByTable.get(table)?.has(name) ?? false,
            autoIncrement: false,
          });
          columnsByTable.set(table, list);
        }
        const indexesByTable = new Map<string, IndexInfo[]>();
        for (const row of rowsOf(indexes)) {
          const table = String(row.TABLE_NAME ?? row.table_name ?? '');
          const name = String(row.INDEX_NAME ?? row.index_name ?? '');
          const list = indexesByTable.get(table) ?? [];
          let index = list.find((item) => item.name === name);
          if (!index) {
            index = { name, columns: [], unique: String(row.UNIQUENESS ?? row.uniqueness ?? '').toUpperCase() === 'UNIQUE', primary: false };
            list.push(index);
          }
          index.columns.push(String(row.COLUMN_NAME ?? row.column_name ?? ''));
          indexesByTable.set(table, list);
        }

        const tablesList: TableInfo[] = [];
        for (const row of rowsOf(tables)) {
          const name = String(row.NAME ?? row.name ?? '');
          tablesList.push({
            name,
            type: viewNames.has(name) ? 'view' : 'table',
            schema,
            rowEstimate: row.ROW_EST === undefined || row.ROW_EST === null ? undefined : Number(row.ROW_EST),
            columns: columnsByTable.get(name) ?? [],
            indexes: indexesByTable.get(name) ?? [],
          });
        }
        for (const name of viewNames) {
          if (!tablesList.some((table) => table.name === name)) {
            tablesList.push({ name, type: 'view', schema, columns: columnsByTable.get(name) ?? [] });
          }
        }
        return tablesList.sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (err: any) {
      throw new DbError(err?.message ?? `无法读取达梦 schema ${schema}`, { code: err?.errCode ? `DM_${err.errCode}` : 'DM_ERROR', hint: dmHint(err) });
    }
  }

  private async currentUser(): Promise<string> {
    const { result } = await this.execute('SELECT USER AS NAME FROM DUAL', [], { maxRows: 1 });
    return String(result.rows?.[0]?.NAME ?? result.rows?.[0]?.name ?? 'SYSDBA');
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    try {
      const { result, columns } = await this.execute(sql, params, opts);
      const rows = (result.rows ?? []).map((row) => columns.map((column) => normalizeValue(row[column.name])));
      return {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
        affected: result.rowsAffected,
        statement: sql,
      };
    } catch (err: any) {
      throw new DbError(err?.message ?? '达梦执行失败', { code: err?.errCode ? `DM_${err.errCode}` : 'DM_ERROR', hint: dmHint(err) });
    }
  }

  /** 开启跨请求事务：固定一条池内连接，事务期间 autoCommit=false。 */
  async beginTransaction(sessionId: string, _database?: string): Promise<void> {
    if (this.txConnections.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    const pool = await this.pool();
    const connection = await pool.getConnection();
    this.txConnections.set(sessionId, connection);
  }

  async runInTransaction(sessionId: string, sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const connection = this.txConnections.get(sessionId);
    if (!connection) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const started = Date.now();
    try {
      const result = (await connection.execute(sql, params, {
        autoCommit: false,
        maxRows: opts.maxRows,
        outFormat: dmdb.OUT_FORMAT_OBJECT,
      })) as dmdb.Result<Record<string, unknown>>;
      const columns = metaList(result.metaData).map((meta) => ({ name: meta.name, type: meta.dbTypeName }));
      const rows = (result.rows ?? []).map((row) => columns.map((column) => normalizeValue(row[column.name])));
      return {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
        affected: result.rowsAffected,
        statement: sql,
      };
    } catch (err: any) {
      throw new DbError(err?.message ?? '达梦事务执行失败', { code: err?.errCode ? `DM_${err.errCode}` : 'DM_ERROR', hint: dmHint(err) });
    }
  }

  async commitTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, 'commit');
  }

  async rollbackTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, 'rollback');
  }

  private async finishTransaction(sessionId: string, mode: 'commit' | 'rollback'): Promise<void> {
    const connection = this.txConnections.get(sessionId);
    if (!connection) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    this.txConnections.delete(sessionId);
    try {
      if (mode === 'commit') await connection.commit();
      else await connection.rollback();
    } catch (err: any) {
      throw new DbError(err?.message ?? `${mode === 'commit' ? '提交' : '回滚'}事务失败`, {
        code: mode === 'commit' ? 'TX_COMMIT' : 'TX_ROLLBACK',
      });
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.txConnections.keys()]) {
      await this.finishTransaction(sessionId, 'rollback').catch(() => undefined);
    }
    await this.poolClient?.close().catch(() => undefined);
    this.poolClient = undefined;
    this.connecting = undefined;
  }
}
