import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { reconcileData, type ReconLevel, type ReconMapping } from '../features/reconcile';
import {
  redisSnapshotsMatch,
  type RedisReconcileDriver,
  type RedisReconcileCommand,
  type RedisReconcileSnapshot,
} from '../drivers/redis';

const MAX_SNAPSHOT_ENTRIES = 100_000;
const ALLOWED = new Set(['HSET', 'SET', 'HDEL', 'DEL']);
const BINARY_PLACEHOLDER = /^<binary \d+ bytes>$/;

export interface RedisSnapshotEntry extends RedisReconcileSnapshot {}

function redisTokens(command: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] ?? '')) index++;
    if (index >= command.length) break;
    if (command[index] === '"') {
      const start = index;
      index++;
      while (index < command.length) {
        if (command[index] === '\\') {
          index += 2;
          continue;
        }
        if (command[index] === '"') {
          index++;
          break;
        }
        index++;
      }
      tokens.push(JSON.parse(command.slice(start, index)) as string);
    } else {
      const start = index;
      while (index < command.length && !/\s/.test(command[index])) index++;
      tokens.push(command.slice(start, index));
    }
  }
  return tokens;
}

function assertNoBinaryValue(value: unknown, key: string): void {
  if (value instanceof Uint8Array || (typeof value === 'string' && BINARY_PLACEHOLDER.test(value))) {
    throw Object.assign(new Error(`Redis 键 ${key} 包含二进制值，无法无损备份或修复`), { code: 'RECON_UNSUPPORTED_BINARY', status: 400 });
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoBinaryValue(item, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) assertNoBinaryValue(item, key);
  }
}

function validateCommand(command: string): { key: string; tokens: string[] } {
  if (/[\r\n;]/.test(command)) throw Object.assign(new Error('Redis 修复命令包含非法换行或分号'), { code: 'INVALID_INPUT', status: 400 });
  let tokens: string[];
  try {
    tokens = redisTokens(command);
  } catch {
    throw Object.assign(new Error('Redis 修复命令引号或转义不合法'), { code: 'INVALID_INPUT', status: 400 });
  }
  const verb = tokens[0]?.toUpperCase();
  if (!verb || !ALLOWED.has(verb) || !tokens[1]) throw Object.assign(new Error(`不允许的 Redis 修复命令：${command.slice(0, 80)}`), { code: 'INVALID_INPUT', status: 400 });
  const valid = (verb === 'SET' && tokens.length === 3)
    || (verb === 'HSET' && tokens.length === 4)
    || (verb === 'HDEL' && tokens.length >= 3)
    || (verb === 'DEL' && tokens.length === 2);
  if (!valid) throw Object.assign(new Error('Redis 修复命令参数不符合安全执行契约'), { code: 'INVALID_INPUT', status: 400 });
  assertNoBinaryValue(tokens.slice(1), tokens[1]);
  return { key: tokens[1], tokens };
}

async function queryRows(manager: ConnectionManager, connectionId: string, database: string | undefined, sql: string, maxRows: number): Promise<unknown[][]> {
  const result = await manager.query(connectionId, sql, { database, maxRows, allowMulti: false, autoLimit: false, actor: 'user' });
  const set = result.sets[0];
  if (set?.columns?.some((column) => column.type?.toLowerCase() === 'binary')) {
    throw Object.assign(new Error('Redis 二进制值无法无损备份或修复，已拒绝执行'), { code: 'RECON_UNSUPPORTED_BINARY', status: 400 });
  }
  if (set?.truncated) throw Object.assign(new Error('Redis 快照读取被截断'), { code: 'SNAPSHOT_INCOMPLETE' });
  return set?.rows ?? [];
}

export async function snapshotRedisKeys(manager: ConnectionManager, connectionId: string, database: string | undefined, keys: string[]): Promise<RedisSnapshotEntry[]> {
  const out: RedisSnapshotEntry[] = [];
  for (const key of [...new Set(keys)]) {
    const quoted = JSON.stringify(key);
    const type = String((await queryRows(manager, connectionId, database, `TYPE ${quoted}`, 1))[0]?.[0] ?? 'none');
    const capturedAt = Date.now();
    const ttl = Number((await queryRows(manager, connectionId, database, `PTTL ${quoted}`, 1))[0]?.[0] ?? -1);
    if (type === 'none') {
      out.push({ key, type, value: null, ttl, capturedAt });
      continue;
    }
    if (type === 'string') {
      const value = (await queryRows(manager, connectionId, database, `GET ${quoted}`, 1))[0]?.[0] ?? null;
      assertNoBinaryValue(value, key);
      out.push({ key, type, value, ttl, capturedAt });
      continue;
    }
    if (type === 'hash') {
      const count = Number((await queryRows(manager, connectionId, database, `HLEN ${quoted}`, 1))[0]?.[0] ?? 0);
      if (count > MAX_SNAPSHOT_ENTRIES) throw Object.assign(new Error(`Redis hash ${key} 超过快照上限`), { code: 'SNAPSHOT_TOO_LARGE' });
      const rows = await queryRows(manager, connectionId, database, `HGETALL ${quoted}`, MAX_SNAPSHOT_ENTRIES);
      if (rows.length !== count) throw Object.assign(new Error(`Redis hash ${key} 快照不完整`), { code: 'SNAPSHOT_INCOMPLETE' });
      assertNoBinaryValue(rows, key);
      out.push({ key, type, value: rows, ttl, capturedAt });
      continue;
    }
    if (type === 'list' || type === 'set' || type === 'zset') {
      const countCommand = type === 'list' ? 'LLEN' : type === 'set' ? 'SCARD' : 'ZCARD';
      const count = Number((await queryRows(manager, connectionId, database, `${countCommand} ${quoted}`, 1))[0]?.[0] ?? 0);
      if (count > MAX_SNAPSHOT_ENTRIES) throw Object.assign(new Error(`Redis ${type} ${key} 超过快照上限`), { code: 'SNAPSHOT_TOO_LARGE' });
      const command = type === 'list' ? `LRANGE ${quoted} 0 -1` : type === 'set' ? `SMEMBERS ${quoted}` : `ZRANGE ${quoted} 0 -1 WITHSCORES`;
      const rows = await queryRows(manager, connectionId, database, command, MAX_SNAPSHOT_ENTRIES);
      if (rows.length !== count) throw Object.assign(new Error(`Redis ${type} ${key} 快照不完整`), { code: 'SNAPSHOT_INCOMPLETE' });
      assertNoBinaryValue(rows, key);
      out.push({ key, type, value: rows, ttl, capturedAt });
      continue;
    }
    throw Object.assign(new Error(`Redis 键 ${key} 的类型 ${type} 无法完整快照，已拒绝执行`), { code: 'RECON_UNSUPPORTED_TYPE' });
  }
  return out;
}

function appendSnapshotExpiry(commands: RedisReconcileCommand[], entry: RedisSnapshotEntry): void {
  if (entry.ttl > 0) {
    const expireAt = entry.capturedAt + entry.ttl;
    if (expireAt <= Date.now()) commands.push({ command: 'DEL', args: [entry.key] });
    else commands.push({ command: 'PEXPIRE', args: [entry.key, '0'], expireAt });
  } else if (entry.ttl === -1) {
    commands.push({ command: 'PERSIST', args: [entry.key] });
  }
}

function restoreCommands(entry: RedisSnapshotEntry): RedisReconcileCommand[] {
  assertNoBinaryValue(entry.value, entry.key);
  const commands: RedisReconcileCommand[] = [];
  if (entry.type === 'none' || (entry.ttl > 0 && entry.capturedAt + entry.ttl <= Date.now())) {
    return [{ command: 'DEL', args: [entry.key] }];
  }
  if (entry.type === 'string') {
    commands.push({ command: 'SET', args: [entry.key, String(entry.value ?? '')] });
  } else if (entry.type === 'hash') {
    commands.push({ command: 'DEL', args: [entry.key] });
    const rows = entry.value as unknown[][];
    for (let index = 0; index < rows.length; index += 100) {
      const chunk = rows.slice(index, index + 100);
      commands.push({ command: 'HSET', args: [entry.key, ...chunk.flatMap((row) => [String(row[0]), String(row[1] ?? '')])] });
    }
  } else if (entry.type === 'list') {
    commands.push({ command: 'DEL', args: [entry.key] });
    const values = (entry.value as unknown[][]).map((row) => String(row[0] ?? ''));
    for (let index = 0; index < values.length; index += 100) commands.push({ command: 'RPUSH', args: [entry.key, ...values.slice(index, index + 100)] });
  } else if (entry.type === 'set') {
    commands.push({ command: 'DEL', args: [entry.key] });
    const values = (entry.value as unknown[][]).map((row) => String(row[0] ?? ''));
    for (let index = 0; index < values.length; index += 100) commands.push({ command: 'SADD', args: [entry.key, ...values.slice(index, index + 100)] });
  } else if (entry.type === 'zset') {
    commands.push({ command: 'DEL', args: [entry.key] });
    const rows = entry.value as unknown[][];
    for (let index = 0; index < rows.length; index += 100) {
      const chunk = rows.slice(index, index + 100);
      commands.push({ command: 'ZADD', args: [entry.key, ...chunk.flatMap((row) => [String(row[1] ?? '0'), String(row[0] ?? '')])] });
    }
  } else {
    throw Object.assign(new Error(`Redis 键 ${entry.key} 的类型 ${entry.type} 无法恢复`), { code: 'RECON_UNSUPPORTED_TYPE' });
  }
  appendSnapshotExpiry(commands, entry);
  return commands;
}

function repairCommands(tokens: string[][], expected: RedisSnapshotEntry): RedisReconcileCommand[] {
  const commands: RedisReconcileCommand[] = [];
  for (const item of tokens) {
    const command: RedisReconcileCommand = { command: item[0].toUpperCase(), args: item.slice(1) };
    commands.push(command);
    // Plain SET drops TTL. PEXPIRE/PERSIST in the same MULTI preserves persistent vs expiring semantics.
    if (command.command === 'SET') appendSnapshotExpiry(commands, expected);
  }
  return commands;
}

function reconcileCasDriver(driver: unknown): RedisReconcileDriver {
  const candidate = driver as Partial<RedisReconcileDriver> | undefined;
  if (!candidate || typeof candidate.supportsReconcileCas !== 'function' || typeof candidate.compareAndSwapKey !== 'function' || !candidate.supportsReconcileCas()) {
    throw Object.assign(new Error('当前 Redis 驱动不支持安全的 WATCH/MULTI/EXEC 对账修复，已拒绝写入'), { code: 'RECON_CAS_UNSUPPORTED', status: 400 });
  }
  return candidate as RedisReconcileDriver;
}

export interface ReconExecuteResult {
  artifactId: string;
  executed: number;
  failed: number;
  backupPath?: string;
  rolledBack?: boolean;
  results: Array<{ command: string; ok: boolean; error?: string; durationMs: number }>;
  verification?: { ok: boolean; missingInRight: number; extraInRight: number; valueChanged: number };
}

export async function executeReconRepair(
  store: Store,
  manager: ConnectionManager,
  config: GatewayConfig,
  artifactId: string,
  opts: { confirm: string; steps?: number[] },
): Promise<ReconExecuteResult> {
  if (opts.confirm !== 'EXECUTE') throw Object.assign(new Error('需要输入 EXECUTE 确认执行'), { code: 'CONFIRM_REQUIRED', status: 400 });
  const artifact = store.getArtifact(artifactId);
  if (!artifact) throw Object.assign(new Error('产物不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
  if (artifact.type !== 'recon') throw Object.assign(new Error('该产物不是对账结果'), { code: 'INVALID_INPUT', status: 400 });
  const run = store.listArtifactRuns(artifactId, 1)[0];
  const result = run?.result as {
    repair?: string[];
    repairComplete?: boolean;
    level?: ReconLevel;
    summary?: { comparisonComplete?: boolean; truncated?: boolean; skippedKeys?: number };
  } | undefined;
  if (result?.repairComplete !== true
    || (result.level !== 'keys' && result.level !== 'fields')
    || result.summary?.comparisonComplete !== true
    || result.summary.truncated !== false
    || result.summary.skippedKeys !== 0) {
    throw Object.assign(new Error('Redis 对账覆盖或修复计划不完整，已拒绝执行'), { code: 'REPAIR_PLAN_INCOMPLETE', status: 409 });
  }
  const rawPlan = Array.isArray(result?.repair) ? result.repair : [];
  const selected = opts.steps?.length ? rawPlan.filter((_, index) => opts.steps!.includes(index)) : rawPlan;
  const plan = selected.map((command) => {
    if (typeof command !== 'string') throw Object.assign(new Error('Redis 修复计划包含非法命令'), { code: 'INVALID_INPUT', status: 400 });
    return command.replace(/;\s*$/, '');
  });
  if (!plan.length) throw Object.assign(new Error('没有可执行的 Redis 修复命令'), { code: 'REPAIR_EMPTY', status: 400 });
  const spec = artifact.spec as Record<string, unknown>;
  const input = (spec.input && typeof spec.input === 'object' ? spec.input : {}) as Record<string, unknown>;
  const mapping = input.mapping as ReconMapping | undefined;
  const right = mapping?.right;
  if (!right || right.kind !== 'keyspace') throw Object.assign(new Error('只有右侧为 Redis 键空间的对账支持写回'), { code: 'UNSUPPORTED_ENGINE', status: 400 });
  const conn = store.getConnection(right.connectionId);
  if (!conn) throw Object.assign(new Error('Redis 连接不存在'), { code: 'SOURCE_UNAVAILABLE', status: 404 });
  if (conn.readonly) throw Object.assign(new Error('Redis 连接为只读，不能写回'), { code: 'SOURCE_READONLY', status: 403 });
  const parsedPlan = plan.map(validateCommand);
  const driver = reconcileCasDriver(await manager.rawDriver(conn.id));
  const keys = parsedPlan.map((command) => command.key);
  const snapshotRows = await snapshotRedisKeys(manager, conn.id, right.database, keys);
  mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = join(config.backupDir, `redis-repair-${artifactId.slice(0, 8)}-${stamp}-${randomUUID().slice(0, 8)}.json`);
  const tempPath = `${backupPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ version: 1, artifactId, connectionId: conn.id, database: right.database, keys: snapshotRows }, null, 2), { mode: 0o600 });
  renameSync(tempPath, backupPath);
  const beforeWrite = await snapshotRedisKeys(manager, conn.id, right.database, keys);
  if (beforeWrite.length !== snapshotRows.length || beforeWrite.some((entry, index) => !redisSnapshotsMatch(snapshotRows[index], entry))) {
    rmSync(backupPath, { force: true });
    throw Object.assign(new Error('快照后 Redis 数据或 TTL 已变化，请重新生成修复计划'), { code: 'SNAPSHOT_CHANGED', status: 409 });
  }

  const snapshotByKey = new Map(snapshotRows.map((entry) => [entry.key, entry]));
  const groups = new Map<string, { sql: string[]; tokens: string[][] }>();
  parsedPlan.forEach(({ key, tokens }, index) => {
    const group = groups.get(key) ?? { sql: [], tokens: [] };
    group.sql.push(plan[index]);
    group.tokens.push(tokens);
    groups.set(key, group);
  });

  const results: ReconExecuteResult['results'] = [];
  const rollbackTargets = new Map<string, { original: RedisSnapshotEntry; expectedAfter: RedisSnapshotEntry }>();
  let executed = 0;
  let failed = 0;
  let rolledBack: boolean | undefined;
  let uncertainWrite = false;
  const started = Date.now();
  for (const [key, group] of groups) {
    const original = snapshotByKey.get(key)!;
    const at = Date.now();
    try {
      const cas = await driver.compareAndSwapKey({
        key,
        expected: original,
        commands: repairCommands(group.tokens, original),
        database: right.database,
        timeoutMs: store.getSettings().queryTimeoutMs,
      });
      if (!cas.applied || !cas.snapshot) {
        failed++;
        const error = cas.error ?? 'Redis 键在执行前已变化';
        for (const command of group.sql) {
          results.push({ command, ok: false, error, durationMs: Date.now() - at });
          store.addAudit({ actor: 'user', connectionId: conn.id, database: right.database, tool: 'command.recon.repair', sql: command, risk: 'write', approval: 'manual', status: 'error', durationMs: Date.now() - at, meta: { artifactId, runId: run?.id, backupPath, error } });
        }
        if (cas.wrote && cas.snapshot) rollbackTargets.set(key, { original, expectedAfter: cas.snapshot });
        else if (cas.wrote) uncertainWrite = true;
        break;
      }
      executed += group.sql.length;
      rollbackTargets.set(key, { original, expectedAfter: cas.snapshot });
      for (const command of group.sql) {
        results.push({ command, ok: true, durationMs: Date.now() - at });
        store.addAudit({ actor: 'user', connectionId: conn.id, database: right.database, tool: 'command.recon.repair', sql: command, risk: 'write', approval: 'manual', status: 'ok', durationMs: Date.now() - at, meta: { artifactId, runId: run?.id, backupPath } });
      }
    } catch (err: any) {
      failed++;
      uncertainWrite = true;
      const error = err?.message ?? '执行失败';
      for (const command of group.sql) {
        results.push({ command, ok: false, error, durationMs: Date.now() - at });
        store.addAudit({ actor: 'user', connectionId: conn.id, database: right.database, tool: 'command.recon.repair', sql: command, risk: 'write', approval: 'manual', status: 'error', durationMs: Date.now() - at, meta: { artifactId, runId: run?.id, backupPath, error } });
      }
      break;
    }
  }

  if (failed && (rollbackTargets.size || uncertainWrite)) {
    let restored = !uncertainWrite;
    for (const [key, target] of rollbackTargets) {
      try {
        const rollback = await driver.compareAndSwapKey({
          key,
          expected: target.expectedAfter,
          commands: restoreCommands(target.original),
          database: right.database,
          timeoutMs: store.getSettings().queryTimeoutMs,
        });
        if (!rollback.applied) throw new Error(rollback.error ?? `Redis 键 ${key} 在回滚前已变化`);
      } catch (rollbackErr: any) {
        restored = false;
        store.addAudit({ actor: 'user', connectionId: conn.id, database: right.database, tool: 'command.recon.repair.rollback', sql: '-- rollback', risk: 'destructive', approval: 'manual', status: 'error', durationMs: Date.now() - started, meta: { artifactId, backupPath, key, error: rollbackErr?.message } });
      }
    }
    rolledBack = restored;
  }

  let verification: ReconExecuteResult['verification'];
  if (mapping && executed > 0 && failed === 0) {
    try {
      const after = await reconcileData(store, manager, mapping, result?.level ?? 'keys');
      verification = {
        ok: after.summary.comparisonComplete
          && after.repairComplete
          && after.summary.missingInRight === 0
          && after.summary.extraInRight === 0
          && after.summary.valueChanged === 0
          && after.summary.typeDrift === 0
          && after.summary.nullMismatch === 0,
        missingInRight: after.summary.missingInRight,
        extraInRight: after.summary.extraInRight,
        valueChanged: after.summary.valueChanged,
      };
    } catch {
      verification = undefined;
    }
  }
  store.addAudit({ actor: 'user', connectionId: conn.id, database: right.database, tool: 'command.recon.repair.summary', risk: 'write', approval: 'manual', status: failed ? 'error' : 'ok', durationMs: Date.now() - started, meta: { artifactId, executed, failed, backupPath, rolledBack, verification } });
  return { artifactId, executed, failed, backupPath, rolledBack, results, verification };
}
