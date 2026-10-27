import { engineUsesSchema, placeholder, quoteIdent, quoteQualified, type Engine } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

export interface ReplaceInput {
  connectionId: string;
  database?: string;
  table: string;
  column: string;
  find: string;
  replace: string;
  where?: string;
  preview?: boolean;
}

export interface ReplaceResult {
  affected: number;
  sql: string;
  preview: boolean;
}

function textExpr(engine: Engine, column: string): string {
  const col = quoteIdent(column, engine);
  if (engine === 'sqlite') return `CAST(${col} AS TEXT)`;
  if (engine === 'mysql' || engine === 'mariadb') return `CAST(${col} AS CHAR)`;
  if (engine === 'postgresql' || engine === 'cockroachdb') return `${col}::text`;
  if (engine === 'sqlserver') return `CAST(${col} AS NVARCHAR(MAX))`;
  if (engine === 'oracle') return `TO_CHAR(${col})`;
  return `toString(${col})`;
}

function matchExpr(engine: Engine, expr: string, index: number): string {
  const p = placeholder(engine, index);
  if (engine === 'postgresql' || engine === 'cockroachdb') return `POSITION(${p} IN ${expr}) > 0`;
  if (engine === 'sqlserver') return `CHARINDEX(${p}, ${expr}) > 0`;
  if (engine === 'clickhouse') return `position(${expr}, ${p}) > 0`;
  return `INSTR(${expr}, ${p}) > 0`;
}

function replaceExpr(engine: Engine, expr: string, first: number, second: number): string {
  const find = placeholder(engine, first);
  const replacement = placeholder(engine, second);
  return engine === 'clickhouse' ? `replaceAll(${expr}, ${find}, ${replacement})` : `REPLACE(${expr}, ${find}, ${replacement})`;
}

export async function replaceData(store: Store, manager: ConnectionManager, input: ReplaceInput): Promise<ReplaceResult> {
  const conn = store.getConnection(input.connectionId);
  if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
  if (conn.readonly && !input.preview) throw Object.assign(new Error('只读连接禁止修改数据'), { code: 'READONLY', status: 403 });
  const { table } = await manager.findTable(input.connectionId, input.database, input.table);
  const column = (table.columns ?? []).find((item) => item.name === input.column);
  if (!column) throw Object.assign(new Error(`列不存在：${input.column}`), { code: 'COLUMN_NOT_FOUND', status: 404 });
  if (/blob|bytea|binary|varbinary|image/i.test(column.type)) {
    throw Object.assign(new Error('二进制列不支持查找替换'), { code: 'UNSUPPORTED', status: 400 });
  }
  if (!input.find) throw Object.assign(new Error('查找内容不能为空'), { code: 'INVALID_INPUT', status: 400 });

  const schema = engineUsesSchema(conn.engine) ? table.schema : undefined;
  const target = quoteQualified([schema, table.name], conn.engine);
  const expr = textExpr(conn.engine, input.column);
  const scope = input.where?.trim() ? `(${input.where.trim()}) AND ` : '';
  const started = Date.now();

  let sql: string;
  let affected: number;
  if (input.preview) {
    sql = `SELECT COUNT(*) AS ${quoteIdent('count', conn.engine)} FROM ${target} WHERE ${scope}${matchExpr(conn.engine, expr, 1)}`;
    const result = await manager.runParams(input.connectionId, sql, [input.find], { database: input.database, actor: 'user' });
    affected = Number(result.rows?.[0]?.[0] ?? 0);
  } else {
    sql = `UPDATE ${target} SET ${quoteIdent(input.column, conn.engine)} = ${replaceExpr(conn.engine, expr, 1, 2)} WHERE ${scope}${matchExpr(conn.engine, expr, 3)}`;
    const result = await manager.runParams(input.connectionId, sql, [input.find, input.replace, input.find], {
      database: input.database,
      actor: 'user',
    });
    affected = result.affected ?? 0;
    manager.invalidate(input.connectionId);
  }

  store.addAudit({
    actor: 'user',
    connectionId: input.connectionId,
    database: input.database,
    tool: input.preview ? 'data.replace.preview' : 'data.replace',
    sql,
    risk: input.preview ? 'read' : 'write',
    approval: 'manual',
    status: 'ok',
    durationMs: Date.now() - started,
    meta: { table: table.name, column: input.column, affected },
  });
  return { affected, sql, preview: Boolean(input.preview) };
}
