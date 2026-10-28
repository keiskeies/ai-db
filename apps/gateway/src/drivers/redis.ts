import { Redis } from 'ioredis';
import { parseRedisCommandLine } from '@aidb/core';
import type { Engine, QueryResult, RedisKeyDetail, RedisQuery, StructuredQuery, TableInfo } from '@aidb/core';
import type { CreateRedisKeyInput, Driver, DriverTestResult, RedisKeyDriver, RunOptions, StructuredQueryDriver } from './types';
import { DbError } from './types';

const MODULE_LABEL: Record<string, string> = {
  ReJSON: 'JSON',
  search: 'RediSearch',
  timeseries: 'TimeSeries',
  bf: 'Bloom',
  redisgears_2: 'Gears',
  RedisCompat: 'compat',
  vectorset: 'VectorSet',
};

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

/** RESP3 把 member/score 成对返回为嵌套数组，这里展平成 pairs 需要的形式。 */
function flattenPairs(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
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

/** Redis 把 map 回复摊平成 [k, v, k, v]，这里还原成对象。 */
function kvPairs(flat: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let index = 0; index + 1 < flat.length; index += 2) out[String(flat[index])] = flat[index + 1];
  return out;
}

/**
 * FT.SEARCH 有两种回复：RESP2 的 [total, key, [field, value], ...]
 * 与 RESP3/新版 Stack 的 map（results / total_results），两者都转成同一种行。
 */
function parseSearchReply(raw: unknown[]): { total: number; names: string[]; docs: Array<Record<string, unknown>> } | null {
  const names: string[] = [];
  const docs: Array<Record<string, unknown>> = [];
  const push = (record: Record<string, unknown>) => {
    for (const key of Object.keys(record)) {
      if (key !== '__key' && !names.includes(key)) names.push(key);
    }
    docs.push(record);
  };

  if (typeof raw[0] === 'number') {
    for (let index = 1; index + 1 < raw.length; index += 2) {
      const flat = Array.isArray(raw[index + 1]) ? (raw[index + 1] as unknown[]) : [];
      push({ __key: String(raw[index]), ...kvPairs(flat) });
    }
    return { total: Number(raw[0]), names, docs };
  }

  const map = kvPairs(raw);
  const results = Array.isArray(map.results) ? (map.results as unknown[]) : undefined;
  if (!results) return null;
  for (const entry of results) {
    const item = Array.isArray(entry) ? kvPairs(entry) : ((entry as Record<string, unknown> | null) ?? {});
    const attributes = Array.isArray(item.extra_attributes)
      ? kvPairs(item.extra_attributes as unknown[])
      : ((item.extra_attributes as Record<string, unknown> | null) ?? {});
    push({ __key: String(item.id ?? ''), ...attributes });
  }
  return { total: Number(map.total_results ?? docs.length), names, docs };
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
      const data = pairs(flattenPairs(raw), 'member', 'score');
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
    if (upper === 'FT.SEARCH') {
      const parsed = parseSearchReply(raw);
      if (parsed) {
        const { total, names, docs } = parsed;
        const rows = docs.slice(0, maxRows).map((record) => [
          record.__key ?? null,
          null,
          ...names.map((name) => serialize(record[name])),
        ]);
        return {
          columns: [
            { name: 'key', type: 'string' },
            { name: 'score', type: 'float' },
            ...names.map((name) => ({ name, type: 'json', kind: 'json' as const })),
          ],
          rows,
          rowCount: rows.length,
          durationMs: Date.now() - started,
          truncated: docs.length > rows.length,
          messages: [`total=${total}`],
          statement,
          resultKind: 'documents',
        };
      }
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

export class RedisDriver implements StructuredQueryDriver, RedisKeyDriver {
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

  private async modules(client: Redis): Promise<string[]> {
    try {
      const raw = (await client.call('MODULE', 'LIST')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .map((entry) => {
          const fields = Array.isArray(entry) ? entry : [];
          const index = fields.findIndex((value) => String(value).toLowerCase() === 'name');
          return index >= 0 ? String(fields[index + 1] ?? '') : '';
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const client = await this.ready();
      await client.ping();
      const info = await client.info('server');
      const version = /redis_version:([^\r\n]+)/.exec(String(info))?.[1];
      const modules = await this.modules(client);
      const tags = modules.map((name) => MODULE_LABEL[name] ?? name).filter((name) => name !== 'compat');
      return {
        ok: true,
        version: `Redis ${version ?? ''}${tags.length ? ` · ${tags.join('/')}` : ''}`.trim(),
        latencyMs: Date.now() - started,
      };
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
      const tables: TableInfo[] = [
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
      try {
        const raw = (await client.call('FT._LIST')) as unknown;
        const names = Array.isArray(raw) ? raw.map((name) => String(name)).filter(Boolean) : [];
        for (const name of names) {
          let docs: number | undefined;
          try {
            const info = (await client.call('FT.INFO', name)) as unknown;
            if (Array.isArray(info)) {
              const index = info.findIndex((value) => String(value).toLowerCase() === 'num_docs');
              if (index >= 0) docs = Number(info[index + 1]);
            }
          } catch {
            /* FT.INFO 在旧版本可能不可用 */
          }
          tables.push({
            name,
            type: 'table',
            kind: 'index',
            rowEstimate: Number.isFinite(docs) ? docs : undefined,
            comment: 'RediSearch 索引；打开时执行 FT.SEARCH',
            columns: [
              { name: 'key', type: 'string', nullable: false, primaryKey: true },
              { name: 'score', type: 'float', nullable: true, primaryKey: false },
              { name: 'fields', type: 'json', nullable: true, primaryKey: false },
            ],
          });
        }
      } catch {
        /* 未安装 RediSearch：只展示键空间 */
      }
      return tables;
    } catch (err: any) {
      throw new DbError(err?.message ?? '无法读取 Redis 键空间', { code: 'REDIS_ERROR' });
    }
  }

  /** 类型感知的键详情：先读 TYPE/TTL/ENCODING，再按类型取值，单次最多 limit 个成员。 */
  async describeKey(key: string, database?: string, limit = 200): Promise<RedisKeyDetail> {
    const name = key.trim();
    if (!name) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    const client = await this.ready(database);
    const type = String(await client.type(name));
    if (type === 'none') throw new DbError(`键不存在：${name}`, { code: 'REDIS_KEY_NOT_FOUND', status: 404 });
    const ttl = Number(await client.ttl(name));
    let encoding: string | undefined;
    try {
      encoding = String(await client.call('OBJECT', 'ENCODING', name));
    } catch {
      /* 少数类型不支持 OBJECT ENCODING */
    }
    const sizeCommand: Record<string, string> = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' };
    let size: number | null = null;
    try {
      const command = sizeCommand[type];
      if (command) size = Number(await client.call(command, name));
      else if (type === 'ReJSON-RL') size = Number(await client.call('JSON.OBJLEN', name, '$')) || null;
      else if (type === 'TSDB-TYPE') {
        const info = (await client.call('TS.INFO', name)) as unknown;
        const flat = Array.isArray(info) ? info : [];
        const index = flat.findIndex((value) => String(value) === 'total_samples');
        size = index >= 0 ? Number(flat[index + 1]) : null;
      }
    } catch {
      size = null;
    }

    if (type === 'string') {
      const value = await client.get(name);
      return { key: name, type, ttl, size, encoding, columns: [{ name: 'value', type: 'string' }], rows: value === null ? [] : [[value]] };
    }
    if (type === 'hash') {
      const flat = (await client.hgetall(name)) as Record<string, string>;
      const rows = Object.entries(flat).slice(0, limit).map(([field, value]) => [field, value]);
      return {
        key: name,
        type,
        ttl,
        size,
        encoding,
        columns: [
          { name: 'field', type: 'string' },
          { name: 'value', type: 'string' },
        ],
        rows,
        note: Object.keys(flat).length > limit ? `仅显示前 ${limit} 个字段` : undefined,
      };
    }
    if (type === 'list') {
      const values = await client.lrange(name, 0, limit - 1);
      return { key: name, type, ttl, size, encoding, columns: [{ name: 'index', type: 'integer' }, { name: 'value', type: 'string' }], rows: values.map((value, index) => [index, value]) };
    }
    if (type === 'set') {
      const members = await client.smembers(name);
      return {
        key: name,
        type,
        ttl,
        size,
        encoding,
        columns: [{ name: 'member', type: 'string' }],
        rows: members.slice(0, limit).map((member) => [member]),
        note: members.length > limit ? `仅显示前 ${limit} 个成员` : undefined,
      };
    }
    if (type === 'zset') {
      const data = pairs(flattenPairs(await client.call('ZRANGE', name, '0', String(limit - 1), 'WITHSCORES')), 'member', 'score');
      return { key: name, type, ttl, size, encoding, columns: data.columns, rows: data.rows };
    }
    if (type === 'stream') {
      const raw = (await client.call('XRANGE', name, '-', '+', 'COUNT', String(limit))) as unknown[];
      const rows = (Array.isArray(raw) ? raw : []).map((entry) => {
        const pair = Array.isArray(entry) ? entry : [entry];
        const fields = Array.isArray(pair[1]) ? (pair[1] as unknown[]) : [];
        const object: Record<string, unknown> = {};
        for (let index = 0; index + 1 < fields.length; index += 2) object[String(fields[index])] = fields[index + 1];
        return [serialize(pair[0]), JSON.stringify(object)];
      });
      return {
        key: name,
        type,
        ttl,
        size,
        encoding,
        columns: [
          { name: 'id', type: 'string' },
          { name: 'fields', type: 'json' },
        ],
        rows,
      };
    }
    if (type === 'ReJSON-RL') {
      const raw = await client.call('JSON.GET', name);
      let pretty = String(raw ?? '');
      try {
        pretty = JSON.stringify(JSON.parse(String(raw)), null, 2);
      } catch {
        /* 非标准 JSON 时原样展示 */
      }
      return { key: name, type: 'json', ttl, size, encoding, columns: [{ name: 'json', type: 'json' }], rows: pretty ? [[pretty]] : [] };
    }
    if (type === 'TSDB-TYPE') {
      const samples = (await client.call('TS.RANGE', name, '-', '+', 'COUNT', String(limit))) as unknown[];
      return {
        key: name,
        type: 'timeseries',
        ttl,
        size,
        encoding,
        columns: [
          { name: 'timestamp', type: 'integer' },
          { name: 'value', type: 'string' },
        ],
        rows: (Array.isArray(samples) ? samples : []).map((sample) => {
          const pair = Array.isArray(sample) ? sample : [];
          return [serialize(pair[0]), serialize(pair[1])];
        }),
      };
    }
    return {
      key: name,
      type,
      ttl,
      size,
      encoding,
      columns: [{ name: 'value', type: 'string' }],
      rows: [],
      note: `暂不支持预览 ${type} 类型，可在命令窗口用对应命令读取`,
    };
  }

  /** 删除键走 UNLINK：值很大时由后台线程回收，不阻塞主线程。 */
  async createKey(input: CreateRedisKeyInput, database?: string): Promise<{ key: string; type: string; ttl: number }> {
    const name = input.key.trim();
    if (!name) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    const client = await this.ready(database);
    if (await client.exists(name)) throw new DbError(`键已存在：${name}`, { code: 'REDIS_KEY_EXISTS', status: 409 });
    const text = (value: unknown): string => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
    const value = input.value;
    try {
      if (input.type === 'string') {
        if (value === null || value === undefined || typeof value === 'object') {
          throw new DbError('string 键需要一个标量值', { code: 'REDIS_VALUE' });
        }
        await client.set(name, text(value));
      } else if (input.type === 'hash' || input.type === 'zset') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new DbError(`${input.type} 键需要一个对象`, { code: 'REDIS_VALUE' });
        }
        const entries = Object.entries(value as Record<string, unknown>);
        if (!entries.length) throw new DbError(`${input.type} 键至少需要一个成员`, { code: 'REDIS_VALUE' });
        if (input.type === 'hash') {
          await client.hset(name, ...entries.flatMap(([field, item]) => [field, text(item)]));
        } else {
          const args: Array<string | number> = [];
          for (const [member, score] of entries) {
            const numeric = Number(score);
            if (!Number.isFinite(numeric)) throw new DbError(`zset 成员 ${member} 的分数必须是数字`, { code: 'REDIS_VALUE' });
            args.push(numeric, member);
          }
          await client.zadd(name, ...args);
        }
      } else if (input.type === 'list' || input.type === 'set') {
        if (!Array.isArray(value) || !value.length) throw new DbError(`${input.type} 键需要一个非空数组`, { code: 'REDIS_VALUE' });
        const members = value.map(text);
        if (input.type === 'list') await client.rpush(name, ...members);
        else await client.sadd(name, ...members);
      } else {
        throw new DbError(`不支持的键类型：${input.type}`, { code: 'REDIS_TYPE' });
      }
    } catch (err) {
      if (err instanceof DbError) throw err;
      throw new DbError((err as any)?.message ?? `创建键失败：${name}`, { code: 'REDIS_CREATE' });
    }
    if (input.ttl !== undefined && input.ttl !== null) {
      if (!Number.isFinite(input.ttl) || input.ttl < 1) throw new DbError('TTL 需要是正整数秒', { code: 'REDIS_TTL' });
      await client.expire(name, Math.floor(input.ttl));
    }
    return { key: name, type: input.type, ttl: Number(await client.ttl(name)) };
  }

  async deleteKeys(keys: string[], database?: string): Promise<{ deleted: number }> {
    const names = keys.map((key) => key.trim()).filter(Boolean);
    if (!names.length) throw new DbError('至少要指定一个键', { code: 'REDIS_KEY' });
    const client = await this.ready(database);
    return { deleted: Number(await client.unlink(...names)) };
  }

  async dropIndex(name: string, database?: string): Promise<{ name: string; dropped: boolean }> {
    const target = name.trim();
    if (!target) throw new DbError('索引名不能为空', { code: 'REDIS_INDEX' });
    const client = await this.ready(database);
    try {
      await client.call('FT.DROPINDEX', target);
    } catch (err: any) {
      throw new DbError(err?.message ?? `删除索引失败：${target}`, { code: 'REDIS_DROP_INDEX' });
    }
    return { name: target, dropped: true };
  }

  /** seconds 为 null 时移除过期时间（PERSIST）。 */
  async setTtl(key: string, seconds: number | null, database?: string): Promise<{ key: string; ttl: number }> {
    const name = key.trim();
    if (!name) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    const client = await this.ready(database);
    if (seconds === null) {
      await client.persist(name);
    } else {
      if (!Number.isFinite(seconds) || seconds < 1) throw new DbError('TTL 需要是正整数秒', { code: 'REDIS_TTL' });
      const ok = await client.expire(name, Math.floor(seconds));
      if (!ok) throw new DbError(`键不存在，未设置 TTL：${name}`, { code: 'REDIS_KEY_NOT_FOUND', status: 404 });
    }
    return { key: name, ttl: Number(await client.ttl(name)) };
  }

  /** 写 hash 字段：字段不存在时新增，存在则覆盖；只接受 hash 类型。 */
  async setHashField(key: string, field: string, value: string, database?: string): Promise<{ key: string; field: string; created: boolean }> {
    const name = key.trim();
    const target = field.trim();
    if (!name) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    if (!target) throw new DbError('字段名不能为空', { code: 'REDIS_FIELD' });
    const client = await this.ready(database);
    const type = String(await client.type(name));
    if (type === 'none') throw new DbError(`键不存在：${name}`, { code: 'REDIS_KEY_NOT_FOUND', status: 404 });
    if (type !== 'hash') throw new DbError(`只能编辑 hash 字段，当前类型为 ${type}`, { code: 'REDIS_TYPE' });
    const existed = (await client.hexists(name, target)) === 1;
    await client.hset(name, target, value);
    return { key: name, field: target, created: !existed };
  }

  /** 删 hash 字段；最后一个字段删掉后 Redis 会自动删除整个键，这里如实回传。 */
  async deleteHashField(key: string, field: string, database?: string): Promise<{ key: string; field: string; deleted: boolean; keyGone: boolean }> {
    const name = key.trim();
    const target = field.trim();
    if (!name) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    if (!target) throw new DbError('字段名不能为空', { code: 'REDIS_FIELD' });
    const client = await this.ready(database);
    const type = String(await client.type(name));
    if (type === 'none') throw new DbError(`键不存在：${name}`, { code: 'REDIS_KEY_NOT_FOUND', status: 404 });
    if (type !== 'hash') throw new DbError(`只能删除 hash 字段，当前类型为 ${type}`, { code: 'REDIS_TYPE' });
    const deleted = Number(await client.hdel(name, target)) > 0;
    const keyGone = (await client.exists(name)) === 0;
    return { key: name, field: target, deleted, keyGone };
  }

  /** 编辑 string 键的取值；KEEPTTL 保留原过期时间，非 string 类型拒绝以免 SET 覆盖整个键。 */
  async setKeyValue(key: string, value: string, database?: string): Promise<{ key: string; type: string; ttl: number }> {
    const name = key.trim();
    if (!name) throw new DbError('键名不能为空', { code: 'REDIS_KEY' });
    const client = await this.ready(database);
    const type = String(await client.type(name));
    if (type === 'none') throw new DbError(`键不存在：${name}`, { code: 'REDIS_KEY_NOT_FOUND', status: 404 });
    if (type !== 'string') throw new DbError(`只能编辑 string 键的取值，当前类型为 ${type}`, { code: 'REDIS_TYPE' });
    await client.set(name, value, 'KEEPTTL');
    return { key: name, type: 'string', ttl: Number(await client.ttl(name)) };
  }

  async renameKey(from: string, to: string, database?: string): Promise<{ from: string; to: string }> {
    const source = from.trim();
    const target = to.trim();
    if (!source || !target) throw new DbError('原键名与目标键名必填', { code: 'REDIS_KEY' });
    if (source === target) throw new DbError('目标键名与原键名相同', { code: 'REDIS_RENAME' });
    const client = await this.ready(database);
    if (await client.exists(target)) throw new DbError(`键已存在：${target}`, { code: 'REDIS_RENAME_TAKEN', status: 409 });
    try {
      await client.rename(source, target);
    } catch (err: any) {
      throw new DbError(err?.message ?? `重命名失败：${source}`, { code: 'REDIS_RENAME' });
    }
    return { from: source, to: target };
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
