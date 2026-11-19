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
 *  - $$...$$ 美元引用按字符串掩掉（仅 PG 系方言），函数体里的关键字不参与判定。
 */
export function maskLiterals(sql: string, engine?: Engine): string {
  const mysql = isMysqlDialect(engine);
  const pg = isPgDialect(engine);
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      out += ' '.repeat(i - start);
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (sql[i + 2] === '!' && (mysql || engine === undefined)) {
        // 可执行注释：只跳过 /*! 标记，内容按正常代码继续扫描。
        out += '   ';
        i += 3;
        continue;
      }
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      out += ' '.repeat(i - start);
      continue;
    }
    const tag = pg ? dollarTagAt(sql, i) : undefined;
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? n : close + tag.length;
      out += tag + ' '.repeat(Math.max(0, end - i - tag.length * 2)) + (close === -1 ? '' : tag);
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && mysql) {
          const step = Math.min(2, n - i);
          out += ' '.repeat(step);
          i += step;
          continue;
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            out += '  ';
            i += 2;
            continue;
          }
          out += q;
          i++;
          break;
        }
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Split a script into statements, respecting strings, quoted identifiers and comments. */
export function splitStatements(sql: string, engine?: Engine): string[] {
  const mysql = isMysqlDialect(engine);
  const pg = isPgDialect(engine);
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (sql[i + 2] === '!' && (mysql || engine === undefined)) {
        // 可执行注释里的 ; 是真实语句边界，必须参与拆分。
        current += '/*!';
        i += 3;
        continue;
      }
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const tag = pg ? dollarTagAt(sql, i) : undefined;
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const stop = close === -1 ? n : close + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      current += c;
      i++;
      while (i < n) {
        current += sql[i];
        if (sql[i] === '\\' && mysql && i + 1 < n) {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += c;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function classifyStatement(sql: string, engine?: Engine): StatementInfo {
  const masked = maskLiterals(sql, engine).replace(/\s+/g, ' ').trim();
  const code = masked.toUpperCase();
  const verb = (code.match(/^[A-Z]+/) || [''])[0];

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
    if (/\b(JOURNAL_MODE|WAL_CHECKPOINT|REKEY|KEY|VACUUM|OPTIMIZE|USER_VERSION|APPLICATION_ID)\b/.test(code)) {
      return { sql, kind: 'write', verb, reason: 'PRAGMA 会产生副作用' };
    }
    return { sql, kind: 'read', verb };
  }

  if (/^EXPLAIN\b/.test(code)) {
    if (/^EXPLAIN\s+(ANALYZE|ANALYSE)\b/.test(code)) {
      const inner = classifyStatement(code.replace(/^EXPLAIN\s+(ANALYZE|ANALYSE)\b/, ''), engine);
      const kind: SqlKind = inner.kind === 'read' ? 'write' : inner.kind;
      return { sql, kind, verb: 'EXPLAIN', reason: 'EXPLAIN ANALYZE 会实际执行语句' };
    }
    return { sql, kind: 'read', verb: 'EXPLAIN' };
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
