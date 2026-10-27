import type { ConnectionConfig, TableInfo } from '@aidb/core';
import { engineUsesSchema, quoteIdent, quoteLiteral, quoteQualified } from '@aidb/core';

export function connectionSchema(conn: ConnectionConfig, table?: TableInfo): string | undefined {
  if (!engineUsesSchema(conn.engine)) return undefined;
  if (table?.schema) return table.schema;
  if (conn.engine === 'sqlserver') return 'dbo';
  if (conn.engine === 'oracle') return (conn.username ?? '').toUpperCase();
  if (conn.engine === 'clickhouse') return conn.database ?? 'default';
  return 'public';
}

export function tableRef(conn: ConnectionConfig, table: TableInfo, name?: string): string {
  return quoteQualified([connectionSchema(conn, table), name ?? table.name], conn.engine);
}

export function q(conn: ConnectionConfig, name: string): string {
  return quoteIdent(name, conn.engine);
}

export function lit(value: string): string {
  return quoteLiteral(value);
}

export function textColumn(type: string): boolean {
  return /char|text|json|clob|uuid|enum|set/i.test(type);
}

export function numericColumn(type: string): boolean {
  return /int|serial|numeric|decimal|real|double|float|money|number/i.test(type);
}
