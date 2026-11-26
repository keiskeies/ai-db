import { buildCreateTable, buildInsert, buildSelectTable, engineMeta, type Engine } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { supportsRowStream, supportsTransaction, type RowBatch } from '../drivers/types';
import { throwIfAborted } from '../drivers/timeout';
import { connectionSchema, q, tableRef } from './common';

/**
 * 每次 INSERT 的绑定参数上限（mssql 2100、oracle 65535），单行绑定量为列数。
 * 固定 200 行在宽表（>10 列）上会超限，按引擎动态折算批次。
 */
export function insertBatchSize(engine: Engine, columnCount: number): number {
  const perRow = Math.max(1, columnCount);
  if (engine === 'sqlserver') return Math.min(200, Math.max(1, Math.floor(2000 / perRow)));
  if (engine === 'oracle') return Math.min(200, Math.max(1, Math.floor(60000 / perRow)));
  return 200;
}

export interface TransferTableResult {
  table: string;
  status: 'ok' | 'error' | 'skipped';
  rows: number;
  created: boolean;
  truncated: boolean;
  error?: string;
  code?: string;
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

/** 批写入失败时带出源表行区间，让用户能直接定位坏行。 */
export class TransferBatchError extends Error {
  code = 'TRANSFER_BATCH_ERROR';
  from: number;
  to: number;
  cause: Error;

  constructor(from: number, to: number, cause: Error) {
    super(`第 ${from}-${to} 行写入失败：${cause?.message ?? cause}`);
    this.name = 'TransferBatchError';
    this.from = from;
    this.to = to;
    this.cause = cause;
  }
}

/**
 * 按表顺序复制数据。replace 模式的事务只覆盖当前表，不提供跨表全局原子性；
 * 已完成提交的表不会因后续表失败或取消而回滚。
 */
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
    executionId?: string;
    signal?: AbortSignal;
  },
): Promise<TransferResult> {
  const checkAbort = () => {
    if (opts.shouldAbort?.()) throw new TransferAbortedError();
    throwIfAborted(opts.signal);
  };
  const isAbort = (err: unknown) => (
    err instanceof TransferAbortedError
    || (err as { code?: string })?.code === 'ABORTED'
    || opts.shouldAbort?.() === true
    || opts.signal?.aborted === true
  );
  checkAbort();
  const source = store.getConnection(opts.sourceId);
  const target = store.getConnection(opts.targetId);
  if (!source || !target) throw new Error('连接不存在');
  if (target.readonly) throw new Error('目标连接为只读，无法写入');
  const emit = async (event: TransferEvent) => {
    checkAbort();
    opts.onEvent?.(event);
    // 同步驱动（SQLite/DuckDB 等）的批次不产生真实 I/O 等待，整段循环会停在微任务里，
    // SSE 要等到传输结束才出站。让出一个宏任务，进度才能逐条到达客户端。
    if (opts.onEvent) await new Promise<void>((resolve) => setImmediate(resolve));
    checkAbort();
  };
  const [sourceSchemas, targetSchemas] = await Promise.all([
    manager.schema(opts.sourceId, opts.sourceDatabase, true),
    manager.schema(opts.targetId, opts.targetDatabase, true),
  ]);
  checkAbort();
  const sourceTables = sourceSchemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
  const selected = opts.tables?.length ? sourceTables.filter((table) => opts.tables!.includes(table.name)) : sourceTables;
  if (!selected.length) throw new Error('没有可传输的表');
  const maxRows = Math.min(100000, Math.max(1, opts.limit ?? 100000));
  const mode = opts.mode === 'replace' ? 'replace' : 'append';
  const results: TransferTableResult[] = [];
  const started = Date.now();
  await emit({ type: 'start', mode, tables: selected.map((table) => table.name) });

  for (let index = 0; index < selected.length; index += 1) {
    checkAbort();
    const srcTable = selected[index];
    const tableStarted = Date.now();
    let created = false;
    let truncated = false;
    let inserted = 0;
    let phase: TransferPhase = 'read';
    let batches: AsyncGenerator<RowBatch> | undefined;
    let useTx = false;
    let txId = `transfer-${Date.now()}-${index}-${srcTable.name}`;
    const runOpts = (extra: Record<string, unknown> = {}) => ({
      database: opts.targetDatabase,
      actor: 'user' as const,
      executionId: opts.executionId,
      signal: opts.signal,
      ...extra,
      ...(useTx ? { sessionId: txId, requireTransaction: true } : {}),
    });
    let txBeginAttempted = false;
    let committed = false;
    let txRollbackAttempted = false;
    const rollbackTx = async (context: '取消' | '失败') => {
      if (!txBeginAttempted || committed || txRollbackAttempted) return;
      txRollbackAttempted = true;
      try {
        await manager.rollbackTransaction(txId, 'user');
        truncated = false;
        created = false;
      } catch (rollbackErr: any) {
        throw Object.assign(new Error(`传输${context}后回滚失败：${rollbackErr?.message ?? rollbackErr}`), { code: 'TRANSFER_ROLLBACK_FAILED', cause: rollbackErr });
      }
    };
    await emit({ type: 'table-start', table: srcTable.name, index, total: selected.length });
    try {
      let targetTable = targetSchemas.flatMap((schema) => schema.tables).find((table) => table.name.toLowerCase() === srcTable.name.toLowerCase());
      if (!targetTable) {
        if (opts.createMissing === false) throw new Error('目标缺少该表');
        // 新建 SQL Server 身份列表时，连 CREATE 也放进同一事务；未提交结构不会
        // 被池化 schema 查询看到，因此直接用已校验的源列元数据，避免另开连接刷新。
        const createsIdentityTable = target.engine === 'sqlserver' && (srcTable.columns ?? []).some((column) => column.autoIncrement);
        if (createsIdentityTable) {
          let canCreateTx = false;
          try {
            canCreateTx = supportsTransaction(await manager.rawDriver(opts.targetId));
          } catch {
            // 与下方一致：能力不足时 fail closed，绝不先建表再半途写入。
          }
          checkAbort();
          if (!canCreateTx) {
            throw Object.assign(new Error(`${engineMeta(target.engine).label} 不支持原子身份列传输，已拒绝写入`), { code: 'ATOMIC_TRANSFER_UNSUPPORTED' });
          }
          useTx = true;
          checkAbort();
          txBeginAttempted = true;
          await manager.beginTransaction(txId, opts.targetId, runOpts());
        }
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
        await manager.query(opts.targetId, ddl, runOpts({ allowMulti: true, autoLimit: false }));
        checkAbort();
        created = true;
        await emit({
          type: 'phase-done',
          table: srcTable.name,
          phase,
          durationMs: Date.now() - createStarted,
          columns: srcTable.columns?.length ?? 0,
          ddl,
        });
        if (createsIdentityTable) {
          targetTable = { ...srcTable, schema: connectionSchema(target) };
        } else {
          const refreshed = await manager.schema(opts.targetId, opts.targetDatabase, true);
          checkAbort();
          targetTable = refreshed.flatMap((schema) => schema.tables).find((table) => table.name.toLowerCase() === srcTable.name.toLowerCase());
          if (!targetTable) throw new Error('目标表创建后仍未找到');
        }
      }

      phase = 'read';
      await emit({ type: 'phase-start', table: srcTable.name, phase });
      const readStarted = Date.now();
      const sourceSql = buildSelectTable(source.engine, srcTable.name, {
        schema: connectionSchema(source, srcTable),
      });
      // 流式驱动逐批读源表：整表 LONGTEXT 不再一次性进堆（maxRows 只是取回后 slice，
      // 挡不住驱动层全量缓冲）。不支持流式的驱动保持整批读的老路径。
      const sourceDriver = await manager.rawDriver(opts.sourceId);
      const streamed = supportsRowStream(sourceDriver);
      batches = streamed
        ? sourceDriver.iterateRows(sourceSql, [], { database: opts.sourceDatabase, maxRows, signal: opts.signal })
        : (async function* (): AsyncGenerator<RowBatch> {
            const sourceBatch = await manager.query(opts.sourceId, sourceSql, {
              database: opts.sourceDatabase,
              maxRows,
              allowMulti: false,
              autoLimit: false,
              actor: 'user',
              executionId: opts.executionId,
              signal: opts.signal,
            });
            checkAbort();
            const set = sourceBatch.sets[0];
            if (!set) throw new Error('源表没有返回结果');
            yield { columns: set.columns, rows: set.rows };
          })();
      const activeBatches = batches;
      let readFailed = false;
      try {
        const first = await activeBatches.next();
        checkAbort();
        const firstBatch: RowBatch = first.done ? { columns: [], rows: [] } : first.value;
        const sourceColumns = firstBatch.columns.map((column) => column.name);
        await emit({
          type: 'phase-done',
          table: srcTable.name,
          phase,
          durationMs: Date.now() - readStarted,
          rows: streamed ? undefined : firstBatch.rows.length,
          columns: sourceColumns.length,
          // 流式读在首批时还不知道会不会读满上限，limitReached 由 table-done 给出。
          limitReached: streamed ? undefined : firstBatch.rows.length >= maxRows,
        });
        const targetColumnNames = new Map((targetTable.columns ?? []).map((column) => [column.name.toLowerCase(), column.name]));
        const columns = targetColumnNames.size ? sourceColumns.filter((column) => targetColumnNames.has(column.toLowerCase())) : sourceColumns;
        if (!columns.length) throw new Error('源表与目标表没有同名列');
        const insertColumns = columns.map((column) => targetColumnNames.get(column.toLowerCase()) ?? column);
        const skippedColumns = sourceColumns.length - columns.length;
        const targetRef = tableRef(target, targetTable);

        // replace 模式把 DELETE + INSERT 放同一事务里；SQL Server 显式写入身份列时
        // 也必须固定会话，否则池化请求可能把 SET/INSERT/OFF 拆到不同物理连接。
        let canTx = false;
        try {
          canTx = supportsTransaction(await manager.rawDriver(opts.targetId));
        } catch {
          // 目标连接不可用会在执行时报错，这里先按不可事务处理。
        }
        checkAbort();
        const identityCol = (targetTable.columns ?? []).find((column) => column.autoIncrement);
        const identityOn = target.engine === 'sqlserver' && Boolean(identityCol) && columns.some((column) => column.toLowerCase() === identityCol!.name.toLowerCase());
        if (mode === 'replace' && !created && !canTx) {
          throw Object.assign(new Error(`${engineMeta(target.engine).label} 不支持原子替换，请先创建空目标表或使用原生事务工具`), { code: 'ATOMIC_REPLACE_UNSUPPORTED' });
        }
        if (identityOn && !canTx) {
          throw Object.assign(new Error(`${engineMeta(target.engine).label} 不支持原子身份列传输，已拒绝写入`), { code: 'ATOMIC_TRANSFER_UNSUPPORTED' });
        }
        useTx = txBeginAttempted || (mode === 'replace' && !created) || identityOn;

        try {
          if (useTx && !txBeginAttempted) {
            checkAbort();
            txBeginAttempted = true;
            await manager.beginTransaction(txId, opts.targetId, runOpts());
          }
          checkAbort();
          if (mode === 'replace' && !created) {
            phase = 'truncate';
            await emit({ type: 'phase-start', table: srcTable.name, phase });
            const truncateStarted = Date.now();
            await manager.query(opts.targetId, `DELETE FROM ${targetRef}`, runOpts({ allowMulti: false, autoLimit: false }));
            checkAbort();
            truncated = true;
            await emit({ type: 'phase-done', table: srcTable.name, phase, durationMs: Date.now() - truncateStarted });
          }

          let identityInsertAttempted = false;
          let writeStarted = 0;
          let batchCount = 0;
          let limitReached = false;
          try {
            if (identityOn) {
              // ON 的确认也可能丢失；只要尝试过就在 finally 里补 OFF，不能假定失败即未生效。
              identityInsertAttempted = true;
              checkAbort();
              await manager.query(opts.targetId, `SET IDENTITY_INSERT ${targetRef} ON`, runOpts({ allowMulti: false, autoLimit: false }));
              checkAbort();
            }

            const indexes = columns.map((column) => sourceColumns.indexOf(column));
            const typeOf = new Map((targetTable.columns ?? []).map((c) => [c.name.toLowerCase(), c.type]));
            phase = 'write';
            writeStarted = Date.now();
            await emit({ type: 'phase-start', table: srcTable.name, phase });
            let lastProgressAt = 0;
            const batchSize = insertBatchSize(target.engine, columns.length);
            let pending = firstBatch.rows;
            let iteratorDone = first.done;
            let rowOffset = 0;
            for (;;) {
              checkAbort();
              while (pending.length) {
                checkAbort();
                const chunk = pending.slice(0, batchSize);
                pending = pending.slice(batchSize);
                const params: unknown[] = [];
                for (const row of chunk) {
                  for (const column of columns) {
                    const value = row[indexes[columns.indexOf(column)]];
                    // 空串按目标列类型归一：字符类保留 ''，日期/数字类按 NULL 传递，
                    // 否则 mssql 会推成 varchar(1) 在日期/数字列上直接报错。
                    if (value === '') params.push(/char|text|json|uuid|blob/.test(String(typeOf.get(column.toLowerCase()) ?? '').toLowerCase()) ? '' : null);
                    else params.push(value ?? null);
                  }
                }
                const insertSql = buildInsert(target.engine, targetTable.name, insertColumns, chunk.length, connectionSchema(target, targetTable));
                try {
                  await manager.runParams(opts.targetId, insertSql, params, runOpts());
                } catch (err: any) {
                  // 失败下钻到具体批区间：整表报错时用户不知道坏在哪一行。
                  throw new TransferBatchError(rowOffset + 1, rowOffset + chunk.length, err);
                }
                rowOffset += chunk.length;
                inserted += chunk.length;
                batchCount += 1;
                const now = Date.now();
                if (now - lastProgressAt >= 80) {
                  lastProgressAt = now;
                  // 流式读完整表前总数未知：totalRows 给 0，UI 只显示已写行数。
                  await emit({ type: 'progress', table: srcTable.name, rows: inserted, totalRows: streamed ? 0 : firstBatch.rows.length });
                }
              }
              if (iteratorDone) break;
              let next: IteratorResult<RowBatch>;
              try {
                next = await activeBatches.next();
              } catch (err) {
                readFailed = true;
                throw err;
              }
              iteratorDone = Boolean(next.done);
              pending = next.done ? [] : next.value.rows;
            }
            limitReached = inserted >= maxRows;
            if (streamed) {
              // 流式读绕过 manager.query，补记查询历史，审计口径与老路径一致。
              store.addHistory({
                connectionId: opts.sourceId,
                database: opts.sourceDatabase ?? source.database,
                sql: sourceSql,
                status: 'ok',
                durationMs: Date.now() - readStarted,
                rowCount: inserted,
              });
            }
            await emit({ type: 'progress', table: srcTable.name, rows: inserted, totalRows: inserted });
          } finally {
            if (identityInsertAttempted) {
              // 清理语句不能继承已触发的 signal/executionId，否则 manager 会在执行前拒绝 OFF。
              await manager.query(opts.targetId, `SET IDENTITY_INSERT ${targetRef} OFF`, {
                database: opts.targetDatabase,
                actor: 'user',
                sessionId: txId,
                requireTransaction: true,
                allowMulti: false,
                autoLimit: false,
              });
            }
          }

          if (useTx) {
            checkAbort();
            await manager.commitTransaction(txId, 'user');
            committed = true;
          }
          await emit({
            type: 'phase-done',
            table: srcTable.name,
            phase,
            durationMs: Date.now() - writeStarted,
            rows: inserted,
            batches: batchCount,
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
            batches: batchCount,
            limitReached,
          });
        } catch (err: any) {
          if (isAbort(err)) {
            await rollbackTx('取消');
            if (committed) results.push({ table: srcTable.name, status: 'ok', rows: inserted, created, truncated });
            throw err instanceof TransferAbortedError ? err : new TransferAbortedError();
          }
          await rollbackTx('失败');
          const message = err?.message ?? '传输失败';
          results.push({ table: srcTable.name, status: 'error', rows: inserted, created, truncated, error: message, ...(typeof err?.code === 'string' ? { code: err.code } : {}) });
          await emit({ type: 'table-error', table: srcTable.name, error: message, phase, durationMs: Date.now() - tableStarted, rows: inserted });
        }
      } catch (err: any) {
        if (err?.code === 'TRANSFER_ROLLBACK_FAILED') throw err;
        if (isAbort(err)) throw err instanceof TransferAbortedError ? err : new TransferAbortedError();
        if (streamed && readFailed) {
          store.addHistory({
            connectionId: opts.sourceId,
            database: opts.sourceDatabase ?? source.database,
            sql: sourceSql,
            status: 'error',
            durationMs: Date.now() - readStarted,
            error: err?.message ?? '读取失败',
          });
        }
        const message = err?.message ?? '传输失败';
        results.push({ table: srcTable.name, status: 'error', rows: inserted, created, truncated, error: message, ...(typeof err?.code === 'string' ? { code: err.code } : {}) });
        await emit({ type: 'table-error', table: srcTable.name, error: message, phase, durationMs: Date.now() - tableStarted, rows: inserted });
      }
    } catch (err: any) {
      if (err?.code === 'TRANSFER_ROLLBACK_FAILED') throw err;
      if (isAbort(err)) throw err instanceof TransferAbortedError ? err : new TransferAbortedError();
      const message = err?.message ?? '传输失败';
      results.push({ table: srcTable.name, status: 'error', rows: inserted, created, truncated, error: message, ...(typeof err?.code === 'string' ? { code: err.code } : {}) });
      await emit({ type: 'table-error', table: srcTable.name, error: message, phase, durationMs: Date.now() - tableStarted, rows: inserted });
    } finally {
      // beginTransaction 的确认丢失也可能已开启事务；任何退出路径都先尝试回滚，
      // 再关闭源端迭代器，避免取消/异常留下目标会话或流式连接。
      try {
        await rollbackTx('失败');
      } finally {
        if (batches) await batches.return(undefined).catch(() => undefined);
      }
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
