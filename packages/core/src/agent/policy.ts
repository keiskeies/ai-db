import type { Engine, Environment, PermissionMode, Risk } from '../types';
import { classifySql, countStatements } from '../sql/classify';
import { tablesFromSql } from './suggest';
import { classifyAql, classifyCql, classifyCypher, classifyMql, classifyRedis, aqlQueryFromArgs, cqlQueryFromArgs, cypherQueryFromArgs, formatStructuredQuery, mqlQueryFromArgs, redisQueryFromArgs } from '../query';
import { builtinMcpToolRisk, builtinMcpToolRiskByName } from './builtinMcp';
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
export function resolveRisk(call: ToolCall, tool: ToolDefinition, engine?: Engine): Risk {
  if (tool.risk === 'dynamic') {
    if (call.name === 'mcp_call') {
      // Only namespaced built-in ids inherit read auto-approval; external servers stay write.
      // With `server` omitted, a built-in tool name resolves to its first-party server;
      // an explicit non-built-in ref never falls back to name inference.
      const tool = String(call.args.tool ?? '');
      const ref = String(call.args.server ?? '').trim();
      return (ref ? builtinMcpToolRisk(ref, tool) : builtinMcpToolRiskByName(tool)) ?? 'write';
    }
    if (call.name === 'run_sql') {
      const sql = String(call.args.sql ?? '');
      return sql.trim() ? classifySql(sql, engine).risk : 'ddl';
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
  if (call.name === 'create_connection') {
    const credential = typeof call.args.passwordRef === 'string' && call.args.passwordRef ? 'ref' : call.args.useSavedCredential === true ? 'saved' : 'none';
    return `${call.name}:${String(call.args.host ?? '*')}:${String(call.args.port ?? '*')}:${String(call.args.engine ?? '*')}:${String(call.args.username ?? '*')}:${String(call.args.database ?? '*')}:${credential}:${call.args.skipProbe === true ? 'skip' : 'test'}:${String(call.args.environment ?? 'dev')}:${call.args.readonly === true ? 'readonly' : 'write'}:${call.args.ssl === true ? 'ssl' : 'plain'}:${call.args.sslInsecure === true ? 'insecure' : 'verified'}`;
  }
  if (call.name === 'probe_engine') {
    return `${call.name}:${String(call.args.host ?? '*')}:${String(call.args.port ?? '*')}:${String(call.args.username ?? '*')}:${String(call.args.database ?? '*')}:${call.args.ssl === true ? 'ssl' : 'plain'}:${call.args.sslInsecure === true ? 'insecure' : 'verified'}`;
  }
  let target = '';
  const explicit = call.args.table ?? call.args.name;
  if (typeof explicit === 'string') target = explicit;
  else if (typeof call.args.sql === 'string') {
    // 签名必须覆盖整段脚本：风险级 + 全部引用表 + 动词序列 + 语句数。只取第一个 FROM 表时，
    // INSERT/UPDATE/DELETE（没有 FROM）会落成 run_sql:conn:*，一次「始终允许」
    // 就等于该连接上所有非破坏性写的通行证；多语句脚本也能借首表相同的签名混过去。
    // 动词也要进签名：批准 INSERT orders 不应顺带放行同表的 UPDATE。
    const sql = String(call.args.sql);
    const classification = classifySql(sql);
    const tables = [...new Set(tablesFromSql(sql))].sort().join(',');
    const verbs = classification.statements.map((s) => s.verb).join(',');
    target = `${classification.risk}:${tables || '*'}:${verbs}#${classification.statements.length}`;
  }
  else if (call.name === 'run_mql' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'run_redis' && typeof call.args.command === 'string') target = call.args.command;
  else if (call.name === 'run_cypher' && typeof call.args.query === 'string') target = call.args.query.slice(0, 40);
  else if (call.name === 'vector_search' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'search_index' && typeof call.args.index === 'string') target = call.args.index;
  else if (call.name === 'upsert_document' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'delete_documents' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'import_documents' && typeof call.args.collection === 'string') target = call.args.collection;
  else if (call.name === 'create_collection' && typeof call.args.name === 'string') target = call.args.name;
  else if (call.name === 'delete_collection' && typeof call.args.name === 'string') target = call.args.name;
  else if (call.name === 'run_cql' && typeof call.args.query === 'string') target = call.args.query.slice(0, 40);
  else if (call.name === 'run_aql' && typeof call.args.query === 'string') target = call.args.query.slice(0, 40);
  else if (call.name === 'mcp_call') {
    const mcpArgs = call.args.arguments && typeof call.args.arguments === 'object' ? (call.args.arguments as Record<string, unknown>) : undefined;
    const detail = typeof mcpArgs?.path === 'string'
      ? mcpArgs.path
      : typeof mcpArgs?.url === 'string'
        ? mcpArgs.url
        : typeof mcpArgs?.source === 'string'
          ? `${mcpArgs.source}>${String(mcpArgs.destination ?? '')}`
          : '';
    target = `${String(call.args.server ?? 'builtin')}.${String(call.args.tool ?? '')}${detail ? `:${detail.slice(0, 200)}` : ''}`;
  }
  else if (call.args.index && typeof call.args.index === 'object') {
    const idx = call.args.index as Record<string, unknown>;
    if (typeof idx.name === 'string') target = idx.name;
  }
  return `${call.name}:${conn}:${target || '*'}`;
}

const SECRET_ARG_KEYS = new Set(['password', 'sshpassword', 'sshprivatekey', 'sshpassphrase', 'passphrase']);

export function isSecretToolArgKey(key: string): boolean {
  return SECRET_ARG_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

export function redactToolSecrets(value: unknown): unknown {
  const walk = (current: unknown): { value: unknown; changed: boolean } => {
    if (Array.isArray(current)) {
      let changed = false;
      const items = current.map((item) => {
        const next = walk(item);
        changed ||= next.changed;
        return next.value;
      });
      return { value: changed ? items : current, changed };
    }
    if (!current || typeof current !== 'object') return { value: current, changed: false };
    let changed = false;
    const entries = Object.entries(current as Record<string, unknown>).map(([key, child]) => {
      if (isSecretToolArgKey(key)) {
        changed = true;
        return [key, '***'];
      }
      const next = walk(child);
      changed ||= next.changed;
      return [key, next.value];
    });
    return { value: changed ? Object.fromEntries(entries) : current, changed };
  };
  return walk(value).value;
}

/** SQL shown in the approval dialog / audit log for the call. */
export function describeCall(call: ToolCall): { summary: string; sql?: string } {
  const a = call.args;
  const sql = typeof a.sql === 'string' ? a.sql : undefined;
  switch (call.name) {
    case 'probe_engine':
      return { summary: `探测 ${String(a.host ?? '')}:${String(a.port ?? '')} 的数据库类型` };
    case 'create_connection':
      return { summary: `创建连接 ${String(a.name ?? '')}（${String(a.engine ?? '')} ${String(a.host ?? '')}:${String(a.port ?? '')}）` };
    case 'run_sql': {
      if (!sql) return { summary: '执行 SQL', sql };
      // 多语句脚本的规模要在审批弹窗里看得见：18 条 ALTER 和 1 条 SELECT 的后果差别很大，
      // 只显示前 240 字会让用户以为自己批准的是「一条 SQL」。
      const count = countStatements(sql);
      const head = sql.replace(/\s+/g, ' ').trim().slice(0, 240);
      return { summary: count > 1 ? `${count} 条语句：${head}` : head, sql };
    }
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
    case 'delete_collection':
      return { summary: `删除集合 ${String(a.name ?? '')}`, sql: JSON.stringify({ drop: a.name }) };
    case 'create_collection':
      return { summary: `创建集合 ${String(a.name ?? '')}`, sql: JSON.stringify({ name: a.name, dimension: a.dimension, distance: a.distance, fields: a.fields ?? [] }) };
    case 'upsert_document':
      return { summary: `写入 ${String(a.collection ?? '')}`, sql: JSON.stringify(a.documents ?? a.document ?? {}) };
    case 'import_documents':
      return { summary: `CSV 导入 ${String(a.collection ?? '')}`, sql: typeof a.csv === 'string' ? a.csv.slice(0, 240) : String(a.path ?? '') };
    case 'delete_documents':
      return { summary: `删除 ${String(a.collection ?? '')} · ${Array.isArray(a.ids) ? (a.ids as unknown[]).length : 0} 条`, sql: JSON.stringify({ collection: a.collection, ids: a.ids ?? [] }) };
    case 'create_table':
      return { summary: `创建表 ${String(a.table ?? '')}`, sql };
    case 'alter_table':
      return { summary: `修改表 ${String(a.table ?? '')}` };
    case 'drop_object':
      return { summary: `删除${a.kind === 'view' ? '视图' : '表'} ${String(a.name ?? '')}` };
    case 'manage_index':
      return { summary: `${a.action === 'drop' ? '删除' : '创建'}索引 ${String((a.index as Record<string, unknown> | undefined)?.name ?? a.name ?? '')} · ${String(a.table ?? '')}` };
    case 'import_csv':
      return { summary: `导入 CSV 到 ${String(a.table ?? '')}` };
    case 'export_result':
      return { summary: `导出数据到 ${String(a.format ?? 'csv')}` };
    case 'backup_database':
      return { summary: '备份数据库' };
    case 'mcp_list_servers':
      return { summary: '列出 MCP Server' };
    case 'mcp_list_tools':
      return { summary: `列出 MCP 工具 ${String(a.server ?? '')}` };
    case 'mcp_call': {
      const target = `${String(a.server ?? '') || '内置'}.${String(a.tool ?? '')}`;
      const args = a.arguments && typeof a.arguments === 'object' ? (a.arguments as Record<string, unknown>) : undefined;
      const detail = typeof args?.path === 'string'
        ? args.path
        : typeof args?.url === 'string'
          ? args.url
          : typeof args?.source === 'string'
            ? `${args.source} → ${String(args.destination ?? '')}`
            : undefined;
      return { summary: `MCP ${target}${detail ? ` · ${detail.slice(0, 160)}` : ''}` };
    }
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

  // full = 「全权交给 Agent」，包括生产环境的破坏性操作：选了这一档就是不要中间人，
  // 再弹一次确认等于推翻用户刚做的决定。DROP TABLE 在 prod + full 下同样直接执行。
  // 兜底不在弹窗上：executor 的 drop 前自动备份、只读连接（上面的 deny）、完整审计日志。
  // 要保护生产又想要自动，用 auto：破坏性操作照常审批。
  if (risk === 'destructive' && ctx.environment === 'prod' && ctx.mode !== 'full') return 'ask';

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
