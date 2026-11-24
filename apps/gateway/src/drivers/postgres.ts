import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { ColumnInfo, Engine, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, estimateValueBytes, MAX_RESULT_BYTES } from './types';
import { wrapSelectLimit } from './sqlCap';
import { nodeTlsOptions } from './ssl';
import { throwIfAborted } from './timeout';

const { Pool: PgPool } = pg;

interface PgField {
  name: string;
  dataTypeID: number;
}
/**
 * 事件式流式 Query：提交前挂 'row' 监听且不带 callback 时，pg 不再把行累积进 result.rows
 * （见 pg/lib/query.js handleRowDescription 的 _accumulateRows 判定）。
 */
interface PgStreamQuery {
  on(event: 'row', listener: (row: Record<string, unknown>, result: { fields: PgField[] }) => void): PgStreamQuery;
  on(event: 'end', listener: (result: { fields: PgField[]; rowCount: number | null }) => void): PgStreamQuery;
  on(event: 'error', listener: (err: any) => void): PgStreamQuery;
}
const PgQuery = (pg as unknown as { Query: new (config: { text: string; values?: unknown[] }) => PgStreamQuery }).Query;

/** 查询默认超时；内省/test 等 pool.query 路径靠池级 statement_timeout 在服务端兜底。 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const METADATA_TIMEOUT_MS = 30000;
/** 备份恢复整段脚本的服务端上限（与网关 execScript 的 600s 约定对齐）。 */
const SCRIPT_TIMEOUT_MS = 600000;

export interface PgOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  sslInsecure?: boolean;
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

/** int2vector 在 node-postgres 里是字符串（如 "1 3"）；解析成有序 attnum。 */
function indexKeyColumns(indkey: unknown): number[] {
  const raw = Array.isArray(indkey) ? indkey.join(' ') : String(indkey ?? '');
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
}

export class PostgresDriver implements Driver {
  engine: Engine;
  private pools = new Map<string, Pool>();
  /** 跨请求事务：会话 id → 被固定的池内 client。 */
  private txClients = new Map<string, import('pg').PoolClient>();

  constructor(private opts: PgOptions, engine: Engine = 'postgresql') {
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
        ssl: nodeTlsOptions(this.opts),
        max: 3,
        connectionTimeoutMillis: 10000,
        // 会话级服务端兜底：内省/test 等直接 pool.query 的路径拿不到 client 句柄，
        // 无法逐句 SET/RESET，靠启动参数让服务端 30s 自动取消（57014）。
        // 用户查询在 runOnClient 里按 opts 覆盖，结束后 RESET 回落到这个默认值。
        statement_timeout: METADATA_TIMEOUT_MS,
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
      // 六条 catalog 查询互不依赖，并发发出；池子只有 3 条连接，多出来的排队而不是串行等待。
      // 列、索引、外键都只是补充信息：Greenplum/Redshift 等 PG 分支可能缺某个系统视图，
      // 不能因为一个查询失败就把整棵对象树判空。
      const empty = { rows: [] as any[] };
      const [tablesRes, columnsRes, indexesRes, attrsRes, fksRes, estRes, genRes] = await Promise.all([
        pool.query(
          `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ${SYSTEM_SCHEMAS} ORDER BY table_schema, table_name`,
        ),
        pool
          .query(
            `SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema NOT IN ${SYSTEM_SCHEMAS} ORDER BY table_schema, table_name, ordinal_position`,
          )
          .catch(() => empty),
        // indkey 是索引列 attnum 的有序列表；在 JS 里还原列名与顺序，避免依赖 PG 9.5+ 的 array_position。
        pool
          .query(`
        SELECT n.nspname AS schema, t.relname AS table, i.relname AS index, ix.indisunique AS unique,
               ix.indisprimary AS primary, ix.indkey AS indkey, ix.indrelid AS relid
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY t.relname, i.relname`)
          .catch(() => empty),
        pool
          .query(`
        SELECT a.attrelid AS relid, a.attnum, a.attname AS column
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE a.attnum > 0 AND NOT a.attisdropped AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`)
          .catch(() => empty),
        pool
          .query(`
        SELECT tc.table_schema AS schema, tc.table_name AS table, tc.constraint_name AS name,
               kcu.column_name AS column, ccu.table_name AS ref_table, ccu.column_name AS ref_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY tc.table_schema, tc.table_name, tc.constraint_name`)
          .catch(() => empty),
        pool
          .query(`
        SELECT n.nspname AS schema, c.relname AS table, c.reltuples AS estimate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`)
          .catch(() => empty),
        // attidentity 是 PG 10+、attgenerated 是 PG 12+；旧版本会报缺列，
        // 所以单独一条查询，失败只丢自增/生成列标记，不连普通列信息一起丢。
        pool
          .query(`
        SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, a.attidentity, a.attgenerated
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND (a.attidentity <> '' OR a.attgenerated <> '')
          AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`)
          .catch(() => empty),
      ]);
      let hypertables: Array<Record<string, any>> = [];
      if (this.engine === 'timescale') {
        try {
          const res = await pool.query(
            'SELECT hypertable_schema, hypertable_name, num_chunks FROM timescaledb_information.hypertables',
          );
          hypertables = res.rows as Array<Record<string, any>>;
        } catch {
          /* 实例未安装 timescaledb 扩展：按普通 PG 展示 */
        }
      }

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
      for (const r of hypertables) {
        const t = tables.get(`${r.hypertable_schema}.${r.hypertable_name}`);
        if (t) t.comment = `超表 · ${Number(r.num_chunks ?? 0)} chunks`;
      }
      const attributes = new Map<string, Map<number, string>>();
      for (const r of attrsRes.rows as Array<Record<string, any>>) {
        const relid = String(r.relid);
        const map = attributes.get(relid) ?? new Map<number, string>();
        map.set(Number(r.attnum), String(r.column));
        attributes.set(relid, map);
      }
      const primaryCols = new Map<string, Set<string>>();
      const indexMap = new Map<string, IndexInfo>();
      for (const r of indexesRes.rows as Array<Record<string, any>>) {
        const columns = attributes.get(String(r.relid));
        if (!columns) continue;
        const key = `${r.schema}.${r.table}.${r.index}`;
        let idx = indexMap.get(key);
        if (!idx) {
          idx = { name: r.index, columns: [], unique: Boolean(r.unique), primary: Boolean(r.primary) };
          indexMap.set(key, idx);
        }
        for (const attnum of indexKeyColumns(r.indkey)) {
          const column = columns.get(attnum);
          if (!column) continue;
          idx.columns.push(column);
          if (r.primary) {
            const tableKey = `${r.schema}.${r.table}`;
            const set = primaryCols.get(tableKey) ?? new Set<string>();
            set.add(column);
            primaryCols.set(tableKey, set);
          }
        }
      }
      // PG 10+ 的 identity 列与 PG 12+ 的生成列：结构树与 Agent 需要知道谁是自增。
      const generated = new Map<string, { autoIncrement: boolean; generated?: 'virtual' | 'stored' }>();
      for (const r of genRes.rows as Array<Record<string, any>>) {
        const identity = String(r.attidentity ?? '');
        const expression = String(r.attgenerated ?? '');
        if (!identity && !expression) continue;
        generated.set(`${r.schema}.${r.table}.${r.column}`, {
          autoIncrement: identity === 'a' || identity === 'd',
          generated: expression === 'v' ? 'virtual' : expression === 's' ? 'stored' : undefined,
        });
      }
      for (const r of columnsRes.rows as Array<Record<string, any>>) {
        const t = tables.get(`${r.table_schema}.${r.table_name}`);
        if (!t) continue;
        const pkSet = primaryCols.get(`${r.table_schema}.${r.table_name}`);
        const flag = generated.get(`${r.table_schema}.${r.table_name}.${r.column_name}`);
        (t.columns as ColumnInfo[]).push({
          name: r.column_name,
          type: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type,
          nullable: r.is_nullable === 'YES',
          defaultValue: r.column_default ?? null,
          primaryKey: Boolean(pkSet?.has(r.column_name)),
          autoIncrement: flag?.autoIncrement,
          generated: flag?.generated,
        });
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
      // 池级 statement_timeout 取消（57014）保留超时语义，其余按内省错误上报。
      if (err?.code === '57014') throw new DbError(`PostgreSQL 内省超时（${METADATA_TIMEOUT_MS}ms）`, { code: 'PG_TIMEOUT', status: 504 });
      throw new DbError(err.message, { code: 'PG_METADATA_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    // pg-pool 的 connectionTimeoutMillis 已覆盖排队等待；这里签出独占 client 才能 SET/RESET。
    const client = await this.pool(opts.database).connect();
    return this.runOnClient(client, sql, params, opts, started, false);
  }

  /**
   * 真超时 + 行数下推的统一执行路径。
   * 服务端：SET statement_timeout 让 PG 自己取消慢查询（57014）；
   * 客户端看门狗兜底（服务端无响应/网络黑洞时 SET 也救不了），非事务到期销毁 client，
   * 服务端查询随连接终止。事务内不销毁（会中止事务），且用 SET LOCAL——
   * 事务结束自动还原，语句被取消导致事务 aborted 时也不会残留会话设置。
   */
  private async runOnClient(
    client: import('pg').PoolClient,
    sql: string,
    params: unknown[],
    opts: RunOptions,
    started: number,
    inTx: boolean,
  ): Promise<QueryResult> {
    const ms = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_QUERY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!inTx) {
          destroyed = true;
          client.release(true);
        }
        reject(new DbError(`PostgreSQL 查询超时（${ms}ms）`, { code: 'PG_TIMEOUT', status: 504 }));
      }, ms);
    });
    try {
      await Promise.race([client.query(inTx ? `SET LOCAL statement_timeout = ${ms}` : `SET statement_timeout = ${ms}`), watchdog]);
      const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : 0;
      let pushed = maxRows > 0 ? wrapSelectLimit(sql, maxRows + 1, 'postgresql') : undefined;
      const markDestroyed = () => {
        destroyed = true;
      };
      let res: QueryResult;
      try {
        res = await Promise.race([this.streamCollect(client, pushed ?? sql, params, opts, started, inTx, markDestroyed), watchdog]);
      } catch (err: any) {
        // 外包一层子查询并非永远合法：重复列名（42701）、尾注释/特殊语法（42601）、
        // 列引用进不了子查询（42703）、不支持的特性（0A000）都回落原句，行数上限靠客户端裁剪。
        // 超时/取消不回落——原句只会跑得更久。
        if (pushed && ['42601', '42701', '42703', '0A000'].includes(err?.code)) {
          pushed = undefined;
          res = await Promise.race([this.streamCollect(client, sql, params, opts, started, inTx, markDestroyed), watchdog]);
        } else {
          throw err;
        }
      }
      // statement 始终回用户原句：下推包装句只用于执行，不能漏进图表 spec / 历史展示。
      res.statement = sql;
      return res;
    } catch (err: any) {
      // 57014 = statement_timeout 服务端取消，沿用超时语义而不是普通执行错误。
      // 流式路径已把原始错误包成 DbError（保留 SQLSTATE），必须先于 instanceof 判定。
      if (err?.code === '57014') throw new DbError(`PostgreSQL 查询超时（${ms}ms）`, { code: 'PG_TIMEOUT', status: 504 });
      if (err instanceof DbError) throw err;
      throw new DbError(err?.message ?? 'PostgreSQL 执行失败', { code: err?.code ?? 'PG_ERROR' });
    } finally {
      if (timer) clearTimeout(timer);
      if (!inTx && !destroyed) {
        try {
          await client.query('RESET statement_timeout');
          client.release();
        } catch {
          // RESET 失败说明 client 状态不可信（连接已断/事务异常），销毁不回池，
          // 避免把改过的 statement_timeout 泄漏给下一个使用者。
          client.release(true);
        }
      }
    }
  }

  /**
   * 流式收集查询结果：逐行保留、行数 + 字节双上限，超限即停（对齐 mysql.ts streamCollect）。
   * 非事务超限销毁 client（服务端查询随连接终止）；事务内不能销毁，剩余行只排空不保留。
   */
  private streamCollect(
    client: import('pg').PoolClient,
    sql: string,
    params: unknown[],
    opts: RunOptions,
    started: number,
    inTx: boolean,
    markDestroyed: () => void,
  ): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : Number.POSITIVE_INFINITY;
      const columns: Array<{ name: string; type: string }> = [];
      const rows: unknown[][] = [];
      let bytes = 0;
      let truncated = false;
      let settled = false;
      let affected: number | undefined;

      const pushFields = (fields: PgField[]) => {
        for (const f of fields) columns.push({ name: f.name, type: OIDS[f.dataTypeID] ?? String(f.dataTypeID) });
      };
      const finish = (result?: { fields: PgField[]; rowCount: number | null }) => {
        if (settled) return;
        settled = true;
        if (!columns.length && result?.fields?.length) pushFields(result.fields);
        if (result?.rowCount != null) affected = result.rowCount;
        if (truncated && !inTx) {
          markDestroyed();
          client.release(true);
        }
        resolve({
          columns,
          rows,
          rowCount: rows.length,
          affected,
          durationMs: Date.now() - started,
          truncated,
          statement: sql,
        });
      };
      const stop = () => {
        truncated = true;
        // 事务里不能销毁 client：保持 'row' 监听排空剩余报文，'end' 时再结算。
        if (!inTx) finish();
      };

      const query = new PgQuery({ text: sql, values: params });
      query.on('row', (row, result) => {
        if (settled || truncated) return;
        if (!columns.length && result?.fields?.length) pushFields(result.fields);
        let size = 16;
        for (const key in row) size += estimateValueBytes(row[key]) + key.length;
        // 首行即使单独超预算也保留，否则用户什么都看不到；此后严格执行字节预算。
        if (rows.length >= maxRows || (rows.length > 0 && bytes + size > MAX_RESULT_BYTES)) {
          stop();
          return;
        }
        rows.push(columns.map((c) => row[c.name]));
        bytes += size;
        if (rows.length >= maxRows || bytes >= MAX_RESULT_BYTES) stop();
      });
      query.on('error', (err: any) => {
        if (settled) return;
        settled = true;
        reject(new DbError(err?.message ?? 'PostgreSQL 执行失败', { code: err?.code ?? 'PG_ERROR' }));
      });
      query.on('end', (result) => finish(result));
      try {
        (client.query as (q: PgStreamQuery) => unknown)(query);
      } catch (err: any) {
        if (!settled) {
          settled = true;
          reject(new DbError(err?.message ?? 'PostgreSQL 执行失败', { code: err?.code ?? 'PG_ERROR' }));
        }
      }
    });
  }

  /** 开启跨请求事务：从连接池签出一条 client 固定住，后续语句都走它。 */
  async beginTransaction(sessionId: string, database?: string): Promise<void> {
    if (this.txClients.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    const client = await this.pool(database).connect();
    try {
      await client.query('BEGIN');
    } catch (err: any) {
      client.release();
      throw new DbError(err?.message ?? '开启事务失败', { code: 'TX_BEGIN' });
    }
    this.txClients.set(sessionId, client);
  }

  async runInTransaction(sessionId: string, sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const client = this.txClients.get(sessionId);
    if (!client) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const started = Date.now();
    return this.runOnClient(client, sql, params, opts, started, true);
  }

  async commitTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, 'COMMIT');
  }

  async rollbackTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, 'ROLLBACK');
  }

  private async finishTransaction(sessionId: string, command: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    const client = this.txClients.get(sessionId);
    if (!client) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    this.txClients.delete(sessionId);
    try {
      await client.query(command);
    } catch (err: any) {
      throw new DbError(err?.message ?? `${command === 'COMMIT' ? '提交' : '回滚'}事务失败`, {
        code: command === 'COMMIT' ? 'TX_COMMIT' : 'TX_ROLLBACK',
      });
    } finally {
      client.release();
    }
  }

  /** 备份恢复用：PG 的 simple query 一次往返执行整段脚本，脚本内任一语句失败整段回滚。 */
  async execScript(sql: string, database?: string, opts: RunOptions = {}): Promise<void> {
    throwIfAborted(opts.signal);
    let client: PoolClient | undefined;
    const onAbort = () => client?.connection?.stream?.destroy();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let ok = false;
    try {
      client = await this.pool(database).connect();
      throwIfAborted(opts.signal);
      // 池默认 statement_timeout 是内省用的 30s，恢复脚本的大语句必须放宽，否则中途被 57014 掐断。
      await client.query(`SET statement_timeout = ${SCRIPT_TIMEOUT_MS}`);
      await client.query(sql);
      throwIfAborted(opts.signal);
      ok = true;
    } catch (err: any) {
      if (opts.signal?.aborted) {
        ok = false;
        throw new DbError('工具执行已取消', { code: 'ABORTED' });
      }
      throw new DbError(err?.message ?? 'PostgreSQL 脚本执行失败', { code: err?.code ?? 'PG_SCRIPT_ERROR' });
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (ok && client) {
        try {
          await client.query('RESET statement_timeout');
          client.release();
        } catch {
          client.release(true);
        }
      } else {
        // 脚本失败后 client 可能停在 aborted 事务/断连状态，RESET 不可靠，直接销毁。
        client?.release(true);
      }
    }
  }

  /** 连接被回收前先回滚，避免事务悬挂占着连接。 */
  async close(): Promise<void> {
    for (const [sessionId] of this.txClients) {
      await this.finishTransaction(sessionId, 'ROLLBACK').catch(() => undefined);
    }
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}
