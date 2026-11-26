import type { AgentEvent, CommandRunEvent } from '@aidb/core';
import { StoreDb, iso } from './db';

export type AgentTurnStatus = 'running' | 'succeeded' | 'failed' | 'aborted' | 'interrupted';

export interface AgentTurnClaim {
  id: string;
  sessionId: string;
  ownerId: string;
  idempotencyKey: string;
  status: AgentTurnStatus;
  deadlineAt?: string;
  startedAt: string;
  finishedAt?: string;
  abortCause?: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  owner_id: string;
  idempotency_key: string;
  status: AgentTurnStatus;
  deadline_at: string | null;
  started_at: string;
  finished_at: string | null;
  abort_cause: string | null;
}

export interface StoredEvent<T> {
  seq: number;
  event: T;
}

export interface CommandEventReplay {
  events: StoredEvent<CommandRunEvent>[];
  firstSeq?: number;
  lastSeq: number;
  truncated: boolean;
}

export interface RecoveryResult {
  turns: number;
  sessions: number;
  jobs: number;
  artifactRuns: number;
  artifacts: number;
  pipelineRuns: number;
  pipelines: number;
  dashboardCards: number;
  dashboardSchedules: number;
  artifactSchedules: number;
  interruptedTurns: Array<{ turnId: string; sessionId: string }>;
}

const AGENT_EVENTS_PER_TURN = 1000;
const COMMAND_EVENTS_PER_RUN = 500;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 32 * 1024;
const TURN_RETENTION = 500;

function claimOf(row: TurnRow): AgentTurnClaim {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    deadlineAt: row.deadline_at ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    abortCause: row.abort_cause ?? undefined,
  };
}

function boundedPayload(event: unknown): string {
  const text = JSON.stringify(event);
  if (Buffer.byteLength(text, 'utf8') <= MAX_EVENT_BYTES) return text;
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(MAX_PREVIEW_BYTES, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const preview = bytes.subarray(0, end).toString('utf8');
  return JSON.stringify({ type: (event as { type?: string })?.type ?? 'unknown', truncated: true, preview });
}

export class RuntimeRepo {
  constructor(private db: StoreDb) {}

  claimTurn(input: { id: string; sessionId: string; ownerId: string; idempotencyKey: string; deadlineAt?: string }): AgentTurnClaim {
    const now = iso();
    try {
      this.db.exec(
        'INSERT INTO agent_turns (id,session_id,owner_id,idempotency_key,status,deadline_at,started_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [input.id, input.sessionId, input.ownerId, input.idempotencyKey, 'running', input.deadlineAt ?? null, now, now],
      );
    } catch (err: any) {
      if (/idx_agent_turns_one_running|UNIQUE constraint failed: agent_turns.session_id/i.test(String(err?.message))) {
        throw Object.assign(new Error('该会话正在运行或删除，请先中止或等待完成'), { code: 'SESSION_BUSY', status: 409 });
      }
      if (/idempotency_key/i.test(String(err?.message))) {
        throw Object.assign(new Error('该回合已提交，请勿重复提交'), { code: 'TURN_REPLAYED', status: 409 });
      }
      throw err;
    }
    return this.getTurn(input.id)!;
  }

  getTurn(id: string): AgentTurnClaim | undefined {
    const row = this.db.one<TurnRow>('SELECT * FROM agent_turns WHERE id = ?', [id]);
    return row ? claimOf(row) : undefined;
  }

  listTurns(sessionId: string, limit = 20): AgentTurnClaim[] {
    return this.db.all<TurnRow>('SELECT * FROM agent_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT ?', [sessionId, Math.min(100, Math.max(1, limit))]).map(claimOf);
  }

  finishTurn(id: string, ownerId: string, status: Exclude<AgentTurnStatus, 'running'>, abortCause?: string, terminalEvent?: AgentEvent): boolean {
    if (!terminalEvent) {
      const result = this.db.exec(
        "UPDATE agent_turns SET status = ?, finished_at = ?, abort_cause = ? WHERE id = ? AND owner_id = ? AND status = 'running'",
        [status, iso(), abortCause ?? null, id, ownerId],
      );
      return result.changes === 1;
    }
    this.db.db.exec('BEGIN IMMEDIATE');
    try {
      const turn = this.db.one<TurnRow>("SELECT * FROM agent_turns WHERE id = ? AND owner_id = ? AND status = 'running'", [id, ownerId]);
      if (!turn) {
        this.db.db.exec('ROLLBACK');
        return false;
      }
      const hasTerminal = this.db.one<{ one: number }>("SELECT 1 AS one FROM agent_turn_events WHERE turn_id = ? AND type IN ('done','aborted','error') LIMIT 1", [id]);
      if (!hasTerminal) {
        const seq = this.db.one<{ seq: number }>('SELECT COALESCE(MAX(seq),0) + 1 AS seq FROM agent_turn_events WHERE turn_id = ?', [id])?.seq ?? 1;
        this.db.exec('INSERT INTO agent_turn_events (turn_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,?)', [id, seq, terminalEvent.type, boundedPayload(terminalEvent), iso()]);
      }
      this.db.exec("UPDATE agent_turns SET status = ?, finished_at = ?, abort_cause = ? WHERE id = ? AND owner_id = ? AND status = 'running'", [status, iso(), abortCause ?? null, id, ownerId]);
      this.db.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.db.exec('ROLLBACK');
      throw err;
    }
  }

  setTurnAbortCause(id: string, ownerId: string, cause: string): void {
    this.db.exec("UPDATE agent_turns SET abort_cause = ? WHERE id = ? AND owner_id = ? AND status = 'running' AND abort_cause IS NULL", [cause, id, ownerId]);
  }

  appendAgentEvent(turnId: string, seq: number, event: AgentEvent): void {
    this.appendEvent('agent_turn_events', 'turn_id', turnId, seq, event, AGENT_EVENTS_PER_TURN);
  }

  appendCommandEvent(runId: string, seq: number, event: CommandRunEvent): void {
    this.appendEvent('artifact_run_events', 'run_id', runId, seq, event, COMMAND_EVENTS_PER_RUN);
  }

  private appendEvent(table: string, ownerColumn: string, ownerId: string, seq: number, event: unknown, keep: number): void {
    this.db.exec(`INSERT INTO ${table} (${ownerColumn},seq,type,payload_json,created_at) VALUES (?,?,?,?,?)`, [ownerId, seq, (event as { type: string }).type, boundedPayload(event), iso()]);
    this.db.exec(`DELETE FROM ${table} WHERE rowid < COALESCE((SELECT MIN(rowid) FROM (SELECT rowid FROM ${table} WHERE ${ownerColumn} = ? ORDER BY rowid DESC LIMIT ?)), 0)`, [ownerId, keep]);
  }

  agentEvents(turnId: string, after = 0, limit = 1000): { events: StoredEvent<AgentEvent>[]; firstSeq?: number; lastSeq: number } {
    const rows = this.db.all<{ seq: number; payload_json: string }>(`SELECT seq,payload_json FROM agent_turn_events WHERE turn_id = ? AND seq > ? ORDER BY seq LIMIT ?`, [turnId, after, Math.min(1000, Math.max(1, limit))]);
    const range = this.db.one<{ first_seq: number | null; last_seq: number | null }>('SELECT MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM agent_turn_events WHERE turn_id = ?', [turnId]);
    return {
      events: rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.payload_json) as AgentEvent })),
      firstSeq: range?.first_seq ?? undefined,
      lastSeq: range?.last_seq ?? 0,
    };
  }

  commandEventReplay(runId: string, after = 0): CommandEventReplay {
    const events = this.db.all<{ seq: number; payload_json: string }>('SELECT seq,payload_json FROM artifact_run_events WHERE run_id = ? AND seq > ? ORDER BY seq', [runId, after])
      .map((row) => ({ seq: row.seq, event: JSON.parse(row.payload_json) as CommandRunEvent }));
    const range = this.db.one<{ first_seq: number | null; last_seq: number | null }>('SELECT MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM artifact_run_events WHERE run_id = ?', [runId]);
    const firstSeq = range?.first_seq ?? undefined;
    const lastSeq = range?.last_seq ?? 0;
    return {
      events,
      firstSeq,
      lastSeq,
      truncated: firstSeq !== undefined && after < firstSeq - 1,
    };
  }

  commandEvents(runId: string, after = 0): StoredEvent<CommandRunEvent>[] {
    return this.commandEventReplay(runId, after).events;
  }

  pruneRuntime(): void {
    this.db.exec(
      `DELETE FROM agent_turns
       WHERE status != 'running' AND rowid < COALESCE((
         SELECT MIN(rowid) FROM (
           SELECT rowid FROM agent_turns WHERE status != 'running' ORDER BY rowid DESC LIMIT ?
         )
       ), 0)`,
      [TURN_RETENTION],
    );
    this.db.exec('DELETE FROM agent_turn_events WHERE turn_id NOT IN (SELECT id FROM agent_turns)');
    this.db.exec('DELETE FROM artifact_run_events WHERE run_id NOT IN (SELECT id FROM artifact_runs)');
  }

  recoverInterrupted(): RecoveryResult {
    const result: RecoveryResult = {
      turns: 0, sessions: 0, jobs: 0, artifactRuns: 0, artifacts: 0, pipelineRuns: 0,
      pipelines: 0, dashboardCards: 0, dashboardSchedules: 0, artifactSchedules: 0, interruptedTurns: [],
    };
    this.db.db.exec('BEGIN IMMEDIATE');
    try {
      const turns = this.db.all<TurnRow>("SELECT * FROM agent_turns WHERE status = 'running'");
      const now = iso();
      result.interruptedTurns = turns.map((turn) => ({ turnId: turn.id, sessionId: turn.session_id }));
      result.turns = this.db.exec("UPDATE agent_turns SET status = 'interrupted', finished_at = ?, abort_cause = 'interrupted' WHERE status = 'running'", [now]).changes;
      for (const turn of turns) {
        const seq = this.db.one<{ seq: number }>('SELECT COALESCE(MAX(seq),0) + 1 AS seq FROM agent_turn_events WHERE turn_id = ?', [turn.id])?.seq ?? 1;
        this.db.exec('INSERT INTO agent_turn_events (turn_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,?)', [turn.id, seq, 'error', JSON.stringify({ type: 'error', code: 'TURN_INTERRUPTED', message: '网关进程中断，回合未完成', retryable: false }), now]);
      }
      result.sessions = this.db.exec("UPDATE agent_sessions SET status = 'error', resume_cause = 'interrupted', updated_at = ? WHERE status = 'running'", [now]).changes;
      result.jobs = this.db.exec("UPDATE jobs SET last_status = 'error', last_error = '进程中断，运行未完成', updated_at = ? WHERE last_status = 'running'", [now]).changes;
      const artifactRuns = this.db.all<{ id: string; started_at: string }>("SELECT id,started_at FROM artifact_runs WHERE status IN ('queued','running','waiting_approval')");
      result.artifactRuns = this.db.exec("UPDATE artifact_runs SET status = 'failed', error = '进程中断，运行未完成', finished_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) WHERE status IN ('queued','running','waiting_approval')", [now, now]).changes;
      for (const run of artifactRuns) {
        const seq = this.db.one<{ seq: number }>('SELECT COALESCE(MAX(seq),0) + 1 AS seq FROM artifact_run_events WHERE run_id = ?', [run.id])?.seq ?? 1;
        const durationMs = Math.max(0, Date.now() - new Date(run.started_at).getTime());
        this.db.exec('INSERT INTO artifact_run_events (run_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,?)', [run.id, seq, 'run_finished', JSON.stringify({ type: 'run_finished', seq, runId: run.id, status: 'failed', durationMs }), now]);
      }
      result.artifacts = this.db.exec("UPDATE artifacts SET status = 'error', updated_at = ? WHERE status = 'running'", [now]).changes;
      result.pipelineRuns = this.db.exec("UPDATE pipeline_runs SET status = 'error', error = '进程中断，运行未完成', finished_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) WHERE status = 'running'", [now, now]).changes;
      result.pipelines = this.db.exec("UPDATE pipelines SET last_status = 'error', last_error = '进程中断，运行未完成', updated_at = ? WHERE last_status = 'running'", [now]).changes;
      result.dashboardCards = this.db.exec("UPDATE dashboard_cards SET last_status = 'error', last_error = '进程中断，刷新未完成', updated_at = ? WHERE last_status = 'running'", [now]).changes;
      result.dashboardSchedules = this.db.exec("UPDATE dashboard_schedules SET last_status = 'error', last_error = '进程中断，刷新未完成', updated_at = ? WHERE last_status = 'running'", [now]).changes;
      result.artifactSchedules = this.db.exec("UPDATE artifact_schedules SET last_status = 'error', last_error = '进程中断，运行未完成', updated_at = ? WHERE last_status = 'running'", [now]).changes;
      this.db.db.exec('COMMIT');
    } catch (err) {
      this.db.db.exec('ROLLBACK');
      throw err;
    }
    return result;
  }
}
