import type { Engine, TableInfo } from '../types';
import {
  buildAlterTable,
  buildCreateIndex,
  buildCreateTable,
  buildDropIndex,
  buildDropObject,
  normalizeColumnType,
  type AlterOp,
  type IndexDef,
} from '../sql/ddl';
import { defaultIndexName } from '../sql/ddl';

export type SchemaChangeKind =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column'
  | 'add_index'
  | 'drop_index';

export interface SchemaChange {
  kind: SchemaChangeKind;
  table: string;
  column?: string;
  detail: string;
  sql?: string;
  destructive?: boolean;
}

export interface SchemaTableDiff {
  name: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  changes: SchemaChange[];
  sql: string[];
}

export interface SchemaDiff {
  sourceTables: number;
  targetTables: number;
  tables: SchemaTableDiff[];
  sql: string[];
  summary: { added: number; removed: number; changed: number; unchanged: number; statements: number };
}

export interface DiffOptions {
  targetEngine: Engine;
  targetSchema?: string;
  includeDrops?: boolean;
}

function typeSignature(engine: Engine, type: string): string {
  return normalizeColumnType(engine, type).replace(/\s+/g, ' ').trim().toUpperCase();
}

function indexSignature(index: { columns: string[]; unique?: boolean }): string {
  return `${index.columns.join('|')}|${index.unique ? '1' : '0'}`;
}

export function diffSchemas(source: TableInfo[], target: TableInfo[], options: DiffOptions): SchemaDiff {
  const { targetEngine, targetSchema, includeDrops = true } = options;
  const targetMap = new Map(target.map((table) => [table.name.toLowerCase(), table]));
  const sourceMap = new Map(source.map((table) => [table.name.toLowerCase(), table]));
  const tables: SchemaTableDiff[] = [];
  const allSql: string[] = [];

  for (const srcTable of source) {
    if (srcTable.type !== 'table') continue;
    const tgtTable = targetMap.get(srcTable.name.toLowerCase());
    if (!tgtTable) {
      const ddl = buildCreateTable(targetEngine, {
        table: srcTable.name,
        columns: (srcTable.columns ?? []).map((column) => ({ ...column })),
        indexes: (srcTable.indexes ?? []).filter((index) => !index.primary).map((index) => ({ name: index.name, columns: index.columns, unique: index.unique })),
        schema: targetSchema,
        comment: srcTable.comment,
      });
      const statements = ddl.split(';\n').map((statement) => statement.trim()).filter(Boolean).map((statement) => `${statement};`);
      const change: SchemaChange = {
        kind: 'create_table',
        table: srcTable.name,
        detail: `目标缺少表 ${srcTable.name}（${srcTable.columns?.length ?? 0} 列）`,
        sql: statements.join('\n'),
      };
      tables.push({ name: srcTable.name, status: 'added', changes: [change], sql: statements });
      allSql.push(...statements);
      continue;
    }

    const changes: SchemaChange[] = [];
    const sql: string[] = [];
    const srcColumns = srcTable.columns ?? [];
    const tgtColumns = tgtTable.columns ?? [];
    const tgtColumnMap = new Map(tgtColumns.map((column) => [column.name.toLowerCase(), column]));
    const srcColumnNames = new Set(srcColumns.map((column) => column.name.toLowerCase()));

    for (const srcColumn of srcColumns) {
      const tgtColumn = tgtColumnMap.get(srcColumn.name.toLowerCase());
      if (!tgtColumn) {
        const statements = buildAlterTable(targetEngine, srcTable.name, [{ op: 'add_column', column: { ...srcColumn } }], targetSchema);
        statements.forEach((statement) => {
          changes.push({ kind: 'add_column', table: srcTable.name, column: srcColumn.name, detail: `新增列 ${srcColumn.name} ${srcColumn.type}`, sql: statement });
          sql.push(statement);
        });
        continue;
      }
      const typeChanged = typeSignature(targetEngine, srcColumn.type) !== typeSignature(targetEngine, tgtColumn.type);
      const nullChanged = srcColumn.nullable !== tgtColumn.nullable;
      const defaultChanged = (srcColumn.defaultValue ?? null) !== (tgtColumn.defaultValue ?? null);
      if (typeChanged || nullChanged || defaultChanged) {
        const operations: AlterOp[] = [
          {
            op: 'alter_column',
            name: srcColumn.name,
            type: srcColumn.type,
            nullable: srcColumn.nullable,
            defaultValue: srcColumn.defaultValue ?? null,
          },
        ];
        try {
          const statements = buildAlterTable(targetEngine, srcTable.name, operations, targetSchema);
          statements.forEach((statement) => {
            changes.push({
              kind: 'alter_column',
              table: srcTable.name,
              column: srcColumn.name,
              detail: `修改列 ${srcColumn.name}：${[
                typeChanged ? `${tgtColumn.type} → ${srcColumn.type}` : '',
                nullChanged ? `nullable ${tgtColumn.nullable} → ${srcColumn.nullable}` : '',
                defaultChanged ? `default ${tgtColumn.defaultValue ?? 'NULL'} → ${srcColumn.defaultValue ?? 'NULL'}` : '',
              ]
                .filter(Boolean)
                .join('；')}`,
              sql: statement,
            });
            sql.push(statement);
          });
        } catch (err: any) {
          changes.push({ kind: 'alter_column', table: srcTable.name, column: srcColumn.name, detail: `无法自动生成变更：${err.message}` });
        }
      }
    }

    for (const tgtColumn of tgtColumns) {
      if (srcColumnNames.has(tgtColumn.name.toLowerCase())) continue;
      if (!includeDrops) continue;
      const statements = buildAlterTable(targetEngine, srcTable.name, [{ op: 'drop_column', name: tgtColumn.name }], targetSchema);
      statements.forEach((statement) => {
        changes.push({ kind: 'drop_column', table: srcTable.name, column: tgtColumn.name, detail: `目标多出列 ${tgtColumn.name}`, sql: statement, destructive: true });
        sql.push(statement);
      });
    }

    const srcIndexes = (srcTable.indexes ?? []).filter((index) => !index.primary && !/^sqlite_autoindex_/i.test(index.name));
    const tgtIndexes = (tgtTable.indexes ?? []).filter((index) => !index.primary && !/^sqlite_autoindex_/i.test(index.name));
    const tgtIndexBySig = new Map(tgtIndexes.map((index) => [indexSignature(index), index]));
    const srcIndexBySig = new Map(srcIndexes.map((index) => [indexSignature(index), index]));

    for (const srcIndex of srcIndexes) {
      if (tgtIndexBySig.has(indexSignature(srcIndex))) continue;
      const index: IndexDef = {
        name: srcIndex.name || defaultIndexName(srcTable.name, srcIndex.columns, srcIndex.unique),
        columns: srcIndex.columns,
        unique: srcIndex.unique,
      };
      const statement = buildCreateIndex(targetEngine, srcTable.name, index, targetSchema);
      changes.push({ kind: 'add_index', table: srcTable.name, detail: `新增索引 ${index.name}(${index.columns.join(', ')})`, sql: statement });
      sql.push(statement);
    }
    for (const tgtIndex of tgtIndexes) {
      if (srcIndexBySig.has(indexSignature(tgtIndex))) continue;
      if (!includeDrops) continue;
      const statement = buildDropIndex(targetEngine, srcTable.name, tgtIndex.name, targetSchema);
      changes.push({ kind: 'drop_index', table: srcTable.name, detail: `目标多出索引 ${tgtIndex.name}`, sql: statement, destructive: true });
      sql.push(statement);
    }

    tables.push({
      name: srcTable.name,
      status: changes.length ? 'changed' : 'unchanged',
      changes,
      sql,
    });
    allSql.push(...sql);
  }

  for (const tgtTable of target) {
    if (tgtTable.type !== 'table') continue;
    if (sourceMap.has(tgtTable.name.toLowerCase())) continue;
    const change: SchemaChange = {
      kind: 'drop_table',
      table: tgtTable.name,
      detail: `目标独有表 ${tgtTable.name}${includeDrops ? '（将删除）' : ''}`,
      destructive: true,
      sql: includeDrops ? buildDropObject(targetEngine, 'table', tgtTable.name, false, targetSchema) : undefined,
    };
    const sql = change.sql ? [change.sql] : [];
    tables.push({ name: tgtTable.name, status: 'removed', changes: [change], sql });
    if (includeDrops) allSql.push(...sql);
  }

  const summary = {
    added: tables.filter((table) => table.status === 'added').length,
    removed: tables.filter((table) => table.status === 'removed').length,
    changed: tables.filter((table) => table.status === 'changed').length,
    unchanged: tables.filter((table) => table.status === 'unchanged').length,
    statements: allSql.length,
  };
  return { sourceTables: source.length, targetTables: target.length, tables, sql: allSql, summary };
}
