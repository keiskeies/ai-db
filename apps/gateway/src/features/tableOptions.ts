import { quoteLiteral } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

export interface TableOptionItem {
  label: string;
  value: string;
}

export interface TableOptionsResult {
  supported: boolean;
  options: TableOptionItem[];
  note?: string;
}

/** 表设计器「选项」标签页的数据源：读取各引擎的表级选项，只读展示。 */
export async function describeTableOptions(
  store: Store,
  manager: ConnectionManager,
  connectionId: string,
  table: string,
  database?: string,
): Promise<TableOptionsResult> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const db = database ?? conn.database;
  const run = async (sql: string) => {
    const batch = await manager.query(connectionId, sql, {
      database: db,
      maxRows: 20,
      allowMulti: false,
      autoLimit: false,
      actor: 'user',
    });
    return batch.sets[0];
  };
  const pick = (row: Record<string, unknown>, key: string): string => {
    const value = row[key];
    return value === null || value === undefined || value === '' ? '' : String(value);
  };
  const rowsOf = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    const result = await run(sql);
    const names = result.columns.map((column) => column.name);
    return result.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
  };

  if (conn.engine === 'mysql' || conn.engine === 'mariadb') {
    if (!db) throw new Error('缺少数据库上下文');
    const [row] = await rowsOf(`SHOW TABLE STATUS LIKE ${quoteLiteral(table)}`);
    if (!row) return { supported: false, options: [], note: '未找到该表' };
    const collation = pick(row, 'Collation');
    const options: TableOptionItem[] = [
      { label: '引擎', value: pick(row, 'Engine') },
      { label: '行格式', value: pick(row, 'Row_format') },
      { label: '排序规则', value: collation },
      { label: '字符集', value: collation ? collation.split('_')[0] : '' },
      { label: '自动递增', value: pick(row, 'Auto_increment') },
      { label: '行数', value: pick(row, 'Rows') },
      { label: '平均行长度', value: pick(row, 'Avg_row_length') },
      { label: '数据长度', value: pick(row, 'Data_length') },
      { label: '索引长度', value: pick(row, 'Index_length') },
      { label: '数据空闲', value: pick(row, 'Data_free') },
      { label: '表空间', value: pick(row, 'Table_space') },
      { label: '创建选项', value: pick(row, 'Create_options') },
      { label: '加密', value: pick(row, 'Encryption') },
      { label: '注释', value: pick(row, 'Comment') },
    ];
    return { supported: true, options: options.filter((item) => item.value) };
  }

  if (conn.engine === 'postgresql' || conn.engine === 'cockroachdb') {
    const [row] = await rowsOf(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.reltuples::bigint AS row_estimate, am.amname AS access_method, ts.spcname AS tablespace, obj_description(c.oid) AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_am am ON am.oid = c.relam LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
       WHERE n.nspname = current_schema() AND c.relname = ${quoteLiteral(table)}`,
    );
    if (!row) return { supported: false, options: [], note: '未找到该表' };
    const options: TableOptionItem[] = [
      { label: '所有者', value: pick(row, 'owner') },
      { label: '存储引擎', value: pick(row, 'access_method') },
      { label: '表空间', value: pick(row, 'tablespace') },
      { label: '行数估算', value: pick(row, 'row_estimate') },
      { label: '注释', value: pick(row, 'comment') },
    ];
    return { supported: true, options: options.filter((item) => item.value) };
  }

  if (conn.engine === 'sqlite') {
    const [meta] = await rowsOf(`SELECT type, sql FROM sqlite_master WHERE name = ${quoteLiteral(table)} LIMIT 1`);
    if (!meta) return { supported: false, options: [], note: '未找到该表' };
    const pragma = await rowsOf('PRAGMA page_size');
    const encoding = await rowsOf('PRAGMA encoding');
    const journal = await rowsOf('PRAGMA journal_mode');
    const options: TableOptionItem[] = [
      { label: '类型', value: pick(meta, 'type') },
      { label: '页大小', value: pragma[0] ? String(Object.values(pragma[0])[0]) : '' },
      { label: '编码', value: encoding[0] ? String(Object.values(encoding[0])[0]) : '' },
      { label: '日志模式', value: journal[0] ? String(Object.values(journal[0])[0]) : '' },
    ];
    return { supported: true, options: options.filter((item) => item.value) };
  }

  return { supported: false, options: [], note: `${conn.engine} 暂不提供表级选项读取` };
}
