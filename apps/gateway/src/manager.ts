import {
  applyLimit,
  engineUsesSchema,
  readonlyViolation,
  splitStatements,
  type AppSettings,
  type ConnectionConfig,
  type ConnectionSecret,
  type DatabaseSchema,
  type QueryBatchResult,
  type QueryResult,
  type TableInfo,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { createDriver, DbError, type Driver } from './drivers';
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
    const dbKey = database ?? conn.database ?? (conn.engine === 'sqlite' ? 'main' : '');
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
        const fallback = conn.engine === 'sqlserver' ? 'dbo' : conn.engine === 'oracle' ? (conn.username ?? '').toUpperCase() : dbKey || 'public';
        const key = table.schema ?? fallback;
        groups.set(key, [...(groups.get(key) ?? []), table]);
      }
      if (!groups.size) groups.set(dbKey || 'public', []);
      schemas = [...groups.entries()].map(([name, list]) => ({ name, tables: list }));
    } else {
      schemas = [{ name: dbKey || 'main', tables }];
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

  async query(connectionId: string, sql: string, opts: QueryOptions): Promise<QueryBatchResult> {
    const conn = this.store.getConnection(connectionId);
    if (!conn) throw new DbError('连接不存在', { code: 'CONNECTION_NOT_FOUND', status: 404 });
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
