import type { ColumnInfo, Engine, QueryResult, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError } from './types';

export interface InfluxdbOptions {
  host: string;
  port: number;
  token?: string;
  /** InfluxDB 1.x 用用户名密码（或 u/p 查询参数），没有 2.x/3.x 的 token 概念。 */
  user?: string;
  database?: string;
  ssl?: boolean;
}

type InfluxGeneration = 1 | 2 | 3;

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

  private headers(basic = false): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
    // 1.x 没有 token 体系，只有用户名密码；Bearer 会被它当无效凭据拒掉。
    if (basic && this.opts.user) {
      headers.authorization = `Basic ${Buffer.from(`${this.opts.user}:${this.opts.token ?? ''}`).toString('base64')}`;
    } else if (this.opts.token) {
      headers.authorization = `Bearer ${this.opts.token}`;
    }
    return headers;
  }

  private async send(path: string, init: { method?: string; body?: string; timeoutMs?: number; basic?: boolean; raw?: boolean } = {}): Promise<Response> {
    try {
      return await fetch(`${this.base()}${path}`, {
        method: init.method ?? 'GET',
        headers: init.raw ? { 'content-type': 'text/plain', ...this.headers(init.basic) } : this.headers(init.basic),
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30000),
      });
    } catch (err: any) {
      throw new DbError(`InfluxDB 请求失败：${err?.message ?? '网络错误'}`, { code: 'INFLUXDB_NETWORK' });
    }
  }

  private generation?: InfluxGeneration;
  private serverVersion = '';

  /**
   * 1.x / 2.x 有 /ping 并回 X-Influxdb-Version，3.x 只有 /health。
   * 三代接口的路径与查询语言都不同，必须先分代再决定后续请求走哪条路。
   */
  private async detect(): Promise<InfluxGeneration> {
    if (this.generation) return this.generation;
    const ping = await this.send('/ping', { timeoutMs: 8000 }).catch(() => null);
    const header = String(ping?.headers?.get('x-influxdb-version') ?? '');
    if (/^1\./.test(header)) {
      this.serverVersion = header;
      this.generation = 1;
      return 1;
    }
    if (/^2\./.test(header)) {
      this.serverVersion = header;
      this.generation = 2;
      return 2;
    }
    const health = await this.send('/health', { timeoutMs: 8000 }).catch(() => null);
    if (health?.ok) {
      const body = (await health.json().catch(() => null)) as { version?: string } | null;
      this.serverVersion = String(body?.version ?? '');
      this.generation = 3;
      return 3;
    }
    // 探测不到就沿用当前实现（v3），真实失败会由随后的请求如实抛出。
    this.generation = 3;
    return 3;
  }

  /** InfluxDB 1.x 的 /query 结果形态：results[].series[] 每列一组 values。 */
  private async queryV1Series(query: string, database?: string, timeoutMs = 30000): Promise<Array<{ name?: string; columns: string[]; values?: unknown[][] }>> {
    const params = new URLSearchParams({ q: query, epoch: 'ns' });
    const db = database || this.opts.database;
    if (db) params.set('db', db);
    const response = await this.send(`/query?${params.toString()}`, { basic: true, timeoutMs });
    const text = await response.text();
    let parsed: { results?: Array<{ error?: string; series?: Array<{ name?: string; columns: string[]; values?: unknown[][] }> }> } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) throw new DbError(parsed?.results?.[0]?.error ?? text.slice(0, 300) ?? `InfluxDB 返回 ${response.status}`, { code: `INFLUXDB_${response.status}` });
    const result = parsed?.results?.[0];
    if (result?.error) throw new DbError(`InfluxDB 执行失败：${result.error}`, { code: 'INFLUXDB_ERROR' });
    return result?.series ?? [];
  }

  private async queryV1Rows(query: string, database?: string, timeoutMs = 30000): Promise<Row[]> {
    const rows: Row[] = [];
    for (const series of await this.queryV1Series(query, database, timeoutMs)) {
      for (const values of series.values ?? []) {
        rows.push(Object.fromEntries(series.columns.map((column, index) => [column, values[index]])));
      }
    }
    return rows;
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
      const generation = await this.detect();
      if (generation === 2) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: `检测到 InfluxDB ${this.serverVersion || '2.x'}：本引擎的查询走 DataFusion SQL（/api/v3/query_sql），需要 InfluxDB 3；2.x 请改用 Flux 客户端或升级到 3`,
        };
      }
      if (generation === 1) {
        await this.queryV1Rows('SHOW DATABASES', undefined, 8000);
        return { ok: true, version: `InfluxDB ${this.serverVersion || '1.x'}`, latencyMs: Date.now() - started };
      }
      await this.queryRows('SELECT 1 AS ok', undefined, 8000);
      return { ok: true, version: `InfluxDB 3${this.serverVersion ? ` ${this.serverVersion}` : ''}`, latencyMs: Date.now() - started };
    } catch (err: any) {
      const health = await this.send('/health', { timeoutMs: 8000 }).catch(() => null);
      if (health?.ok) return { ok: true, version: 'InfluxDB 3', latencyMs: Date.now() - started };
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    if ((await this.detect()) === 1) {
      const rows = await this.queryV1Rows('SHOW DATABASES');
      return rows
        .map((row) => String(row.name ?? ''))
        .filter((name) => name && !SYSTEM_DATABASES.has(name));
    }
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
    if ((await this.detect()) === 1) {
      // 1.x 没有 information_schema：measurement 与 field key 各一条 SHOW 查询。
      const measurements = await this.queryV1Rows('SHOW MEASUREMENTS', db);
      const fieldSeries = await this.queryV1Series('SHOW FIELD KEYS', db);
      const byTable = new Map<string, ColumnInfo[]>();
      for (const series of fieldSeries) {
        const columns = series.columns ?? [];
        const measurementIndex = columns.indexOf('measurement');
        const keyIndex = columns.indexOf('fieldKey');
        const typeIndex = columns.indexOf('fieldType');
        for (const values of series.values ?? []) {
          const name = measurementIndex >= 0 ? String(values[measurementIndex] ?? '') : String(series.name ?? '').replace(/,$/, '');
          const field = keyIndex >= 0 ? String(values[keyIndex] ?? '') : '';
          if (!name || !field) continue;
          const list = byTable.get(name) ?? [];
          list.push({
            name: field,
            type: baseType(typeIndex >= 0 ? String(values[typeIndex] ?? '') : 'string'),
            nullable: true,
            primaryKey: false,
          });
          byTable.set(name, list);
        }
      }
      return measurements
        .map((row) => String(row.name ?? ''))
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
    const rows = (await this.detect()) === 1
      ? await this.queryV1Rows(statement, opts.database || this.opts.database, opts.timeoutMs ?? 30000)
      : await this.queryRows(statement, opts.database || this.opts.database, opts.timeoutMs ?? 30000);
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

  /**
   * 行协议写入：v3 的 SQL 接口只读，写必须走 /api/v3/write_lp（纯文本 body），
   * 所以不能复用强制 JSON 的 send()。
   */
  async writeLineProtocol(lines: string[], database?: string, timeoutMs = 30000): Promise<{ written: number }> {
    const payload = lines.map((line) => line.trim()).filter(Boolean);
    if (!payload.length) throw new DbError('行协议内容不能为空', { code: 'INFLUXDB_WRITE' });
    const db = database || this.opts.database || 'aidb';
    // 1.x 的写入端点是 /write，且用 Basic 认证；3.x 是 /api/v3/write_lp + Bearer。
    const generation = await this.detect();
    const path = generation === 1
      ? `/write?db=${encodeURIComponent(db)}&precision=ns`
      : `/api/v3/write_lp?db=${encodeURIComponent(db)}&precision=nanosecond`;
    const response = await this.send(path, {
      method: 'POST',
      body: payload.join('\n'),
      timeoutMs,
      raw: true,
      basic: generation === 1,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim();
      throw new DbError(detail || `InfluxDB 写入失败：HTTP ${response.status}`, { code: `INFLUXDB_${response.status}` });
    }
    return { written: payload.length };
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
  }
}