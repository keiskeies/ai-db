import {
  addField,
  applyLimit,
  classifyAql,
  classifyCql,
  classifyCypher,
  classifyMql,
  classifyRedis,
  classifySearch,
  classifyVector,
  editsRecords,
  engineMeta,
  engineUsesSchema,
  formatStructuredQuery,
  managesObjects,
  managesIndexes,
  parseRedisCommandLine,
  quoteIdent,
  quoteQualified,
  readonlyViolation,
  searchQueryFromArgs,
  splitStatements,
  vectorQueryFromArgs,
  type AppSettings,
  type AqlQuery,
  type ConnectionConfig,
  type ConnectionSecret,
  type CqlQuery,
  type CypherQuery,
  type DatabaseSchema,
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
import { normalizeMql } from './drivers/mongodb';
import type { CreateRedisKeyInput, RedisKeyDriver } from './drivers/types';
import { supportsCollectionIndexes, supportsDocumentRead, supportsDocumentWrite, supportsFieldAdd, supportsKeyDetail, supportsObjectCreate, supportsStructuredQuery, supportsVectorSearch } from './drivers/types';
import { embedText } from './embeddings';
import type { Store } from './store';

interface CachedDriver {
  driver: Driver;
  close: () => Promise<void>;
}

export interface QueryOptions {
  database?: string;
  maxRows?: number;
  timeoutMs?: number;
  allowMulti?: boolean;
  autoLimit?: boolean;
  actor: 'user' | 'agent';
}

export class ConnectionManager {
  private clients = new Map<string, CachedDriver>();

  constructor(
    private store: Store,
    private config: GatewayConfig,
    private settings: () => AppSettings,
  ) {}

  private async driverFor(connectionId: string): Promise<Driver> {
    const cached = this.clients.get(connectionId);
    if (cached) {
      this.store.touchConnection(connectionId);
      return cached.driver;
    }
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const secret = this.store.getConnectionSecret(connectionId);
    const bundle = await createDriver(conn, secret);
    this.clients.set(connectionId, bundle);
    this.store.touchConnection(connectionId);
    return bundle.driver;
  }

  async testSaved(connectionId: string): Promise<{ ok: boolean; version?: string; latencyMs: number; message?: string }> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    return this.testConfig(conn, this.store.getConnectionSecret(connectionId));
  }

  async testConfig(conn: ConnectionConfig, secret: ConnectionSecret): Promise<{ ok: boolean; version?: string; latencyMs: number; message?: string }> {
    const started = Date.now();
    let bundle: Awaited<ReturnType<typeof createDriver>> | undefined;
    try {
      bundle = await createDriver({ ...conn, readonly: false }, secret);
      const result = await bundle.driver.test();
      return result;
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    } finally {
      await bundle?.close().catch(() => undefined);
    }
  }

  async listDatabases(connectionId: string): Promise<string[]> {
    const driver = await this.driverFor(connectionId);
    return driver.listDatabases();
  }

  async describe(connectionId: string, database?: string): Promise<TableInfo[]> {
    const driver = await this.driverFor(connectionId);
    return driver.describe(database);
  }

  async schema(connectionId: string, database?: string, refresh = false, ttlMs = 30000): Promise<DatabaseSchema[]> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const dbKey = database ?? conn.database ?? (conn.engine === 'sqlite' ? 'main' : conn.engine === 'redis' ? '0' : conn.engine === 'neo4j' ? 'neo4j' : conn.engine === 'memgraph' ? 'memgraph' : conn.engine === 'falkordb' ? (conn.database || 'aidb') : conn.engine === 'influxdb' ? (conn.database || 'aidb') : conn.engine === 'arangodb' ? (conn.database || '_system') : conn.engine === 'elasticsearch' || conn.engine === 'opensearch' ? 'default' : conn.engine === 'cassandra' || conn.engine === 'scylla' ? 'system' : '');
    const cached = this.store.getSchemaCache(connectionId, dbKey);
    if (!refresh && cached && Date.now() - new Date(cached.fetchedAt).getTime() < ttlMs) {
      try {
        return JSON.parse(cached.payload) as DatabaseSchema[];
      } catch {
        /* fall through */
      }
    }
    const tables = await this.describe(connectionId, database);
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
    return schemas;
  }

  async findTable(connectionId: string, database: string | undefined, name: string): Promise<{ table: TableInfo; schema: DatabaseSchema }> {
    const schemas = await this.schema(connectionId, database);
    const target = name.toLowerCase();
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
    const driver = await this.driverFor(connectionId);
    if (!supportsStructuredQuery(driver)) {
      throw new DbError(`${engineMeta(conn.engine).label} 驱动不支持结构化查询`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    try {
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
    }
  }

  async queryStructured(connectionId: string, query: StructuredQuery, opts: QueryOptions): Promise<QueryBatchResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    return this.executeStructured(connectionId, conn, query, opts);
  }

  private async documentWriter(connectionId: string, collection: string) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    if (conn.readonly) {
      throw new DbError('只读连接不允许写入', { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可写入' });
    }
    if (!collection || !collection.trim()) {
      throw new DbError('collection 不能为空', { code: 'WRITE_COLLECTION' });
    }
    const driver = await this.driverFor(connectionId);
    if (!supportsDocumentWrite(driver)) {
      throw new DbError(`${meta.label} 暂不支持写入文档/向量`, { code: 'UNSUPPORTED_ENGINE', hint: '当前支持 MongoDB / ArangoDB / Qdrant / Weaviate / Milvus / Elasticsearch / OpenSearch' });
    }
    return { conn, driver, name: collection.trim() };
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
    this.invalidate(connectionId);
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
    this.invalidate(connectionId);
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
    const driver = await this.driverFor(connectionId);
    if (!supportsCollectionIndexes(driver)) {
      throw new DbError(`${meta.label} 驱动不支持索引管理`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    const result = await driver.createIndex(
      { ...input, collection: input.collection.trim() },
      { database: opts.database, timeoutMs: opts.timeoutMs },
    );
    this.invalidate(connectionId);
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
    const driver = await this.driverFor(connectionId);
    if (!supportsCollectionIndexes(driver)) {
      throw new DbError(`${meta.label} 驱动不支持索引管理`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    const result = await driver.dropIndex({ collection: input.collection.trim(), name: input.name.trim() }, {
      database: opts.database,
      timeoutMs: opts.timeoutMs,
    });
    this.invalidate(connectionId);
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
    const driver = await this.driverFor(connectionId);
    if (!supportsFieldAdd(driver)) {
      throw new DbError(`${meta.label} 驱动不支持追加字段`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    const result = await driver.createField(
      { object: input.object.trim(), name: input.name.trim(), type: input.type?.trim() || 'text' },
      { database: opts.database, timeoutMs: opts.timeoutMs },
    );
    this.invalidate(connectionId);
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
    this.invalidate(connectionId);
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
    this.invalidate(connectionId);
    this.store.addHistory({
      connectionId,
      database: opts.database ?? conn.database,
      sql: JSON.stringify({ createKey: { key: result.key, type: result.type } }),
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
    const driver = await this.driverFor(connectionId);
    if (!supportsObjectCreate(driver)) {
      throw new DbError(`${meta.label} 驱动不支持创建对象`, { code: 'UNSUPPORTED_ENGINE' });
    }
    const started = Date.now();
    const result = await driver.createObject(
      { name: input.name.trim(), dimension: input.dimension, distance: input.distance, fields: input.fields ?? [], edge: input.edge },
      { database: opts.database, timeoutMs: opts.timeoutMs },
    );
    this.invalidate(connectionId);
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
    const driver = await this.driverFor(connectionId);
    if (!supportsObjectCreate(driver)) {
      throw new DbError(`${meta.label} 暂不支持删除集合/索引`, { code: 'UNSUPPORTED_ENGINE', hint: '请在对应控制台执行删除命令' });
    }
    const started = Date.now();
    const result = await driver.dropObject(name, { database: opts.database, timeoutMs: opts.timeoutMs });
    this.invalidate(connectionId);
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
    const { conn, driver, name } = await this.documentWriter(connectionId, input.collection);
    const documents = input.documents ?? [];
    if (!documents.length) throw new DbError('至少需要一个文档', { code: 'WRITE_DOCUMENT' });
    if (documents.some((document) => !document || typeof document !== 'object' || Array.isArray(document))) {
      throw new DbError('documents 必须是 JSON 对象数组', { code: 'WRITE_DOCUMENT' });
    }
    const started = Date.now();
    try {
      const result = await driver.upsertDocuments({ collection: name, documents }, { database: opts.database, timeoutMs: opts.timeoutMs });
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
    const { conn, driver, name } = await this.documentWriter(connectionId, input.collection);
    const ids = input.ids.map((id) => String(id).trim()).filter(Boolean);
    if (!ids.length) throw new DbError('ids 不能为空', { code: 'WRITE_IDS', hint: '删除必须给出明确的 id 列表' });
    const started = Date.now();
    try {
      const result = await driver.deleteDocuments({ collection: name, ids }, { database: opts.database, timeoutMs: opts.timeoutMs });
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

  async vectorSearch(connectionId: string, query: VectorQuery, opts: QueryOptions): Promise<QueryResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    const meta = engineMeta(conn.engine);
    const topK = Math.max(1, Math.min(1000, Number(query.topK) || 10));
    let vector = query.vector;
    if (!vector?.length && query.text) vector = await embedText(this.settings(), query.text);
    const started = Date.now();
    const driver = await this.driverFor(connectionId);

    if (meta.model === 'vector') {
      if (!supportsVectorSearch(driver)) {
        throw new DbError(`${meta.label} 驱动不支持向量检索`, { code: 'UNSUPPORTED_ENGINE' });
      }
      try {
        const result = await driver.vectorSearch({ ...query, topK, vector }, { database: opts.database, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs });
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
      const literal = `[${vector.join(',')}]`;
      const sql = `SELECT *, 1 - (${vectorColumn} <=> $1::vector) AS score FROM ${target} ORDER BY ${vectorColumn} <=> $1::vector LIMIT ${topK}`;
      try {
        const result = await driver.runParams(sql, [literal], { database: opts.database, maxRows: topK, timeoutMs: opts.timeoutMs });
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
  }

  async query(connectionId: string, sql: string, opts: QueryOptions): Promise<QueryBatchResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      const query = this.parseStructuredQuery(conn, sql);
      return this.executeStructured(connectionId, conn, query, opts);
    }
    const statements = splitStatements(sql);
    if (!statements.length) throw new DbError('SQL 为空', { code: 'EMPTY_SQL' });
    if (statements.length > 1 && !opts.allowMulti) {
      throw new DbError('默认不允许一次执行多条语句，请在设置中开启或在编辑器中逐条执行', { code: 'MULTI_STATEMENT_DISABLED' });
    }
    if (conn.readonly) {
      for (const statement of statements) {
        const violation = readonlyViolation(statement, conn.engine);
        if (violation) throw new DbError(violation, { code: 'READONLY', status: 403, hint: '在连接设置中关闭只读后才可写入' });
      }
    }
    const driver = await this.driverFor(connectionId);
    const started = Date.now();
    const sets: QueryResult[] = [];
    const messages: string[] = [];
    let failure: Error | undefined;
    try {
      for (const [index, statement] of statements.entries()) {
        const prepared = opts.autoLimit !== false && opts.maxRows ? applyLimit(statement, opts.maxRows, conn.engine) : statement;
        try {
          const result = await driver.run(prepared, { database: opts.database, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs });
          sets.push(result);
          messages.push(
            result.columns.length
              ? `[${index + 1}] ${result.rowCount} 行 · ${result.durationMs}ms`
              : `[${index + 1}] 影响 ${result.affected ?? 0} 行 · ${result.durationMs}ms`,
          );
        } catch (err: any) {
          failure = err;
          throw err;
        }
      }
      return { sets, messages, durationMs: Date.now() - started };
    } catch (err: any) {
      this.store.addHistory({
        connectionId,
        database: opts.database ?? conn.database,
        sql,
        status: 'error',
        durationMs: Date.now() - started,
        error: err?.message ?? '执行失败',
      });
      throw err instanceof DbError ? err : new DbError(err?.message ?? '执行失败');
    } finally {
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
    }
  }

  async runParams(connectionId: string, sql: string, params: unknown[], opts: { database?: string; timeoutMs?: number; actor: 'user' | 'agent' }): Promise<QueryResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (!engineMeta(conn.engine).languages.includes('sql')) {
      throw new DbError(`${engineMeta(conn.engine).label} 不支持参数化 SQL`, { code: 'UNSUPPORTED_ENGINE' });
    }
    if (conn.readonly) throw new DbError('该连接为只读，禁止写入', { code: 'READONLY', status: 403 });
    const driver = await this.driverFor(connectionId);
    return driver.runParams(sql, params, { database: opts.database, timeoutMs: opts.timeoutMs });
  }

  async rawDriver(connectionId: string): Promise<Driver> {
    return this.driverFor(connectionId);
  }

  async close(connectionId: string): Promise<void> {
    const cached = this.clients.get(connectionId);
    if (cached) {
      await cached.close().catch(() => undefined);
      this.clients.delete(connectionId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.entries()].map(async ([id]) => this.close(id)));
  }

  invalidate(connectionId: string): void {
    this.store.clearSchemaCache(connectionId);
  }
}
