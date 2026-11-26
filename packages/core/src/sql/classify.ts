import { dialectOf } from '../engines';
import type { Engine, Risk } from '../types';

export type SqlKind = 'read' | 'write' | 'ddl' | 'destructive' | 'session' | 'unknown';

export interface StatementInfo {
  sql: string;
  kind: SqlKind;
  verb: string;
  reason?: string;
}

export interface SqlClassification {
  risk: Risk;
  kind: SqlKind;
  statements: StatementInfo[];
}

const RISK_RANK: Record<Risk, number> = { read: 0, write: 1, ddl: 2, destructive: 3 };

/** MySQL 系方言（含 MariaDB/TiDB/Doris 等）：字符串认反斜杠转义，/*! 注释内容会被执行。 */
function isMysqlDialect(engine?: Engine): boolean {
  if (!engine) return false;
  try {
    return dialectOf(engine) === 'mysql';
  } catch {
    return false;
  }
}

/** PG 美元引用开标签：$$ 或 $tag$。数据里的普通 $ 不会误中（必须成对出现 $...$）。 */
function dollarTagAt(sql: string, i: number): string | undefined {
  if (sql[i] !== '$') return undefined;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
  return m ? m[0] : undefined;
}

/** 美元引用只在 PG 系方言成立：MySQL 标识符允许 $，a$b$c 里的 $b$ 会被误认成开标签，
 * 找不到闭标签就把后续整段（含真实语句）吞进掩码。引擎未知时不认美元引用（宁可误拆）。 */
function isPgDialect(engine?: Engine): boolean {
  if (!engine) return false;
  try {
    return dialectOf(engine) === 'postgres';
  } catch {
    return false;
  }
}

function isMssqlDialect(engine?: Engine): boolean {
  if (!engine) return false;
  try {
    return dialectOf(engine) === 'mssql';
  } catch {
    return false;
  }
}

/** MySQL 的 -- 注释要求第二个 - 后还有空白/控制字符；1--1 是算术表达式而非注释。 */
function startsLineComment(sql: string, i: number, mysql: boolean): boolean {
  if (sql[i] !== '-' || sql[i + 1] !== '-') return false;
  return !mysql || i + 2 >= sql.length || /[\u0000-\u0020]/.test(sql[i + 2]);
}

/** SQL Server 方括号标识符中出现这些字符时无法安全证明它只是标识符，整体拒绝。 */
function unsafeBracketChar(sql: string, i: number): boolean {
  const c = sql[i];
  return /['"`;#\r\n\[]/.test(c) || sql.startsWith('--', i) || sql.startsWith('/*', i) || sql.startsWith('*/', i);
}

interface SqlScan {
  masked: string;
  statements: string[];
  unsafe: boolean;
}

/**
 * Replace quoted literals/identifiers and comments with blanks so keyword checks never fire inside data.
 * 掩码必须与原文等长：注释按原长填空格、双写引号/转义按 2 格填。
 * 调用方（injectMaxExecutionTime）拿掩码下标去切原文，缩长的掩码会把提示插进注释里或插碎 SQL。
 *
 * 方言规则（engine 未知时取保守方向）：
 *  - 反斜杠转义只在 MySQL 系成立；PG/SQLite 等标准 SQL 里 'a\' 就是字符串结束，
 *    按转义处理会把后面的真实语句吞进掩码，整段被误判成一条 read。
 *  - MySQL 的 /*! 版本注释（可执行注释）按代码处理，否则 INTO OUTFILE / FOR UPDATE
 *    这类子句藏在注释里就能骗过只读判定；引擎未知时同样按代码（宁可误拦）。
 *  - MySQL # 行注释与 -- 一样屏蔽到换行，注释内的分号不参与语句拆分。
 *  - SQL Server [...] 标识符支持 ]] 转义；危险或未闭合的括号语法由分类层拒绝。
 *  - $$...$$ 美元引用按字符串掩掉（仅 PG 系方言），函数体里的关键字不参与判定。
 */
export function maskLiterals(sql: string, engine?: Engine): string {
  return scanSql(sql, engine).masked;
}

/**
 * 掩码与语句拆分共用同一套词法扫描，避免两边对方括号、注释和转义的理解漂移。
 * 掩码与原文严格等长，splitStatements 则只在引号/注释/方括号标识符之外识别分号。
 * 未闭合引号、注释、方括号，以及方括号标识符中的语句/注释元字符均标记为 unsafe，
 * 让分类与 manager 执行边界 fail-closed，而不是把剩余 SQL 吞成一条 read。
 */
function scanSql(sql: string, engine?: Engine): SqlScan {
  const mysql = isMysqlDialect(engine);
  const pg = isPgDialect(engine);
  const mssql = isMssqlDialect(engine);
  const statements: string[] = [];
  let masked = '';
  let current = '';
  let bracketDepth = 0;
  let unsafe = false;
  let i = 0;
  const n = sql.length;
  const maskRaw = (raw: string) => {
    masked += ' '.repeat(raw.length);
    current += raw;
  };

  while (i < n) {
    const c = sql[i];
    if (startsLineComment(sql, i, mysql)) {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      maskRaw(sql.slice(start, i));
      continue;
    }
    if (mysql && c === '#') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      maskRaw(sql.slice(start, i));
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (sql[i + 2] === '!' && (mysql || engine === undefined)) {
        // 可执行注释：只跳过 /*! 标记，内容按正常代码继续扫描，分号仍是语句边界。
        masked += '   ';
        current += '/*!';
        i += 3;
        continue;
      }
      const start = i;
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) unsafe = true;
      i = end === -1 ? n : end + 2;
      maskRaw(sql.slice(start, i));
      continue;
    }
    const tag = pg ? dollarTagAt(sql, i) : undefined;
    if (tag) {
      const start = i;
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) unsafe = true;
      const end = close === -1 ? n : close + tag.length;
      const innerLength = end - i - tag.length - (close === -1 ? 0 : tag.length);
      masked += tag + ' '.repeat(Math.max(0, innerLength)) + (close === -1 ? '' : tag);
      current += sql.slice(start, end);
      i = end;
      continue;
    }
    if (mssql && c === '[') {
      const start = i;
      let closed = false;
      i++;
      while (i < n) {
        if (sql[i] === ']' && sql[i + 1] === ']') {
          i += 2;
          continue;
        }
        if (sql[i] === ']') {
          closed = true;
          i++;
          break;
        }
        if (unsafeBracketChar(sql, i)) unsafe = true;
        i++;
      }
      if (!closed) unsafe = true;
      const raw = sql.slice(start, i);
      const innerLength = raw.length - 1 - (closed ? 1 : 0);
      masked += '[' + ' '.repeat(innerLength) + (closed ? ']' : '');
      current += raw;
      continue;
    }
    if (mssql && c === ']') {
      unsafe = true;
      masked += c;
      current += c;
      i++;
      continue;
    }
    if (!mssql && c === '[') {
      bracketDepth += 1;
      masked += c;
      current += c;
      i++;
      continue;
    }
    if (!mssql && c === ']') {
      if (bracketDepth === 0) unsafe = true;
      else bracketDepth -= 1;
      masked += c;
      current += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      const start = i;
      let closed = false;
      masked += q;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && mysql) {
          const step = Math.min(2, n - i);
          masked += ' '.repeat(step);
          i += step;
          continue;
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            masked += '  ';
            i += 2;
            continue;
          }
          masked += q;
          i++;
          closed = true;
          break;
        }
        masked += ' ';
        i++;
      }
      if (!closed) unsafe = true;
      current += sql.slice(start, i);
      continue;
    }
    if (c === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      masked += ';';
      i++;
      continue;
    }
    masked += c;
    current += c;
    i++;
  }
  if (bracketDepth > 0) unsafe = true;
  if (current.trim()) statements.push(current.trim());
  return { masked, statements, unsafe };
}

/** Split a script into statements, respecting strings, quoted identifiers and comments. */
export function splitStatements(sql: string, engine?: Engine): string[] {
  return scanSql(sql, engine).statements;
}

/** 执行边界使用：词法不完整或方言歧义时必须在连接数据库之前拒绝。 */
export function hasUnsafeSqlSyntax(sql: string, engine?: Engine): boolean {
  return scanSql(sql, engine).unsafe;
}

interface ExplainPrefix {
  target: string;
  analyze: boolean;
  valid: boolean;
}

/** 仅这些 SQLite PRAGMA 的无赋值查询形态可视为 read；其余一律按写处理。 */
const READ_ONLY_PRAGMAS = new Set([
  'APPLICATION_ID', 'AUTO_VACUUM', 'AUTOMATIC_INDEX', 'BUSY_TIMEOUT', 'CACHE_SIZE', 'CACHE_SPILL',
  'CELL_SIZE_CHECK', 'CHECKPOINT_FULLFSYNC', 'COLLATION_LIST', 'COMPILE_OPTIONS', 'DATA_VERSION',
  'DATABASE_LIST', 'DEFER_FOREIGN_KEYS', 'ENCODING', 'FOREIGN_KEYS', 'FREELIST_COUNT', 'FULLFSYNC',
  'FOREIGN_KEY_LIST', 'FUNCTION_LIST', 'HARD_HEAP_LIMIT', 'INDEX_INFO', 'INDEX_LIST', 'INDEX_XINFO',
  'INTEGRITY_CHECK', 'JOURNAL_MODE', 'JOURNAL_SIZE_LIMIT', 'LEGACY_ALTER_TABLE', 'LOCKING_MODE',
  'MMAP_SIZE', 'MODULE_LIST', 'PAGE_COUNT', 'PAGE_SIZE', 'QUERY_ONLY', 'QUICK_CHECK',
  'READ_UNCOMMITTED', 'RECURSIVE_TRIGGERS', 'REVERSE_UNORDERED_SELECTS',
  'SCHEMA_VERSION', 'SECURE_DELETE', 'SOFT_HEAP_LIMIT', 'STATS', 'SYNCHRONOUS', 'TEMP_STORE',
  'TABLE_INFO', 'TABLE_LIST', 'TABLE_XINFO', 'THREADS', 'TRUSTED_SCHEMA', 'USER_VERSION', 'WAL_AUTOCHECKPOINT',
]);

/** 这些 PRAGMA 的括号参数是表/索引名；状态类 PRAGMA 的括号值是 setter，不能放行。 */
const PRAGMA_WITH_OBJECT_ARGUMENT = new Set([
  'FOREIGN_KEY_LIST', 'INDEX_INFO', 'INDEX_LIST', 'INDEX_XINFO', 'TABLE_INFO', 'TABLE_XINFO',
]);

/**
 * Parse only the EXPLAIN prefix; the target is classified recursively.
 * Parenthesized options are balanced rather than matched with a single regex so
 * PostgreSQL forms such as EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) cannot hide
 * an executing option behind another option or a nested value.
 */
function parseExplainPrefix(code: string): ExplainPrefix {
  let rest = code.replace(/^EXPLAIN\b/, '').trimStart();
  let analyze = false;
  if (/^(ANALYZE|ANALYSE)\b/.test(rest)) {
    analyze = true;
    rest = rest.replace(/^(ANALYZE|ANALYSE)\b/, '').trimStart();
  }
  if (rest.startsWith('(')) {
    let depth = 0;
    let close = -1;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '(') depth += 1;
      else if (rest[i] === ')') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) return { target: '', analyze, valid: false };
    const options = rest.slice(1, close);
    if (/\b(ANALYZE|ANALYSE)\b/.test(options)) analyze = true;
    rest = rest.slice(close + 1).trimStart();
  }
  // Be conservative about non-standard option placement as well: an ANALYZE
  // token after the option list still means the target may actually execute.
  if (/^(ANALYZE|ANALYSE)\b/.test(rest)) {
    analyze = true;
    rest = rest.replace(/^(ANALYZE|ANALYSE)\b/, '').trimStart();
  }
  rest = rest.replace(/^QUERY\s+PLAN\b/, '').replace(/^PLAN\s+FOR\b/, '').trimStart();
  // MySQL/MariaDB also accept FORMAT=JSON without parentheses.
  rest = rest.replace(/^FORMAT\s*=\s*[A-Za-z_][A-Za-z0-9_]*\b/, '').trimStart();
  return { target: rest, analyze, valid: Boolean(rest) };
}

export function classifyStatement(sql: string, engine?: Engine): StatementInfo {
  const scan = scanSql(sql, engine);
  const code = scan.masked.replace(/\s+/g, ' ').trim().toUpperCase();
  const verb = (code.match(/^[A-Z]+/) || [''])[0];
  if (scan.unsafe) {
    return { sql, kind: 'unknown', verb: verb || 'UNKNOWN', reason: 'SQL 包含无法安全解析的括号、引号或注释' };
  }

  if (/^(SELECT|VALUES|TABLE)\b/.test(code) || /^WITH\b/.test(code)) {
    if (/^WITH\b/.test(code) && /\b(INSERT|UPDATE|DELETE|REPLACE|MERGE)\b/.test(code)) {
      if (/\b(UPDATE|DELETE)\b/.test(code) && !/\bWHERE\b/.test(code)) {
        return { sql, kind: 'destructive', verb: 'WITH', reason: 'WITH 中包含无 WHERE 的 UPDATE/DELETE' };
      }
      return { sql, kind: 'write', verb: 'WITH', reason: 'CTE 内含写操作' };
    }
    if (/\bFOR\s+(NO\s+KEY\s+)?UPDATE\b/.test(code) || /\bFOR\s+SHARE\b/.test(code)) {
      return { sql, kind: 'write', verb, reason: 'SELECT 带行锁' };
    }
    if (/^SELECT\b/.test(code) && /\bINTO\b/.test(code)) {
      return { sql, kind: 'write', verb, reason: 'SELECT INTO 会写入表' };
    }
    return { sql, kind: 'read', verb };
  }

  if (/^(SHOW|DESCRIBE|DESC)\b/.test(code)) return { sql, kind: 'read', verb };

  if (/^PRAGMA\b/.test(code)) {
    const match = /^PRAGMA\s+(?:[A-Z_][A-Z0-9_$]*\.)?([A-Z_][A-Z0-9_$]*)/.exec(code);
    const name = match?.[1];
    if (!name) return { sql, kind: 'unknown', verb, reason: 'PRAGMA 名称不完整' };
    if (!READ_ONLY_PRAGMAS.has(name)) {
      return { sql, kind: 'write', verb, reason: 'PRAGMA 会产生副作用或修改连接状态' };
    }
    const rest = code.slice(match[0].length).trim();
    const objectQuery = PRAGMA_WITH_OBJECT_ARGUMENT.has(name) && /^\([^=]*\)$/.test(rest);
    if (rest && !objectQuery) {
      return { sql, kind: 'write', verb, reason: 'PRAGMA 赋值或参数形式会产生副作用' };
    }
    return { sql, kind: 'read', verb };
  }

  if (/^EXPLAIN\b/.test(code)) {
    const prefix = parseExplainPrefix(code);
    if (!prefix.valid) return { sql, kind: 'unknown', verb: 'EXPLAIN', reason: 'EXPLAIN 选项或内层语句不完整' };
    const inner = classifyStatement(prefix.target, engine);
    const writesPlanTable = /^EXPLAIN\s+PLAN\s+FOR\b/.test(code);
    if (prefix.analyze || writesPlanTable) {
      const kind: SqlKind = inner.kind === 'read' || inner.kind === 'session' ? 'write' : inner.kind;
      return {
        sql,
        kind,
        verb: 'EXPLAIN',
        reason: writesPlanTable ? 'EXPLAIN PLAN FOR 会写入 PLAN_TABLE_OUTPUT' : 'EXPLAIN ANALYZE/ANALYSE 会实际执行内层语句',
      };
    }
    // A plain EXPLAIN does not normally execute its target, but classifying by
    // the inner statement is safer across dialects and keeps locking/writing
    // clauses from being presented as read-only.
    const kind: SqlKind = inner.kind === 'session' ? 'unknown' : inner.kind;
    return { sql, kind, verb: 'EXPLAIN', ...(kind === 'read' ? {} : { reason: `EXPLAIN 内层语句为 ${inner.kind}` }) };
  }

  if (/^(INSERT|REPLACE|MERGE)\b/.test(code)) return { sql, kind: 'write', verb };

  if (/^(UPDATE|DELETE)\b/.test(code)) {
    if (!/\bWHERE\b/.test(code)) {
      return { sql, kind: 'destructive', verb, reason: `${verb} 缺少 WHERE，将影响整表` };
    }
    return { sql, kind: 'write', verb };
  }

  if (/^TRUNCATE\b/.test(code)) return { sql, kind: 'destructive', verb: 'TRUNCATE' };
  if (/^DROP\b/.test(code)) return { sql, kind: 'destructive', verb: 'DROP' };

  if (/^ALTER\b/.test(code)) {
    if (/\bDROP\b/.test(code)) {
      return { sql, kind: 'destructive', verb: 'ALTER', reason: 'ALTER ... DROP 会丢失数据' };
    }
    return { sql, kind: 'ddl', verb: 'ALTER' };
  }

  if (/^(CREATE|RENAME|COMMENT|GRANT|REVOKE|REINDEX|ATTACH|DETACH|VACUUM)\b/.test(code)) {
    return { sql, kind: 'ddl', verb };
  }

  // SQL Server 改表名/列名走 EXEC sp_rename —— 这是结构变更，不是普通存储过程调用。
  // 以前它落到 unknown，任何"只认 ddl/destructive"的下游判定（例如结构缓存失效）
  // 都会漏掉它：改完表名既不广播也不清缓存，客户端一直显示旧表名。
  // 其余 EXEC（usp_xxx 之类）仍归 unknown，不跟着一起算。
  // 注意 code 已被 toUpperCase，这里的正则必须用大写。
  if (/^EXEC(UTE)?\b/.test(code) && /\bSP_RENAME\b/.test(code)) {
    return { sql, kind: 'ddl', verb: 'EXEC', reason: 'sp_rename 会改表名或列名' };
  }

  // 会话级语句：只改当前连接的上下文或事务边界，不动数据。
  //
  // 以前它们没有规则覆盖，落到下面的 unknown，而 unknown 一律当 ddl ——
  // 结果是 `SET SESSION group_concat_max_len=65535; SELECT ...` 这种最普通的
  // 调参查询会被判成「包含写操作」，在多语句闸门和只读连接上双双被拒。
  // 危险子集单独处理：GLOBAL / PERSIST 改的是服务端配置，PASSWORD 改的是凭证。
  if (/^SET\b/.test(code)) {
    if (/\bPASSWORD\b/.test(code)) return { sql, kind: 'destructive', verb: 'SET', reason: 'SET PASSWORD 会修改凭证' };
    // 改的是权限上下文而不是会话参数：只读连接上放行等于允许提权后再读。
    if (/\bROLE\b/.test(code) || /\bSESSION\s+AUTHORIZATION\b/.test(code)) {
      return { sql, kind: 'write', verb: 'SET', reason: 'SET ROLE / SESSION AUTHORIZATION 会切换权限上下文' };
    }
    if (/\b(GLOBAL|PERSIST|PERSIST_ONLY)\b/.test(code)) {
      return { sql, kind: 'write', verb: 'SET', reason: '修改服务端全局配置，不是会话级设置' };
    }
    return { sql, kind: 'session', verb: 'SET' };
  }
  if (/^(USE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(code)) {
    return { sql, kind: 'session', verb };
  }

  return { sql, kind: 'unknown', verb: verb || 'UNKNOWN' };
}

const KNOWN_RISK: Record<SqlKind, Risk> = {
  read: 'read',
  write: 'write',
  ddl: 'ddl',
  destructive: 'destructive',
  // 会话级语句不碰数据，按只读参与风险相加：夹在写脚本里也不会抬高整体风险。
  session: 'read',
  unknown: 'ddl',
};

export function classifySql(sql: string, engine?: Engine): SqlClassification {
  const statements = splitStatements(sql, engine).map((s) => classifyStatement(s, engine));
  let risk: Risk = 'read';
  for (const s of statements) {
    const r = KNOWN_RISK[s.kind];
    if (RISK_RANK[r] > RISK_RANK[risk]) risk = r;
  }
  const kinds = new Set(statements.map((s) => s.kind));
  const kind: SqlKind = kinds.has('destructive')
    ? 'destructive'
    : kinds.has('ddl') || kinds.has('unknown')
      ? 'ddl'
      : kinds.has('write')
        ? 'write'
        : kinds.size === 1 && kinds.has('session')
          ? 'session'
          : 'read';
  return { risk, kind, statements };
}

export function isReadOnlyStatement(sql: string, engine?: Engine): boolean {
  const kind = classifyStatement(sql, engine).kind;
  return kind === 'read' || kind === 'session';
}

/** Returns a human-readable rejection reason for readonly connections, or null when allowed. */
export function readonlyViolation(sql: string, engine?: Engine): string | null {
  const statements = splitStatements(sql, engine);
  if (!statements.length) return '空 SQL';
  for (const s of statements) {
    const info = classifyStatement(s, engine);
    // 会话级语句（SET SESSION / USE / 事务边界）不写数据，只读连接上没有理由拒绝：
    // 它既不会改库，也不会绕开后面每条语句各自的只读判定。
    if (info.kind !== 'read' && info.kind !== 'session') {
      return `只读连接不允许执行 ${info.verb}${info.reason ? `（${info.reason}）` : ''}`;
    }
  }
  return null;
}

/** Append a LIMIT to a single plain SELECT when the user did not specify one. */
export function applyLimit(sql: string, limit: number, engine?: Engine): string {
  if (!limit || limit <= 0) return sql;
  const statements = splitStatements(sql, engine);
  if (statements.length !== 1) return sql;
  const s = statements[0];
  if (classifyStatement(s, engine).kind !== 'read') return sql;
  const code = maskLiterals(s, engine).replace(/\s+/g, ' ').toUpperCase();
  if (/^(SHOW|DESCRIBE|DESC|PRAGMA|EXPLAIN)\b/.test(code)) return sql;
  if (/\bLIMIT\b|\bFETCH\s+(FIRST|NEXT)\b|\bTOP\s+\d+\b|\bOFFSET\b/.test(code)) return sql;
  const clean = s.replace(/;\s*$/, '');
  const n = Math.floor(limit);
  const dialect = engine ? dialectOf(engine) : undefined;
  // 追加必须另起一行：原句尾部若有 -- 行注释，同行追加的 LIMIT 会被注释掉，
  // 服务端不再限流；PG 的外包 LIMIT 还会把闭括号一起注释掉造成语法错误。
  if (dialect === 'mssql') {
    const hasOrder = /\bORDER\s+BY\b/.test(code);
    return `${clean}\n${hasOrder ? '' : 'ORDER BY (SELECT NULL) '}OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  }
  if (dialect === 'oracle') return `${clean}\nFETCH FIRST ${n} ROWS ONLY`;
  return `${clean}\nLIMIT ${n}`;
}

/** Best-effort primary table reference, used for context hints only. */
export function extractTableRef(sql: string): string | undefined {
  const masked = maskLiterals(sql);
  const m = masked.match(/\bFROM\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/i);
  return m ? m[1].replace(/[`"\[\]]/g, '') : undefined;
}

export function countStatements(sql: string, engine?: Engine): number {
  return splitStatements(sql, engine).length;
}
