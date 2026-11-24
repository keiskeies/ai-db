import { randomUUID } from 'node:crypto';
import {
  addField,
  engineMeta,
  engineUsesSchema,
  getTool,
  isSqlEngine,
  managesIndexes,
  quoteIdent,
  resolveRisk,
  type AppSettings,
  type ConnectionConfig,
  type Engine,
  type TableInfo,
  type ToolCall,
  type ToolResult,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { ConnectionProvisioner } from './connectionProvisioner';
import { DbError } from './drivers';
import type { GatewayEvents } from './events';
import type { ConnectionManager } from './manager';
import { SkillStore } from './skills';
import { SkillRunner } from './skillRunner';
import type { SkillWorker } from './skillWorker';
import type { Store } from './store';
import { toolRegistry } from './executor/registry';
import type { ExecutorServices, ToolContext } from './executor/types';

export type { ToolContext } from './executor/types';

const DB_TOOLS = new Set([
  'create_connection',
  'inspect_schema',
  'search_objects',
  'run_sql',
  'begin_transaction',
  'commit_transaction',
  'rollback_transaction',
  'run_mql',
  'run_redis',
  'run_cypher',
  'vector_search',
  'search_index',
  'run_cql',
  'run_aql',
  'upsert_document',
  'delete_documents',
  'import_documents',
  'create_collection',
  'delete_collection',
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
  'schema_diff',
  'recon_data',
  'transfer_data',
  'mcp_list_servers',
  'mcp_list_tools',
  'mcp_call',
]);

const SQL_ONLY_TOOLS = new Set([
  'run_sql',
  'explain_sql',
  'profile_column',
  'create_table',
  'alter_table',
  'drop_object',
  'manage_index',
  'import_csv',
  'backup_database',
  'audit_database',
  'check_data_quality',
  'render_chart',
  'analyze_chart',
  'forecast_chart',
  'generate_data',
]);

export class ToolExecutor {
  private skills: SkillStore;
  private skillRunner: SkillRunner;
  private skillWorker?: SkillWorker;
  private skillRuns = new Map<string, string>();
  private connectionProvisioner: ConnectionProvisioner;

  constructor(
    private store: Store,
    private manager: ConnectionManager,
    private config: GatewayConfig,
    private getSettings: () => AppSettings,
    skills?: SkillStore,
    skillRunner?: SkillRunner,
    events?: GatewayEvents,
  ) {
    this.skills = skills ?? new SkillStore(config.home);
    this.skillRunner = skillRunner ?? new SkillRunner(this.skills, config.home);
    this.connectionProvisioner = new ConnectionProvisioner(store, manager, events);
  }

  setSkillWorker(worker: SkillWorker): void {
    this.skillWorker = worker;
  }

  /** 同一会话对同一 skill 复用运行目录，避免每次写文件都新建沙箱。 */
  private skillRunId(ctx: ToolContext, skill: string, provided?: unknown): string {
    if (typeof provided === 'string' && provided) {
      const run = this.skillRunner.getRun(provided);
      if (skill && run.skill !== skill) throw new Error('runId 与 skill 不匹配');
      return provided;
    }
    const key = `${ctx.sessionId}:${skill}`;
    const existing = this.skillRuns.get(key);
    if (existing) {
      try {
        this.skillRunner.getRun(existing);
        return existing;
      } catch {
        this.skillRuns.delete(key);
      }
    }
    const created = this.skillRunner.createRun(skill).id;
    this.skillRuns.set(key, created);
    return created;
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const features = this.getSettings().features;
    if (!features.skills && (call.name.startsWith('skill_') || call.name === 'skill_worker_run')) {
      return { ok: false, summary: 'Skill 自动调用已关闭', error: { code: 'FEATURE_DISABLED', message: 'Agent 自动调用技能已关闭；可在设置 → Skills 手动运行' }, meta: { durationMs: 0 } };
    }
    if (!features.pipelines && call.name === 'manage_pipeline') {
      return { ok: false, summary: '数据流处理已关闭', error: { code: 'FEATURE_DISABLED', message: '数据流处理功能已关闭；可在 工具箱 → 数据流处理 顶部开启' }, meta: { durationMs: 0 } };
    }
    if (!features.mcp && (call.name === 'mcp_list_servers' || call.name === 'mcp_list_tools' || call.name === 'mcp_call')) {
      return { ok: false, summary: 'MCP 功能已关闭', error: { code: 'FEATURE_DISABLED', message: 'MCP 已在设置中关闭' }, meta: { durationMs: 0 } };
    }
    const tool = getTool(call.name);
    // 必填参数在入口处校验：残缺 JSON 会被 provider 兜成 {}，空参一路落到各分支
    // 才报出看不懂的下游错误。connectionId 有会话兜底（requireConnection），不在此列；
    // confirm 交给破坏性工具自己的 CONFIRM_REQUIRED 流程（缺省/不一致都有专门提示）。
    if (tool) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      const missing = (tool.inputSchema.required ?? []).filter(
        (key) => key !== 'connectionId' && key !== 'confirm' && (args[key] === undefined || args[key] === null || args[key] === ''),
      );
      if (missing.length) {
        return {
          ok: false,
          summary: '工具参数不完整',
          error: {
            code: 'INVALID_ARGS',
            message: `${call.name} 缺少必填参数：${missing.join(', ')}`,
            hint: '补全参数后重新调用；参数结构见工具定义。',
          },
          meta: { durationMs: Date.now() - started },
        };
      }
    }
    if (ctx.signal?.aborted) {
      return { ok: false, summary: '工具执行已取消', error: { code: 'ABORTED', message: '工具执行已取消' }, meta: { durationMs: Date.now() - started } };
    }
    const executionId = randomUUID();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      this.manager.cancelExecution(executionId);
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    let result: ToolResult;
    try {
      result = await this.dispatch(call, { ...ctx, executionId }, started);
    } catch (err: any) {
      result = {
        ok: false,
        summary: '工具执行失败',
        error: { code: err?.code ?? 'TOOL_ERROR', message: err?.message ?? '未知错误', hint: err?.hint },
        data: err?.data,
        meta: { durationMs: Date.now() - started },
      };
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      this.manager.releaseExecution(executionId);
    }
    if (aborted || ctx.signal?.aborted) {
      result = {
        ok: false,
        summary: '工具执行已取消',
        error: { code: 'ABORTED', message: '工具执行已取消' },
        meta: { durationMs: Date.now() - started },
      };
    }
    if (DB_TOOLS.has(call.name)) {
      // 审计风险与运行时审批同口径：带上引擎，方言差异（如 /*! 注释）不会两边判得不一样。
      const riskConnId = this.connectionIdOf(call, ctx);
      const riskConn = riskConnId ? this.store.getConnection(riskConnId) : undefined;
      const risk = tool ? resolveRisk(call, tool, riskConn?.engine) : undefined;
      const generated = (result.data as { ddl?: string; statements?: string[] } | undefined)?.ddl
        ?? (result.data as { statements?: string[] } | undefined)?.statements?.join(';\n');
      const createdConnectionId = call.name === 'create_connection'
        ? (result.data as { connectionId?: string; existingConnectionId?: string } | undefined)?.connectionId
          ?? (result.data as { existingConnectionId?: string } | undefined)?.existingConnectionId
        : undefined;
      const sql = typeof call.args.sql === 'string' ? call.args.sql : generated;
      this.store.addAudit({
        actor: 'agent',
        connectionId: call.name === 'create_connection' ? createdConnectionId : this.connectionIdOf(call, ctx),
        database: typeof call.args.database === 'string' ? call.args.database : ctx.database,
        tool: call.name,
        sql,
        risk,
        approval: 'policy',
        status: result.ok ? 'ok' : 'error',
        durationMs: result.meta.durationMs,
        meta: {
          sessionId: ctx.sessionId,
          callId: call.id,
          error: result.error?.code,
          summary: result.summary,
          ...(call.name === 'render_chart' && result.ok
            ? {
                requestedChartType: typeof call.args.type === 'string' ? call.args.type : undefined,
                chartType: (result.data as { chart?: { type?: string } } | undefined)?.chart?.type,
              }
            : {}),
        },
      });
    }
    if (call.name === 'skill_run' || call.name === 'skill_worker_run') {
      const data = result.data as { runId?: string; id?: string; skill?: string; entrypoint?: string; exitCode?: number; status?: string } | undefined;
      this.store.addAudit({
        actor: 'agent',
        tool: call.name,
        risk: 'write',
        approval: 'policy',
        status: result.ok ? 'ok' : 'error',
        durationMs: result.meta.durationMs,
        meta: {
          sessionId: ctx.sessionId,
          callId: call.id,
          runId: data?.runId ?? data?.id,
          skill: data?.skill,
          entrypoint: data?.entrypoint,
          exitCode: data?.exitCode,
          status: data?.status,
          summary: result.summary,
        },
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
    // 把会话库盖到连接上，下面所有 databaseOf() 的兜底就自然指向它
    return ctx.database ? { ...conn, database: ctx.database } : conn;
  }

  /** 工具参数里的 id 经常是模型记不全的片段，允许用精确名字兜底定位。 */
  private findPipeline(id: unknown, name: unknown) {
    const direct = typeof id === 'string' && id.trim() ? this.store.getPipeline(id.trim()) : undefined;
    if (direct) return direct;
    const wanted = [typeof id === 'string' ? id.trim() : '', typeof name === 'string' ? name.trim() : ''].filter(Boolean);
    for (const key of wanted) {
      const hit = this.store.listPipelines().find((item) => item.name === key);
      if (hit) return hit;
    }
    throw new DbError(`找不到数据流：${wanted.join(' / ') || '（需要 id 或 name）'}`, {
      code: 'PIPELINE_NOT_FOUND',
      hint: '先用 action=list 看清现有数据流的 id 与名字',
    });
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
    if (conn.engine === 'dm') return (conn.username ?? 'SYSDBA').toUpperCase();
    if (conn.engine === 'cassandra' || conn.engine === 'scylla') return conn.database || 'system';
    if (conn.engine === 'clickhouse') return conn.database ?? 'default';
    return 'public';
  }

  private async dispatch(call: ToolCall, ctx: ToolContext, started: number): Promise<ToolResult> {
    if (SQL_ONLY_TOOLS.has(call.name)) {
      const conn = this.requireConnection(call, ctx);
      // manage_index / alter_table 在支持这些能力的文档与搜索引擎上走结构化通道，不是 SQL DDL
      if ((call.name === 'manage_index' && managesIndexes(conn.engine)) || (call.name === 'alter_table' && addField(conn.engine))) {
        /* 放到下面的 dispatch 分支处理 */
      } else if (!isSqlEngine(conn.engine)) {
        throw new DbError(`${engineMeta(conn.engine).label} 不支持 ${call.name}`, {
          code: 'UNSUPPORTED_ENGINE',
          hint:
            engineMeta(conn.engine).languages.includes('aql')
              ? '请使用 run_aql 执行 AQL'
              : engineMeta(conn.engine).model === 'document'
              ? '请使用 run_mql 执行 MongoDB 查询'
              : engineMeta(conn.engine).model === 'keyvalue'
                ? '请使用 run_redis 执行 Redis 命令'
                : engineMeta(conn.engine).model === 'graph'
                  ? '请使用 run_cypher 执行 Cypher'
                  : engineMeta(conn.engine).model === 'vector'
                    ? '请使用 vector_search 执行向量检索'
                    : engineMeta(conn.engine).model === 'search'
                      ? '请使用 search_index 执行搜索 DSL'
                      : engineMeta(conn.engine).model === 'widecolumn'
                        ? '请使用 run_cql 执行 CQL'
                        : '该功能仅支持 SQL 引擎',
        });
      }
    }
    const services: ExecutorServices = {
      store: this.store,
      manager: this.manager,
      connectionProvisioner: this.connectionProvisioner,
      config: this.config,
      getSettings: this.getSettings,
      skills: this.skills,
      skillRunner: this.skillRunner,
      skillWorker: this.skillWorker,
      started,
      skillRunId: (ctx, skill, provided) => this.skillRunId(ctx, skill, provided),
      connectionIdOf: (call, ctx) => this.connectionIdOf(call, ctx),
      requireConnection: (call, ctx) => this.requireConnection(call, ctx),
      findPipeline: (id, name) => this.findPipeline(id, name),
      databaseOf: (call, conn) => this.databaseOf(call, conn),
      ref: (engine, table, name) => this.ref(engine, table, name),
      schemaFor: (conn, table) => this.schemaFor(conn, table),
    };
    const handler = toolRegistry.get(call.name);
    if (!handler) throw new DbError(`未实现的工具：${call.name}`, { code: 'UNKNOWN_TOOL' });
    return handler(call, ctx, services);
  }
}
