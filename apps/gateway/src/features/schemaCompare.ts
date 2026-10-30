import { diffSchemas, type SchemaDiff } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';

export interface SchemaCompareResult extends SchemaDiff {
  source: { id: string; name: string; engine: string; database?: string };
  target: { id: string; name: string; engine: string; database?: string };
}

export interface SchemaCompareOptions {
  includeDrops?: boolean;
  tables?: string[];
}

export async function compareSchemas(
  store: Store,
  manager: ConnectionManager,
  sourceId: string,
  sourceDatabase: string | undefined,
  targetId: string,
  targetDatabase: string | undefined,
  options: SchemaCompareOptions = {},
): Promise<SchemaCompareResult> {
  const sourceConn = store.getConnection(sourceId);
  const targetConn = store.getConnection(targetId);
  if (!sourceConn || !targetConn) throw new Error('连接不存在');
  const [sourceSchemas, targetSchemas] = await Promise.all([
    manager.schema(sourceId, sourceDatabase, true),
    manager.schema(targetId, targetDatabase, true),
  ]);
  const selected = options.tables?.length ? new Set(options.tables.map((table) => table.toLowerCase())) : undefined;
  const sourceTables = sourceSchemas
    .flatMap((schema) => schema.tables)
    .filter((table) => !selected || selected.has(table.name.toLowerCase()));
  const targetTables = targetSchemas
    .flatMap((schema) => schema.tables)
    .filter((table) => !selected || selected.has(table.name.toLowerCase()));
  const diff = diffSchemas(sourceTables, targetTables, {
    targetEngine: targetConn.engine,
    targetSchema: connectionSchema(targetConn, targetTables[0]),
    includeDrops: options.includeDrops ?? true,
  });
  return {
    ...diff,
    source: { id: sourceConn.id, name: sourceConn.name, engine: sourceConn.engine, database: sourceDatabase ?? sourceConn.database },
    target: { id: targetConn.id, name: targetConn.name, engine: targetConn.engine, database: targetDatabase ?? targetConn.database },
  };
}
