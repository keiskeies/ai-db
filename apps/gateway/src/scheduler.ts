import type { JobInfo } from '@aidb/core';
import type { GatewayConfig } from './config';
import { SCHEDULER_TASK_TIMEOUT_MS, type ConnectionManager } from './manager';
import { notifyArtifact, sendNotification } from './notifications';
import { dumpDatabase } from './services';
import type { Store } from './store';

export class JobScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = new Set<string>();
  private artifactRunning = new Set<string>();
  private artifactRunner?: (artifactId: string) => Promise<{ ok: boolean; message: string }>;
  private dashboardRunning = new Set<string>();
  private dashboardRunner?: (connectionId: string, database?: string) => Promise<{ ok: boolean; message: string }>;
  private pipelineRunner?: (pipelineIds: string[], batchAt: string) => Promise<{ ok: number; failed: number; message: string }>;

  constructor(
    private store: Store,
    private manager: ConnectionManager,
    private config: GatewayConfig,
  ) {}

  setArtifactRunner(runner: (artifactId: string) => Promise<{ ok: boolean; message: string }>): void {
    this.artifactRunner = runner;
  }

  setDashboardRunner(runner: (connectionId: string, database?: string) => Promise<{ ok: boolean; message: string }>): void {
    this.dashboardRunner = runner;
  }

  /** 数据流任务把执行交给流水线 runner，与 artifact/dashboard 同一套注入方式。 */
  setPipelineRunner(runner: (pipelineIds: string[], batchAt: string) => Promise<{ ok: number; failed: number; message: string }>): void {
    this.pipelineRunner = runner;
  }

  /**
   * 任务级超时（G4）：runner/dump 挂死时运行槽永不释放，同一产物/仪表板/任务
   * 的后续所有定时运行被永久阻塞。这里与 600s 上限竞态，超时抛错走既有的
   * catch/finally，保证释放槽位并落失败记录。底层 Promise 可能仍在跑（没有
   * 可取消句柄），但它不再占用调度槽，也不会把结果写回调度状态。
   */
  private withTaskTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label}超时（${SCHEDULER_TASK_TIMEOUT_MS}ms），已释放调度槽`)),
        SCHEDULER_TASK_TIMEOUT_MS,
      );
      timer.unref?.();
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
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
      void this.withTaskTimeout(this.artifactRunner(schedule.artifactId), '产物定时运行')
        .then(async (result) => {
          this.store.markArtifactScheduleRun(schedule.artifactId, result.ok ? 'ok' : 'error', result.ok ? undefined : result.message);
          await notifyArtifact(this.store, schedule.artifactId, result.ok ? 'ok' : 'error').catch(() => undefined);
        })
        .catch((err: any) => this.store.markArtifactScheduleRun(schedule.artifactId, 'error', err?.message ?? '定时运行失败'))
        .finally(() => this.artifactRunning.delete(schedule.artifactId));
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
      void this.withTaskTimeout(this.dashboardRunner(schedule.connectionId, schedule.database), '仪表板定时刷新')
        .then(async (result) => {
          this.store.markDashboardScheduleRun(schedule.connectionId, schedule.database, result.ok ? 'ok' : 'error', result.ok ? undefined : result.message);
          for (const channelId of schedule.notifyChannels) {
            await sendNotification(this.store, channelId, `仪表板刷新${result.ok ? '完成' : '失败'}：${result.message}`).catch(() => undefined);
          }
        })
        .catch((err: any) => this.store.markDashboardScheduleRun(schedule.connectionId, schedule.database, 'error', err?.message ?? '定时刷新失败'))
        .finally(() => this.dashboardRunning.delete(scope));
    }
  }

  async runJob(id: string): Promise<{ ok: boolean; message: string }> {
    if (this.running.has(id)) throw new Error('任务正在运行');
    const job = this.store.getJob(id);
    if (!job) throw new Error('任务不存在');
    this.running.add(id);
    this.store.markJobRun(id, 'running');
    const started = Date.now();
    try {
      let message = '';
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
        });
        const rows = batch.sets.reduce((sum, set) => sum + set.rowCount, 0);
        message = `${batch.sets.length} 个结果集，${rows} 行`;
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
      } else if (job.type === 'pipeline') {
        const ids = (job.payload?.pipelineIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
        if (!ids.length) throw new Error('数据流任务没有选择流水线');
        if (!this.pipelineRunner) throw new Error('流水线执行器尚未就绪');
        const result = await this.pipelineRunner(ids, new Date().toISOString());
        message = result.message;
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
        } else {
          throw new Error(message);
        }
      } else {
        const backup = await this.withTaskTimeout(
          dumpDatabase(this.store, this.manager, this.config, job.connectionId, job.database, `job:${job.name}`),
          '备份任务',
        );
        message = `${backup.tables} 张表 / ${backup.rows} 行 → ${backup.path}`;
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
      }
      this.store.markJobRun(id, 'ok');
      return { ok: true, message };
    } catch (err: any) {
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
    } finally {
      this.running.delete(id);
    }
  }
}

export type { JobInfo };
