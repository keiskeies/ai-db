import { randomUUID } from 'node:crypto';
import {
  DASHBOARD_CARD_LIMIT,
  type DashboardCard,
  type DashboardCardInput,
  type DashboardCardSource,
  type DashboardChartType,
  type DashboardScheduleInfo,
} from '@aidb/core';
import { StoreDb, iso } from './db';

interface DashboardCardRow {
  id: string;
  scope_key: string;
  connection_id: string;
  database_name: string | null;
  title: string;
  sql: string;
  chart_type: string;
  series_x: string | null;
  series_y: string | null;
  time_column: string | null;
  span: number;
  position: number;
  source: string;
  pinned: number;
  last_result_json: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  schema_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** 快照只为「打开即见图」服务，行数必须封顶，否则 App 存储会被大结果集撑爆。 */
function trimDashboardResult(result: { columns: Array<{ name: string }>; rows: unknown[][] } | undefined) {
  if (!result) return { columns: [], rows: [] };
  return { columns: result.columns.slice(0, 64), rows: result.rows.slice(0, 200).map((row) => row.slice(0, 64)) };
}

export class DashboardsRepo {
  constructor(private db: StoreDb) {}

  private scopeKey(connectionId: string, database?: string): string {
    return `${connectionId}/${database ?? ''}`;
  }

  private rowToDashboardCard(row: DashboardCardRow): DashboardCard {
    let lastResult: DashboardCard['lastResult'] | undefined;
    if (row.last_result_json) {
      try {
        lastResult = JSON.parse(row.last_result_json) as DashboardCard['lastResult'];
      } catch {
        lastResult = undefined;
      }
    }
    return {
      id: row.id,
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      title: row.title,
      sql: row.sql,
      chartType: row.chart_type as DashboardChartType,
      x: row.series_x ?? undefined,
      y: row.series_y ?? undefined,
      timeColumn: row.time_column ?? undefined,
      span: row.span === 2 ? 2 : 1,
      position: row.position,
      source: row.source as DashboardCardSource,
      pinned: Boolean(row.pinned),
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status === 'ok' || row.last_status === 'error' ? row.last_status : undefined,
      lastError: row.last_error ?? undefined,
      lastResult,
      schemaHash: row.schema_hash ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listDashboardCards(connectionId: string, database?: string): DashboardCard[] {
    const rows = this.db.all<DashboardCardRow>(
      'SELECT * FROM dashboard_cards WHERE scope_key = ? ORDER BY position, created_at',
      [this.scopeKey(connectionId, database)],
    );
    return rows.map((row) => this.rowToDashboardCard(row));
  }

  dashboardCard(id: string): DashboardCard | undefined {
    const row = this.db.one<DashboardCardRow>('SELECT * FROM dashboard_cards WHERE id = ?', [id]);
    return row ? this.rowToDashboardCard(row) : undefined;
  }

  insertDashboardCard(input: DashboardCardInput): DashboardCard {
    const now = iso();
    const id = randomUUID();
    const position = input.position ?? this.listDashboardCards(input.connectionId, input.database).length + 1;
    this.db.exec(
      `INSERT INTO dashboard_cards
       (id,scope_key,connection_id,database_name,title,sql,chart_type,series_x,series_y,time_column,span,position,source,pinned,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        this.scopeKey(input.connectionId, input.database),
        input.connectionId,
        input.database ?? null,
        input.title.trim(),
        input.sql.trim(),
        input.chartType,
        input.x ?? null,
        input.y ?? null,
        input.timeColumn ?? null,
        input.span === 2 ? 2 : 1,
        position,
        input.source ?? 'manual',
        input.pinned === false ? 0 : 1,
        now,
        now,
      ],
    );
    return this.dashboardCard(id)!;
  }

  /** 逐字段更新：undefined 表示不改，null 表示清空该字段。 */
  updateDashboardCard(
    id: string,
    patch: Omit<Partial<DashboardCardInput>, 'timeColumn'> & {
      timeColumn?: string | null;
      lastResult?: DashboardCard['lastResult'];
      lastStatus?: 'ok' | 'error';
      lastError?: string;
      schemaHash?: string | null;
    },
  ): DashboardCard | undefined {
    const existing = this.db.one<DashboardCardRow>('SELECT * FROM dashboard_cards WHERE id = ?', [id]);
    if (!existing) return undefined;
    const next = [
      patch.title?.trim() || existing.title,
      patch.sql?.trim() || existing.sql,
      patch.chartType ?? existing.chart_type,
      patch.x === undefined ? existing.series_x : patch.x ?? null,
      patch.y === undefined ? existing.series_y : patch.y ?? null,
      patch.timeColumn === undefined ? existing.time_column : patch.timeColumn ?? null,
      patch.span === undefined ? existing.span : patch.span === 2 ? 2 : 1,
      patch.position === undefined ? existing.position : patch.position,
      patch.pinned === undefined ? existing.pinned : patch.pinned ? 1 : 0,
      patch.source ?? existing.source,
      patch.lastResult === undefined ? existing.last_result_json : JSON.stringify(trimDashboardResult(patch.lastResult)),
      patch.lastStatus === undefined ? existing.last_status : patch.lastStatus,
      patch.lastError === undefined ? existing.last_error : patch.lastError,
      patch.schemaHash === undefined ? existing.schema_hash : patch.schemaHash,
      iso(),
      id,
    ];
    this.db.exec(
      `UPDATE dashboard_cards SET title=?, sql=?, chart_type=?, series_x=?, series_y=?, time_column=?, span=?, position=?, pinned=?,
       source=?, last_result_json=?, last_status=?, last_error=?, schema_hash=?, updated_at=? WHERE id=?`,
      next,
    );
    return this.dashboardCard(id);
  }

  deleteDashboardCard(id: string): void {
    this.db.exec('DELETE FROM dashboard_cards WHERE id = ?', [id]);
  }

  /**
   * 整批替换草稿卡片：只删 pinned = 0 的行，用户固定的卡片不受影响。
   * 生成器因此永远无法「重设」掉用户攒下的看板。
   */
  setDraftCards(connectionId: string, database: string | undefined, cards: DashboardCardInput[]): DashboardCard[] {
    const scope = this.scopeKey(connectionId, database);
    this.db.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM dashboard_cards WHERE scope_key = ? AND pinned = 0', [scope]);
      const kept = Number(this.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM dashboard_cards WHERE scope_key = ?', [scope])?.n ?? 0);
      const slots = Math.max(0, DASHBOARD_CARD_LIMIT - kept);
      cards.slice(0, slots).forEach((card, index) => {
        const inserted = this.insertDashboardCard({
          ...card,
          connectionId,
          database,
          source: card.source ?? 'ai',
          pinned: false,
          position: kept + index + 1,
        });
        // 生成器试跑带回来的结果直接当快照存，卡片入板就能画出来
        if (card.lastResult) this.updateDashboardCard(inserted.id, { lastResult: card.lastResult, lastStatus: 'ok' });
      });
      this.db.db.exec('COMMIT');
    } catch (err) {
      this.db.db.exec('ROLLBACK');
      throw err;
    }
    return this.listDashboardCards(connectionId, database);
  }

  /** 丢弃当前作用域的全部草稿，保留固定卡片。 */
  discardDashboardDrafts(connectionId: string, database?: string): number {
    const result = this.db.exec('DELETE FROM dashboard_cards WHERE scope_key = ? AND pinned = 0', [
      this.scopeKey(connectionId, database),
    ]);
    return result.changes;
  }

  reorderDashboardCards(ids: string[]): DashboardCard[] {
    if (!ids.length) return [];
    const first = this.db.one<DashboardCardRow>('SELECT * FROM dashboard_cards WHERE id = ?', [ids[0]]);
    if (!first) return [];
    this.db.db.exec('BEGIN');
    try {
      ids.forEach((id, index) => {
        this.db.exec('UPDATE dashboard_cards SET position = ?, updated_at = ? WHERE id = ?', [index + 1, iso(), id]);
      });
      this.db.db.exec('COMMIT');
    } catch (err) {
      this.db.db.exec('ROLLBACK');
      throw err;
    }
    return this.listDashboardCards(first.connection_id, first.database_name ?? undefined);
  }

  removeDashboardScope(connectionId: string, database?: string): number {
    const scope = this.scopeKey(connectionId, database);
    const result = database
      ? this.db.exec('DELETE FROM dashboard_cards WHERE scope_key = ?', [scope])
      : this.db.exec('DELETE FROM dashboard_cards WHERE connection_id = ?', [connectionId]);
    this.db.exec('DELETE FROM dashboard_schedules WHERE scope_key = ?', [scope]);
    return result.changes;
  }

  private rowToDashboardSchedule(row: Record<string, any>): DashboardScheduleInfo {
    let channels: string[] = [];
    try {
      channels = Array.isArray(JSON.parse(row.notify_channels ?? '[]')) ? JSON.parse(row.notify_channels ?? '[]') : [];
    } catch {
      channels = [];
    }
    return {
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      intervalSeconds: Number(row.interval_seconds),
      enabled: Boolean(row.enabled),
      notifyChannels: channels,
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status === 'ok' || row.last_status === 'error' ? row.last_status : undefined,
      lastError: row.last_error ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  getDashboardSchedule(connectionId: string, database?: string): DashboardScheduleInfo | undefined {
    const row = this.db.one<Record<string, any>>('SELECT * FROM dashboard_schedules WHERE scope_key = ?', [
      this.scopeKey(connectionId, database),
    ]);
    return row ? this.rowToDashboardSchedule(row) : undefined;
  }

  /** 只列出启用中的定时，供调度器轮询。 */
  listDashboardSchedules(): DashboardScheduleInfo[] {
    return this.db.all<Record<string, any>>('SELECT * FROM dashboard_schedules WHERE enabled = 1 ORDER BY last_run_at')
      .map((row) => this.rowToDashboardSchedule(row));
  }

  setDashboardSchedule(input: {
    connectionId: string;
    database?: string;
    intervalSeconds: number;
    enabled: boolean;
    notifyChannels?: string[];
  }): DashboardScheduleInfo | undefined {
    const now = iso();
    const scope = this.scopeKey(input.connectionId, input.database);
    this.db.exec(
      `INSERT INTO dashboard_schedules (scope_key,connection_id,database_name,interval_seconds,enabled,notify_channels,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(scope_key) DO UPDATE SET interval_seconds = excluded.interval_seconds, enabled = excluded.enabled,
         notify_channels = excluded.notify_channels, updated_at = excluded.updated_at`,
      [
        scope,
        input.connectionId,
        input.database ?? null,
        Math.max(60, Math.floor(input.intervalSeconds)),
        input.enabled ? 1 : 0,
        JSON.stringify(input.notifyChannels ?? []),
        now,
        now,
      ],
    );
    return this.getDashboardSchedule(input.connectionId, input.database);
  }

  markDashboardScheduleRun(connectionId: string, database: string | undefined, status: 'ok' | 'error', error?: string): void {
    this.db.exec('UPDATE dashboard_schedules SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE scope_key = ?', [
      iso(),
      status,
      error ?? null,
      iso(),
      this.scopeKey(connectionId, database),
    ]);
  }

  removeDashboardSchedule(connectionId: string, database?: string): void {
    this.db.exec('DELETE FROM dashboard_schedules WHERE scope_key = ?', [this.scopeKey(connectionId, database)]);
  }
}
