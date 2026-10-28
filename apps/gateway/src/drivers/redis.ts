import { Redis } from 'ioredis';
import { parseRedisCommandLine } from '@aidb/core';
import type { Engine, QueryResult, RedisQuery, StructuredQuery, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions, StructuredQueryDriver } from './types';
import { DbError } from './types';

export interface RedisOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function scalarType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'integer';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function scalarResult(value: unknown, started: number, statement: string): QueryResult {
  const rows = value === undefined ? [] : [[serialize(value)]];
  return {
    columns: [{ name: 'value', type: scalarType(value) }],
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    statement,
  };
}

function pairs(flat: unknown[], left: string, right: string): { columns: { name: string; type: string }[]; rows: unknown[][] } {
  const rows: unknown[][] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) rows.push([serialize(flat[index]), serialize(flat[index + 1])]);
  return {
    columns: [
      { name: left, type: 'string' },
      { name: right, type: 'string' },
    ],
    rows,
  };
}

function listResult(values: unknown[], name: string, started: number, statement: string, truncated = false): QueryResult {
  const rows = values.map((value) => [serialize(value)]);
  return {
    columns: [{ name, type: scalarType(values[0]) }],
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    truncated,
    statement,
  };
}

function infoResult(text: string, started: number, statement: string): QueryResult {
  const rows: unknown[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at === -1) rows.push([line, '']);
    else rows.push([line.slice(0, at), line.slice(at + 1)]);
  }
  return {
    columns: [
      { name: 'field', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    statement,
  };
}

function resultFromRedis(
  command: string,
  args: string[],
  raw: unknown,
  started: number,
  statement: string,
  maxRows: number,
): QueryResult {
  const upper = command.toUpperCase();
  if (upper === 'INFO' && typeof raw === 'string') return infoResult(raw, started, statement);
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Buffer.isBuffer(raw)) {
    const rows = Object.entries(raw as Record<string, unknown>).map(([field, value]) => [field, serialize(value)]);
    return {
      columns: [
        { name: 'field', type: 'string' },
        { name: 'value', type: 'json', kind: 'json' },
      ],
      rows,
      rowCount: rows.length,
      durationMs: Date.now() - started,
      statement,
    };
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw === null) {
    return scalarResult(raw, started, statement);
  }
  if (Array.isArray(raw)) {
    if ((upper === 'SCAN' || upper === 'HSCAN' || upper === 'SSCAN' || upper === 'ZSCAN') && raw.length === 2 && Array.isArray(raw[1])) {
      const cursor = String(raw[0]);
      const payload = raw[1] as unknown[];
      const data = upper === 'HSCAN' || upper === 'ZSCAN' ? pairs(payload, 'field', 'value') : listResult(payload, 'key', started, statement);
      const rows = data.rows.slice(0, maxRows);
      return {
        columns: data.columns,
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
        truncated: cursor !== '0' || data.rows.length > rows.length,
        messages: [`cursor=${cursor}`],
        statement,
        resultKind: 'keys',
      };
    }
    if (upper === 'HGETALL') {
      const data = pairs(raw, 'field', 'value');
      return { ...data, rowCount: data.rows.length, durationMs: Date.now() - started, statement };
    }
    const withScores = args.some((arg) => arg.toUpperCase() === 'WITHSCORES');
    if (withScores && upper.startsWith('Z')) {
      const data = pairs(raw, 'member', 'score');
      return { ...data, rowCount: data.rows.length, durationMs: Date.now() - started, statement };
    }
    if (upper === 'XRANGE' || upper === 'XREVRANGE') {
      const rows = raw.slice(0, maxRows).map((entry) => {
        const pair = Array.isArray(entry) ? entry : [entry];
        const fields = Array.isArray(pair[1]) ? (pair[1] as unknown[]) : [];
        const object: Record<string, unknown> = {};
        for (let index = 0; index + 1 < fields.length; index += 2) object[String(fields[index])] = fields[index + 1];
        return [serialize(pair[0]), JSON.stringify(object)];
      });
      return {
        columns: [
          { name: 'id', type: 'string' },
          { name: 'fields', type: 'json', kind: 'json' },
        ],
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
        truncated: raw.length > rows.length,
        statement,
      };
    }
    const allScalar = raw.every((value) => value === null || typeof value !== 'object');
    if (allScalar) {
      return listResult(raw, upper === 'KEYS' || upper.endsWith('SCAN') ? 'key' : 'value', started, statement, raw.length > maxRows);
    }
    const rows = raw.slice(0, maxRows).map((value) => [serialize(value)]);
    return {
      columns: [{ name: 'value', type: 'json', kind: 'json' }],
      rows,
      rowCount: rows.length,
      durationMs: Date.now() - started,
      truncated: raw.length > rows.length,
      statement,
    };
  }
  return scalarResult(raw, started, statement);
}

export class RedisDriver implements StructuredQueryDriver {
  engine: Engine = 'redis';
  private clients = new Map<number, Redis>();

  constructor(private opts: RedisOptions) {}

  private dbIndex(database?: string): number {
    const raw = database ?? this.opts.database ?? '0';
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : 0;
  }

  private client(database?: string): Redis {
    const index = this.dbIndex(database);
    let client = this.clients.get(index);
    if (!client) {
      client = new Redis({
        host: this.opts.host || '127.0.0.1',
        port: this.opts.port || 6379,
        username: this.opts.username || undefined,
        password: this.opts.password || undefined,
        db: index,
        lazyConnect: true,
        connectTimeout: 8000,
        commandTimeout: 20000,
        maxRetriesPerRequest: 1,
        tls: this.opts.ssl ? {} : undefined,
      });
      client.on('error', () => undefined);
      this.clients.set(index, client);
    }
    return client;
  }

  private async ready(database?: string): Promise<Redis> {
    const client = this.client(database);
    if (client.status === 'wait') await client.connect();
    return client;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const client = await this.ready();
      await client.ping();
      const info = await client.info('server');
      const version = /redis_version:([^\r\n]+)/.exec(String(info))?.[1];
      return { ok: true, version: `Redis ${version ?? ''}`.trim(), latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.ready();
    let count = 1;
    try {
      const config = await client.call('CONFIG', 'GET', 'databases');
      if (Array.isArray(config) && config.length >= 2) count = Math.max(1, Number(config[1]) || 1);
    } catch {
      try {
        const keyspace = String(await client.info('keyspace'));
        const indexes = [...keyspace.matchAll(/db(\d+):/g)].map((match) => Number(match[1]));
        count = indexes.length ? Math.max(...indexes) + 1 : 1;
      } catch {
        count = 1;
      }
    }
    return Array.from({ length: Math.min(count, 64) }, (_, index) => String(index));
  }

  async describe(database?: string): Promise<TableInfo[]> {
    try {
      const client = await this.ready(database);
      const size = Number(await client.dbsize()) || 0;
      return [
        {
          name: 'keys',
          type: 'table',
          kind: 'key',
          rowEstimate: size,
          comment: '使用 SCAN 浏览键；命令列支持任意 Redis 命令',
          columns: [
            { name: 'key', type: 'string', nullable: false, primaryKey: true },
            { name: 'type', type: 'string', nullable: false, primaryKey: false },
            { name: 'ttl', type: 'integer', nullable: true, primaryKey: false },
            { name: 'size', type: 'integer', nullable: true, primaryKey: false },
          ],
        },
      ];
    } catch (err: any) {
      throw new DbError(err?.message ?? '无法读取 Redis 键空间', { code: 'REDIS_ERROR' });
    }
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'redis') throw new DbError('Redis 驱动只接受命令查询', { code: 'REDIS_ONLY' });
    const command = query.command.trim().toUpperCase();
    if (!command) throw new DbError('Redis 命令为空', { code: 'REDIS_EMPTY' });
    const args = (query.args ?? []).map((arg) => String(arg));
    if (command === 'SELECT') throw new DbError('请在连接或工具栏切换 Redis DB，而不是执行 SELECT', { code: 'REDIS_SELECT' });
    const started = Date.now();
    const statement = [command, ...args].join(' ');
    try {
      const client = await this.ready(opts.database);
      const raw = await client.call(command, ...args);
      const maxRows = Math.max(1, Math.min(opts.maxRows && opts.maxRows > 0 ? opts.maxRows : 500, 5000));
      return resultFromRedis(command, args, raw, started, statement, maxRows);
    } catch (err: any) {
      if (err instanceof DbError) throw err;
      throw new DbError(err?.message ?? `Redis 命令执行失败：${command}`, { code: err?.code ?? 'REDIS_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    const parsed = parseRedisCommandLine(sql);
    if (!parsed) throw new DbError('Redis 命令为空', { code: 'REDIS_EMPTY' });
    return this.executeQuery(parsed, opts);
  }

  async runParams(): Promise<QueryResult> {
    throw new DbError('Redis 不支持参数化 SQL，请使用命令查询', { code: 'REDIS_ONLY' });
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }),
    );
    this.clients.clear();
  }
}
