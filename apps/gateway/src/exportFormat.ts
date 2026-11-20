import {
  dialectOf,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  type DialectId,
  type Engine,
} from '@aidb/core';

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xml' | 'xlsx';

export interface XlsxSheet {
  name: string;
  columns: string[];
  rows: unknown[][];
}

export interface ExportInput {
  dir: string;
  format: ExportFormat;
  columns: string[];
  rows: unknown[][];
  tableName?: string;
  engine: Engine;
  baseName?: string;
  /**
   * 多 sheet 输出（仅 xlsx）。报告的表格块各占一张表时用它；
   * 给了 sheets 就忽略 columns/rows。
   */
  sheets?: XlsxSheet[];
}

/** CSV/公式注入防护：= + - @ 及控制符开头的值在 Excel 里会被当公式执行，前缀 ' 转纯文本。 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
}

export function escapeCsv(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  text = neutralizeFormula(text);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  return '\uFEFF' + [columns.map(escapeCsv).join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\r\n') + '\r\n';
}

const BINARY_LITERAL: Record<string, (hex: string) => string> = {
  postgres: (hex) => `decode('${hex}', 'hex')`,
  mssql: (hex) => `0x${hex}`,
  oracle: (hex) => `hextoraw('${hex}')`,
  dm: (hex) => `hextoraw('${hex}')`,
  clickhouse: (hex) => `unhex('${hex}')`,
  tdengine: (hex) => `x'${hex}'`,
  influxdb: (hex) => `decode('${hex}')`,
  mysql: (hex) => `X'${hex}'`,
  sqlite: (hex) => `X'${hex}'`,
};

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** 本地墙钟时间：PG 的 timestamp（无时区）按会话时区解析，转成 UTC 会整体偏移。 */
function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function localOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function dateLiteral(date: Date, dialect: DialectId): string {
  const stamp = localStamp(date);
  // Oracle 与达梦的默认日期格式不是 ISO，裸字符串会按 NLS 解析失败。
  if (dialect === 'oracle' || dialect === 'dm') return `TO_TIMESTAMP(${quoteLiteral(stamp)}, 'YYYY-MM-DD HH24:MI:SS.FF3')`;
  if (dialect === 'mssql') return quoteLiteral(`${stamp.slice(0, 10)}T${stamp.slice(11)}`);
  if (dialect === 'influxdb') return quoteLiteral(date.toISOString());
  // PG 带偏移：timestamptz 保留瞬时，timestamp 会忽略偏移并保留墙钟。
  if (dialect === 'postgres') return quoteLiteral(`${stamp}${localOffset(date)}`);
  return quoteLiteral(stamp);
}

function binaryLiteral(value: Uint8Array, engine: Engine, dialect: DialectId): string {
  const hex = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  // DuckDB 的 BLOB 字面量不是标准 X'…'。
  if (engine === 'duckdb') return `'\\x${hex}'::BLOB`;
  return (BINARY_LITERAL[dialect] ?? BINARY_LITERAL.mysql)(hex);
}

export function sqlLiteral(value: unknown, engine: Engine): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  // 按方言判断，不能只认 postgresql/cockroachdb；Kingbase/openGauss/Timescale 等别名同样不接受 1/0 写 boolean。
  if (typeof value === 'boolean') return dialectOf(engine) === 'postgres' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0';
  if (value instanceof Date) return dateLiteral(value, dialectOf(engine));
  // node:sqlite 的 BLOB 是 Uint8Array，不是 Buffer；按对象 JSON 化会得到 {"0":1,…} 这种垃圾。
  if (value instanceof Uint8Array) return binaryLiteral(value, engine, dialectOf(engine));
  // PG 驱动把数组列返回成 JS 数组，JSON 串无法隐式转成 integer[] 等数组类型。
  if (Array.isArray(value)) {
    if (dialectOf(engine) !== 'postgres') return quoteLiteral(JSON.stringify(value));
    return value.length ? `ARRAY[${value.map((item) => sqlLiteral(item, engine)).join(', ')}]` : `'{}'`;
  }
  if (typeof value === 'object') return quoteLiteral(JSON.stringify(value));
  return quoteLiteral(String(value));
}

export function toSqlInserts(engine: Engine, table: string, columns: string[], rows: unknown[][], schema?: string): string {
  const target = quoteQualified([schema, table], engine);
  const cols = columns.map((c) => quoteIdent(c, engine)).join(', ');
  return rows.map((row) => `INSERT INTO ${target} (${cols}) VALUES (${row.map((v) => sqlLiteral(v, engine)).join(', ')});`).join('\n');
}
