import type { ToolCall, ToolResult } from '@aidb/core';

const OBJECT_KEYS = ['table', 'collection', 'index'] as const;
const IDENTITY_KEYS = ['table', 'tableName', 'name', 'object', 'collection', 'index', 'entity'] as const;
const ALL_TABLE_TOOLS = new Set(['schema_diff', 'transfer_data']);

function disabledSet(disabled: string[]): Set<string> {
  return new Set(disabled.map((name) => name.trim().toLowerCase()).filter(Boolean));
}

function collectObjectNames(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectNames(item, out, depth + 1);
    return out;
  }
  const record = value as Record<string, unknown>;
  for (const key of OBJECT_KEYS) {
    if (typeof record[key] === 'string') out.push(record[key] as string);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'tables' && Array.isArray(child)) {
      out.push(...child.map(String));
      continue;
    }
    collectObjectNames(child, out, depth + 1);
  }
  return out;
}

/** 对象级工具（含 recon_data 这类嵌套参数）是否指向禁用表。 */
export function disabledTableTarget(call: ToolCall, disabledTables: string[]): string | undefined {
  const set = disabledSet(disabledTables);
  if (!set.size) return undefined;
  return collectObjectNames(call.args ?? {}).find((name) => set.has(name.trim().toLowerCase()));
}

/** schema_diff / transfer_data 未指定 tables 时会扫描整库，禁用上下文下必须要求显式表清单。 */
export function allTableScanNeedsScope(call: ToolCall, disabledTables: string[]): boolean {
  if (!disabledTables.length || !ALL_TABLE_TOOLS.has(call.name)) return false;
  const args = (call.args ?? {}) as Record<string, unknown>;
  return !Array.isArray(args.tables) || args.tables.length === 0;
}

export function scopeRequiredError(tool: string): ToolResult {
  return {
    ok: false,
    summary: '需要显式指定表',
    error: {
      code: 'TABLE_SCOPE_REQUIRED',
      message: `当前业务上下文禁用了部分表，${tool} 必须显式传入 tables，不能扫描整库。`,
      hint: '传入允许的表清单，或让用户在 Agent 上下文中调整禁用项。',
    },
    meta: { durationMs: 0 },
  };
}

export function disabledToolError(name: string): ToolResult {
  return {
    ok: false,
    summary: '对象已被业务上下文禁用',
    error: {
      code: 'TABLE_DISABLED',
      message: `对象 ${name} 已在业务上下文中禁用，不能读取或操作。`,
      hint: '改用未禁用的对象；若确需它，请让用户在 Agent 上下文里启用。',
    },
    meta: { durationMs: 0 },
  };
}

/** 系统目录查询会绕过表名匹配枚举出禁用表，需要整体拒绝。 */
export function systemCatalogQuery(sql: string): boolean {
  const text = sql.trim();
  if (!text) return false;
  if (/\b(information_schema|performance_schema)\b/i.test(text)) return true;
  if (/\b(mysql|sys)\s*\./i.test(text)) return true;
  return /^\s*show\s+(tables|databases)\b/i.test(text);
}

export function metadataBlockedError(): ToolResult {
  return {
    ok: false,
    summary: '系统目录查询已被禁用',
    error: {
      code: 'METADATA_BLOCKED',
      message: '当前业务上下文禁用了部分表，禁止查询 information_schema / performance_schema / mysql / sys 或 SHOW TABLES / SHOW DATABASES，避免枚举被禁用对象。',
      hint: '直接查询业务表；需要结构时使用 inspect_schema（结果会自动过滤禁用表）。',
    },
    meta: { durationMs: 0 },
  };
}

function disabledIdentity(value: unknown, set: Set<string>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return IDENTITY_KEYS.some((key) => typeof record[key] === 'string' && set.has(String(record[key]).trim().toLowerCase()));
}

function redact(value: unknown, set: Set<string>): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      if (disabledIdentity(item, set)) { changed = true; continue; }
      const child = redact(item, set);
      changed ||= child.changed;
      out.push(child.value);
    }
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (disabledIdentity(child, set)) { changed = true; continue; }
      const next = redact(child, set);
      changed ||= next.changed;
      out[key] = next.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/**
 * 列表/聚合类工具调用后二次过滤：数组里带 table/name 等标识的禁用对象直接移除。
 * run_sql 不做递归删行，避免误删业务数据里恰好等于表名的字符串。
 */
export function filterDisabledObjects(call: ToolCall, result: ToolResult, disabledTables: string[]): ToolResult {
  const set = disabledSet(disabledTables);
  if (!result.ok || !set.size || !result.data || typeof result.data !== 'object') return result;
  if (call.name === 'run_sql') return result;
  const redacted = redact(result.data, set);
  if (!redacted.changed) return result;
  const data = redacted.value as Record<string, unknown>;
  if (call.name === 'search_objects' && Array.isArray(data.matches)) data.total = data.matches.length;
  return {
    ...result,
    data,
    summary: `${result.summary}（已过滤业务上下文禁用的表）`,
  };
}
