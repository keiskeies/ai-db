import type { ColumnInfo, Engine, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError } from './types';

export interface TdengineOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

interface TdResponse {
  code?: number;
  status?: string;
  desc?: string;
  column_meta?: Array<[string, string, number] | string[]>;
  head?: string[];
  data?: unknown[][];
  rows?: number;
}

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema']);

function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function columnType(type: string, length?: number): string {
  const upper = type.toUpperCase();
  if (length && /^(BINARY|NCHAR|VARCHAR|GEOMETRY)$/.test(upper)) return `${upper}(${length})`;
  return upper || 'UNKNOWN';
}

export class TdengineDriver implements Driver {
  engine: Engine = 'tdengine';

  constructor(private opts: TdengineOptions) {}

  private base(): string {
    if (this.opts.host.startsWith('http://') || this.opts.host.startsWith('https://')) {
      return this.opts.host.replace(/\/+$/, '');
    }
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 6041}`;
  }

  private auth(): string {
    const token = `${this.opts.user ?? 'root'}:${this.opts.password ?? ''}`;
    return `Basic ${Buffer.from(token, 'utf8').toString('base64')}`;
  }

  private async request(sql: string, database?: string, timeoutMs = 30000): Promise<TdResponse> {
    const path = database ? `/rest/sql/${encodeURIComponent(database)}` : '/rest/sql';
    let response: Response;
    try {
      response = await fetch(`${this.base()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', authorization: this.auth(), connection: 'close' },
        body: sql,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      throw new DbError(`TDengine 请求失败：${err?.message ?? '网络错误'}`, { code: 'TDENGINE_NETWORK' });
    }
    const body = (await response.json().catch(() => null)) as TdResponse | null;
    if (!response.ok || !body) {
      throw new DbError(`TDengine 返回 ${response.status}`, { code: `TDENGINE_${response.status}` });
    }
    const failed = body.status === 'error' || (typeof body.code === 'number' && body.code !== 0);
    if (failed) {
      throw new DbError(body.desc || 'TDengine 执行失败', { code: `TDENGINE_${body.code ?? 'ERROR'}` });
    }
    return body;
  }

  private toResult(body: TdResponse, started: number, statement: string): QueryResult {
    const meta = body.column_meta ?? [];
    const columns = meta.length
      ? meta.map((item) => ({ name: String(item[0]), type: String(item[1] ?? '') }))
      : (body.head ?? []).map((name) => ({ name: String(name), type: '' }));
    const rows = (body.data ?? []).map((row) => row.map(cell));
    if (!columns.length) {
      return { columns: [], rows: [], rowCount: 0, affected: Number(body.rows ?? 0), durationMs: Date.now() - started, statement };
    }
    return { columns, rows, rowCount: rows.length, durationMs: Date.now() - started, statement, resultKind: 'table' };
  }

  private names(body: TdResponse): string[] {
    const index = (body.column_meta ?? []).findIndex((item) => String(item[1] ?? '').toUpperCase() === 'VARCHAR');
    const key = index >= 0 ? index : 0;
    return (body.data ?? []).map((row) => String(row[key] ?? '')).filter(Boolean);
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const version = await this.request('SELECT SERVER_VERSION()', undefined, 8000).catch(() => null);
      if (version) {
        const value = version.data?.[0]?.[0];
        return { ok: true, version: value ? `TDengine ${String(value)}` : 'TDengine', latencyMs: Date.now() - started };
      }
      await this.request('SHOW DATABASES', undefined, 8000);
      return { ok: true, version: 'TDengine', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    const body = await this.request('SHOW DATABASES');
    return this.names(body).filter((name) => !SYSTEM_DATABASES.has(name.toLowerCase()));
  }

  private async describeTable(database: string, name: string): Promise<ColumnInfo[]> {
    const body = await this.request(`DESCRIBE \`${name.replace(/`/g, '``')}\``, database);
    const data = body.data ?? [];
    return data.map((row, index) => {
      const field = String(row[0] ?? '');
      const type = String(row[1] ?? '');
      const length = Number(row[2] ?? 0) || undefined;
      const note = String(row[3] ?? '').toUpperCase();
      return {
        name: field,
        type: columnType(type, length),
        nullable: true,
        primaryKey: index === 0,
        comment: note === 'TAG' ? 'TAG' : undefined,
      };
    });
  }

  async describe(database?: string): Promise<TableInfo[]> {
    let db = database || this.opts.database;
    if (!db) {
      const databases = await this.listDatabases();
      db = databases[0];
    }
    if (!db) return [];
    const [stables, tables] = await Promise.all([
      this.request('SHOW STABLES', db).catch(() => ({ data: [] } as TdResponse)),
      this.request('SHOW TABLES', db).catch(() => ({ data: [] } as TdResponse)),
    ]);
    const tableHeaders = (tables.column_meta ?? []).map((item) => String(item[0]).toLowerCase());
    const tableNameIndex = Math.max(0, tableHeaders.indexOf('table_name'));
    const stableNameIndex = tableHeaders.indexOf('stable_name');
    const stableNames = new Set(this.names(stables));
    const entries: Array<{ name: string; kind: 'stable' | 'table' | 'child'; stable?: string }> = [];
    const seen = new Set<string>();
    for (const name of stableNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, kind: 'stable' });
    }
    for (const row of tables.data ?? []) {
      const name = String(row[tableNameIndex] ?? '');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const stable = stableNameIndex >= 0 ? String(row[stableNameIndex] ?? '') : '';
      entries.push({ name, kind: stable ? 'child' : 'table', stable: stable || undefined });
    }
    const limited = entries.slice(0, 500);
    const result: TableInfo[] = [];
    for (const entry of limited) {
      const table: TableInfo = {
        name: entry.name,
        type: 'table',
        kind: 'table',
        schema: db,
        comment: entry.kind === 'stable' ? '超级表' : entry.kind === 'child' ? `子表${entry.stable ? ` · ${entry.stable}` : ''}` : undefined,
      };
      try {
        table.columns = await this.describeTable(db, entry.name);
      } catch {
        /* column introspection is best effort */
      }
      result.push(table);
    }
    return result;
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    const body = await this.request(sql, opts.database || this.opts.database, opts.timeoutMs ?? 30000);
    return this.toResult(body, started, sql);
  }

  async runParams(_sql: string, _params: unknown[], _opts: RunOptions = {}): Promise<QueryResult> {
    throw new DbError('TDengine REST 暂不支持参数化查询，请直接执行 SQL', { code: 'TDENGINE_NO_PARAMS' });
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
  }
}