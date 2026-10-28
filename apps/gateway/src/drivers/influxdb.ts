import type { ColumnInfo, Engine, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError } from './types';

export interface InfluxdbOptions {
  host: string;
  port: number;
  token?: string;
  database?: string;
  ssl?: boolean;
}

type Row = Record<string, unknown>;

const SYSTEM_DATABASES = new Set(['_internal']);

function baseType(raw: string): string {
  const type = String(raw ?? '');
  if (/^Dictionary\(.*Utf8\)/i.test(type)) return 'string';
  if (/^Timestamp/i.test(type)) return 'timestamp';
  if (/^(Float|Decimal)/i.test(type)) return 'number';
  if (/^Int/i.test(type)) return 'integer';
  if (/^Boolean/i.test(type)) return 'boolean';
  if (/^(List|Array|Struct|Map)/i.test(type)) return 'json';
  return type || 'string';
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function inferType(rows: Row[], column: string): string {
  for (const row of rows) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
  }
  return 'string';
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value) || typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** InfluxDB 3 SQL 只接受命名参数；批量写入等位置参数按顺序内联为字面量。 */
export function bindPositional(sql: string, params: unknown[]): string {
  if (!params.length) return sql;
  let index = 0;
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString && ch === '?' && index < params.length) {
      out += literal(params[index++]);
      continue;
    }
    out += ch;
  }
  return out;
}

export class InfluxdbDriver implements Driver {
  engine: Engine = 'influxdb';

  constructor(private opts: InfluxdbOptions) {}

  private base(): string {
    if (/^https?:\/\//i.test(this.opts.host)) return this.opts.host.replace(/\/+$/, '');
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 8086}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    return headers;
  }

  private async send(path: string, init: { method?: string; body?: string; timeoutMs?: number } = {}): Promise<Response> {
    try {
      return await fetch(`${this.base()}${path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(),
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30000),
      });
    } catch (err: any) {
      throw new DbError(`InfluxDB 请求失败：${err?.message ?? '网络错误'}`, { code: 'INFLUXDB_NETWORK' });
    }
  }

  private async queryRows(sql: string, database?: string, timeoutMs = 30000): Promise<Row[]> {
    const response = await this.send('/api/v3/query_sql', {
      method: 'POST',
      body: JSON.stringify({ db: database || this.opts.database || '', q: sql, format: 'json' }),
      timeoutMs,
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        /* keep raw text */
      }
      throw new DbError(`InfluxDB 执行失败：${message}`, { code: `INFLUXDB_${response.status}` });
    }
    if (!text.trim()) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as Row[]) : [];
    } catch {
      throw new DbError('InfluxDB 返回格式异常', { code: 'INFLUXDB_REPLY' });
    }
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      await this.queryRows('SELECT 1 AS ok', undefined, 8000);
      return { ok: true, version: 'InfluxDB 3', latencyMs: Date.now() - started };
    } catch (err: any) {
      const health = await this.send('/health', { timeoutMs: 8000 }).catch(() => null);
      if (health?.ok) return { ok: true, version: 'InfluxDB 3', latencyMs: Date.now() - started };
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    const response = await this.send('/api/v3/configure/database?format=json');
    if (!response.ok) throw new DbError(`InfluxDB 返回 ${response.status}`, { code: `INFLUXDB_${response.status}` });
    const body = (await response.json().catch(() => [])) as Array<Record<string, unknown>>;
    const names = body
      .map((item) => String(item['iox::database'] ?? item.database ?? ''))
      .filter((name) => name && !SYSTEM_DATABASES.has(name));
    return names;
  }

  async describe(database?: string): Promise<TableInfo[]> {
    let db = database || this.opts.database;
    if (!db) db = (await this.listDatabases())[0];
    if (!db) return [];
    const tables = await this.queryRows(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'iox' ORDER BY table_name`,
      db,
    );
    const columns = await this.queryRows(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'iox' ORDER BY table_name, ordinal_position`,
      db,
    );
    const byTable = new Map<string, ColumnInfo[]>();
    for (const row of columns) {
      const name = String(row.table_name ?? '');
      if (!name) continue;
      const type = baseType(String(row.data_type ?? ''));
      const column: ColumnInfo = {
        name: String(row.column_name ?? ''),
        type,
        nullable: String(row.is_nullable ?? 'YES').toUpperCase() !== 'NO',
        primaryKey: false,
      };
      byTable.set(name, [...(byTable.get(name) ?? []), column]);
    }
    return tables
      .map((row) => String(row.table_name ?? ''))
      .filter(Boolean)
      .map((name) => ({
        name,
        type: 'table' as const,
        kind: 'table' as const,
        schema: db,
        columns: byTable.get(name) ?? [],
        comment: 'measurement',
      }));
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    const statement = sql.trim();
    const rows = await this.queryRows(statement, opts.database || this.opts.database, opts.timeoutMs ?? 30000);
    const names: string[] = [];
    const seen = new Set<string>();
    for (const row of rows.slice(0, 50)) {
      for (const key of Object.keys(row)) {
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(key);
      }
    }
    if (!names.length) {
      return { columns: [], rows: [], rowCount: 0, durationMs: Date.now() - started, statement };
    }
    const limited = rows.slice(0, opts.maxRows && opts.maxRows > 0 ? opts.maxRows : rows.length);
    const columns: ColumnInfo[] = names.map((name) => ({
      name,
      type: inferType(limited, name),
      nullable: true,
      primaryKey: false,
    }));
    return {
      columns,
      rows: limited.map((row) => names.map((name) => normalizeCell(row[name]))),
      rowCount: limited.length,
      durationMs: Date.now() - started,
      truncated: rows.length > limited.length,
      statement,
      resultKind: 'table',
    };
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    return this.run(bindPositional(sql, params), opts);
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
  }
}