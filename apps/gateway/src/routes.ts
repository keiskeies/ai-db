import { existsSync } from 'node:fs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  COMMANDS,
  TOOLS,
  DASHBOARD_CARD_LIMIT,
  DASHBOARD_CHART_TYPES,
  engineDefaultPort,
  engineMeta,
  engineUsesSchema,
  isEngine,
  isSqlEngine,
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
  getTool,
  isAgentContextActive,
  listProviderModels,
  quoteIdent,
  resolveRisk,
  sseHeaders,
  suggestQuestions,
  tablesFromSql,
  type AppSettings,
  type ArtifactType,
  type ColumnDef,
  type ConnectionConfig,
  type DashboardCardSource,
  type DashboardChartType,
  type ForeignKeyInfo,
  type IndexDef,
  type MemoryCandidate,
  type NotificationChannelType,
  type PermissionMode,
  type ProviderKind,
  type ReportSpec,
} from '@aidb/core';
import { pairingCode, hashToken, randomToken, safeEqual } from './crypto';
import { validateBuiltinMcpArgs } from './builtinMcp';
import { readAttachment, saveAttachment } from './attachments';
import type { GatewayConfig } from './config';
import type { ConnectionManager } from './manager';
import { assertExportable, auditCsv, coerceValue, dumpDatabase, exportNeedsStatement, importCsv, importDocuments, writeExportFile } from './services';
import type { Store } from './store';
import type { AgentHost } from './agentHost';
import type { ToolExecutor } from './executor';
import { exportArtifact } from './commands/export';
import { handleBotEvent } from './bots';
import type { SkillStore } from './skills';
import type { SkillWorker } from './skillWorker';
import type { SkillRunner } from './skillRunner';
import { runReportDeck } from './features/reportDeckRun';
import { assertDashboardSql, buildDashboardReportSpec, dashboardSupported, disabledTablesTouched, refreshDashboardCards } from './features/dashboards';
import { generateDashboardDrafts } from './features/dashboardGenerate';
import { composeDashboardCard, previewDashboardSql } from './features/dashboardCompose';
import { listMcpTools } from './mcp';
import { probeSearchBackend, resetSearchHealth, runSearch, SEARCH_BACKENDS, searchHealth } from './search';
import { channelSummary, sendNotification, validateNotificationChannel } from './notifications';
import { executeFixPlan } from './commands/fixExecute';
import { executeReconRepair } from './commands/reconExecute';
import type { CommandRunner } from './commands/runner';
import type { JobScheduler } from './scheduler';
import { createFeatureRouter } from './features/routes';

/** The outbound MCP bridge is for database reads; never expose the local MCP proxy (filesystem/web). */
const MCP_BRIDGE_EXCLUDED = new Set(['mcp_list_servers', 'mcp_list_tools', 'mcp_call']);

export interface ApiDeps {
  config: GatewayConfig;
  store: Store;
  manager: ConnectionManager;
  host: AgentHost;
  executor: ToolExecutor;
  skills: SkillStore;
  skillWorker: SkillWorker;
  skillRunner: SkillRunner;
  pairCodes: Map<string, { expiresAt: number }>;
  scheduler: JobScheduler;
  commands: CommandRunner;
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
  if (conn.engine === 'dm') return (conn.username ?? 'SYSDBA').toUpperCase();
  if (conn.engine === 'cassandra' || conn.engine === 'scylla') return conn.database || 'system';
  if (conn.engine === 'clickhouse') return conn.database ?? 'default';
  return 'public';
}

function assertSqlEngine(conn: ConnectionConfig): void {
  if (isSqlEngine(conn.engine)) return;
  throw Object.assign(new Error(`${engineMeta(conn.engine).label} 不支持该功能`), {
    code: 'UNSUPPORTED_ENGINE',
    status: 400,
    hint: conn.engine === 'mongodb' ? 'MongoDB 请使用查询窗口的 MQL 或 Agent 的 run_mql' : 'Redis 请使用命令窗口或 Agent 的 run_redis',
  });
}

function classifyForAudit(sql: string) {
  try {
    return classifySql(sql).risk;
  } catch {
    return undefined;
  }
}

function reportDeckOutline(result: any): string {
  const lines: string[] = [];
  for (const section of result?.sections ?? []) {
    lines.push(`## ${String(section.title ?? '')}`);
    for (const block of section.blocks ?? []) {
      if (block.kind === 'narrative' && block.text) lines.push(String(block.text));
      else if (block.kind === 'metric') for (const metric of block.metrics ?? []) lines.push(`- ${metric.label}: ${metric.value}${metric.unit ?? ''}`);
      else if (block.kind === 'comparison') lines.push(`- ${block.left?.label}: ${block.left?.value} / ${block.right?.label}: ${block.right?.value} / 差值 ${block.delta?.absolute ?? ''}`);
      else if (block.kind === 'callout' && block.text) lines.push(`> ${block.text}`);
      else if (block.kind === 'table') for (const row of (block.rows ?? []).slice(0, 30)) lines.push(`| ${row.join(' | ')} |`);
      else if (block.kind === 'chart') for (const point of (block.series ?? []).slice(0, 30)) lines.push(`- ${point.label}: ${point.value}`);
    }
  }
  return lines.join('\n').slice(0, 30_000);
}

export function createApiRouter(deps: ApiDeps): Router {
  const { store, manager, host, config, scheduler, commands, executor, skills, skillWorker, skillRunner } = deps;
  const router = Router();

  router.use((req, res, next) => {
    const open = req.path === '/health' || req.path === '/pair/claim' || req.path.startsWith('/bots/');
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

  router.post(
    '/groups/rename',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const from = str(body.from);
      const to = str(body.to);
      if (!from || !to) throw Object.assign(new Error('from 与 to 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ renamed: store.renameGroup(from, to) });
    }),
  );

  router.post(
    '/groups/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const name = str(body.name);
      if (!name) throw Object.assign(new Error('name 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ moved: store.deleteGroup(name) });
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
          sessionId: str(body.sessionId),
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

  // ---------- dashboards ----------
  const dashboardChartType = (value: unknown): DashboardChartType =>
    DASHBOARD_CHART_TYPES.includes(value as DashboardChartType) ? (value as DashboardChartType) : 'bar';

  const dashboardScopeOf = (body: Record<string, unknown>) => {
    const connectionId = str(body.connectionId);
    const conn = connectionId ? store.getConnection(connectionId) : undefined;
    if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
    if (!dashboardSupported(conn.engine)) {
      throw Object.assign(new Error(`${engineMeta(conn.engine).label} 不支持仪表板`), { code: 'DASHBOARD_UNSUPPORTED', status: 400 });
    }
    return { conn, database: str(body.database) ?? conn.database };
  };

  router.get(
    '/dashboards/cards',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const database = str(req.query.database) ?? conn.database;
      const supported = dashboardSupported(conn.engine);
      res.json({
        supported,
        limit: DASHBOARD_CARD_LIMIT,
        cards: supported ? store.listDashboardCards(conn.id, database) : [],
      });
    }),
  );

  router.post(
    '/dashboards/cards',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const { conn, database } = dashboardScopeOf(body);
      const sql = str(body.sql) ?? '';
      const guard = assertDashboardSql(sql);
      if (guard) throw Object.assign(new Error(guard), { code: 'DASHBOARD_NOT_READ_ONLY', status: 400 });
      const blocked = disabledTablesTouched(sql, store.agentContextBundle(conn.id, database).disabledTables);
      if (blocked.length) {
        throw Object.assign(new Error(`这些表已在 Agent 上下文中禁用：${blocked.join('、')}`), { code: 'TABLE_DISABLED', status: 403 });
      }
      const patch = {
        title: (str(body.title) ?? '').trim() || '未命名卡片',
        sql,
        chartType: dashboardChartType(body.chartType),
        x: str(body.x),
        y: str(body.y),
        timeColumn: body.timeColumn === '' ? undefined : str(body.timeColumn),
        span: Number(body.span) === 2 ? (2 as const) : (1 as const),
        pinned: body.pinned === undefined ? undefined : Boolean(body.pinned),
      };
      const id = str(body.id);
      if (id) {
        const card = store.updateDashboardCard(id, patch);
        if (!card) throw Object.assign(new Error('卡片不存在'), { code: 'NOT_FOUND', status: 404 });
        res.json({ card, cards: store.listDashboardCards(conn.id, database) });
        return;
      }
      const existing = store.listDashboardCards(conn.id, database);
      if (existing.length >= DASHBOARD_CARD_LIMIT) {
        throw Object.assign(new Error(`一块仪表板最多 ${DASHBOARD_CARD_LIMIT} 张卡片`), { code: 'DASHBOARD_LIMIT', status: 400 });
      }
      const card = store.insertDashboardCard({
        connectionId: conn.id,
        database,
        source: (str(body.source) as DashboardCardSource) ?? 'manual',
        ...patch,
        timeColumn: patch.timeColumn ?? undefined,
      });
      res.json({ card, cards: store.listDashboardCards(conn.id, database) });
    }),
  );

  router.delete(
    '/dashboards/cards/:id',
    ah(async (req, res) => {
      const card = store.dashboardCard(req.params.id);
      if (!card) throw Object.assign(new Error('卡片不存在'), { code: 'NOT_FOUND', status: 404 });
      store.deleteDashboardCard(card.id);
      res.json({ cards: store.listDashboardCards(card.connectionId, card.database) });
    }),
  );

  router.post(
    '/dashboards/cards/reorder',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : [];
      if (!ids.length) throw Object.assign(new Error('ids 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ cards: store.reorderDashboardCards(ids) });
    }),
  );

  router.post(
    '/dashboards/refresh',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const { conn, database } = dashboardScopeOf(body);
      const cardIds = Array.isArray(body.cardIds) ? new Set(body.cardIds.map((id) => String(id))) : undefined;
      const cards = store.listDashboardCards(conn.id, database).filter((card) => !cardIds || cardIds.has(card.id));
      const rawRange = body.range && typeof body.range === 'object' && !Array.isArray(body.range) ? (body.range as Record<string, unknown>) : undefined;
      const range = rawRange ? { from: str(rawRange.from), to: str(rawRange.to) } : undefined;
      const results = await refreshDashboardCards({ store, manager, settings: store.getSettings(), cards, range });
      res.json({ results, cards: store.listDashboardCards(conn.id, database) });
    }),
  );

  router.get(
    '/dashboards/schedule',
    ah(async (req, res) => {
      const { conn, database } = dashboardScopeOf({ connectionId: str(req.query.connectionId), database: str(req.query.database) });
      res.json({ schedule: store.getDashboardSchedule(conn.id, database) ?? null });
    }),
  );

  router.put(
    '/dashboards/schedule',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const { conn, database } = dashboardScopeOf(body);
      const intervalSeconds = num(body.intervalSeconds, 0, 0, 86_400);
      if (!intervalSeconds) {
        store.removeDashboardSchedule(conn.id, database);
        res.json({ schedule: null });
        return;
      }
      const channels = Array.isArray(body.notifyChannels) ? body.notifyChannels.map((id) => String(id)).slice(0, 4) : [];
      const schedule = store.setDashboardSchedule({
        connectionId: conn.id,
        database,
        intervalSeconds,
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        notifyChannels: channels,
      });
      res.json({ schedule });
    }),
  );

  router.post(
    '/dashboards/report',
    ah(async (req, res) => {
      const body = obj(req.body ?? {}, 'body');
      const { conn, database } = dashboardScopeOf(body);
      const cards = store.listDashboardCards(conn.id, database);
      const spec = buildDashboardReportSpec({ conn, database, cards });
      if (!spec) throw Object.assign(new Error('没有带结果的卡片，先刷新再导出'), { code: 'DASHBOARD_EMPTY', status: 400 });
      const artifactSpec = { ...spec, type: 'report' as const };
      const artifact = store.createArtifact({ type: 'report', title: spec.title, spec: artifactSpec, status: 'ready' });
      // 报告导出读的是「最近一次 run 的快照」，所以这里直接把这次仪表板结果记成一次成功的 run
      store.addArtifactRun({ artifactId: artifact.id, status: 'succeeded', result: artifactSpec, durationMs: 0 });
      res.json({ artifact });
    }),
  );

  router.post(
    '/dashboards/preview',
    ah(async (req, res) => {
      const body = obj(req.body ?? {}, 'body');
      const { conn, database } = dashboardScopeOf(body);
      const sql = str(body.sql) ?? '';
      if (!sql.trim()) throw Object.assign(new Error('sql 必填'), { code: 'INVALID_INPUT', status: 400 });
      const started = Date.now();
      const preview = await previewDashboardSql({ store, manager, connectionId: conn.id, database, sql });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database,
        tool: 'dashboard_preview',
        sql,
        risk: classifyForAudit(sql),
        approval: 'manual',
        status: preview.error ? 'error' : 'ok',
        durationMs: Date.now() - started,
        meta: preview.error ? { error: preview.error } : { rows: preview.rowCount },
      });
      res.json({ preview });
    }),
  );

  router.post(
    '/dashboards/compose',
    ah(async (req, res) => {
      const body = obj(req.body ?? {}, 'body');
      const { conn, database } = dashboardScopeOf(body);
      const prompt = (str(body.prompt) ?? '').trim();
      if (prompt.length < 2) throw Object.assign(new Error('请用一句话描述想看的指标'), { code: 'INVALID_INPUT', status: 400 });
      if (prompt.length > 500) throw Object.assign(new Error('需求最多 500 字，写清指标、维度和时间范围即可'), { code: 'INVALID_INPUT', status: 400 });
      const started = Date.now();
      const result = await composeDashboardCard({ store, manager, connectionId: conn.id, database, prompt });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database,
        tool: 'dashboard_compose',
        sql: result.sql,
        risk: 'read',
        approval: 'manual',
        status: result.preview.error ? 'error' : 'ok',
        durationMs: Date.now() - started,
        meta: { usedModel: result.usedModel, prompt, notes: result.notes.slice(0, 4) },
      });
      res.json(result);
    }),
  );

  router.post(
    '/dashboards/generate',
    ah(async (req, res) => {
      const body = obj(req.body ?? {}, 'body');
      const { conn, database } = dashboardScopeOf(body);
      const result = await generateDashboardDrafts({
        store,
        manager,
        connectionId: conn.id,
        database,
        limit: num(body.limit, 8, 1, DASHBOARD_CARD_LIMIT),
      });
      const cards = store.setDraftCards(conn.id, database, result.cards);
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database,
        tool: 'dashboard_generate',
        sql: result.cards.map((card) => card.sql).join('\n'),
        risk: 'read',
        approval: 'manual',
        status: 'ok',
        durationMs: 0,
        meta: { created: result.cards.length, usedModel: result.usedModel },
      });
      res.json({ created: result.cards.length, usedModel: result.usedModel, notes: result.notes, cards });
    }),
  );

  router.delete(
    '/dashboards/drafts',
    ah(async (req, res) => {
      const body = obj(req.body ?? {}, 'body');
      const { conn, database } = dashboardScopeOf(body);
      res.json({ discarded: store.discardDashboardDrafts(conn.id, database), cards: store.listDashboardCards(conn.id, database) });
    }),
  );

  router.post(
    '/vector/search',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      if (!connectionId || !collection) {
        throw Object.assign(new Error('connectionId 与 collection 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const vector = Array.isArray(body.vector) ? (body.vector as unknown[]).map(Number).filter((value) => Number.isFinite(value)) : undefined;
      const text = str(body.text);
      const field = str(body.field);
      const filter = body.filter && typeof body.filter === 'object' && !Array.isArray(body.filter) ? (body.filter as Record<string, unknown>) : undefined;
      const query = {
        language: 'vector' as const,
        collection,
        topK: Math.max(1, Math.min(1000, Number(body.topK) || 10)),
        op: body.op === 'scroll' ? ('scroll' as const) : undefined,
        ...(vector?.length ? { vector } : {}),
        ...(text ? { text } : {}),
        ...(field ? { field } : {}),
        ...(filter ? { filter } : {}),
      };
      const settings = store.getSettings();
      const started = Date.now();
      try {
        const result = await manager.vectorSearch(connectionId, query, {
          database: str(body.database),
          maxRows: query.topK,
          timeoutMs: settings.queryTimeoutMs,
          actor: 'user',
        });
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'vector.search',
          sql: JSON.stringify(query),
          risk: 'read',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'vector.search',
          sql: JSON.stringify(query),
          risk: 'read',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  const documentBatch = (body: Record<string, unknown>) => {
    const connectionId = str(body.connectionId);
    const collection = str(body.collection);
    if (!connectionId || !collection) {
      throw Object.assign(new Error('connectionId 与 collection 必填'), { code: 'INVALID_INPUT', status: 400 });
    }
    const raw = Array.isArray(body.documents) ? body.documents : body.document ? [body.document] : [];
    const documents = raw.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    );
    if (!documents.length) {
      throw Object.assign(new Error('document 或 documents 必须是非空 JSON 对象'), { code: 'INVALID_INPUT', status: 400 });
    }
    return { connectionId, collection, documents };
  };

  router.post(
    '/documents/upsert',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const { connectionId, collection, documents } = documentBatch(body);
      const database = str(body.database);
      const settings = store.getSettings();
      const started = Date.now();
      try {
        const result = await manager.writeDocuments(connectionId, { collection, documents }, { database, timeoutMs: settings.queryTimeoutMs, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.upsert',
          sql: JSON.stringify({ collection, count: result.upserted, ids: result.ids.slice(0, 5) }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.upsert',
          sql: JSON.stringify({ collection, count: documents.length }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/documents/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id).trim()).filter(Boolean) : [];
      if (!connectionId || !collection || !ids.length) {
        throw Object.assign(new Error('connectionId、collection 与非空 ids 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const settings = store.getSettings();
      const started = Date.now();
      try {
        const result = await manager.deleteDocuments(connectionId, { collection, ids }, { database, timeoutMs: settings.queryTimeoutMs, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.delete',
          sql: JSON.stringify({ collection, ids: ids.slice(0, 5), count: ids.length }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.delete',
          sql: JSON.stringify({ collection, ids: ids.slice(0, 5), count: ids.length }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/documents/import',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      if (!connectionId || !collection) {
        throw Object.assign(new Error('connectionId 与 collection 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const csvText = str(body.csv);
      const started = Date.now();
      const summary = {
        collection,
        rows: csvText ? csvText.split('\n').filter((line: string) => line.trim()).length : undefined,
        path: str(body.path),
      };
      try {
        const result = await importDocuments(store, manager, config, connectionId, {
          collection,
          csv: str(body.csv),
          path: str(body.path),
          hasHeader: body.hasHeader !== false,
          delimiter: str(body.delimiter),
          idColumn: str(body.idColumn),
          vectorColumn: str(body.vectorColumn),
        });
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'documents.import',
          sql: JSON.stringify(summary),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
          meta: { imported: result.imported, skipped: result.skipped },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'documents.import',
          sql: JSON.stringify(summary),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/objects/drop',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const name = str(body.name);
      if (!connectionId || !name) {
        throw Object.assign(new Error('connectionId 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.dropObject(connectionId, name, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/fields/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const object = str(body.object);
      const name = str(body.name);
      if (!connectionId || !object || !name) {
        throw Object.assign(new Error('connectionId、object 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const type = str(body.type) || 'text';
      try {
        const result = await manager.createField(connectionId, { object, name, type }, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'fields.create',
          sql: JSON.stringify({ object, name, type }),
          risk: 'ddl',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'fields.create',
          sql: JSON.stringify({ object, name, type }),
          risk: 'ddl',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/indexes/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      const columns = Array.isArray(body.columns) ? (body.columns as unknown[]).map((column) => String(column ?? '')).filter(Boolean) : [];
      if (!connectionId || !collection || !columns.length) {
        throw Object.assign(new Error('connectionId、collection 与 columns 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const ttl = Number(body.expireAfterSeconds ?? 0);
      const spec = {
        collection,
        name: str(body.name) || undefined,
        columns,
        unique: body.unique === true,
        sparse: body.sparse === true,
        expireAfterSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : undefined,
        type: str(body.type) || undefined,
      };
      try {
        const result = await manager.createCollectionIndex(connectionId, spec, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.create',
          sql: JSON.stringify(spec),
          risk: 'ddl',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.create',
          sql: JSON.stringify(spec),
          risk: 'ddl',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/indexes/drop',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      const name = str(body.name);
      if (!connectionId || !collection || !name) {
        throw Object.assign(new Error('connectionId、collection 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.dropCollectionIndex(connectionId, { collection, name }, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.drop',
          sql: JSON.stringify({ collection, name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.drop',
          sql: JSON.stringify({ collection, name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.get(
    '/documents/get',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      const collection = str(req.query.collection);
      const id = str(req.query.id);
      if (!connectionId || !collection || !id) {
        throw Object.assign(new Error('connectionId、collection 与 id 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const detail = await manager.documentDetail(connectionId, { collection, id }, { database: str(req.query.database) });
      res.json({ detail });
    }),
  );

  router.get(
    '/redis/key',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      const key = str(req.query.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      const detail = await manager.keyDetail(connectionId, key, { database: str(req.query.database) });
      res.json({ detail });
    }),
  );

  router.post(
    '/influx/write',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const raw = typeof body.lines === 'string' ? body.lines.split(/\r?\n/) : Array.isArray(body.lines) ? body.lines.map(String) : [];
      const lines = raw.map((line) => line.trim()).filter(Boolean);
      if (!lines.length) throw Object.assign(new Error('lines 需要至少一行行协议'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      try {
        const result = await manager.writeLineProtocol(connectionId, lines, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'influx.write',
          sql: `write_lp ${result.written} 行`,
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { written: result.written },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'influx.write',
          sql: `write_lp ${lines.length} 行`,
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/tx/begin',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const sessionId = str(body.sessionId);
      if (!connectionId || !sessionId) {
        throw Object.assign(new Error('connectionId 与 sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const result = await manager.beginTransaction(sessionId, connectionId, { database, actor: 'user' });
      store.addAudit({
        actor: 'user',
        connectionId,
        database,
        tool: 'tx.begin',
        sql: 'BEGIN',
        risk: 'write',
        approval: 'manual',
        status: 'ok',
      });
      res.json({ result });
    }),
  );

  router.post(
    '/tx/commit',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const sessionId = str(body.sessionId);
      if (!sessionId) throw Object.assign(new Error('sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const result = await manager.commitTransaction(sessionId);
      store.addAudit({
        actor: 'user',
        tool: 'tx.commit',
        sql: 'COMMIT',
        risk: 'write',
        approval: 'manual',
        status: 'ok',
      });
      res.json({ result });
    }),
  );

  router.post(
    '/tx/rollback',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const sessionId = str(body.sessionId);
      if (!sessionId) throw Object.assign(new Error('sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const result = await manager.rollbackTransaction(sessionId);
      store.addAudit({
        actor: 'user',
        tool: 'tx.rollback',
        sql: 'ROLLBACK',
        risk: 'write',
        approval: 'manual',
        status: 'ok',
      });
      res.json({ result });
    }),
  );

  router.post(
    '/redis/key/list-item',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (typeof body.value !== 'string') throw Object.assign(new Error('value 需要是字符串'), { code: 'INVALID_INPUT', status: 400 });
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0) {
        throw Object.assign(new Error('index 需要是非负整数'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const value = body.value;
      try {
        const result = await manager.setListItem(connectionId, key, index, value, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.list-item',
          sql: JSON.stringify({ key, index }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.list-item',
          sql: JSON.stringify({ key, index }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/member',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const member = str(body.member);
      if (!connectionId || !key || !member) {
        throw Object.assign(new Error('connectionId、key 与 member 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const score = body.score === undefined || body.score === null || body.score === '' ? undefined : Number(body.score);
      if (score !== undefined && !Number.isFinite(score)) {
        throw Object.assign(new Error('score 需要是数字'), { code: 'INVALID_INPUT', status: 400 });
      }
      try {
        const result = await manager.addKeyMember(connectionId, key, member, { database, actor: 'user', score });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member',
          sql: JSON.stringify({ key, member, score }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { added: result.added },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member',
          sql: JSON.stringify({ key, member }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/member/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const member = str(body.member);
      if (!connectionId || !key || !member) {
        throw Object.assign(new Error('connectionId、key 与 member 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.removeKeyMember(connectionId, key, member, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member.delete',
          sql: JSON.stringify({ key, member }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          meta: { deleted: result.deleted, keyGone: result.keyGone },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member.delete',
          sql: JSON.stringify({ key, member }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/hash/field',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const field = str(body.field);
      if (!connectionId || !key || !field) {
        throw Object.assign(new Error('connectionId、key 与 field 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (typeof body.value !== 'string') throw Object.assign(new Error('value 需要是字符串'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const value = body.value;
      try {
        const result = await manager.setHashField(connectionId, key, field, value, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field',
          sql: JSON.stringify({ key, field }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { created: result.created },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field',
          sql: JSON.stringify({ key, field }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/hash/field/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const field = str(body.field);
      if (!connectionId || !key || !field) {
        throw Object.assign(new Error('connectionId、key 与 field 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.deleteHashField(connectionId, key, field, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field.delete',
          sql: JSON.stringify({ key, field }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          meta: { deleted: result.deleted, keyGone: result.keyGone },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field.delete',
          sql: JSON.stringify({ key, field }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/value',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (typeof body.value !== 'string') throw Object.assign(new Error('value 需要是字符串'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const value = body.value;
      try {
        const result = await manager.setKeyValue(connectionId, key, value, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.value',
          sql: JSON.stringify({ key, bytes: value.length }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { ttl: result.ttl },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.value',
          sql: JSON.stringify({ key, bytes: value.length }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const type = str(body.type);
      if (!connectionId || !key || !type) {
        throw Object.assign(new Error('connectionId、key 与 type 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (!['string', 'hash', 'list', 'set', 'zset'].includes(type)) {
        throw Object.assign(new Error('type 需要是 string/hash/list/set/zset'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (body.value === undefined) throw Object.assign(new Error('value 必填'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const ttl = body.ttl === null || body.ttl === undefined || body.ttl === '' ? null : Number(body.ttl);
      if (ttl !== null && (!Number.isFinite(ttl) || ttl < 1)) {
        throw Object.assign(new Error('ttl 需要是正整数秒，或 null 表示永不过期'), { code: 'INVALID_INPUT', status: 400 });
      }
      const input = { key, type: type as 'string' | 'hash' | 'list' | 'set' | 'zset', value: body.value, ttl };
      try {
        const result = await manager.createKey(connectionId, input, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.create',
          sql: JSON.stringify({ key, type }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { ttl: result.ttl },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.create',
          sql: JSON.stringify({ key, type }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/ttl',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const seconds = body.seconds === null || body.seconds === undefined || body.seconds === '' ? null : Number(body.seconds);
      if (seconds !== null && (!Number.isFinite(seconds) || seconds < 1)) {
        throw Object.assign(new Error('seconds 需要是正整数秒，或 null 表示移除过期'), { code: 'INVALID_INPUT', status: 400 });
      }
      try {
        const result = await manager.setKeyTtl(connectionId, key, seconds, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.ttl',
          sql: JSON.stringify({ key, seconds }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { ttl: result.ttl },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.ttl',
          sql: JSON.stringify({ key, seconds }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/rename',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const to = str(body.to);
      if (!connectionId || !key || !to) {
        throw Object.assign(new Error('connectionId、key 与 to 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.renameKey(connectionId, key, to, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.rename',
          sql: JSON.stringify({ from: key, to }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.rename',
          sql: JSON.stringify({ from: key, to }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/keys/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const keys = Array.isArray(body.keys) ? (body.keys as unknown[]).map((key) => String(key ?? '')) : [];
      if (!connectionId || !keys.length) {
        throw Object.assign(new Error('connectionId 与 keys 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const sql = JSON.stringify({ keys: keys.slice(0, 5), count: keys.length });
      try {
        const result = await manager.deleteKeys(connectionId, keys, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.keys.delete',
          sql,
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          meta: { deleted: result.deleted },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.keys.delete',
          sql,
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/index/drop',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const name = str(body.name);
      if (!connectionId || !name) {
        throw Object.assign(new Error('connectionId 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.dropIndex(connectionId, name, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.index.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.index.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/objects/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const name = str(body.name);
      if (!connectionId || !name) {
        throw Object.assign(new Error('connectionId 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const settings = store.getSettings();
      const fields = Array.isArray(body.fields)
        ? (body.fields as Array<Record<string, unknown>>)
            .map((field) => ({ name: String(field.name ?? '').trim(), type: String(field.type ?? 'keyword').trim() }))
            .filter((field) => field.name)
        : [];
      try {
        const result = await manager.createObject(
          connectionId,
          {
            name,
            dimension: body.dimension === undefined || body.dimension === null || body.dimension === '' ? undefined : Number(body.dimension),
            distance: str(body.distance),
            fields,
            edge: body.edge === true,
          },
          { database, timeoutMs: settings.queryTimeoutMs, actor: 'user' },
        );
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.create',
          sql: JSON.stringify({ name, dimension: body.dimension, distance: str(body.distance), fields, edge: body.edge === true }),
          risk: 'ddl',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.create',
          sql: JSON.stringify({ name, dimension: body.dimension, distance: str(body.distance), fields }),
          risk: 'ddl',
          approval: 'manual',
          status: 'error',
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
      assertSqlEngine(conn);
      const database = str(req.query.database);
      const { table } = await manager.findTable(connectionId, database, tableName);
      const limit = num(req.query.limit, 100, 1, 1000);
      const offset = num(req.query.offset, 0, 0, 10_000_000);
      // 多列排序：orderBy=status,total_cents&orderDir=asc,desc，最多 4 列
      const orderCols = (str(req.query.orderBy) ?? '').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 4);
      const directions = String(req.query.orderDir ?? 'asc').split(',').map((value) => value.trim().toLowerCase());
      const orderParts = orderCols
        .map((column, index) => ((table.columns ?? []).some((c) => c.name === column) ? `${quoteIdent(column, conn.engine)} ${directions[index] === 'desc' ? 'DESC' : 'ASC'}` : null))
        .filter((part): part is string => Boolean(part));
      // 未指定排序时按主键升序，确保 offset 分页稳定（否则不同引擎可能重复或漏行）
      const fallbackOrder = (table.columns ?? [])
        .filter((column) => column.primaryKey)
        .map((column) => `${quoteIdent(column.name, conn.engine)} ASC`);
      const orderBy = orderParts.length ? orderParts.join(', ') : fallbackOrder.length ? fallbackOrder.join(', ') : undefined;
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
      const countSql = buildCount(conn.engine, table.name, engineUsesSchema(conn.engine) ? table.schema : undefined, str(req.query.where));
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
      assertSqlEngine(conn);
      if (conn.readonly) throw Object.assign(new Error('只读连接禁止修改数据'), { code: 'READONLY', status: 403 });
      const database = str(body.database);
      const { table } = await manager.findTable(connectionId, database, tableName);
      const known = new Set((table.columns ?? []).map((c) => c.name));
      const typeOf = new Map((table.columns ?? []).map((c) => [c.name, c.type]));
      const rejectUnknown = (keys: string[]) => {
        const unknown = keys.filter((column) => !known.has(column));
        if (unknown.length) {
          throw Object.assign(new Error(`列不存在：${unknown.join(', ')}`), { code: 'UNKNOWN_COLUMN', status: 400 });
        }
      };
      const primaryKeys = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
      const requirePrimaryKey = (whereColumns: string[]) => {
        if (!primaryKeys.length) {
          throw Object.assign(new Error('该表没有主键，不能按行更新或删除'), { code: 'NO_PRIMARY_KEY', status: 400 });
        }
        if (whereColumns.length !== primaryKeys.length || primaryKeys.some((name) => !whereColumns.includes(name))) {
          throw Object.assign(new Error(`更新/删除必须使用完整主键：${primaryKeys.join(', ')}`), { code: 'KEY_NOT_PRIMARY', status: 400 });
        }
      };
      const schema = engineUsesSchema(conn.engine) ? table.schema : undefined;
      let sql: string;
      let params: unknown[] = [];
      let risk = 'write';
      if (op === 'insert') {
        const values = obj(body.values, 'values');
        rejectUnknown(Object.keys(values));
        const columns = Object.keys(values).filter((c) => known.has(c));
        if (!columns.length) throw Object.assign(new Error('没有可插入的列'), { code: 'INVALID_INPUT', status: 400 });
        sql = buildInsert(conn.engine, table.name, columns, 1, schema);
        params = columns.map((c) => coerceValue(values[c], typeOf.get(c) ?? 'text'));
      } else if (op === 'insertMany') {
        const records = Array.isArray(body.rows) ? body.rows.filter((row) => row && typeof row === 'object') as Record<string, unknown>[] : [];
        if (!records.length) throw Object.assign(new Error('没有可插入的行'), { code: 'INVALID_INPUT', status: 400 });
        rejectUnknown([...new Set(records.flatMap((row) => Object.keys(row)))]);
        const columns = [...new Set(records.flatMap((row) => Object.keys(row)))].filter((c) => known.has(c));
        if (!columns.length) throw Object.assign(new Error('没有可插入的列'), { code: 'INVALID_INPUT', status: 400 });
        sql = buildInsert(conn.engine, table.name, columns, records.length, schema);
        params = records.flatMap((row) => columns.map((c) => coerceValue(row[c], typeOf.get(c) ?? 'text')));
      } else if (op === 'update') {
        const values = obj(body.values, 'values');
        const key = obj(body.key, 'key');
        rejectUnknown(Object.keys(values));
        rejectUnknown(Object.keys(key));
        const setCols = Object.keys(values).filter((c) => known.has(c));
        const whereCols = Object.keys(key).filter((c) => known.has(c));
        if (!setCols.length || !whereCols.length) throw Object.assign(new Error('更新需要 values 与主键 key'), { code: 'INVALID_INPUT', status: 400 });
        requirePrimaryKey(whereCols);
        sql = buildUpdate(conn.engine, table.name, setCols, whereCols, schema);
        params = [...setCols.map((c) => coerceValue(values[c], typeOf.get(c) ?? 'text')), ...whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text'))];
      } else if (op === 'delete') {
        const key = obj(body.key, 'key');
        rejectUnknown(Object.keys(key));
        const whereCols = Object.keys(key).filter((c) => known.has(c));
        if (!whereCols.length) throw Object.assign(new Error('删除需要主键 key'), { code: 'INVALID_INPUT', status: 400 });
        requirePrimaryKey(whereCols);
        sql = buildDelete(conn.engine, table.name, whereCols, schema);
        params = whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text'));
        risk = 'destructive';
      } else if (op === 'deleteMany') {
        const keys = Array.isArray(body.keys) ? body.keys.filter((key) => key && typeof key === 'object') as Record<string, unknown>[] : [];
        if (!keys.length) throw Object.assign(new Error('删除需要主键列表'), { code: 'INVALID_INPUT', status: 400 });
        rejectUnknown(Object.keys(keys[0]));
        const whereCols = Object.keys(keys[0]).filter((c) => known.has(c));
        if (!whereCols.length) throw Object.assign(new Error('删除需要主键列'), { code: 'INVALID_INPUT', status: 400 });
        requirePrimaryKey(whereCols);
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
      assertSqlEngine(conn);
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
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      assertSqlEngine(conn);
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
      const format = (['csv', 'json', 'sql', 'xml', 'xlsx'].includes(String(body.format)) ? String(body.format) : 'csv') as 'csv' | 'json' | 'sql' | 'xml' | 'xlsx';
      assertExportable(conn.engine, format);
      const limit = num(body.limit, 10000, 1, 200000);
      let sql: string;
      let tableName: string | undefined;
      if (str(body.sql)) sql = String(body.sql);
      else if (str(body.table)) {
        if (!isSqlEngine(conn.engine)) exportNeedsStatement(conn.engine);
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
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      assertSqlEngine(conn);
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

  router.post(
    '/history/:id/favorite',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const favorite = Boolean(body.favorite);
      if (!store.setHistoryFavorite(req.params.id, favorite)) {
        throw Object.assign(new Error('历史记录不存在'), { code: 'HISTORY_NOT_FOUND', status: 404 });
      }
      res.json({ id: req.params.id, favorite });
    }),
  );

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
  router.get('/search/backends', (_req, res) => {
    res.json({ backends: SEARCH_BACKENDS, health: searchHealth(), keyStatus: store.searchKeyStatus() });
  });

  router.post(
    '/search/query',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const query = String(body.query ?? '').trim();
      if (!query) throw Object.assign(new Error('query 必填'), { code: 'INVALID_INPUT', status: 400 });
      const overrides: Record<string, unknown> = {};
      if (typeof body.numResults === 'number') overrides.numResults = Math.min(20, Math.max(1, Math.trunc(body.numResults)));
      res.json(await runSearch(query, store, overrides as any));
    }),
  );

  router.post('/search/backends/reset', (_req, res) => {
    resetSearchHealth();
    res.json({ health: searchHealth() });
  });

  router.post(
    '/search/backends/:id/probe',
    ah(async (req, res) => {
      const id = SEARCH_BACKENDS.find((backend) => backend.id === req.params.id);
      if (!id) throw Object.assign(new Error('搜索后端不存在'), { code: 'NOT_FOUND', status: 404 });
      res.json({ health: await probeSearchBackend(id.id, store) });
    }),
  );

  router.get('/settings', (_req, res) => res.json({ settings: store.publicSettings() }));
  router.put(
    '/settings',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const current = store.getSettings();
      const agentBody = (body.agent ?? {}) as Partial<AppSettings['agent']>;
      const embeddingBody = (body.embedding ?? {}) as Partial<AppSettings['embedding']>;
      const searchBody = (body.search ?? {}) as Partial<AppSettings['search']>;
      const merged: AppSettings = {
        ...current,
        ...body,
        agent: {
          ...current.agent,
          ...agentBody,
          apiKey: agentBody.apiKey,
        },
        embedding: {
          ...current.embedding,
          ...embeddingBody,
          apiKey: embeddingBody.apiKey,
        },
        search: { ...current.search, ...searchBody },
      };
      store.saveSettings(merged);
      res.json({ settings: store.publicSettings() });
    }),
  );

  // ---------- agent ----------
  router.get('/agent/tools', (req, res) => {
    if (str(req.query.for) === 'mcp' && !store.getSettings().features.mcp) {
      res.status(403).json({ error: { code: 'FEATURE_DISABLED', message: 'MCP 已在设置中关闭' } });
      return;
    }
    const tools = str(req.query.for) === 'mcp' ? TOOLS.filter((tool) => !MCP_BRIDGE_EXCLUDED.has(tool.name)) : TOOLS;
    res.json({ tools });
  });

  router.post(
    '/agent/tools/:name',
    ah(async (req, res) => {
      if (!store.getSettings().features.mcp) {
        res.status(403).json({ error: { code: 'FEATURE_DISABLED', message: 'MCP 已在设置中关闭' } });
        return;
      }
      const name = req.params.name;
      if (MCP_BRIDGE_EXCLUDED.has(name)) {
        res.status(403).json({ error: { code: 'TOOL_NOT_EXPOSED', message: `出站 MCP 桥不暴露 ${name}；本地 MCP 工具只能在 AiDB 内使用` } });
        return;
      }
      const tool = getTool(name);
      if (!tool) {
        res.status(404).json({ error: { code: 'TOOL_NOT_FOUND', message: `工具不存在：${name}` } });
        return;
      }
      const body = obj(req.body, 'body');
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
      const call = { id: `http-${Date.now()}`, name, args };
      const risk = resolveRisk(call, tool);
      if (risk !== 'read') {
        res.status(403).json({ error: { code: 'TOOL_READ_ONLY', message: `MCP 只读桥不允许执行 ${name}（风险 ${risk}）` } });
        return;
      }
      const result = await executor.execute(call, {
        sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'mcp',
        connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
        database: typeof body.database === 'string' ? body.database : undefined,
      });
      res.status(result.ok ? 200 : 400).json({ result });
    }),
  );

  router.post(
    '/agent/models',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const kind = String(body.kind ?? '') as ProviderKind;
      if (!['local', 'anthropic', 'openai', 'ollama'].includes(kind)) {
        throw Object.assign(new Error('未知的模型协议'), { code: 'INVALID_INPUT', status: 400 });
      }
      const stored = store.getSettings().agent;
      const configId = str(body.modelConfigId);
      const config = configId ? stored.modelConfigs?.find((item) => item.id === configId) : undefined;
      const apiKey =
        str(body.apiKey) ??
        (config ? store.getModelApiKey(config.id) : kind === stored.provider ? stored.apiKey : undefined);
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
        database: str(body.database),
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
        database: str(body.database),
        permissionMode: str(body.permissionMode) as PermissionMode | undefined,
        archived: body.archived === undefined ? undefined : Boolean(body.archived),
      });
      res.json({ session });
    }),
  );

  router.delete('/agent/sessions/:id', (req, res) => {
    host.forgetSessionApprovals(req.params.id);
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
            database: str(body.database),
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
      // 建议只是锦上添花：连接还没选库（MySQL 常见）或库不可达时，返回空建议而不是 400，
      // 否则每次打开查询页都会在控制台留下一个失败请求。
      let schemas: Awaited<ReturnType<typeof manager.schema>> = [];
      try {
        schemas = await manager.schema(connectionId, database);
      } catch {
        res.json({ suggestions: [] });
        return;
      }
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

  // ---------- commands / artifacts ----------
  router.get('/commands', (_req, res) => res.json({ commands: COMMANDS }));

  router.post(
    '/commands/:id/runs',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const input = obj(body.input, 'input');
      const saveAs = body.saveAs && typeof body.saveAs === 'object' ? (body.saveAs as Record<string, unknown>) : {};
      const run = commands.start(req.params.id, input, { title: str(saveAs.title) });
      res.status(202).json({ run });
    }),
  );

  router.get('/commands/runs/:id', (req, res) => {
    const run = commands.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在' } });
      return;
    }
    res.json({ run });
  });

  router.get('/commands/runs/:id/events', (req, res) => {
    const runId = req.params.id;
    if (!commands.get(runId)) {
      res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在' } });
      return;
    }
    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    const after = Number(req.query.after) || 0;
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const send = (event: unknown) => {
      if (!closed && !res.writableEnded) res.write(encodeSse(event as Parameters<typeof encodeSse>[0]));
      const type = (event as { type?: string })?.type;
      if (type === 'run_finished') {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    };
    res.on('close', cleanup);
    for (const event of commands.events(runId, after)) {
      send(event);
      if (closed) return;
    }
    if (commands.isFinished(runId)) {
      cleanup();
      if (!res.writableEnded) res.end();
      return;
    }
    unsubscribe = commands.subscribe(runId, send);
  });

  router.post('/commands/runs/:id/cancel', (req, res) => {
    res.json({ ok: commands.cancel(req.params.id) });
  });

  router.get('/artifacts', (req, res) => {
    res.json({
      artifacts: store.listArtifacts({
        type: str(req.query.type) as ArtifactType | undefined,
        limit: num(req.query.limit, 100, 1, 500),
      }),
    });
  });

  router.get('/artifacts/:id', (req, res) => {
    const artifact = store.getArtifact(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    res.json({ artifact });
  });

  router.get('/artifacts/:id/runs', (req, res) => {
    if (!store.getArtifact(req.params.id)) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    res.json({ runs: store.listArtifactRuns(req.params.id, num(req.query.limit, 20, 1, 100)) });
  });

  router.get(
    '/artifacts/:id/export',
    ah(async (req, res) => {
      const format = str(req.query.format) === 'pptx' ? 'pptx' : 'xlsx';
      res.json(await exportArtifact(store, config, req.params.id, format));
    }),
  );

  router.post('/artifacts/:id/deck', (req, res) => {
    if (!store.getSettings().features.reportDeck) {
      res.status(403).json({ error: { code: 'FEATURE_DISABLED', message: 'AI PPT 已在设置中关闭' } });
      return;
    }
    const artifact = store.getArtifact(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    const run = store.listArtifactRuns(artifact.id, 1)[0];
    if (!run) {
      res.status(400).json({ error: { code: 'ARTIFACT_RUN_REQUIRED', message: '产物还没有运行结果' } });
      return;
    }
    const body = obj(req.body, 'body');
    const skill = typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : 'ppt-master';
    const template = typeof body.template === 'string' ? body.template.trim() : '';
    const deterministic = body.mode === 'deterministic' || store.getSettings().agent.provider === 'local';
    if (deterministic) {
      const spec = run.result as ReportSpec;
      if (!spec || !Array.isArray(spec.sections) || !spec.sections.length) {
        res.status(400).json({ error: { code: 'REPORT_REQUIRED', message: '确定性排版需要报告结果（report/compare）' } });
        return;
      }
      runReportDeck(skills, skillRunner, spec, template)
        .then((info) => {
          if (!res.writableEnded) res.status(201).json({ run: { runId: info.id, skill: info.skill, status: info.status }, mode: 'deterministic' });
        })
        .catch((err: any) => {
          if (!res.writableEnded) res.status(500).json({ error: { code: 'DECK_FAILED', message: err?.message ?? '报告 PPTX 生成失败' } });
        });
      return;
    }
    const outline = reportDeckOutline(run.result);
    const prompt = [
      `把下面的 AiDB 报告做成 3 页左右的中文演示文稿，直接产出原生 PPTX。`,
      `报告标题：${artifact.title}`,
      `所有数字必须逐字来自报告，不得改写、四舍五入或补充报告之外的事实。`,
      template ? `使用模板：${template}` : '',
      `报告内容：\n${outline || JSON.stringify(run.result).slice(0, 30_000)}`,
    ].filter(Boolean).join('\n\n');
    res.status(202).json({ run: skillWorker.start(skill, prompt), mode: 'agent' });
  });

  router.post(
    '/artifacts/:id/recon/execute',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      res.json(
        await executeReconRepair(store, manager, config, req.params.id, {
          confirm: String(body.confirm ?? ''),
          steps: Array.isArray(body.steps) ? body.steps.map(Number).filter((value) => Number.isInteger(value) && value >= 0) : undefined,
        }),
      );
    }),
  );

  router.post(
    '/artifacts/:id/fix/execute',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      res.json(
        await executeFixPlan(
          store,
          manager,
          config,
          req.params.id,
          {
            confirm: String(body.confirm ?? ''),
            backup: body.backup === true,
            dryRun: body.dryRun === true,
            steps: Array.isArray(body.steps) ? body.steps.map(Number).filter((value) => Number.isInteger(value) && value >= 0) : undefined,
          },
          executor,
        ),
      );
    }),
  );

  router.post(
    '/bots/:id/events',
    ah(async (req, res) => {
      const result = await handleBotEvent(store, host, req.params.id, req.body, req.headers);
      res.status(result.status).json(result.body);
    }),
  );

  router.get('/skills', (req, res) => {
    res.json({ skills: skills.listSkills(str(req.query.includeDisabled) === '1') });
  });

  router.post('/skills/:id/runs', (req, res) => {
    const body = obj(req.body, 'body');
    res.status(202).json({ run: skillWorker.start(req.params.id, typeof body.prompt === 'string' ? body.prompt : undefined) });
  });

  router.get('/skills/runs/:id', (req, res) => {
    const state = skillWorker.get(req.params.id);
    if (!state) {
      const stored = skillWorker.runInfo(req.params.id);
      if (!stored) {
        res.status(404).json({ error: { code: 'SKILL_RUN_NOT_FOUND', message: 'Skill 运行不存在' } });
        return;
      }
      res.json({
        run: {
          runId: stored.id,
          skill: stored.skill,
          status: stored.status,
          text: stored.stdout ?? '',
          error: stored.error,
          outputs: skillWorker.runFiles(stored.id),
          workspace: stored.workspace,
          project: stored.project,
          startedAt: stored.startedAt,
          finishedAt: stored.finishedAt,
        },
      });
      return;
    }
    const run = skillWorker.runInfo(state.runId);
    res.json({
      run: {
        runId: state.runId,
        skill: state.skill,
        status: state.status,
        text: state.text,
        error: state.error,
        outputs: state.outputs,
        workspace: run?.workspace,
        project: run?.project,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      },
    });
  });

  router.post('/skills/runs/:id/answers', (req, res) => {
    const body = obj(req.body, 'body');
    const questionId = typeof body.questionId === 'string' ? body.questionId : '';
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!questionId || !answer) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'questionId 与 answer 不能为空' } });
      return;
    }
    res.json({ ok: skillWorker.answer(req.params.id, questionId, answer) });
  });

  router.get('/skills/runs/:id/files', (req, res) => {
    const area = str(req.query.area) === 'output' ? 'output' : str(req.query.area) === 'input' ? 'input' : 'workspace';
    try {
      const file = skillWorker.runFile(req.params.id, area, str(req.query.path) ?? '');
      if (!existsSync(file)) {
        res.status(404).json({ error: { code: 'SKILL_FILE_NOT_FOUND', message: '文件不存在' } });
        return;
      }
      res.sendFile(file);
    } catch (err: any) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: err?.message ?? '非法文件路径' } });
    }
  });

  router.get('/skills/runs/:id/events', (req, res) => {
    const runId = req.params.id;
    if (!skillWorker.get(runId)) {
      res.status(404).json({ error: { code: 'SKILL_RUN_NOT_FOUND', message: 'Skill 运行不存在' } });
      return;
    }
    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    const after = Number(req.query.after) || 0;
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const send = (event: unknown) => {
      if (!closed && !res.writableEnded) res.write(encodeSse(event as Parameters<typeof encodeSse>[0]));
      if ((event as { type?: string })?.type === 'done') {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    };
    res.on('close', cleanup);
    for (const event of skillWorker.events(runId, after)) send(event);
    if (skillWorker.isFinished(runId)) {
      cleanup();
      if (!res.writableEnded) res.end();
      return;
    }
    unsubscribe = skillWorker.subscribe(runId, send);
  });

  router.post('/skills/runs/:id/cancel', (req, res) => {
    res.json({ ok: skillWorker.cancel(req.params.id) });
  });

  router.get('/skills/:id/secrets', (req, res) => {
    const skill = skills.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: { code: 'SKILL_NOT_FOUND', message: 'Skill 不存在' } });
      return;
    }
    const manifest = skills.getManifest(req.params.id);
    res.json({ declared: manifest?.secrets ?? [], set: store.listSkillSecretNames(req.params.id) });
  });

  router.put('/skills/:id/secrets', (req, res) => {
    const manifest = skills.getManifest(req.params.id);
    const declared = manifest?.secrets ?? [];
    const body = obj(req.body, 'body');
    const secrets = body.secrets && typeof body.secrets === 'object' && !Array.isArray(body.secrets) ? (body.secrets as Record<string, unknown>) : {};
    for (const [name, value] of Object.entries(secrets)) {
      if (!declared.includes(name)) {
        res.status(400).json({ error: { code: 'SECRET_NOT_DECLARED', message: `Skill 未声明密钥 ${name}` } });
        return;
      }
      if (typeof value === 'string' && value) store.setSkillSecret(req.params.id, name, value);
      else store.deleteSkillSecret(req.params.id, name);
    }
    res.json({ declared, set: store.listSkillSecretNames(req.params.id) });
  });

  router.delete('/skills/:id/secrets/:name', (req, res) => {
    store.deleteSkillSecret(req.params.id, req.params.name);
    res.json({ declared: skills.getManifest(req.params.id)?.secrets ?? [], set: store.listSkillSecretNames(req.params.id) });
  });

  router.get('/skills/:id', (req, res) => {
    const skill = skills.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: { code: 'SKILL_NOT_FOUND', message: 'Skill 不存在' } });
      return;
    }
    res.json({ skill });
  });

  router.get('/skills/:id/file', (req, res) => {
    try {
      res.json(skills.readFile(req.params.id, str(req.query.path) ?? 'SKILL.md'));
    } catch (err: any) {
      res.status(400).json({ error: { code: 'SKILL_READ_FAILED', message: err?.message ?? '读取失败' } });
    }
  });

  router.post(
    '/skills/import',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const requestedId = str(body.id);
      if (typeof body.zipBase64 === 'string' && body.zipBase64.trim()) {
        if (body.zipBase64.length > 280_000_000) throw Object.assign(new Error('压缩包超过限制'), { code: 'SKILL_TOO_LARGE', status: 400 });
        res.status(201).json({ skill: skills.importZip(Buffer.from(body.zipBase64, 'base64'), requestedId) });
        return;
      }
      if (typeof body.git === 'string' && body.git.trim()) {
        res.status(201).json({
          skill: await skills.importGit(body.git.trim(), requestedId, { ref: str(body.ref), subdir: str(body.subdir) }),
        });
        return;
      }
      if (typeof body.npm === 'string' && body.npm.trim()) {
        res.status(201).json({ skill: await skills.importNpm(body.npm.trim(), requestedId, str(body.subdir)) });
        return;
      }
      const path = str(body.path);
      if (!path) throw Object.assign(new Error('需要 path、zipBase64、git 或 npm'), { code: 'INVALID_INPUT', status: 400 });
      res.status(201).json({ skill: skills.importDirectory(path, requestedId) });
    }),
  );

  router.post('/skills/:id/enable', (req, res) => {
    const body = obj(req.body, 'body');
    res.json({ skill: skills.setEnabled(req.params.id, body.enabled !== false) });
  });

  router.delete('/skills/:id', (req, res) => {
    skills.deleteSkill(req.params.id);
    res.status(204).end();
  });

  router.get('/mcp/servers', (_req, res) => {
    res.json({ servers: store.listMcpServers() });
  });

  router.post(
    '/mcp/servers',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const name = String(body.name ?? '').trim();
      const command = String(body.command ?? '').trim();
      if (!name || !command) throw Object.assign(new Error('name 与 command 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (/^builtin[:-]/i.test(name) || ['filesystem', 'git', 'web'].includes(name.toLowerCase())) {
        throw Object.assign(new Error('该名称保留给内置 MCP（filesystem / git / web），请换一个名称'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (command.startsWith('builtin:')) {
        throw Object.assign(new Error('内置 MCP 由系统预置，不能手动创建'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (store.listMcpServers().some((server) => server.name === name)) {
        throw Object.assign(new Error('MCP Server 名称已存在'), { code: 'INVALID_INPUT', status: 400 });
      }
      const args = Array.isArray(body.args) ? body.args.map(String) : [];
      const env = body.env && typeof body.env === 'object' ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : undefined;
      res.status(201).json({ server: store.createMcpServer({ name, command, args, env, enabled: body.enabled !== false }) });
    }),
  );

  router.put(
    '/mcp/servers/:id',
    ah(async (req, res) => {
      const current = store.getMcpServer(req.params.id);
      if (!current) throw Object.assign(new Error('MCP Server 不存在'), { code: 'MCP_SERVER_NOT_FOUND', status: 404 });
      const body = obj(req.body, 'body');
      if (current.builtin) {
        if (typeof body.command === 'string' && body.command.trim() !== current.command) {
          throw Object.assign(new Error('内置 MCP 的命令不可修改'), { code: 'INVALID_INPUT', status: 400 });
        }
        if (typeof body.name === 'string' && body.name.trim() !== current.name) {
          throw Object.assign(new Error('内置 MCP 的名称不可修改'), { code: 'INVALID_INPUT', status: 400 });
        }
      }
      const args = Array.isArray(body.args) ? body.args.map(String) : undefined;
      res.json({
        server: store.updateMcpServer(req.params.id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          command: typeof body.command === 'string' ? body.command : undefined,
          args: current.builtin && args ? validateBuiltinMcpArgs(current.builtin, args) : args,
          env: body.env && typeof body.env === 'object' ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        }),
      });
    }),
  );

  router.delete('/mcp/servers/:id', (req, res) => {
    const current = store.getMcpServer(req.params.id);
    if (current?.builtin) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: '内置 MCP 不能删除，请在列表中停用' } });
      return;
    }
    store.deleteMcpServer(req.params.id);
    res.status(204).end();
  });

  router.get(
    '/mcp/servers/:id/tools',
    ah(async (req, res) => {
      res.json(await listMcpTools(store, req.params.id));
    }),
  );

  router.get('/notifications/channels', (_req, res) => {
    res.json({ channels: store.listNotificationChannels() });
  });

  router.post(
    '/notifications/channels',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const type = String(body.type ?? '') as NotificationChannelType;
      const allowedTypes: NotificationChannelType[] = ['feishu', 'wecom', 'qq-onebot', 'dingtalk', 'slack', 'discord', 'telegram'];
      if (!allowedTypes.includes(type)) {
        throw Object.assign(new Error('type 必须是 feishu / wecom / qq-onebot / dingtalk / slack / discord / telegram'), { code: 'INVALID_INPUT', status: 400 });
      }
      const name = String(body.name ?? '').trim();
      if (!name) throw Object.assign(new Error('name 必填'), { code: 'INVALID_INPUT', status: 400 });
      const config = body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : {};
      validateNotificationChannel(type, config);
      res.status(201).json({
        channel: store.createNotificationChannel({ name, type, config, summary: channelSummary(type, config), enabled: body.enabled !== false }),
      });
    }),
  );

  router.put(
    '/notifications/channels/:id',
    ah(async (req, res) => {
      const existing = store.getNotificationChannel(req.params.id);
      if (!existing) throw Object.assign(new Error('通知渠道不存在'), { code: 'CHANNEL_NOT_FOUND', status: 404 });
      const body = obj(req.body, 'body');
      const config = body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : undefined;
      if (config) validateNotificationChannel(existing.type, config);
      res.json({
        channel: store.updateNotificationChannel(req.params.id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          config,
          summary: config ? channelSummary(existing.type, config) : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        }),
      });
    }),
  );

  router.delete('/notifications/channels/:id', (req, res) => {
    store.deleteNotificationChannel(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/notifications/channels/:id/test',
    ah(async (req, res) => {
      res.json({ result: await sendNotification(store, req.params.id, '【AiDB Studio】通知渠道测试消息') });
    }),
  );

  router.get('/artifacts/:id/schedule', (req, res) => {    if (!store.getArtifact(req.params.id)) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    res.json({ schedule: store.getArtifactSchedule(req.params.id) ?? null });
  });

  router.post('/artifacts/:id/schedule', (req, res) => {
    if (!store.getArtifact(req.params.id)) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    const body = obj(req.body, 'body');
    const intervalSeconds = num(body.intervalSeconds, 3600, 60, 30 * 86400);
    const schedule = store.upsertArtifactSchedule(req.params.id, {
      intervalSeconds,
      enabled: body.enabled !== false,
      refreshNarrative: body.refreshNarrative === true,
    });
    if (Array.isArray(body.notifyChannels)) {
      store.setArtifactScheduleNotifyChannels(
        req.params.id,
        body.notifyChannels.filter((value): value is string => typeof value === 'string'),
      );
    }
    res.json({ schedule: store.getArtifactSchedule(req.params.id) ?? schedule });
  });

  router.delete('/artifacts/:id/schedule', (req, res) => {
    store.deleteArtifactSchedule(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/artifacts/:id/runs',
    ah(async (req, res) => {
      const artifact = store.getArtifact(req.params.id);
      if (!artifact) throw Object.assign(new Error('产物不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
      const spec = artifact.spec as Record<string, unknown>;
      const command = str(spec.command) ?? artifact.type;
      const input = (spec.input && typeof spec.input === 'object' ? spec.input : { sources: spec.sources }) as Record<string, unknown>;
      const run = commands.start(command, input, { title: artifact.title, artifactId: artifact.id });
      res.status(202).json({ run });
    }),
  );

  router.delete('/artifacts/:id', (req, res) => {
    store.deleteArtifact(req.params.id);
    res.status(204).end();
  });

  router.use(createFeatureRouter({ store, manager, config, scheduler }));

  return router;
}
