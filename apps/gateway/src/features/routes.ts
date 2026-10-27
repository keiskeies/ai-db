import { readFileSync } from 'node:fs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { TableMaintenanceAction } from '@aidb/core';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import type { JobScheduler } from '../scheduler';
import { compareSchemas } from './schemaCompare';
import { searchDatabase } from './search';
import { transferData } from './transfer';
import { generateData } from './generate';
import { killSession, monitorConnection } from './monitor';
import { listUsers, manageUser } from './users';
import { buildDictionary } from './dictionary';
import { listAdvancedObjects } from './objects';
import { describeTableOptions } from './tableOptions';
import { compareData } from './compareData';
import { runTableOp, type TableOp } from './tableOps';
import { runDatabaseOp, type DatabaseOp } from './databaseOps';
import { replaceData } from './replace';

export interface FeatureDeps {
  store: Store;
  manager: ConnectionManager;
  config: GatewayConfig;
  scheduler: JobScheduler;
}

const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

function obj(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

export function createFeatureRouter(deps: FeatureDeps): Router {
  const { store, manager, config, scheduler } = deps;
  const router = Router();

  router.post(
    '/databases/ops',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const database = str(body.database);
      if (!connectionId || !database) throw Object.assign(new Error('connectionId 与 database 必填'), { code: 'INVALID_INPUT', status: 400 });
      const ops: DatabaseOp[] = ['create', 'drop', 'rename'];
      if (!ops.includes(body.op as DatabaseOp)) throw Object.assign(new Error('未知数据库操作'), { code: 'INVALID_INPUT', status: 400 });
      res.json(
        await runDatabaseOp(store, manager, {
          connectionId,
          database,
          op: body.op as DatabaseOp,
          newName: str(body.newName),
        }),
      );
    }),
  );

  router.post(
    '/tables/ops',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const table = str(body.table);
      if (!connectionId || !table) throw Object.assign(new Error('connectionId 与 table 必填'), { code: 'INVALID_INPUT', status: 400 });
      const ops: TableOp[] = ['ddl', 'rename', 'duplicate', 'truncate', 'empty', 'drop', 'maintenance'];
      if (!ops.includes(body.op as TableOp)) throw Object.assign(new Error('未知表操作'), { code: 'INVALID_INPUT', status: 400 });
      res.json(
        await runTableOp(store, manager, {
          connectionId,
          database: str(body.database),
          table,
          schema: str(body.schema),
          op: body.op as TableOp,
          newName: str(body.newName),
          withData: body.withData === undefined ? undefined : Boolean(body.withData),
          action: str(body.action) as TableMaintenanceAction | undefined,
        }),
      );
    }),
  );

  router.post(
    '/data/replace',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const table = str(body.table);
      const column = str(body.column);
      if (!connectionId || !table || !column) {
        throw Object.assign(new Error('connectionId / table / column 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      res.json(
        await replaceData(store, manager, {
          connectionId,
          database: str(body.database),
          table,
          column,
          find: String(body.find ?? ''),
          replace: String(body.replace ?? ''),
          where: str(body.where),
          preview: body.preview === undefined ? undefined : Boolean(body.preview),
        }),
      );
    }),
  );

  router.post(
    '/search',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const result = await searchDatabase(
        store,
        manager,
        connectionId,
        str(body.database),
        String(body.query ?? ''),
        body.scope === 'objects' || body.scope === 'data' ? body.scope : 'all',
      );
      res.json(result);
    }),
  );

  router.post(
    '/schema/compare',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const sourceId = str(body.sourceId);
      const targetId = str(body.targetId);
      if (!sourceId || !targetId) throw Object.assign(new Error('sourceId 与 targetId 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ diff: await compareSchemas(store, manager, sourceId, str(body.sourceDatabase), targetId, str(body.targetDatabase)) });
    }),
  );

  router.post(
    '/schema/sync',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      if (conn.readonly) throw Object.assign(new Error('目标连接为只读'), { code: 'READONLY', status: 403 });
      const statements = Array.isArray(body.statements) ? (body.statements as string[]) : [];
      const sql = statements.join(';\n');
      if (!sql.trim()) throw Object.assign(new Error('没有同步语句'), { code: 'INVALID_INPUT', status: 400 });
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
        tool: 'schema.sync',
        sql,
        risk: 'ddl',
        approval: 'manual',
        status: 'ok',
        durationMs: Date.now() - started,
        meta: { statements: statements.length },
      });
      res.json({ batch });
    }),
  );

  router.post(
    '/transfer',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const sourceId = str(body.sourceId);
      const targetId = str(body.targetId);
      if (!sourceId || !targetId) throw Object.assign(new Error('sourceId 与 targetId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const started = Date.now();
      const result = await transferData(store, manager, {
        sourceId,
        sourceDatabase: str(body.sourceDatabase),
        targetId,
        targetDatabase: str(body.targetDatabase),
        tables: Array.isArray(body.tables) ? (body.tables as string[]) : undefined,
        mode: body.mode === 'replace' ? 'replace' : 'append',
        createMissing: body.createMissing !== false,
        limit: Number(body.limit) || undefined,
      });
      manager.invalidate(targetId);
      store.addAudit({
        actor: 'user',
        connectionId: targetId,
        database: str(body.targetDatabase),
        tool: 'data.transfer',
        risk: 'write',
        approval: 'manual',
        status: result.results.some((item) => item.status === 'error') ? 'error' : 'ok',
        durationMs: Date.now() - started,
        meta: { sourceId, tables: result.results.length, rows: result.totalRows },
      });
      res.json({ result });
    }),
  );

  router.post(
    '/generate',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const started = Date.now();
      const result = await generateData(store, manager, {
        connectionId,
        database: str(body.database),
        table: String(body.table ?? ''),
        rows: Number(body.rows) || 10,
        dryRun: body.dryRun === true,
      });
      store.addAudit({
        actor: 'user',
        connectionId,
        database: str(body.database),
        tool: 'data.generate',
        sql: result.sqlPreview,
        risk: 'write',
        approval: 'manual',
        status: 'ok',
        durationMs: Date.now() - started,
        meta: { table: result.table, inserted: result.inserted, dryRun: result.dryRun },
      });
      res.json({ result });
    }),
  );

  router.get(
    '/monitor',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ monitor: await monitorConnection(store, manager, connectionId) });
    }),
  );

  router.post(
    '/monitor/kill',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const sessionId = str(body.sessionId);
      if (!connectionId || !sessionId) throw Object.assign(new Error('connectionId 与 sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ result: await killSession(store, manager, connectionId, sessionId) });
    }),
  );

  router.get(
    '/users',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json(await listUsers(store, manager, connectionId));
    }),
  );

  router.post(
    '/users/action',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const action = body.action === 'drop' || body.action === 'grant' ? body.action : 'create';
      const result = await manageUser(store, manager, connectionId, action, {
        name: str(body.name),
        host: str(body.host),
        password: str(body.password),
        privileges: str(body.privileges),
        scope: str(body.scope),
        role: str(body.role),
      });
      res.json({ result });
    }),
  );

  router.get(
    '/dictionary',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ dictionary: await buildDictionary(store, manager, connectionId, str(req.query.database)) });
    }),
  );

  router.get(
    '/objects',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ objects: await listAdvancedObjects(store, manager, connectionId, str(req.query.database)) });
    }),
  );

  router.get(
    '/table-options',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      const table = str(req.query.table);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (!table) throw Object.assign(new Error('table 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json(await describeTableOptions(store, manager, connectionId, table, str(req.query.database)));
    }),
  );

  router.post(
    '/data/compare',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const sourceId = str(body.sourceId);
      const targetId = str(body.targetId);
      if (!sourceId || !targetId) throw Object.assign(new Error('sourceId 与 targetId 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({
        result: await compareData(store, manager, {
          sourceId,
          sourceDatabase: str(body.sourceDatabase),
          targetId,
          targetDatabase: str(body.targetDatabase),
          tables: Array.isArray(body.tables) ? (body.tables as string[]) : undefined,
        }),
      });
    }),
  );

  router.get('/jobs', (_req, res) => res.json({ jobs: store.listJobs() }));

  router.post(
    '/jobs',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId || !store.getConnection(connectionId)) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const type = body.type === 'backup' ? 'backup' : 'query';
      if (type === 'query' && !str(body.sql)) throw Object.assign(new Error('查询任务需要 SQL'), { code: 'INVALID_INPUT', status: 400 });
      const job = store.createJob({
        name: String(body.name ?? '未命名任务'),
        connectionId,
        database: str(body.database),
        type,
        sql: str(body.sql),
        intervalSeconds: Math.max(30, Number(body.intervalSeconds) || 3600),
        enabled: body.enabled !== false,
      });
      res.status(201).json({ job });
    }),
  );

  router.put(
    '/jobs/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const job = store.updateJob(req.params.id, {
        name: str(body.name),
        database: str(body.database),
        sql: str(body.sql),
        type: body.type === 'backup' ? 'backup' : body.type === 'query' ? 'query' : undefined,
        intervalSeconds: body.intervalSeconds === undefined ? undefined : Number(body.intervalSeconds),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      res.json({ job });
    }),
  );

  router.delete('/jobs/:id', (req, res) => {
    store.deleteJob(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/jobs/:id/run',
    ah(async (req, res) => {
      if (scheduler.isRunning(req.params.id)) throw Object.assign(new Error('任务正在运行'), { code: 'JOB_BUSY', status: 409 });
      res.json(await scheduler.runJob(req.params.id));
    }),
  );

  router.post(
    '/backups/:id/restore',
    ah(async (req, res) => {
      const backup = store.listBackups().find((item) => item.id === req.params.id);
      if (!backup) throw Object.assign(new Error('备份不存在'), { code: 'NOT_FOUND', status: 404 });
      const sql = readFileSync(backup.path, 'utf8');
      const started = Date.now();
      const batch = await manager.query(backup.connectionId, sql, {
        database: backup.database,
        allowMulti: true,
        autoLimit: false,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
      });
      manager.invalidate(backup.connectionId);
      store.addAudit({
        actor: 'user',
        connectionId: backup.connectionId,
        database: backup.database,
        tool: 'backup.restore',
        sql: `-- restore ${backup.path}`,
        risk: 'destructive',
        approval: 'manual',
        status: 'ok',
        durationMs: Date.now() - started,
        meta: { path: backup.path, bytes: backup.bytes },
      });
      res.json({ batch });
    }),
  );

  return router;
}
