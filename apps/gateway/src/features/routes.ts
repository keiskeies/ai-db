import { readFileSync } from 'node:fs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { encodeSse, engineMeta, isSqlEngine, sseHeaders, type TableMaintenanceAction } from '@aidb/core';
import { getCapability, validateCapabilityInput, type CapabilityId } from '@aidb/core';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import type { JobScheduler } from '../scheduler';
import { restoreDropStatements } from '../services';
import { compareSchemas } from './schemaCompare';
import { searchDatabase } from './search';
import { transferData, TransferAbortedError, type TransferEvent, type TransferResult } from './transfer';
import { createPipelinesRouter } from './pipelines';
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

/**
 * 用能力契约校验请求体，把失败统一成 `{ code:'INVALID_INPUT', status:400, field }`。
 *
 * 契约是字段知识的唯一来源（`packages/core/src/capabilities/<id>.json`）；
 * 端点只负责把归一化后的值转给执行函数。未迁移的端点仍走手写 `str()` 校验。
 */
function capabilityBody(id: CapabilityId, body: unknown): Record<string, unknown> {
  const capability = getCapability(id);
  if (!capability) throw Object.assign(new Error(`能力契约不存在：${id}`), { code: 'CAPABILITY_NOT_FOUND', status: 500 });
  const result = validateCapabilityInput(capability, body);
  if (result.ok) return result.value ?? {};
  const first = result.errors?.[0];
  throw Object.assign(new Error(first?.message ?? '参数不合法'), {
    code: 'INVALID_INPUT',
    status: 400,
    field: first?.field,
    hint: result.errors?.map((item) => `${item.field}: ${item.message}`).join('；'),
  });
}

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

  const sqlOnlyPaths = [
    '/databases/ops',
    '/tables/ops',
    '/data/replace',
    '/schema/compare',
    '/schema/sync',
    '/transfer',
    '/generate',
    '/monitor',
    '/users',
    '/dictionary',
    '/objects',
    '/table-options',
    '/data/compare',
    '/jobs',
    '/backups',
  ];
  router.use((req, res, next) => {
    if (!sqlOnlyPaths.some((path) => req.path === path || req.path.startsWith(`${path}/`))) {
      next();
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = [req.query.connectionId, body.connectionId, body.sourceId, body.targetId]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const id of ids) {
      const conn = store.getConnection(id);
      if (conn && !isSqlEngine(conn.engine)) {
        next(
          Object.assign(new Error(`${engineMeta(conn.engine).label} 不支持该功能`), {
            code: 'UNSUPPORTED_ENGINE',
            status: 400,
            hint: conn.engine === 'mongodb' ? 'MongoDB 请使用查询窗口的 MQL 或 Agent 的 run_mql' : 'Redis 请使用命令窗口或 Agent 的 run_redis',
          }),
        );
        return;
      }
    }
    next();
  });

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
      const input = capabilityBody('search', req.body);
      const scope = input.scope === 'objects' || input.scope === 'data' ? input.scope : 'all';
      const result = await searchDatabase(
        store,
        manager,
        String(input.connectionId),
        input.database as string | undefined,
        String(input.query ?? ''),
        scope,
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
      // 契约把 statements 声明为 `code`（一段 DDL 文本，对 Agent 最自然），
      // 但历史 UI 传的是 string[]。这里在进契约前归一化成文本，校验后再拆回语句数组。
      const raw = obj(req.body, 'body');
      const normalized = Array.isArray(raw.statements) ? { ...raw, statements: (raw.statements as unknown[]).filter((item): item is string => typeof item === 'string').join(';\n') } : raw;
      const input = capabilityBody('schema-sync', normalized);
      const connectionId = String(input.connectionId);
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      if (conn.readonly) throw Object.assign(new Error('目标连接为只读'), { code: 'READONLY', status: 403 });
      const text = String(input.statements ?? '').trim();
      const statements = text
        .split(/;\s*\n|;\s*(?=CREATE|ALTER|DROP|RENAME|COMMENT)/i)
        .map((item) => item.trim())
        .filter(Boolean);
      const sql = statements.join(';\n');
      if (!sql.trim()) throw Object.assign(new Error('没有同步语句'), { code: 'INVALID_INPUT', status: 400 });
      const started = Date.now();
      const batch = await manager.query(connectionId, sql, {
        database: input.database as string | undefined,
        allowMulti: true,
        autoLimit: false,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
      });
      store.addAudit({
        actor: 'user',
        connectionId,
        database: input.database as string | undefined,
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
      const input = capabilityBody('transfer', req.body);
      const sourceId = String(input.sourceConnectionId);
      const targetId = String(input.targetConnectionId);
      const started = Date.now();
      const result = await transferData(store, manager, {
        sourceId,
        sourceDatabase: input.sourceDatabase as string | undefined,
        targetId,
        targetDatabase: input.targetDatabase as string | undefined,
        tables: input.tables as string[] | undefined,
        mode: input.mode === 'replace' ? 'replace' : 'append',
        createMissing: input.createMissing !== false,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
      store.addAudit({
        actor: 'user',
        connectionId: targetId,
        database: input.targetDatabase as string | undefined,
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
    '/transfer/stream',
    ah(async (req, res) => {
      // 与 /transfer 共用同一份契约：两者入参相同，手写校验会漂（limit 的归一化就曾经不一致）。
      // 必须在 writeHead 之前校验——校验失败要返回 400 JSON，而不是塞进 SSE 流里的错误事件。
      const input = capabilityBody('transfer', req.body);
      const sourceId = String(input.sourceConnectionId);
      const targetId = String(input.targetConnectionId);
      const started = Date.now();
      res.writeHead(200, sseHeaders());
      res.flushHeaders?.();
      let finished = false;
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!finished && !closed && !res.writableEnded) res.write(': ping\n\n');
      }, 15000);
      const send = (event: TransferEvent) => {
        if (finished || closed || res.writableEnded) return;
        res.write(encodeSse(event));
      };
      res.on('close', () => {
        if (!res.writableEnded) closed = true;
      });
      let result: TransferResult | undefined;
      let failure: string | undefined;
      try {
        result = await transferData(store, manager, {
          sourceId,
          sourceDatabase: input.sourceDatabase as string | undefined,
          targetId,
          targetDatabase: input.targetDatabase as string | undefined,
          tables: input.tables as string[] | undefined,
          mode: input.mode === 'replace' ? 'replace' : 'append',
          createMissing: input.createMissing !== false,
          limit: typeof input.limit === 'number' ? input.limit : undefined,
          onEvent: send,
          shouldAbort: () => closed,
        });
      } catch (err: any) {
        failure = String(err?.message ?? '传输失败');
        if (!(err instanceof TransferAbortedError)) {
          send({ type: 'error', code: err?.code ?? 'TRANSFER_ERROR', message: failure });
        }
      } finally {
        finished = true;
        clearInterval(heartbeat);
        store.addAudit({
          actor: 'user',
          connectionId: targetId,
          database: input.targetDatabase as string | undefined,
          tool: 'data.transfer',
          risk: 'write',
          approval: 'manual',
          status: result && !result.results.some((item) => item.status === 'error') ? 'ok' : 'error',
          durationMs: Date.now() - started,
          meta: {
            sourceId,
            tables: result?.results.length ?? (Array.isArray(input.tables) ? input.tables.length : 0),
            rows: result?.totalRows ?? 0,
            failed: result?.results.filter((item) => item.status === 'error').length ?? 0,
            aborted: closed,
            error: failure,
          },
        });
        if (!res.writableEnded) res.end();
      }
    }),
  );

  router.post(
    '/generate',
    ah(async (req, res) => {
      const input = capabilityBody('generate', req.body);
      const connectionId = String(input.connectionId);
      const started = Date.now();
      const result = await generateData(store, manager, {
        connectionId,
        database: input.database as string | undefined,
        table: String(input.table ?? ''),
        rows: Number(input.rows) || 10,
        dryRun: input.dryRun === true,
      });
      store.addAudit({
        actor: 'user',
        connectionId,
        database: input.database as string | undefined,
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
      const input = capabilityBody('monitor', req.query);
      res.json({ monitor: await monitorConnection(store, manager, String(input.connectionId)) });
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
      const input = capabilityBody('users', req.body);
      const action = input.action === 'drop' || input.action === 'grant' ? input.action : input.action === 'list' ? 'list' : 'create';
      // list 复用 /users 的只读实现：契约把四个动作合在一张表单里，端点保持单一入口
      if (action === 'list') {
        res.json({ result: await listUsers(store, manager, String(input.connectionId)) });
        return;
      }
      const result = await manageUser(store, manager, String(input.connectionId), action, {
        name: input.name as string | undefined,
        host: input.host as string | undefined,
        password: input.password as string | undefined,
        privileges: input.privileges as string | undefined,
        scope: input.scope as string | undefined,
        role: input.role as string | undefined,
      });
      res.json({ result });
    }),
  );

  router.get(
    '/dictionary',
    ah(async (req, res) => {
      const input = capabilityBody('dictionary', req.query);
      const connectionId = String(input.connectionId);
      res.json({ dictionary: await buildDictionary(store, manager, connectionId, input.database as string | undefined) });
    }),
  );

  router.get(
    '/objects',
    ah(async (req, res) => {
      const input = capabilityBody('advanced-objects', req.query);
      res.json({ objects: await listAdvancedObjects(store, manager, String(input.connectionId), input.database as string | undefined) });
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
      const input = capabilityBody('compare-data', req.body);
      res.json({
        result: await compareData(store, manager, {
          sourceId: String(input.sourceId),
          sourceDatabase: input.sourceDatabase as string | undefined,
          targetId: String(input.targetId),
          targetDatabase: input.targetDatabase as string | undefined,
          tables: input.tables as string[] | undefined,
        }),
      });
    }),
  );

  router.get('/jobs', (_req, res) => res.json({ jobs: store.listJobs() }));

  router.post(
    '/jobs',
    ah(async (req, res) => {
      const input = capabilityBody('jobs', req.body);
      const connectionId = String(input.connectionId);
      if (!store.getConnection(connectionId)) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const type: 'query' | 'backup' | 'pipeline' = input.type === 'backup' ? 'backup' : input.type === 'pipeline' ? 'pipeline' : 'query';
      const payload = input.payload && typeof input.payload === 'object' ? (input.payload as Record<string, unknown>) : {};
      const pipelineIds = Array.isArray(payload.pipelineIds) ? payload.pipelineIds.map((id) => String(id)).filter(Boolean) : [];
      if (type === 'pipeline' && !pipelineIds.length) throw Object.assign(new Error('数据流任务至少要选一条流水线'), { code: 'PIPELINE_REQUIRED', status: 400, hint: 'payload: {"pipelineIds": ["<流水线 id>"]}' });
      const job = store.createJob({
        name: String(input.name),
        connectionId,
        database: input.database as string | undefined,
        type,
        sql: input.sql as string | undefined,
        payload: type === 'pipeline' ? { pipelineIds } : undefined,
        intervalSeconds: Math.max(30, Number(input.intervalSeconds) || 3600),
        enabled: input.enabled !== false,
      });
      res.status(201).json({ job });
    }),
  );

  router.put(
    '/jobs/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const payload = body.payload && typeof body.payload === 'object' ? (body.payload as Record<string, unknown>) : undefined;
      const pipelineIds = payload && Array.isArray(payload.pipelineIds) ? payload.pipelineIds.map((id) => String(id)).filter(Boolean) : undefined;
      const job = store.updateJob(req.params.id, {
        name: str(body.name),
        database: str(body.database),
        sql: str(body.sql),
        type: body.type === 'backup' ? 'backup' : body.type === 'pipeline' ? 'pipeline' : body.type === 'query' ? 'query' : undefined,
        payload: pipelineIds === undefined ? undefined : { pipelineIds },
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

  // 数据流处理不要求 SQL 引擎：HTTP 取数 + 内存 DuckDB 计算对任何连接都成立。
  router.use('/pipelines', createPipelinesRouter({ store, manager, config }));

  router.post(
    '/backups/:id/restore',
    ah(async (req, res) => {
      const backup = store.listBackups().find((item) => item.id === req.params.id);
      if (!backup) throw Object.assign(new Error('备份不存在'), { code: 'NOT_FOUND', status: 404 });
      const sql = readFileSync(backup.path, 'utf8');
      const conn = store.getConnection(backup.connectionId);
      if (!conn) throw Object.assign(new Error('备份对应的连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const drops = restoreDropStatements(conn.engine, sql);
      const started = Date.now();
      // SQLite 走整段脚本：45 万条 INSERT 逐条执行会阻塞事件循环十几分钟。
      const fast = await manager.execScript(backup.connectionId, [...drops, 'BEGIN;', sql, 'COMMIT;'].join('\n'), {
        database: backup.database,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
      });
      const batch = fast
        ? { sets: [], messages: ['备份已恢复'], durationMs: Date.now() - started }
        : await manager.query(backup.connectionId, [...drops, sql].join('\n'), {
        database: backup.database,
        allowMulti: true,
        autoLimit: false,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
      });
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
