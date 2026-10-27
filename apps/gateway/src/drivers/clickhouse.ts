import type { ColumnInfo, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, toRowArray } from './types';

export interface ClickHouseOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return `'${value.toISOString().replace('T', ' ').slice(0, 23)}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function interpolate(sql: string, params: unknown[]): string {
  let index = 0;
  return sql.replace(/\?/g, () => (index < params.length ? literal(params[index++]) : 'NULL'));
}

export class ClickHouseDriver implements Driver {
  engine = 'clickhouse' as const;
  constructor(private opts: ClickHouseOptions) {}

  private async request(sql: string, database?: string): Promise<string> {
    const url = new URL(`${this.opts.ssl ? 'https' : 'http'}://${this.opts.host}:${this.opts.port}/`);
    const db = database || this.opts.database;
    if (db) url.searchParams.set('database', db);
    url.searchParams.set('default_format', 'JSONCompact');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-ClickHouse-User': this.opts.user,
          ...(this.opts.password ? { 'X-ClickHouse-Key': this.opts.password } : {}),
        },
        body: sql,
      });
    } catch (err: any) {
      throw new DbError(`ClickHouse 连接失败：${err.message}`, { code: 'CLICKHOUSE_NETWORK' });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new DbError(text.slice(0, 600) || `ClickHouse HTTP ${res.status}`, { code: 'CLICKHOUSE_ERROR' });
    }
    return text;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const text = await this.request('SELECT version() AS v');
      const parsed = JSON.parse(text) as { data?: unknown[][] };
      return { ok: true, version: `ClickHouse ${parsed.data?.[0]?.[0] ?? ''}`, latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    }
  }

  async listDatabases(): Promise<string[]> {
    const text = await this.request("SELECT name FROM system.databases WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name");
    const parsed = JSON.parse(text) as { data?: string[][] };
    return (parsed.data ?? []).map((row) => String(row[0]));
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const db = database || this.opts.database || 'default';
    const lit = db.replace(/'/g, "''");
    try {
      const tablesText = await this.request(
        `SELECT name, engine FROM system.tables WHERE database = '${lit}' AND is_temporary = 0 ORDER BY name`,
      );
      const columnsText = await this.request(
        `SELECT table, name, type, default_expression, is_in_primary_key FROM system.columns WHERE database = '${lit}' ORDER BY table, position`,
      );
      const rowsText = await this.request(
        `SELECT table, sum(rows) AS rows FROM system.parts WHERE active AND database = '${lit}' GROUP BY table`,
      );
      const tablesJson = JSON.parse(tablesText) as { data?: Array<[string, string]> };
      const columnsJson = JSON.parse(columnsText) as { data?: Array<[string, string, string, string, number]> };
      const rowsJson = JSON.parse(rowsText) as { data?: Array<[string, number]> };
      const map = new Map<string, TableInfo>();
      for (const [name, engine] of tablesJson.data ?? []) {
        map.set(name, {
          name,
          schema: db,
          type: /View/i.test(engine) ? 'view' : 'table',
          columns: [],
          indexes: [],
          foreignKeys: [],
          comment: engine,
        });
      }
      for (const [tableName, columnName, type, defaultExpr, isPk] of columnsJson.data ?? []) {
        const table = map.get(tableName);
        if (!table) continue;
        const nullable = /^Nullable\((.*)\)$/.test(type);
        const cleanType = type.replace(/^Nullable\((.*)\)$/, '$1').replace(/^LowCardinality\((.*)\)$/, '$1');
        (table.columns as ColumnInfo[]).push({
          name: columnName,
          type: cleanType,
          nullable,
          defaultValue: defaultExpr || null,
          primaryKey: Number(isPk) === 1,
        });
      }
      for (const [tableName, count] of rowsJson.data ?? []) {
        const table = map.get(tableName);
        if (table) table.rowEstimate = Number(count);
      }
      return [...map.values()];
    } catch (err: any) {
      throw new DbError(err.message, { code: 'CLICKHOUSE_METADATA_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    const prepared = params.length ? interpolate(sql, params) : sql;
    try {
      const text = await this.request(prepared, opts.database);
      if (!text.trim()) {
        return { columns: [], rows: [], rowCount: 0, affected: 0, durationMs: Date.now() - started, statement: prepared };
      }
      let parsed: { meta?: Array<{ name: string; type: string }>; data?: unknown[][] } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!parsed?.meta) {
        return { columns: [], rows: [], rowCount: 0, affected: 0, messages: [text.slice(0, 300)], durationMs: Date.now() - started, statement: prepared };
      }
      const columns = parsed.meta.map((meta) => ({ name: meta.name, type: meta.type }));
      const all = parsed.data ?? [];
      const limit = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : all.length;
      const rows = all.slice(0, limit);
      return {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
        truncated: all.length > rows.length,
        statement: prepared,
      };
    } catch (err: any) {
      throw err instanceof DbError ? err : new DbError(err.message ?? 'ClickHouse 执行失败', { code: 'CLICKHOUSE_ERROR' });
    }
  }

  async close(): Promise<void> {
    /* HTTP is stateless */
  }
}
