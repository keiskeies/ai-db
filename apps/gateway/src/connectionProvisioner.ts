import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  engineDefaultPort,
  engineMeta,
  ENGINES,
  isEngine,
  isSecretToolArgKey,
  probeCandidates,
  PROBE_RANK,
  type ConnectionConfig,
  type ConnectionSecret,
  type Engine,
} from '@aidb/core';
import { DbError } from './drivers';
import type { GatewayEvents } from './events';
import type { ConnectionManager } from './manager';
import type { Store } from './store';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_CONCURRENCY = 4;
const PASSWORD_REF_TTL_MS = 5 * 60 * 1000;

export type ProbeOutcome = 'connected' | 'auth_failed' | 'unknown';
export type ProbeFailureCategory = 'auth_failed' | 'unreachable' | 'protocol_mismatch' | 'unknown';

export interface ProbeMatch {
  engine: Engine;
  label: string;
  version?: string;
  latencyMs: number;
}

export interface ProbeResult {
  host: string;
  port: number;
  outcome: ProbeOutcome;
  protocolMatches: ProbeMatch[];
  recommendation?: Engine;
  portHintEngines: Engine[];
  failures: Array<{ engine: Engine; category: ProbeFailureCategory; message: string }>;
  passwordRef?: string;
}

export interface CreateConnectionResult {
  connection: ConnectionConfig;
  tested: boolean;
  version?: string;
  warning?: string;
}

interface CredentialRef {
  password: string;
  host: string;
  resolvedHost: string;
  port: number;
  username: string;
  expiresAt: number;
}

interface ProbeAttempt {
  transport: string;
  engine: Engine;
}

export class DuplicateConnectionError extends DbError {
  constructor(readonly connectionId: string) {
    super('相同地址、端口、用户和数据库的连接已存在', { code: 'CONNECTION_DUPLICATE', status: 409 });
  }
}

function ipv6Groups(address: string): number[] | undefined {
  let ip = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const ipv4 = ip.slice(lastColon + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const groups = parts.map((part) => parseInt(part, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

function reservedIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (a === 169 && b === 254) || ip === '0.0.0.0' || ip === '100.100.100.200';
}

export function isReservedProbeAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(ip) === 4) return reservedIpv4(ip);
  if (isIP(ip) !== 6) return false;
  const groups = ipv6Groups(ip);
  if (!groups) return false;
  if (groups.every((group) => group === 0)) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return reservedIpv4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return reservedIpv4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  return false;
}

function normalizeHost(value: unknown): string {
  const host = String(value ?? '').trim().replace(/^\[|\]$/g, '');
  if (!host) throw new DbError('host 不能为空', { code: 'INVALID_HOST', status: 400 });
  const lower = host.toLowerCase();
  if (lower === 'metadata.google.internal' || lower.endsWith('.metadata.google.internal')) {
    throw new DbError('不允许探测云元数据地址', { code: 'RESERVED_ADDRESS', status: 400 });
  }
  if (isReservedProbeAddress(host)) throw new DbError('不允许探测保留或链路本地地址', { code: 'RESERVED_ADDRESS', status: 400 });
  return host;
}

async function resolveProbeHost(host: string, ssl: boolean, sslInsecure: boolean): Promise<string> {
  if (isIP(host)) return host;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new DbError(`无法解析主机：${host}`, { code: 'HOST_NOT_RESOLVABLE', status: 400 });
  }
  if (addresses.some((item) => isReservedProbeAddress(item.address))) {
    throw new DbError('不允许探测解析到保留或链路本地地址的主机', { code: 'RESERVED_ADDRESS', status: 400 });
  }
  // Agent 工具把校验后的 IP 固定给驱动，避免 DNS rebinding。需要严格校验证书的主机名 TLS
  // 无法安全地表为 IP（会丢 SNI），这类连接交给连接编辑器。
  if (ssl && !sslInsecure) throw new DbError('Agent 建连暂不支持主机名 + 严格 TLS，请使用 IP 或在连接编辑器中创建', { code: 'TLS_HOSTNAME_REQUIRES_IP', status: 400 });
  return addresses[0]?.address ?? host;
}

function endpointPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DbError('port 必须是 1-65535 的整数', { code: 'INVALID_PORT', status: 400 });
  return port;
}

export function classifyProbeFailure(result: { code?: string; message?: string }): ProbeFailureCategory {
  const code = String(result.code ?? '').toUpperCase();
  const message = String(result.message ?? '');
  if (
    code === 'ER_ACCESS_DENIED_ERROR' || code === '28P01' || code === 'ORA-01017' || code === 'NOAUTH' || code === 'WRONGPASS' || code === 'SEARCH_401' ||
    /access denied for user|password authentication failed|authentication failed|login failed for user|invalid username\s*\/\s*password|\bORA-01017\b|\bNOAUTH\b|\bWRONGPASS\b|security_exception|missing authentication credentials|unauthorized|\b401\b/i.test(message)
  ) return 'auth_failed';
  if (
    code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_AGAIN' || code === 'CLICKHOUSE_TIMEOUT' ||
    /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connection (?:timed out|timeout)|connect timeout|timed out|ClickHouse 查询超时/i.test(message)
  ) return 'unreachable';
  if (
    code === 'EPROTO' || /protocol error|unsupported (?:protocol|message|startup)|invalid handshake|handshake (?:failure|failed)|unexpected packet|invalid packet|packet sequence|parse error/i.test(message)
  ) return 'protocol_mismatch';
  return 'unknown';
}

function draftConfig(engine: Engine, host: string, port: number, username: string, database?: string, ssl?: boolean, sslInsecure?: boolean): ConnectionConfig {
  const now = new Date().toISOString();
  return {
    id: 'probe',
    name: 'probe',
    engine,
    color: 'blue',
    environment: 'dev',
    groupName: '',
    host,
    port,
    database,
    username,
    ssl,
    sslInsecure,
    readonly: false,
    createdAt: now,
    updatedAt: now,
  };
}

function timeoutResult(engine: Engine): { ok: false; latencyMs: number; message: string; code: string } {
  return { ok: false, latencyMs: PROBE_TIMEOUT_MS, message: `探测 ${engine} 超时`, code: 'ETIMEDOUT' };
}

async function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const VERSION_ENGINE_HINTS: Array<[Engine, RegExp]> = [
  ['tidb', /TiDB/i], ['oceanbase', /OceanBase/i], ['mariadb', /MariaDB/i], ['greatsql', /GreatSQL/i],
  ['goldendb', /GoldenDB/i], ['tdsql', /TDSQL/i], ['polardb', /PolarDB/i], ['opengauss', /openGauss/i],
  ['gaussdb', /GaussDB/i], ['vastbase', /Vastbase/i], ['ivorysql', /IvorySQL/i], ['timescale', /Timescale/i],
  ['cockroachdb', /Cockroach/i], ['starrocks', /StarRocks/i], ['doris', /Doris/i],
  ['opensearch', /OpenSearch/i], ['elasticsearch', /Elasticsearch/i], ['falkordb', /FalkorDB/i],
];

export class ConnectionProvisioner {
  private credentialRefs = new Map<string, CredentialRef>();
  private createLocks = new Map<string, Promise<void>>();

  constructor(private store: Store, private manager: ConnectionManager, private events?: GatewayEvents) {}

  private savedPassword(host: string, port: number, username: string): string | undefined {
    const wantedHost = host.toLowerCase();
    const connection = this.store.listConnections().find((item) =>
      String(item.host ?? '').toLowerCase().replace(/^\[|\]$/g, '') === wantedHost && item.port === port && item.username === username,
    );
    return connection ? this.store.getConnectionSecret(connection.id).password : undefined;
  }

  private issuePasswordRef(password: string | undefined, host: string, resolvedHost: string, port: number, username: string): string | undefined {
    if (password === undefined) return undefined;
    const now = Date.now();
    for (const [ref, value] of this.credentialRefs) if (value.expiresAt <= now) this.credentialRefs.delete(ref);
    const ref = randomUUID();
    this.credentialRefs.set(ref, { password, host: host.toLowerCase(), resolvedHost, port, username, expiresAt: now + PASSWORD_REF_TTL_MS });
    return ref;
  }

  private consumePasswordRef(ref: unknown, host: string, resolvedHost: string, port: number, username: string): string | undefined {
    if (typeof ref !== 'string' || !ref) return undefined;
    const value = this.credentialRefs.get(ref);
    if (!value) throw new DbError('passwordRef 无效或已过期，请重新调用 probe_engine', { code: 'INVALID_PASSWORD_REF', status: 400 });
    this.credentialRefs.delete(ref);
    if (value.expiresAt <= Date.now()) throw new DbError('passwordRef 已过期，请重新调用 probe_engine', { code: 'INVALID_PASSWORD_REF', status: 400 });
    if (value.host !== host.toLowerCase() || value.resolvedHost !== resolvedHost || value.port !== port || value.username !== username) {
      throw new DbError('passwordRef 与目标地址不匹配', { code: 'PASSWORD_REF_MISMATCH', status: 400 });
    }
    return value.password;
  }

  private attempts(port: number): ProbeAttempt[] {
    const seen = new Set<string>();
    const attempts: ProbeAttempt[] = [];
    for (const engine of probeCandidates(port)) {
      const transport = engineMeta(engine).transport;
      if (seen.has(transport)) continue;
      seen.add(transport);
      attempts.push({ transport, engine });
    }
    return attempts;
  }

  private familyCandidates(attempts: ProbeAttempt[], port: number): Engine[] {
    const transports = new Set(attempts.map((item) => item.transport));
    const hinted = probeCandidates(port);
    const family = hinted.filter((engine) => transports.has(engineMeta(engine).transport));
    const rest = ENGINES.filter((item) => !item.fileBased && transports.has(item.transport) && !family.includes(item.id))
      .sort((a, b) => Number(PROBE_RANK.includes(b.id)) - Number(PROBE_RANK.includes(a.id)))
      .map((item) => item.id);
    return [...family, ...rest];
  }

  async probe(input: { host: unknown; port: unknown; username: unknown; database?: unknown; ssl?: unknown; sslInsecure?: unknown }): Promise<ProbeResult> {
    const displayHost = normalizeHost(input.host);
    const ssl = input.ssl === true;
    const host = await resolveProbeHost(displayHost, ssl, input.sslInsecure === true);
    const port = endpointPort(input.port);
    const username = String(input.username ?? '').trim();
    if (!username) throw new DbError('username 不能为空', { code: 'INVALID_USERNAME', status: 400 });
    const database = typeof input.database === 'string' && input.database ? input.database : undefined;
    const password = this.savedPassword(displayHost, port, username) ?? (host !== displayHost ? this.savedPassword(host, port, username) : undefined);
    const secret: ConnectionSecret = password === undefined ? {} : { password };
    const attempts = this.attempts(port);
    const results = new Map<string, Awaited<ReturnType<ConnectionManager['testConfig']>>>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < attempts.length) {
        const attempt = attempts[cursor++];
        const config = draftConfig(attempt.engine, host, port, username, database, ssl);
        const pending = this.manager.testConfig(config, secret).catch((err: any) => ({ ok: false as const, latencyMs: 0, message: err?.message ?? '连接失败', code: typeof err?.code === 'string' ? err.code : undefined }));
        const result = await withTimeout(pending, timeoutResult(attempt.engine));
        results.set(attempt.transport, result);
        // 超时候选直接退休，不再用这个 worker 起新尝试；底层驱动继续按自身超时收尾。
        // 这样既不让实际并发超过 4，也不会把整个探测卡在 HTTP 驱动的 30 秒超时上。
        if (result.code === 'ETIMEDOUT' && result.latencyMs >= PROBE_TIMEOUT_MS) return;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, attempts.length) }, worker));

    const connected = attempts.filter((attempt) => results.get(attempt.transport)?.ok);
    const authFailed = attempts.filter((attempt) => !results.get(attempt.transport)?.ok && classifyProbeFailure(results.get(attempt.transport) ?? {}) === 'auth_failed');
    const recognized = connected.length ? connected : authFailed;
    const candidates = this.familyCandidates(recognized.length ? recognized : attempts, port);
    const version = connected.map((attempt) => results.get(attempt.transport)?.version ?? '').join(' ');
    const hintedEngine = VERSION_ENGINE_HINTS.find(([, pattern]) => pattern.test(version))?.[0];
    const protocolMatches: ProbeMatch[] = recognized.length
      ? candidates.map((engine) => {
          const attempt = recognized.find((item) => item.transport === engineMeta(engine).transport)!;
          const result = results.get(attempt.transport)!;
          return { engine, label: engineMeta(engine).label, version: result.ok ? result.version : undefined, latencyMs: result.latencyMs };
        }).sort((a, b) => Number(b.engine === hintedEngine) - Number(a.engine === hintedEngine))
      : [];
    const failures = attempts.filter((attempt) => !results.get(attempt.transport)?.ok).map((attempt) => {
      const result = results.get(attempt.transport)!;
      return { engine: attempt.engine, category: classifyProbeFailure(result), message: result.message ?? '无法识别' };
    });
    const outcome: ProbeOutcome = connected.length ? 'connected' : authFailed.length ? 'auth_failed' : 'unknown';
    return {
      host: displayHost,
      port,
      outcome,
      protocolMatches,
      recommendation: protocolMatches[0]?.engine,
      portHintEngines: probeCandidates(port),
      failures,
      passwordRef: outcome === 'connected' ? this.issuePasswordRef(password, displayHost, host, port, username) : undefined,
    };
  }

  private async acquireCreateLock(key: string): Promise<() => void> {
    const previous = this.createLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.createLocks.set(key, current);
    await previous;
    return () => {
      release();
      if (this.createLocks.get(key) === current) this.createLocks.delete(key);
    };
  }

  async create(input: Record<string, unknown>): Promise<CreateConnectionResult> {
    for (const key of Object.keys(input)) {
      if (isSecretToolArgKey(key)) throw new DbError('create_connection 不接受明文密码，请在连接编辑器中输入', { code: 'PASSWORD_NOT_ACCEPTED', status: 400 });
    }
    if (!isEngine(input.engine)) throw new DbError(`不支持的数据库类型：${String(input.engine ?? '')}`, { code: 'INVALID_ENGINE', status: 400 });
    const engine = input.engine;
    if (engineMeta(engine).fileBased) throw new DbError('Agent 建连不支持 SQLite/DuckDB 文件路径，请在连接编辑器中创建', { code: 'FILE_ENGINE_NOT_SUPPORTED', status: 400 });
    const displayHost = normalizeHost(input.host);
    const host = await resolveProbeHost(displayHost, input.ssl === true, input.sslInsecure === true);
    const port = input.port === undefined || input.port === null || input.port === '' ? engineDefaultPort(engine) : endpointPort(input.port);
    if (!port) throw new DbError('该数据库类型必须显式提供 port', { code: 'INVALID_PORT', status: 400 });
    const username = String(input.username ?? '').trim();
    if (!username) throw new DbError('username 不能为空', { code: 'INVALID_USERNAME', status: 400 });
    const name = String(input.name ?? '').trim();
    if (!name) throw new DbError('name 不能为空', { code: 'INVALID_NAME', status: 400 });
    const environment = (input.environment ?? 'dev') as ConnectionConfig['environment'];
    if (!['dev', 'staging', 'prod'].includes(environment)) throw new DbError('environment 必须是 dev/staging/prod', { code: 'INVALID_ENVIRONMENT', status: 400 });
    const color = (input.color ?? 'blue') as ConnectionConfig['color'];
    if (!['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'gray'].includes(color)) throw new DbError('color 无效', { code: 'INVALID_COLOR', status: 400 });
    const database = typeof input.database === 'string' && input.database ? input.database : undefined;
    const lockKey = `${host.toLowerCase()}:${port}:${username}:${database ?? ''}`;
    const release = await this.acquireCreateLock(lockKey);
    try {
      const duplicate = this.store.listConnections().find((item) =>
        String(item.host ?? '').toLowerCase().replace(/^\[|\]$/g, '') === host.toLowerCase() && item.port === port && item.username === username && (item.database ?? '') === (database ?? ''),
      );
      if (duplicate) throw new DuplicateConnectionError(duplicate.id);

      let password: string | undefined;
      if (input.passwordRef !== undefined) password = this.consumePasswordRef(input.passwordRef, displayHost, host, port, username);
      else if (input.useSavedCredential === true) password = this.savedPassword(displayHost, port, username) ?? (host !== displayHost ? this.savedPassword(host, port, username) : undefined);
      let testResult: Awaited<ReturnType<ConnectionManager['testConfig']>> | undefined;
      if (password !== undefined && input.skipProbe !== true) {
        testResult = await withTimeout(this.manager.testConfig(draftConfig(engine, host, port, username, database, input.ssl === true, input.sslInsecure === true), { password }), timeoutResult(engine));
        if (!testResult.ok) {
          const category = classifyProbeFailure(testResult);
          throw new DbError(testResult.message ?? '连接测试失败', {
            code: category === 'auth_failed' ? 'CONNECTION_AUTH_FAILED' : category === 'unreachable' ? 'CONNECTION_UNREACHABLE' : 'CONNECTION_TEST_FAILED',
            status: 400,
            hint: '修正凭据或参数后重试；确实要先保存时显式传 skipProbe=true',
          });
        }
      }
      const connection = this.store.createConnection({
        name,
        engine,
        color,
        environment,
        groupName: typeof input.groupName === 'string' && input.groupName ? input.groupName : '默认',
        host,
        port,
        database,
        username,
        password,
        ssl: input.ssl === true,
        sslInsecure: input.sslInsecure === true,
        readonly: input.readonly === true,
        note: typeof input.note === 'string' && input.note ? input.note : undefined,
      });
      this.manager.invalidate(connection.id, 'agent', false);
      this.events?.emitConnectionsChanged({ type: 'connections_changed', connectionId: connection.id, change: 'created', at: new Date().toISOString() });
      const warning = password === undefined
        ? '未保存密码，请在连接编辑器中补充'
        : input.skipProbe === true ? '按用户要求跳过了连通性测试' : undefined;
      return { connection, tested: testResult?.ok === true, version: testResult?.version, warning };
    } finally {
      release();
    }
  }
}
