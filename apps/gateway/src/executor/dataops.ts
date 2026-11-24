import { buildSelectTable, isSqlEngine } from '@aidb/core';
import { DbError } from '../drivers';
import { EXPORT_QUERY_TIMEOUT_MS } from '../manager';
import { assertExportable, dumpDatabase, exportNeedsStatement, importCsv } from '../services';
import { writeExportFile } from '../xlsx';
import { defineTool, ok } from './types';

export const exportResultTool = defineTool('export_result', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const format = (['csv', 'json', 'sql', 'xml', 'xlsx'].includes(String(a.format)) ? String(a.format) : 'csv') as 'csv' | 'json' | 'sql' | 'xml' | 'xlsx';
  assertExportable(conn.engine, format);
  const limit = Math.min(200000, Math.max(1, Number(a.limit) || 10000));
  let sql: string;
  let tableName: string | undefined;
  if (typeof a.sql === 'string' && a.sql.trim()) sql = a.sql;
  else if (typeof a.table === 'string' && a.table) {
    if (!isSqlEngine(conn.engine)) exportNeedsStatement(conn.engine);
    const { table } = await s.manager.findTable(conn.id, database, a.table);
    tableName = table.name;
    sql = buildSelectTable(conn.engine, table.name, { schema: s.schemaFor(conn, table), limit });
  } else throw new DbError('需要 sql 或 table 之一');
  const batch = await s.manager.query(conn.id, sql, {
    database,
    maxRows: limit,
    allowMulti: false,
    autoLimit: false,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
    // G2：导出查询与 /export 路由同口径（120s），此前漏传。
    timeoutMs: EXPORT_QUERY_TIMEOUT_MS,
  });
  const set = batch.sets[0];
  if (!set) throw new DbError('没有可导出的结果');
  // K4：WP5 将把 writeExportFile 异步化，这里先 await（对同步函数 await 亦合法）。
  const file = await writeExportFile({
    dir: s.config.exportDir,
    format,
    columns: set.columns.map((c) => c.name),
    rows: set.rows,
    tableName,
    engine: conn.engine,
    signal: ctx.signal,
  });
  return ok(started, `已导出 ${file.rows} 行为 ${format.toUpperCase()}`, { ...file, format, table: tableName });
});

export const importCsvTool = defineTool('import_csv', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const result = await importCsv(s.store, s.manager, s.config, conn.id, {
    table: String(a.table ?? ''),
    path: typeof a.path === 'string' ? a.path : undefined,
    hasHeader: a.hasHeader !== false,
    delimiter: typeof a.delimiter === 'string' ? a.delimiter : undefined,
    mapping: Array.isArray(a.mapping) ? (a.mapping as Array<{ column: string; sourceIndex?: number }>) : undefined,
    database: s.databaseOf(call, conn),
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  s.manager.invalidate(conn.id);
  return ok(started, `已导入 ${result.inserted} 行`, result);
});

export const backupDatabaseTool = defineTool('backup_database', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const backup = await dumpDatabase(
    s.store,
    s.manager,
    s.config,
    conn.id,
    s.databaseOf(call, conn),
    typeof a.label === 'string' ? a.label : undefined,
    ctx.signal,
    ctx.executionId,
  );
  return ok(started, `备份完成：${backup.tables} 张表 / ${backup.rows} 行`, backup, { backupPath: backup.path });
});

export const getQueryHistoryTool = defineTool('get_query_history', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const connectionId = typeof a.connectionId === 'string' ? a.connectionId : ctx.connectionId;
  const items = s.store.listHistory({
    connectionId,
    search: typeof a.search === 'string' ? a.search : undefined,
    limit: Math.min(100, Number(a.limit) || 30),
  });
  return ok(started, `读取 ${items.length} 条历史`, { items });
});
