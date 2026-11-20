import { Router } from 'express';
import {
  DASHBOARD_CARD_LIMIT,
  DASHBOARD_CHART_TYPES,
  engineMeta,
  type DashboardCardSource,
  type DashboardChartType,
} from '@aidb/core';
import {
  assertDashboardSql,
  buildDashboardReportSpec,
  dashboardSupported,
  disabledTablesTouched,
  refreshDashboardCards,
} from '../features/dashboards';
import { generateDashboardDrafts } from '../features/dashboardGenerate';
import { composeDashboardCard, previewDashboardSql } from '../features/dashboardCompose';
import {
  ah,
  str,
  obj,
  num,
  classifyForAudit,
  type ApiDeps,
} from './shared';

export function createDashboardsRouter(deps: ApiDeps): Router {
  const { store, manager } = deps;
  const router = Router();

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

  return router;
}
