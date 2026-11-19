import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { classifyStatement, type ColumnInfo, type ForeignKeyInfo, type IndexInfo, type QueryResult, type TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, estimateValueBytes, MAX_RESULT_BYTES, toRowArray } from './types';
import { wrapSelectLimit } from './sqlCap';

/**
 * node:sqlite 只接受 null / number / bigint / string / Uint8Array。
 * 网格编辑与导入会把 BOOLEAN 列原样传成 JS 布尔，必须在绑定前归一化。
 */
function normalizeParams(params: unknown[]): unknown[] {
  return params.map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

export class SqliteDriver implements Driver {
  engine = 'sqlite' as const;
  private db: DatabaseSync;
  /** 进行中的事务会话（SQLite 单连接，同一时刻只允许一个）。 */
  private txSessions = new Set<string>();

  constructor(private filePath: string, readonly: boolean) {
    if (!existsSync(filePath)) throw new DbError(`SQLite 文件不存在：${filePath}`, { code: 'SQLITE_NOT_FOUND' });
    this.db = new DatabaseSync(filePath, { readOnly: readonly });
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const row = this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      return { ok: true, version: `SQLite ${row.v}`, latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['main'];
  }

  async describe(): Promise<TableInfo[]> {
    const objects = this.db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<{ name: string; type: string }>;
    const tables: TableInfo[] = [];
    for (const obj of objects) {
      const quoted = `"${obj.name.replace(/"/g, '""')}"`;
      const cols = this.db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<Record<string, unknown>>;
      const colInfos: ColumnInfo[] = cols.map((c) => ({
        name: String(c.name),
        type: String(c.type || 'TEXT'),
        nullable: Number(c.notnull) === 0,
        defaultValue: c.dflt_value === null ? null : String(c.dflt_value),
        primaryKey: Number(c.pk) > 0,
        autoIncrement: false,
      }));
      // Detect AUTOINCREMENT from the original DDL (PRAGMA does not expose it).
      const ddl = this.db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(obj.name) as { sql?: string } | undefined;
      if (ddl?.sql && /AUTOINCREMENT/i.test(ddl.sql)) {
        const pk = colInfos.find((c) => c.primaryKey);
        if (pk) pk.autoIncrement = true;
      }
      const idxRows = (this.db.prepare(`PRAGMA index_list(${quoted})`).all() as Array<Record<string, unknown>>).filter(
        (idx) => !String(idx.name).startsWith('sqlite_autoindex_'),
      );
      const indexes: IndexInfo[] = idxRows.map((idx) => {
        const idxName = String(idx.name);
        const colsInfo = this.db.prepare(`PRAGMA index_info("${idxName.replace(/"/g, '""')}")`).all() as Array<Record<string, unknown>>;
        return {
          name: idxName,
          columns: colsInfo.map((ci) => String(ci.name)),
          unique: Number(idx.unique) === 1,
          primary: String(idx.origin) === 'pk',
        };
      });
      const fkRows = this.db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<Record<string, unknown>>;
      const fkMap = new Map<number, ForeignKeyInfo>();
      for (const fk of fkRows) {
        const id = Number(fk.id);
        const entry = fkMap.get(id) ?? { name: `fk_${obj.name}_${id}`, columns: [], refTable: String(fk.table), refColumns: [], onDelete: String(fk.on_delete) };
        entry.columns.push(String(fk.from));
        entry.refColumns.push(String(fk.to));
        fkMap.set(id, entry);
      }
      let rowEstimate: number | undefined;
      if (obj.type === 'table') {
        // 不做 COUNT(*) 全表扫描（大表上 describe 会卡死事件循环）。
        // sqlite_stat1 只在跑过 ANALYZE 后存在，stat 首段是估算行数。
        try {
          const stat = this.db.prepare('SELECT stat FROM sqlite_stat1 WHERE tbl = ? LIMIT 1').get(obj.name) as { stat?: string } | undefined;
          const first = stat?.stat?.split(/\s+/)[0];
          if (first !== undefined && Number.isFinite(Number(first))) rowEstimate = Number(first);
        } catch {
          /* 未 ANALYZE 时 sqlite_stat1 不存在 */
        }
        // stat1 缺失（多数库从未 ANALYZE）时退到 MAX(rowid)：rowid 表上它读 B 树最右
        // 叶节点，O(log n) 不扫全表。报告/仪表板拿它过滤事实表，全空会让功能静默退化。
        // WITHOUT ROWID 表没有 rowid 列，报错即跳过。
        if (rowEstimate === undefined) {
          try {
            const quoted = `"${String(obj.name).replaceAll('"', '""')}"`;
            const max = this.db.prepare(`SELECT MAX(rowid) AS n FROM ${quoted}`).get() as { n?: number | bigint | null };
            const n = Number(max?.n);
            if (max?.n !== null && max?.n !== undefined && Number.isFinite(n) && n > 0) rowEstimate = n;
          } catch {
            /* WITHOUT ROWID 表或损坏对象 */
          }
        }
      }
      tables.push({
        name: obj.name,
        type: obj.type === 'view' ? 'view' : 'table',
        schema: 'main',
        rowEstimate,
        columns: colInfos,
        indexes,
        foreignKeys: [...fkMap.values()],
      });
    }
    return tables;
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async execScript(sql: string): Promise<void> {
    if (this.txSessions.size) throw new DbError('有进行中的事务，无法执行脚本', { code: 'TX_ACTIVE' });
    try {
      this.db.exec(sql);
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 脚本没有开启事务时无需回滚 */
      }
      throw new DbError(err?.message ?? 'SQLite 脚本执行失败', { code: 'SQLITE_ERROR' });
    }
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    const bound = normalizeParams(params);
    try {
      const stmt = this.db.prepare(sql);
      const kind = classifyStatement(sql, 'sqlite').kind;
      const isRead = kind === 'read' || /^\s*PRAGMA\b/i.test(sql);
      if (isRead) {
        const stmtAny = stmt as unknown as {
          columns?: () => Array<{ name: string; type?: string }>;
          iterate?: (...args: unknown[]) => IterableIterator<Record<string, unknown>>;
        };
        let columns = (stmtAny.columns?.() ?? []).map((c) => ({ name: c.name, type: c.type || undefined }));
        const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : Number.POSITIVE_INFINITY;
        const rows: Record<string, unknown>[] = [];
        let bytes = 0;
        let truncated = false;
        // 行数/字节双上限（对齐 mysql.ts 的 64MB 语义）：首行即使单独超预算也保留，
        // 否则用户什么都看不到；此后严格执行预算，到达上限立即停止读取。
        const take = (raw: Record<string, unknown>): boolean => {
          if (!columns.length) columns = Object.keys(raw).map((name) => ({ name, type: undefined as string | undefined }));
          let size = 16;
          for (const key in raw) size += estimateValueBytes(raw[key]) + key.length;
          if (rows.length >= maxRows || (rows.length > 0 && bytes + size > MAX_RESULT_BYTES)) {
            truncated = true;
            return false;
          }
          rows.push(raw);
          bytes += size;
          if (bytes >= MAX_RESULT_BYTES) {
            truncated = true;
            return false;
          }
          return true;
        };
        // node:sqlite 是同步 API，阻塞事件循环本身无法消除；iterate（Node ≥22.13）逐行读，
        // 配合双上限保证最坏情况有界，不再 .all() 把整张表一次性吃进堆。
        if (typeof stmtAny.iterate === 'function') {
          for (const raw of stmtAny.iterate(...bound)) {
            if (!take(raw)) break;
          }
        } else {
          // 无 iterate 的旧运行时：单条 SELECT/WITH 下推 LIMIT maxRows+1 缩小全量缓冲，
          // 读入后再按行数/字节裁剪。多语句/非 SELECT 无法下推，只能靠裁剪兜底。
          const pushed = Number.isFinite(maxRows) ? wrapSelectLimit(sql, maxRows + 1, 'sqlite') : undefined;
          const target = pushed ? this.db.prepare(pushed) : stmt;
          const rawRows = (target.all as (...args: unknown[]) => Record<string, unknown>[])(...bound);
          for (const raw of rawRows) {
            if (!take(raw)) break;
          }
        }
        return {
          columns,
          rows: toRowArray(columns, rows),
          rowCount: rows.length,
          durationMs: Date.now() - started,
          truncated,
          statement: sql,
        };
      }
      const result = (stmt.run as (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(...bound);
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affected: Number(result.changes),
        lastInsertId: typeof result.lastInsertRowid === 'bigint' ? Number(result.lastInsertRowid) : result.lastInsertRowid,
        durationMs: Date.now() - started,
        statement: sql,
      };
    } catch (err: any) {
      throw new DbError(err.message ?? 'SQLite 执行失败', { code: 'SQLITE_ERROR' });
    }
  }

  async dumpSchema(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name")
      .all() as Array<{ sql: string }>;
    return rows.map((r) => `${r.sql};`);
  }

  async filePathValue(): Promise<string> {
    return this.filePath;
  }

  /**
   * SQLite 整个驱动只有一条连接，所以事务天然跨请求生效，不需要固定连接。
   * 记录会话 id 只是为了校验顺序与避免嵌套事务。
   */
  async beginTransaction(sessionId: string, _database?: string): Promise<void> {
    if (this.txSessions.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    if (this.txSessions.size) throw new DbError('已有进行中的事务，SQLite 同一时刻只允许一个', { code: 'TX_ACTIVE' });
    try {
      this.db.exec('BEGIN');
    } catch (err: any) {
      throw new DbError(err?.message ?? '开启事务失败', { code: 'TX_BEGIN' });
    }
    this.txSessions.add(sessionId);
  }

  async runInTransaction(sessionId: string, sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    if (!this.txSessions.has(sessionId)) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    return this.runParams(sql, params, opts);
  }

  async commitTransaction(sessionId: string): Promise<void> {
    this.finishTransaction(sessionId, 'COMMIT');
  }

  async rollbackTransaction(sessionId: string): Promise<void> {
    this.finishTransaction(sessionId, 'ROLLBACK');
  }

  private finishTransaction(sessionId: string, command: 'COMMIT' | 'ROLLBACK'): void {
    if (!this.txSessions.has(sessionId)) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    this.txSessions.delete(sessionId);
    try {
      this.db.exec(command);
    } catch (err: any) {
      throw new DbError(err?.message ?? `${command === 'COMMIT' ? '提交' : '回滚'}事务失败`, {
        code: command === 'COMMIT' ? 'TX_COMMIT' : 'TX_ROLLBACK',
      });
    }
  }

  async close(): Promise<void> {
    // 连接关闭前先回滚，避免留下未提交的写事务。
    for (const sessionId of [...this.txSessions]) {
      try {
        this.finishTransaction(sessionId, 'ROLLBACK');
      } catch {
        /* 关闭阶段忽略 */
      }
    }
    this.db.close();
  }
}
