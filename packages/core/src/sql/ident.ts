import type { Engine } from '../types';

const MYSQL_LIKE = new Set<Engine>(['mysql', 'mariadb', 'clickhouse']);
const DOLLAR_PARAMS = new Set<Engine>(['postgresql', 'cockroachdb']);

export function quoteIdent(name: string, engine: Engine): string {
  if (name.includes('\u0000')) throw new Error('非法标识符');
  if (MYSQL_LIKE.has(engine)) return '`' + name.replace(/`/g, '``') + '`';
  if (engine === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']';
  return '"' + name.replace(/"/g, '""') + '"';
}

export function quoteQualified(parts: Array<string | undefined>, engine: Engine): string {
  return parts.filter((p): p is string => Boolean(p)).map((p) => quoteIdent(p, engine)).join('.');
}

export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Parameter placeholder for the given engine, 1-based index. */
export function placeholder(engine: Engine, index: number): string {
  if (DOLLAR_PARAMS.has(engine)) return `$${index}`;
  if (engine === 'oracle') return `:${index}`;
  if (engine === 'sqlserver') return `@p${index}`;
  return '?';
}

export function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
}

export function sanitizeDefaultLiteral(value: string): string {
  const trimmed = value.trim();
  if (/^(NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|true|false)$/i.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') return trimmed.toLowerCase();
    return trimmed;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^'(?:[^']|'')*'$/.test(trimmed)) return trimmed;
  if (/^\(.*\)$/.test(trimmed)) return trimmed;
  return quoteLiteral(trimmed);
}
