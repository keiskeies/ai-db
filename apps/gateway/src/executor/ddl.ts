import {
  buildAlterTable,
  addField,
  buildCreateIndex,
  buildCreateTable,
  buildDropIndex,
  buildDropObject,
  engineMeta,
  managesIndexes,
  type AlterOp,
  type ColumnDef,
  type IndexDef,
} from '@aidb/core';
import { DbError } from '../drivers';
import { throwIfAborted } from '../drivers/timeout';
import { dumpDatabase } from '../services';
import { defineTool, ok } from './types';

export const createTableTool = defineTool('create_table', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const tableName = String(a.table ?? '').trim();
  if (!tableName) throw new DbError('表名不能为空');
  const columns = Array.isArray(a.columns) ? (a.columns as ColumnDef[]) : [];
  if (!columns.length) throw new DbError('至少需要一列');
  const normalized = columns.map((c) => ({
    ...c,
    name: String(c.name ?? '').trim(),
    type: String(c.type ?? 'TEXT').trim() || 'TEXT',
    autoIncrement: Boolean(c.autoIncrement),
  }));
  for (const c of normalized) if (!c.name) throw new DbError('列名不能为空');
  if (normalized.filter((c) => c.autoIncrement).length > 1) throw new DbError('只能有一列自增');
  for (const c of normalized) if (c.autoIncrement && !/int|serial/i.test(c.type)) c.type = 'INTEGER';
  const indexes = Array.isArray(a.indexes) ? (a.indexes as IndexDef[]) : [];
  const ddl = buildCreateTable(conn.engine, {
    table: tableName,
    columns: normalized,
    indexes,
    schema: s.schemaFor(conn),
    comment: typeof a.comment === 'string' ? a.comment : undefined,
  });
  const settings = s.getSettings();
  const batch = await s.manager.query(conn.id, ddl, {
    database,
    allowMulti: true,
    autoLimit: false,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, `已创建表 ${tableName}`, { table: tableName, ddl, statements: batch.sets.length, messages: batch.messages });
});

export const alterTableTool = defineTool('alter_table', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const tableName = String(a.table ?? '');
  const { table } = await s.manager.findTable(conn.id, database, tableName);
  throwIfAborted(ctx.signal);
  if (addField(conn.engine)) {
    const ops = Array.isArray(a.operations) ? (a.operations as Array<Record<string, unknown>>) : [];
    if (!ops.length) throw new DbError('operations 不能为空');
    const added: string[] = [];
    for (const op of ops) {
      throwIfAborted(ctx.signal);
      if (op.op !== 'add_column') {
        throw new DbError(`${engineMeta(conn.engine).label} 的结构变更只支持 add_column`, {
          code: 'UNSUPPORTED_ENGINE',
          hint: '其余变更请在引擎控制台完成',
        });
      }
      const column = (op.column ?? {}) as { name?: string; type?: string };
      const result = await s.manager.createField(
        conn.id,
        { object: tableName, name: String(column.name ?? ''), type: String(column.type ?? 'text') },
        { database, timeoutMs: s.getSettings().queryTimeoutMs, actor: 'agent', executionId: ctx.executionId,
    signal: ctx.signal },
      );
      added.push(`${result.name}:${result.type}`);
    }
    return ok(started, `已追加 ${added.length} 个字段`, { table: tableName, columns: added });
  }
  const operations = Array.isArray(a.operations) ? (a.operations as AlterOp[]) : [];
  if (!operations.length) throw new DbError('operations 不能为空');
  const statements = buildAlterTable(conn.engine, table.name, operations, s.schemaFor(conn, table));
  const settings = s.getSettings();
  await s.manager.query(conn.id, statements.join(';\n'), {
    database,
    allowMulti: true,
    autoLimit: false,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, `已修改表 ${tableName}（${statements.length} 条语句）`, { table: tableName, statements });
});

export const dropObjectTool = defineTool('drop_object', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const name = String(a.name ?? '');
  const kind = a.kind === 'view' ? 'view' : 'table';
  const schemas = await s.manager.schema(conn.id, database);
  const found = schemas.flatMap((s) => s.tables).find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new DbError(`对象不存在：${name}`);
  let backupPath: string | undefined;
  const settings = s.getSettings();
  if (settings.agent.snapshotBeforeWrite) {
    const backup = await dumpDatabase(s.store, s.manager, s.config, conn.id, database, `auto-before-drop:${name}`, ctx.signal, ctx.executionId);
    backupPath = backup.path;
  }
  throwIfAborted(ctx.signal);
  const sql = buildDropObject(conn.engine, kind, found.name, Boolean(a.cascade), s.schemaFor(conn, found));
  await s.manager.query(conn.id, sql, {
    database,
    allowMulti: false,
    autoLimit: false,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, `已删除${kind === 'view' ? '视图' : '表'} ${found.name}`, { name: found.name, kind, sql, backupPath }, { backupPath });
});

export const manageIndexTool = defineTool('manage_index', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const tableName = String(a.table ?? '');
  if (managesIndexes(conn.engine)) {
    const settings = s.getSettings();
    const raw = (a.index ?? {}) as IndexDef;
    const result =
      a.action === 'drop'
        ? await s.manager.dropCollectionIndex(
            conn.id,
            { collection: tableName, name: String(a.name ?? raw.name ?? '') },
            { database, timeoutMs: settings.queryTimeoutMs, actor: 'agent', executionId: ctx.executionId,
    signal: ctx.signal },
          )
        : await s.manager.createCollectionIndex(
            conn.id,
            {
              collection: tableName,
              name: typeof raw.name === 'string' ? raw.name : undefined,
              columns: Array.isArray(raw.columns) ? raw.columns.map(String) : [],
              unique: Boolean(raw.unique),
              sparse: a.sparse === true,
              expireAfterSeconds: Number(a.expireAfterSeconds ?? 0) > 0 ? Math.floor(Number(a.expireAfterSeconds)) : undefined,
              type: typeof a.type === 'string' ? a.type : undefined,
            },
            { database, timeoutMs: settings.queryTimeoutMs, actor: 'agent', executionId: ctx.executionId,
    signal: ctx.signal },
          );
    return ok(started, a.action === 'drop' ? '索引已删除' : '索引已创建', { table: tableName, index: result.name });
  }
  const { table } = await s.manager.findTable(conn.id, database, tableName);
  const action = a.action === 'drop' ? 'drop' : 'create';
  let sql: string;
  if (action === 'drop') {
    const name = String(a.name ?? (a.index as IndexDef | undefined)?.name ?? '');
    if (!name) throw new DbError('删除索引需要 name');
    sql = buildDropIndex(conn.engine, table.name, name, s.schemaFor(conn, table));
  } else {
    const raw = (a.index ?? {}) as IndexDef;
    const columns = Array.isArray(raw.columns) ? raw.columns.map(String) : [];
    if (!columns.length) throw new DbError('创建索引需要 columns');
    for (const col of columns) {
      if (!(table.columns ?? []).some((c) => c.name === col)) throw new DbError(`列不存在：${col}`);
    }
    sql = buildCreateIndex(
      conn.engine,
      table.name,
      { name: raw.name, columns, unique: Boolean(raw.unique) },
      s.schemaFor(conn, table),
    );
  }
  const settings = s.getSettings();
  await s.manager.query(conn.id, sql, {
    database,
    allowMulti: false,
    autoLimit: false,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, action === 'drop' ? '索引已删除' : '索引已创建', { table: table.name, sql });
});
