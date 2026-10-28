import { statSync } from 'node:fs';
import { engineMeta, quoteLiteral, type ConnectionConfig, type QueryResult } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

export interface MonitorItem {
  label: string;
  value: string | number;
}

export interface MonitorSection {
  title: string;
  items: MonitorItem[];
  error?: string;
}

export interface MonitorSession {
  id: string;
  user?: string;
  database?: string;
  state?: string;
  query?: string;
  elapsed?: string;
}

export interface MonitorResult {
  engine: string;
  version?: string;
  sampledAt: string;
  sections: MonitorSection[];
  sessions: MonitorSession[];
  error?: string;
}

function rowValue(result: QueryResult, column: string): unknown {
  const index = result.columns.findIndex((item) => item.name.toLowerCase() === column.toLowerCase());
  return index === -1 ? undefined : result.rows[0]?.[index];
}

function pairs(result: QueryResult): MonitorItem[] {
  return result.rows.map((row) => ({ label: String(row[0] ?? ''), value: row[1] as string | number }));
}

function fmtBytes(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export async function monitorConnection(store: Store, manager: ConnectionManager, connectionId: string): Promise<MonitorResult> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const family = engineMeta(conn.engine).dialect;
  const driver = await manager.rawDriver(connectionId);
  const run = (sql: string, maxRows = 200, database?: string) => driver.run(sql, { maxRows, database: database ?? conn.database });
  const sampledAt = new Date().toISOString();
  const sections: MonitorSection[] = [];
  const sessions: MonitorSession[] = [];
  let version: string | undefined;
  let error: string | undefined;
  const add = async (title: string, fn: () => Promise<MonitorItem[]>) => {
    try {
      sections.push({ title, items: await fn() });
    } catch (err: any) {
      sections.push({ title, items: [], error: err?.message ?? '查询失败' });
    }
  };

  try {
    if (family === 'sqlite') {
      const pageCount = await run('PRAGMA page_count');
      const pageSize = await run('PRAGMA page_size');
      const free = await run('PRAGMA freelist_count');
      const journal = await run('PRAGMA journal_mode');
      const schema = await manager.schema(connectionId, undefined, true);
      let fileSize = 0;
      try {
        fileSize = conn.database ? statSync(conn.database).size : 0;
      } catch {
        /* ignore */
      }
      version = `SQLite ${rowValue(await run('SELECT sqlite_version() AS v'), 'v') ?? ''}`;
      sections.push({
        title: '数据库',
        items: [
          { label: '文件大小', value: fmtBytes(fileSize) },
          { label: '页数 × 页大小', value: `${Number(rowValue(pageCount, 'page_count') ?? 0).toLocaleString()} × ${Number(rowValue(pageSize, 'page_size') ?? 0).toLocaleString()}` },
          { label: '空闲页', value: Number(rowValue(free, 'freelist_count') ?? 0).toLocaleString() },
          { label: 'Journal 模式', value: String(rowValue(journal, 'journal_mode') ?? '—') },
        ],
      });
      sections.push({
        title: '对象',
        items: [
          { label: '表', value: schema.flatMap((item) => item.tables).filter((table) => table.type === 'table').length },
          { label: '视图', value: schema.flatMap((item) => item.tables).filter((table) => table.type === 'view').length },
          { label: '估算行数', value: schema.flatMap((item) => item.tables).reduce((sum, table) => sum + (table.rowEstimate ?? 0), 0).toLocaleString() },
        ],
      });
    } else if (family === 'mysql') {
      const versionRes = await run('SELECT VERSION() AS v');
      version = String(rowValue(versionRes, 'v') ?? '');
      const status = await run('SHOW GLOBAL STATUS', 2000);
      const statusMap = new Map(status.rows.map((row) => [String(row[0]).toLowerCase(), row[1]]));
      const variable = await run('SHOW VARIABLES LIKE "max_connections"');
      sections.push({
        title: '运行状态',
        items: [
          { label: 'Uptime', value: `${Math.floor(Number(statusMap.get('uptime') ?? 0) / 3600)} h` },
          { label: '当前连接', value: Number(statusMap.get('threads_connected') ?? 0).toLocaleString() },
          { label: '累计查询', value: Number(statusMap.get('queries') ?? 0).toLocaleString() },
          { label: '慢查询', value: Number(statusMap.get('slow_queries') ?? 0).toLocaleString() },
          { label: 'InnoDB Buffer Pool 命中', value: `${Number(statusMap.get('innodb_buffer_pool_read_requests') ?? 0).toLocaleString()} req` },
          { label: '最大连接数', value: String(variable.rows[0]?.[1] ?? '—') },
        ],
      });
      const bytesIn = Number(statusMap.get('bytes_received') ?? 0);
      const bytesOut = Number(statusMap.get('bytes_sent') ?? 0);
      sections.push({ title: '网络', items: [{ label: '接收', value: fmtBytes(bytesIn) }, { label: '发送', value: fmtBytes(bytesOut) }] });
      const list = await run('SHOW FULL PROCESSLIST', 100);
      for (const row of list.rows) {
        sessions.push({
          id: String(row[0]),
          user: String(row[1] ?? ''),
          database: String(row[3] ?? ''),
          state: String(row[4] ?? ''),
          query: String(row[7] ?? ''),
          elapsed: String(row[5] ?? ''),
        });
      }
    } else if (family === 'postgres') {
      const versionRes = await run('SELECT version() AS v');
      version = String(rowValue(versionRes, 'v') ?? '').split(' ').slice(0, 3).join(' ');
      const dbStat = await run(
        'SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit, deadlocks, pg_size_pretty(pg_database_size(current_database())) AS size FROM pg_stat_database WHERE datname = current_database()',
      );
      const hit = Number(rowValue(dbStat, 'blks_hit') ?? 0);
      const read = Number(rowValue(dbStat, 'blks_read') ?? 0);
      const ratio = hit + read > 0 ? ((hit / (hit + read)) * 100).toFixed(2) : '—';
      sections.push({
        title: '数据库',
        items: [
          { label: '大小', value: String(rowValue(dbStat, 'size') ?? '—') },
          { label: '后端连接', value: Number(rowValue(dbStat, 'numbackends') ?? 0) },
          { label: '事务提交', value: Number(rowValue(dbStat, 'xact_commit') ?? 0).toLocaleString() },
          { label: '事务回滚', value: Number(rowValue(dbStat, 'xact_rollback') ?? 0).toLocaleString() },
          { label: '缓存命中率', value: `${ratio}%` },
          { label: '死锁', value: Number(rowValue(dbStat, 'deadlocks') ?? 0) },
        ],
      });
      const act = await run(
        "SELECT pid, usename, datname, state, query, EXTRACT(EPOCH FROM (now() - query_start))::int AS elapsed FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY query_start",
        100,
      );
      const names = act.columns.map((column) => column.name);
      for (const row of act.rows) {
        const get = (name: string) => row[names.indexOf(name)];
        sessions.push({ id: String(get('pid')), user: String(get('usename') ?? ''), database: String(get('datname') ?? ''), state: String(get('state') ?? ''), query: String(get('query') ?? ''), elapsed: `${get('elapsed') ?? 0}s` });
      }
    } else if (family === 'mssql') {
      const versionRes = await run('SELECT @@VERSION AS v');
      version = String(rowValue(versionRes, 'v') ?? '').split('\n')[0];
      const sys = await run('SELECT cpu_count, physical_memory_kb, (SELECT COUNT(*) FROM sys.dm_exec_sessions) AS sessions FROM sys.dm_os_sys_info');
      sections.push({
        title: '服务器',
        items: [
          { label: 'CPU', value: Number(rowValue(sys, 'cpu_count') ?? 0) },
          { label: '内存', value: fmtBytes(Number(rowValue(sys, 'physical_memory_kb') ?? 0) * 1024) },
          { label: '会话数', value: Number(rowValue(sys, 'sessions') ?? 0) },
        ],
      });
      const list = await run('SELECT session_id, login_name, DB_NAME(database_id) AS db, status, program_name FROM sys.dm_exec_sessions WHERE is_user_process = 1', 100);
      const names = list.columns.map((column) => column.name);
      for (const row of list.rows) {
        const get = (name: string) => row[names.indexOf(name)];
        sessions.push({ id: String(get('session_id')), user: String(get('login_name') ?? ''), database: String(get('db') ?? ''), state: String(get('status') ?? ''), query: String(get('program_name') ?? '') });
      }
    } else if (family === 'oracle') {
      const inst = await run('SELECT instance_name, status, version, startup_time FROM v$instance');
      version = String(rowValue(inst, 'version') ?? '');
      sections.push({
        title: '实例',
        items: [
          { label: '实例', value: String(rowValue(inst, 'instance_name') ?? '') },
          { label: '状态', value: String(rowValue(inst, 'status') ?? '') },
          { label: '启动时间', value: String(rowValue(inst, 'startup_time') ?? '') },
        ],
      });
      const list = await run("SELECT sid, serial#, username, status, program FROM v$session WHERE type = 'USER'", 100);
      const names = list.columns.map((column) => column.name);
      for (const row of list.rows) {
        const get = (name: string) => row[names.indexOf(name)];
        sessions.push({ id: `${get('sid')},${get('serial#')}`, user: String(get('username') ?? ''), state: String(get('status') ?? ''), query: String(get('program') ?? '') });
      }
    } else if (family === 'clickhouse') {
      version = String(rowValue(await run('SELECT version() AS v'), 'v') ?? '');
      const metrics = await run(
        "SELECT metric, value FROM system.metrics WHERE metric IN ('Query','QueryThread','Merge','PartMutation','TCPConnection','HTTPConnection','MemoryTracking')",
      );
      sections.push({ title: '运行状态', items: pairs(metrics) });
      const list = await run('SELECT query_id, user, elapsed, query FROM system.processes', 100);
      const names = list.columns.map((column) => column.name);
      for (const row of list.rows) {
        const get = (name: string) => row[names.indexOf(name)];
        sessions.push({ id: String(get('query_id')), user: String(get('user') ?? ''), elapsed: `${get('elapsed') ?? 0}s`, query: String(get('query') ?? '') });
      }
    } else {
      throw new Error(`暂不支持监控 ${conn.engine}`);
    }
  } catch (err: any) {
    error = err?.message ?? '监控失败';
  }
  return { engine: conn.engine, version, sampledAt, sections, sessions, error };
}

export async function killSession(store: Store, manager: ConnectionManager, connectionId: string, sessionId: string): Promise<{ sql: string }> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const family = engineMeta(conn.engine).dialect;
  if (family === 'sqlite') throw new Error('SQLite 没有会话概念');
  let sql: string;
  let params: unknown[] = [];
  if (family === 'mysql' || family === 'mssql') {
    if (!/^\d+$/.test(sessionId)) throw new Error('会话 ID 必须是数字');
    sql = `KILL ${sessionId}`;
  } else if (family === 'postgres') {
    if (!/^\d+$/.test(sessionId)) throw new Error('会话 ID 必须是数字');
    sql = 'SELECT pg_terminate_backend($1)';
    params = [Number(sessionId)];
  } else if (family === 'oracle') {
    if (!/^\d+,\d+$/.test(sessionId)) throw new Error('Oracle 会话 ID 格式应为 sid,serial#');
    sql = `ALTER SYSTEM KILL SESSION ${quoteLiteral(sessionId)} IMMEDIATE`;
  } else if (family === 'clickhouse') {
    if (!/^[\w-]+$/.test(sessionId)) throw new Error('非法 query_id');
    sql = `KILL QUERY WHERE query_id = ${quoteLiteral(sessionId)}`;
  } else {
    throw new Error('该引擎不支持终止会话');
  }
  const started = Date.now();
  try {
    if (params.length) await manager.runParams(connectionId, sql, params, { database: conn.database, actor: 'user' });
    else await manager.query(connectionId, sql, { database: conn.database, allowMulti: false, autoLimit: false, actor: 'user' });
    store.addAudit({
      actor: 'user',
      connectionId,
      database: conn.database,
      tool: 'monitor.kill',
      sql,
      risk: 'destructive',
      approval: 'manual',
      status: 'ok',
      durationMs: Date.now() - started,
      meta: { sessionId },
    });
    return { sql };
  } catch (err: any) {
    store.addAudit({ actor: 'user', connectionId, database: conn.database, tool: 'monitor.kill', sql, risk: 'destructive', approval: 'manual', status: 'error', durationMs: Date.now() - started, meta: { sessionId, error: err.message } });
    throw err;
  }
}
