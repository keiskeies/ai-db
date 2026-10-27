import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { classifyStatement, type ColumnInfo, type ForeignKeyInfo, type IndexInfo, type QueryResult, type TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError, toRowArray } from './types';

export class SqliteDriver implements Driver {
  engine = 'sqlite' as const;
  private db: DatabaseSync;

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
        try {
          rowEstimate = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get() as { c: number }).c);
        } catch {
          rowEstimate = undefined;
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

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const started = Date.now();
    try {
      const stmt = this.db.prepare(sql);
      const kind = classifyStatement(sql).kind;
      const isRead = kind === 'read' || /^\s*PRAGMA\b/i.test(sql);
      if (isRead) {
        const stmtAny = stmt as unknown as { columns?: () => Array<{ name: string; type?: string }> };
        let columns = (stmtAny.columns?.() ?? []).map((c) => ({ name: c.name, type: c.type || undefined }));
        const rawRows = (stmt.all as (...args: unknown[]) => Record<string, unknown>[])(...params);
        if (!columns.length && rawRows.length) {
          columns = Object.keys(rawRows[0]).map((name) => ({ name, type: undefined as string | undefined }));
        }
        const limit = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : rawRows.length;
        const rows = rawRows.slice(0, limit);
        return {
          columns,
          rows: toRowArray(columns, rows),
          rowCount: rows.length,
          durationMs: Date.now() - started,
          truncated: rawRows.length > rows.length,
          statement: sql,
        };
      }
      const result = (stmt.run as (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(...params);
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

  async close(): Promise<void> {
    this.db.close();
  }
}
