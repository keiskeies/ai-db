import {
  buildCreateTable,
  buildDropObject,
  buildRenameTable,
  buildTableMaintenance,
  buildTruncate,
  engineUsesSchema,
  quoteIdent,
  quoteQualified,
  type ColumnDef,
  type QueryBatchResult,
  type TableMaintenanceAction,
} from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

export type TableOp = 'ddl' | 'rename' | 'duplicate' | 'truncate' | 'empty' | 'drop' | 'maintenance';

export interface TableOpInput {
  connectionId: string;
  database?: string;
  table: string;
  schema?: string;
  op: TableOp;
  newName?: string;
  withData?: boolean;
  action?: TableMaintenanceAction;
}

export interface TableOpResult {
  statements: string[];
  batch?: QueryBatchResult;
  ddl?: string;
  supported?: boolean;
  message?: string;
}

function cleanName(value: string | undefined, label: string): string {
  const name = value?.trim();
  if (!name) throw Object.assign(new Error(`${label}不能为空`), { code: 'INVALID_INPUT', status: 400 });
  if (name.includes('\u0000')) throw Object.assign(new Error(`${label}包含非法字符`), { code: 'INVALID_INPUT', status: 400 });
  return name;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.endsWith(';') ? item : `${item};`));
}

async function ensureUnusedName(manager: ConnectionManager, connectionId: string, database: string | undefined, name: string): Promise<void> {
  const schemas = await manager.schema(connectionId, database, true);
  const exists = schemas.some((schema) => schema.tables.some((table) => table.name.toLowerCase() === name.toLowerCase()));
  if (exists) throw Object.assign(new Error(`对象已存在：${name}`), { code: 'ALREADY_EXISTS', status: 409 });
}

function toColumnDefs(columns: NonNullable<Awaited<ReturnType<ConnectionManager['findTable']>>['table']['columns']>): ColumnDef[] {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    defaultValue: column.defaultValue ?? null,
    primaryKey: column.primaryKey,
    autoIncrement: column.autoIncrement,
    comment: column.comment,
  }));
}

export async function runTableOp(store: Store, manager: ConnectionManager, input: TableOpInput): Promise<TableOpResult> {
  const conn = store.getConnection(input.connectionId);
  if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const { table } = await manager.findTable(input.connectionId, input.database, input.table);
  const schema = engineUsesSchema(conn.engine) ? table.schema ?? input.schema : undefined;
  const target = table.name;
  const isView = table.type === 'view';

  if (input.op === 'ddl') {
    if (isView) {
      if (conn.engine === 'mysql' || conn.engine === 'mariadb') {
        const batch = await manager.query(input.connectionId, `SHOW CREATE VIEW ${quoteQualified([schema, target], conn.engine)}`, {
          database: input.database,
          allowMulti: false,
          autoLimit: false,
          actor: 'user',
        });
        const row = batch.sets[0]?.rows?.[0] ?? [];
        const ddl = String(row[row.length - 1] ?? '');
        return { statements: [ddl], ddl };
      }
      return { statements: [], ddl: '', message: '当前引擎暂不支持从元数据还原视图 DDL，请在查询编辑器查看定义。' };
    }
    const columns = toColumnDefs(table.columns ?? []);
    if (!columns.length) throw Object.assign(new Error('无法读取列结构'), { code: 'EMPTY_SCHEMA', status: 400 });
    const indexes = (table.indexes ?? [])
      .filter((index) => !index.primary && index.name?.toUpperCase() !== 'PRIMARY' && !index.name?.startsWith('sqlite_autoindex_'))
      .map((index) => ({ name: index.name, columns: index.columns, unique: index.unique }));
    const ddl = buildCreateTable(conn.engine, {
      table: target,
      columns,
      indexes,
      foreignKeys: table.foreignKeys,
      schema,
      comment: table.comment,
    });
    return { statements: splitStatements(ddl), ddl };
  }

  if (isView && input.op !== 'drop') {
    throw Object.assign(new Error('视图仅支持查看 DDL 与删除'), { code: 'UNSUPPORTED', status: 400 });
  }

  let statements: string[] = [];
  let risk: 'read' | 'write' | 'ddl' | 'destructive' = 'ddl';

  if (input.op === 'rename') {
    if (isView) throw Object.assign(new Error('当前引擎暂不支持重命名视图'), { code: 'UNSUPPORTED', status: 400 });
    const newName = cleanName(input.newName, '新表名');
    if (newName.toLowerCase() === target.toLowerCase()) throw Object.assign(new Error('新表名与原表名相同'), { code: 'INVALID_INPUT', status: 400 });
    await ensureUnusedName(manager, input.connectionId, input.database, newName);
    statements = [buildRenameTable(conn.engine, target, newName, schema)];
  } else if (input.op === 'duplicate') {
    const newName = cleanName(input.newName, '新表名');
    if (newName.toLowerCase() === target.toLowerCase()) throw Object.assign(new Error('新表名与原表名相同'), { code: 'INVALID_INPUT', status: 400 });
    await ensureUnusedName(manager, input.connectionId, input.database, newName);
    const columns = toColumnDefs(table.columns ?? []);
    if (!columns.length) throw Object.assign(new Error('无法读取列结构'), { code: 'EMPTY_SCHEMA', status: 400 });
    const indexes = (table.indexes ?? [])
      .filter((index) => !index.primary && index.name?.toUpperCase() !== 'PRIMARY' && !index.name?.startsWith('sqlite_autoindex_'))
      .map((index) => ({ columns: index.columns, unique: index.unique }));
    const foreignKeys = (table.foreignKeys ?? []).map((fk) => ({ ...fk, name: undefined }));
    const create = buildCreateTable(conn.engine, { table: newName, columns, indexes, foreignKeys, schema });
    statements = splitStatements(create);
    if (input.withData) {
      const auto = new Set(columns.filter((column) => column.autoIncrement).map((column) => column.name));
      const copy = columns.map((column) => column.name).filter((name) => !auto.has(name));
      if (copy.length) {
        const list = copy.map((name) => quoteIdent(name, conn.engine)).join(', ');
        statements.push(
          `INSERT INTO ${quoteQualified([schema, newName], conn.engine)} (${list}) SELECT ${list} FROM ${quoteQualified([schema, target], conn.engine)};`,
        );
      }
    }
  } else if (input.op === 'truncate') {
    if (isView) throw Object.assign(new Error('视图不能清空'), { code: 'UNSUPPORTED', status: 400 });
    statements = [buildTruncate(conn.engine, target, schema)];
    if (conn.engine === 'sqlite' && (table.columns ?? []).some((column) => column.autoIncrement)) {
      statements.push(`DELETE FROM sqlite_sequence WHERE name = '${target.replace(/'/g, "''")}'`);
    }
    risk = 'destructive';
  } else if (input.op === 'empty') {
    if (isView) throw Object.assign(new Error('视图不能清空'), { code: 'UNSUPPORTED', status: 400 });
    statements = [`DELETE FROM ${quoteQualified([schema, target], conn.engine)}`];
    risk = 'destructive';
  } else if (input.op === 'drop') {
    statements = [buildDropObject(conn.engine, isView ? 'view' : 'table', target, false, schema)];
    risk = 'destructive';
  } else if (input.op === 'maintenance') {
    const action = input.action;
    if (!action || !['analyze', 'optimize', 'check', 'repair', 'vacuum'].includes(action)) {
      throw Object.assign(new Error('未知维护动作'), { code: 'INVALID_INPUT', status: 400 });
    }
    const plan = buildTableMaintenance(conn.engine, target, action, schema);
    if (!plan) {
      return {
        statements: [],
        supported: false,
        message: `${conn.engine} 不支持 ${action} 操作`,
      };
    }
    statements = plan;
    risk = action === 'check' ? 'read' : 'write';
  } else {
    throw Object.assign(new Error('未知表操作'), { code: 'INVALID_INPUT', status: 400 });
  }

  const sql = statements.map((statement) => statement.trim().replace(/;+$/, '')).join(';\n');
  const started = Date.now();
  const batch = await manager.query(input.connectionId, sql, {
    database: input.database,
    allowMulti: true,
    autoLimit: false,
    timeoutMs: store.getSettings().queryTimeoutMs,
    actor: 'user',
  });
  manager.invalidate(input.connectionId);
  store.addAudit({
    actor: 'user',
    connectionId: input.connectionId,
    database: input.database,
    tool: `table.${input.op}${input.action ? `.${input.action}` : ''}`,
    sql,
    risk,
    approval: 'manual',
    status: 'ok',
    durationMs: Date.now() - started,
    meta: { table: target, newName: input.newName, withData: input.withData },
  });
  return { statements, batch, supported: true };
}
