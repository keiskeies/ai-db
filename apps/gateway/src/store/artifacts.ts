import { randomUUID } from 'node:crypto';
import type {
  ArtifactInfo,
  ArtifactRunInfo,
  ArtifactScheduleInfo,
  ArtifactSpec,
  ArtifactType,
} from '@aidb/core';
import { StoreDb, iso } from './db';

interface ArtifactRow {
  id: string;
  type: ArtifactType;
  title: string;
  spec_json: string;
  status: 'draft' | 'ready' | 'running' | 'error';
  schedule_id: string | null;
  origin_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactRunRow {
  id: string;
  artifact_id: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';
  input_json: string | null;
  steps_json: string | null;
  result_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface ArtifactScheduleRow {
  id: string;
  artifact_id: string;
  interval_seconds: number;
  enabled: number;
  refresh_narrative: number;
  notify_channels: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const ARTIFACT_RUNS_LIMIT = 500;

export class ArtifactsRepo {
  constructor(private db: StoreDb) {}

  // ---------- artifacts ----------
  private rowToArtifact(row: ArtifactRow): ArtifactInfo {
    let spec: ArtifactSpec;
    try {
      spec = JSON.parse(row.spec_json) as ArtifactSpec;
    } catch {
      spec = { version: 1, type: row.type, title: row.title };
    }
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      spec,
      status: row.status,
      scheduleId: row.schedule_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listArtifacts(opts: { type?: ArtifactType; limit?: number; offset?: number } = {}): ArtifactInfo[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.type) {
      clauses.push('type = ?');
      params.push(opts.type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.db.all<ArtifactRow>(`SELECT * FROM artifacts ${where} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`, params).map((row) =>
      this.rowToArtifact(row),
    );
  }

  getArtifact(id: string): ArtifactInfo | undefined {
    const row = this.db.one<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', [id]);
    return row ? this.rowToArtifact(row) : undefined;
  }

  createArtifact(input: {
    type: ArtifactType;
    title: string;
    spec: ArtifactSpec;
    status?: 'draft' | 'ready' | 'running' | 'error';
    originSessionId?: string;
    scheduleId?: string;
  }): ArtifactInfo {
    const id = randomUUID();
    const now = iso();
    this.db.exec(
      `INSERT INTO artifacts (id,type,title,spec_json,status,schedule_id,origin_session_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.type,
        input.title,
        JSON.stringify(input.spec),
        input.status ?? 'ready',
        input.scheduleId ?? null,
        input.originSessionId ?? null,
        now,
        now,
      ],
    );
    return this.getArtifact(id)!;
  }

  updateArtifact(id: string, patch: { title?: string; spec?: ArtifactSpec; status?: 'draft' | 'ready' | 'running' | 'error'; scheduleId?: string | null }): ArtifactInfo {
    const row = this.db.one<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', [id]);
    if (!row) throw new Error('产物不存在');
    this.db.exec(
      `UPDATE artifacts SET title = ?, spec_json = ?, status = ?, schedule_id = ?, updated_at = ? WHERE id = ?`,
      [
        patch.title ?? row.title,
        patch.spec ? JSON.stringify(patch.spec) : row.spec_json,
        patch.status ?? row.status,
        patch.scheduleId === undefined ? row.schedule_id : patch.scheduleId,
        iso(),
        id,
      ],
    );
    return this.getArtifact(id)!;
  }

  deleteArtifact(id: string): void {
    this.db.exec('DELETE FROM artifacts WHERE id = ?', [id]);
  }

  addArtifactRun(input: {
    artifactId: string;
    status: ArtifactRunRow['status'];
    input?: unknown;
    steps?: unknown;
    result?: unknown;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  }): ArtifactRunInfo {
    const id = randomUUID();
    const startedAt = input.startedAt ?? iso();
    this.db.exec(
      `INSERT INTO artifact_runs (id,artifact_id,status,input_json,steps_json,result_json,error,started_at,finished_at,duration_ms,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.artifactId,
        input.status,
        input.input === undefined ? null : JSON.stringify(input.input),
        input.steps === undefined ? null : JSON.stringify(input.steps),
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error ?? null,
        startedAt,
        input.finishedAt ?? null,
        input.durationMs ?? null,
        iso(),
      ],
    );
    return this.getArtifactRun(id)!;
  }

  updateArtifactRun(
    id: string,
    patch: Partial<Pick<ArtifactRunInfo, 'status' | 'steps' | 'result' | 'error' | 'finishedAt' | 'durationMs'>>,
  ): ArtifactRunInfo {
    const row = this.db.one<ArtifactRunRow>('SELECT * FROM artifact_runs WHERE id = ?', [id]);
    if (!row) throw new Error('运行记录不存在');
    this.db.exec(
      `UPDATE artifact_runs SET status = ?, steps_json = ?, result_json = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`,
      [
        patch.status ?? row.status,
        patch.steps === undefined ? row.steps_json : JSON.stringify(patch.steps),
        patch.result === undefined ? row.result_json : JSON.stringify(patch.result),
        patch.error === undefined ? row.error : patch.error,
        patch.finishedAt === undefined ? row.finished_at : patch.finishedAt,
        patch.durationMs === undefined ? row.duration_ms : patch.durationMs,
        id,
      ],
    );
    return this.getArtifactRun(id)!;
  }

  getArtifactRun(id: string): ArtifactRunInfo | undefined {
    const row = this.db.one<ArtifactRunRow>('SELECT * FROM artifact_runs WHERE id = ?', [id]);
    if (!row) return undefined;
    return {
      id: row.id,
      artifactId: row.artifact_id,
      status: row.status,
      steps: row.steps_json ? JSON.parse(row.steps_json) : undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
    };
  }

  listArtifactRuns(artifactId: string, limit = 20): ArtifactRunInfo[] {
    return this.db.all<ArtifactRunRow>(
      'SELECT * FROM artifact_runs WHERE artifact_id = ? ORDER BY created_at DESC LIMIT ?',
      [artifactId, Math.min(100, Math.max(1, limit))],
    ).map((row) => ({
      id: row.id,
      artifactId: row.artifact_id,
      status: row.status,
      steps: row.steps_json ? JSON.parse(row.steps_json) : undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
    }));
  }

  private rowToArtifactSchedule(row: ArtifactScheduleRow): ArtifactScheduleInfo {
    return {
      id: row.id,
      artifactId: row.artifact_id,
      intervalSeconds: row.interval_seconds,
      enabled: Boolean(row.enabled),
      refreshNarrative: Boolean(row.refresh_narrative),
      notifyChannels: row.notify_channels ? (JSON.parse(row.notify_channels) as string[]) : [],
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  getArtifactSchedule(artifactId: string): ArtifactScheduleInfo | undefined {
    const row = this.db.one<ArtifactScheduleRow>('SELECT * FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    return row ? this.rowToArtifactSchedule(row) : undefined;
  }

  listArtifactSchedules(): ArtifactScheduleInfo[] {
    return this.db.all<ArtifactScheduleRow>('SELECT * FROM artifact_schedules ORDER BY created_at ASC').map((row) =>
      this.rowToArtifactSchedule(row),
    );
  }

  upsertArtifactSchedule(artifactId: string, input: { intervalSeconds: number; enabled?: boolean; refreshNarrative?: boolean }): ArtifactScheduleInfo {
    const now = iso();
    const existing = this.db.one<ArtifactScheduleRow>('SELECT * FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    if (existing) {
      this.db.exec(
        'UPDATE artifact_schedules SET interval_seconds = ?, enabled = ?, refresh_narrative = ?, updated_at = ? WHERE id = ?',
        [input.intervalSeconds, input.enabled === false ? 0 : 1, input.refreshNarrative ? 1 : 0, now, existing.id],
      );
      this.updateArtifact(artifactId, { scheduleId: existing.id });
      return this.getArtifactSchedule(artifactId)!;
    }
    const id = randomUUID();
    this.db.exec(
      `INSERT INTO artifact_schedules (id,artifact_id,interval_seconds,enabled,refresh_narrative,last_run_at,last_status,last_error,created_at,updated_at)
       VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?)`,
      [id, artifactId, input.intervalSeconds, input.enabled === false ? 0 : 1, input.refreshNarrative ? 1 : 0, now, now],
    );
    this.updateArtifact(artifactId, { scheduleId: id });
    return this.getArtifactSchedule(artifactId)!;
  }

  deleteArtifactSchedule(artifactId: string): void {
    this.db.exec('DELETE FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    this.updateArtifact(artifactId, { scheduleId: null });
  }

  setArtifactScheduleNotifyChannels(artifactId: string, channelIds: string[]): ArtifactScheduleInfo {
    const row = this.db.one<ArtifactScheduleRow>('SELECT * FROM artifact_schedules WHERE artifact_id = ?', [artifactId]);
    if (!row) throw new Error('定时配置不存在');
    this.db.exec('UPDATE artifact_schedules SET notify_channels = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify([...new Set(channelIds.filter(Boolean))]),
      iso(),
      row.id,
    ]);
    return this.getArtifactSchedule(artifactId)!;
  }

  markArtifactScheduleRun(artifactId: string, status: 'ok' | 'error', error?: string): void {
    this.db.exec(
      'UPDATE artifact_schedules SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE artifact_id = ?',
      [iso(), status, error ?? null, iso(), artifactId],
    );
  }

  pruneArtifactRuns(): void {
    this.db.pruneTable('artifact_runs', ARTIFACT_RUNS_LIMIT);
  }
}
