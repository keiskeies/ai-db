import { buildCreateTable, buildInsert, buildSelectTable, buildTruncate } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema, q, tableRef } from './common';

export interface TransferTableResult {
  table: string;
  status: 'ok' | 'error' | 'skipped';
  rows: number;
  created: boolean;
  truncated: boolean;
  error?: string;
}

export interface TransferResult {
  results: TransferTableResult[];
  totalRows: number;
  createdTables: number;
}

export async function transferData(
  store: Store,
  manager: ConnectionManager,
  opts: {
    sourceId: string;
    sourceDatabase?: string;
    targetId: string;
    targetDatabase?: string;
    tables?: string[];
    mode?: 'append' | 'replace';
    createMissing?: boolean;
    limit?: number;
  },
): Promise<TransferResult> {
  const source = store.getConnection(opts.sourceId);
  const target = store.getConnection(opts.targetId);
  if (!source || !target) throw new Error('连接不存在');
  if (target.readonly) throw new Error('目标连接为只读，无法写入');
  const [sourceSchemas, targetSchemas] = await Promise.all([
    manager.schema(opts.sourceId, opts.sourceDatabase, true),
    manager.schema(opts.targetId, opts.targetDatabase, true),
  ]);
  const sourceTables = sourceSchemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
  const selected = opts.tables?.length ? sourceTables.filter((table) => opts.tables!.includes(table.name)) : sourceTables;
  if (!selected.length) throw new Error('没有可传输的表');
  const maxRows = Math.min(100000, Math.max(1, opts.limit ?? 100000));
  const results: TransferTableResult[] = [];

  for (const srcTable of selected) {
    let created = false;
    let truncated = false;
    try {
      let targetTable = targetSchemas.flatMap((schema) => schema.tables).find((table) => table.name.toLowerCase() === srcTable.name.toLowerCase());
      if (!targetTable) {
        if (opts.createMissing === false) throw new Error('目标缺少该表');
        const ddl = buildCreateTable(target.engine, {
          table: srcTable.name,
          columns: (srcTable.columns ?? []).map((column) => ({ ...column })),
          indexes: (srcTable.indexes ?? []).filter((index) => !index.primary).map((index) => ({ name: index.name, columns: index.columns, unique: index.unique })),
          schema: connectionSchema(target),
          comment: srcTable.comment,
        });
        await manager.query(opts.targetId, ddl, {
          database: opts.targetDatabase,
          allowMulti: true,
          autoLimit: false,
          actor: 'user',
        });
        created = true;
        manager.invalidate(opts.targetId);
        const refreshed = await manager.schema(opts.targetId, opts.targetDatabase, true);
        targetTable = refreshed.flatMap((schema) => schema.tables).find((table) => table.name.toLowerCase() === srcTable.name.toLowerCase());
        if (!targetTable) throw new Error('目标表创建后仍未找到');
      }

      const sourceSql = buildSelectTable(source.engine, srcTable.name, {
        schema: connectionSchema(source, srcTable),
      });
      const sourceBatch = await manager.query(opts.sourceId, sourceSql, {
        database: opts.sourceDatabase,
        maxRows,
        allowMulti: false,
        autoLimit: false,
        actor: 'user',
      });
      const set = sourceBatch.sets[0];
      if (!set) throw new Error('源表没有返回结果');
      const sourceColumns = set.columns.map((column) => column.name);
      const targetColumns = new Set((targetTable.columns ?? []).map((column) => column.name.toLowerCase()));
      const columns = targetColumns.size ? sourceColumns.filter((column) => targetColumns.has(column.toLowerCase())) : sourceColumns;
      if (!columns.length) throw new Error('源表与目标表没有同名列');
      const targetRef = tableRef(target, targetTable);

      if (opts.mode === 'replace') {
        const truncateSql = buildTruncate(target.engine, targetTable.name, connectionSchema(target, targetTable));
        await manager.query(opts.targetId, truncateSql, {
          database: opts.targetDatabase,
          allowMulti: false,
          autoLimit: false,
          actor: 'user',
        });
        truncated = true;
      }

      const identityCol = (targetTable.columns ?? []).find((column) => column.autoIncrement);
      const identityOn = target.engine === 'sqlserver' && identityCol && columns.some((column) => column.toLowerCase() === identityCol.name.toLowerCase());
      if (identityOn) {
        await manager.query(opts.targetId, `SET IDENTITY_INSERT ${targetRef} ON`, { database: opts.targetDatabase, actor: 'user' });
      }

      const indexes = columns.map((column) => sourceColumns.indexOf(column));
      let inserted = 0;
      try {
        for (let offset = 0; offset < set.rows.length; offset += 200) {
          const chunk = set.rows.slice(offset, offset + 200);
          const params: unknown[] = [];
          for (const row of chunk) for (const index of indexes) params.push(row[index]);
          const insertSql = buildInsert(target.engine, targetTable.name, columns, chunk.length, connectionSchema(target, targetTable));
          await manager.runParams(opts.targetId, insertSql, params, { database: opts.targetDatabase, actor: 'user' });
          inserted += chunk.length;
        }
      } finally {
        if (identityOn) {
          await manager.query(opts.targetId, `SET IDENTITY_INSERT ${targetRef} OFF`, { database: opts.targetDatabase, actor: 'user' }).catch(() => undefined);
        }
      }
      results.push({ table: srcTable.name, status: 'ok', rows: inserted, created, truncated });
    } catch (err: any) {
      results.push({ table: srcTable.name, status: 'error', rows: 0, created, truncated, error: err?.message ?? '传输失败' });
    }
  }
  return {
    results,
    totalRows: results.reduce((sum, result) => sum + result.rows, 0),
    createdTables: results.filter((result) => result.created).length,
  };
}
