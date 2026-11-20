import { randomUUID } from 'node:crypto';
import type {
  JobInfo,
  PipelineCredentialInfo,
  PipelineInfo,
  PipelineRunInfo,
  PipelineSpec,
} from '@aidb/core';
import { StoreDb, iso } from './db';
import type { PipelineCredentialSecret } from '../pipeline/types';

export class JobsRepo {
  constructor(private db: StoreDb) {}

  // ---------- jobs ----------
  private rowToJob(row: Record<string, any>): JobInfo {
    let payload: JobInfo['payload'];
    if (row.payload) {
      try {
        payload = JSON.parse(row.payload) as JobInfo['payload'];
      } catch {
        payload = undefined;
      }
    }
    return {
      id: row.id,
      name: row.name,
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      type: row.type,
      sql: row.sql ?? undefined,
      payload,
      intervalSeconds: row.interval_seconds,
      enabled: Boolean(row.enabled),
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listJobs(): JobInfo[] {
    return this.db.all<Record<string, any>>('SELECT * FROM jobs ORDER BY created_at DESC').map((row) => this.rowToJob(row));
  }

  getJob(id: string): JobInfo | undefined {
    const row = this.db.one<Record<string, any>>('SELECT * FROM jobs WHERE id = ?', [id]);
    return row ? this.rowToJob(row) : undefined;
  }

  createJob(input: { name: string; connectionId: string; database?: string; type: 'query' | 'backup' | 'pipeline'; sql?: string; payload?: JobInfo['payload']; intervalSeconds: number; enabled?: boolean }): JobInfo {
    const id = randomUUID();
    const now = iso();
    this.db.exec(
      'INSERT INTO jobs (id,name,connection_id,database_name,type,sql,payload,interval_seconds,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, input.name, input.connectionId, input.database ?? null, input.type, input.sql ?? null, input.payload ? JSON.stringify(input.payload) : null, Math.max(30, input.intervalSeconds), input.enabled === false ? 0 : 1, now, now],
    );
    return this.getJob(id)!;
  }

  updateJob(id: string, patch: Partial<Pick<JobInfo, 'name' | 'database' | 'sql' | 'payload' | 'intervalSeconds' | 'enabled' | 'type'>>): JobInfo {
    const row = this.getJob(id);
    if (!row) throw new Error('任务不存在');
    this.db.exec(
      'UPDATE jobs SET name=?, database_name=?, type=?, sql=?, payload=?, interval_seconds=?, enabled=?, updated_at=? WHERE id=?',
      [
        patch.name ?? row.name,
        patch.database ?? row.database ?? null,
        patch.type ?? row.type,
        patch.sql ?? row.sql ?? null,
        patch.payload !== undefined ? JSON.stringify(patch.payload) : row.payload ? JSON.stringify(row.payload) : null,
        Math.max(30, patch.intervalSeconds ?? row.intervalSeconds),
        (patch.enabled ?? row.enabled) ? 1 : 0,
        iso(),
        id,
      ],
    );
    return this.getJob(id)!;
  }

  deleteJob(id: string): void {
    this.db.exec('DELETE FROM jobs WHERE id = ?', [id]);
  }

  markJobRun(id: string, status: 'ok' | 'error' | 'running', error?: string): void {
    this.db.exec('UPDATE jobs SET last_status=?, last_error=?, last_run_at=?, updated_at=? WHERE id=?', [
      status,
      error ?? null,
      iso(),
      iso(),
      id,
    ]);
  }

  // ---------- pipelines ----------
  private rowToPipeline(row: Record<string, any>): PipelineInfo {
    let spec: PipelineInfo['spec'];
    try {
      spec = JSON.parse(row.spec_json) as PipelineInfo['spec'];
    } catch {
      spec = { version: 1, steps: [] };
    }
    let state: Record<string, unknown> = {};
    try {
      state = row.state_json ? (JSON.parse(row.state_json) as Record<string, unknown>) : {};
    } catch {
      state = {};
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      connectionId: row.connection_id ?? undefined,
      database: row.database_name ?? undefined,
      spec,
      state,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  listPipelines(): PipelineInfo[] {
    return this.db.all<Record<string, any>>('SELECT * FROM pipelines ORDER BY updated_at DESC').map((row) => this.rowToPipeline(row));
  }

  getPipeline(id: string): PipelineInfo | undefined {
    const row = this.db.one<Record<string, any>>('SELECT * FROM pipelines WHERE id = ?', [id]);
    return row ? this.rowToPipeline(row) : undefined;
  }

  createPipeline(input: { name: string; description?: string; connectionId?: string; database?: string; spec: PipelineSpec }): PipelineInfo {
    const id = randomUUID();
    const now = iso();
    this.db.exec(
      'INSERT INTO pipelines (id,name,description,connection_id,database_name,spec_json,state_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)',
      [id, input.name, input.description ?? null, input.connectionId ?? null, input.database ?? null, JSON.stringify(input.spec), '{}', now, now],
    );
    return this.getPipeline(id)!;
  }

  updatePipeline(
    id: string,
    patch: Partial<Pick<PipelineInfo, 'name' | 'description' | 'connectionId' | 'database' | 'spec' | 'enabled'>>,
  ): PipelineInfo {
    const row = this.getPipeline(id);
    if (!row) throw new Error('流水线不存在');
    this.db.exec('UPDATE pipelines SET name=?, description=?, connection_id=?, database_name=?, spec_json=?, enabled=?, updated_at=? WHERE id=?', [
      patch.name ?? row.name,
      patch.description ?? row.description ?? null,
      patch.connectionId ?? row.connectionId ?? null,
      patch.database ?? row.database ?? null,
      JSON.stringify(patch.spec ?? row.spec),
      (patch.enabled ?? row.enabled) ? 1 : 0,
      iso(),
      id,
    ]);
    return this.getPipeline(id)!;
  }

  deletePipeline(id: string): void {
    this.db.exec('DELETE FROM pipelines WHERE id = ?', [id]);
    this.db.exec('DELETE FROM pipeline_runs WHERE pipeline_id = ?', [id]);
  }

  /** 增量断点只在运行成功后回写，失败保留旧值，下次仍从同一水位继续。 */
  setPipelineState(id: string, state: Record<string, unknown>): void {
    this.db.exec('UPDATE pipelines SET state_json=?, updated_at=? WHERE id=?', [JSON.stringify(state ?? {}), iso(), id]);
  }

  resetPipelineState(id: string): void {
    this.setPipelineState(id, {});
  }

  markPipelineRun(id: string, status: 'ok' | 'error' | 'running', error?: string): void {
    this.db.exec('UPDATE pipelines SET last_status=?, last_error=?, last_run_at=?, updated_at=? WHERE id=?', [status, error ?? null, iso(), iso(), id]);
  }

  // ---------- pipeline runs ----------
  private rowToPipelineRun(row: Record<string, any>): PipelineRunInfo {
    let steps: PipelineRunInfo['steps'] = [];
    try {
      steps = row.steps_json ? (JSON.parse(row.steps_json) as PipelineRunInfo['steps']) : [];
    } catch {
      steps = [];
    }
    return {
      id: row.id,
      pipelineId: row.pipeline_id,
      trigger: row.trigger,
      status: row.status,
      batchAt: row.batch_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      rowsIn: row.rows_in ?? undefined,
      rowsOut: row.rows_out ?? undefined,
      message: row.message ?? undefined,
      error: row.error ?? undefined,
      steps,
    };
  }

  recordPipelineRun(run: PipelineRunInfo): void {
    this.db.exec(
      `INSERT INTO pipeline_runs (id,pipeline_id,status,trigger,batch_at,steps_json,message,error,rows_in,rows_out,started_at,finished_at,duration_ms,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        run.id,
        run.pipelineId,
        run.status,
        run.trigger,
        run.batchAt,
        JSON.stringify(run.steps ?? []),
        run.message ?? null,
        run.error ?? null,
        run.rowsIn ?? null,
        run.rowsOut ?? null,
        run.startedAt,
        run.finishedAt ?? null,
        run.durationMs ?? null,
        run.finishedAt ?? iso(),
      ],
    );
    this.db.exec(
      `DELETE FROM pipeline_runs WHERE pipeline_id = ? AND id NOT IN (
         SELECT id FROM pipeline_runs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT 40
       )`,
      [run.pipelineId, run.pipelineId],
    );
  }

  listPipelineRuns(pipelineId: string, limit = 20): PipelineRunInfo[] {
    return this.db.all<Record<string, any>>('SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT ?', [pipelineId, limit]).map((row) => this.rowToPipelineRun(row));
  }

  getPipelineRun(id: string): PipelineRunInfo | undefined {
    const row = this.db.one<Record<string, any>>('SELECT * FROM pipeline_runs WHERE id = ?', [id]);
    return row ? this.rowToPipelineRun(row) : undefined;
  }

  // ---------- pipeline credentials ----------
  /** 凭证与流水线定义分库存储：spec 里只留 id，AI 生成或导出都不会带出密钥。 */
  listPipelineCredentials(): PipelineCredentialInfo[] {
    return this.db.all<Record<string, any>>('SELECT id,name,kind,summary,created_at,updated_at FROM pipeline_credentials ORDER BY name').map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      summary: row.summary ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createPipelineCredential(input: { name: string; kind: PipelineCredentialInfo['kind']; secret: Record<string, unknown> }): PipelineCredentialInfo {
    const id = randomUUID();
    const now = iso();
    const summary = input.kind === 'basic' ? `Basic ${String(input.secret.username ?? '')}` : input.kind === 'bearer' ? 'Bearer ***' : `Header ${String(input.secret.header ?? input.secret.field ?? '')}`;
    this.db.exec('INSERT INTO pipeline_credentials (id,name,kind,summary,secret,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [
      id,
      input.name,
      input.kind,
      summary,
      this.db.box.encrypt(input.secret),
      now,
      now,
    ]);
    const found = this.listPipelineCredentials().find((item) => item.id === id);
    if (!found) throw new Error('凭证保存失败');
    return found;
  }

  getPipelineCredentialSecret(id: string): PipelineCredentialSecret | null {
    const row = this.db.one<Record<string, any>>('SELECT secret FROM pipeline_credentials WHERE id = ?', [id]);
    if (!row) return null;
    return this.db.box.decrypt<PipelineCredentialSecret>(row.secret) ?? null;
  }

  deletePipelineCredential(id: string): void {
    this.db.exec('DELETE FROM pipeline_credentials WHERE id = ?', [id]);
  }
}
