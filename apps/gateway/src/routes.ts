import { Router, type Request, type Response } from 'express';
import {
  TOOLS,
  isDevicePermissionMode,
  type AppSettings,
  type ConnectionConfig,
  type DeviceInfo,
  type PermissionMode,
} from '@aidb/core';
import { hashToken, safeEqual } from './crypto';
import {
  isDeviceAgentToolAllowed,
  runWithAgentAccess,
  type AgentAccessContext,
} from './agentHost';
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

/** 设备连接列表只返回展示/选择所需字段，主机、账号、SSH、认证与 options 不离开本机。 */
function deviceConnectionView(connection: ConnectionConfig) {
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.engine,
    color: connection.color,
    environment: connection.environment,
    groupName: connection.groupName,
    database: connection.database,
    readonly: connection.readonly,
    hasPassword: connection.hasPassword,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastUsedAt: connection.lastUsedAt,
  };
}

function deviceSettingsView(settings: AppSettings): AppSettings {
  return {
    ...settings,
    agent: {
      ...settings.agent,
      baseUrl: '',
      apiKey: undefined,
      modelKeys: undefined,
      modelConfigs: undefined,
    },
    embedding: { provider: 'none', baseUrl: '', model: '' },
    search: { ...settings.search, proxyUrl: undefined, searxngBaseUrl: '' },
  };
}

function denyDevice(res: Response, message: string, code = 'SCOPE_DENIED'): void {
  res.status(403).json({ error: { code, message } });
}

function denyDeviceConnection(res: Response): void {
  denyDevice(res, '设备无权访问该连接', 'CONNECTION_FORBIDDEN');
}

function deviceModeAllowed(value: unknown): value is PermissionMode {
  return typeof value === 'string' && isDevicePermissionMode(value as PermissionMode);
}

const DEVICE_DATA_POST_PATHS = new Set([
  '/query',
  '/rows',
  '/ddl/preview',
  '/ddl/execute',
  '/vector/search',
  '/documents/upsert',
  '/documents/delete',
  '/objects/drop',
  '/fields/create',
  '/indexes/create',
  '/indexes/drop',
  '/influx/write',
  '/redis/key/list-item',
  '/redis/key/member',
  '/redis/key/member/delete',
  '/redis/hash/field',
  '/redis/hash/field/delete',
  '/redis/key/value',
  '/redis/key/create',
  '/redis/key/ttl',
  '/redis/key/rename',
  '/redis/keys/delete',
  '/redis/index/drop',
  '/objects/create',
]);

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
      res.locals.device = device;
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
        return next();
      }
      if (device.scope === 'admin') return next();
      const access: AgentAccessContext = {
        scope: 'device',
        deviceId: device.id,
        connectionIds: store.listDeviceConnectionPermissions(device.id),
      };
      res.locals.agentAccess = access;
      // SSE 的 close、Abort、审批等异步回调也必须继承同一设备上下文。
      return runWithAgentAccess(access, () => next());
    }
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '访问令牌无效或已吊销' } });
  });

  /**
   * device 采用默认拒绝的能力矩阵。这里只放行初始化、授权连接上的数据与 Agent 操作；
   * 设置写入、密钥、设备、MCP、技能、通知、定时任务、导入导出与宿主文件均不进入矩阵。
   */
  router.use((req, res, next) => {
    const device = res.locals.device as DeviceInfo | undefined;
    if (!device || device.scope !== 'device') return next();
    const p = req.path;
    const method = req.method;
    const allowedConnections = new Set(store.listDeviceConnectionPermissions(device.id));
    const canAccessConnection = (id: unknown): id is string =>
      typeof id === 'string' && allowedConnections.has(id) && Boolean(store.getConnection(id));
    const requireConnection = (id: unknown): boolean => {
      if (canAccessConnection(id)) return true;
      denyDeviceConnection(res);
      return false;
    };
    const requireSession = (id: string) => {
      const session = store.getSession(id);
      if (!session) {
        res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: '会话不存在' } });
        return undefined;
      }
      if (!canAccessConnection(session.connectionId)) {
        denyDeviceConnection(res);
        return undefined;
      }
      return session;
    };
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};

    if (method === 'GET') {
      if (p === '/health' || p === '/capabilities' || /^\/capabilities\/[^/]+$/.test(p)) return next();
      if (p === '/bootstrap') {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          version: config.version,
          platform: process.platform,
          arch: process.arch,
          bridgeHost: config.host,
          bridgePort: config.port,
          connections: store.listConnections()
            .filter((connection) => canAccessConnection(connection.id))
            .map(deviceConnectionView),
          settings: deviceSettingsView(store.publicSettings()),
          sessions: store.listSessions().filter((session) => canAccessConnection(session.connectionId)),
          tools: TOOLS.filter((tool) => isDeviceAgentToolAllowed(tool.name))
            .map((tool) => ({ name: tool.name, description: tool.description, risk: tool.risk })),
          startedAt: deps.startedAt,
        });
        return;
      }
      if (p === '/connections') {
        const requested = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
        if (requested && !canAccessConnection(requested)) {
          denyDeviceConnection(res);
          return;
        }
        res.json({
          connections: store.listConnections()
            .filter((connection) => canAccessConnection(connection.id) && (!requested || connection.id === requested))
            .map(deviceConnectionView),
        });
        return;
      }
      const connectionRead = /^\/connections\/([^/]+)\/(databases|schema|tables)$/.exec(p);
      if (connectionRead) {
        if (!requireConnection(connectionRead[1])) return;
        return next();
      }
      if (p === '/agent/tools') {
        res.json({ tools: TOOLS.filter((tool) => isDeviceAgentToolAllowed(tool.name)) });
        return;
      }
      if (p === '/agent/sessions') {
        const requested = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
        if (requested && !canAccessConnection(requested)) {
          denyDeviceConnection(res);
          return;
        }
        const sessions = store.listSessions({
          ...(requested ? { connectionId: requested } : {}),
          database: typeof req.query.database === 'string' ? req.query.database : undefined,
          archived: req.query.archived === '1',
        }).filter((session) => canAccessConnection(session.connectionId));
        res.json({ sessions });
        return;
      }
      const sessionDetail = /^\/agent\/sessions\/([^/]+)$/.exec(p);
      if (sessionDetail) {
        if (!requireSession(sessionDetail[1])) return;
        return next();
      }
      const turns = /^\/agent\/sessions\/([^/]+)\/turns(?:\/[^/]+\/events)?$/.exec(p);
      if (turns) {
        if (!requireSession(turns[1])) return;
        return next();
      }
      if (p === '/agent/suggest') {
        if (!requireConnection(req.query.connectionId)) return;
        return next();
      }
      if (p === '/data') {
        if (!requireConnection(req.query.connectionId)) return;
        return next();
      }
      if (p === '/agent/memories' || p === '/artifacts' || /^\/artifacts\/[^/]+(?:\/runs|\/export)?$/.test(p)) return next();
      denyDevice(res, '设备凭据无权访问该接口');
      return;
    }

    if (method === 'POST') {
      if (p === '/agent/sessions') {
        if (!requireConnection(body.connectionId)) return;
        if (body.permissionMode !== undefined && body.permissionMode !== null && !deviceModeAllowed(body.permissionMode)) {
          denyDevice(res, '设备 Agent 只能使用 readonly 或 ask 模式', 'MODE_NOT_ALLOWED');
          return;
        }
        return next();
      }
      const turn = /^\/agent\/sessions\/([^/]+)\/turns$/.exec(p);
      if (turn) {
        const session = requireSession(turn[1]);
        if (!session) return;
        const mode = body.mode ?? session.permissionMode;
        if (!deviceModeAllowed(mode)) {
          denyDevice(res, '设备 Agent 只能使用 readonly 或 ask 模式', 'MODE_NOT_ALLOWED');
          return;
        }
        if (!requireConnection(body.connectionId ?? session.connectionId)) return;
        if (typeof body.text === 'string' && /^\/init(?:\s+[\s\S]+)?$/i.test(body.text.trim())) {
          denyDevice(res, '设备 Agent 不能执行 /init', 'COMMAND_NOT_ALLOWED');
          return;
        }
        return next();
      }
      const abort = /^\/agent\/sessions\/([^/]+)\/abort$/.exec(p);
      if (abort) {
        if (!requireSession(abort[1])) return;
        return next();
      }
      if (/^\/agent\/approvals\/[^/]+$/.test(p)) {
        // 审批 id 本身不暴露 session；Host 在消费前再次验证会话 ACL。
        return next();
      }
      if (p === '/agent/chart-insight') {
        if (!requireConnection(body.connectionId)) return;
        return next();
      }
      if (p === '/agent/memories') return next();
      if (DEVICE_DATA_POST_PATHS.has(p)) {
        if (!requireConnection(body.connectionId)) return;
        return next();
      }
      denyDevice(res, '设备凭据无权访问该接口');
      return;
    }

    if (method === 'PATCH') {
      const memoryPatch = /^\/agent\/memories\/([^/]+)$/.exec(p);
      if (memoryPatch) return next();
      const patch = /^\/agent\/sessions\/([^/]+)$/.exec(p);
      if (patch) {
        const session = requireSession(patch[1]);
        if (!session) return;
        if (body.connectionId === null) {
          denyDeviceConnection(res);
          return;
        }
        if (body.connectionId !== undefined && !requireConnection(body.connectionId)) return;
        if (!deviceModeAllowed(body.permissionMode ?? session.permissionMode)) {
          denyDevice(res, '设备 Agent 只能使用 readonly 或 ask 模式', 'MODE_NOT_ALLOWED');
          return;
        }
        return next();
      }
    }

    if (method === 'DELETE') {
      if (/^\/agent\/memories\/[^/]+$/.test(p)) return next();
      const remove = /^\/agent\/sessions\/([^/]+)$/.exec(p);
      if (remove) {
        if (!requireSession(remove[1])) return;
        return next();
      }
    }

    denyDevice(res, '设备凭据无权访问该接口');
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
