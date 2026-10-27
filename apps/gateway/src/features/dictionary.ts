import { buildCreateTable, buildCreateIndex, type ColumnDef, type IndexDef } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';

export interface DictionaryResult {
  tableCount: number;
  columnCount: number;
  markdown: string;
  sql: string;
  json: unknown;
}

export async function buildDictionary(store: Store, manager: ConnectionManager, connectionId: string, database?: string): Promise<DictionaryResult> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const schemas = await manager.schema(connectionId, database, true);
  const markdown: string[] = [`# ${conn.name} 数据字典`, '', `- 引擎：${conn.engine}`, `- 数据库：${database ?? conn.database ?? ''}`, `- 生成时间：${new Date().toISOString()}`, ''];
  const ddl: string[] = [`-- ${conn.name} (${conn.engine}) ${database ?? conn.database ?? ''}`, ''];
  const json: Array<{ database: string; tables: unknown[] }> = [];
  let tableCount = 0;
  let columnCount = 0;

  for (const schema of schemas) {
    markdown.push(`## ${schema.name}`, '');
    const dbJson: unknown[] = [];
    for (const table of schema.tables) {
      tableCount++;
      columnCount += table.columns?.length ?? 0;
      markdown.push(`### ${table.name}${table.type === 'view' ? '（视图）' : ''}${table.comment ? ` — ${table.comment}` : ''}`, '');
      markdown.push('| 列 | 类型 | 可空 | 默认 | 主键 | 说明 |', '| --- | --- | --- | --- | --- | --- |');
      for (const column of table.columns ?? []) {
        markdown.push(`| ${column.name} | ${column.type} | ${column.nullable ? 'YES' : 'NO'} | ${column.defaultValue ?? ''} | ${column.primaryKey ? 'PK' : ''} | ${column.comment ?? ''} |`);
      }
      markdown.push('');
      if (table.indexes?.length) {
        markdown.push('索引：' + table.indexes.map((index) => `${index.name}(${index.columns.join(', ')})${index.unique ? ' UNIQUE' : ''}`).join('；'), '');
      }
      if (table.foreignKeys?.length) {
        markdown.push(
          '外键：' + table.foreignKeys.map((fk) => `${fk.columns.join(',')} → ${fk.refTable}(${fk.refColumns.join(',')})`).join('；'),
          '',
        );
      }
      if (table.type === 'table') {
        const columns: ColumnDef[] = (table.columns ?? []).map((column) => ({ ...column }));
        const indexes: IndexDef[] = (table.indexes ?? []).filter((index) => !index.primary).map((index) => ({ name: index.name, columns: index.columns, unique: index.unique }));
        ddl.push(
          buildCreateTable(conn.engine, {
            table: table.name,
            columns,
            indexes: [],
            schema: connectionSchema(conn, table),
            comment: table.comment,
          }) + ';',
        );
        for (const index of indexes) {
          ddl.push(buildCreateIndex(conn.engine, table.name, index, connectionSchema(conn, table)) + ';');
        }
        ddl.push('');
      }
      dbJson.push({
        name: table.name,
        type: table.type,
        comment: table.comment,
        columns: table.columns,
        indexes: table.indexes,
        foreignKeys: table.foreignKeys,
      });
    }
    json.push({ database: schema.name, tables: dbJson });
  }

  return { tableCount, columnCount, markdown: markdown.join('\n'), sql: ddl.join('\n'), json };
}
