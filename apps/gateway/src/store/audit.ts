import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '@aidb/core';
import { StoreDb, iso } from './db';

interface AuditRow {
  id: string;
  actor: AuditEntry['actor'];
  connection_id: string | null;
  database_name: string | null;
  tool: string | null;
  sql: string | null;
  risk: AuditEntry['risk'] | null;
  approval: string | null;
  status: AuditEntry['status'];
  duration_ms: number | null;
  meta_json: string | null;
  created_at: string;
}

/** 审计 / 工具运行 / 产物运行只写不删会无限膨胀，按条数保留最近记录。 */
const AUDIT_LOG_LIMIT = 5000;

export class AuditRepo {
  constructor(private db: StoreDb) {}

  // ---------- audit ----------
  addAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'> & { createdAt?: string }): AuditEntry {
    const full: AuditEntry = { ...entry, id: randomUUID(), createdAt: entry.createdAt ?? iso() };
    this.db.exec(
      'INSERT INTO audit_log (id,actor,connection_id,database_name,tool,sql,risk,approval,status,duration_ms,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        full.id,
        full.actor,
        full.connectionId ?? null,
        full.database ?? null,
        full.tool ?? null,
        full.sql ?? null,
        full.risk ?? null,
        full.approval ?? null,
        full.status,
        full.durationMs ?? null,
        full.meta ? JSON.stringify(full.meta) : null,
        full.createdAt,
      ],
    );
    return full;
  }

  listAudit(opts: { limit?: number; offset?: number; connectionId?: string; actor?: string } = {}): AuditEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.connectionId) {
      clauses.push('connection_id = ?');
      params.push(opts.connectionId);
    }
    if (opts.actor) {
      clauses.push('actor = ?');
      params.push(opts.actor);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(1000, Math.max(1, opts.limit ?? 200));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.db.all<AuditRow>(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params).map((r) => ({
      id: r.id,
      actor: r.actor,
      connectionId: r.connection_id ?? undefined,
      database: r.database_name ?? undefined,
      tool: r.tool ?? undefined,
      sql: r.sql ?? undefined,
      risk: r.risk ?? undefined,
      approval: r.approval ?? undefined,
      status: r.status,
      durationMs: r.duration_ms ?? undefined,
      meta: r.meta_json ? (JSON.parse(r.meta_json) as Record<string, unknown>) : undefined,
      createdAt: r.created_at,
    }));
  }

  pruneAuditLog(): void {
    this.db.pruneTable('audit_log', AUDIT_LOG_LIMIT);
  }
}
