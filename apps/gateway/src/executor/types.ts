import type { AppSettings, ConnectionConfig, Engine, PipelineInfo, TableInfo, ToolCall, ToolResult } from '@aidb/core';
import type { ConnectionProvisioner } from '../connectionProvisioner';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import type { SkillStore } from '../skills';
import type { SkillRunner } from '../skillRunner';
import type { SkillWorker } from '../skillWorker';

export interface ToolContext {
  sessionId: string;
  connectionId?: string;
  /** 会话选中的库：工具自己没传 database 时以它为准（优先于连接上的默认库）。 */
  database?: string;
  /** 业务上下文禁用的表：全库扫描类工具必须在源头跳过。 */
  disabledTables?: string[];
  signal?: AbortSignal;
  /** 本次工具调用在连接管理器中的执行追踪 id。 */
  executionId?: string;
}

/** execute() 每次调用时绑定的服务面：实例字段 + 绑定的私有辅助方法 + 本次起始时间。
 *  handler 不持有类实例，工具实现才能拆到独立文件里。 */
export interface ExecutorServices {
  store: Store;
  manager: ConnectionManager;
  connectionProvisioner: ConnectionProvisioner;
  config: GatewayConfig;
  getSettings: () => AppSettings;
  skills: SkillStore;
  skillRunner: SkillRunner;
  skillWorker?: SkillWorker;
  started: number;
  skillRunId: (ctx: ToolContext, skill: string, provided?: unknown) => string;
  connectionIdOf: (call: ToolCall, ctx: ToolContext) => string | undefined;
  requireConnection: (call: ToolCall, ctx: ToolContext) => ConnectionConfig;
  findPipeline: (id: unknown, name: unknown) => PipelineInfo;
  databaseOf: (call: ToolCall, conn: { database?: string }) => string | undefined;
  ref: (engine: Engine, table: TableInfo, name?: string) => string;
  schemaFor: (conn: ConnectionConfig, table?: TableInfo) => string | undefined;
}

export type ToolHandler = (call: ToolCall, ctx: ToolContext, services: ExecutorServices) => Promise<ToolResult>;

/** 工具名必须以字符串字面量出现在第一参数——scripts/verify-docs.mjs 检查 10.1 的扫描锚点。 */
export function defineTool(name: string, handler: ToolHandler): { name: string; handler: ToolHandler } {
  return { name, handler };
}

export function ok(started: number, summary: string, data?: unknown, meta: Partial<ToolResult['meta']> = {}): ToolResult {
  return { ok: true, summary, data, meta: { durationMs: Date.now() - started, ...meta } };
}

/** Agent 的事务键：与 UI 的 sessionId 命名空间分开，避免撞车。 */
export function agentTxKey(ctx: ToolContext): string {
  return `agent:${ctx.sessionId}`;
}
