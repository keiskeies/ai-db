import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  TOOLS,
  engineDefaultPort,
  engineUsesSchema,
  isEngine,
  buildAlterTable,
  buildCount,
  buildCreateTable,
  buildDelete,
  buildDeleteMany,
  buildDropIndex,
  buildInsert,
  buildSelectTable,
  buildUpdate,
  classifySql,
  encodeSse,
  isAgentContextActive,
  listProviderModels,
  quoteIdent,
  sseHeaders,
  suggestQuestions,
  tablesFromSql,
  type AppSettings,
  type ColumnDef,
  type ConnectionConfig,
  type ForeignKeyInfo,
  type IndexDef,
  type MemoryCandidate,
  type PermissionMode,
  type ProviderKind,
} from '@aidb/core';
import { pairingCode, hashToken, randomToken, safeEqual } from './crypto';
import { readAttachment, saveAttachment } from './attachments';
import type { GatewayConfig } from './config';
import type { ConnectionManager } from './manager';
import { auditCsv, coerceValue, dumpDatabase, importCsv, writeExportFile } from './services';
import type { Store } from './store';
import type { AgentHost } from './agentHost';
import type { JobScheduler } from './scheduler';
import { createFeatureRouter } from './features/routes';

export interface ApiDeps {
  config: GatewayConfig;
  store: Store;
  manager: ConnectionManager;
  host: AgentHost;
  pairCodes: Map<string, { expiresAt: number }>;
  scheduler: JobScheduler;
  startedAt: number;
}

const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function obj(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function bearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function localIp(): string {
  const nets = require('node:os').networkInterfaces() as Record<string, Array<{ family: string; internal: boolean; address: string }> | undefined>;
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function defaultSchema(conn: ConnectionConfig): string | undefined {
  if (!engineUsesSchema(conn.engine)) return undefined;
  if (conn.engine === 'sqlserver') return 'dbo';
  if (conn.engine === 'oracle') return (conn.username ?? '').toUpperCase();
  if (conn.engine === 'clickhouse') return conn.database ?? 'default';
  return 'public';
}

function classifyForAudit(sql: string) {
  try {
    return classifySql(sql).risk;
  } catch {
    return undefined;
  }
}

export function createApiRouter(deps: ApiDeps): Router {
  const { store, manager, host, config, scheduler } = deps;
  const router = Router();

  router.use((req, res, next) => {
    const open = req.path === '/health' || req.path === '/pair/claim';
    if (open) return next();
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '缺少访问令牌' } });
      return;
    }
    if (safeEqual(token, config.token)) return next();
    const device = store.findDeviceByTokenHash(hashToken(token));
    if (device) return next();
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '访问令牌无效或已吊销' } });
  });

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: config.version,
      platform: process.platform,
      demoReady: store.listConnections().some((c) => c.engine === 'sqlite'),
      uptimeMs: Date.now() - deps.startedAt,
    });
  });

  router.get('/bootstrap', (_req, res) => {
    res.json({
      version: config.version,
      platform: process.platform,
      bridgeHost: config.host,
      bridgePort: config.port,
      connections: store.listConnections(),
      settings: store.publicSettings(),
      sessions: store.listSessions(),
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, risk: t.risk })),
      startedAt: deps.startedAt,
    });
  });

  // ---------- connections ----------
  router.get('/connections', (_req, res) => res.json({ connections: store.listConnections() }));

  router.post(
    '/connections',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      if (!str(body.name)) throw Object.assign(new Error('连接名称不能为空'), { code: 'INVALID_INPUT', status: 400 });
      if (!isEngine(body.engine)) throw Object.assign(new Error('不支持的数据库类型'), { code: 'INVALID_ENGINE', status: 400 });
      const created = store.createConnection({
        name: String(body.name),
        engine: body.engine as ConnectionConfig['engine'],
        color: (str(body.color) as ConnectionConfig['color']) ?? 'blue',
        environment: (str(body.environment) as ConnectionConfig['environment']) ?? 'dev',
        groupName: str(body.groupName),
        host: str(body.host),
        port: body.port ? Number(body.port) : engineDefaultPort(body.engine as import('@aidb/core').Engine),
        database: str(body.database),
        username: str(body.username),
        password: str(body.password),
        sshPassword: str(body.sshPassword),
        sshPrivateKey: str(body.sshPrivateKey),
        ssl: Boolean(body.ssl),
        ssh: body.ssh as ConnectionConfig['ssh'],
        readonly: Boolean(body.readonly),
        note: str(body.note),
      });
      res.status(201).json({ connection: created });
    }),
  );

  router.put(
    '/connections/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      if (body.engine !== undefined && !isEngine(body.engine)) throw Object.assign(new Error('不支持的数据库类型'), { code: 'INVALID_ENGINE', status: 400 });
      const updated = store.updateConnection(req.params.id, {
        name: str(body.name),
        engine: str(body.engine) as ConnectionConfig['engine'] | undefined,
        color: str(body.color) as ConnectionConfig['color'] | undefined,
        environment: str(body.environment) as ConnectionConfig['environment'] | undefined,
        groupName: str(body.groupName),
        host: str(body.host),
        port: body.port === undefined ? undefined : Number(body.port),
        database: str(body.database),
        username: str(body.username),
        password: str(body.password),
        sshPassword: str(body.sshPassword),
        sshPrivateKey: str(body.sshPrivateKey),
        ssl: body.ssl === undefined ? undefined : Boolean(body.ssl),
        ssh: body.ssh as ConnectionConfig['ssh'],
        readonly: body.readonly === undefined ? undefined : Boolean(body.readonly),
        note: str(body.note),
      });
      await manager.close(req.params.id);
      manager.invalidate(req.params.id);
      res.json({ connection: updated });
    }),
  );

  router.delete(
    '/connections/:id',
    ah(async (req, res) => {
      await manager.close(req.params.id);
      store.deleteConnection(req.params.id);
      res.status(204).end();
    }),
  );

  router.post(
    '/connections/:id/test',
    ah(async (req, res) => {
      res.json({ result: await manager.testSaved(req.params.id) });
    }),
  );

  router.post(
    '/connections/test',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const now = new Date().toISOString();
      const conn: ConnectionConfig = {
        id: 'draft',
        name: str(body.name) ?? 'draft',
        engine: (str(body.engine) as ConnectionConfig['engine']) ?? 'sqlite',
        color: 'blue',
        environment: 'dev',
        groupName: '',
        host: str(body.host),
        port: body.port ? Number(body.port) : engineDefaultPort(body.engine as import('@aidb/core').Engine),
        database: str(body.database),
        username: str(body.username),
        ssl: Boolean(body.ssl),
        ssh: body.ssh as ConnectionConfig['ssh'],
        readonly: false,
        createdAt: now,
        updatedAt: now,
      };
      const result = await manager.testConfig(conn, {
        password: str(body.password),
        sshPassword: str(body.sshPassword) ?? (body.ssh as ConnectionConfig['ssh'])?.password,
        sshPrivateKey: str(body.sshPrivateKey),
      });
      res.json({ result });
    }),
  );

  router.get(
    '/connections/:id/databases',
    ah(async (req, res) => {
      res.json({ databases: await manager.listDatabases(req.params.id) });
    }),
  );

  router.get(
    '/connections/:id/schema',
    ah(async (req, res) => {
      const schemas = await manager.schema(req.params.id, str(req.query.database), req.query.refresh === '1');
      res.json({ schemas });
    }),
  );

  router.get(
    '/connections/:id/tables',
    ah(async (req, res) => {
      const database = str(req.query.database);
      const schemas = await manager.schema(req.params.id, database);
      res.json({
        database: database ?? store.getConnection(req.params.id)?.database,
        tables: schemas.flatMap((s) => s.tables),
      });
    }),
  );

  router.post(
    '/connections/:id/refresh',
    ah(async (req, res) => {
      manager.invalidate(req.params.id);
      const schemas = await manager.schema(req.params.id, str((req.body as Record<string, unknown>)?.database), true);
      res.json({ schemas });
    }),
  );

  // ---------- queries ----------
  router.post(
    '/query',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const sql = str(body.sql);
      if (!connectionId || !sql) throw Object.assign(new Error('connectionId 与 sql 必填'), { code: 'INVALID_INPUT', status: 400 });
      const settings = store.getSettings();
      const started = Date.now();
      try {
        const batch = await manager.query(connectionId, sql, {
          database: str(body.database),
          maxRows: num(body.limit, settings.defaultLimit, 1, 10000),
          timeoutMs: settings.queryTimeoutMs,
          allowMulti: body.allowMulti === undefined ? settings.allowMultiStatement : Boolean(body.allowMulti),
          autoLimit: settings.autoLimit,
          actor: 'user',
        });
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'query',
          sql,
          risk: classifyForAudit(sql),
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        res.json({ batch });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'query',
          sql,
          risk: classifyForAudit(sql),
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.get(
    '/data',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      const tableName = str(req.query.table);
      if (!connectionId || !tableName) throw Object.assign(new Error('connectionId 与 table 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const database = str(req.query.database);
      const { table } = await manager.findTable(connectionId, database, tableName);
      const limit = num(req.query.limit, 100, 1, 1000);
      const offset = num(req.query.offset, 0, 0, 10_000_000);
      const orderCol = str(req.query.orderBy);
      const direction = String(req.query.orderDir ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      let orderBy: string | undefined;
      if (orderCol && (table.columns ?? []).some((c) => c.name === orderCol)) {
        orderBy = `${quoteIdent(orderCol, conn.engine)} ${direction}`;
      }
      const sql = buildSelectTable(conn.engine, table.name, {
        schema: engineUsesSchema(conn.engine) ? table.schema : undefined,
        where: str(req.query.where),
        orderBy,
        limit,
        offset,
      });
      const batch = await manager.query(connectionId, sql, {
        database,
        maxRows: limit,
        allowMulti: false,
        autoLimit: false,
        actor: 'user',
        timeoutMs: store.getSettings().queryTimeoutMs,
      });
      const countSql = buildCount(conn.engine, table.name, engineUsesSchema(conn.engine) ? table.schema : undefined);
      const countBatch = await manager.query(connectionId, countSql, { database, maxRows: 1, allowMulti: false, autoLimit: false, actor: 'user' });
      res.json({
        batch,
        table: table.name,
        total: Number(countBatch.sets[0]?.rows?.[0]?.[0] ?? 0),
        limit,
        offset,
        sql,
      });
    }),
  );

  router.post(
    '/rows',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const tableName = str(body.table);
      const op = str(body.op);
      if (!connectionId || !tableName || !op) throw Object.assign(new Error('connectionId/table/op 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      if (conn.readonly) throw Object.assign(new Error('只读连接禁止修改数据'), { code: 'READONLY', status: 403 });
      const database = str(body.database);
      const { table } = await manager.findTable(connectionId, database, tableName);
      const known = new Set((table.columns ?? []).map((c) => c.name));
      const typeOf = new Map((table.columns ?? []).map((c) => [c.name, c.type]));
      const schema = engineUsesSchema(conn.engine) ? table.schema : undefined;
      let sql: string;
      let params: unknown[] = [];
      let risk = 'write';
      if (op === 'insert') {
        const values = obj(body.values, 'values');
        const columns = Object.keys(values).filter((c) => known.has(c));
        if (!columns.length) throw Object.assign(new Error('没有可插入的列'), { code: 'INVALID_INPUT', status: 400 });
        sql = buildInsert(conn.engine, table.name, columns, 1, schema);
        params = columns.map((c) => coerceValue(values[c], typeOf.get(c) ?? 'text'));
      } else if (op === 'insertMany') {
        const records = Array.isArray(body.rows) ? body.rows.filter((row) => row && typeof row === 'object') as Record<string, unknown>[] : [];
        if (!records.length) throw Object.assign(new Error('没有可插入的行'), { code: 'INVALID_INPUT', status: 400 });
        const columns = [...new Set(records.flatMap((row) => Object.keys(row)))].filter((c) => known.has(c));
        if (!columns.length) throw Object.assign(new Error('没有可插入的列'), { code: 'INVALID_INPUT', status: 400 });
        sql = buildInsert(conn.engine, table.name, columns, records.length, schema);
        params = records.flatMap((row) => columns.map((c) => coerceValue(row[c], typeOf.get(c) ?? 'text')));
      } else if (op === 'update') {
        const values = obj(body.values, 'values');
        const key = obj(body.key, 'key');
        const setCols = Object.keys(values).filter((c) => known.has(c));
        const whereCols = Object.keys(key).filter((c) => known.has(c));
        if (!setCols.length || !whereCols.length) throw Object.assign(new Error('更新需要 values 与主键 key'), { code: 'INVALID_INPUT', status: 400 });
        sql = buildUpdate(conn.engine, table.name, setCols, whereCols, schema);
        params = [...setCols.map((c) => coerceValue(values[c], typeOf.get(c) ?? 'text')), ...whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text'))];
      } else if (op === 'delete') {
        const key = obj(body.key, 'key');
        const whereCols = Object.keys(key).filter((c) => known.has(c));
        if (!whereCols.length) throw Object.assign(new Error('删除需要主键 key'), { code: 'INVALID_INPUT', status: 400 });
        sql = buildDelete(conn.engine, table.name, whereCols, schema);
        params = whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text'));
        risk = 'destructive';
      } else if (op === 'deleteMany') {
        const keys = Array.isArray(body.keys) ? body.keys.filter((key) => key && typeof key === 'object') as Record<string, unknown>[] : [];
        if (!keys.length) throw Object.assign(new Error('删除需要主键列表'), { code: 'INVALID_INPUT', status: 400 });
        const whereCols = Object.keys(keys[0]).filter((c) => known.has(c));
        if (!whereCols.length) throw Object.assign(new Error('删除需要主键列'), { code: 'INVALID_INPUT', status: 400 });
        if (keys.some((key) => whereCols.some((c) => key[c] === undefined))) {
          throw Object.assign(new Error('批量删除的主键列必须一致'), { code: 'INVALID_INPUT', status: 400 });
        }
        sql = buildDeleteMany(conn.engine, table.name, whereCols, keys.length, schema);
        params = keys.flatMap((key) => whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text')));
        risk = 'destructive';
      } else {
        throw Object.assign(new Error('未知操作'), { code: 'INVALID_INPUT', status: 400 });
      }
      const started = Date.now();
      try {
        const result = await manager.runParams(connectionId, sql, params, { database, actor: 'user' });
        store.addAudit({ actor: 'user', connectionId, database, tool: `rows.${op}`, sql, risk: risk as 'write' | 'destructive', approval: 'manual', status: 'ok', durationMs: Date.now() - started, meta: { table: table.name } });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({ actor: 'user', connectionId, database, tool: `rows.${op}`, sql, risk: risk as 'write' | 'destructive', approval: 'manual', status: 'error', durationMs: Date.now() - started, meta: { error: err.message } });
        throw err;
      }
    }),
  );

  router.post(
    '/ddl/preview',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const conn = store.getConnection(String(body.connectionId));
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const table = String(body.table ?? '');
      if (!table) throw Object.assign(new Error('表名必填'), { code: 'INVALID_INPUT', status: 400 });
      if (body.mode === 'alter') {
        const statements = buildAlterTable(
          conn.engine,
          table,
          (body.operations ?? []) as Parameters<typeof buildAlterTable>[2],
          engineUsesSchema(conn.engine) ? String(body.schema ?? defaultSchema(conn)) : undefined,
        );
        res.json({ statements });
        return;
      }
      const columns = (Array.isArray(body.columns) ? body.columns : []) as ColumnDef[];
      if (!columns.length) throw Object.assign(new Error('至少需要一列'), { code: 'INVALID_INPUT', status: 400 });
      const ddl = buildCreateTable(conn.engine, {
        table,
        columns,
        indexes: (Array.isArray(body.indexes) ? body.indexes : []) as IndexDef[],
        foreignKeys: (Array.isArray(body.foreignKeys) ? body.foreignKeys : []) as ForeignKeyInfo[],
        schema: engineUsesSchema(conn.engine) ? String(body.schema ?? defaultSchema(conn)) : undefined,
        comment: str(body.comment),
      });
      res.json({ statements: ddl.split(';\n').filter(Boolean).map((s) => s.trim() + ';').slice(0), ddl });
    }),
  );

  router.post(
    '/ddl/execute',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const statements = Array.isArray(body.statements) ? (body.statements as string[]) : str(body.sql) ? [String(body.sql)] : [];
      const sql = statements.join(';\n');
      if (!sql.trim()) throw Object.assign(new Error('没有可执行的语句'), { code: 'INVALID_INPUT', status: 400 });
      const started = Date.now();
      const batch = await manager.query(connectionId, sql, {
        database: str(body.database),
        allowMulti: true,
        autoLimit: false,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
      });
      manager.invalidate(connectionId);
      store.addAudit({
        actor: 'user',
        connectionId,
        database: str(body.database),
        tool: 'ddl.execute',
        sql,
        risk: classifyForAudit(sql),
        approval: 'manual',
        status: 'ok',
        durationMs: Date.now() - started,
      });
      res.json({ batch });
    }),
  );

  router.post(
    '/export',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const database = str(body.database);
      const format = (['csv', 'json', 'sql', 'xml'].includes(String(body.format)) ? String(body.format) : 'csv') as 'csv' | 'json' | 'sql' | 'xml';
      const limit = num(body.limit, 10000, 1, 200000);
      let sql: string;
      let tableName: string | undefined;
      if (str(body.sql)) sql = String(body.sql);
      else if (str(body.table)) {
        const { table } = await manager.findTable(connectionId, database, String(body.table));
        tableName = table.name;
        sql = buildSelectTable(conn.engine, table.name, { schema: engineUsesSchema(conn.engine) ? table.schema : undefined, limit });
      } else throw Object.assign(new Error('sql 或 table 必填'), { code: 'INVALID_INPUT', status: 400 });
      const batch = await manager.query(connectionId, sql, { database, maxRows: limit, allowMulti: false, autoLimit: false, actor: 'user' });
      const set = batch.sets[0];
      if (!set) throw Object.assign(new Error('没有可导出的结果'), { code: 'EMPTY_RESULT', status: 400 });
      const file = writeExportFile({ dir: config.exportDir, format, columns: set.columns.map((c) => c.name), rows: set.rows, tableName, engine: conn.engine });
      store.addAudit({ actor: 'user', connectionId, database, tool: 'export', sql, risk: 'read', approval: 'manual', status: 'ok', meta: { path: file.path, format } });
      res.json({ file, format });
    }),
  );

  router.post(
    '/import',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const result = await importCsv(store, manager, config, connectionId, {
        table: String(body.table ?? ''),
        csv: str(body.csv),
        path: str(body.path),
        hasHeader: body.hasHeader !== false,
        delimiter: str(body.delimiter),
        mapping: Array.isArray(body.mapping) ? (body.mapping as Array<{ column: string; sourceIndex?: number }>) : undefined,
      });
      manager.invalidate(connectionId);
      store.addAudit({ actor: 'user', connectionId, tool: 'import', risk: 'write', approval: 'manual', status: 'ok', meta: { table: body.table, inserted: result.inserted } });
      res.json({ result });
    }),
  );

  router.get('/backups', (req, res) => {
    res.json({ backups: store.listBackups(str(req.query.connectionId)) });
  });

  router.post(
    '/backups',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const backup = await dumpDatabase(store, manager, config, connectionId, str(body.database), str(body.label));
      res.status(201).json({ backup });
    }),
  );

  router.get('/history', (req, res) => {
    res.json({
      items: store.listHistory({
        connectionId: str(req.query.connectionId),
        search: str(req.query.search),
        limit: num(req.query.limit, 200, 1, 500),
      }),
    });
  });

  router.delete('/history', (_req, res) => {
    store.clearHistory();
    res.status(204).end();
  });

  router.get('/audit', (req, res) => {
    const entries = store.listAudit({ connectionId: str(req.query.connectionId), actor: str(req.query.actor), limit: num(req.query.limit, 200, 1, 1000) });
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="aidb-audit.csv"');
      res.send(auditCsv(entries as unknown as Array<Record<string, unknown>>));
      return;
    }
    res.json({ entries });
  });

  router.get('/snippets', (_req, res) => res.json({ snippets: store.listSnippets() }));
  router.post(
    '/snippets',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      if (!str(body.name) || !str(body.sql)) throw Object.assign(new Error('name 与 sql 必填'), { code: 'INVALID_INPUT', status: 400 });
      const created = store.createSnippet({ name: String(body.name), sql: String(body.sql), tags: Array.isArray(body.tags) ? (body.tags as string[]) : [] });
      res.status(201).json({ snippet: created });
    }),
  );
  router.delete('/snippets/:id', (req, res) => {
    store.deleteSnippet(req.params.id);
    res.status(204).end();
  });

  // ---------- settings ----------
  router.get('/settings', (_req, res) => res.json({ settings: store.publicSettings() }));
  router.put(
    '/settings',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const current = store.getSettings();
      const agentBody = (body.agent ?? {}) as Partial<AppSettings['agent']>;
      const merged: AppSettings = {
        ...current,
        ...body,
        agent: {
          ...current.agent,
          ...agentBody,
          apiKey: agentBody.apiKey,
        },
      };
      store.saveSettings(merged);
      res.json({ settings: store.publicSettings() });
    }),
  );

  // ---------- agent ----------
  router.get('/agent/tools', (_req, res) => res.json({ tools: TOOLS }));

  router.post(
    '/agent/models',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const kind = String(body.kind ?? '') as ProviderKind;
      if (!['local', 'anthropic', 'openai', 'ollama'].includes(kind)) {
        throw Object.assign(new Error('未知的模型协议'), { code: 'INVALID_INPUT', status: 400 });
      }
      const stored = store.getSettings().agent;
      const apiKey = str(body.apiKey) ?? (kind === stored.provider ? stored.apiKey : undefined);
      try {
        res.json(await listProviderModels({ kind, baseUrl: String(body.baseUrl ?? ''), apiKey }));
      } catch (err: any) {
        throw Object.assign(err, { status: Number(err?.status) || 400 });
      }
    }),
  );

  router.post(
    '/agent/attachments',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const attachment = saveAttachment(config.attachmentDir, { mime: str(body.mime), base64: str(body.base64) });
      res.status(201).json({ attachment });
    }),
  );

  router.get('/agent/attachments/:id', (req, res) => {
    const file = readAttachment(config.attachmentDir, req.params.id);
    if (!file) {
      res.status(404).json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: '图片附件不存在或已被清理' } });
      return;
    }
    res.setHeader('cache-control', 'private, max-age=86400');
    res.contentType(file.mime);
    res.send(file.buffer);
  });

  router.get('/agent/sessions', (_req, res) => res.json({ sessions: store.listSessions() }));
  router.post(
    '/agent/sessions',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const session = store.createSession({
        connectionId: str(body.connectionId),
        title: str(body.title),
        model: str(body.model),
        permissionMode: str(body.permissionMode) as PermissionMode | undefined,
      });
      res.status(201).json({ session });
    }),
  );

  router.get(
    '/agent/sessions/:id',
    ah(async (req, res) => {
      const session = store.getSession(req.params.id);
      if (!session) throw Object.assign(new Error('会话不存在'), { code: 'SESSION_NOT_FOUND', status: 404 });
      res.json({ session, messages: store.listMessages(session.id), toolRuns: store.listToolRuns(session.id) });
    }),
  );

  router.patch(
    '/agent/sessions/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const session = store.updateSession(req.params.id, {
        title: str(body.title),
        connectionId: body.connectionId === null ? undefined : str(body.connectionId),
        permissionMode: str(body.permissionMode) as PermissionMode | undefined,
        archived: body.archived === undefined ? undefined : Boolean(body.archived),
      });
      res.json({ session });
    }),
  );

  router.delete('/agent/sessions/:id', (req, res) => {
    store.deleteSession(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/agent/sessions/:id/turns',
    ah(async (req, res) => {
      const sessionId = req.params.id;
      const session = store.getSession(sessionId);
      if (!session) throw Object.assign(new Error('会话不存在'), { code: 'SESSION_NOT_FOUND', status: 404 });
      if (host.isRunning(sessionId)) throw Object.assign(new Error('会话正在运行'), { code: 'SESSION_BUSY', status: 409 });
      const body = obj(req.body, 'body');
      res.writeHead(200, sseHeaders());
      res.flushHeaders?.();
      let finished = false;
      const heartbeat = setInterval(() => {
        if (!finished) res.write(': ping\n\n');
      }, 15000);
      res.on('close', () => {
        if (!res.writableEnded) {
          finished = true;
          clearInterval(heartbeat);
          host.abort(sessionId);
        }
      });
      try {
        await host.startTurn(
          sessionId,
          {
            text: String(body.text ?? ''),
            mode: str(body.mode) as Parameters<AgentHost['startTurn']>[1]['mode'],
            attachments: Array.isArray(body.attachments) ? (body.attachments as string[]) : undefined,
            images: Array.isArray(body.images) ? (body.images as string[]).map(String).slice(0, 4) : undefined,
            connectionId: str(body.connectionId),
          },
          (event) => {
            if (!finished && !res.writableEnded) res.write(encodeSse(event));
          },
        );
      } catch (err: any) {
        if (!res.writableEnded) {
          res.write(encodeSse({ type: 'error', code: err?.code ?? 'AGENT_ERROR', message: err?.message ?? 'Agent 运行失败' }));
        }
      } finally {
        finished = true;
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    }),
  );

  router.post('/agent/sessions/:id/abort', (req, res) => {
    const ok = host.abort(req.params.id);
    res.json({ ok });
  });

  router.post('/agent/approvals/:id', (req, res) => {
    const body = obj(req.body, 'body');
    const decision = body.decision === 'allow' ? 'allow' : 'deny';
    const scope = ['once', 'session', 'always'].includes(String(body.scope)) ? (String(body.scope) as 'once' | 'session' | 'always') : 'once';
    const ok = host.resolveApproval(req.params.id, decision, scope);
    res.status(ok ? 200 : 404).json({ ok });
  });

  router.get('/agent/memories', (req, res) => {
    res.json({
      memories: store.listMemories({
        q: str(req.query.q),
        kind: str(req.query.kind),
        scopeType: str(req.query.scopeType),
        includeArchived: req.query.includeArchived === '1',
        limit: num(req.query.limit, 200, 1, 500),
      }),
    });
  });

  router.post(
    '/agent/memories',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const title = str(body.title);
      const content = str(body.content);
      if (!title || !content) throw Object.assign(new Error('title 与 content 必填'), { code: 'INVALID_INPUT', status: 400 });
      const connectionId = str(body.connectionId);
      const candidate: MemoryCandidate = {
        kind: (str(body.kind) as MemoryCandidate['kind']) ?? 'fact',
        title,
        content,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        importance: typeof body.importance === 'number' ? body.importance : 0.6,
        scopeType: str(body.scopeType) as MemoryCandidate['scopeType'],
        scopeKey: str(body.scopeKey),
      };
      const result = store.upsertMemoryCandidate(candidate, { connectionId, database: str(body.database) });
      res.status(201).json(result);
    }),
  );

  router.put(
    '/agent/memories/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const memory = store.updateMemory(req.params.id, {
        title: str(body.title),
        content: str(body.content),
        kind: str(body.kind) as MemoryCandidate['kind'],
        importance: typeof body.importance === 'number' ? body.importance : undefined,
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        archived: typeof body.archived === 'boolean' ? body.archived : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      });
      res.json({ memory });
    }),
  );

  router.delete('/agent/memories/:id', (req, res) => {
    store.deleteMemory(req.params.id);
    res.status(204).end();
  });

  /** 猜你想问：纯本地规则，不查库、不调模型，离线模式同样可用。 */
  router.get(
    '/agent/suggest',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(req.query.database);
      const limit = num(req.query.limit, 6, 1, 12);
      const schemas = await manager.schema(connectionId, database);
      const history = store.listHistory({ connectionId, limit: 50 }).flatMap((h) => tablesFromSql(h.sql));
      res.json({
        suggestions: suggestQuestions(schemas, { limit, history, bundle: store.agentContextBundle(connectionId, database) }),
      });
    }),
  );

  // ---------- agent business context ----------
  router.get('/agent/context', (req, res) => {
    const connectionId = str(req.query.connectionId);
    if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
    const database = str(req.query.database) ?? '';
    const entries = store.listAgentContext(connectionId, database);
    const bundle = store.agentContextBundle(connectionId, database);
    res.json({ entries, bundle, active: isAgentContextActive(bundle) });
  });

  router.put('/agent/context/entry', (req, res) => {
    const body = obj(req.body, 'body');
    const connectionId = str(body.connectionId);
    const table = str(body.table);
    const kindRaw = str(body.kind) ?? 'table';
    if (!connectionId || !table) throw Object.assign(new Error('connectionId 与 table 必填'), { code: 'INVALID_INPUT', status: 400 });
    if (kindRaw !== 'table' && kindRaw !== 'column') throw Object.assign(new Error('kind 只能是 table 或 column'), { code: 'INVALID_INPUT', status: 400 });
    const entry = store.upsertAgentContextEntry({
      connectionId,
      database: str(body.database) ?? '',
      kind: kindRaw,
      table,
      column: str(body.column),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      alias: body.alias === null ? null : str(body.alias),
      description: body.description === null ? null : str(body.description),
    });
    res.json({ entry });
  });

  router.put('/agent/context/relation', (req, res) => {
    const body = obj(req.body, 'body');
    const connectionId = str(body.connectionId);
    const table = str(body.table);
    const column = str(body.column);
    const refTable = str(body.refTable);
    const refColumn = str(body.refColumn);
    if (!connectionId || !table || !column || !refTable || !refColumn) {
      throw Object.assign(new Error('connectionId、table、column、refTable、refColumn 均必填'), { code: 'INVALID_INPUT', status: 400 });
    }
    const entry = store.upsertAgentRelation({
      connectionId,
      database: str(body.database) ?? '',
      table,
      column,
      refTable,
      refColumn,
      description: body.description === null ? null : str(body.description),
    });
    res.json({ entry });
  });

  router.post('/agent/context/bulk', (req, res) => {
    const body = obj(req.body, 'body');
    const connectionId = str(body.connectionId);
    if (!connectionId || !Array.isArray(body.tables)) {
      throw Object.assign(new Error('connectionId 与 tables[] 必填'), { code: 'INVALID_INPUT', status: 400 });
    }
    const tables = (body.tables as unknown[]).map(String).slice(0, 2000);
    const touched = store.bulkSetAgentContextTables({
      connectionId,
      database: str(body.database) ?? '',
      tables,
      enabled: body.enabled !== false,
    });
    res.json({ touched });
  });

  router.delete('/agent/context/entry/:id', (req, res) => {
    store.deleteAgentContext(req.params.id);
    res.status(204).end();
  });

  /** 清空某个连接（可选某个库）的全部业务上下文配置，回到「未配置」的默认行为。 */
  router.delete('/agent/context', (req, res) => {
    const connectionId = str(req.query.connectionId);
    if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
    const removed = store.clearAgentContext(connectionId, str(req.query.database));
    res.json({ removed });
  });

  // ---------- pairing ----------
  router.post(
    '/pair/start',
    ah(async (req, res) => {
      const code = pairingCode();
      deps.pairCodes.set(code, { expiresAt: Date.now() + 5 * 60 * 1000 });
      for (const [k, v] of deps.pairCodes) if (v.expiresAt < Date.now()) deps.pairCodes.delete(k);
      const host = config.host === '0.0.0.0' || config.host === '::' ? localIp() : config.host;
      res.json({
        code,
        expiresIn: 300,
        qrPayload: JSON.stringify({ v: 1, host, port: config.port, code }),
        host,
        port: config.port,
      });
    }),
  );

  router.post(
    '/pair/claim',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const code = String(body.code ?? '').trim();
      const entry = deps.pairCodes.get(code);
      if (!entry || entry.expiresAt < Date.now()) throw Object.assign(new Error('配对码无效或已过期'), { code: 'PAIR_INVALID', status: 401 });
      deps.pairCodes.delete(code);
      const token = randomToken(32);
      const device = store.createDevice({
        name: str(body.deviceName) ?? '移动设备',
        platform: str(body.platform) ?? 'unknown',
        tokenHash: hashToken(token),
      });
      res.json({
        token,
        device,
        bridge: { host: config.host === '0.0.0.0' ? localIp() : config.host, port: config.port, version: config.version },
      });
    }),
  );

  router.get('/devices', (_req, res) => res.json({ devices: store.listDevices() }));
  router.delete('/devices/:id', (req, res) => {
    store.revokeDevice(req.params.id);
    res.status(204).end();
  });

  router.use(createFeatureRouter({ store, manager, config, scheduler }));

  return router;
}
