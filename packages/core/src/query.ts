import type { QueryLanguage, Risk } from './types';

export type QueryKind = 'read' | 'write' | 'ddl' | 'destructive';

export interface QuerySafety {
  risk: Risk;
  kind: QueryKind;
  reason?: string;
}

export type MqlOperation = 'find' | 'aggregate' | 'count' | 'distinct';

/** MongoDB 的结构化查询；执行前不拼接 shell 字符串。 */
export interface MqlQuery {
  language: 'mql';
  collection: string;
  op: MqlOperation;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
  skip?: number;
  field?: string;
}

export interface RedisQuery {
  language: 'redis';
  command: string;
  args?: string[];
}

export interface CypherQuery {
  language: 'cypher';
  text: string;
  params?: Record<string, unknown>;
}

export interface VectorQuery {
  language: 'vector';
  collection: string;
  op?: 'search' | 'scroll';
  vector?: number[];
  text?: string;
  topK: number;
  filter?: Record<string, unknown>;
  field?: string;
}

export interface SearchQuery {
  language: 'search';
  index: string;
  body?: Record<string, unknown>;
  size?: number;
}

export interface CqlQuery {
  language: 'cql';
  text: string;
  params?: unknown[];
}

export interface AqlQuery {
  language: 'aql';
  text: string;
  params?: Record<string, unknown>;
}

export type StructuredQuery = MqlQuery | RedisQuery | CypherQuery | VectorQuery | SearchQuery | CqlQuery | AqlQuery;

export function queryLanguageOf(query: StructuredQuery): QueryLanguage {
  return query.language;
}

export function formatStructuredQuery(query: StructuredQuery): string {
  if (query.language === 'mql') return JSON.stringify(query);
  if (query.language === 'cypher') return query.text;
  if (query.language === 'vector') return JSON.stringify(query);
  if (query.language === 'search') return JSON.stringify(query);
  if (query.language === 'cql') return query.text;
  if (query.language === 'aql') return query.text;
  return [query.command, ...(query.args ?? [])].join(' ');
}

/** 把模型传入的工具参数归一化为 MQL；缺省 op 按是否带 pipeline/field 推断。 */
export function mqlQueryFromArgs(args: Record<string, unknown>): MqlQuery {
  const collection = typeof args.collection === 'string' ? args.collection : '';
  const op =
    args.op === 'aggregate' || args.op === 'count' || args.op === 'distinct' || args.op === 'find'
      ? args.op
      : Array.isArray(args.pipeline)
        ? 'aggregate'
        : typeof args.field === 'string'
          ? 'distinct'
          : 'find';
  const query: MqlQuery = { language: 'mql', collection, op };
  if (args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)) query.filter = args.filter as Record<string, unknown>;
  if (Array.isArray(args.pipeline)) query.pipeline = args.pipeline as Record<string, unknown>[];
  if (args.projection && typeof args.projection === 'object' && !Array.isArray(args.projection)) query.projection = args.projection as Record<string, unknown>;
  if (args.sort && typeof args.sort === 'object' && !Array.isArray(args.sort)) query.sort = args.sort as Record<string, unknown>;
  if (typeof args.limit === 'number') query.limit = args.limit;
  if (typeof args.skip === 'number') query.skip = args.skip;
  if (typeof args.field === 'string') query.field = args.field;
  return query;
}

export function redisQueryFromArgs(args: Record<string, unknown>): RedisQuery {
  return {
    language: 'redis',
    command: typeof args.command === 'string' ? args.command : '',
    args: Array.isArray(args.args) ? args.args.map((arg) => String(arg)) : [],
  };
}

export function cypherQueryFromArgs(args: Record<string, unknown>): CypherQuery {
  const text = typeof args.query === 'string' ? args.query : typeof args.cypher === 'string' ? args.cypher : '';
  const params =
    args.params && typeof args.params === 'object' && !Array.isArray(args.params)
      ? (args.params as Record<string, unknown>)
      : undefined;
  return { language: 'cypher', text, params };
}

export function vectorQueryFromArgs(args: Record<string, unknown>): VectorQuery {
  const vector = Array.isArray(args.vector)
    ? args.vector.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : undefined;
  const query: VectorQuery = {
    language: 'vector',
    collection: typeof args.collection === 'string' ? args.collection : '',
    topK: Math.max(1, Math.min(1000, Number(args.topK) || 10)),
  };
  if (vector && vector.length) query.vector = vector;
  if (typeof args.text === 'string' && args.text.trim()) query.text = args.text.trim();
  if (typeof args.field === 'string' && args.field.trim()) query.field = args.field.trim();
  if (args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)) query.filter = args.filter as Record<string, unknown>;
  if (args.op === 'scroll' || args.op === 'search') query.op = args.op;
  return query;
}

export function searchQueryFromArgs(args: Record<string, unknown>): SearchQuery {
  const query: SearchQuery = {
    language: 'search',
    index: typeof args.index === 'string' ? args.index : '',
  };
  if (args.body && typeof args.body === 'object' && !Array.isArray(args.body)) query.body = args.body as Record<string, unknown>;
  else if (args.query && typeof args.query === 'object' && !Array.isArray(args.query)) query.body = { query: args.query };
  if (typeof args.size === 'number') query.size = args.size;
  return query;
}

export function cqlQueryFromArgs(args: Record<string, unknown>): CqlQuery {
  return {
    language: 'cql',
    text: typeof args.query === 'string' ? args.query : typeof args.cql === 'string' ? args.cql : '',
    params: Array.isArray(args.params) ? args.params : undefined,
  };
}

export function aqlQueryFromArgs(args: Record<string, unknown>): AqlQuery {
  const params =
    args.params && typeof args.params === 'object' && !Array.isArray(args.params)
      ? (args.params as Record<string, unknown>)
      : undefined;
  return {
    language: 'aql',
    text: typeof args.query === 'string' ? args.query : typeof args.aql === 'string' ? args.aql : '',
    params,
  };
}

const MQL_RISK: Record<string, QueryKind> = {
  $out: 'destructive',
  $merge: 'destructive',
  $where: 'destructive',
  $function: 'destructive',
  $accumulator: 'destructive',
  $changeStream: 'write',
  $currentOp: 'write',
  $listSessions: 'write',
  $listLocalSessions: 'write',
  $planCacheStats: 'write',
};

const MQL_REASON: Record<string, string> = {
  $out: '聚合管道会写入集合（$out）',
  $merge: '聚合管道会写入集合（$merge）',
  $where: 'MongoDB 服务端脚本执行（$where）',
  $function: 'MongoDB 服务端脚本执行（$function）',
  $accumulator: 'MongoDB 服务端脚本执行（$accumulator）',
  $changeStream: '变更流需要长连接与额外权限',
  $currentOp: '系统诊断管道不在普通查询范围内',
  $listSessions: '系统诊断管道不在普通查询范围内',
  $listLocalSessions: '系统诊断管道不在普通查询范围内',
  $planCacheStats: '系统诊断管道不在普通查询范围内',
};

function scanMqlKeys(value: unknown, found: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) scanMqlKeys(item, found);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MQL_RISK[key]) found.add(key);
    scanMqlKeys(child, found);
  }
}

export function classifyMql(query: MqlQuery): QuerySafety {
  if (!query.collection || query.collection.includes('\u0000')) {
    return { risk: 'destructive', kind: 'destructive', reason: '集合名非法' };
  }
  if (!['find', 'aggregate', 'count', 'distinct'].includes(query.op)) {
    return { risk: 'destructive', kind: 'destructive', reason: `不支持的 MongoDB 操作：${query.op}` };
  }
  if (query.op === 'aggregate' && (!Array.isArray(query.pipeline) || query.pipeline.length === 0)) {
    return { risk: 'destructive', kind: 'destructive', reason: '聚合管道为空' };
  }
  if (query.op === 'distinct' && !query.field) {
    return { risk: 'destructive', kind: 'destructive', reason: 'distinct 缺少字段名' };
  }

  const found = new Set<string>();
  scanMqlKeys(query.filter, found);
  scanMqlKeys(query.pipeline, found);
  scanMqlKeys(query.projection, found);
  scanMqlKeys(query.sort, found);

  let worst: QuerySafety = { risk: 'read', kind: 'read' };
  const rank: Record<Risk, number> = { read: 0, write: 1, ddl: 2, destructive: 3 };
  for (const key of found) {
    const kind = MQL_RISK[key];
    const candidate: QuerySafety = { risk: kind === 'write' ? 'write' : 'destructive', kind, reason: MQL_REASON[key] };
    if (rank[candidate.risk] > rank[worst.risk]) worst = candidate;
  }
  return worst;
}

const REDIS_READ = new Set([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'SUBSTR', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'SCAN', 'KEYS', 'RANDOMKEY', 'DBSIZE',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSTRLEN', 'HRANDFIELD', 'HSCAN',
  'LLEN', 'LRANGE', 'LINDEX', 'LPOS', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SRANDMEMBER', 'SSCAN',
  'ZCARD', 'ZCOUNT', 'ZSCORE', 'ZMSCORE', 'ZRANK', 'ZREVRANK', 'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE',
  'ZRANGEBYLEX', 'ZREVRANGEBYLEX', 'ZSCAN', 'XLEN', 'XRANGE', 'XREVRANGE', 'XPENDING', 'XINFO',
  'BITCOUNT', 'GETBIT', 'BITPOS', 'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO',
  'INFO', 'PING', 'ECHO', 'TIME', 'LASTSAVE', 'COMMAND', 'OBJECT', 'MEMORY', 'DUMP', 'SLOWLOG', 'LOLWUT',
  'CLUSTER', 'ACL', 'SCRIPT', 'FUNCTION', 'FT.SEARCH', 'FT.AGGREGATE', 'FT.INFO', 'FT.EXPLAIN', 'FT._LIST',
  'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'JSON.ARRLEN', 'JSON.OBJLEN', 'JSON.KEYS', 'JSON.STRLEN',
  'TS.INFO', 'TS.RANGE', 'TS.MRANGE', 'TS.QUERYINDEX', 'TS.MGET',
]);

const REDIS_WRITE = new Set([
  'SET', 'SETEX', 'PSETEX', 'SETNX', 'MSET', 'MSETNX', 'APPEND', 'INCR', 'DECR', 'INCRBY', 'DECRBY', 'INCRBYFLOAT',
  'GETSET', 'GETDEL', 'GETEX', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST', 'RENAME',
  'RENAMENX', 'MOVE', 'COPY', 'RESTORE', 'HSET', 'HSETNX', 'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT',
  'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'LSET', 'LINSERT', 'LREM', 'LTRIM', 'RPOPLPUSH', 'LMOVE',
  'SADD', 'SREM', 'SPOP', 'SMOVE', 'ZADD', 'ZREM', 'ZINCRBY', 'ZPOPMIN', 'ZPOPMAX', 'ZREMRANGEBYRANK',
  'ZREMRANGEBYSCORE', 'ZREMRANGEBYLEX', 'ZDIFFSTORE', 'ZINTERSTORE', 'ZUNIONSTORE', 'ZRANGESTORE',
  'XADD', 'XDEL', 'XTRIM', 'XGROUP', 'XACK', 'XCLAIM', 'XAUTOCLAIM', 'SETBIT', 'BITOP', 'BITFIELD', 'PFADD', 'PFMERGE',
  'GEOADD', 'GEOSEARCHSTORE', 'JSON.SET', 'JSON.DEL', 'JSON.NUMINCRBY', 'JSON.STRAPPEND', 'JSON.ARRAPPEND', 'JSON.ARRINSERT',
  'JSON.ARRPOP', 'JSON.ARRTRIM', 'JSON.TOGGLE', 'JSON.CLEAR', 'FT.CREATE', 'FT.DROPINDEX', 'FT.ALTER',
  'TS.ADD', 'TS.CREATE', 'TS.INCRBY', 'TS.DECRBY', 'TS.DEL', 'TS.ALTER',
]);

const REDIS_DESTRUCTIVE = new Set([
  'FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'SWAPDB', 'MIGRATE', 'REPLICAOF', 'SLAVEOF', 'MONITOR', 'SYNC', 'PSYNC',
  'EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO', 'DEBUG', 'MODULE', 'SAVE', 'BGSAVE', 'BGREWRITEAOF',
  'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'BLPOP', 'BRPOP', 'BLMOVE',
]);

function redisSubcommand(command: string, args: string[]): string {
  return (args[0] ?? '').toUpperCase();
}

export function classifyRedis(query: RedisQuery): QuerySafety {
  const command = query.command.trim().toUpperCase();
  if (!command) return { risk: 'destructive', kind: 'destructive', reason: '空命令' };
  const args = query.args ?? [];
  const sub = redisSubcommand(command, args);

  if (command === 'SELECT') return { risk: 'write', kind: 'write', reason: '请使用数据库下拉切换 Redis DB' };
  if (command === 'CONFIG') {
    return sub === 'GET' || sub === 'HELP'
      ? { risk: 'read', kind: 'read' }
      : { risk: 'destructive', kind: 'destructive', reason: 'CONFIG 会修改服务端配置' };
  }
  if (command === 'ACL') {
    return ['WHOAMI', 'LIST', 'GETUSER', 'CAT', 'USERS'].includes(sub)
      ? { risk: 'read', kind: 'read' }
      : { risk: 'destructive', kind: 'destructive', reason: 'ACL 会修改用户权限' };
  }
  if (command === 'SCRIPT') {
    return ['EXISTS'].includes(sub) ? { risk: 'read', kind: 'read' } : { risk: 'destructive', kind: 'destructive', reason: '脚本缓存操作需要确认' };
  }
  if (command === 'FUNCTION') {
    return ['LIST', 'STATS', 'DUMP'].includes(sub) ? { risk: 'read', kind: 'read' } : { risk: 'destructive', kind: 'destructive', reason: '函数管理操作需要确认' };
  }
  if (command === 'CLUSTER') {
    return ['INFO', 'NODES', 'SLOTS', 'SHARDS', 'MYID', 'COUNTKEYSINSLOT', 'GETKEYSINSLOT', 'KEYSLOT'].includes(sub)
      ? { risk: 'read', kind: 'read' }
      : { risk: 'destructive', kind: 'destructive', reason: '集群管理操作需要确认' };
  }
  if (command === 'MEMORY') {
    return sub === 'USAGE' || sub === 'STATS' || sub === 'DOCTOR' || sub === 'MALLOC-STATS'
      ? { risk: 'read', kind: 'read' }
      : { risk: 'write', kind: 'write', reason: 'MEMORY 子命令会改变服务端状态' };
  }
  if (REDIS_DESTRUCTIVE.has(command)) {
    return { risk: 'destructive', kind: 'destructive', reason: `${command} 可能造成数据丢失或服务中断` };
  }
  if (REDIS_READ.has(command)) return { risk: 'read', kind: 'read' };
  if (REDIS_WRITE.has(command)) return { risk: 'write', kind: 'write' };
  return { risk: 'write', kind: 'write', reason: `未识别的 Redis 命令：${command}` };
}

/** 供 manager / agent 共用的只读拒绝文案。 */
export function readonlyViolationForQuery(query: StructuredQuery): string | null {
  const safety =
    query.language === 'mql'
      ? classifyMql(query)
      : query.language === 'redis'
        ? classifyRedis(query)
        : query.language === 'cypher'
          ? classifyCypher(query)
          : query.language === 'vector'
            ? classifyVector(query)
            : query.language === 'search'
              ? classifySearch(query)
              : query.language === 'aql'
                ? classifyAql(query)
                : classifyCql(query);
  if (safety.kind === 'read') return null;
  const label =
    query.language === 'mql'
      ? 'MongoDB 写操作'
      : query.language === 'redis'
        ? (query as RedisQuery).command
        : query.language === 'cypher'
          ? 'Cypher 写操作'
          : query.language === 'vector'
            ? '向量写操作'
            : query.language === 'search'
              ? '搜索写操作'
              : query.language === 'aql'
                ? 'AQL 写操作'
                : 'CQL 写操作';
  return `只读连接不允许执行 ${label}${safety.reason ? `（${safety.reason}）` : ''}`;
}

function maskCypher(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < n) {
        if (text[i] === '\\' && quote !== '`') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          out += quote;
          i++;
          break;
        }
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const CYPHER_READ_PROCEDURE =
  /^(DB\.(LABELS|RELATIONSHIPTYPES|PROPERTYKEYS|INDEXES|CONSTRAINTS|INFO|SCHEMA\.VISUALIZATION)|DBMS\.(LISTQUERIES|LISTTRANSACTIONS|SHOWCURRENTUSER))$/;

export function classifyCypher(query: CypherQuery): QuerySafety {
  const text = query.text.trim();
  if (!text) return { risk: 'destructive', kind: 'destructive', reason: '空 Cypher' };
  const code = maskCypher(text).toUpperCase();
  if (/^\s*EXPLAIN\b/.test(code)) return { risk: 'read', kind: 'read' };

  const body = code.replace(/^\s*PROFILE\s+/, '');
  if (/\b(CREATE|DROP)\s+(INDEX|CONSTRAINT|DATABASE|USER|ROLE|ALIAS|SERVER|FUNCTION|PROCEDURE)\b/.test(body)) {
    return /\bDROP\b/.test(body)
      ? { risk: 'destructive', kind: 'destructive', reason: '删除索引/约束/库对象' }
      : { risk: 'ddl', kind: 'ddl' };
  }
  if (/\b(DROP|DETACH\s+DELETE|DELETE|TERMINATE|KILL)\b/.test(body)) {
    return { risk: 'destructive', kind: 'destructive', reason: 'Cypher 删除/终止操作' };
  }
  if (/\b(CREATE|MERGE|SET|REMOVE|LOAD\s+CSV|FOREACH)\b/.test(body)) {
    return { risk: 'write', kind: 'write' };
  }

  const calls = [...body.matchAll(/\bCALL\s+([A-Z0-9_.]+)/g)].map((match) => match[1]);
  for (const procedure of calls) {
    if (procedure.startsWith('APOC.') || procedure.startsWith('GDS.')) {
      return { risk: 'write', kind: 'write', reason: `CALL ${procedure}` };
    }
    if ((procedure.startsWith('DB.') || procedure.startsWith('DBMS.')) && !CYPHER_READ_PROCEDURE.test(procedure)) {
      return { risk: 'write', kind: 'write', reason: `CALL ${procedure}` };
    }
  }
  return { risk: 'read', kind: 'read' };
}

export function classifyVector(query: VectorQuery): QuerySafety {
  if (!query.collection || !query.collection.trim()) {
    return { risk: 'destructive', kind: 'destructive', reason: '向量集合名不能为空' };
  }
  if (!Number.isFinite(query.topK) || query.topK < 1 || query.topK > 1000) {
    return { risk: 'destructive', kind: 'destructive', reason: 'topK 必须在 1-1000 之间' };
  }
  if (query.vector && query.vector.some((value) => !Number.isFinite(value))) {
    return { risk: 'destructive', kind: 'destructive', reason: '向量必须全部是有限数值' };
  }
  return { risk: 'read', kind: 'read' };
}

export function classifySearch(query: SearchQuery): QuerySafety {
  if (!query.index || !query.index.trim()) {
    return { risk: 'destructive', kind: 'destructive', reason: '索引名不能为空' };
  }
  if (query.size !== undefined && (!Number.isFinite(query.size) || query.size < 1 || query.size > 10000)) {
    return { risk: 'destructive', kind: 'destructive', reason: 'size 必须在 1-10000 之间' };
  }
  return { risk: 'read', kind: 'read' };
}

export function classifyCql(query: CqlQuery): QuerySafety {
  const text = query.text.trim();
  if (!text) return { risk: 'destructive', kind: 'destructive', reason: '空 CQL' };
  const code = maskCypher(text)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ' '))
    .join('\n')
    .toUpperCase();
  const head = code.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  if (/^(SELECT|DESCRIBE|USE|LIST|TRACING)\b/.test(head)) return { risk: 'read', kind: 'read' };
  if (/^(CREATE|ALTER|GRANT|REVOKE)\b/.test(head)) return { risk: 'ddl', kind: 'ddl' };
  if (/^(TRUNCATE|DROP)\b/.test(head)) return { risk: 'destructive', kind: 'destructive', reason: 'CQL 删除/清空操作' };
  if (/^(DELETE)\b/.test(head)) {
    return /\bWHERE\b/.test(code)
      ? { risk: 'write', kind: 'write' }
      : { risk: 'destructive', kind: 'destructive', reason: 'DELETE 缺少 WHERE' };
  }
  if (/^(INSERT|UPDATE|COPY)\b/.test(head)) return { risk: 'write', kind: 'write' };
  if (/^BEGIN\s+(UNLOGGED\s+)?BATCH\b/.test(head)) {
    if (/\b(TRUNCATE|DROP)\b/.test(code)) return { risk: 'destructive', kind: 'destructive', reason: 'BATCH 含删除/清空' };
    return { risk: 'write', kind: 'write' };
  }
  return { risk: 'ddl', kind: 'ddl' };
}

export function classifyAql(query: AqlQuery): QuerySafety {
  const text = query.text.trim();
  if (!text) return { risk: 'destructive', kind: 'destructive', reason: '空 AQL' };
  const code = maskCypher(text)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ' '))
    .join('\n')
    .toUpperCase();
  if (/\b(DROP|TRUNCATE)\b/.test(code)) {
    return { risk: 'destructive', kind: 'destructive', reason: 'AQL 删除集合/数据操作' };
  }
  if (/\b(COLLECTION|DB|VIEW)\s*\(/.test(code)) {
    return { risk: 'ddl', kind: 'ddl', reason: 'AQL 可能创建集合/库/视图' };
  }
  if (/\bINSERT\b[^]*\bINTO\b[^]*\b(COLLECTION|DB)\s*\(/.test(code)) {
    return { risk: 'ddl', kind: 'ddl', reason: 'INSERT INTO 不存在的集合会创建集合' };
  }
  if (/\bREMOVE\b/.test(code)) {
    return /\bFILTER\b/.test(code)
      ? { risk: 'write', kind: 'write' }
      : { risk: 'destructive', kind: 'destructive', reason: 'REMOVE 缺少 FILTER 过滤' };
  }
  if (/\b(INSERT|UPDATE|REPLACE|UPSERT)\b/.test(code)) return { risk: 'write', kind: 'write' };
  if (/^FOR\b/.test(code) || /\bRETURN\b/.test(code)) return { risk: 'read', kind: 'read' };
  return { risk: 'ddl', kind: 'ddl', reason: '未识别的 AQL 语句' };
}

/** 把一行 Redis 命令拆成命令名与参数，支持单双引号。 */
export function parseRedisCommandLine(line: string): RedisQuery | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of line.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char as '"' | "'";
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  if (!tokens.length) return null;
  return { language: 'redis', command: tokens[0], args: tokens.slice(1) };
}
