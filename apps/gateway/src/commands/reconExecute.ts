import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { reconcileData, type ReconLevel, type ReconMapping } from '../features/reconcile';

const ALLOWED = /^(HSET|SET|DEL)\s+/i;

function commandKey(command: string): string | undefined {
  const match = command.match(/^(?:HSET|SET|DEL)\s+("(?:[^"\\]|\\.)*"|\S+)/i);
  if (!match) return undefined;
  const raw = match[1];
  try {
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

async function snapshot(manager: ConnectionManager, connectionId: string, database: string | undefined, keys: string[]): Promise<Array<{ key: string; type: string; value: unknown }>> {
  const out: Array<{ key: string; type: string; value: unknown }> = [];
  for (const key of [...new Set(keys)]) {
    const typeBatch = await manager.query(connectionId, `TYPE ${JSON.stringify(key)}`, {
      database,
      maxRows: 1,
      allowMulti: false,
      autoLimit: false,
      actor: 'user',
    });
    const type = String(typeBatch.sets[0]?.rows[0]?.[0] ?? 'none');
    if (type === 'none') {
      out.push({ key, type, value: null });
      continue;
    }
    const command = type === 'hash' ? `HGETALL ${JSON.stringify(key)}` : type === 'string' ? `GET ${JSON.stringify(key)}` : `TYPE ${JSON.stringify(key)}`;
    const batch = await manager.query(connectionId, command, {
      database,
      maxRows: 5000,
      allowMulti: false,
      autoLimit: false,
      actor: 'user',
    });
    out.push({ key, type, value: batch.sets[0]?.rows ?? [] });
  }
  return out;
}

export interface ReconExecuteResult {
  artifactId: string;
  executed: number;
  failed: number;
  backupPath?: string;
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
  const result = run?.result as { repair?: string[]; level?: ReconLevel } | undefined;
  const rawPlan = result?.repair ?? [];
  const plan = (opts.steps?.length ? rawPlan.filter((_, index) => opts.steps!.includes(index)) : rawPlan).map((command) => command.replace(/;\s*$/, ''));
  if (!plan.length) throw Object.assign(new Error('没有可执行的 Redis 修复命令'), { code: 'REPAIR_EMPTY', status: 400 });
  const spec = artifact.spec as Record<string, unknown>;
  const input = (spec.input && typeof spec.input === 'object' ? spec.input : {}) as Record<string, unknown>;
  const mapping = input.mapping as ReconMapping | undefined;
  const right = mapping?.right;
  if (!right || right.kind !== 'keyspace') throw Object.assign(new Error('只有右侧为 Redis 键空间的对账支持写回'), { code: 'UNSUPPORTED_ENGINE', status: 400 });
  const conn = store.getConnection(right.connectionId);
  if (!conn) throw Object.assign(new Error('Redis 连接不存在'), { code: 'SOURCE_UNAVAILABLE', status: 404 });
  if (conn.readonly) throw Object.assign(new Error('Redis 连接为只读，不能写回'), { code: 'SOURCE_READONLY', status: 403 });
  for (const command of plan) {
    if (!ALLOWED.test(command)) throw Object.assign(new Error(`不允许的 Redis 修复命令：${command.slice(0, 80)}`), { code: 'INVALID_INPUT', status: 400 });
  }

  const keys = plan.map(commandKey).filter((key): key is string => Boolean(key));
  const snapshotRows = await snapshot(manager, conn.id, right.database, keys);
  mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = join(config.backupDir, `redis-repair-${artifactId.slice(0, 8)}-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify({ artifactId, connectionId: conn.id, database: right.database, keys: snapshotRows }, null, 2));

  const results: ReconExecuteResult['results'] = [];
  let executed = 0;
  let failed = 0;
  const started = Date.now();
  for (const command of plan) {
    const at = Date.now();
    try {
      await manager.query(conn.id, command, {
        database: right.database,
        allowMulti: false,
        autoLimit: false,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
      });
      executed++;
      results.push({ command, ok: true, durationMs: Date.now() - at });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database: right.database,
        tool: 'command.recon.repair',
        sql: command,
        risk: 'write',
        approval: 'manual',
        status: 'ok',
        durationMs: Date.now() - at,
        meta: { artifactId, runId: run?.id, backupPath },
      });
    } catch (err: any) {
      failed++;
      results.push({ command, ok: false, error: err?.message ?? '执行失败', durationMs: Date.now() - at });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database: right.database,
        tool: 'command.recon.repair',
        sql: command,
        risk: 'write',
        approval: 'manual',
        status: 'error',
        durationMs: Date.now() - at,
        meta: { artifactId, runId: run?.id, backupPath, error: err?.message },
      });
      break;
    }
  }

  let verification: ReconExecuteResult['verification'];
  if (mapping && executed > 0) {
    try {
      const after = await reconcileData(store, manager, mapping, result?.level ?? 'keys');
      verification = {
        ok: after.summary.missingInRight === 0 && after.summary.extraInRight === 0 && after.summary.valueChanged === 0,
        missingInRight: after.summary.missingInRight,
        extraInRight: after.summary.extraInRight,
        valueChanged: after.summary.valueChanged,
      };
    } catch {
      verification = undefined;
    }
  }
  store.addAudit({
    actor: 'user',
    connectionId: conn.id,
    database: right.database,
    tool: 'command.recon.repair.summary',
    risk: 'write',
    approval: 'manual',
    status: failed ? 'error' : 'ok',
    durationMs: Date.now() - started,
    meta: { artifactId, executed, failed, backupPath, verification },
  });
  return { artifactId, executed, failed, backupPath, results, verification };
}
