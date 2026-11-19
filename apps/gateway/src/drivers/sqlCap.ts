import { classifyStatement, maskLiterals, splitStatements, type Engine } from '@aidb/core';

/**
 * 单条只读 SELECT/WITH 判定：LIMIT 外包与 MAX_EXECUTION_TIME 注入都只敢作用于这种形状。
 * classifyStatement 已把 SELECT INTO / FOR UPDATE / WITH 内含写判成 write，
 * SHOW/DESCRIBE/PRAGMA/EXPLAIN 虽是 read 但不能被子查询包裹，这里按 verb 排除。
 */
export function isSingleSelect(sql: string, engine?: Engine): boolean {
  const statements = splitStatements(sql, engine);
  if (statements.length !== 1) return false;
  const info = classifyStatement(statements[0], engine);
  return info.kind === 'read' && (info.verb === 'SELECT' || info.verb === 'WITH');
}

/**
 * 行数上限下推：外包一层 LIMIT，让服务端只产出 maxRows+1 行（多要一行用于判定 truncated）。
 * 多语句/非 SELECT 返回 undefined，调用方回落到客户端裁剪。
 * 残留风险：子查询不允许重复列名（如 SELECT a.id, b.id），PG 侧调用方需捕获 42701 回落原句。
 */
export function wrapSelectLimit(sql: string, limit: number, engine?: Engine): string | undefined {
  if (!Number.isFinite(limit) || limit <= 0 || !isSingleSelect(sql, engine)) return undefined;
  const clean = sql.replace(/;\s*$/, '');
  // 闭括号前换行：原句尾部的 -- 行注释否则会把 ) AS _aidb_limit 一起注释掉。
  return `SELECT * FROM (${clean}\n) AS _aidb_limit LIMIT ${Math.floor(limit)}`;
}

/**
 * MySQL 优化器提示 MAX_EXECUTION_TIME 只认顶层 SELECT 关键字后的位置：
 * WITH 场景要跳过 CTE 括号里的 SELECT，把提示插到主 SELECT 后面。
 * 在 maskLiterals 结果上扫描，字符串/注释里的 SELECT 不会误中；不识别提示的
 * MySQL 协议实现（Doris/StarRocks 等）会忽略它，客户端看门狗仍是兜底。
 */
export function injectMaxExecutionTime(sql: string, ms: number, engine?: Engine): string {
  if (!Number.isFinite(ms) || ms <= 0 || !isSingleSelect(sql, engine)) return sql;
  const masked = maskLiterals(sql, engine);
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (
      depth === 0 &&
      (c === 'S' || c === 's') &&
      /^select\b/i.test(masked.slice(i, i + 7)) &&
      (i === 0 || !/[\w$]/.test(masked[i - 1]))
    ) {
      const end = i + 6;
      return `${sql.slice(0, end)} /*+ MAX_EXECUTION_TIME(${Math.floor(ms)}) */${sql.slice(end)}`;
    }
  }
  return sql;
}