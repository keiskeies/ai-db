import type { JobInfo } from '@aidb/core';
import type { GatewayConfig } from './config';
import type { ConnectionManager } from './manager';
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
      void this.artifactRunner(schedule.artifactId)
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
      void this.dashboardRunner(schedule.connectionId, schedule.database)
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
      } else {
        const backup = await dumpDatabase(this.store, this.manager, this.config, job.connectionId, job.database, `job:${job.name}`);
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
