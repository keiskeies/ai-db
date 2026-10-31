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

export type TransferPhase = 'create' | 'read' | 'truncate' | 'write';

export type TransferEvent =
  | { type: 'start'; mode: 'append' | 'replace'; tables: string[] }
  | { type: 'table-start'; table: string; index: number; total: number }
  | { type: 'phase-start'; table: string; phase: TransferPhase }
  | {
      type: 'phase-done';
      table: string;
      phase: TransferPhase;
      durationMs: number;
      rows?: number;
      columns?: number;
      skippedColumns?: number;
      batches?: number;
      limitReached?: boolean;
      ddl?: string;
    }
  | { type: 'progress'; table: string; rows: number; totalRows: number }
  | {
      type: 'table-done';
      table: string;
      result: TransferTableResult;
      durationMs: number;
      columns: number;
      skippedColumns: number;
      batches: number;
      limitReached: boolean;
    }
  | { type: 'table-error'; table: string; error: string; phase: TransferPhase; durationMs: number; rows: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; result: TransferResult; durationMs: number };

export class TransferAbortedError extends Error {
  code = 'TRANSFER_ABORTED';

  constructor() {
    super('传输已取消');
    this.name = 'TransferAbortedError';
  }
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
    onEvent?: (event: TransferEvent) => void;
    shouldAbort?: () => boolean;
  },
): Promise<TransferResult> {
  const source = store.getConnection(opts.sourceId);
  const target = store.getConnection(opts.targetId);
  if (!source || !target) throw new Error('连接不存在');
  if (target.readonly) throw new Error('目标连接为只读，无法写入');
  const emit = async (event: TransferEvent) => {
    opts.onEvent?.(event);
    // 同步驱动（SQLite/DuckDB 等）的批次不产生真实 I/O 等待，整段循环会停在微任务里，
    // SSE 要等到传输结束才出站。让出一个宏任务，进度才能逐条到达客户端。
    if (opts.onEvent) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const [sourceSchemas, targetSchemas] = await Promise.all([
    manager.schema(opts.sourceId, opts.sourceDatabase, true),
    manager.schema(opts.targetId, opts.targetDatabase, true),
  ]);
  const sourceTables = sourceSchemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
  const selected = opts.tables?.length ? sourceTables.filter((table) => opts.tables!.includes(table.name)) : sourceTables;
  if (!selected.length) throw new Error('没有可传输的表');
  const maxRows = Math.min(100000, Math.max(1, opts.limit ?? 100000));
  const mode = opts.mode === 'replace' ? 'replace' : 'append';
  const results: TransferTableResult[] = [];
  const started = Date.now();
  await emit({ type: 'start', mode, tables: selected.map((table) => table.name) });

  for (let index = 0; index < selected.length; index += 1) {
    if (opts.shouldAbort?.()) throw new TransferAbortedError();
    const srcTable = selected[index];
    const tableStarted = Date.now();
    let created = false;
    let truncated = false;
    let inserted = 0;
    let phase: TransferPhase = 'read';
    await emit({ type: 'table-start', table: srcTable.name, index, total: selected.length });
    try {
      let targetTable = targetSchemas.flatMap((schema) => schema.tables).find((table) => table.name.toLowerCase() === srcTable.name.toLowerCase());
      if (!targetTable) {
        if (opts.createMissing === false) throw new Error('目标缺少该表');
        phase = 'create';
        await emit({ type: 'phase-start', table: srcTable.name, phase });
        const createStarted = Date.now();
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
        await emit({
          type: 'phase-done',
          table: srcTable.name,
          phase,
          durationMs: Date.now() - createStarted,
          columns: srcTable.columns?.length ?? 0,
          ddl,
        });
        const refreshed = await manager.schema(opts.targetId, opts.targetDatabase, true);
        targetTable = refreshed.flatMap((schema) => schema.tables).find((table) => table.name.toLowerCase() === srcTable.name.toLowerCase());
        if (!targetTable) throw new Error('目标表创建后仍未找到');
      }

      phase = 'read';
      await emit({ type: 'phase-start', table: srcTable.name, phase });
      const readStarted = Date.now();
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
      const limitReached = set.rows.length >= maxRows;
      await emit({
        type: 'phase-done',
        table: srcTable.name,
        phase,
        durationMs: Date.now() - readStarted,
        rows: set.rows.length,
        columns: set.columns.length,
        limitReached,
      });
      const sourceColumns = set.columns.map((column) => column.name);
      const targetColumns = new Set((targetTable.columns ?? []).map((column) => column.name.toLowerCase()));
      const columns = targetColumns.size ? sourceColumns.filter((column) => targetColumns.has(column.toLowerCase())) : sourceColumns;
      if (!columns.length) throw new Error('源表与目标表没有同名列');
      const skippedColumns = sourceColumns.length - columns.length;
      const targetRef = tableRef(target, targetTable);

      if (mode === 'replace' && !created) {
        phase = 'truncate';
        await emit({ type: 'phase-start', table: srcTable.name, phase });
        const truncateStarted = Date.now();
        const truncateSql = buildTruncate(target.engine, targetTable.name, connectionSchema(target, targetTable));
        await manager.query(opts.targetId, truncateSql, {
          database: opts.targetDatabase,
          allowMulti: false,
          autoLimit: false,
          actor: 'user',
        });
        truncated = true;
        await emit({ type: 'phase-done', table: srcTable.name, phase, durationMs: Date.now() - truncateStarted });
      }

      const identityCol = (targetTable.columns ?? []).find((column) => column.autoIncrement);
      const identityOn = target.engine === 'sqlserver' && identityCol && columns.some((column) => column.toLowerCase() === identityCol.name.toLowerCase());
      if (identityOn) {
        await manager.query(opts.targetId, `SET IDENTITY_INSERT ${targetRef} ON`, { database: opts.targetDatabase, actor: 'user' });
      }

      const indexes = columns.map((column) => sourceColumns.indexOf(column));
      phase = 'write';
      await emit({ type: 'phase-start', table: srcTable.name, phase });
      const writeStarted = Date.now();
      let batches = 0;
      let lastProgressAt = 0;
      try {
        for (let offset = 0; offset < set.rows.length; offset += 200) {
          if (opts.shouldAbort?.()) throw new TransferAbortedError();
          const chunk = set.rows.slice(offset, offset + 200);
          const params: unknown[] = [];
          for (const row of chunk) for (const index of indexes) params.push(row[index]);
          const insertSql = buildInsert(target.engine, targetTable.name, columns, chunk.length, connectionSchema(target, targetTable));
          await manager.runParams(opts.targetId, insertSql, params, { database: opts.targetDatabase, actor: 'user' });
          inserted += chunk.length;
          batches += 1;
          const now = Date.now();
          if (inserted >= set.rows.length || now - lastProgressAt >= 80) {
            lastProgressAt = now;
            await emit({ type: 'progress', table: srcTable.name, rows: inserted, totalRows: set.rows.length });
          }
        }
      } finally {
        if (identityOn) {
          await manager.query(opts.targetId, `SET IDENTITY_INSERT ${targetRef} OFF`, { database: opts.targetDatabase, actor: 'user' }).catch(() => undefined);
        }
      }
      await emit({
        type: 'phase-done',
        table: srcTable.name,
        phase,
        durationMs: Date.now() - writeStarted,
        rows: inserted,
        batches,
      });
      const result: TransferTableResult = { table: srcTable.name, status: 'ok', rows: inserted, created, truncated };
      results.push(result);
      await emit({
        type: 'table-done',
        table: srcTable.name,
        result,
        durationMs: Date.now() - tableStarted,
        columns: columns.length,
        skippedColumns,
        batches,
        limitReached,
      });
    } catch (err: any) {
      if (err instanceof TransferAbortedError) throw err;
      const message = err?.message ?? '传输失败';
      results.push({ table: srcTable.name, status: 'error', rows: inserted, created, truncated, error: message });
      await emit({ type: 'table-error', table: srcTable.name, error: message, phase, durationMs: Date.now() - tableStarted, rows: inserted });
    }
  }
  const result = {
    results,
    totalRows: results.reduce((sum, item) => sum + item.rows, 0),
    createdTables: results.filter((item) => item.created).length,
  };
  await emit({ type: 'done', result, durationMs: Date.now() - started });
  return result;
}
