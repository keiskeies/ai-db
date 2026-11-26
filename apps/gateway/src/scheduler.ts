import { randomUUID } from 'node:crypto';
import type { JobInfo } from '@aidb/core';
import type { GatewayConfig } from './config';
import { DbError } from './drivers';
import { throwIfAborted } from './drivers/timeout';
import { SCHEDULER_TASK_TIMEOUT_MS, type ConnectionManager } from './manager';
import { notifyArtifact, sendNotification } from './notifications';
import { dumpDatabase } from './services';
import type { Store } from './store';
import { currentCorrelationId, logGateway, type GatewayLogger, type GatewayMetrics } from './observability';

export class JobScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private tasks = new Set<Promise<unknown>>();
  private running = new Set<string>();
  private controllers = new Set<AbortController>();
  private artifactRunning = new Set<string>();
  private artifactRunner?: (artifactId: string, signal: AbortSignal) => Promise<{ ok: boolean; message: string }>;
  private dashboardRunning = new Set<string>();
  private dashboardRunner?: (connectionId: string, database: string | undefined, signal: AbortSignal) => Promise<{ ok: boolean; message: string }>;
  private pipelineRunner?: (pipelineIds: string[], batchAt: string, signal: AbortSignal, executionId: string) => Promise<{ ok: number; failed: number; message: string }>;

  constructor(
    private store: Store,
    private manager: ConnectionManager,
    private config: GatewayConfig,
    private metrics?: GatewayMetrics,
    private logger: GatewayLogger = logGateway,
  ) {}

  setArtifactRunner(runner: (artifactId: string, signal: AbortSignal) => Promise<{ ok: boolean; message: string }>): void {
    this.artifactRunner = runner;
  }

  setDashboardRunner(runner: (connectionId: string, database: string | undefined, signal: AbortSignal) => Promise<{ ok: boolean; message: string }>): void {
    this.dashboardRunner = runner;
  }

  /** 数据流任务把执行交给流水线 runner，与 artifact/dashboard 同一套注入方式。 */
  setPipelineRunner(runner: (pipelineIds: string[], batchAt: string, signal: AbortSignal, executionId: string) => Promise<{ ok: number; failed: number; message: string }>): void {
    this.pipelineRunner = runner;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    this.metrics?.gauge('aidb_scheduler_tasks_active', this.tasks.size);
    void task.then(
      () => { this.tasks.delete(task); this.metrics?.gauge('aidb_scheduler_tasks_active', this.tasks.size); },
      () => { this.tasks.delete(task); this.metrics?.gauge('aidb_scheduler_tasks_active', this.tasks.size); },
    );
    return task;
  }

  private recordFailure(kind: string, id: string, code = 'SCHEDULER_FAILED'): void {
    this.metrics?.inc('aidb_scheduler_failures_total', { kind, code });
    this.logger('error', 'scheduler_run_failed', { correlationId: currentCorrelationId(), jobId: kind === 'job' ? id : undefined, artifactId: kind === 'artifact' ? id : undefined, scope: kind === 'dashboard' ? id : undefined, kind, code });
  }

  private withTaskTimeout<T>(work: (signal: AbortSignal) => Promise<T>, label: string, settled: () => void): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let timeoutError: DbError | undefined;

    // 超时只负责请求取消；promise 必须等底层 work（包括其 finally/后处理）真正结算。
    // 否则调用方会误以为工作已经停止，提前释放运行槽或让下一次定时任务重叠进来。
    const completion = (async () => {
      try {
        timer = setTimeout(() => {
          timedOut = true;
          timeoutError = new DbError(`${label}超时（${SCHEDULER_TASK_TIMEOUT_MS}ms），已请求取消并等待底层执行结束`, { code: 'SCHEDULER_TIMEOUT', status: 504 });
          controller.abort(new DbError('工具执行已取消', { code: 'ABORTED' }));
        }, SCHEDULER_TASK_TIMEOUT_MS);
        timer.unref?.();

        let underlying: Promise<T>;
        try {
          underlying = work(controller.signal);
        } catch (err) {
          underlying = Promise.reject(err);
        }
        // track 会挂上 reject handler，避免取消导致 work 拒绝时出现 unhandled rejection。
        this.track(underlying);
        try {
          const value = await underlying;
          if (timedOut) throw timeoutError;
          return value;
        } catch (err) {
          // 取消通常会让 work 以 ABORTED 拒绝；对外仍保留最初的超时原因。
          if (timedOut) throw timeoutError;
          throw err;
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.controllers.delete(controller);
        settled();
      }
    })();
    return completion;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers) {
      controller.abort(new DbError('调度器已停止', { code: 'ABORTED' }));
    }
    // 超时只是对外 reject；忽略取消的工作仍可能写 store，必须等真实工作及后处理退出。
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const jobs = this.store.listJobs().filter((job) => job.enabled);
    const now = Date.now();
    for (const job of jobs) {
      if (this.running.has(job.id)) continue;
      const last = job.lastRunAt ? new Date(job.lastRunAt).getTime() : 0;
      if (now - last < job.intervalSeconds * 1000) continue;
      void this.runJob(job.id).catch(() => undefined);
    }
    await this.tickArtifacts(now);
    await this.tickDashboards(now);
  }

  private async tickArtifacts(now: number): Promise<void> {
    if (!this.artifactRunner) return;
    for (const schedule of this.store.listArtifactSchedules()) {
      if (!schedule.enabled || this.artifactRunning.has(schedule.artifactId)) continue;
      const last = schedule.lastRunAt ? new Date(schedule.lastRunAt).getTime() : 0;
      if (now - last < Math.max(60, schedule.intervalSeconds) * 1000) continue;
      this.artifactRunning.add(schedule.artifactId);
      void this.track(this.withTaskTimeout(
        (signal) => this.artifactRunner!(schedule.artifactId, signal),
        '产物定时运行',
        () => this.artifactRunning.delete(schedule.artifactId),
      )
        .then(async (result) => {
          this.store.markArtifactScheduleRun(schedule.artifactId, result.ok ? 'ok' : 'error', result.ok ? undefined : result.message);
          if (!result.ok) this.recordFailure('artifact', schedule.artifactId);
          await notifyArtifact(this.store, schedule.artifactId, result.ok ? 'ok' : 'error').catch(() => undefined);
        })
        .catch((err: any) => {
          this.recordFailure('artifact', schedule.artifactId, typeof err?.code === 'string' ? err.code : 'SCHEDULER_FAILED');
          this.store.markArtifactScheduleRun(schedule.artifactId, 'error', err?.message ?? '定时运行失败');
        }));
    }
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** 仪表板定时刷新：与 artifact 定时同一套节流，最小 60 秒，同一块板不并发跑。 */
  private async tickDashboards(now: number): Promise<void> {
    if (!this.dashboardRunner) return;
    for (const schedule of this.store.listDashboardSchedules()) {
      const scope = `${schedule.connectionId}/${schedule.database ?? ''}`;
      if (this.dashboardRunning.has(scope)) continue;
      const last = schedule.lastRunAt ? new Date(schedule.lastRunAt).getTime() : 0;
      if (now - last < Math.max(60, schedule.intervalSeconds) * 1000) continue;
      this.dashboardRunning.add(scope);
      void this.track(this.withTaskTimeout(
        (signal) => this.dashboardRunner!(schedule.connectionId, schedule.database, signal),
        '仪表板定时刷新',
        () => this.dashboardRunning.delete(scope),
      )
        .then(async (result) => {
          this.store.markDashboardScheduleRun(schedule.connectionId, schedule.database, result.ok ? 'ok' : 'error', result.ok ? undefined : result.message);
          if (!result.ok) this.recordFailure('dashboard', scope);
          for (const channelId of schedule.notifyChannels) {
            await sendNotification(this.store, channelId, `仪表板刷新${result.ok ? '完成' : '失败'}：${result.message}`).catch(() => undefined);
          }
        })
        .catch((err: any) => {
          this.recordFailure('dashboard', scope, typeof err?.code === 'string' ? err.code : 'SCHEDULER_FAILED');
          this.store.markDashboardScheduleRun(schedule.connectionId, schedule.database, 'error', err?.message ?? '定时刷新失败');
        }));
    }
  }

  async runJob(id: string): Promise<{ ok: boolean; message: string }> {
    if (this.stopped) throw new Error('调度器已停止');
    return this.track(this.executeJob(id));
  }

  private async executeJob(id: string): Promise<{ ok: boolean; message: string }> {
    if (this.running.has(id)) throw new Error('任务正在运行');
    const job = this.store.getJob(id);
    if (!job) throw new Error('任务不存在');
    this.running.add(id);
    this.store.markJobRun(id, 'running');
    const started = Date.now();
    const executionId = randomUUID();
    try {
      let message = '';
      message = await this.withTaskTimeout(async (signal) => {
        const onAbort = () => this.manager.cancelExecution(executionId);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          throwIfAborted(signal);
          if (job.type === 'query') {
            if (!job.sql?.trim()) throw new Error('查询任务缺少 SQL');
            const settings = this.store.getSettings();
            const batch = await this.manager.query(job.connectionId, job.sql, {
              database: job.database,
              maxRows: settings.defaultLimit,
              allowMulti: true,
              autoLimit: settings.autoLimit,
              timeoutMs: settings.queryTimeoutMs,
              actor: 'user',
              signal,
              executionId,
            });
            throwIfAborted(signal);
            const rows = batch.sets.reduce((sum, set) => sum + set.rowCount, 0);
            this.store.addAudit({
              actor: 'user',
              connectionId: job.connectionId,
              database: job.database,
              tool: 'job.query',
              sql: job.sql,
              risk: 'write',
              approval: 'scheduled',
              status: 'ok',
              durationMs: Date.now() - started,
              meta: { jobId: job.id, job: job.name, rows },
            });
            return `${batch.sets.length} 个结果集，${rows} 行`;
          }
          if (job.type === 'pipeline') {
            const ids = (job.payload?.pipelineIds ?? []).filter((pipelineId) => typeof pipelineId === 'string' && pipelineId.length > 0);
            if (!ids.length) throw new Error('数据流任务没有选择流水线');
            if (!this.pipelineRunner) throw new Error('流水线执行器尚未就绪');
            const result = await this.pipelineRunner(ids, new Date().toISOString(), signal, executionId);
            throwIfAborted(signal);
            if (!result.failed) {
              this.store.addAudit({
                actor: 'user',
                connectionId: job.connectionId,
                database: job.database,
                tool: 'job.pipeline',
                risk: 'write',
                approval: 'scheduled',
                status: 'ok',
                durationMs: Date.now() - started,
                meta: { jobId: job.id, job: job.name, pipelines: ids.length, ok: result.ok },
              });
              return result.message;
            }
            throw new Error(result.message);
          }
          const backup = await dumpDatabase(this.store, this.manager, this.config, job.connectionId, job.database, `job:${job.name}`, signal, executionId);
          throwIfAborted(signal);
          this.store.addAudit({
            actor: 'user',
            connectionId: job.connectionId,
            database: job.database,
            tool: 'job.backup',
            risk: 'read',
            approval: 'scheduled',
            status: 'ok',
            durationMs: Date.now() - started,
            meta: { jobId: job.id, job: job.name, path: backup.path },
          });
          return `${backup.tables} 张表 / ${backup.rows} 行 → ${backup.path}`;
        } finally {
          signal.removeEventListener('abort', onAbort);
          this.manager.releaseExecution(executionId);
        }
      }, '调度任务', () => this.running.delete(id));
      this.store.markJobRun(id, 'ok');
      return { ok: true, message };
    } catch (err: any) {
      this.recordFailure('job', id, typeof err?.code === 'string' ? err.code : 'SCHEDULER_FAILED');
      this.store.markJobRun(id, 'error', err?.message ?? '任务失败');
      this.store.addAudit({
        actor: 'user',
        connectionId: job.connectionId,
        database: job.database,
        tool: `job.${job.type}`,
        sql: job.sql,
        risk: job.type === 'query' ? 'write' : 'read',
        approval: 'scheduled',
        status: 'error',
        durationMs: Date.now() - started,
        meta: { jobId: job.id, job: job.name, error: err?.message },
      });
      return { ok: false, message: err?.message ?? '任务失败' };
    }
  }
}

export type { JobInfo };
