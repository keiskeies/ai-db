import { dialectOf } from '../engines';
import type { Engine, Risk } from '../types';

export type SqlKind = 'read' | 'write' | 'ddl' | 'destructive' | 'unknown';

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

/** Replace quoted literals/identifiers and comments with blanks so keyword checks never fire inside data. */
export function maskLiterals(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && q !== "'") {
          i += 2;
          continue;
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
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
export function splitStatements(sql: string): string[] {
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
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
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
        if (sql[i] === '\\' && q !== "'" && i + 1 < n) {
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

export function classifyStatement(sql: string): StatementInfo {
  const masked = maskLiterals(sql).replace(/\s+/g, ' ').trim();
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
    if (/\b(JOURNAL_MODE|WAL_CHECKPOINT|REKEY|KEY|VACUUM|OPTIMIZE)\b/.test(code)) {
      return { sql, kind: 'write', verb, reason: 'PRAGMA 会产生副作用' };
    }
    return { sql, kind: 'read', verb };
  }

  if (/^EXPLAIN\b/.test(code)) {
    if (/^EXPLAIN\s+(ANALYZE|ANALYSE)\b/.test(code)) {
      const inner = classifyStatement(code.replace(/^EXPLAIN\s+(ANALYZE|ANALYSE)\b/, ''));
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

  return { sql, kind: 'unknown', verb: verb || 'UNKNOWN' };
}

const KNOWN_RISK: Record<SqlKind, Risk> = {
  read: 'read',
  write: 'write',
  ddl: 'ddl',
  destructive: 'destructive',
  unknown: 'ddl',
};

export function classifySql(sql: string): SqlClassification {
  const statements = splitStatements(sql).map(classifyStatement);
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
        : 'read';
  return { risk, kind, statements };
}

export function isReadOnlyStatement(sql: string): boolean {
  return classifyStatement(sql).kind === 'read';
}

/** Returns a human-readable rejection reason for readonly connections, or null when allowed. */
export function readonlyViolation(sql: string, _engine?: Engine): string | null {
  const statements = splitStatements(sql);
  if (!statements.length) return '空 SQL';
  for (const s of statements) {
    const info = classifyStatement(s);
    if (info.kind !== 'read') {
      return `只读连接不允许执行 ${info.verb}${info.reason ? `（${info.reason}）` : ''}`;
    }
  }
  return null;
}

/** Append a LIMIT to a single plain SELECT when the user did not specify one. */
export function applyLimit(sql: string, limit: number, engine?: Engine): string {
  if (!limit || limit <= 0) return sql;
  const statements = splitStatements(sql);
  if (statements.length !== 1) return sql;
  const s = statements[0];
  if (classifyStatement(s).kind !== 'read') return sql;
  const code = maskLiterals(s).replace(/\s+/g, ' ').toUpperCase();
  if (/^(SHOW|DESCRIBE|DESC|PRAGMA|EXPLAIN)\b/.test(code)) return sql;
  if (/\bLIMIT\b|\bFETCH\s+(FIRST|NEXT)\b|\bTOP\s+\d+\b|\bOFFSET\b/.test(code)) return sql;
  const clean = s.replace(/;\s*$/, '');
  const n = Math.floor(limit);
  const dialect = engine ? dialectOf(engine) : undefined;
  if (dialect === 'mssql') {
    const hasOrder = /\bORDER\s+BY\b/.test(code);
    return `${clean}${hasOrder ? '' : ' ORDER BY (SELECT NULL)'} OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  }
  if (dialect === 'oracle') return `${clean} FETCH FIRST ${n} ROWS ONLY`;
  return `${clean} LIMIT ${n}`;
}

/** Best-effort primary table reference, used for context hints only. */
export function extractTableRef(sql: string): string | undefined {
  const masked = maskLiterals(sql);
  const m = masked.match(/\bFROM\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/i);
  return m ? m[1].replace(/[`"\[\]]/g, '') : undefined;
}

export function countStatements(sql: string): number {
  return splitStatements(sql).length;
}
