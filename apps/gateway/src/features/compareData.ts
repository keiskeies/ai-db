import { buildCount, quoteIdent as quoteIdentFor, type ConnectionConfig, type TableInfo } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';

export interface DataCompareRow {
  table: string;
  sourceRows: number;
  targetRows: number | null;
  status: 'same' | 'different' | 'missing' | 'error';
  fingerprint?: string;
  targetFingerprint?: string;
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

export async function compareData(
  store: Store,
  manager: ConnectionManager,
  opts: { sourceId: string; sourceDatabase?: string; targetId: string; targetDatabase?: string; tables?: string[] },
): Promise<DataCompareResult> {
  const source = store.getConnection(opts.sourceId);
  const target = store.getConnection(opts.targetId);
  if (!source || !target) throw new Error('连接不存在');
  const [sourceSchemas, targetSchemas] = await Promise.all([
    manager.schema(opts.sourceId, opts.sourceDatabase, true),
    manager.schema(opts.targetId, opts.targetDatabase, true),
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
      const count = async (connectionId: string, database: string | undefined, conn: typeof source, table: typeof srcTable) => {
        const batch = await manager.query(connectionId, buildCount(conn.engine, table.name, connectionSchema(conn, table)), {
          database,
          maxRows: 1,
          allowMulti: false,
          autoLimit: false,
          actor: 'user',
        });
        return Number(batch.sets[0]?.rows?.[0]?.[0] ?? 0);
      };
      const [sourceRows, targetRows] = await Promise.all([
        count(opts.sourceId, opts.sourceDatabase, source, srcTable),
        count(opts.targetId, opts.targetDatabase, target, tgtTable),
      ]);
      const pk = (srcTable.columns ?? []).filter((column) => column.primaryKey);
      let fingerprint: string | undefined;
      let targetFingerprint: string | undefined;
      if (sourceRows === targetRows && pk.length <= 2) {
        const fingerprintQuery = (conn: ConnectionConfig, table: TableInfo): string | null => {
          const cols = pk.length ? pk.map((column) => quoteIdentFor(column.name, conn.engine)) : [];
          if (!cols.length) return null;
          const ref = `${quoteIdentFor(table.name, conn.engine)}`;
          const key = cols.length === 1 ? cols[0] : `(${cols.join(', ')})`;
          return `SELECT COUNT(DISTINCT ${key}) AS distinct_keys, MIN(${key}) AS min_key, MAX(${key}) AS max_key FROM ${ref}`;
        };
        try {
          const srcSql = fingerprintQuery(source, srcTable);
          const tgtSql = fingerprintQuery(target, tgtTable);
          if (srcSql && tgtSql) {
            const [srcFp, tgtFp] = await Promise.all([
              manager.query(opts.sourceId, srcSql, { database: opts.sourceDatabase, maxRows: 1, allowMulti: false, autoLimit: false, actor: 'user' }),
              manager.query(opts.targetId, tgtSql, { database: opts.targetDatabase, maxRows: 1, allowMulti: false, autoLimit: false, actor: 'user' }),
            ]);
            fingerprint = JSON.stringify(srcFp.sets[0]?.rows?.[0] ?? []);
            targetFingerprint = JSON.stringify(tgtFp.sets[0]?.rows?.[0] ?? []);
          }
        } catch {
          /* fingerprint is best-effort */
        }
      }
      const status = sourceRows !== targetRows ? 'different' : fingerprint && targetFingerprint && fingerprint !== targetFingerprint ? 'different' : 'same';
      rows.push({ table: srcTable.name, sourceRows, targetRows, status, fingerprint, targetFingerprint });
    } catch (err: any) {
      rows.push({ table: srcTable.name, sourceRows: -1, targetRows: null, status: 'error', error: err?.message ?? '比较失败' });
    }
  }
  return {
    // 同一连接下比两个库时，只写连接名会显示成「local3306 → local3306」
    source: opts.sourceDatabase ? `${source.name}/${opts.sourceDatabase}` : source.name,
    target: opts.targetDatabase ? `${target.name}/${opts.targetDatabase}` : target.name,
    rows,
    same: rows.filter((row) => row.status === 'same').length,
    different: rows.filter((row) => row.status === 'different').length,
    missing: rows.filter((row) => row.status === 'missing').length,
  };
}
