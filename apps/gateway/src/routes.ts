import { Router, type NextFunction, type Request, type Response } from 'express';
import { hashToken, safeEqual } from './crypto';
import { createFeatureRouter } from './features/routes';
import { bearer, type ApiDeps } from './routes/shared';
import { createSystemRouter } from './routes/system';
import { createConnectionsRouter } from './routes/connections';
import { createQueryRouter } from './routes/query';
import { createDashboardsRouter } from './routes/dashboards';
import { createObjectsRouter } from './routes/objects';
import { createAgentRouter } from './routes/agent';
import { createPairingRouter } from './routes/pairing';
import { createCommandsRouter } from './routes/commands';
import { createBotsRouter } from './routes/bots';
import { createSkillsRouter } from './routes/skills';
import { createMcpRouter } from './routes/mcp';
import { createNotificationsRouter } from './routes/notifications';

export type { ApiDeps } from './routes/shared';

/**
 * 组合根：全域 auth/scope 边界必须先于任何域路由注册（它设置 res.locals.mcpReadonly）。
 * 各域端点见 routes/<domain>.ts；域间路径前缀互不交叉，域内保持原注册顺序。
 */
export function createApiRouter(deps: ApiDeps): Router {
  const { store, manager, config, scheduler } = deps;
  const router = Router();

  router.use((req, res, next) => {
    const open =
      req.path === '/health' ||
      req.path === '/pair/claim' ||
      req.path === '/pair/mcp/claim' ||
      req.path.startsWith('/bots/');
    if (open) return next();
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '缺少访问令牌' } });
      return;
    }
    if (safeEqual(token, config.token)) return next();
    const device = store.findDeviceByTokenHash(hashToken(token));
    if (device) {
      // 出站 MCP 配对凭据只允许只读工具桥，避免借道 /query 等接口绕过审批。
      if (device.scope === 'mcp:readonly') {
        const p = req.path;
        // 只放行 /agent/tools/<单个工具名>，不用宽前缀，避免未来新增子路由被意外继承权限。
        const allowed =
          (req.method === 'GET' && (p === '/health' || p === '/agent/tools')) ||
          (req.method === 'POST' && /^\/agent\/tools\/[^/]+$/.test(p));
        if (!allowed) {
          res.status(403).json({ error: { code: 'SCOPE_DENIED', message: '只读 MCP 凭据不能访问该接口' } });
          return;
        }
        res.locals.mcpReadonly = true;
      }
      return next();
    }
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '访问令牌无效或已吊销' } });
  });

  router.use(createSystemRouter(deps));
  router.use(createConnectionsRouter(deps));
  router.use(createQueryRouter(deps));
  router.use(createDashboardsRouter(deps));
  router.use(createObjectsRouter(deps));
  router.use(createAgentRouter(deps));
  router.use(createPairingRouter(deps));
  router.use(createCommandsRouter(deps));
  router.use(createBotsRouter(deps));
  router.use(createSkillsRouter(deps));
  router.use(createMcpRouter(deps));
  router.use(createNotificationsRouter(deps));

  router.use(createFeatureRouter({ store, manager, config, scheduler }));

  return router;
}
