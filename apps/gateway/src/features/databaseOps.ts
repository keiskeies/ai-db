import { quoteIdent, type Engine } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

export type DatabaseOp = 'create' | 'drop' | 'rename';

export interface DatabaseOpInput {
  connectionId: string;
  database: string;
  op: DatabaseOp;
  newName?: string;
}

export interface DatabaseOpResult {
  supported: boolean;
  statements: string[];
  message?: string;
}

function statementsFor(engine: Engine, op: DatabaseOp, database: string, newName?: string): string[] | null {
  if (engine === 'sqlite' || engine === 'oracle') return null;
  const current = quoteIdent(database, engine);
  if (op === 'create') {
    if (engine === 'mysql' || engine === 'mariadb') return [`CREATE DATABASE ${current} CHARACTER SET utf8mb4`];
    if (engine === 'postgresql' || engine === 'cockroachdb') return [`CREATE DATABASE ${current}`];
    if (engine === 'sqlserver') return [`CREATE DATABASE ${current}`];
    return [`CREATE DATABASE ${current}`];
  }
  if (op === 'drop') {
    return [`DROP DATABASE ${current}`];
  }
  if (!newName) return null;
  const next = quoteIdent(newName, engine);
  if (engine === 'postgresql' || engine === 'cockroachdb') return [`ALTER DATABASE ${current} RENAME TO ${next}`];
  if (engine === 'sqlserver') return [`ALTER DATABASE ${current} MODIFY NAME = ${next}`];
  if (engine === 'clickhouse') return [`RENAME DATABASE ${current} TO ${next}`];
  return null;
}

function maintenanceDatabase(engine: Engine, fallback?: string): string | undefined {
  if (engine === 'mysql' || engine === 'mariadb') return 'mysql';
  if (engine === 'postgresql' || engine === 'cockroachdb') return 'postgres';
  if (engine === 'sqlserver') return 'master';
  if (engine === 'clickhouse') return 'default';
  return fallback;
}

export async function runDatabaseOp(store: Store, manager: ConnectionManager, input: DatabaseOpInput): Promise<DatabaseOpResult> {
  const conn = store.getConnection(input.connectionId);
  if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
  const database = input.database.trim();
  if (!database) throw Object.assign(new Error('数据库名不能为空'), { code: 'INVALID_INPUT', status: 400 });
  if (input.op === 'rename' && !input.newName?.trim()) {
    throw Object.assign(new Error('新数据库名不能为空'), { code: 'INVALID_INPUT', status: 400 });
  }
  const statements = statementsFor(conn.engine, input.op, database, input.newName?.trim());
  if (!statements) {
    return {
      supported: false,
      statements: [],
      message: `${conn.engine} 不支持${input.op === 'create' ? '新建' : input.op === 'drop' ? '删除' : '重命名'}数据库`,
    };
  }
  const sql = statements.map((statement) => statement.trim().replace(/;+$/, '')).join(';\n');
  const started = Date.now();
  const useDatabase =
    input.op === 'create' || database === conn.database ? maintenanceDatabase(conn.engine, conn.database) : conn.database;
  const batch = await manager.query(input.connectionId, sql, {
    database: useDatabase,
    allowMulti: true,
    autoLimit: false,
    timeoutMs: store.getSettings().queryTimeoutMs,
    actor: 'user',
  });
  const risk = input.op === 'drop' ? 'destructive' : 'ddl';
  store.addAudit({
    actor: 'user',
    connectionId: input.connectionId,
    database,
    tool: `database.${input.op}`,
    sql,
    risk,
    approval: 'manual',
    status: 'ok',
    durationMs: Date.now() - started,
    meta: { newName: input.newName, sets: batch.sets.length },
  });
  manager.invalidate(input.connectionId);
  return { supported: true, statements };
}
