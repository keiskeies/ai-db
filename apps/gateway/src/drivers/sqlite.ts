import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { classifyStatement, type QueryResult, type TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError } from './types';
import { wrapSelectLimit } from './sqlCap';
import { throwIfAborted } from './timeout';

const SQLITE_DEFAULT_TIMEOUT_MS = 30_000;
const SQLITE_SCRIPT_TIMEOUT_MS = 600_000;
const SQLITE_INIT_TIMEOUT_MS = 10_000;
const SQLITE_MAX_RESULT_BYTES = 64 * 1024 * 1024;

// node:sqlite exposes only synchronous calls, so a deadline on the gateway event loop cannot interrupt them.
const SQLITE_CHILD_SOURCE = `
import { DatabaseSync } from 'node:sqlite';

let db;
const maxResultBytes = 64 * 1024 * 1024;

function estimateValueBytes(value) {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Date) {
    return value.byteLength || 8;
  }
  try {
    return JSON.stringify(value)?.length ?? 8;
  } catch {
    return 8;
  }
}

function quote(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function describe() {
  const objects = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const tables = [];
  for (const obj of objects) {
    const quoted = quote(obj.name);
    const cols = db.prepare('PRAGMA table_info(' + quoted + ')').all();
    const colInfos = cols.map((c) => ({
      name: String(c.name),
      type: String(c.type || 'TEXT'),
      nullable: Number(c.notnull) === 0,
      defaultValue: c.dflt_value === null ? null : String(c.dflt_value),
      primaryKey: Number(c.pk) > 0,
      autoIncrement: false,
    }));
    const ddl = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(obj.name);
    if (ddl?.sql && /AUTOINCREMENT/i.test(ddl.sql)) {
      const pk = colInfos.find((c) => c.primaryKey);
      if (pk) pk.autoIncrement = true;
    }
    const idxRows = db.prepare('PRAGMA index_list(' + quoted + ')').all().filter((idx) => !String(idx.name).startsWith('sqlite_autoindex_'));
    const indexes = idxRows.map((idx) => {
      const idxName = String(idx.name);
      const colsInfo = db.prepare('PRAGMA index_info(' + quote(idxName) + ')').all();
      return {
        name: idxName,
        columns: colsInfo.map((ci) => String(ci.name)),
        unique: Number(idx.unique) === 1,
        primary: String(idx.origin) === 'pk',
      };
    });
    const fkRows = db.prepare('PRAGMA foreign_key_list(' + quoted + ')').all();
    const fkMap = new Map();
    for (const fk of fkRows) {
      const id = Number(fk.id);
      const entry = fkMap.get(id) ?? { name: 'fk_' + obj.name + '_' + id, columns: [], refTable: String(fk.table), refColumns: [], onDelete: String(fk.on_delete) };
      entry.columns.push(String(fk.from));
      entry.refColumns.push(String(fk.to));
      fkMap.set(id, entry);
    }
    let rowEstimate;
    if (obj.type === 'table') {
      try {
        const stat = db.prepare('SELECT stat FROM sqlite_stat1 WHERE tbl = ? LIMIT 1').get(obj.name);
        const first = stat?.stat?.trim().split(/\\s+/)[0];
        if (first !== undefined && Number.isFinite(Number(first))) rowEstimate = Number(first);
      } catch {}
      if (rowEstimate === undefined) {
        try {
          const max = db.prepare('SELECT MAX(rowid) AS n FROM ' + quoted).get();
          const n = Number(max?.n);
          if (max?.n !== null && max?.n !== undefined && Number.isFinite(n) && n > 0) rowEstimate = n;
        } catch {}
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

function query(message) {
  const started = Date.now();
  const params = (message.params ?? []).map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return value;
  });
  const stmt = db.prepare(message.sql);
  if (!message.isRead) {
    const result = stmt.run(...params);
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affected: Number(result.changes),
      lastInsertId: typeof result.lastInsertRowid === 'bigint' ? Number(result.lastInsertRowid) : result.lastInsertRowid,
      durationMs: Date.now() - started,
      statement: message.sql,
    };
  }
  let columns = (stmt.columns?.() ?? []).map((c) => ({ name: c.name, type: c.type || undefined }));
  const maxRows = message.maxRows && message.maxRows > 0 ? message.maxRows : Number.POSITIVE_INFINITY;
  const rows = [];
  let bytes = 0;
  let truncated = false;
  const take = (raw) => {
    if (!columns.length) columns = Object.keys(raw).map((name) => ({ name, type: undefined }));
    let size = 16;
    for (const key in raw) size += estimateValueBytes(raw[key]) + key.length;
    if (rows.length >= maxRows || (rows.length > 0 && bytes + size > maxResultBytes)) {
      truncated = true;
      return false;
    }
    rows.push(raw);
    bytes += size;
    if (bytes >= maxResultBytes) {
      truncated = true;
      return false;
    }
    return true;
  };
  if (typeof stmt.iterate === 'function') {
    for (const raw of stmt.iterate(...params)) {
      if (!take(raw)) break;
    }
  } else {
    const target = message.fallbackSql ? db.prepare(message.fallbackSql) : stmt;
    for (const raw of target.all(...params)) {
      if (!take(raw)) break;
    }
  }
  return {
    columns,
    rows: rows.map((raw) => columns.map((column) => raw[column.name] ?? null)),
    rowCount: rows.length,
    durationMs: Date.now() - started,
    truncated,
    statement: message.sql,
  };
}

process.on('message', (message) => {
  try {
    let value;
    switch (message.op) {
      case 'init':
        db = new DatabaseSync(message.filePath, { readOnly: message.readonly });
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA busy_timeout = 5000');
        value = true;
        break;
      case 'query':
        value = query(message);
        break;
      case 'exec':
        try {
          db.exec(message.sql);
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        value = true;
        break;
      case 'transaction':
        db.exec(message.sql);
        value = true;
        break;
      case 'describe':
        value = describe();
        break;
      case 'schema':
        value = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name").all().map((row) => row.sql + ';');
        break;
      case 'version':
        value = db.prepare('SELECT sqlite_version() AS v').get().v;
        break;
      case 'close':
        db?.close();
        db = undefined;
        value = true;
        break;
      default:
        throw new Error('Unsupported SQLite operation');
    }
    if (process.connected) process.send({ id: message.id, ok: true, value });
    if (message.op === 'close') setImmediate(() => process.exit(0));
  } catch (error) {
    if (process.connected) process.send({ id: message.id, ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
  }
});

process.on('disconnect', () => process.exit(0));
`;

type SqliteOperation = 'init' | 'query' | 'exec' | 'transaction' | 'describe' | 'schema' | 'version' | 'close';

interface PendingRequest {
  child: ChildProcess;
  operation: SqliteOperation;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface ChildResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { message?: string };
}

function connectionError(): DbError {
  return new DbError('SQLite 执行进程已断开', { code: 'SQLITE_CONNECTION_LOST', status: 503 });
}

function abortError(signal: AbortSignal): DbError {
  const reason = signal.reason as { name?: string } | undefined;
  if (reason instanceof DbError) return reason;
  if (reason?.name === 'TimeoutError') return new DbError('SQLite 初始化超时', { code: 'SQLITE_TIMEOUT', status: 504 });
  return new DbError('SQLite 执行已取消', { code: 'ABORTED' });
}

class SqliteConnection {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(private filePath: string, private readonly: boolean) {}

  async request<T>(operation: SqliteOperation, payload: Record<string, unknown>, opts: RunOptions & { timeoutMs?: number } = {}): Promise<T> {
    throwIfAborted(opts.signal);
    const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
      ? opts.timeoutMs!
      : operation === 'exec' ? SQLITE_SCRIPT_TIMEOUT_MS : SQLITE_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => {
      controller.abort(new DbError(`SQLite 执行超时（${timeoutMs}ms）`, { code: 'SQLITE_TIMEOUT', status: 504 }));
    }, timeoutMs);
    timer.unref?.();
    try {
      await this.ensureConnection(signal);
      throwIfAborted(signal);
      const child = this.child;
      if (!child) throw connectionError();
      return await this.send<T>(child, operation, payload, signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.stopping;
      return;
    }
    try {
      if (this.child) await this.request('close', {}, { timeoutMs: 5_000 });
    } catch {
      if (this.child) this.terminate(this.child);
    } finally {
      this.closed = true;
      if (this.child) this.terminate(this.child);
      await this.stopping;
    }
  }

  private async ensureConnection(signal: AbortSignal): Promise<void> {
    if (this.closed) throw new DbError('SQLite 连接已关闭', { code: 'SQLITE_CLOSED', status: 503 });
    if (this.stopping) await this.waitForSignal(this.stopping, signal);
    if (this.closed) throw new DbError('SQLite 连接已关闭', { code: 'SQLITE_CLOSED', status: 503 });
    if (this.starting) {
      await this.waitForSignal(this.starting, signal);
      return;
    }
    if (this.child?.connected) {
      if (this.ready) await this.waitForSignal(this.ready, signal);
      return;
    }
    const child = spawn(process.execPath, ['--input-type=module', '--eval', SQLITE_CHILD_SOURCE], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });
    child.stderr?.resume();
    this.child = child;
    child.on('message', (response: ChildResponse) => this.handleResponse(child, response));
    child.on('error', () => {
      this.rejectPending(connectionError(), child);
      this.terminate(child);
    });
    child.on('exit', () => this.handleExit(child));
    child.on('close', () => this.handleExit(child));
    const initSignal = AbortSignal.any([signal, AbortSignal.timeout(SQLITE_INIT_TIMEOUT_MS)]);
    const ready = this.send(child, 'init', { filePath: this.filePath, readonly: this.readonly }, initSignal);
    this.ready = ready.then(() => undefined);
    this.starting = this.ready.finally(() => {
      if (this.child === child) this.starting = undefined;
    });
    try {
      await this.waitForSignal(this.starting, signal);
    } catch (err) {
      this.terminate(child, err instanceof DbError ? err : undefined);
      throw err;
    }
  }

  private send<T>(child: ChildProcess, operation: SqliteOperation, payload: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      const error = abortError(signal);
      this.terminate(child, error);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      let finished = false;
      const settle = (callback: () => void) => {
        if (finished) return;
        finished = true;
        this.pending.delete(id);
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        const error = abortError(signal);
        settle(() => reject(error));
        this.terminate(child, error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { child, operation, resolve: (value) => settle(() => resolve(value as T)), reject: (error) => settle(() => reject(error)) });
      try {
        child.send({ id, op: operation, ...payload }, (error) => {
          if (!error || finished) return;
          settle(() => reject(connectionError()));
          this.terminate(child);
        });
      } catch {
        settle(() => reject(connectionError()));
        this.terminate(child);
      }
    });
  }

  private handleResponse(child: ChildProcess, response: ChildResponse): void {
    if (this.child !== child) return;
    const pending = this.pending.get(response.id);
    if (!pending || pending.child !== child) return;
    if (response.ok) {
      pending.resolve(response.value);
      return;
    }
    pending.reject(new DbError(response.error?.message ?? 'SQLite 执行失败', {
      code: pending.operation === 'init' ? 'SQLITE_OPEN' : 'SQLITE_ERROR',
    }));
  }

  private handleExit(child: ChildProcess): void {
    this.rejectPending(connectionError(), child);
    if (this.child === child) {
      this.child = undefined;
      this.ready = undefined;
      this.starting = undefined;
    }
  }

  private rejectPending(error: DbError, child?: ChildProcess): void {
    for (const [id, pending] of this.pending) {
      if (child && pending.child !== child) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async waitForSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      void work.catch(() => undefined);
      throw abortError(signal);
    }
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        const error = abortError(signal);
        void work.catch(() => undefined);
        this.terminate(this.child, error);
        reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  private terminate(child: ChildProcess | undefined, cause?: DbError): void {
    if (!child) return;
    const error = cause ?? connectionError();
    this.rejectPending(error, child);
    const stopped = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });
    child.kill('SIGKILL');
    if (this.child !== child || this.stopping) return;
    let tracked: Promise<void>;
    tracked = stopped.then(() => {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.starting = undefined;
      }
      if (this.stopping === tracked) this.stopping = undefined;
    });
    this.stopping = tracked;
  }
}

const PROCESS_BOUNDARY_ERRORS = new Set(['ABORTED', 'SQLITE_TIMEOUT', 'SQLITE_CONNECTION_LOST']);

export class SqliteDriver implements Driver {
  engine = 'sqlite' as const;
  private connection: SqliteConnection;
  private txSessions = new Set<string>();

  constructor(private filePath: string, readonly: boolean) {
    if (!existsSync(filePath)) throw new DbError(`SQLite 文件不存在：${filePath}`, { code: 'SQLITE_NOT_FOUND' });
    this.connection = new SqliteConnection(filePath, readonly);
  }

  private async execute<T>(operation: SqliteOperation, payload: Record<string, unknown>, opts: RunOptions = {}): Promise<T> {
    try {
      return await this.connection.request<T>(operation, payload, opts);
    } catch (err) {
      if (err instanceof DbError && PROCESS_BOUNDARY_ERRORS.has(err.code)) this.txSessions.clear();
      throw err;
    }
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const version = await this.execute<string>('version', {});
      return { ok: true, version: `SQLite ${version}`, latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err.message };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['main'];
  }

  async describe(): Promise<TableInfo[]> {
    return this.execute<TableInfo[]>('describe', {});
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.runParams(sql, [], opts);
  }

  async execScript(sql: string, _database?: string, opts: RunOptions = {}): Promise<void> {
    throwIfAborted(opts.signal);
    if (this.txSessions.size) throw new DbError('有进行中的事务，无法执行脚本', { code: 'TX_ACTIVE' });
    await this.execute('exec', { sql }, opts);
    throwIfAborted(opts.signal);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    throwIfAborted(opts.signal);
    const kind = classifyStatement(sql, 'sqlite').kind;
    const isRead = kind === 'read' || /^\s*PRAGMA\b/i.test(sql);
    const maxRows = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : Number.POSITIVE_INFINITY;
    const fallbackSql = isRead && Number.isFinite(maxRows) ? wrapSelectLimit(sql, maxRows + 1, 'sqlite') : undefined;
    try {
      return await this.execute<QueryResult>('query', {
        sql,
        params,
        isRead,
        maxRows: Number.isFinite(maxRows) ? maxRows : null,
        fallbackSql,
      }, opts);
    } catch (err: any) {
      if (err instanceof DbError) throw err;
      throw new DbError(err?.message ?? 'SQLite 执行失败', { code: 'SQLITE_ERROR' });
    }
  }

  async dumpSchema(): Promise<string[]> {
    return this.execute<string[]>('schema', {});
  }

  async filePathValue(): Promise<string> {
    return this.filePath;
  }

  async beginTransaction(sessionId: string, _database?: string): Promise<void> {
    if (this.txSessions.has(sessionId)) throw new DbError('该会话已有进行中的事务', { code: 'TX_ACTIVE' });
    if (this.txSessions.size) throw new DbError('已有进行中的事务，SQLite 同一时刻只允许一个', { code: 'TX_ACTIVE' });
    try {
      await this.execute('transaction', { sql: 'BEGIN' });
    } catch (err: any) {
      if (err instanceof DbError && PROCESS_BOUNDARY_ERRORS.has(err.code)) throw err;
      throw new DbError(err?.message ?? '开启事务失败', { code: 'TX_BEGIN' });
    }
    this.txSessions.add(sessionId);
  }

  async runInTransaction(sessionId: string, sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    if (!this.txSessions.has(sessionId)) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    return this.runParams(sql, params, opts);
  }

  async commitTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, 'COMMIT');
  }

  async rollbackTransaction(sessionId: string): Promise<void> {
    await this.finishTransaction(sessionId, 'ROLLBACK');
  }

  private async finishTransaction(sessionId: string, command: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    if (!this.txSessions.has(sessionId)) throw new DbError('事务会话不存在或已结束', { code: 'TX_NOT_FOUND', status: 404 });
    this.txSessions.delete(sessionId);
    try {
      await this.execute('transaction', { sql: command }, { timeoutMs: 5_000 });
    } catch (err: any) {
      if (err instanceof DbError && PROCESS_BOUNDARY_ERRORS.has(err.code)) throw err;
      throw new DbError(err?.message ?? `${command === 'COMMIT' ? '提交' : '回滚'}事务失败`, {
        code: command === 'COMMIT' ? 'TX_COMMIT' : 'TX_ROLLBACK',
      });
    }
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.txSessions]) {
      try {
        await this.finishTransaction(sessionId, 'ROLLBACK');
      } catch {}
    }
    this.txSessions.clear();
    await this.connection.close();
  }
}
