import type { TableInfo } from '@aidb/core';

/**
 * 表结构的确定性指纹，用于判断"这张表在别处被改过没有"。
 *
 * 字段顺序写死，不依赖对象键顺序：同样的结构在任何一次 describe 里都必须得到同一个串，
 * 否则每次 loadSchema 都会误判成"变了"，把用户正在编辑的内容反复重置掉。
 */
export function tableSignature(info: TableInfo | undefined): string {
  if (!info) return '';
  return JSON.stringify({
    name: info.name,
    type: info.type,
    kind: info.kind ?? '',
    comment: info.comment ?? '',
    columns: (info.columns ?? []).map((column) => [
      column.name,
      column.type,
      String(column.nullable),
      column.defaultValue ?? '',
      column.comment ?? '',
      String(column.primaryKey),
      String(Boolean(column.autoIncrement)),
    ]),
    indexes: (info.indexes ?? []).map((index) => [
      index.name,
      index.columns.join(','),
      String(index.unique),
      String(Boolean(index.primary)),
      index.method ?? '',
      index.comment ?? '',
    ]),
    foreignKeys: (info.foreignKeys ?? []).map((fk) => [
      fk.name ?? '',
      fk.columns.join(','),
      fk.refSchema ?? '',
      fk.refTable,
      fk.refColumns.join(','),
      fk.onDelete ?? '',
      fk.onUpdate ?? '',
    ]),
  });
}
