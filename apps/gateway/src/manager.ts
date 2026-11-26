import {
  addField,
  applyLimit,
  classifyAql,
  classifyCql,
  classifyCypher,
  classifyMql,
  classifyRedis,
  classifySearch,
  classifyStatement,
  dialectOf,
  classifyVector,
  editsRecords,
  engineMeta,
  engineUsesSchema,
  formatStructuredQuery,
  hasUnsafeSqlSyntax,
  managesObjects,
  managesIndexes,
  parseRedisCommandLine,
  quoteIdent,
  quoteQualified,
  readonlyViolation,
  searchQueryFromArgs,
  splitStatements,
  supportsTransactions,
  vectorQueryFromArgs,
  writesLineProtocol,
  type AppSettings,
  type AqlQuery,
  type ConnectionConfig,
  type ConnectionSecret,
  type CqlQuery,
  type CypherQuery,
  type DatabaseSchema,
  type Engine,
  type MqlQuery,
  type QueryBatchResult,
  type QueryResult,
  type RedisKeyDetail,
  type RedisQuery,
  type SearchQuery,
  type StructuredQuery,
  type TableInfo,
  type VectorQuery,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { createDriver, DbError, type Driver } from './drivers';
import { throwIfAborted, withQueryTimeout } from './drivers/timeout';
import { GatewayEvents, type SchemaChangeCause } from './events';
import { normalizeMql } from './drivers/mongodb';
import type { CreateRedisKeyInput, RedisKeyDriver } from './drivers/types';
import { supportsCollectionIndexes, supportsDocumentRead, supportsDocumentWrite, supportsFieldAdd, supportsKeyDetail, supportsLineProtocol, supportsObjectCreate, supportsStructuredQuery, supportsTransaction, supportsVectorSearch, type DriverTestResult, type TransactionDriver } from './drivers/types';
import { embedText } from './embeddings';
import type { Store } from './store';

interface CachedDriver {
  driver: Driver;
  close: () => Promise<void>;
}

/**
 * 显式 allowMulti: true 脚本的无条件硬上限。allowMulti 只授权“逐条执行脚本”，
 * 不能关闭规模保护；超过 1000 条无论调用方是谁都拒绝。
 */
export const MAX_SCRIPT_HARD_STATEMENTS = 1000;

// ── 超时常量集中定义（G2）──────────────────────────────────────────────
// 各执行路径的超时口径不同，散落在调用点容易漏传（导出/质检曾完全没传）。
// 统一放这里并注明理由，调用方只引用常量，不再各写各的数字。

/** 导出查询：全表扫描 + 落盘，比交互查询慢，但仍是单条查询，不该像脚本那样长占连接。120s。 */
export const EXPORT_QUERY_TIMEOUT_MS = 120_000;
/** 整段脚本（备份恢复）：一个脚本可能含上千条 INSERT，单语句 30s 口径不适用，统一 600s。 */
export const EXEC_SCRIPT_TIMEOUT_MS = 600_000;
/** 质检 / 画像：COUNT DISTINCT 等全表聚合在大表上慢，但仍是单条查询。120s。 */
export const QUALITY_CHECK_TIMEOUT_MS = 120_000;
/** scheduler 任务级：产物/仪表板/备份任务挂死时必须释放运行槽，否则后续所有定时任务被永久阻塞。600s。 */
export const SCHEDULER_TASK_TIMEOUT_MS = 600_000;

/**
 * 这些引擎的 DDL 会**隐式提交**当前事务：在 BEGIN 里执行完 ALTER/CREATE，
 * 变更立刻对别的会话可见，事务边界不再保护它。
 *
 * 用来决定结构变更事件什么时候发：隐式提交的引擎必须当场发，否则用户会
 * 一直看着旧结构，直到他敲 COMMIT 或手动刷新；其余引擎推迟到 COMMIT 才对，
 * 提前发等于通知一个别处还看不到的结构。
 */
function implicitCommitDdl(engine: Engine): boolean {
  const dialect = dialectOf(engine);
  return dialect === 'mysql' || dialect === 'oracle' || dialect === 'dm';
}


export interface QueryOptions {
  database?: string;
  maxRows?: number;
  timeoutMs?: number;
  /** false/省略 = 最多一条可执行语句；只有显式 true 才允许逐条执行脚本。 */
  allowMulti?: boolean;
  autoLimit?: boolean;
  actor: 'user' | 'agent';
  /** 跨请求事务会话；存在时语句走被固定的那条连接。 */
  sessionId?: string;
  /** 复合写要求会话必须仍归属当前连接的有效事务，禁止静默回退到池连接。 */
  requireTransaction?: boolean;
  /** 执行追踪 id（G1）：路由生成并传入，客户端提前断开时据此取消，见 cancelExecution。 */
  executionId?: string;
  /** Agent stop / 请求断连信号；复合任务会把它贯通到每一批。 */
  signal?: AbortSignal;
}

type ExecutionOptions = Pick<QueryOptions, 'executionId' | 'signal' | 'sessionId' | 'timeoutMs'>;

export class ConnectionManager {
  private clients = new Map<string, CachedDriver>();
  /** 每个 connectionId 的在途创建 Promise：同一连接首次被并发请求时只建一次池/隧道。 */
  private inFlight = new Map<string, Promise<CachedDriver>>();
  /** 已 close/删除的连接 id：创建完成时若已被删除，立即关闭且不进缓存。 */
  private closedFlags = new Map<string, boolean>();
  /** 跨请求事务会话：会话 id → 连接与开始时间（用于超时回收）。 */
  private txSessions = new Map<
    string,
    { connectionId: string; database?: string; startedAt: number; lastUsedAt: number; schemaDirty?: boolean }
  >();
  private readonly txIdleMs: number;
  private txTimer?: NodeJS.Timeout;
  /**
   * 活动查询追踪（G1）：executionId → 占用的连接与事务归属。
   * 客户端提前断开时据此销毁连接，终止服务端仍在跑的查询；查询结束即移除。
   */
  private activeExecutions = new Map<string, { connectionId: string; sessionId?: string; inTx: boolean; abandoned?: boolean }>();
  /** 一次 Agent 工具调用会顺序执行多批查询；单批 finally 不能抹掉整次调用的取消态。 */
  private abandonedExecutions = new Set<string>();

  private throwIfAborted(opts: ExecutionOptions): void {
    throwIfAborted(opts.signal);
    if (opts.executionId && this.abandonedExecutions.has(opts.executionId)) {
      throw new DbError('工具执行已取消', { code: 'ABORTED' });
    }
  }

  private beginExecution(connectionId: string, opts: ExecutionOptions, inTx = false): void {
    this.throwIfAborted(opts);
    if (opts.executionId) {
      this.activeExecutions.set(opts.executionId, { connectionId, sessionId: inTx ? opts.sessionId : undefined, inTx });
    }
  }

  /** 直驱操作没有 SQL 批次循环，也必须像 query/runParams 一样可被 stop 定位并断开。 */
  private async trackWrite<T>(connectionId: string, opts: ExecutionOptions, write: (driver: Driver) => Promise<T>): Promise<T> {
    this.beginExecution(connectionId, opts);
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      if (opts.executionId) {
        const active = this.activeExecutions.get(opts.executionId);
        this.activeExecutions.delete(opts.executionId);
        if (active?.abandoned) this.abandonedExecutions.delete(opts.executionId);
      }
    };
    const work = (async () => {
      const driver = await this.driverFor(connectionId);
      this.throwIfAborted(opts);
      return write(driver);
    })();
    work.then(release, release);
    let onAbort: (() => void) | undefined;
    try {
      const result = opts.signal
        ? await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              onAbort = () => {
                if (opts.executionId) this.cancelExecution(opts.executionId);
                reject(new DbError('工具执行已取消', { code: 'ABORTED' }));
              };
              opts.signal!.addEventListener('abort', onAbort, { once: true });
              if (opts.signal!.aborted) onAbort();
            }),
          ])
        : await work;
      this.throwIfAborted(opts);
      return result;
    } finally {
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        const driver = this.clients.get(connectionId)?.driver;
        if (opts.signal?.aborted && driver) this.destroyDriverConnections(driver);
      }
    }
  }

  constructor(
    private store: Store,
    private config: GatewayConfig,
    private settings: () => AppSettings,
    // 可缺省：多个测试直接三参构造，事件总线只是通知通道，没有它功能照常。
    private events?: GatewayEvents,
  ) {
    this.txIdleMs = config.txIdleMs && config.txIdleMs > 0 ? config.txIdleMs : ConnectionManager.TX_IDLE_MS;
    this.txTimer = setInterval(() => {
      void this.reapIdleTransactions().catch(() => undefined);
    }, Math.max(200, Math.floor(this.txIdleMs / 2)));
    this.txTimer.unref?.();
  }

  private driverFor(connectionId: string): Promise<Driver> {
    const cached = this.clients.get(connectionId);
    if (cached) {
      this.store.touchConnection(connectionId);
      return Promise.resolve(cached.driver);
    }

    const pending = this.inFlight.get(connectionId);
    if (pending) return pending.then((bundle) => {
      if (this.closedFlags.get(connectionId)) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
      this.store.touchConnection(connectionId);
      return bundle.driver;
    });

    const created = this.createDriverCached(connectionId);
    this.inFlight.set(connectionId, created);
    return created.then((bundle) => bundle.driver);
  }

  private async createDriverCached(connectionId: string): Promise<CachedDriver> {
    // ConnectionManager 没有 createConnection/updateConnection 钩子（id 由 store 生成：
    // createConnection 一律 randomUUID 全新；updateConnection 复用 id 但经 routes 走
    // manager.close 后由下一次 driverFor 重建）。这里在真正重建前清除已关闭标记，
    // 使「更新连接后重新建池」不被 close 留下的标记永久阻塞；删除连接的场景 getConnection
    // 会先抛 CONNECTION_NOT_FOUND，不受影响。
    this.closedFlags.delete(connectionId);
    try {
      const conn = this.store.getConnection(connectionId);
      if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const secret = this.store.getConnectionSecret(connectionId);
      const bundle = await createDriver(conn, secret);
      if (this.closedFlags.get(connectionId)) {
        // 创建期间连接已被删除：立即关掉，绝不进缓存。
        await bundle.close().catch(() => undefined);
        throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
      }
      this.clients.set(connectionId, bundle);
      this.store.touchConnection(connectionId);
      return bundle;
    } finally {
      this.inFlight.delete(connectionId);
    }
  }

  async testSaved(connectionId: string): Promise<{ ok: boolean; version?: string; latencyMs: number; message?: string }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    return this.testConfig(conn, this.store.getConnectionSecret(connectionId));
  }

  async testConfig(conn: ConnectionConfig, secret: ConnectionSecret): Promise<DriverTestResult> {
    const started = Date.now();
    let bundle: Awaited<ReturnType<typeof createDriver>> | undefined;
    try {
      bundle = await createDriver({ ...conn, readonly: false }, secret);
      const result = await bundle.driver.test();
      return result;
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败', code: typeof err?.code === 'string' ? err.code : undefined };
    } finally {
      await bundle?.close().catch(() => undefined);
    }
  }

  async listDatabases(connectionId: string): Promise<string[]> {
    const driver = await this.driverFor(connectionId);
    return driver.listDatabases();
  }

  async describe(connectionId: string, database?: string, opts: ExecutionOptions = {}): Promise<TableInfo[]> {
    return this.trackWrite(connectionId, opts, async (driver) => driver.describe(database));
  }

  async schema(connectionId: string, database?: string, refresh = false, ttlMs = 30000, opts: ExecutionOptions = {}): Promise<DatabaseSchema[]> {
    this.throwIfAborted(opts);
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const dbKey = database ?? conn.database ?? (conn.engine === 'sqlite' ? 'main' : conn.engine === 'redis' ? '0' : conn.engine === 'neo4j' ? 'neo4j' : conn.engine === 'memgraph' ? 'memgraph' : conn.engine === 'falkordb' ? (conn.database || 'aidb') : conn.engine === 'influxdb' ? (conn.database || 'aidb') : conn.engine === 'arangodb' ? (conn.database || '_system') : conn.engine === 'elasticsearch' || conn.engine === 'opensearch' ? 'default' : conn.engine === 'cassandra' || conn.engine === 'scylla' ? 'system' : '');
    const memKey = `${connectionId}\u0000${dbKey}`;
    // 进程内已解析缓存：SQLite 缓存每命中一次就要整体 JSON.parse 一整库结构，
    // 表多时这是主线程上的固定开销；解析结果连同表名索引一起留在内存里，TTL 同源。
    if (!refresh) {
      const mem = this.parsedSchemas.get(memKey);
      if (mem && Date.now() - mem.fetchedAt < ttlMs) {
        mem.usedAt = Date.now();
        return mem.schemas;
      }
    }
    const cached = this.store.getSchemaCache(connectionId, dbKey);
    if (!refresh && cached && Date.now() - new Date(cached.fetchedAt).getTime() < ttlMs) {
      try {
        const schemas = JSON.parse(cached.payload) as DatabaseSchema[];
        this.rememberSchemas(memKey, schemas, new Date(cached.fetchedAt).getTime());
        return schemas;
      } catch {
        /* fall through */
      }
    }
    const describe = this.describe(connectionId, database, opts);
    // 仅调用方显式给出预算时才设 schema 超时；普通 schema 读取保持原有缓存/驱动口径。
    // Agent 回合把自己的剩余绝对预算传下来，超时错误先赢得竞态，再取消在途连接。
    const tables = opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? await withQueryTimeout(describe, opts.timeoutMs, {
          code: 'SCHEMA_TIMEOUT',
          label: 'Schema 读取',
          onTimeout: () => {
            if (opts.executionId) {
              this.cancelExecution(opts.executionId);
              return;
            }
            const cached = this.clients.get(connectionId);
            if (cached) this.destroyDriverConnections(cached.driver);
            void this.close(connectionId).catch(() => undefined);
          },
        })
      : await describe;
    this.throwIfAborted(opts);
    let schemas: DatabaseSchema[];
    if (engineUsesSchema(conn.engine)) {
      const groups = new Map<string, TableInfo[]>();
      for (const table of tables) {
        const fallback = conn.engine === 'sqlserver' ? 'dbo' : conn.engine === 'oracle' ? (conn.username ?? '').toUpperCase() : conn.engine === 'dm' ? (conn.username ?? 'SYSDBA').toUpperCase() : conn.engine === 'cassandra' || conn.engine === 'scylla' ? dbKey || 'system' : dbKey || 'public';
        const key = table.schema ?? fallback;
        groups.set(key, [...(groups.get(key) ?? []), table]);
      }
      if (!groups.size) groups.set(dbKey || 'public', []);
      schemas = [...groups.entries()].map(([name, list]) => ({ name, tables: list }));
    } else {
      const fallback = conn.engine === 'mongodb' ? 'default' : conn.engine === 'redis' ? '0' : conn.engine === 'neo4j' ? 'neo4j' : conn.engine === 'memgraph' ? 'memgraph' : conn.engine === 'falkordb' ? (conn.database || 'aidb') : conn.engine === 'influxdb' ? (conn.database || 'aidb') : conn.engine === 'arangodb' ? (conn.database || '_system') : conn.engine === 'elasticsearch' || conn.engine === 'opensearch' ? 'default' : 'main';
      schemas = [{ name: dbKey || fallback, tables }];
    }
    this.store.setSchemaCache(connectionId, dbKey, schemas);
    this.rememberSchemas(memKey, schemas, Date.now());
    return schemas;
  }

  /** 已解析 schema 的内存缓存上限：连接 × 库数量多时按最久未用淘汰，防止整库结构常驻堆。 */
  private static readonly PARSED_SCHEMA_CACHE_MAX = 64;
  private parsedSchemas = new Map<
    string,
    { schemas: DatabaseSchema[]; fetchedAt: number; usedAt: number; index: Map<string, { table: TableInfo; schema: DatabaseSchema }> }
  >();

  private rememberSchemas(key: string, schemas: DatabaseSchema[], fetchedAt: number): void {
    const index = new Map<string, { table: TableInfo; schema: DatabaseSchema }>();
    for (const schema of schemas) {
      for (const table of schema.tables) {
        const name = table.name.toLowerCase();
        // 与 findTable 原来的线性扫描一致：同名表取第一个 schema 里的。
        if (!index.has(name)) index.set(name, { table, schema });
      }
    }
    this.parsedSchemas.set(key, { schemas, fetchedAt, usedAt: Date.now(), index });
    if (this.parsedSchemas.size > ConnectionManager.PARSED_SCHEMA_CACHE_MAX) {
      let stalestKey: string | undefined;
      let stalest = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.parsedSchemas) {
        if (v.usedAt < stalest) {
          stalest = v.usedAt;
          stalestKey = k;
        }
      }
      if (stalestKey !== undefined) this.parsedSchemas.delete(stalestKey);
    }
  }

  private forgetParsedSchemas(connectionId: string): void {
    const prefix = `${connectionId}\u0000`;
    for (const key of [...this.parsedSchemas.keys()]) {
      if (key.startsWith(prefix)) this.parsedSchemas.delete(key);
    }
  }

  async findTable(connectionId: string, database: string | undefined, name: string): Promise<{ table: TableInfo; schema: DatabaseSchema }> {
    const schemas = await this.schema(connectionId, database);
    const target = name.toLowerCase();
    // schema() 刚填充的内存条目带表名索引；引用相同即命中，O(1) 取代全表线性遍历。
    for (const entry of this.parsedSchemas.values()) {
      if (entry.schemas !== schemas) continue;
      const hit = entry.index.get(target);
      if (hit) return hit;
      break;
    }
    for (const schema of schemas) {
      const table = schema.tables.find((t) => t.name.toLowerCase() === target);
      if (table) return { table, schema };
    }
    throw new DbError(`表不存在：${name}`, { code: 'TABLE_NOT_FOUND', hint: '先用 inspect_schema 或 search_objects 确认表名' });
  }

  private parseStructuredQuery(conn: ConnectionConfig, text: string): StructuredQuery {
    if (conn.engine === 'mongodb') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DbError('MongoDB 查询需要 JSON，例如 {"collection":"users","op":"find","filter":{}}', { code: 'MQL_PARSE' });
      }
      return normalizeMql(parsed);
    }
    if (conn.engine === 'redis') {
      const query = parseRedisCommandLine(text);
      if (!query) throw new DbError('Redis 命令为空', { code: 'REDIS_EMPTY' });
      return query;
    }
    if (engineMeta(conn.engine).languages.includes('cypher')) {
      const trimmed = text.trim();
      if (!trimmed) throw new DbError('Cypher 不能为空', { code: 'CYPHER_EMPTY' });
      if (trimmed.startsWith('{')) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          throw new DbError('Neo4j 查询需要合法的 JSON 或 Cypher 文本', { code: 'CYPHER_PARSE' });
        }
        const body = typeof parsed.query === 'string' ? parsed.query : typeof parsed.text === 'string' ? parsed.text : '';
        if (!body.trim()) throw new DbError('Cypher 不能为空', { code: 'CYPHER_EMPTY' });
        return {
          language: 'cypher',
          text: body,
          params: parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params) ? (parsed.params as Record<string, unknown>) : undefined,
        };
      }
      return { language: 'cypher', text: trimmed };
    }
    if (engineMeta(conn.engine).languages.includes('aql')) {
      const trimmed = text.trim();
      if (!trimmed) throw new DbError('AQL 不能为空', { code: 'AQL_EMPTY' });
      if (trimmed.startsWith('{')) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          throw new DbError('ArangoDB 查询需要合法的 JSON 或 AQL 文本', { code: 'AQL_PARSE' });
        }
        const body = typeof parsed.query === 'string' ? parsed.query : typeof parsed.text === 'string' ? parsed.text : '';
        if (!body.trim()) throw new DbError('AQL 不能为空', { code: 'AQL_EMPTY' });
        return {
          language: 'aql',
          text: body,
          params: parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params) ? (parsed.params as Record<string, unknown>) : undefined,
        };
      }
      return { language: 'aql', text: trimmed };
    }
    if (conn.engine === 'qdrant' || conn.engine === 'milvus' || conn.engine === 'weaviate') {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new DbError('向量查询需要 JSON，例如 {"collection":"docs","vector":[...],"topK":5}', { code: 'VECTOR_PARSE' });
      }
      const query = vectorQueryFromArgs(parsed);
      if (!query.op) query.op = query.vector?.length || query.text ? 'search' : 'scroll';
      return query;
    }
    if (conn.engine === 'elasticsearch' || conn.engine === 'opensearch') {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new DbError('搜索查询需要 JSON，例如 {"index":"logs","query":{"match_all":{}},"size":20}', { code: 'SEARCH_PARSE' });
      }
      return searchQueryFromArgs(parsed);
    }
    if (conn.engine === 'cassandra' || conn.engine === 'scylla') {
      const trimmed = text.trim();
      if (!trimmed) throw new DbError('CQL 不能为空', { code: 'CQL_EMPTY' });
      return { language: 'cql', text: trimmed };
    }
    throw new DbError(`${engineMeta(conn.engine).label} 暂不支持查询`, { code: 'UNSUPPORTED_ENGINE' });
  }

  private async executeStructured(connectionId: string, conn: ConnectionConfig, query: StructuredQuery, opts: QueryOptions): Promise<QueryBatchResult> {
    if (conn.readonly) {
      const safety =
        query.language === 'mql'
          ? classifyMql(query as MqlQuery)
          : query.language === 'redis'
            ? classifyRedis(query as RedisQuery)
            : query.language === 'cypher'
              ? classifyCypher(query as CypherQuery)
              : query.language === 'vector'
                ? classifyVector(query as VectorQuery)
                : query.language === 'search'
                  ? classifySearch(query as SearchQuery)
                  : query.language === 'aql'
                    ? classifyAql(query as AqlQuery)
                    : classifyCql(query as CqlQuery);
      if (safety.kind !== 'read') {
        const label =
          query.language === 'mql'
            ? 'MongoDB 写操作'
            : query.language === 'redis'
              ? (query as RedisQuery).command
              : query.language === 'cypher'
                ? 'Cypher 写操作'
                : query.language === 'vector'
                  ? '向量写操作'
                  : query.language === 'search'
                    ? '搜索写操作'
                    : query.language === 'aql'
                      ? 'AQL 写操作'
                      : 'CQL 写操作';
        throw new DbError(`只读连接不允许执行 ${label}${safety.reason ? `（${safety.reason}）` : ''}`, {
          code: 'READONLY',
          status: 403,
          hint: '在连接设置中关闭只读后才可写入',
        });
      }
    }
    // G1：结构化查询不进事务会话，断开时可直接销毁连接。
    this.beginExecution(connectionId, opts);
    const driver = await this.driverFor(connectionId).catch((err) => {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
      throw err;
    });
    if (!supportsStructuredQuery(driver)) {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
      throw new DbError(`${engineMeta(conn.engine).label} 驱动不支持结构化查询`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    try {
      this.throwIfAborted(opts);
      let effective = query;
      if (query.language === 'vector' && query.text && !query.vector?.length) {
        const vector = await embedText(this.settings(), query.text);
        effective = { ...query, vector };
      }
      const result = await driver.executeQuery(effective, {
        database: opts.database,
        maxRows: opts.maxRows,
        timeoutMs: opts.timeoutMs,
      });
      this.throwIfAborted(opts);
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql: formatStructuredQuery(query),
        status: 'ok',
        durationMs: result.durationMs,
        rowCount: result.rowCount,
      });
      return {
        sets: [result],
        messages: [`${result.rowCount} 行 · ${result.durationMs}ms`],
        durationMs: Date.now() - started,
      };
    } catch (err: any) {
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql: formatStructuredQuery(query),
        status: 'error',
        durationMs: Date.now() - started,
        error: err?.message ?? '执行失败',
      });
      throw err instanceof DbError ? err : new DbError(err?.message ?? '执行失败');
    } finally {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
    }
  }

  async queryStructured(connectionId: string, query: StructuredQuery, opts: QueryOptions): Promise<QueryBatchResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    return this.executeStructured(connectionId, conn, query, opts);
  }

  private documentContext(connectionId: string, collection: string) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (conn.readonly) {
      throw new DbError('只读连接不允许写入', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可写入' });
    }
    if (!collection || !collection.trim()) {
      throw new DbError('collection 不能为空', { code: 'WRITE_COLLECTION' });
    }
    return { conn, name: collection.trim() };
  }

  /** 批量写入历史只留摘要，避免把整批文档塞进历史表。 */
  private describeBatch(collection: string, count: number, ids: string[]): string {
    return JSON.stringify({ collection, count, ids: ids.slice(0, 5) });
  }

  /** 键值引擎的键详情（Redis / Redis Stack）。 */
  async keyDetail(connectionId: string, key: string, opts: { database?: string } = {}): Promise<RedisKeyDetail> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (meta.model !== 'keyvalue') {
      throw new DbError(`${meta.label} 没有键详情视图`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const driver = await this.driverFor(connectionId);
    if (!supportsKeyDetail(driver)) {
      throw new DbError(`${meta.label} 驱动不支持键详情`, { code: 'UNSUPPORTED_ENGINE' });
    }
    return driver.describeKey(key, opts.database ?? conn.database);
  }

  /** 文档引擎的单文档读取（编辑对话框用，返回 EJSON 原文）。 */
  async documentDetail(
    connectionId: string,
    input: { collection: string; id: string },
    opts: { database?: string } = {},
  ): Promise<{ id: string; document: string }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (!editsRecords(conn.engine)) {
      throw new DbError(`${meta.label} 没有单记录读取接口`, { code: 'UNSUPPORTED_ENGINE' });
    }
    if (!input.collection?.trim() || !input.id?.trim()) throw new DbError('collection 与 id 必填', { code: 'MQL_COLLECTION' });
    const driver = await this.driverFor(connectionId);
    if (!supportsDocumentRead(driver)) {
      throw new DbError(`${meta.label} 驱动不支持单记录读取`, { code: 'UNSUPPORTED_ENGINE' });
    }
    return driver.getDocument(input.collection.trim(), input.id.trim(), opts.database ?? conn.database);
  }

  /** 删除 Redis 键（UNLINK）；只读连接拒绝，返回真实删除数量。 */
  async deleteKeys(connectionId: string, keys: string[], opts: QueryOptions): Promise<{ deleted: number }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许删除键', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可删除' });
    }
    if (meta.model !== 'keyvalue') {
      throw new DbError(`${meta.label} 没有键删除入口`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const names = keys.map((key) => String(key ?? '').trim()).filter(Boolean);
    if (!names.length) throw new DbError('至少要指定一个键', { code: 'REDIS_KEY' });
    const driver = await this.driverFor(connectionId);
    if (!supportsKeyDetail(driver)) {
      throw new DbError(`${meta.label} 驱动不支持键删除`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    const result = await driver.deleteKeys(names, opts.database ?? conn.database);
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ unlink: names.slice(0, 5), count: names.length, deleted: result.deleted }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 删除 RediSearch 索引（FT.DROPINDEX），不触碰索引里的文档。 */
  async dropIndex(connectionId: string, name: string, opts: QueryOptions): Promise<{ name: string; dropped: boolean }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许删除索引', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可删除' });
    }
    if (meta.model !== 'keyvalue') {
      throw new DbError(`${meta.label} 没有搜索索引`, { code: 'UNSUPPORTED_ENGINE' });
    }
    if (!name.trim()) throw new DbError('索引名不能为空', { code: 'REDIS_INDEX' });
    const driver = await this.driverFor(connectionId);
    if (!supportsKeyDetail(driver)) {
      throw new DbError(`${meta.label} 驱动不支持删除索引`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    const result = await driver.dropIndex(name.trim(), opts.database ?? conn.database);
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ dropIndex: result.name }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 文档型引擎的索引创建/删除（非 SQL DDL）。 */
  async createCollectionIndex(
    connectionId: string,
    input: { collection: string; name?: string; columns: string[]; unique?: boolean; sparse?: boolean; expireAfterSeconds?: number; type?: string },
    opts: QueryOptions,
  ): Promise<{ name: string; created: boolean }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许创建索引', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可建索引' });
    }
    if (!managesIndexes(conn.engine)) {
      throw new DbError(`${meta.label} 暂不支持在此创建索引`, { code: 'UNSUPPORTED_ENGINE', hint: '请使用该引擎自身的索引命令' });
    }
    if (!input.collection?.trim()) throw new DbError('collection 不能为空', { code: 'MQL_COLLECTION' });
    if (!input.columns.some((column) => column.trim())) throw new DbError('索引至少需要一个字段', { code: 'MQL_INDEX' });
    const started = Date.now();
    const result = await this.trackWrite(connectionId, opts, async (driver) => {
      if (!supportsCollectionIndexes(driver)) {
        throw new DbError(`${meta.label} 驱动不支持索引管理`, { code: 'UNSUPPORTED_ENGINE' });
      }
      return driver.createIndex(
        { ...input, collection: input.collection.trim() },
        { database: opts.database, timeoutMs: opts.timeoutMs },
      );
    });
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ createIndex: { collection: input.collection, name: result.name, columns: input.columns, unique: input.unique, sparse: input.sparse, ttl: input.expireAfterSeconds, type: input.type } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  async dropCollectionIndex(
    connectionId: string,
    input: { collection: string; name: string },
    opts: QueryOptions,
  ): Promise<{ name: string; dropped: boolean }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许删除索引', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可删除索引' });
    }
    if (!managesIndexes(conn.engine)) {
      throw new DbError(`${meta.label} 暂不支持在此删除索引`, { code: 'UNSUPPORTED_ENGINE', hint: '请使用该引擎自身的索引命令' });
    }
    if (!input.collection?.trim() || !input.name?.trim()) throw new DbError('collection 与索引名必填', { code: 'MQL_INDEX' });
    const started = Date.now();
    const result = await this.trackWrite(connectionId, opts, async (driver) => {
      if (!supportsCollectionIndexes(driver)) {
        throw new DbError(`${meta.label} 驱动不支持索引管理`, { code: 'UNSUPPORTED_ENGINE' });
      }
      return driver.dropIndex({ collection: input.collection.trim(), name: input.name.trim() }, {
        database: opts.database,
        timeoutMs: opts.timeoutMs,
      });
    });
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ dropIndex: { collection: input.collection, name: result.name } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 给已有对象追加字段（ES/OpenSearch mapping、Weaviate property）。 */
  async createField(
    connectionId: string,
    input: { object: string; name: string; type: string },
    opts: QueryOptions,
  ): Promise<{ name: string; type: string; added: boolean }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许追加字段', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可改结构' });
    }
    if (!addField(conn.engine)) {
      throw new DbError(`${meta.label} 不支持追加字段`, {
        code: 'UNSUPPORTED_ENGINE',
        hint: meta.model === 'document' ? 'MongoDB 文档无固定 schema，直接写入带新字段的文档即可' : '该引擎的字段定义只能通过重建对象修改',
      });
    }
    if (!input.object?.trim() || !input.name?.trim()) throw new DbError('对象与字段名必填', { code: 'FIELD_INPUT' });
    const started = Date.now();
    const result = await this.trackWrite(connectionId, opts, async (driver) => {
      if (!supportsFieldAdd(driver)) {
        throw new DbError(`${meta.label} 驱动不支持追加字段`, { code: 'UNSUPPORTED_ENGINE' });
      }
      return driver.createField(
        { object: input.object.trim(), name: input.name.trim(), type: input.type?.trim() || 'text' },
        { database: opts.database, timeoutMs: opts.timeoutMs },
      );
    });
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ addField: { object: input.object, name: result.name, type: result.type } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  private async keyDriver(connectionId: string): Promise<{ conn: ConnectionConfig; driver: RedisKeyDriver }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许修改键', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可改键' });
    }
    if (meta.model !== 'keyvalue') {
      throw new DbError(`${meta.label} 没有键写入接口`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const driver = await this.driverFor(connectionId);
    if (!supportsKeyDetail(driver)) {
      throw new DbError(`${meta.label} 驱动不支持键操作`, { code: 'UNSUPPORTED_ENGINE' });
    }
    return { conn, driver };
  }

  /** 设置或移除键的过期时间（EXPIRE / PERSIST）。 */
  async setKeyTtl(connectionId: string, key: string, seconds: number | null, opts: QueryOptions): Promise<{ key: string; ttl: number }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    if (!key.trim()) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    const started = Date.now();
    const result = await driver.setTtl(key, seconds, opts.database ?? conn.database);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ keyTtl: { key: result.key, seconds } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 重命名键；目标名已存在时由驱动拒绝。 */
  async renameKey(connectionId: string, from: string, to: string, opts: QueryOptions): Promise<{ from: string; to: string }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    if (!to.trim()) throw new DbError('目标键名不能为空', { code: 'REDIS_RENAME' });
    const started = Date.now();
    const result = await driver.renameKey(from, to, opts.database ?? conn.database);
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ renameKey: result }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 新建键（string/hash/list/set/zset）；键已存在时由驱动拒绝。 */
  async createKey(connectionId: string, input: CreateRedisKeyInput, opts: QueryOptions): Promise<{ key: string; type: string; ttl: number }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    if (!input.key?.trim()) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    const started = Date.now();
    const result = await driver.createKey(input, opts.database ?? conn.database);
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ createKey: { key: result.key, type: result.type } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 写或删 hash 字段（HSET / HDEL），用于键详情里的字段级编辑。 */
  async setHashField(connectionId: string, key: string, field: string, value: string, opts: QueryOptions): Promise<{ key: string; field: string; created: boolean }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    const started = Date.now();
    const result = await driver.setHashField(key, field, value, opts.database ?? conn.database);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ setHashField: { key: result.key, field: result.field } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  async deleteHashField(connectionId: string, key: string, field: string, opts: QueryOptions): Promise<{ key: string; field: string; deleted: boolean; keyGone: boolean }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    const started = Date.now();
    const result = await driver.deleteHashField(key, field, opts.database ?? conn.database);
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ deleteHashField: { key: result.key, field: result.field } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** list/set/zset 的成员增删（键详情用）。 */
  async addKeyMember(connectionId: string, key: string, member: string, opts: QueryOptions & { score?: number }): Promise<{ key: string; type: string; added: boolean }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    const started = Date.now();
    const result = await driver.addKeyMember(key, member, opts.score, opts.database ?? conn.database);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ addKeyMember: { key: result.key, type: result.type } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  async removeKeyMember(connectionId: string, key: string, member: string, opts: QueryOptions): Promise<{ key: string; member: string; deleted: number; keyGone: boolean }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    const started = Date.now();
    const result = await driver.removeKeyMember(key, member, opts.database ?? conn.database);
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ removeKeyMember: { key: result.key, deleted: result.deleted } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 按索引改写 list 元素。 */
  async setListItem(connectionId: string, key: string, index: number, value: string, opts: QueryOptions): Promise<{ key: string; index: number; value: string }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    const started = Date.now();
    const result = await driver.setListItem(key, index, value, opts.database ?? conn.database);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ setListItem: { key: result.key, index: result.index } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 编辑 string 键的取值（SET KEEPTTL）；非 string 类型由驱动拒绝。 */
  async setKeyValue(connectionId: string, key: string, value: string, opts: QueryOptions): Promise<{ key: string; type: string; ttl: number }> {
    const { conn, driver } = await this.keyDriver(connectionId);
    if (!key.trim()) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    const started = Date.now();
    const result = await driver.setKeyValue(key, value, opts.database ?? conn.database);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ setKeyValue: { key: result.key } }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 时序引擎的行协议写入（InfluxDB v3 的 SQL 只读，写走 /api/v3/write_lp）。 */
  async writeLineProtocol(connectionId: string, lines: string[], opts: QueryOptions): Promise<{ written: number }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许写入', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可写入' });
    }
    if (!writesLineProtocol(conn.engine)) {
      throw new DbError(`${meta.label} 没有行协议写入入口`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    const result = await this.trackWrite(connectionId, opts, async (driver) => {
      if (!supportsLineProtocol(driver)) {
        throw new DbError(`${meta.label} 驱动不支持行协议写入`, { code: 'UNSUPPORTED_ENGINE' });
      }
      return driver.writeLineProtocol(lines, opts.database ?? conn.database, opts.timeoutMs);
    });
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: `write_lp ${result.written} 行`,
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** 向量/搜索引擎的对象创建（非 SQL DDL）：Qdrant 集合、ES/OpenSearch 索引、Weaviate class。 */
  async createObject(
    connectionId: string,
    input: { name: string; dimension?: number; distance?: string; fields?: Array<{ name: string; type: string }>; edge?: boolean },
    opts: QueryOptions,
  ): Promise<{ name: string; kind: string }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许创建集合/索引', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可建对象' });
    }
    if (!managesObjects(conn.engine)) {
      throw new DbError(`${meta.label} 暂不支持通过本界面创建对象`, {
        code: 'UNSUPPORTED_ENGINE',
        hint: 'Milvus 需要完整字段与索引定义，请使用 SDK 或 REST 建集合；关系型引擎请使用 DDL',
      });
    }
    if (!input.name?.trim()) throw new DbError('名称不能为空', { code: 'OBJECT_NAME' });
    const started = Date.now();
    const result = await this.trackWrite(connectionId, opts, async (driver) => {
      if (!supportsObjectCreate(driver)) {
        throw new DbError(`${meta.label} 驱动不支持创建对象`, { code: 'UNSUPPORTED_ENGINE' });
      }
      return driver.createObject(
        { name: input.name.trim(), dimension: input.dimension, distance: input.distance, fields: input.fields ?? [], edge: input.edge },
        { database: opts.database, timeoutMs: opts.timeoutMs },
      );
    });
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ createObject: result, dimension: input.dimension, distance: input.distance, fields: (input.fields ?? []).length }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  async dropObject(connectionId: string, name: string, opts: QueryOptions): Promise<{ name: string; dropped: boolean }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许删除集合/索引', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可删除对象' });
    }
    if (!name.trim()) throw new DbError('名称不能为空', { code: 'OBJECT_NAME' });
    if (!managesObjects(conn.engine)) {
      throw new DbError(`${meta.label} 暂不支持删除集合/索引`, { code: 'UNSUPPORTED_ENGINE', hint: '请在对应控制台执行删除命令' });
    }
    const started = Date.now();
    const result = await this.trackWrite(connectionId, opts, async (driver) => {
      if (!supportsObjectCreate(driver)) {
        throw new DbError(`${meta.label} 暂不支持删除集合/索引`, { code: 'UNSUPPORTED_ENGINE', hint: '请在对应控制台执行删除命令' });
      }
      return driver.dropObject(name, { database: opts.database, timeoutMs: opts.timeoutMs });
    });
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ dropObject: result.name }),
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return result;
  }

  async writeDocuments(
    connectionId: string,
    input: { collection: string; documents: Record<string, unknown>[] },
    opts: QueryOptions,
  ): Promise<{ ids: string[]; upserted: number }> {
    const { conn, name } = this.documentContext(connectionId, input.collection);
    const documents = input.documents ?? [];
    if (!documents.length) throw new DbError('至少需要一个文档', { code: 'WRITE_DOCUMENT' });
    if (documents.some((document) => !document || typeof document !== 'object' || Array.isArray(document))) {
      throw new DbError('documents 必须是 JSON 对象数组', { code: 'WRITE_DOCUMENT' });
    }
    const started = Date.now();
    try {
      const result = await this.trackWrite(connectionId, opts, async (driver) => {
        if (!supportsDocumentWrite(driver)) {
          throw new DbError(`${engineMeta(conn.engine).label} 暂不支持写入文档/向量`, { code: 'UNSUPPORTED_ENGINE' });
        }
        return driver.upsertDocuments({ collection: name, documents }, { database: opts.database, timeoutMs: opts.timeoutMs });
      });
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql: this.describeBatch(name, result.upserted, result.ids),
        status: 'ok',
        durationMs: Date.now() - started,
        rowCount: result.upserted,
      });
      return result;
    } catch (err: any) {
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql: this.describeBatch(name, documents.length, []),
        status: 'error',
        durationMs: Date.now() - started,
        error: err?.message ?? '写入失败',
      });
      throw err instanceof DbError ? err : new DbError(err?.message ?? '写入失败');
    }
  }

  async deleteDocuments(
    connectionId: string,
    input: { collection: string; ids: string[] },
    opts: QueryOptions,
  ): Promise<{ deleted: number }> {
    const { conn, name } = this.documentContext(connectionId, input.collection);
    const ids = input.ids.map((id) => String(id).trim()).filter(Boolean);
    if (!ids.length) throw new DbError('ids 不能为空', { code: 'WRITE_IDS', hint: '删除必须给出明确的 id 列表' });
    const started = Date.now();
    try {
      const result = await this.trackWrite(connectionId, opts, async (driver) => {
        if (!supportsDocumentWrite(driver)) {
          throw new DbError(`${engineMeta(conn.engine).label} 暂不支持写入文档/向量`, { code: 'UNSUPPORTED_ENGINE' });
        }
        return driver.deleteDocuments({ collection: name, ids }, { database: opts.database, timeoutMs: opts.timeoutMs });
      });
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql: this.describeBatch(name, result.deleted, ids),
        status: 'ok',
        durationMs: Date.now() - started,
        rowCount: result.deleted,
      });
      return result;
    } catch (err: any) {
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql: this.describeBatch(name, ids.length, ids),
        status: 'error',
        durationMs: Date.now() - started,
        error: err?.message ?? '删除失败',
      });
      throw err instanceof DbError ? err : new DbError(err?.message ?? '删除失败');
    }
  }

  /**
   * 向量元素清洗：只允许有限数字，拒绝字符串/NaN/Infinity。
   * pgvector 的 `[...]` 字面量直接拼进 SQL，Weaviate 直接拼进 GraphQL，
   * 不清洗的元素（如 `"1')--"`）会逃逸出数组字面量。
   */
  private sanitizeVector(v: unknown[]): number[] {
    return v.map((item) => {
      const n = Number(item);
      if (!Number.isFinite(n)) throw new DbError('向量元素必须是有限数字', { code: 'VECTOR_ELEMENT' });
      return n;
    });
  }

  async vectorSearch(connectionId: string, query: VectorQuery, opts: QueryOptions): Promise<QueryResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    const topK = Math.max(1, Math.min(1000, Number(query.topK) || 10));
    this.beginExecution(connectionId, opts);
    const started = Date.now();
    try {
      let vector = query.vector;
      if (!vector?.length && query.text) {
        this.throwIfAborted(opts);
        vector = await embedText(this.settings(), query.text);
      }
      if (vector?.length) vector = this.sanitizeVector(vector);
      this.throwIfAborted(opts);
      const driver = await this.driverFor(connectionId);
      this.throwIfAborted(opts);

      if (meta.model === 'vector') {
        if (!supportsVectorSearch(driver)) {
          throw new DbError(`${meta.label} 驱动不支持向量检索`, { code: 'UNSUPPORTED_ENGINE' });
        }
        try {
          const result = await driver.vectorSearch({ ...query, topK, vector }, { database: opts.database, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs });
          this.throwIfAborted(opts);
          this.store.addHistory({
            connectionId,
            database: opts.database ?? conn.database,
            sql: formatStructuredQuery(query),
            status: 'ok',
            durationMs: result.durationMs,
            rowCount: result.rowCount,
          });
          return result;
        } catch (err: any) {
          this.store.addHistory({
            connectionId,
            database: opts.database ?? conn.database,
            sql: formatStructuredQuery(query),
            status: 'error',
            durationMs: Date.now() - started,
            error: err?.message ?? '向量检索失败',
          });
          throw err instanceof DbError ? err : new DbError(err?.message ?? '向量检索失败');
        }
      }

      if (meta.dialect === 'postgres') {
        if (!query.field) throw new DbError('pgvector 检索需要指定向量列 field', { code: 'VECTOR_FIELD' });
        if (!vector?.length) throw new DbError('pgvector 检索需要 vector 或 text', { code: 'VECTOR_REQUIRED' });
        const { table } = await this.findTable(connectionId, opts.database, query.collection);
        const column = (table.columns ?? []).find((item) => item.name.toLowerCase() === query.field!.toLowerCase());
        if (!column || !/^vector/i.test(column.type)) {
          throw new DbError(`列 ${query.field} 不是 vector 类型`, { code: 'VECTOR_FIELD' });
        }
        const target = quoteQualified([table.schema, table.name], conn.engine);
        const vectorColumn = quoteIdent(column.name, conn.engine);
        const nums = this.sanitizeVector(vector);
        const literal = `[${nums.join(',')}]`;
        const sql = `SELECT *, 1 - (${vectorColumn} <=> $1::vector) AS score FROM ${target} ORDER BY ${vectorColumn} <=> $1::vector LIMIT ${topK}`;
        try {
          const result = await driver.runParams(sql, [literal], { database: opts.database, maxRows: topK, timeoutMs: opts.timeoutMs });
          this.throwIfAborted(opts);
          this.store.addHistory({
            connectionId,
            database: opts.database ?? conn.database,
            sql,
            status: 'ok',
            durationMs: result.durationMs,
            rowCount: result.rowCount,
          });
          return result;
        } catch (err: any) {
          this.store.addHistory({
            connectionId,
            database: opts.database ?? conn.database,
            sql,
            status: 'error',
            durationMs: Date.now() - started,
            error: err?.message ?? '向量检索失败',
          });
          throw err instanceof DbError ? err : new DbError(err?.message ?? '向量检索失败');
        }
      }

      throw new DbError(`${meta.label} 不支持向量检索`, { code: 'UNSUPPORTED_ENGINE' });
    } finally {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
    }
  }

  /** 跨请求事务：只有固定得住连接的驱动（目前 MySQL）支持。 */
  private async txDriver(connectionId: string): Promise<{ conn: ConnectionConfig; driver: TransactionDriver }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (conn.readonly) {
      throw new DbError('只读连接不允许开启事务', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可开启事务' });
    }
    const driver = await this.driverFor(connectionId);
    if (!supportsTransactions(conn.engine) || !supportsTransaction(driver)) {
      throw new DbError(`${engineMeta(conn.engine).label} 暂不支持跨请求事务`, {
        code: 'UNSUPPORTED_ENGINE',
        hint: '目前 MySQL、PostgreSQL、Oracle、SQL Server、SQLite 与达梦 DM8 支持 begin/commit/rollback',
      });
    }
    return { conn, driver };
  }

  /** 事务会话最长空闲时间；超过就回滚，避免永久占住池内连接。 */
  private static readonly TX_IDLE_MS = 15 * 60 * 1000;

  /** 回滚并释放超时的事务会话，返回被回收的 id 列表。 */
  async reapIdleTransactions(): Promise<string[]> {
    const now = Date.now();
    const expired = [...this.txSessions.entries()].filter(([, s]) => now - s.lastUsedAt > this.txIdleMs);
    const reaped: string[] = [];
    for (const [sessionId, session] of expired) {
      this.txSessions.delete(sessionId);
      try {
        const driver = await this.driverFor(session.connectionId);
        if (supportsTransaction(driver)) await driver.rollbackTransaction(sessionId);
      } catch {
        /* 驱动已断开时忽略，连接随之释放 */
      }
      this.store.addHistory({
        connectionId: session.connectionId,
        database: session.database,
        sql: 'ROLLBACK (超时回收)',
        status: 'ok',
        durationMs: now - session.startedAt,
      });
      // 事务里改过结构就必须通知：MySQL/Oracle 的 DDL 是隐式提交，这些变更
      // 早已对别的会话可见；即使是可回滚的引擎，回滚也让结构回到未提交前的样子，
      // 客户端同样需要重读。不通知就等于永久丢掉这次变更。
      if (session.schemaDirty) this.invalidate(session.connectionId);
      reaped.push(sessionId);
    }
    return reaped;
  }

  async beginTransaction(sessionId: string, connectionId: string, opts: QueryOptions): Promise<{ sessionId: string; database?: string }> {
    throwIfAborted(opts.signal);
    await this.reapIdleTransactions();
    throwIfAborted(opts.signal);
    const { conn, driver } = await this.txDriver(connectionId);
    throwIfAborted(opts.signal);
    if (this.txSessions.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    const database = opts.database ?? conn.database;
    await driver.beginTransaction(sessionId, database);
    try {
      throwIfAborted(opts.signal);
    } catch (err) {
      await driver.rollbackTransaction(sessionId).catch(() => undefined);
      throw err;
    }
    this.txSessions.set(sessionId, { connectionId, database, startedAt: Date.now(), lastUsedAt: Date.now() });
    this.store.addHistory({
      connectionId,
      database,
      sql: 'BEGIN',
      status: 'ok',
      durationMs: 0,
    });
    return { sessionId, database };
  }

  async commitTransaction(sessionId: string, actor: SchemaChangeCause = 'user'): Promise<{ sessionId: string; committed: true }> {
    const session = this.txSessions.get(sessionId);
    if (!session) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const driver = await this.driverFor(session.connectionId);
    if (!supportsTransaction(driver)) throw new DbError('驱动不再支持事务', { code: 'UNSUPPORTED_ENGINE' });
    await driver.commitTransaction(sessionId);
    this.txSessions.delete(sessionId);
    // 事务里的 DDL 到这一刻才对别的会话可见，所以事件也到这一刻才发。
    if (session.schemaDirty) this.invalidate(session.connectionId, actor);
    this.store.addHistory({
      connectionId: session.connectionId,
      database: session.database,
      sql: 'COMMIT',
      status: 'ok',
      durationMs: Date.now() - session.startedAt,
    });
    return { sessionId, committed: true };
  }

  async rollbackTransaction(sessionId: string, actor: SchemaChangeCause = 'user'): Promise<{ sessionId: string; rolledBack: true }> {
    const session = this.txSessions.get(sessionId);
    if (!session) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    const driver = await this.driverFor(session.connectionId);
    if (!supportsTransaction(driver)) throw new DbError('驱动不再支持事务', { code: 'UNSUPPORTED_ENGINE' });
    await driver.rollbackTransaction(sessionId);
    this.txSessions.delete(sessionId);
    // 回滚可能把结构改回去（DDL 是否可回滚取决于引擎），客户端必须重读，
    // 否则会一直显示一个从未提交过的表。
    if (session.schemaDirty) this.invalidate(session.connectionId, actor);
    this.store.addHistory({
      connectionId: session.connectionId,
      database: session.database,
      sql: 'ROLLBACK',
      status: 'ok',
      durationMs: Date.now() - session.startedAt,
    });
    return { sessionId, rolledBack: true };
  }

  /** 会话当前是否在事务里（路由用来决定走固定连接还是普通池）。 */
  transactionOf(sessionId: string | undefined): { connectionId: string; database?: string } | null {
    if (!sessionId) return null;
    const session = this.txSessions.get(sessionId);
    return session ? { connectionId: session.connectionId, database: session.database } : null;
  }

  /**
   * 取消一次仍在执行的查询（G1：客户端提前断开）。返回是否命中活动执行。
   *
   * 事务内不能销毁连接——那会中止用户整个事务，只标记放弃结果，查询在超时
   * 看门狗约束下跑完，结果由路由层丢弃。同连接还挂着别的事务会话时同理，
   * 避免连带回滚别人的事务。其余情况销毁该连接的缓存驱动：MySQL/PG 连接
   * 断开即终止服务端查询；其他引擎按驱动能力尽力而为。驱动会在下次查询时重建。
   */
  releaseExecution(executionId: string): void {
    // 已取消但底层写仍未结束时，追踪必须保留到写真正完成，重试停止才找得到连接。
    this.abandonedExecutions.delete(executionId);
  }

  cancelExecution(executionId: string): boolean {
    const active = this.activeExecutions.get(executionId);
    // 复合任务在批次间隙没有活动查询，stop 仍必须否决下一批。
    this.abandonedExecutions.add(executionId);
    if (!active) return false;
    active.abandoned = true;
    const txOnConnection = [...this.txSessions.values()].some((s) => s.connectionId === active.connectionId);
    if (active.inTx || txOnConnection) return true;
    const cached = this.clients.get(active.connectionId);
    if (cached) this.destroyDriverConnections(cached.driver);
    // close() 负责摘缓存与清事务会话；单独 pool.end() 是温和关闭（mysql2 会等
    // 当前命令跑完），杀不掉正在执行的查询，所以先 destroy 再 close。
    void this.close(active.connectionId).catch(() => undefined);
    return true;
  }

  /**
   * 尽力立即断开驱动占用的底层连接（仅用于取消路径，整池即将被丢弃）。
   * Driver 契约只有温和的 close()，这里按 mysql2/pg 池的已知结构直接 destroy；
   * 结构不匹配（驱动重写等）时静默跳过，由 close() + 超时看门狗兜底。
   */
  private destroyDriverConnections(driver: Driver): void {
    try {
      const pools = (driver as unknown as { pools?: Map<string, unknown> }).pools;
      if (!pools || typeof pools.values !== 'function') return;
      for (const pool of pools.values()) {
        const p = pool as any;
        // mysql2 promise pool：真实连接挂在 core pool 的 _allConnections 上。
        const core = p?.pool ?? p;
        const all = core?._allConnections;
        if (all && typeof all.forEach === 'function') {
          all.forEach((conn: any) => {
            try { conn?.destroy?.(); } catch { /* 单条连接销毁失败不影响其余 */ }
          });
          continue;
        }
        // pg pool：destroy 客户端底层 socket 即终止服务端查询。
        const clients = p?._clients;
        if (Array.isArray(clients)) {
          for (const client of clients) {
            try { client?.connection?.stream?.destroy?.(); } catch { /* 同上 */ }
          }
        }
      }
    } catch { /* 结构探测失败时由 close() 兜底 */ }
  }

  async query(connectionId: string, sql: string, opts: QueryOptions): Promise<QueryBatchResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      const query = this.parseStructuredQuery(conn, sql);
      return this.executeStructured(connectionId, conn, query, opts);
    }
    // /query 等直连路径不经过 Agent 的 unknown 审批闸门；词法不完整/歧义必须在建连前拒绝。
    if (hasUnsafeSqlSyntax(sql, conn.engine)) {
      throw new DbError('无法证明 SQL 安全，已拒绝解析不完整的括号、引号或注释', {
        code: 'SQL_UNKNOWN',
        status: 400,
        hint: '请改写为明确支持的 SQL 语句；不确定的方括号标识符或注释边界不会进入执行。',
      });
    }
    const statements = splitStatements(sql, conn.engine);
    if (!statements.length) throw new DbError('SQL 为空', { code: 'EMPTY_SQL' });
    if (statements.length > MAX_SCRIPT_HARD_STATEMENTS) {
      throw new DbError(`脚本含 ${statements.length} 条语句，超过硬上限 ${MAX_SCRIPT_HARD_STATEMENTS} 条`, {
        code: 'SCRIPT_TOO_LARGE',
        hint: '请分批执行：每批控制在合理条数内，逐次调用并确认上一批结果后再继续。',
      });
    }
    // 真正的单语句边界：省略或 false 都只允许一条可执行语句。只有显式
    // allowMulti: true 才进入下面的逐条执行循环；空分号不构成额外语句。
    if (statements.length > 1 && opts.allowMulti !== true) {
      throw new DbError(`脚本含 ${statements.length} 条可执行语句；未显式允许执行多语句脚本`, {
        code: 'SCRIPT_TOO_LARGE',
        hint:
          '整段执行需显式声明：调用 run_sql 时传 allowMulti: true，或在 设置 → 查询 打开「允许多语句」。' +
          '整段脚本非原子：中途失败时前面的语句已生效，请分批并在每批之间确认结果。',
      });
    }
    if (conn.readonly) {
      for (const statement of statements) {
        const violation = readonlyViolation(statement, conn.engine);
        if (violation) throw new DbError(violation, { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可写入' });
      }
    }
    // 事务会话里的语句必须走被固定的那条连接，否则 COMMIT/ROLLBACK 作用不到。
    // 同时也必须校验归属：别的连接的事务 id 混进来时应当普通执行，而不是抛 TX_NOT_FOUND。
    const candidate = opts.sessionId ? this.txSessions.get(opts.sessionId) : undefined;
    if (opts.requireTransaction && (!candidate || candidate.connectionId !== connectionId)) {
      throw new DbError('事务会话不存在或已结束，已拒绝非原子写入', { code: 'ATOMIC_TRANSFER_UNSUPPORTED', status: 409 });
    }
    this.beginExecution(connectionId, opts, Boolean(candidate));
    const driver = await this.driverFor(connectionId).catch((err) => {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
      throw err;
    });
    const currentTx = opts.sessionId ? this.txSessions.get(opts.sessionId) : undefined;
    const txSession = currentTx && currentTx.connectionId === connectionId ? currentTx : undefined;
    const txDriver = txSession && supportsTransaction(driver) ? driver : undefined;
    if (opts.requireTransaction && !txDriver) {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
      throw new DbError('驱动不再支持事务，已拒绝非原子写入', { code: 'ATOMIC_TRANSFER_UNSUPPORTED', status: 409 });
    }
    if (txSession) txSession.lastUsedAt = Date.now();
    // G1：登记执行追踪，客户端提前断开时 cancelExecution 据此定位连接与事务归属。
    const inTx = Boolean(txDriver && opts.sessionId);
    if (opts.executionId) {
      const abandoned = this.activeExecutions.get(opts.executionId)?.abandoned;
      this.activeExecutions.set(opts.executionId, { connectionId, sessionId: inTx ? opts.sessionId : undefined, inTx, abandoned });
    }
    const started = Date.now();
    const sets: QueryResult[] = [];
    const messages: string[] = [];
    let failure: Error | undefined;
    let failedStatementIndex: number | undefined;
    // 已成功执行并落库的语句。用于判断结构是否真的变了：脚本第 3 条失败时
    // 第 1 条 DDL 已经生效，按「整段成功」判定就等于永远不通知。
    const applied: string[] = [];
    try {
      this.throwIfAborted(opts);
      for (const [index, statement] of statements.entries()) {
        try {
          this.throwIfAborted(opts);
        } catch (err) {
          failedStatementIndex = index;
          throw err;
        }
        const prepared = opts.autoLimit !== false && opts.maxRows ? applyLimit(statement, opts.maxRows, conn.engine) : statement;
        try {
          const result = txDriver && opts.sessionId
            ? await txDriver.runInTransaction(opts.sessionId, prepared, [], { database: opts.database, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs, signal: opts.signal, executionId: opts.executionId })
            : await driver.run(prepared, { database: opts.database, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs });
          this.throwIfAborted(opts);
          sets.push(result);
          applied.push(statement);
          // applyLimit 已经把 SQL 改写成带 LIMIT 的形式，驱动无法再通过原始行数判断截断。
          if (prepared !== statement && opts.maxRows && result.rowCount >= opts.maxRows) {
            result.truncated = true;
          }
          messages.push(
            result.columns.length
              ? `[${index + 1}] ${result.rowCount} 行 · ${result.durationMs}ms`
              : `[${index + 1}] 影响 ${result.affected ?? 0} 行 · ${result.durationMs}ms`,
          );
        } catch (err: any) {
          failure = err;
          failedStatementIndex = index;
          throw err;
        }
      }
      return { sets, messages, durationMs: Date.now() - started };
    } catch (err: any) {
      // DM 事务超时：驱动已关闭被固定的连接并删掉自身事务条目，manager 侧的事务
      // 会话也已失效，立即移除，避免 15 分钟 idle reaper 前同 sessionId 无法复开事务、
      // 以及 commit/rollback 报 TX_NOT_FOUND 的连环错误。
      if (err?.code === 'DM_TIMEOUT' && opts.sessionId) this.txSessions.delete(opts.sessionId);
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql,
        status: 'error',
        durationMs: Date.now() - started,
        error: err?.message ?? '执行失败',
      });
      const error = err instanceof DbError ? err : new DbError(err?.message ?? '执行失败');
      if (sets.length) {
        Object.assign(error, {
          data: {
            sets,
            messages,
            multiStatement: true,
            partial: true,
            failedStatementIndex,
            appliedStatements: applied.length,
          },
        });
      }
      throw error;
    } finally {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
      if (!failure && sets.length) {
        this.store.addHistory({
          connectionId,
          database: opts.database ?? conn.database,
          sql,
          status: 'ok',
          durationMs: Date.now() - started,
          rowCount: sets.reduce((a, s) => a + s.rowCount, 0),
        });
      }

      // 结构变更必须清 schema 缓存并广播。
      //
      // 判定放在这里而不是各个路由：/query（SQL 窗口）与 commands/* 此前根本没清缓存，
      // 建完表 30 秒内服务端一直返回旧结构，客户端刷新也没用。逐个路由补是 N 个会再漏的点，
      // 而这里是所有 SQL 执行的唯一咽喉。
      //
      // 用 applied（已执行成功并落库的语句）而不是 statements 判定：脚本第 3 条失败时
      // 第 1 条 DDL 已经生效，按整段失败跳过就等于永远不通知。
      //
      // 已经由调用方显式 invalidate 的路径必须删掉它们自己那处（见计划 Task 3 Step 4），
      // 否则一次操作发两遍事件、客户端刷两遍全库。
      const touchesSchema = applied.some((statement) => {
        const kind = classifyStatement(statement, conn.engine).kind;
        return kind === 'ddl' || kind === 'destructive';
      });
      if (touchesSchema) {
        // 事务内的 DDL 分两种情况，不能一概"等 COMMIT"：
        // - PostgreSQL / SQLite / SQL Server：DDL 参与事务，未提交前别的会话看不到，
        //   推迟到 COMMIT 才对。
        // - MySQL / MariaDB / Oracle / DM：DDL 会**隐式提交**，BEGIN 里执行完就已对
        //   别的会话可见。推迟到 COMMIT 会让用户一直看着旧结构，所以立刻发。
        if (txSession && !implicitCommitDdl(conn.engine)) txSession.schemaDirty = true;
        else this.invalidate(connectionId, opts.actor);
      }
    }
  }

  async runParams(
    connectionId: string,
    sql: string,
    params: unknown[],
    opts: QueryOptions,
  ): Promise<QueryResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      throw new DbError(`${engineMeta(conn.engine).label} 不支持参数化 SQL`, { code: 'UNSUPPORTED_ENGINE' });
    }
    if (conn.readonly) throw new DbError('该连接为只读，禁止写入', { code: 'READONLY', status: 403 });
    const candidate = opts.sessionId ? this.txSessions.get(opts.sessionId) : undefined;
    if (opts.requireTransaction && (!candidate || candidate.connectionId !== connectionId)) {
      throw new DbError('事务会话不存在或已结束，已拒绝非原子写入', { code: 'ATOMIC_TRANSFER_UNSUPPORTED', status: 409 });
    }
    this.beginExecution(connectionId, opts, Boolean(candidate));
    const driver = await this.driverFor(connectionId).catch((err) => {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
      throw err;
    });
    // 事务里的参数化语句必须走被固定的那条连接，与 query() 的逻辑一致。
    const currentTx = opts.sessionId ? this.txSessions.get(opts.sessionId) : undefined;
    const txSession = currentTx && currentTx.connectionId === connectionId ? currentTx : undefined;
    const txDriver = txSession && supportsTransaction(driver) ? driver : undefined;
    if (opts.requireTransaction && !txDriver) {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
      throw new DbError('驱动不再支持事务，已拒绝非原子写入', { code: 'ATOMIC_TRANSFER_UNSUPPORTED', status: 409 });
    }
    if (txSession) txSession.lastUsedAt = Date.now();
    // 与 query() 相同的内存上限语义：调用方传 maxRows 时用 applyLimit 追加 LIMIT，
    // 只改动 SQL 末尾，不破坏 $1 占位符，参数化执行安全。
    const prepared = opts.maxRows && opts.maxRows > 0 ? applyLimit(sql, opts.maxRows, conn.engine) : sql;
    try {
      this.throwIfAborted(opts);
      const result = txDriver && opts.sessionId
        ? await txDriver.runInTransaction(opts.sessionId, prepared, params, { database: opts.database, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs, signal: opts.signal, executionId: opts.executionId })
        : await driver.runParams(prepared, params, { database: opts.database, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs });
      this.throwIfAborted(opts);
      if (prepared !== sql && opts.maxRows && result.rowCount >= opts.maxRows) result.truncated = true;
      return result;
    } finally {
      if (opts.executionId) this.activeExecutions.delete(opts.executionId);
    }
  }

  /**
   * 一次性执行整段脚本（备份恢复）。只有部分驱动支持；返回 false 时调用方回退到 query()。
   */
  async execScript(connectionId: string, sql: string, opts: QueryOptions): Promise<boolean> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (conn.readonly) throw new DbError('该连接为只读，禁止写入', { code: 'READONLY', status: 403 });
    const started = Date.now();
    // G2：execScript 此前完全没超时——驱动签名不收 timeoutMs，挂死的脚本会永久
    // 占住连接。这里在 manager 侧套看门狗；整段脚本不是单条查询，调用方传的
    // queryTimeoutMs 是单语句口径，统一抬到脚本级 600s 下限（允许调用方加长）。
    const scriptTimeoutMs = Math.max(opts.timeoutMs ?? 0, EXEC_SCRIPT_TIMEOUT_MS);
    const executed = await this.trackWrite(connectionId, opts, async (driver) => {
      if (!driver.execScript) return false;
      await withQueryTimeout(driver.execScript(sql, opts.database ?? conn.database, { signal: opts.signal }), scriptTimeoutMs, {
        code: 'SCRIPT_TIMEOUT',
        label: '脚本执行',
        // 超时后断连接才能真正停掉 MySQL/PG 服务端脚本；MySQL 驱动的 execScript
        // 走独立连接，池销毁够不到它，残留执行由驱动自身超时兜底（WP1）。
        onTimeout: () => {
          const cached = this.clients.get(connectionId);
          if (cached) this.destroyDriverConnections(cached.driver);
          void this.close(connectionId).catch(() => undefined);
        },
      });
      return true;
    });
    if (!executed) return false;
    this.invalidate(connectionId, opts.actor);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: '-- script',
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return true;
  }

  async rawDriver(connectionId: string): Promise<Driver> {
    return this.driverFor(connectionId);
  }

  async close(connectionId: string): Promise<void> {
    // 先打删除标记：在途的 createDriverCached 完成时会走「已关闭即关」分支，
    // 不会再把已删除连接的 driver 塞回 clients。
    this.closedFlags.set(connectionId, true);
    this.forgetParsedSchemas(connectionId);
    const cached = this.clients.get(connectionId);
    if (cached) {
      await cached.close().catch(() => undefined);
      this.clients.delete(connectionId);
    }
    // 驱动已关，它的固定连接也被回滚了；留着事务会话只会变成孤儿并阻塞同名会话。
    for (const [sessionId, session] of [...this.txSessions]) {
      if (session.connectionId !== connectionId) continue;
      this.txSessions.delete(sessionId);
      // 与 reaper 同理：隐式提交引擎的结构变更已经落地，客户端必须知道。
      if (session.schemaDirty) this.invalidate(connectionId);
    }
  }

  async closeAll(): Promise<void> {
    if (this.txTimer) clearInterval(this.txTimer);
    await Promise.all([...this.clients.entries()].map(async ([id]) => this.close(id)));
    // 全部关闭后清掉删除标记，避免长期存活实例上的 stale 标记累积。
    this.closedFlags.clear();
  }

  /**
   * 让 schema 缓存失效。
   *
   * @param cause 事件归因，只影响 UI 文案
   * @param broadcast 是否广播结构变更事件。纯数据变更（改值、导数据）只需要
   *   丢掉缓存里过期的 rowEstimate，不该让所有客户端白跑一次全库 describe：
   *   结构没变，它们要刷的东西不存在。默认广播。
   */
  invalidate(connectionId: string, cause: SchemaChangeCause = 'user', broadcast = true): void {
    // 内存解析层先清：即使下面落库清理失败，也不会继续供应旧结构。
    this.forgetParsedSchemas(connectionId);
    // 清缓存失败不能连累已经落库的 DDL：这个方法在 query() 的 finally 里调用，
    // 往上抛会把"表已经建好了"报成失败，调用方据此重试反而制造重复错误。
    // 代价是缓存可能残留旧结构，最多 30s TTL 后自然恢复，比误报失败轻得多。
    try {
      this.store.clearSchemaCache(connectionId);
    } catch (err) {
      console.error(`[schema] 清理连接 ${connectionId} 的 schema 缓存失败`, err);
    }
    if (!broadcast) return;
    this.events?.emitSchemaChanged({
      type: 'schema_changed',
      connectionId,
      cause,
      at: new Date().toISOString(),
    });
  }
}
