import { supportsTransactions } from '@aidb/core';
import type { GatewayConfig } from '../config';
import type { ToolExecutor } from '../executor';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { dumpDatabase } from '../services';

export interface FixExecuteResult {
  artifactId: string;
  backupPath?: string;
  executed: number;
  failed: number;
  results: Array<{ sql: string; risk: string; ok: boolean; rows?: number; error?: string; durationMs: number }>;
  verification?: { ok: boolean; summary: string; findings: number };
  transaction?: 'committed' | 'rolled_back' | 'none';
  dryRun?: boolean;
}

export async function executeFixPlan(
  store: Store,
  manager: ConnectionManager,
  config: GatewayConfig,
  artifactId: string,
  opts: { confirm: string; backup: boolean; steps?: number[]; dryRun?: boolean },
  executor?: ToolExecutor,
): Promise<FixExecuteResult> {
  if (opts.confirm !== 'EXECUTE') {
    throw Object.assign(new Error('需要输入 EXECUTE 确认执行'), { code: 'CONFIRM_REQUIRED', status: 400 });
  }
  const artifact = store.getArtifact(artifactId);
  if (!artifact) throw Object.assign(new Error('产物不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
  if (artifact.type !== 'fix') throw Object.assign(new Error('该产物不是修复单'), { code: 'INVALID_INPUT', status: 400 });
  const run = store.listArtifactRuns(artifactId, 1)[0];
  const result = run?.result as
    | {
        mode?: string;
        connection?: { connectionId: string; database?: string; label?: string };
        plan?: Array<{ sql: string; risk: string; requiresBackup?: boolean }>;
      }
    | undefined;
  const rawPlan = result?.plan ?? [];
  const plan = opts.steps?.length ? rawPlan.filter((_, index) => opts.steps!.includes(index)) : rawPlan;
  if (!plan.length) throw Object.assign(new Error('没有可执行的修复计划'), { code: 'FIX_PLAN_EMPTY', status: 400 });
  const connectionId = result?.connection?.connectionId;
  if (!connectionId) throw Object.assign(new Error('修复单缺少目标连接'), { code: 'SOURCE_UNAVAILABLE', status: 400 });
  const conn = store.getConnection(connectionId);
  if (!conn) throw Object.assign(new Error('目标连接不存在'), { code: 'SOURCE_UNAVAILABLE', status: 404 });
  if (conn.readonly) throw Object.assign(new Error('目标连接为只读，不能执行修复'), { code: 'SOURCE_READONLY', status: 403 });
  const needsBackup = plan.some((step) => step.requiresBackup || step.risk === 'ddl' || step.risk === 'destructive');
  if (opts.dryRun) {
    return {
      artifactId,
      executed: 0,
      failed: 0,
      results: plan.map((step) => ({ sql: step.sql, risk: step.risk, ok: true, rows: 0, durationMs: 0 })),
      dryRun: true,
    };
  }
  if (needsBackup && !opts.backup) {
    throw Object.assign(new Error('该计划包含 DDL / 破坏性步骤，必须先备份目标库'), { code: 'BACKUP_REQUIRED', status: 400 });
  }

  let backupPath: string | undefined;
  if (opts.backup) {
    const backup = await dumpDatabase(store, manager, config, connectionId, result?.connection?.database, `fix:${artifact.title}`);
    backupPath = backup.path;
  }

  const results: FixExecuteResult['results'] = [];
  let executed = 0;
  let failed = 0;
  const canTransact = supportsTransactions(conn.engine) && plan.every((step) => step.risk !== 'ddl' && step.risk !== 'destructive');
  const txSession = `fix:${artifactId}:${Date.now()}`;
  if (canTransact) {
    await manager.beginTransaction(txSession, connectionId, {
      database: result?.connection?.database,
      allowMulti: false,
      autoLimit: false,
      timeoutMs: store.getSettings().queryTimeoutMs,
      actor: 'user',
    });
  }
  for (const step of plan) {
    const started = Date.now();
    try {
      const batch = await manager.query(connectionId, step.sql, {
        database: result?.connection?.database,
        allowMulti: false,
        autoLimit: false,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
        ...(canTransact ? { sessionId: txSession } : {}),
      });
      const rows = batch.sets.reduce((sum, set) => sum + (set.rowCount ?? 0), 0);
      results.push({ sql: step.sql, risk: step.risk, ok: true, rows, durationMs: Date.now() - started });
      executed++;
      store.addAudit({
        actor: 'user',
        connectionId,
        database: result?.connection?.database,
        tool: 'command.fix.execute',
        sql: step.sql,
        risk: step.risk as any,
        approval: 'manual',
        status: 'ok',
        durationMs: Date.now() - started,
        meta: { artifactId, runId: run?.id, backupPath },
      });
    } catch (err: any) {
      failed++;
      results.push({ sql: step.sql, risk: step.risk, ok: false, error: err?.message ?? '执行失败', durationMs: Date.now() - started });
      store.addAudit({
        actor: 'user',
        connectionId,
        database: result?.connection?.database,
        tool: 'command.fix.execute',
        sql: step.sql,
        risk: step.risk as any,
        approval: 'manual',
        status: 'error',
        durationMs: Date.now() - started,
        meta: { artifactId, runId: run?.id, backupPath, error: err?.message },
      });
      break;
    }
  }
  let transaction: FixExecuteResult['transaction'] = 'none';
  if (canTransact) {
    if (failed) {
      await manager.rollbackTransaction(txSession);
      transaction = 'rolled_back';
    } else {
      await manager.commitTransaction(txSession);
      transaction = 'committed';
    }
  }
  let verification: FixExecuteResult['verification'];
  if (executor && executed > 0 && !failed) {
    const audit = await executor.execute(
      { id: `fix-verify-${artifactId}`, name: 'audit_database', args: { connectionId, database: result?.connection?.database } },
      { sessionId: `fix:${artifactId}`, connectionId, database: result?.connection?.database },
    );
    const findings = Array.isArray((audit.data as { findings?: unknown[] } | undefined)?.findings)
      ? (audit.data as { findings: unknown[] }).findings.length
      : 0;
    verification = { ok: audit.ok, summary: audit.summary, findings };
  }
  if (artifact.type === 'fix') store.updateArtifact(artifactId, { status: failed ? 'error' : 'ready' });
  return { artifactId, backupPath, executed, failed, results, verification, transaction };
}
