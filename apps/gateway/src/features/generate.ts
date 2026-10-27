import { randomUUID } from 'node:crypto';
import { buildInsert, buildSelectTable, quoteIdent, type ColumnInfo, type Engine } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { sqlLiteral } from '../services';
import { connectionSchema, tableRef } from './common';

export interface GenerateOptions {
  connectionId: string;
  database?: string;
  table: string;
  rows?: number;
  dryRun?: boolean;
}

export interface GenerateResult {
  table: string;
  columns: string[];
  rowsPreview: unknown[][];
  sqlPreview: string;
  inserted: number;
  dryRun: boolean;
}

const COUNTRIES = ['中国', '美国', '德国', '日本', '新加坡', '英国'];
const STATUSES = ['active', 'pending', 'completed', 'cancelled'];
const CATEGORIES = ['hardware', 'software', 'office', 'life'];
const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey', 'Robin', 'Mia', 'Noah'];

function cappedText(value: string, type: string): string {
  const match = type.match(/\((\d+)\)/);
  if (match) {
    const max = Number(match[1]);
    if (Number.isFinite(max) && max > 0) return value.slice(0, max);
  }
  return value;
}

function mockValue(column: ColumnInfo, index: number, engine: Engine): unknown {
  const name = column.name.toLowerCase();
  const type = column.type.toLowerCase();
  const intValue = () => 1 + Math.floor(Math.random() * 1000);
  if (/bool|bit/.test(type)) return engine === 'postgresql' || engine === 'cockroachdb' ? index % 2 === 0 : index % 2 === 0 ? 1 : 0;
  if (/timestamp|datetime|date/.test(type) || /_at$|date|time/.test(name)) {
    return new Date(Date.now() - Math.floor(Math.random() * 30) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  }
  if (/uuid/.test(type) || name === 'uuid') return randomUUID();
  if (/decimal|numeric|real|double|float|money/.test(type) || /amount|price|total|balance|cost/.test(name)) {
    return Number((10 + Math.random() * 990).toFixed(2));
  }
  if (/int|serial/.test(type) || /count|qty|quantity|stock|age|score|rating/.test(name)) return intValue();
  if (/json/.test(type)) return JSON.stringify({ source: 'generator', index });
  if (name === 'email' || name === 'mail') return `demo${index}@example.com`;
  if (name === 'phone' || name === 'mobile') return `138${String(10000000 + index).slice(-8)}`;
  if (name === 'name' || name === 'username' || name === 'user_name') return `${FIRST_NAMES[index % FIRST_NAMES.length]} ${index}`;
  if (name === 'title' || name === 'subject') return cappedText(`示例标题 ${index}`, column.type);
  if (name === 'status' || name === 'state') return STATUSES[index % STATUSES.length];
  if (name === 'country') return COUNTRIES[index % COUNTRIES.length];
  if (name === 'category' || name === 'type') return CATEGORIES[index % CATEGORIES.length];
  if (name === 'city') return ['上海', '北京', '深圳', '杭州'][index % 4];
  if (name === 'address') return `${index} 号示例路`;
  if (name === 'url' || name === 'website') return `https://example.com/item/${index}`;
  if (name === 'ip') return `10.0.${index % 255}.${(index * 7) % 255}`;
  if (name === 'description' || name === 'content' || name === 'note' || name === 'remark') {
    return cappedText(`自动生成的示例内容 #${index}`, column.type);
  }
  return cappedText(`demo_${index}`, column.type);
}

export async function generateData(store: Store, manager: ConnectionManager, opts: GenerateOptions): Promise<GenerateResult> {
  const conn = store.getConnection(opts.connectionId);
  if (!conn) throw new Error('连接不存在');
  if (conn.readonly && !opts.dryRun) throw new Error('只读连接禁止写入');
  const { table } = await manager.findTable(opts.connectionId, opts.database, opts.table);
  const rowCount = Math.min(5000, Math.max(1, opts.rows ?? 10));
  const columns = (table.columns ?? []).filter((column) => !column.autoIncrement);
  if (!columns.length) throw new Error('没有可填充的列');

  // Resolve foreign-key values from referenced tables to keep generated rows referentially valid.
  const fkValues = new Map<string, unknown[]>();
  for (const fk of table.foreignKeys ?? []) {
    try {
      const ref = await manager.findTable(opts.connectionId, opts.database, fk.refTable);
      const refColumn = fk.refColumns[0];
      if (!refColumn) continue;
      const sql = buildSelectTable(conn.engine, ref.table.name, {
        columns: [refColumn],
        schema: connectionSchema(conn, ref.table),
        limit: 50,
      });
      const batch = await manager.query(opts.connectionId, sql, {
        database: opts.database,
        maxRows: 50,
        allowMulti: false,
        autoLimit: false,
        actor: 'user',
      });
      const values = (batch.sets[0]?.rows ?? []).map((row) => row[0]).filter((value) => value !== null);
      if (values.length) fkValues.set(fk.columns[0].toLowerCase(), values);
    } catch {
      /* optional */
    }
  }

  const rows: unknown[][] = [];
  for (let index = 1; index <= rowCount; index++) {
    rows.push(
      columns.map((column) => {
        const fk = fkValues.get(column.name.toLowerCase());
        if (fk?.length) return fk[Math.floor(Math.random() * fk.length)];
        return mockValue(column, index, conn.engine);
      }),
    );
  }
  const columnNames = columns.map((column) => column.name);
  const previewRows = rows.slice(0, 5);
  const target = tableRef(conn, table);
  const previewSql =
    `INSERT INTO ${target} (${columnNames.map((column) => quoteIdent(column, conn.engine)).join(', ')}) VALUES ` +
    previewRows
      .map((row) => `(${row.map((value) => sqlLiteral(value, conn.engine)).join(', ')})`)
      .join(', ') +
    ';';
  if (opts.dryRun) {
    return { table: table.name, columns: columnNames, rowsPreview: previewRows, sqlPreview: previewSql, inserted: 0, dryRun: true };
  }

  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += 200) {
    const chunk = rows.slice(offset, offset + 200);
    const params = chunk.flat();
    const sql = buildInsert(conn.engine, table.name, columnNames, chunk.length, connectionSchema(conn, table));
    await manager.runParams(opts.connectionId, sql, params, { database: opts.database, actor: 'user' });
    inserted += chunk.length;
  }
  return { table: table.name, columns: columnNames, rowsPreview: previewRows, sqlPreview: previewSql, inserted, dryRun: false };
}
