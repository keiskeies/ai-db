import { dialectOf, engineUsesSchema, quoteIdent, quoteQualified, type ConnectionConfig, type TableInfo } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { sqlLiteral } from '../exportFormat';
import { supportsTransaction } from '../drivers/types';

export interface DataCompareRow {
  table: string;
  sourceRows: number;
  targetRows: number | null;
  status: 'same' | 'different' | 'missing' | 'error';
  error?: string;
}

export interface DataCompareResult {
  source: string;
  target: string;
  rows: DataCompareRow[];
  same: number;
  different: number;
  missing: number;
}

const PAGE_ROWS = 1000;
const KEY_CHUNK_ROWS = 100;

function tableRef(conn: ConnectionConfig, table: TableInfo): string {
  return quoteQualified([engineUsesSchema(conn.engine) ? table.schema : undefined, table.name], conn.engine);
}

function pageSql(conn: ConnectionConfig, table: TableInfo, primary: NonNullable<TableInfo['columns']>, offset: number): string {
  const order = primary.map((column) => quoteIdent(column.name, conn.engine)).join(', ');
  const dialect = dialectOf(conn.engine);
  if (dialect === 'mssql') return `SELECT * FROM ${tableRef(conn, table)} ORDER BY ${order} OFFSET ${offset} ROWS FETCH NEXT ${PAGE_ROWS} ROWS ONLY`;
  if (dialect === 'oracle' || dialect === 'dm') return `SELECT * FROM ${tableRef(conn, table)} ORDER BY ${order} OFFSET ${offset} ROWS FETCH NEXT ${PAGE_ROWS} ROWS ONLY`;
  return `SELECT * FROM ${tableRef(conn, table)} ORDER BY ${order} LIMIT ${PAGE_ROWS} OFFSET ${offset}`;
}

function snapshotSql(engine: ConnectionConfig['engine']): string | undefined {
  const dialect = dialectOf(engine);
  if (dialect === 'postgres') return 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
  if (dialect === 'mssql') return 'SET TRANSACTION ISOLATION LEVEL SNAPSHOT';
  if (dialect === 'oracle' || dialect === 'dm') return 'SET TRANSACTION READ ONLY';
  return undefined;
}

function numericColumnType(type: string | undefined): boolean {
  return /^(?:u?int(?:eger)?|bigint|smallint|mediumint|tinyint|serial|bigserial|numeric|decimal|dec|real|float|double|money|number|binary_float|binary_double)\b/i.test(type?.trim() ?? '');
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function valuesEqual(left: unknown, right: unknown, leftType?: string, rightType?: string): boolean {
  if (left === null || right === null) return left === null && right === null;
  if (left === undefined || right === undefined) return left === undefined && right === undefined;

  // 仅当两侧列都声明为数值列时，兼容 PG/Oracle 返回数值字符串而另一侧返回 number 的驱动差异。
  // TEXT/VARCHAR 的 '1' 与数值 1、BOOLEAN 的 true 与数值 1 仍必须视为不同。
  if (numericColumnType(leftType) && numericColumnType(rightType)) {
    const a = numericValue(left);
    const b = numericValue(right);
    if (a !== undefined && b !== undefined) return a === b;
  }

  if (typeof left !== typeof right) return false;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.from(left).equals(Buffer.from(right));
  if (typeof left === 'object' && typeof right === 'object') return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

async function compareTables(
  manager: ConnectionManager,
  sourceId: string,
  sourceDatabase: string | undefined,
  source: ConnectionConfig,
  sourceTable: TableInfo,
  targetId: string,
  targetDatabase: string | undefined,
  target: ConnectionConfig,
  targetTable: TableInfo,
): Promise<{ sourceRows: number; targetRows: number; equal: boolean; error?: string }> {
  const sourcePrimary = (sourceTable.columns ?? []).filter((column) => column.primaryKey);
  const targetPrimary = (targetTable.columns ?? []).filter((column) => column.primaryKey);
  if (!sourcePrimary.length || !targetPrimary.length) return { sourceRows: 0, targetRows: 0, equal: false, error: '无主键表无法证明数据一致，请使用对账功能' };

  const sourceColumns = sourceTable.columns ?? [];
  const targetColumns = targetTable.columns ?? [];
  const targetIndex = new Map(targetColumns.map((column, index) => [column.name.toLowerCase(), index]));
  if (sourceColumns.length !== targetColumns.length || sourceColumns.some((column) => !targetIndex.has(column.name.toLowerCase()))) {
    return { sourceRows: 0, targetRows: 0, equal: false, error: '两侧列集合不同' };
  }
  const alignedTargetColumns = sourceColumns.map((column) => targetColumns[targetIndex.get(column.name.toLowerCase())!]);
  const targetNames = alignedTargetColumns.map((column) => column.name);
  if (sourcePrimary.some((column) => !targetIndex.has(column.name.toLowerCase()))) {
    return { sourceRows: 0, targetRows: 0, equal: false, error: '目标表缺少同名的源主键列' };
  }
  const targetKeyNames = sourcePrimary.map((column) => targetColumns[targetIndex.get(column.name.toLowerCase())!].name);
  const [sourceDriver, targetDriver] = await Promise.all([manager.rawDriver(sourceId), manager.rawDriver(targetId)]);
  if (!supportsTransaction(sourceDriver) || !supportsTransaction(targetDriver)) {
    return { sourceRows: 0, targetRows: 0, equal: false, error: '当前驱动不支持一致快照，无法可靠比较' };
  }

  const sourceTx = `compare-source-${crypto.randomUUID()}`;
  const sharedSnapshot = sourceId === targetId && source.engine === 'sqlite';
  const targetTx = sharedSnapshot ? sourceTx : `compare-target-${crypto.randomUUID()}`;
  try {
    await manager.beginTransaction(sourceTx, sourceId, { database: sourceDatabase, actor: 'user' });
    if (!sharedSnapshot) await manager.beginTransaction(targetTx, targetId, { database: targetDatabase, actor: 'user' });
    const sourceSnapshotSql = snapshotSql(source.engine);
    const targetSnapshotSql = snapshotSql(target.engine);
    await Promise.all([
      ...(sourceSnapshotSql ? [manager.query(sourceId, sourceSnapshotSql, { database: sourceDatabase, allowMulti: false, autoLimit: false, sessionId: sourceTx, actor: 'user' })] : []),
      ...(!sharedSnapshot && targetSnapshotSql ? [manager.query(targetId, targetSnapshotSql, { database: targetDatabase, allowMulti: false, autoLimit: false, sessionId: targetTx, actor: 'user' })] : []),
    ]);
    const query = async (sessionId: string, connectionId: string, database: string | undefined, sql: string, maxRows: number) => {
      const result = await manager.query(connectionId, sql, { database, maxRows, allowMulti: false, autoLimit: false, sessionId, actor: 'user' });
      const set = result.sets[0];
      if (!set || set.truncated) throw new Error('比较查询未返回完整结果');
      return set.rows;
    };
    if (dialectOf(source.engine) === 'mysql') {
      const isolation = await query(sourceTx, sourceId, sourceDatabase, 'SELECT @@transaction_isolation', 1);
      if (!String(isolation[0]?.[0] ?? '').toUpperCase().includes('REPEATABLE-READ')) throw new Error('MySQL 未启用 REPEATABLE READ，无法建立可靠比较快照');
    }
    if (!sharedSnapshot && dialectOf(target.engine) === 'mysql') {
      const isolation = await query(targetTx, targetId, targetDatabase, 'SELECT @@transaction_isolation', 1);
      if (!String(isolation[0]?.[0] ?? '').toUpperCase().includes('REPEATABLE-READ')) throw new Error('MySQL 未启用 REPEATABLE READ，无法建立可靠比较快照');
    }
    const [sourceCountRows, targetCountRows] = await Promise.all([
      query(sourceTx, sourceId, sourceDatabase, `SELECT COUNT(*) FROM ${tableRef(source, sourceTable)}`, 1),
      query(targetTx, targetId, targetDatabase, `SELECT COUNT(*) FROM ${tableRef(target, targetTable)}`, 1),
    ]);
    const sourceRows = Number(sourceCountRows[0]?.[0] ?? 0);
    const targetRows = Number(targetCountRows[0]?.[0] ?? 0);
    let equal = sourceRows === targetRows;
    let matched = 0;
    const targetSelect = targetNames.map((name) => quoteIdent(name, target.engine)).join(', ');
    const sourceKeyIndexes = sourcePrimary.map((column) => sourceColumns.findIndex((item) => item.name === column.name));
    if (sourceKeyIndexes.some((index) => index < 0)) throw new Error('源表主键列元数据不完整');

    for (let offset = 0; offset < sourceRows; offset += PAGE_ROWS) {
      const batch = await query(sourceTx, sourceId, sourceDatabase, pageSql(source, sourceTable, sourcePrimary, offset), PAGE_ROWS);
      if (!batch.length && offset < sourceRows) throw new Error('源表在一致快照中发生变化');
      for (let start = 0; start < batch.length; start += KEY_CHUNK_ROWS) {
        const chunk = batch.slice(start, start + KEY_CHUNK_ROWS);
        const conditions = chunk.map((row) => `(${sourcePrimary.map((_, index) => `${quoteIdent(targetKeyNames[index], target.engine)} = ${sqlLiteral(row[sourceKeyIndexes[index]], target.engine)}`).join(' AND ')})`);
        const rows = await query(
          targetTx,
          targetId,
          targetDatabase,
          `SELECT ${targetSelect} FROM ${tableRef(target, targetTable)} WHERE ${conditions.join(' OR ')}`,
          KEY_CHUNK_ROWS * 2 + 1,
        );
        for (const row of chunk) {
          const other = rows.find((candidate) => sourceKeyIndexes.every((index, keyIndex) => valuesEqual(row[index], candidate[sourceKeyIndexes[keyIndex]], sourceColumns[index].type, alignedTargetColumns[index].type)));
          if (!other) {
            equal = false;
            continue;
          }
          matched++;
          if (sourceColumns.some((_, index) => !valuesEqual(row[index], other[index], sourceColumns[index].type, alignedTargetColumns[index].type))) equal = false;
        }
      }
    }
    return { sourceRows, targetRows, equal: equal && matched === sourceRows };
  } finally {
    const sessions = sharedSnapshot ? [sourceTx] : [sourceTx, targetTx];
    await Promise.allSettled(sessions.map((sessionId) => manager.rollbackTransaction(sessionId)));
  }
}

export async function compareData(
  store: Store,
  manager: ConnectionManager,
  opts: { sourceId: string; sourceDatabase?: string; targetId?: string; targetDatabase?: string; tables?: string[] },
): Promise<DataCompareResult> {
  const source = store.getConnection(opts.sourceId);
  const target = store.getConnection(opts.targetId ?? opts.sourceId);
  if (!source || !target) throw new Error('连接不存在');
  const targetId = opts.targetId ?? opts.sourceId;
  const [sourceSchemas, targetSchemas] = await Promise.all([
    manager.schema(opts.sourceId, opts.sourceDatabase, true),
    manager.schema(targetId, opts.targetDatabase, true),
  ]);
  const sourceTables = sourceSchemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
  const targetTables = targetSchemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
  const selected = opts.tables?.length ? sourceTables.filter((table) => opts.tables!.includes(table.name)) : sourceTables;
  const rows: DataCompareRow[] = [];
  for (const srcTable of selected) {
    const tgtTable = targetTables.find((table) => table.name.toLowerCase() === srcTable.name.toLowerCase());
    if (!tgtTable) {
      rows.push({ table: srcTable.name, sourceRows: -1, targetRows: null, status: 'missing' });
      continue;
    }
    try {
      const compared = await compareTables(manager, opts.sourceId, opts.sourceDatabase, source, srcTable, targetId, opts.targetDatabase, target, tgtTable);
      rows.push({
        table: srcTable.name,
        sourceRows: compared.sourceRows,
        targetRows: compared.targetRows,
        status: compared.equal ? 'same' : 'different',
        ...(compared.error ? { error: compared.error } : {}),
      });
    } catch (err: any) {
      rows.push({ table: srcTable.name, sourceRows: -1, targetRows: null, status: 'error', error: err?.message ?? '比较失败' });
    }
  }
  return {
    source: opts.sourceDatabase ? `${source.name}/${opts.sourceDatabase}` : source.name,
    target: opts.targetDatabase ? `${target.name}/${opts.targetDatabase}` : target.name,
    rows,
    same: rows.filter((row) => row.status === 'same').length,
    different: rows.filter((row) => row.status === 'different').length,
    missing: rows.filter((row) => row.status === 'missing').length,
  };
}
