import type { Engine, Environment, PermissionMode, Risk } from '../types';
import { classifySql, countStatements } from '../sql/classify';
import { validateExplainSql } from '../sql/ddl';
import { classifyAql, classifyCql, classifyCypher, classifyMql, classifyRedis, aqlQueryFromArgs, cqlQueryFromArgs, cypherQueryFromArgs, formatStructuredQuery, mqlQueryFromArgs, redisQueryFromArgs } from '../query';
import { builtinMcpToolRisk, builtinMcpToolRiskByName } from './builtinMcp';
import type { ToolCall, ToolDefinition } from './types';

export type PermissionVerdict = 'allow' | 'ask' | 'deny';

export interface PermissionContext {
  mode: PermissionMode;
  connectionReadonly: boolean;
  environment: Environment;
  /** SQL dialect used by the same call in resolveRisk and the executor. */
  engine?: Engine;
  connectionId?: string;
  database?: string;
  sessionAllowed?: Set<string>;
  alwaysAllowed?: Set<string>;
}

export interface ToolSignatureScope {
  connectionId?: string;
  database?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  ).join(',')}}`;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function stableDigest(value: unknown): string {
  const input = new TextEncoder().encode(stableStringify(value));
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(padded.length - 4, (input.length * 8) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotate(words[i - 15], 7) ^ rotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotate(words[i - 2], 17) ^ rotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function normalizeSql(sql: string): string {
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    if (/\s/.test(char)) {
      pendingSpace = Boolean(out);
      i++;
      continue;
    }
    if (pendingSpace) { out += ' '; pendingSpace = false; }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += char;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === '\\' && i + 1 < sql.length) { out += sql[++i]; i++; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { out += sql[++i]; i++; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (char === '[') {
      out += char;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') { out += sql[++i]; i++; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (char === '$') {
      const tag = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if ((char === '-' && sql[i + 1] === '-') || (char === '/' && sql[i + 1] === '*')) {
      const line = char === '-';
      const end = line ? sql.slice(i + 2).search(/[\r\n]/) : sql.indexOf('*/', i + 2);
      const stop = line ? (end < 0 ? sql.length : i + 2 + end) : (end < 0 ? sql.length : end + 2);
      out += sql.slice(i, stop);
      // 行注释的换行是 SQL 边界，折叠成空格会让被注释的 WHERE 混进注释。
      if (line && end >= 0) {
        out += '\n';
        i = stop + 1;
      } else {
        i = stop;
      }
      continue;
    }
    out += char;
    i++;
  }
  return out.trim().replace(/;+$/, '');
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
    if (call.name === 'run_sql' || call.name === 'explain_sql') {
      const sql = String(call.args.sql ?? '');
      const risk = sql.trim() ? classifySql(sql, engine).risk : 'ddl';
      // Oracle EXPLAIN PLAN FOR writes PLAN_TABLE_OUTPUT even when its target is
      // a read. The tool must not present that fixed side effect as risk=read.
      if (call.name === 'explain_sql' && engine === 'oracle' && risk === 'read') return 'write';
      return risk;
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

export function toolSignature(call: ToolCall, scope: ToolSignatureScope = {}): string {
  if (call.name === 'create_connection' || call.name === 'probe_engine') {
    return `${call.name}:<unscoped>:<unscoped>:${stableDigest(call.args)}`;
  }
  const explicitConnection = typeof call.args.connectionId === 'string' && call.args.connectionId ? call.args.connectionId : undefined;
  const explicitDatabase = typeof call.args.database === 'string' && call.args.database ? call.args.database : undefined;
  const conn = explicitConnection ?? (scope.connectionId || '<unscoped>');
  const database = explicitDatabase ?? (scope.database || '<unscoped>');
  const scopedArgs = Object.fromEntries(Object.entries(call.args).filter(([key]) => key !== 'connectionId' && key !== 'database'));
  if (call.name === 'run_sql' && typeof scopedArgs.sql === 'string') scopedArgs.sql = normalizeSql(scopedArgs.sql);
  return `${call.name}:${conn}:${database}:${stableDigest(scopedArgs)}`;
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
  if (call && (call.name === 'run_sql' || call.name === 'explain_sql')) {
    const sql = typeof call.args.sql === 'string' ? call.args.sql : '';
    const classification = classifySql(sql, ctx.engine);
    // unknown 的历史风险映射是 ddl；auto/full 会放行 ddl，因此必须在读取
    // risk 之前逐条检查真实 kind，不能让“无法证明安全”变成“像 DDL 一样可自动执行”。
    if (!sql.trim() || !classification.statements.length || classification.statements.some((statement) => statement.kind === 'unknown')) {
      return 'deny';
    }
    // readonly 模式只允许明确的数据读取；SET/USE/事务边界虽然不改数据，也不是只读查询。
    if (ctx.mode === 'readonly' && classification.statements.some((statement) => statement.kind !== 'read')) {
      return 'deny';
    }
    if (call.name === 'explain_sql') {
      // 没有目标连接方言时不能做严格拆句（例如跨连接调用）；执行器虽会
      // 再校验，但审批前不能把一个无法证明只读的 EXPLAIN 请求放出去。
      if (!ctx.engine) return 'deny';
      try {
        validateExplainSql(ctx.engine, sql);
      } catch {
        // 非法 EXPLAIN 输入不是可审批操作：多语句、写语句和 ANALYZE 一律拒绝。
        return 'deny';
      }
    }
  }
  if (risk === 'read') return 'allow';
  if (ctx.connectionReadonly) return 'deny';
  if (ctx.mode === 'readonly') return 'deny';

  const sig = call ? toolSignature(call, ctx) : '';
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
