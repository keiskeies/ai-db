import { DbError } from '../drivers';
import { defineTool, ok } from './types';

export const listConnectionsTool = defineTool('list_connections', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const connections = s.store.listConnections();
  return ok(started, `共有 ${connections.length} 个连接`, { connections });
});

export const inspectSchemaTool = defineTool('inspect_schema', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const schemas = await s.manager.schema(conn.id, database);
  let tables = schemas.flatMap((s) => s.tables);
  const wanted = Array.isArray(a.tables) ? (a.tables as string[]).map((t) => String(t).toLowerCase()) : [];
  if (wanted.length) {
    tables = tables.filter((t) => wanted.includes(t.name.toLowerCase()));
    if (!tables.length) {
      return {
        ok: false,
        summary: '没有找到指定表',
        error: { code: 'TABLE_NOT_FOUND', message: `未找到表：${(a.tables as string[]).join(', ')}`, hint: '使用 search_objects 搜索真实表名' },
        meta: { durationMs: Date.now() - started },
      };
    }
  }
  const trimmed = tables.slice(0, 300);
  return ok(started, `读取到 ${trimmed.length} 个对象`, {
    connectionId: conn.id,
    database,
    engine: conn.engine,
    tables: trimmed,
    schemas: schemas.map((s) => ({ name: s.name, tables: s.tables.length })),
  });
});

export const searchObjectsTool = defineTool('search_objects', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const query = String(a.query ?? '').toLowerCase().trim();
  if (!query) throw new DbError('query 不能为空');
  const limit = Math.min(100, Number(a.limit) || 20);
  const schemas = await s.manager.schema(conn.id, database);
  const matches: Array<{ table: string; schema?: string; matchedColumns: string[]; comment?: string }> = [];
  for (const schema of schemas) {
    for (const table of schema.tables) {
      if (table.name.toLowerCase().includes(query) || (table.comment ?? '').toLowerCase().includes(query)) {
        matches.push({ table: table.name, schema: table.schema, matchedColumns: [], comment: table.comment });
      } else {
        const cols = (table.columns ?? []).filter((c) => c.name.toLowerCase().includes(query)).map((c) => c.name);
        if (cols.length) matches.push({ table: table.name, schema: table.schema, matchedColumns: cols });
      }
      if (matches.length >= limit) break;
    }
  }
  return ok(started, `找到 ${matches.length} 个匹配对象`, { matches, total: matches.length });
});
