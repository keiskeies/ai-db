import { Router } from 'express';
import {
  TOOLS,
  getCapability,
  listCapabilities,
  type AppSettings,
} from '@aidb/core';
import { unavailableEngines } from '../engineAvailability';
import { auditCsv } from '../services';
import { probeSearchBackend, resetSearchHealth, runSearch, SEARCH_BACKENDS, searchHealth } from '../search';
import {
  ah,
  str,
  obj,
  num,
  type ApiDeps,
} from './shared';

export function createSystemRouter(deps: ApiDeps): Router {
  const { store, host, config } = deps;
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: config.version,
      platform: process.platform,
      arch: process.arch,
      demoReady: store.listConnections().some((c) => c.engine === 'sqlite'),
      unavailableEngines: unavailableEngines(),
      uptimeMs: Date.now() - deps.startedAt,
    });
  });

  router.get('/bootstrap', (_req, res) => {
    res.json({
      version: config.version,
      platform: process.platform,
      arch: process.arch,
      bridgeHost: config.host,
      bridgePort: config.port,
      connections: store.listConnections(),
      settings: store.publicSettings(),
      sessions: store.listSessions(),
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, risk: t.risk })),
      // 依赖预编译原生绑定、而本机恰好没有的引擎（当前是 macOS Intel 的 Oracle）：
      // 客户端据此把该引擎置灰，避免用户配完连接才发现连不上。
      unavailableEngines: unavailableEngines(),
      startedAt: deps.startedAt,
    });
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
      // reasoningTier 显式传 null 表示「切回 Default（不下发推理参数）」：浅合并会把 null 留下，
      // 这里归一成未设置，避免库里存一个既不是档位也不是缺省的中间态。
      // 不传该字段时保持原值，不能被其它设置项的保存顺带清掉。
      const clearsTier = 'reasoningTier' in agentBody && agentBody.reasoningTier === null;
      if (clearsTier) delete (agentBody as Record<string, unknown>).reasoningTier;
      const merged: AppSettings = {
        ...current,
        ...body,
        agent: {
          ...current.agent,
          ...agentBody,
          apiKey: agentBody.apiKey,
          ...(clearsTier ? { reasoningTier: undefined } : {}),
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

  // ---------- capabilities（功能能力契约）----------
  router.get('/capabilities', (_req, res) => {
    res.json({ capabilities: listCapabilities() });
  });

  router.get('/capabilities/:id', (req, res) => {
    const capability = getCapability(req.params.id);
    if (!capability) {
      res.status(404).json({ error: { code: 'CAPABILITY_NOT_FOUND', message: `功能不存在：${req.params.id}` } });
      return;
    }
    res.json({ capability });
  });

  return router;
}
