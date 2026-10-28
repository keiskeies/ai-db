import {
  buildAlterTable,
  buildCount,
  buildCreateIndex,
  buildCreateTable,
  buildDropIndex,
  buildDropObject,
  buildExplain,
  buildSelectTable,
  classifySql,
  deltas,
  engineUsesSchema,
  forecastSeries,
  getTool,
  guessAxes,
  isTimeSeries,
  looksLikeSecret,
  quoteIdent,
  resolveRisk,
  round,
  summarize,
  toSeries,
  topShare,
  type AlterOp,
  type AppSettings,
  type ColumnDef,
  type ConnectionConfig,
  type Engine,
  type ForecastMethod,
  type IndexDef,
  type MemoryCandidate,
  type QueryResult,
  type StatPoint,
  type TableInfo,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { DbError } from './drivers';
import type { ConnectionManager } from './manager';
import { dumpDatabase, importCsv, writeExportFile } from './services';
import { generateData } from './features/generate';
import type { Store } from './store';

export interface ToolContext {
  sessionId: string;
  connectionId?: string;
  signal?: AbortSignal;
}

const DB_TOOLS = new Set([
  'inspect_schema',
  'search_objects',
  'run_sql',
  'explain_sql',
  'sample_rows',
  'profile_column',
  'create_table',
  'alter_table',
  'drop_object',
  'manage_index',
  'export_result',
  'import_csv',
  'backup_database',
  'audit_database',
  'check_data_quality',
  'render_chart',
  'analyze_chart',
  'forecast_chart',
  'generate_data',
]);

const SENSITIVE = /pass|secret|token|api[_-]?key|phone|mobile|email|ssn|card|身份证|手机|邮箱/i;

function ok(started: number, summary: string, data?: unknown, meta: Partial<ToolResult['meta']> = {}): ToolResult {
  return { ok: true, summary, data, meta: { durationMs: Date.now() - started, ...meta } };
}

export class ToolExecutor {
  constructor(
    private store: Store,
    private manager: ConnectionManager,
    private config: GatewayConfig,
    private getSettings: () => AppSettings,
  ) {}

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const tool = getTool(call.name);
    let result: ToolResult;
    try {
      result = await this.dispatch(call, ctx, started);
    } catch (err: any) {
      result = {
        ok: false,
        summary: '工具执行失败',
        error: { code: err?.code ?? 'TOOL_ERROR', message: err?.message ?? '未知错误', hint: err?.hint },
        meta: { durationMs: Date.now() - started },
      };
    }
    if (DB_TOOLS.has(call.name)) {
      const risk = tool ? resolveRisk(call, tool) : undefined;
      const generated = (result.data as { ddl?: string; statements?: string[] } | undefined)?.ddl
        ?? (result.data as { statements?: string[] } | undefined)?.statements?.join(';\n');
      const sql = typeof call.args.sql === 'string' ? call.args.sql : generated;
      this.store.addAudit({
        actor: 'agent',
        connectionId: this.connectionIdOf(call, ctx),
        database: typeof call.args.database === 'string' ? call.args.database : undefined,
        tool: call.name,
        sql,
        risk,
        approval: 'policy',
        status: result.ok ? 'ok' : 'error',
        durationMs: result.meta.durationMs,
        meta: { sessionId: ctx.sessionId, callId: call.id, error: result.error?.code, summary: result.summary },
      });
    }
    return result;
  }

  private connectionIdOf(call: ToolCall, ctx: ToolContext): string | undefined {
    return typeof call.args.connectionId === 'string' ? call.args.connectionId : ctx.connectionId;
  }

  private requireConnection(call: ToolCall, ctx: ToolContext) {
    const id = this.connectionIdOf(call, ctx);
    if (!id) throw new DbError('缺少 connectionId：请先选择连接或调用 list_connections', { code: 'NO_CONNECTION' });
    const conn = this.store.getConnection(id);
    if (!conn) throw new DbError(`连接不存在：${id}`, { code: 'CONNECTION_NOT_FOUND' });
    return conn;
  }

  private databaseOf(call: ToolCall, conn: { database?: string }): string | undefined {
    return typeof call.args.database === 'string' && call.args.database ? call.args.database : conn.database;
  }

  private ref(engine: Engine, table: TableInfo, name?: string): string {
    if (engineUsesSchema(engine) && table.schema) {
      return `${quoteIdent(table.schema, engine)}.${quoteIdent(name ?? table.name, engine)}`;
    }
    return quoteIdent(name ?? table.name, engine);
  }

  private schemaFor(conn: ConnectionConfig, table?: TableInfo): string | undefined {
    if (!engineUsesSchema(conn.engine)) return undefined;
    if (table?.schema) return table.schema;
    if (conn.engine === 'sqlserver') return 'dbo';
    if (conn.engine === 'oracle') return (conn.username ?? '').toUpperCase();
    if (conn.engine === 'clickhouse') return conn.database ?? 'default';
    return 'public';
  }

  private async dispatch(call: ToolCall, ctx: ToolContext, started: number): Promise<ToolResult> {
    const a = call.args;
    switch (call.name) {
      case 'list_connections': {
        const connections = this.store.listConnections();
        return ok(started, `共有 ${connections.length} 个连接`, { connections });
      }

      case 'inspect_schema': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const schemas = await this.manager.schema(conn.id, database);
        let tables = schemas.flatMap((s) => s.tables);
        const wanted = Array.isArray(a.tables) ? (a.tables as string[]).map((t) => String(t).toLowerCase()) : [];
        if (wanted.length) {
          tables = tables.filter((t) => wanted.includes(t.name.toLowerCase()));
          if (!tables.length) {
            return {
              ok: false,
              summary: '没有找到指定表',
              error: { code: 'TABLE_NOT_FOUND', message: `未找到表：${(a.tables as string[]).join(', ')}`, hint: '使用 search_objects 搜索真实表名' },
              meta: { durationMs: Date.now() - started },
            };
          }
        }
        const trimmed = tables.slice(0, 300);
        return ok(started, `读取到 ${trimmed.length} 个对象`, {
          connectionId: conn.id,
          database,
          engine: conn.engine,
          tables: trimmed,
          schemas: schemas.map((s) => ({ name: s.name, tables: s.tables.length })),
        });
      }

      case 'search_objects': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const query = String(a.query ?? '').toLowerCase().trim();
        if (!query) throw new DbError('query 不能为空');
        const limit = Math.min(100, Number(a.limit) || 20);
        const schemas = await this.manager.schema(conn.id, database);
        const matches: Array<{ table: string; schema?: string; matchedColumns: string[]; comment?: string }> = [];
        for (const schema of schemas) {
          for (const table of schema.tables) {
            if (table.name.toLowerCase().includes(query) || (table.comment ?? '').toLowerCase().includes(query)) {
              matches.push({ table: table.name, schema: table.schema, matchedColumns: [], comment: table.comment });
            } else {
              const cols = (table.columns ?? []).filter((c) => c.name.toLowerCase().includes(query)).map((c) => c.name);
              if (cols.length) matches.push({ table: table.name, schema: table.schema, matchedColumns: cols });
            }
            if (matches.length >= limit) break;
          }
        }
        return ok(started, `找到 ${matches.length} 个匹配对象`, { matches, total: matches.length });
      }

      case 'run_sql': {
        const conn = this.requireConnection(call, ctx);
        const sql = String(a.sql ?? '').trim();
        if (!sql) throw new DbError('SQL 不能为空', { code: 'EMPTY_SQL' });
        if (a.dryRun === true) {
          const classification = classifySql(sql);
          return ok(started, '仅编译，未执行', {
            statements: classification.statements.map((s) => s.sql),
            risk: classification.risk,
          });
        }
        const settings = this.getSettings();
        const maxRows = Math.min(5000, Math.max(1, Number(a.maxRows) || settings.defaultLimit));
        const batch = await this.manager.query(conn.id, sql, {
          database: this.databaseOf(call, conn),
          maxRows,
          timeoutMs: settings.queryTimeoutMs,
          allowMulti: settings.allowMultiStatement,
          autoLimit: settings.autoLimit,
          actor: 'agent',
        });
        if (/^\s*(create|alter|drop|rename)/i.test(sql)) this.manager.invalidate(conn.id);
        const last = batch.sets[batch.sets.length - 1];
        const summary = last
          ? last.columns.length
            ? `返回 ${last.rowCount} 行${last.truncated ? '（已截断）' : ''}`
            : `影响 ${last.affected ?? 0} 行`
          : '执行完成';
        return ok(started, summary, {
          ...last,
          sets: batch.sets.length > 1 ? batch.sets : undefined,
          messages: batch.messages,
          durationMs: batch.durationMs,
        });
      }

      case 'explain_sql': {
        const conn = this.requireConnection(call, ctx);
        const sql = String(a.sql ?? '').trim();
        if (!sql) throw new DbError('SQL 不能为空');
        if (conn.engine === 'sqlserver') {
          throw new DbError('SQL Server 暂不支持自动 EXPLAIN，请在 SSMS 中查看实际执行计划', {
            code: 'EXPLAIN_UNSUPPORTED',
            hint: '可以改用 audit_database / 索引检查，或粘贴执行计划 XML 让 AI 解读',
          });
        }
        const explain = buildExplain(conn.engine, sql);
        const script =
          conn.engine === 'oracle'
            ? `${explain};
SELECT PLAN_TABLE_OUTPUT AS plan FROM TABLE(DBMS_XPLAN.DISPLAY())`
            : explain;
        const batch = await this.manager.query(conn.id, script, {
          database: this.databaseOf(call, conn),
          maxRows: 200,
          allowMulti: conn.engine === 'oracle',
          autoLimit: false,
          actor: 'agent',
        });
        const last = batch.sets[batch.sets.length - 1];
        return ok(started, '执行计划已生成', { sql: explain, plan: last?.rows ?? [], columns: last?.columns ?? [] });
      }

      case 'sample_rows': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const tableName = String(a.table ?? '');
        if (!tableName) throw new DbError('table 不能为空');
        const { table } = await this.manager.findTable(conn.id, database, tableName);
        const limit = Math.min(100, Math.max(1, Number(a.limit) || 10));
        const sql = buildSelectTable(conn.engine, table.name, { schema: this.schemaFor(conn, table), limit });
        const batch = await this.manager.query(conn.id, sql, { database, maxRows: limit, allowMulti: false, autoLimit: false, actor: 'agent' });
        const result = batch.sets[0];
        if (result && a.maskSensitive !== false) {
          const sensitive = result.columns.map((c) => SENSITIVE.test(c.name));
          result.rows = result.rows.map((row) => row.map((v, i) => (sensitive[i] && v !== null ? '••••' : v)));
        }
        return ok(started, `读取 ${result?.rowCount ?? 0} 行样例`, { table: table.name, ...result });
      }

      case 'profile_column': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const tableName = String(a.table ?? '');
        const column = String(a.column ?? '');
        const { table } = await this.manager.findTable(conn.id, database, tableName);
        if (!(table.columns ?? []).some((c) => c.name === column)) throw new DbError(`列不存在：${column}`);
        const ref = this.ref(conn.engine, table);
        const col = quoteIdent(column, conn.engine);
        const run = async (sql: string): Promise<QueryResult> => {
          const batch = await this.manager.query(conn.id, sql, { database, maxRows: 20, allowMulti: false, autoLimit: false, actor: 'agent' });
          return batch.sets[0];
        };
        const overview = await run(`SELECT COUNT(*) AS total, SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS nulls FROM ${ref}`);
        const distinct = await run(`SELECT COUNT(DISTINCT ${col}) AS distinct_count FROM ${ref}`);
        const top = await run(`SELECT ${col} AS value, COUNT(*) AS count FROM ${ref} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC LIMIT 5`);
        const range = await run(`SELECT MIN(${col}) AS min_value, MAX(${col}) AS max_value FROM ${ref}`);
        const total = Number(overview.rows[0]?.[0] ?? 0);
        const nulls = Number(overview.rows[0]?.[1] ?? 0);
        return ok(started, `${table.name}.${column} 画像完成`, {
          table: table.name,
          column,
          total,
          nulls,
          nullRatio: total ? Number((nulls / total).toFixed(4)) : 0,
          distinct: Number(distinct.rows[0]?.[0] ?? 0),
          top: top.rows.map((r) => ({ value: r[0], count: r[1] })),
          min: range.rows[0]?.[0] ?? null,
          max: range.rows[0]?.[1] ?? null,
        });
      }

      case 'create_table': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const tableName = String(a.table ?? '').trim();
        if (!tableName) throw new DbError('表名不能为空');
        const columns = Array.isArray(a.columns) ? (a.columns as ColumnDef[]) : [];
        if (!columns.length) throw new DbError('至少需要一列');
        const normalized = columns.map((c) => ({
          ...c,
          name: String(c.name ?? '').trim(),
          type: String(c.type ?? 'TEXT').trim() || 'TEXT',
          autoIncrement: Boolean(c.autoIncrement),
        }));
        for (const c of normalized) if (!c.name) throw new DbError('列名不能为空');
        if (normalized.filter((c) => c.autoIncrement).length > 1) throw new DbError('只能有一列自增');
        for (const c of normalized) if (c.autoIncrement && !/int|serial/i.test(c.type)) c.type = 'INTEGER';
        const indexes = Array.isArray(a.indexes) ? (a.indexes as IndexDef[]) : [];
        const ddl = buildCreateTable(conn.engine, {
          table: tableName,
          columns: normalized,
          indexes,
          schema: this.schemaFor(conn),
          comment: typeof a.comment === 'string' ? a.comment : undefined,
        });
        const settings = this.getSettings();
        const batch = await this.manager.query(conn.id, ddl, {
          database,
          allowMulti: true,
          autoLimit: false,
          timeoutMs: settings.queryTimeoutMs,
          actor: 'agent',
        });
        this.manager.invalidate(conn.id);
        return ok(started, `已创建表 ${tableName}`, { table: tableName, ddl, statements: batch.sets.length, messages: batch.messages });
      }

      case 'alter_table': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const tableName = String(a.table ?? '');
        const { table } = await this.manager.findTable(conn.id, database, tableName);
        const operations = Array.isArray(a.operations) ? (a.operations as AlterOp[]) : [];
        if (!operations.length) throw new DbError('operations 不能为空');
        const statements = buildAlterTable(conn.engine, table.name, operations, this.schemaFor(conn, table));
        const settings = this.getSettings();
        await this.manager.query(conn.id, statements.join(';\n'), {
          database,
          allowMulti: true,
          autoLimit: false,
          timeoutMs: settings.queryTimeoutMs,
          actor: 'agent',
        });
        this.manager.invalidate(conn.id);
        return ok(started, `已修改表 ${tableName}（${statements.length} 条语句）`, { table: tableName, statements });
      }

      case 'drop_object': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const name = String(a.name ?? '');
        const kind = a.kind === 'view' ? 'view' : 'table';
        const schemas = await this.manager.schema(conn.id, database);
        const found = schemas.flatMap((s) => s.tables).find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (!found) throw new DbError(`对象不存在：${name}`);
        let backupPath: string | undefined;
        const settings = this.getSettings();
        if (settings.agent.snapshotBeforeWrite) {
          const backup = await dumpDatabase(this.store, this.manager, this.config, conn.id, database, `auto-before-drop:${name}`);
          backupPath = backup.path;
        }
        const sql = buildDropObject(conn.engine, kind, found.name, Boolean(a.cascade), this.schemaFor(conn, found));
        await this.manager.query(conn.id, sql, { database, allowMulti: false, autoLimit: false, timeoutMs: settings.queryTimeoutMs, actor: 'agent' });
        this.manager.invalidate(conn.id);
        return ok(started, `已删除${kind === 'view' ? '视图' : '表'} ${found.name}`, { name: found.name, kind, sql, backupPath }, { backupPath });
      }

      case 'manage_index': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const tableName = String(a.table ?? '');
        const { table } = await this.manager.findTable(conn.id, database, tableName);
        const action = a.action === 'drop' ? 'drop' : 'create';
        let sql: string;
        if (action === 'drop') {
          const name = String(a.name ?? (a.index as IndexDef | undefined)?.name ?? '');
          if (!name) throw new DbError('删除索引需要 name');
          sql = buildDropIndex(conn.engine, table.name, name, this.schemaFor(conn, table));
        } else {
          const raw = (a.index ?? {}) as IndexDef;
          const columns = Array.isArray(raw.columns) ? raw.columns.map(String) : [];
          if (!columns.length) throw new DbError('创建索引需要 columns');
          for (const col of columns) {
            if (!(table.columns ?? []).some((c) => c.name === col)) throw new DbError(`列不存在：${col}`);
          }
          sql = buildCreateIndex(
            conn.engine,
            table.name,
            { name: raw.name, columns, unique: Boolean(raw.unique) },
            this.schemaFor(conn, table),
          );
        }
        const settings = this.getSettings();
        await this.manager.query(conn.id, sql, { database, allowMulti: false, autoLimit: false, timeoutMs: settings.queryTimeoutMs, actor: 'agent' });
        this.manager.invalidate(conn.id);
        return ok(started, action === 'drop' ? '索引已删除' : '索引已创建', { table: table.name, sql });
      }

      case 'export_result': {
        const conn = this.requireConnection(call, ctx);
        const database = this.databaseOf(call, conn);
        const format = ['csv', 'json', 'sql'].includes(String(a.format)) ? (String(a.format) as 'csv' | 'json' | 'sql') : 'csv';
        const limit = Math.min(200000, Math.max(1, Number(a.limit) || 10000));
        let sql: string;
        let tableName: string | undefined;
        if (typeof a.sql === 'string' && a.sql.trim()) sql = a.sql;
        else if (typeof a.table === 'string' && a.table) {
          const { table } = await this.manager.findTable(conn.id, database, a.table);
          tableName = table.name;
          sql = buildSelectTable(conn.engine, table.name, { schema: this.schemaFor(conn, table), limit });
        } else throw new DbError('需要 sql 或 table 之一');
        const batch = await this.manager.query(conn.id, sql, {
          database,
          maxRows: limit,
          allowMulti: false,
          autoLimit: false,
          actor: 'agent',
        });
        const set = batch.sets[0];
        if (!set) throw new DbError('没有可导出的结果');
        const file = writeExportFile({
          dir: this.config.exportDir,
          format,
          columns: set.columns.map((c) => c.name),
          rows: set.rows,
          tableName,
          engine: conn.engine,
        });
        return ok(started, `已导出 ${file.rows} 行为 ${format.toUpperCase()}`, { ...file, format, table: tableName });
      }

      case 'import_csv': {
        const conn = this.requireConnection(call, ctx);
        const result = await importCsv(this.store, this.manager, this.config, conn.id, {
          table: String(a.table ?? ''),
          path: typeof a.path === 'string' ? a.path : undefined,
          hasHeader: a.hasHeader !== false,
          delimiter: typeof a.delimiter === 'string' ? a.delimiter : undefined,
          mapping: Array.isArray(a.mapping) ? (a.mapping as Array<{ column: string; sourceIndex?: number }>) : undefined,
        });
        this.manager.invalidate(conn.id);
        return ok(started, `已导入 ${result.inserted} 行`, result);
      }

      case 'backup_database': {
        const conn = this.requireConnection(call, ctx);
        const backup = await dumpDatabase(this.store, this.manager, this.config, conn.id, this.databaseOf(call, conn), typeof a.label === 'string' ? a.label : undefined);
        return ok(started, `备份完成：${backup.tables} 张表 / ${backup.rows} 行`, backup, { backupPath: backup.path });
      }

      case 'get_query_history': {
        const connectionId = typeof a.connectionId === 'string' ? a.connectionId : ctx.connectionId;
        const items = this.store.listHistory({
          connectionId,
          search: typeof a.search === 'string' ? a.search : undefined,
          limit: Math.min(100, Number(a.limit) || 30),
        });
        return ok(started, `读取 ${items.length} 条历史`, { items });
      }

      case 'update_plan': {
        return ok(started, '计划已更新', { items: a.items ?? [] });
      }

      case 'memory_write': {
        const conn = this.connectionIdOf(call, ctx) ? this.store.getConnection(this.connectionIdOf(call, ctx)!) : undefined;
        const title = String(a.title ?? '').trim();
        const content = String(a.content ?? '').trim();
        const kind = String(a.kind ?? 'fact') as MemoryCandidate['kind'];
        if (!title || !content) throw new DbError('title 与 content 不能为空');
        if (!['fact', 'preference', 'schema', 'procedural'].includes(kind)) throw new DbError('不支持的记忆类型');
        if (looksLikeSecret(`${title} ${content}`)) throw new DbError('疑似包含密钥或凭据，拒绝写入记忆', { code: 'SECRET_REJECTED' });
        const scopeType = ['global', 'connection', 'database', 'table'].includes(String(a.scopeType)) ? (String(a.scopeType) as MemoryCandidate['scopeType']) : undefined;
        let scopeKey = typeof a.scopeKey === 'string' ? a.scopeKey : undefined;
        if (scopeType === 'table' && scopeKey && conn && !scopeKey.includes('/')) scopeKey = `${conn.id}/${scopeKey}`;
        if (scopeType === 'database' && scopeKey && conn && !scopeKey.includes('/')) scopeKey = `${conn.id}/${scopeKey}`;
        const candidate: MemoryCandidate = {
          kind,
          title,
          content,
          tags: Array.isArray(a.tags) ? (a.tags as string[]).map(String) : undefined,
          importance: typeof a.importance === 'number' ? a.importance : 0.65,
          scopeType,
          scopeKey,
        };
        const { memory, merged } = this.store.upsertMemoryCandidate(candidate, {
          connectionId: conn?.id,
          database: this.databaseOf(call, conn ?? {}),
          sessionId: ctx.sessionId,
        });
        return ok(started, `已记住：${memory.title}（${merged ? '已合并相近记忆' : '新记忆'}）`, { memory, merged });
      }

      case 'memory_search': {
        const conn = this.connectionIdOf(call, ctx) ? this.store.getConnection(this.connectionIdOf(call, ctx)!) : undefined;
        const memories = this.store.searchMemories(String(a.query ?? ''), {
          connectionId: conn?.id,
          database: this.databaseOf(call, conn ?? {}),
          limit: Math.min(20, Number(a.limit) || 8),
        });
        return ok(started, `检索到 ${memories.length} 条记忆`, { memories });
      }

      case 'audit_database': {
        const conn = this.requireConnection(call, ctx);
        return this.auditDatabase(conn, this.databaseOf(call, conn), started);
      }

      case 'check_data_quality': {
        const conn = this.requireConnection(call, ctx);
        return this.checkDataQuality(
          conn,
          this.databaseOf(call, conn),
          String(a.table ?? ''),
          Array.isArray(a.columns) ? (a.columns as string[]) : undefined,
          started,
        );
      }

      case 'generate_data': {
        const conn = this.requireConnection(call, ctx);
        const result = await generateData(this.store, this.manager, {
          connectionId: conn.id,
          database: this.databaseOf(call, conn),
          table: String(a.table ?? ''),
          rows: Math.min(5000, Number(a.rows) || 10),
          dryRun: a.dryRun === true,
        });
        return ok(started, result.dryRun ? `生成预览 ${result.rowsPreview.length} 行` : `已生成 ${result.inserted} 行数据`, result);
      }

      case 'render_chart': {
        const conn = this.requireConnection(call, ctx);
        return this.renderChart(
          conn,
          this.databaseOf(call, conn),
          String(a.sql ?? ''),
          a.type === 'line' || a.type === 'pie' ? a.type : 'bar',
          typeof a.title === 'string' ? a.title : undefined,
          typeof a.x === 'string' ? a.x : undefined,
          typeof a.y === 'string' ? a.y : undefined,
          started,
        );
      }

      case 'analyze_chart': {
        const conn = this.requireConnection(call, ctx);
        return this.analyzeChart(conn, this.databaseOf(call, conn), String(a.sql ?? ''), typeof a.x === 'string' ? a.x : undefined, typeof a.y === 'string' ? a.y : undefined, typeof a.topN === 'number' ? a.topN : undefined, started);
      }

      case 'forecast_chart': {
        const conn = this.requireConnection(call, ctx);
        return this.forecastChart(
          conn,
          this.databaseOf(call, conn),
          String(a.sql ?? ''),
          typeof a.x === 'string' ? a.x : undefined,
          typeof a.y === 'string' ? a.y : undefined,
          typeof a.periods === 'number' ? a.periods : undefined,
          a.method === 'linear' || a.method === 'moving_average' || a.method === 'auto' ? (a.method as ForecastMethod) : undefined,
          started,
        );
      }

      default:
        throw new DbError(`未实现的工具：${call.name}`, { code: 'UNKNOWN_TOOL' });
    }
  }

  private async auditDatabase(conn: ConnectionConfig, database: string | undefined, started: number): Promise<ToolResult> {
    const schemas = await this.manager.schema(conn.id, database);
    const tables = schemas.flatMap((schema) => schema.tables);
    const findings: Array<{ severity: 'high' | 'medium' | 'low' | 'info'; code: string; title: string; table?: string; detail: string; suggestedSql?: string }> = [];
    let counted = 0;
    for (const table of tables) {
      if (table.type !== 'table') continue;
      const ref = this.ref(conn.engine, table);
      const pkCols = (table.columns ?? []).filter((c) => c.primaryKey);
      if (!pkCols.length && conn.engine !== 'clickhouse') {
        const candidate = (table.columns ?? []).find((c) => /^id$/i.test(c.name)) ?? table.columns?.[0];
        findings.push({
          severity: 'high',
          code: 'NO_PRIMARY_KEY',
          title: '缺少主键',
          table: table.name,
          detail: `表 ${table.name} 没有主键，行定位/去重/增量同步缺少稳定依据。`,
          suggestedSql: candidate
            ? `-- 确认 ${candidate.name} 唯一后执行\nALTER TABLE ${ref} ADD CONSTRAINT ${quoteIdent('pk_' + table.name, conn.engine)} PRIMARY KEY (${quoteIdent(candidate.name, conn.engine)})`
            : undefined,
        });
      }
      if (conn.engine !== 'clickhouse') {
        for (const fk of table.foreignKeys ?? []) {
          const covered = (table.indexes ?? []).some(
            (idx) => idx.columns.length >= fk.columns.length && fk.columns.every((column, index) => idx.columns[index] === column),
          );
          if (!covered) {
            findings.push({
              severity: 'medium',
              code: 'FK_WITHOUT_INDEX',
              title: '外键缺少索引',
              table: table.name,
              detail: `外键 ${fk.columns.join(', ')} → ${fk.refTable} 没有前缀索引，关联/级联检查可能全表扫描。`,
              suggestedSql: buildCreateIndex(conn.engine, table.name, { columns: fk.columns }, this.schemaFor(conn, table)),
            });
          }
        }
        const seen = new Map<string, string>();
        for (const idx of table.indexes ?? []) {
          if (idx.primary) continue;
          const signature = idx.columns.join('|') + '|' + String(idx.unique);
          const previous = seen.get(signature);
          if (previous) {
            findings.push({
              severity: 'low',
              code: 'DUPLICATE_INDEX',
              title: '重复索引',
              table: table.name,
              detail: `索引 ${idx.name} 与 ${previous} 列组合相同。`,
              suggestedSql: buildDropIndex(conn.engine, table.name, idx.name, this.schemaFor(conn, table)),
            });
          } else {
            seen.set(signature, idx.name);
          }
        }
      }
      if (counted < 30) {
        counted++;
        try {
          const countBatch = await this.manager.query(conn.id, buildCount(conn.engine, table.name, this.schemaFor(conn, table)), {
            database,
            maxRows: 1,
            allowMulti: false,
            autoLimit: false,
            actor: 'agent',
          });
          const count = Number(countBatch.sets[0]?.rows?.[0]?.[0] ?? 0);
          if (count === 0) {
            findings.push({ severity: 'info', code: 'EMPTY_TABLE', title: '空表', table: table.name, detail: `表 ${table.name} 当前 0 行。` });
          } else if (count > 500000) {
            findings.push({ severity: 'info', code: 'LARGE_TABLE', title: '大表', table: table.name, detail: `表 ${table.name} 约 ${count.toLocaleString()} 行，请确认索引与分页策略。` });
          }
        } catch {
          /* best effort */
        }
      }
    }
    const order = { high: 0, medium: 1, low: 2, info: 3 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    const summary = {
      tablesChecked: tables.filter((t) => t.type === 'table').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      info: findings.filter((f) => f.severity === 'info').length,
    };
    return ok(started, `体检完成：${summary.tablesChecked} 张表，${summary.high} 高 / ${summary.medium} 中 / ${summary.low} 低风险`, {
      connectionId: conn.id,
      database,
      engine: conn.engine,
      findings,
      summary,
    });
  }

  private async checkDataQuality(
    conn: ConnectionConfig,
    database: string | undefined,
    tableName: string,
    requestedColumns: string[] | undefined,
    started: number,
  ): Promise<ToolResult> {
    if (!tableName) throw new DbError('table 不能为空');
    const { table } = await this.manager.findTable(conn.id, database, tableName);
    const ref = this.ref(conn.engine, table);
    const allColumns = table.columns ?? [];
    const columns = (requestedColumns?.length ? allColumns.filter((c) => requestedColumns.includes(c.name)) : allColumns).slice(0, 12);
    if (!columns.length) throw new DbError('没有可检查的列');
    const parts: string[] = [`COUNT(*) AS ${quoteIdent('total', conn.engine)}`];
    columns.forEach((column, index) => {
      const q = quoteIdent(column.name, conn.engine);
      parts.push(`SUM(CASE WHEN ${q} IS NULL THEN 1 ELSE 0 END) AS ${quoteIdent('n_' + index, conn.engine)}`);
      if (!/date|time|blob|binary|json/i.test(column.type) && conn.engine !== 'oracle' && conn.engine !== 'clickhouse') {
        parts.push(`SUM(CASE WHEN ${q} = '' THEN 1 ELSE 0 END) AS ${quoteIdent('b_' + index, conn.engine)}`);
      }
      parts.push(`COUNT(DISTINCT ${q}) AS ${quoteIdent('d_' + index, conn.engine)}`);
    });
    const sql = `SELECT ${parts.join(', ')} FROM ${ref}`;
    const batch = await this.manager.query(conn.id, sql, {
      database,
      maxRows: 1,
      allowMulti: false,
      autoLimit: false,
      actor: 'agent',
    });
    const set = batch.sets[0];
    if (!set) throw new DbError('质量检查没有返回结果');
    const names = set.columns.map((column) => column.name);
    const value = (row: unknown[], name: string) => row[names.indexOf(name)];
    const row = set.rows[0] ?? [];
    const total = Number(value(row, 'total') ?? 0);
    const stats = columns.map((column, index) => {
      const nulls = Number(value(row, 'n_' + index) ?? 0);
      const blanks = Number(value(row, 'b_' + index) ?? 0);
      const distinct = Number(value(row, 'd_' + index) ?? 0);
      return {
        name: column.name,
        type: column.type,
        nulls,
        nullRatio: total ? Number((nulls / total).toFixed(4)) : 0,
        blanks,
        distinct,
      };
    });
    const pkCols = allColumns.filter((c) => c.primaryKey);
    let duplicates: unknown[][] = [];
    if (pkCols.length) {
      const group = pkCols.map((c) => quoteIdent(c.name, conn.engine)).join(', ');
      const dupSql = `SELECT ${group}, COUNT(*) AS ${quoteIdent('duplicate_count', conn.engine)} FROM ${ref} GROUP BY ${group} HAVING COUNT(*) > 1`;
      const dupBatch = await this.manager.query(conn.id, dupSql, {
        database,
        maxRows: 5,
        allowMulti: false,
        autoLimit: false,
        actor: 'agent',
      });
      duplicates = dupBatch.sets[0]?.rows ?? [];
    }
    const findings: Array<{ severity: 'high' | 'medium' | 'low' | 'info'; code: string; title: string; detail: string; suggestedSql?: string }> = [];
    for (const stat of stats) {
      if (stat.nulls > 0) {
        const severity = stat.nullRatio >= 0.3 ? 'high' : stat.nullRatio >= 0.05 ? 'medium' : 'low';
        findings.push({
          severity,
          code: 'NULLS',
          title: `${stat.name} 存在空值`,
          detail: `${stat.nulls.toLocaleString()} / ${total.toLocaleString()} 行（${(stat.nullRatio * 100).toFixed(1)}%）为 NULL。`,
          suggestedSql: `SELECT * FROM ${ref} WHERE ${quoteIdent(stat.name, conn.engine)} IS NULL LIMIT 100`,
        });
      }
      if (stat.blanks > 0) {
        findings.push({
          severity: 'low',
          code: 'BLANKS',
          title: `${stat.name} 存在空字符串`,
          detail: `${stat.blanks.toLocaleString()} 行是空字符串，可能应存为 NULL。`,
          suggestedSql: `SELECT * FROM ${ref} WHERE ${quoteIdent(stat.name, conn.engine)} = '' LIMIT 100`,
        });
      }
      if (stat.distinct <= 1 && total > 1) {
        findings.push({ severity: 'info', code: 'LOW_CARDINALITY', title: `${stat.name} 只有 1 个不同值`, detail: '该列区分度极低，检查是否冗余或默认值填充。' });
      }
    }
    if (duplicates.length) {
      findings.push({ severity: 'high', code: 'DUPLICATE_KEYS', title: '主键存在重复', detail: `发现 ${duplicates.length} 组重复主键（显示前 5 组）。` });
    }
    return ok(started, `质量检查完成：${total.toLocaleString()} 行，${findings.length} 项发现`, {
      table: table.name,
      total,
      columnStats: stats,
      duplicates,
      findings,
    });
  }

  /**
   * 跑一次 SELECT 并把结果解析成 (x, y) 序列，render_chart / analyze_chart / forecast_chart 共用。
   * NULL 由 core 的 toSeries 丢弃：早期 render_chart 直接 Number(null) 会把空值画成 0 点。
   */
  private async chartSeries(conn: ConnectionConfig, database: string | undefined, sqlText: string, xName?: string, yName?: string) {
    const sql = sqlText.trim();
    if (!sql) throw new DbError('该工具需要 SQL');
    const batch = await this.manager.query(conn.id, sql, {
      database,
      maxRows: 500,
      allowMulti: false,
      autoLimit: true,
      actor: 'agent',
    });
    const set = batch.sets[0];
    if (!set || !set.columns.length) throw new DbError('SQL 没有返回结果集');
    const names = set.columns.map((column) => column.name);
    const objects = set.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
    const guessed = guessAxes(names, objects);
    const x = xName ?? guessed?.x ?? names[0];
    const y = yName ?? guessed?.y ?? names.find((name) => name !== x);
    if (!x || !y || x === y) throw new DbError('无法确定 x/y 列，请显式传入');
    if (!names.includes(x)) throw new DbError(`结果集中没有列 ${x}（可用列：${names.join(', ')}）`);
    if (!names.includes(y)) throw new DbError(`结果集中没有列 ${y}（可用列：${names.join(', ')}）`);
    return { sql, names, columns: set.columns, rows: set.rows, x, y, points: toSeries(objects, x, y) };
  }

  private async renderChart(
    conn: ConnectionConfig,
    database: string | undefined,
    sqlText: string,
    type: 'bar' | 'line' | 'pie',
    title: string | undefined,
    xName: string | undefined,
    yName: string | undefined,
    started: number,
  ): Promise<ToolResult> {
    const { sql, columns, rows, x, y, points } = await this.chartSeries(conn, database, sqlText, xName, yName);
    const series = points.slice(0, 24).map((point) => ({ label: point.label || '—', value: point.value }));
    const chart = {
      type,
      title: title ?? `${y} by ${x}`,
      xLabel: x,
      yLabel: y,
      sql,
      series,
    };
    return ok(started, `已生成${type === 'line' ? '折线' : type === 'pie' ? '饼' : '柱状'}图（${series.length} 个数据点）`, {
      chart,
      columns,
      rows,
      chartSql: sql,
    });
  }

  private async analyzeChart(
    conn: ConnectionConfig,
    database: string | undefined,
    sqlText: string,
    xName: string | undefined,
    yName: string | undefined,
    topN: number | undefined,
    started: number,
  ): Promise<ToolResult> {
    const { sql, x, y, points } = await this.chartSeries(conn, database, sqlText, xName, yName);
    if (!points.length) throw new DbError('没有可统计的有效数据点（全为 NULL 或空结果）', { code: 'EMPTY_SERIES' });
    const stats = summarize(points)!;
    const limit = Math.min(20, Math.max(1, Math.trunc(topN ?? 5)));
    const timeSeries = isTimeSeries(points);
    // 环比只保留最近 12 期：500 行全量塞给模型既贵又没人看。
    const recent = timeSeries ? deltas(points).slice(-12) : [];
    const data = {
      x,
      y,
      rowCount: points.length,
      sum: round(stats.sum),
      avg: round(stats.avg),
      min: stats.min,
      max: stats.max,
      argmin: stats.argmin,
      argmax: stats.argmax,
      topShare: topShare(points, limit).map((item) => ({ ...item, value: round(item.value), share: round(item.share, 4) })),
      deltas: recent.map((item) => ({ ...item, value: round(item.value), delta: round(item.delta), ratio: item.ratio === null ? null : round(item.ratio, 4) })),
      isTimeSeries: timeSeries,
      sql,
    };
    return ok(
      started,
      `${points.length} 个数据点：合计 ${round(stats.sum)}，均值 ${round(stats.avg)}，最大 ${stats.argmax}=${stats.max}，最小 ${stats.argmin}=${stats.min}`,
      data,
    );
  }

  private async forecastChart(
    conn: ConnectionConfig,
    database: string | undefined,
    sqlText: string,
    xName: string | undefined,
    yName: string | undefined,
    periods: number | undefined,
    method: ForecastMethod | undefined,
    started: number,
  ): Promise<ToolResult> {
    const { sql, x, y, points } = await this.chartSeries(conn, database, sqlText, xName, yName);
    const timeSeries = isTimeSeries(points);
    const result = forecastSeries(points, {
      periods,
      method,
      // 时间序列就用「第 N 期之后」，避免编造具体月份标签
      labelFor: (index, all) => (timeSeries ? `第 ${index - all.length + 1} 期后` : `+${index - all.length + 1}`),
    });
    if (!result.ok) {
      throw new DbError(result.message ?? '样本不足，无法预测', { code: result.code ?? 'FORECAST_FAILED' });
    }
    const chart = {
      type: 'line' as const,
      title: `${y} 预测（${result.method === 'linear' ? '线性回归' : '移动平均'}）`,
      xLabel: x,
      yLabel: y,
      sql,
      series: result.original.map((point: StatPoint) => ({ label: point.label || '—', value: point.value })),
      forecast: result.forecast,
      note: result.note,
    };
    return ok(
      started,
      `预测未来 ${result.forecast.length} 期（${result.method === 'linear' ? `线性回归，斜率 ${result.slope}` : `移动平均，窗口 ${result.window}`}，r=${result.r}）`,
      { ...result, chart, chartSql: sql },
    );
  }

}
