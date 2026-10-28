import type { Environment, PermissionMode, Risk } from '../types';
import { classifySql, extractTableRef } from '../sql/classify';
import { classifyAql, classifyCql, classifyCypher, classifyMql, classifyRedis, aqlQueryFromArgs, cqlQueryFromArgs, cypherQueryFromArgs, formatStructuredQuery, mqlQueryFromArgs, redisQueryFromArgs } from '../query';
import type { ToolCall, ToolDefinition } from './types';

export type PermissionVerdict = 'allow' | 'ask' | 'deny';

export interface PermissionContext {
  mode: PermissionMode;
  connectionReadonly: boolean;
  environment: Environment;
  sessionAllowed?: Set<string>;
  alwaysAllowed?: Set<string>;
}

/** Resolve the effective risk for a call, including dynamic SQL classification. */
export function resolveRisk(call: ToolCall, tool: ToolDefinition): Risk {
  if (tool.risk === 'dynamic') {
    if (call.name === 'run_sql') {
      const sql = String(call.args.sql ?? '');
      return sql.trim() ? classifySql(sql).risk : 'ddl';
    }
    if (call.name === 'run_mql') return classifyMql(mqlQueryFromArgs(call.args)).risk;
    if (call.name === 'run_redis') return classifyRedis(redisQueryFromArgs(call.args)).risk;
    if (call.name === 'run_cypher') return classifyCypher(cypherQueryFromArgs(call.args)).risk;
    if (call.name === 'run_cql') return classifyCql(cqlQueryFromArgs(call.args)).risk;
    if (call.name === 'run_aql') return classifyAql(aqlQueryFromArgs(call.args)).risk;
    if (call.name === 'alter_table') {
      const ops = Array.isArray(call.args.operations) ? (call.args.operations as Array<{ op?: string }>) : [];
      return ops.some((o) => o?.op === 'drop_column') ? 'destructive' : 'ddl';
    }
    return 'write';
  }
  return tool.risk;
}

export function toolSignature(call: ToolCall): string {
  const conn = String(call.args.connectionId ?? '*');
  let target = '';
  const explicit = call.args.table ?? call.args.name;
  if (typeof explicit === 'string') target = explicit;
  else if (typeof call.args.sql === 'string') target = extractTableRef(String(call.args.sql)) ?? '';
  else if (call.name === 'run_mql' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'run_redis' && typeof call.args.command === 'string') target = call.args.command;
  else if (call.name === 'run_cypher' && typeof call.args.query === 'string') target = call.args.query.slice(0, 40);
  else if (call.name === 'vector_search' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'search_index' && typeof call.args.index === 'string') target = call.args.index;
  else if (call.name === 'upsert_document' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'run_cql' && typeof call.args.query === 'string') target = call.args.query.slice(0, 40);
  else if (call.name === 'run_aql' && typeof call.args.query === 'string') target = call.args.query.slice(0, 40);
  else if (call.args.index && typeof call.args.index === 'object') {
    const idx = call.args.index as Record<string, unknown>;
    if (typeof idx.name === 'string') target = idx.name;
  }
  return `${call.name}:${conn}:${target || '*'}`;
}

/** SQL shown in the approval dialog / audit log for the call. */
export function describeCall(call: ToolCall): { summary: string; sql?: string } {
  const a = call.args;
  const sql = typeof a.sql === 'string' ? a.sql : undefined;
  switch (call.name) {
    case 'run_sql':
      return { summary: sql ? sql.slice(0, 240) : '执行 SQL', sql };
    case 'run_mql': {
      const query = mqlQueryFromArgs(a);
      return { summary: `MongoDB ${query.op} ${query.collection}`.trim(), sql: formatStructuredQuery(query) };
    }
    case 'run_redis': {
      const query = redisQueryFromArgs(a);
      return { summary: `Redis ${query.command}`, sql: formatStructuredQuery(query) };
    }
    case 'run_cypher': {
      const query = cypherQueryFromArgs(a);
      return { summary: `Cypher ${query.text.replace(/\s+/g, ' ').slice(0, 200)}`, sql: query.text };
    }
    case 'run_aql': {
      const query = aqlQueryFromArgs(a);
      return { summary: `AQL ${query.text.replace(/\s+/g, ' ').slice(0, 200)}`, sql: query.text };
    }
    case 'upsert_document':
      return { summary: `写入 ${String(a.collection ?? '')}${a.id ? ` · ${a.id}` : ''}`, sql: JSON.stringify(a.document ?? {}) };
    case 'create_table':
      return { summary: `创建表 ${String(a.table ?? '')}`, sql };
    case 'alter_table':
      return { summary: `修改表 ${String(a.table ?? '')}` };
    case 'drop_object':
      return { summary: `删除${a.kind === 'view' ? '视图' : '表'} ${String(a.name ?? '')}` };
    case 'manage_index':
      return { summary: `${a.action === 'drop' ? '删除' : '创建'}索引 ${String((a.index as Record<string, unknown> | undefined)?.name ?? '')}` };
    case 'import_csv':
      return { summary: `导入 CSV 到 ${String(a.table ?? '')}` };
    case 'export_result':
      return { summary: `导出数据到 ${String(a.format ?? 'csv')}` };
    case 'backup_database':
      return { summary: '备份数据库' };
    default:
      return { summary: call.name };
  }
}

export function evaluatePermission(risk: Risk, ctx: PermissionContext, call?: ToolCall): PermissionVerdict {
  if (risk === 'read') return 'allow';
  if (ctx.connectionReadonly) return 'deny';
  if (ctx.mode === 'readonly') return 'deny';

  const sig = call ? toolSignature(call) : '';
  const preApproved = risk !== 'destructive' && sig.length > 0 && (ctx.sessionAllowed?.has(sig) || ctx.alwaysAllowed?.has(sig));

  // Production destructive actions always require explicit approval.
  if (risk === 'destructive' && ctx.environment === 'prod') return 'ask';

  if (preApproved) return 'allow';

  switch (ctx.mode) {
    case 'ask':
      return 'ask';
    case 'auto':
      return risk === 'destructive' ? 'ask' : 'allow';
    case 'full':
      return 'allow';
    default:
      return 'ask';
  }
}
