import { dialectOf } from '../engines';
import type { Engine } from '../types';

export function quoteIdent(name: string, engine: Engine): string {
  if (name.includes('\u0000')) throw new Error('非法标识符');
  const dialect = dialectOf(engine);
  if (dialect === 'mysql' || dialect === 'clickhouse') return '`' + name.replace(/`/g, '``') + '`';
  if (dialect === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
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
  const dialect = dialectOf(engine);
  if (dialect === 'postgres') return `$${index}`;
  if (dialect === 'oracle') return `:${index}`;
  if (dialect === 'mssql') return `@p${index}`;
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
