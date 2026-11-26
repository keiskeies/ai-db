import { randomUUID } from 'node:crypto';
import { open, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import {
  TOOLS,
  getCapability,
  listCapabilities,
  type AppSettings,
} from '@aidb/core';
import { unavailableEngines } from '../engineAvailability';
import { SqliteDriver } from '../drivers/sqlite';
import { auditCsv } from '../services';
import { probeSearchBackend, resetSearchHealth, runSearch, SEARCH_BACKENDS, searchHealth } from '../search';
import {
  ah,
  str,
  obj,
  num,
  type ApiDeps,
} from './shared';

export const MIN_BACKUP_FREE_BYTES = 64 * 1024 * 1024;

export function hasBackupCapacity(stats: { bsize: number | bigint; bavail: number | bigint }): boolean {
  try {
    const blockSize = BigInt(stats.bsize);
    const availableBlocks = BigInt(stats.bavail);
    return blockSize > 0n && availableBlocks > 0n && availableBlocks * blockSize >= BigInt(MIN_BACKUP_FREE_BYTES);
  } catch {
    return false;
  }
}

export async function checkSqliteWritable(filePath: string): Promise<boolean> {
  let driver: SqliteDriver | undefined;
  try {
    driver = new SqliteDriver(filePath, false);
    const table = `aidb_health_${randomUUID().replaceAll('-', '')}`;
    await driver.execScript(`BEGIN IMMEDIATE; CREATE TABLE "${table}" (id INTEGER); ROLLBACK;`, undefined, { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  } finally {
    await driver?.close().catch(() => undefined);
  }
}

export async function checkBackupStorage(directory: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const probe = join(directory, `.aidb-health-${randomUUID()}`);
  try {
    if (!hasBackupCapacity(await statfs(directory))) return false;
    handle = await open(probe, 'wx', 0o600);
    await handle.write('x');
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await handle?.close();
    } finally {
      await unlink(probe).catch(() => undefined);
    }
  }
}

export function createSystemRouter(deps: ApiDeps): Router {
  const { store, host, config } = deps;
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'alive',
      version: config.version,
      platform: process.platform,
      arch: process.arch,
      demoReady: store.listConnections().some((c) => c.engine === 'sqlite'),
      unavailableEngines: unavailableEngines(),
      uptimeMs: Date.now() - deps.startedAt,
    });
  });

  router.get('/health/metrics', (req, res) => {
    const device = res.locals.device as { scope?: string } | undefined;
    if (device && device.scope !== 'admin') {
      res.status(403).json({ error: { code: 'SCOPE_DENIED', message: '只有管理员可以查看运维指标' } });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ metrics: deps.metrics.snapshot() });
  });

  router.get('/health/ready', ah(async (_req, res) => {
    const [sqliteWritable, backupsWritable] = await Promise.all([
      checkSqliteWritable(config.dbPath),
      checkBackupStorage(config.backupDir),
    ]);
    const checks = {
      sqlite: sqliteWritable ? 'ok' : 'error',
      backups: backupsWritable ? 'ok' : 'error',
    };
    const ok = sqliteWritable && backupsWritable;
    res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? 'alive' : 'unavailable',
      checks,
      version: config.version,
      platform: process.platform,
      arch: process.arch,
      demoReady: store.listConnections().some((c) => c.engine === 'sqlite'),
      unavailableEngines: unavailableEngines(),
      uptimeMs: Date.now() - deps.startedAt,
      ...(!ok ? { error: { code: 'HEALTH_CHECK_FAILED', message: '服务不可用', correlationId: res.locals.correlationId } } : {}),
    });
  }));

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
