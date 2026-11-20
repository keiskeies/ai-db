import { randomUUID } from 'node:crypto';
import type { QueryHistoryItem } from '@aidb/core';
import { StoreDb, iso } from './db';
import type { Store } from '../store';

export class HistoryRepo {
  constructor(private db: StoreDb, private store: Store) {}

  // ---------- query history ----------
  addHistory(item: Omit<QueryHistoryItem, 'id' | 'createdAt'>): QueryHistoryItem {
    const entry: QueryHistoryItem = { ...item, id: randomUUID(), createdAt: iso() };
    this.db.exec(
      'INSERT INTO query_history (id,connection_id,database_name,sql,status,duration_ms,row_count,error,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [entry.id, entry.connectionId ?? null, entry.database ?? null, entry.sql, entry.status, entry.durationMs ?? null, entry.rowCount ?? null, entry.error ?? null, entry.createdAt],
    );
    return entry;
  }

  /** 收藏永久保留；其余按条数与天数双阈值裁剪，避免历史表无限增长。 */
  pruneHistory(): void {
    const { historyLimit, historyRetentionDays } = this.store.getSettings();
    const keep = Math.min(100_000, Math.max(10, Math.floor(historyLimit)));
    if (historyRetentionDays > 0) {
      const cutoff = new Date(Date.now() - historyRetentionDays * 86_400_000).toISOString();
      this.db.exec('DELETE FROM query_history WHERE COALESCE(favorite, 0) = 0 AND created_at < ?', [cutoff]);
    }
    // 取最近 keep 条非收藏的 rowid 边界后范围删除，语义等价旧 NOT IN，但避免大列表全表探测。
    this.db.exec(
      `DELETE FROM query_history WHERE COALESCE(favorite, 0) = 0 AND rowid < COALESCE((
         SELECT MIN(rowid) FROM (SELECT rowid FROM query_history WHERE COALESCE(favorite, 0) = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?)
       ), 0)`,
      [keep],
    );
  }

  listHistory(opts: { connectionId?: string; search?: string; limit?: number } = {}): QueryHistoryItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.connectionId) {
      clauses.push('connection_id = ?');
      params.push(opts.connectionId);
    }
    if (opts.search) {
      clauses.push('sql LIKE ?');
      params.push(`%${opts.search}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    return this.db.all<Record<string, any>>(`SELECT * FROM query_history ${where} ORDER BY COALESCE(favorite, 0) DESC, created_at DESC LIMIT ${limit}`, params).map((r) => ({
      id: r.id,
      connectionId: r.connection_id ?? undefined,
      database: r.database_name ?? undefined,
      sql: r.sql,
      status: r.status,
      durationMs: r.duration_ms ?? undefined,
      rowCount: r.row_count ?? undefined,
      error: r.error ?? undefined,
      favorite: Number(r.favorite ?? 0) === 1,
      createdAt: r.created_at,
    }));
  }

  setHistoryFavorite(id: string, favorite: boolean): boolean {
    return this.db.exec('UPDATE query_history SET favorite = ? WHERE id = ?', [favorite ? 1 : 0, id]).changes > 0;
  }

  clearHistory(): void {
    this.db.exec('DELETE FROM query_history');
  }

  // ---------- snippets ----------
  listSnippets(): Array<{ id: string; name: string; sql: string; tags: string[]; createdAt: string }> {
    return this.db.all<Record<string, any>>('SELECT * FROM snippets ORDER BY created_at DESC').map((r) => ({
      id: r.id,
      name: r.name,
      sql: r.sql,
      tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
      createdAt: r.created_at,
    }));
  }

  createSnippet(input: { name: string; sql: string; tags?: string[] }): { id: string } {
    const id = randomUUID();
    this.db.exec('INSERT INTO snippets (id,name,sql,tags,created_at) VALUES (?,?,?,?,?)', [id, input.name, input.sql, JSON.stringify(input.tags ?? []), iso()]);
    return { id };
  }

  deleteSnippet(id: string): void {
    this.db.exec('DELETE FROM snippets WHERE id = ?', [id]);
  }
}
