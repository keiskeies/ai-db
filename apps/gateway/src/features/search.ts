import type { ConnectionConfig, TableInfo } from '@aidb/core';
import { buildSelectTable, quoteLiteral } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema, q, tableRef, textColumn } from './common';

export interface ObjectMatch {
  kind: 'table' | 'view' | 'column';
  table: string;
  column?: string;
  detail?: string;
}

export interface DataMatch {
  table: string;
  columns: string[];
  rows: unknown[][];
}

export interface SearchResult {
  query: string;
  scope: 'objects' | 'data' | 'all';
  objects: ObjectMatch[];
  data: DataMatch[];
  scannedTables: number;
  truncated: boolean;
}

export async function searchDatabase(
  store: Store,
  manager: ConnectionManager,
  connectionId: string,
  database: string | undefined,
  query: string,
  scope: 'objects' | 'data' | 'all' = 'all',
): Promise<SearchResult> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const needle = query.trim();
  if (!needle) throw new Error('请输入搜索内容');
  const schemas = await manager.schema(connectionId, database);
  const tables = schemas.flatMap((schema) => schema.tables);
  const lower = needle.toLowerCase();
  const objects: ObjectMatch[] = [];

  if (scope !== 'data') {
    for (const table of tables) {
      if (table.name.toLowerCase().includes(lower) || (table.comment ?? '').toLowerCase().includes(lower)) {
        objects.push({ kind: table.type === 'view' ? 'view' : 'table', table: table.name, detail: table.comment });
      }
      for (const column of table.columns ?? []) {
        if (column.name.toLowerCase().includes(lower) || (column.comment ?? '').toLowerCase().includes(lower)) {
          objects.push({ kind: 'column', table: table.name, column: column.name, detail: column.type });
        }
      }
    }
  }

  const data: DataMatch[] = [];
  let scanned = 0;
  if (scope !== 'objects') {
    for (const table of tables) {
      if (table.type !== 'table') continue;
      if (scanned >= 25) break;
      const columns = (table.columns ?? []).filter((column) => textColumn(column.type)).slice(0, 6);
      if (!columns.length) continue;
      scanned++;
      const where = columns.map((column) => `${q(conn, column.name)} LIKE ${quoteLiteral(`%${needle}%`)}`).join(' OR ');
      const sql = buildSelectTable(conn.engine, table.name, { schema: connectionSchema(conn, table), where, limit: 5 });
      try {
        const batch = await manager.query(connectionId, sql, {
          database,
          maxRows: 5,
          allowMulti: false,
          autoLimit: false,
          actor: 'user',
          timeoutMs: 15000,
        });
        const set = batch.sets[0];
        if (set?.rows.length) {
          data.push({ table: table.name, columns: set.columns.map((column) => column.name), rows: set.rows });
        }
      } catch {
        /* search is best-effort across heterogeneous engines */
      }
    }
  }

  return {
    query: needle,
    scope,
    objects: objects.slice(0, 200),
    data,
    scannedTables: scanned,
    truncated: objects.length > 200,
  };
}

export async function previewTable(manager: ConnectionManager, conn: ConnectionConfig, table: TableInfo, database: string | undefined) {
  const sql = buildSelectTable(conn.engine, table.name, { schema: connectionSchema(conn, table), limit: 5 });
  const batch = await manager.query(conn.id, sql, { database, maxRows: 5, allowMulti: false, autoLimit: false, actor: 'user' });
  return batch.sets[0];
}
