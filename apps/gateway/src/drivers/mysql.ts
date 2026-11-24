import mysql from 'mysql2/promise';
import type { Connection, Pool, PoolConnection, FieldPacket, ResultSetHeader } from 'mysql2/promise';
import type { Readable } from 'node:stream';
import { engineMeta } from '@aidb/core';
import type { ColumnInfo, Engine, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo } from '@aidb/core';
import type { DriverTestResult, RowBatch, RowStreamDriver, RunOptions } from './types';
import { DbError, estimateRowBytes, estimateValueBytes, MAX_RESULT_BYTES } from './types';
import { injectMaxExecutionTime } from './sqlCap';
import { nodeTlsOptions } from './ssl';
import { throwIfAborted } from './timeout';

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  sslInsecure?: boolean;
  /** 会话级 innodb_lock_wait_timeout（毫秒），DML 锁等待的服务端上限；默认 30s。 */
  lockWaitTimeoutMs?: number;
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

/**
 * 保留结果的累计字节上限见 types.ts 的 MAX_RESULT_BYTES（各驱动共用）。
 * 全保真流式读取（备份/迁移）的批预算：按字节切批，行数只是辅助上限。
 */
const ROW_BATCH_BYTES = 4 * 1024 * 1024;
const ROW_BATCH_ROWS = 2000;
/** 查询/内省的默认超时：mysql2 的 query() 没有 timeout 选项，真超时靠提示 + 看门狗组合。 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const METADATA_TIMEOUT_MS = 30000;
/** 池排队上限：连接全被慢查询占住时，新请求不能无限排队。 */
const POOL_ACQUIRE_TIMEOUT_MS = 10000;
const DEFAULT_LOCK_WAIT_MS = 30000;

/** promise 包装的 query() 只返回 Promise（全量缓冲）；流式必须走底层连接的 Query.stream()。 */
interface RawQuery {
  stream(options?: { highWaterMark?: number }): Readable;
  on(event: 'error', listener: (err: Error) => void): RawQuery;
}
interface RawConnection {
  query(options: { sql: string; values?: unknown[] }): RawQuery;
  destroy(): void;
}
function rawConnection(connection: PoolConnection): RawConnection {
  return ((connection as unknown as { connection?: RawConnection }).connection ?? connection) as RawConnection;
}

/** INSERT/UPDATE/DDL 的 OK 包（与数据行区分：列名恰好叫 affectedRows 的极端情况靠双字段判定排除）。 */
function isResultSetHeader(row: unknown): row is ResultSetHeader {
  return typeof row === 'object' && row !== null && !Array.isArray(row) && 'affectedRows' in row && 'insertId' in row;
}

export class MysqlDriver implements RowStreamDriver {
  engine: Engine;
  private pools = new Map<string, Pool>();
  /** 跨请求事务：会话 id → 被固定的连接。 */
  private txConnections = new Map<string, PoolConnection>();

  constructor(private opts: MysqlOptions, engine: Engine = 'mysql') {
    this.engine = engine;
  }

  /**
   * 流式收集查询结果：逐行解析、按行数 + 字节双上限保留，超限立即停止。
   * 不再用 pool.query() 全量缓冲——那会把整张 LONGTEXT 大表一次性吃进堆。
   */
  private streamCollect(
    connection: PoolConnection,
    sql: string,
    params: unknown[],
    opts: RunOptions,
    started: number,
    inTx: boolean,
  ): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : Number.POSITIVE_INFINITY;
      const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_QUERY_TIMEOUT_MS;
      const columns: Array<{ name: string; type: string }> = [];
      const rows: unknown[][] = [];
      let bytes = 0;
      let truncated = false;
      let header: ResultSetHeader | undefined;
      let settled = false;

      // 服务端上限：MAX_EXECUTION_TIME 提示让 MySQL 自己掐掉慢 SELECT（含事务内）；
      // 不识别提示的协议实现由下面的客户端看门狗兜底。statement 字段保留用户原句。
      const execSql = injectMaxExecutionTime(sql, timeoutMs, 'mysql');
      const query = rawConnection(connection).query({ sql: execSql, values: params });
      const stream = query.stream({ highWaterMark: 16 });

      // 客户端看门狗：到期 reject 并销毁连接（服务端查询随连接终止）。
      // 事务内不能销毁连接（会中止事务），DML 锁等待靠会话级 innodb_lock_wait_timeout。
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.destroy();
        query.on('error', () => {});
        if (!inTx) connection.destroy();
        reject(new DbError(`MySQL 查询超时（${timeoutMs}ms）`, { code: 'MYSQL_TIMEOUT', status: 504 }));
      }, timeoutMs);

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (truncated) {
          stream.destroy();
          // 提前中止后查询仍可能报错（超时/断连），没有接收者的 'error' 事件会直接炸进程。
          query.on('error', () => {});
          // 事务里不能销毁连接（会中止事务）：剩余报文自然排空，后续语句排队等待。
          if (!inTx) connection.destroy();
        }
        if (header && !columns.length) {
          resolve({
            columns: [],
            rows: [],
            rowCount: 0,
            affected: header.affectedRows ?? 0,
            lastInsertId: header.insertId,
            durationMs: Date.now() - started,
            statement: sql,
          });
          return;
        }
        resolve({
          columns,
          rows,
          rowCount: rows.length,
          durationMs: Date.now() - started,
          truncated,
          statement: sql,
        });
      };

      stream.on('fields', (fields: FieldPacket[]) => {
        for (const f of fields) columns.push({ name: f.name, type: MYSQL_TYPES[f.type ?? -1] ?? String(f.type ?? '') });
      });
      stream.on('data', (row: unknown) => {
        if (settled) return;
        if (isResultSetHeader(row)) {
          header = row;
          return;
        }
        const record = row as Record<string, unknown>;
        let size = 16;
        for (const key in record) size += estimateValueBytes(record[key]) + key.length;
        // 首行即使单独超预算也保留，否则用户什么都看不到；此后严格执行字节预算。
        if (rows.length >= maxRows || (rows.length > 0 && bytes + size > MAX_RESULT_BYTES)) {
          truncated = true;
          settle();
          return;
        }
        rows.push(columns.map((c) => record[c.name]));
        bytes += size;
        if (rows.length >= maxRows || bytes >= MAX_RESULT_BYTES) {
          truncated = true;
          settle();
        }
      });
      stream.on('error', (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DbError(err?.message ?? 'MySQL 执行失败', { code: err?.code ?? 'MYSQL_ERROR' }));
      });
      stream.on('end', settle);
    });
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
        ssl: nodeTlsOptions(this.opts),
        waitForConnections: true,
        // describe 的 4 条附属内省并发各占一条连接，3 条会让内省自己排队触发排队超时。
        connectionLimit: 5,
        // 内省突发可开到 5 条，但闲时只留 2 条：接入实例 × 库很多时，
        // 远端 max_connections 不被每个库 5 条常驻 idle 连接吃满（超出 maxIdle 的归还即关）。
        maxIdle: 2,
        idleTimeout: 60000,
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

  /** 已初始化过会话变量的连接：每条物理连接只 SET 一次，避免每次查询多一个往返。 */
  private initialized = new WeakSet<PoolConnection>();
  /** 排队超时（单测可缩短）。 */
  private acquireTimeoutMs = POOL_ACQUIRE_TIMEOUT_MS;

  /**
   * 池获取 + 排队超时。竞态要点：超时 reject 后连接可能迟到，必须 release 归还，
   * 否则池子被永久占掉一个名额（mysql2 不会替我们回收排队成功后才交付的连接）。
   */
  private async acquire(pool: Pool): Promise<PoolConnection> {
    const pending = pool.getConnection();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const connection = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DbError(`MySQL 连接池排队超时（${this.acquireTimeoutMs}ms）`, { code: 'POOL_TIMEOUT', status: 504 })),
            this.acquireTimeoutMs,
          );
        }),
      ]);
      if (!this.initialized.has(connection)) {
        this.initialized.add(connection);
        // Doris/StarRocks 等没有 innodb_lock_wait_timeout，SET 失败不能影响连接可用性。
        const lockWaitMs = this.opts.lockWaitTimeoutMs && this.opts.lockWaitTimeoutMs > 0 ? this.opts.lockWaitTimeoutMs : DEFAULT_LOCK_WAIT_MS;
        try {
          await connection.query(`SET SESSION innodb_lock_wait_timeout = ${Math.max(1, Math.ceil(lockWaitMs / 1000))}`);
        } catch {
          /* 协议实现不支持该会话变量时忽略 */
        }
      }
      return connection;
    } catch (err) {
      pending.then((late) => late.release()).catch(() => undefined);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 内省查询专用：独占连接 + 看门狗，到期销毁连接真正终止服务端查询。
   * 不走 pool.query()——它拿不到连接句柄，超时后只能弃结果、连接仍被慢查询占住。
   */
  private async metadataQuery(pool: Pool, sql: string, params: unknown[] = []): Promise<[any, any]> {
    const connection = await this.acquire(pool);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        connection.query(injectMaxExecutionTime(sql, METADATA_TIMEOUT_MS, 'mysql'), params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            connection.destroy();
            reject(new DbError(`MySQL 内省超时（${METADATA_TIMEOUT_MS}ms）`, { code: 'MYSQL_TIMEOUT', status: 504 }));
          }, METADATA_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // 被销毁的连接 _pool 已置空，release 是空操作。
      connection.release();
    }
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const [rows] = await this.metadataQuery(this.pool(), 'SELECT VERSION() AS v');
      const v = (rows as Array<{ v: string }>)[0]?.v;
      return { ok: true, version: `${engineMeta(this.engine).label} ${v}`, latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    }
  }

  async listDatabases(): Promise<string[]> {
    try {
      const [rows] = await this.metadataQuery(this.pool(), 'SHOW DATABASES');
      return (rows as Array<Record<string, string>>).map((r) => r.Database ?? Object.values(r)[0]);
    } catch {
      // 部分 MySQL 协议实现/受限账号不开放 SHOW DATABASES；information_schema 是标准回落。
      const [rows] = await this.metadataQuery(this.pool(), 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
      return (rows as Array<Record<string, string>>).map((r) => r.SCHEMA_NAME ?? Object.values(r)[0]);
    }
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const db = database ?? this.opts.database;
    if (!db) {
      // 这句是「本次请求没带库」，不是「这条连接没配库」——连接可以完全不配默认库，
      // 那是合法配置（侧栏逐库展开就是靠 /databases + 每次带 database 走）。
      // 原文案写成「连接未指定数据库」，用户会去改连接配置，而真正缺的是调用方的参数。
      throw new DbError('MySQL 内省必须指定数据库', {
        code: 'NO_DATABASE',
        hint: '调用方未提供 database 参数，且该连接没有默认库。先取 /connections/:id/databases，再带 ?database= 重试。',
      });
    }
    const pool = this.pool(db);
    try {
      const [tableRows] = await this.metadataQuery(
        pool,
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [db],
      );
      // 列/索引/外键是补充信息。Doris、StarRocks、GBase 8a 等 MySQL 协议实现
      // 并非每张 information_schema 表都齐全，单表缺失不应让对象树整体为空。
      const optionalRows = async (sql: string): Promise<Array<Record<string, any>>> => {
        try {
          const [rows] = await this.metadataQuery(pool, sql, [db]);
          return Array.isArray(rows) ? (rows as Array<Record<string, any>>) : [];
        } catch {
          return [];
        }
      };
      // 四条附属查询互不依赖，并发跑；每条各占一条连接，超出的排队而不是串行等待。
      const [columnRows, indexRows, fkRows, fkRuleRows] = await Promise.all([
        optionalRows(
          'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
        ),
        optionalRows(
          'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE, INDEX_COMMENT FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
        ),
        optionalRows(
          'SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, REFERENCED_TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME',
        ),
        optionalRows(
          'SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?',
        ),
      ]);
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
      // 超时/排队错误自带语义码，不能被内省错误码覆盖。
      if (err instanceof DbError) throw err;
      throw new DbError(err.message, { code: 'MYSQL_METADATA_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    let connection: PoolConnection;
    try {
      connection = await this.acquire(this.pool(opts.database));
    } catch (err: any) {
      throw err instanceof DbError ? err : new DbError(err?.message ?? 'MySQL 连接失败', { code: err?.code ?? 'MYSQL_ERROR' });
    }
    try {
      return await this.streamCollect(connection, sql, params, opts, started, false);
    } catch (err: any) {
      throw err instanceof DbError ? err : new DbError(err?.message ?? 'MySQL 执行失败', { code: err?.code ?? 'MYSQL_ERROR' });
    } finally {
      // 被截断销毁的连接 _pool 已置空，release 是空操作；正常连接归还池子。
      connection.release();
    }
  }

  /**
   * 全保真逐批读取：备份/迁移不能截断数据，也不能整表进堆。
   * 消费方每拉一批才解析下一批（流背压），提前退出会销毁连接。
   * 空表也 yield 一个带 columns 的空批，调用方据此拿列信息。
   */
  async *iterateRows(sql: string, params: unknown[] = [], opts: RunOptions = {}): AsyncGenerator<RowBatch> {
    if (opts.signal?.aborted) throw new DbError('工具执行已取消', { code: 'ABORTED' });
    const connection = await this.acquire(this.pool(opts.database));
    if (opts.signal?.aborted) {
      connection.destroy();
      throw new DbError('工具执行已取消', { code: 'ABORTED' });
    }
    const query = rawConnection(connection).query({ sql, values: params });
    const stream = query.stream({ highWaterMark: 8 });
    let columns: Array<{ name: string; type: string }> = [];
    stream.on('fields', (fields: FieldPacket[]) => {
      columns = fields.map((f) => ({ name: f.name, type: MYSQL_TYPES[f.type ?? -1] ?? String(f.type ?? '') }));
    });
    const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : Number.POSITIVE_INFINITY;
    // 全保真读取不能用总时长看门狗（大表备份合法地跑很久）：用「逐行空闲」计时，
    // 服务端停止吐行才判超时，销毁连接终止查询。
    const idleMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_QUERY_TIMEOUT_MS;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stream.destroy(new DbError(`MySQL 流式读取超时（${idleMs}ms 无数据）`, { code: 'MYSQL_TIMEOUT', status: 504 }));
      }, idleMs);
    };
    armIdle();
    const onAbort = () => stream.destroy(new DbError('工具执行已取消', { code: 'ABORTED' }));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let batch: unknown[][] = [];
    let batchBytes = 0;
    let rowCount = 0;
    let yielded = false;
    let drained = false;
    stream.on('end', () => {
      drained = true;
    });
    try {
      for await (const row of stream) {
        if (opts.signal?.aborted) throw new DbError('工具执行已取消', { code: 'ABORTED' });
        armIdle();
        if (isResultSetHeader(row)) continue;
        if (rowCount >= maxRows) break;
        const record = row as Record<string, unknown>;
        const arrayRow = columns.map((c) => record[c.name]);
        batch.push(arrayRow);
        batchBytes += estimateRowBytes(arrayRow);
        rowCount += 1;
        if (batch.length >= ROW_BATCH_ROWS || batchBytes >= ROW_BATCH_BYTES) {
          yielded = true;
          yield { columns, rows: batch };
          batch = [];
          batchBytes = 0;
        }
      }
      if (opts.signal?.aborted) throw new DbError('工具执行已取消', { code: 'ABORTED' });
      if (batch.length || !yielded) {
        yielded = true;
        yield { columns, rows: batch };
      }
    } catch (err: any) {
      throw err instanceof DbError ? err : new DbError(err?.message ?? 'MySQL 流式读取失败', { code: err?.code ?? 'MYSQL_ERROR' });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      stream.destroy();
      query.on('error', () => {});
      if (drained) connection.release();
      else connection.destroy();
    }
  }

  /** 开启跨请求事务：从连接池取一条连接固定下来，后续查询都走它。 */
  async beginTransaction(sessionId: string, database?: string): Promise<void> {
    if (this.txConnections.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    const connection = await this.acquire(this.pool(database));
    try {
      await connection.beginTransaction();
    } catch (err: any) {
      connection.release();
      throw new DbError(err?.message ?? '开启事务失败', { code: 'TX_BEGIN' });
    }
    this.txConnections.set(sessionId, connection);
  }

  /** 事务内执行：复用固定连接，结果映射与普通查询一致。 */
  async runInTransaction(sessionId: string, sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const connection = this.txConnections.get(sessionId);
    if (!connection) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const started = Date.now();
    try {
      return await this.streamCollect(connection, sql, params, opts, started, true);
    } catch (err: any) {
      throw err instanceof DbError ? err : new DbError(err?.message ?? 'MySQL 事务执行失败', { code: err?.code ?? 'MYSQL_ERROR' });
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
      throw new DbError(err?.message ?? `${mode === 'commit' ? '提交' : '回滚'}事务失败`, { code: mode === 'commit' ? 'TX_COMMIT' : 'TX_ROLLBACK' });
    } finally {
      connection.release();
    }
  }

  /** 连接被回收前必须回滚，避免事务悬挂占用连接。 */
  /**
   * 备份恢复用：一批语句一次往返。
   * 主池固定 multipleStatements:false（普通查询不该被拼接成语句流），脚本走这条一次性连接。
   */
  async execScript(sql: string, database?: string, opts: RunOptions = {}): Promise<void> {
    throwIfAborted(opts.signal);
    let connection: Connection | undefined;
    const onAbort = () => connection?.destroy();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      connection = await mysql.createConnection({
        host: this.opts.host,
        port: this.opts.port,
        user: this.opts.user,
        password: this.opts.password,
        database: database || this.opts.database || undefined,
        ssl: nodeTlsOptions(this.opts),
        connectTimeout: 10000,
        multipleStatements: true,
      });
      throwIfAborted(opts.signal);
      const active = connection;
      await active.query(sql);
      throwIfAborted(opts.signal);
    } catch (err: any) {
      if (opts.signal?.aborted) throw new DbError('工具执行已取消', { code: 'ABORTED' });
      throw new DbError(err?.message ?? 'MySQL 脚本执行失败', { code: err?.code ?? 'MYSQL_SCRIPT_ERROR' });
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await connection?.end().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const [sessionId] of this.txConnections) {
      await this.finishTransaction(sessionId, 'rollback').catch(() => undefined);
    }
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}
