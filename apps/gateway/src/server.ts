import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Bonjour } from 'bonjour-service';
import { hostname } from 'node:os';
import cors from 'cors';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentEvent, PermissionMode } from '@aidb/core';
import { CAPABILITIES, TOOLS, assertCapabilities, assertCommandDefinitions } from '@aidb/core';
import { AgentHost, type AgentAccessContext } from './agentHost';
import { seedBuiltinMcpServers, bindSearchStore } from './builtinMcp';
import { CommandRunner } from './commands/runner';
import { refreshDashboardCards } from './features/dashboards';
import { runPipelineAndRecord } from './features/pipelines';
import { shutdownMcpClients } from './mcp';
import { SkillStore } from './skills';
import { SkillRunner } from './skillRunner';
import { SkillWorker } from './skillWorker';
import { hashToken, safeEqual } from './crypto';
import { loadConfig, type GatewayConfig } from './config';
import { ConnectionManager } from './manager';
import { throwIfAborted } from './drivers/timeout';
import { GatewayEvents, type ConnectionsChangedEvent, type SchemaChangedEvent } from './events';
import { ToolExecutor } from './executor';
import { ensureDemoDatabase } from './seed';
import { createApiRouter } from './routes';
import { JobScheduler } from './scheduler';
import { Store } from './store';
import { AlertSender, GatewayMetrics, currentCorrelationId, logGateway, runWithCorrelation } from './observability';

/** WS 背压阈值（G5）：客户端不消费时帧积压在发送缓冲，超过 1MB 丢弃该客户端，保护网关内存。 */
const WS_MAX_BUFFERED_BYTES = 1024 * 1024;
const WS_MAX_PAYLOAD_BYTES = 1024 * 1024;
/** WS 死连接阈值（G5）：ping 周期 30s，连续 3 轮（90s）没有任何入站消息即判半开连接，terminate。 */
const WS_DEAD_AFTER_MS = 90_000;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = (address ?? '').replace(/^::ffff:/, '').split('%')[0];
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.');
}

function gatewayOrigins(config: GatewayConfig): Set<string> {
  const origins = new Set<string>();
  if (config.publicUrl) origins.add(new URL(config.publicUrl).origin);
  if (config.port > 0) {
    const wildcard = ['0.0.0.0', '::', '[::]'].includes(config.host);
    if (!wildcard) {
      const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
      origins.add(new URL(`http://${host}:${config.port}`).origin);
    }
    origins.add(`http://127.0.0.1:${config.port}`);
    origins.add(`http://localhost:${config.port}`);
    origins.add(`http://[::1]:${config.port}`);
  }
  if (!config.production) {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
    origins.add('http://localhost:5180');
    origins.add('http://127.0.0.1:5180');
  }
  return origins;
}

function safeErrorCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function httpErrorBody(err: any, correlationId?: string): Record<string, unknown> {
  const rawStatus = Number(err?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  if (status >= 500) {
    const timeoutCode = status === 504 ? safeErrorCode(err?.code, 'REQUEST_TIMEOUT') : undefined;
    return {
      error: {
        code: timeoutCode ?? (status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR'),
        message: status === 504 ? '请求超时，请稍后重试' : status === 503 ? '服务暂不可用' : '服务器内部错误',
        correlationId,
      },
    };
  }
  if (err?.type === 'entity.parse.failed') {
    return { error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON', correlationId } };
  }
  if (err?.type === 'entity.too.large') {
    return { error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体超过大小限制', correlationId } };
  }
  if (err?.code === 'ORIGIN_NOT_ALLOWED') {
    return { error: { code: 'ORIGIN_NOT_ALLOWED', message: '来源不受信任', correlationId } };
  }
  return {
    error: {
      code: safeErrorCode(err?.code, 'BAD_REQUEST'),
      message: typeof err?.message === 'string' ? err.message : '请求无效',
      ...(typeof err?.hint === 'string' ? { hint: err.hint } : {}),
      ...(typeof err?.field === 'string' ? { field: err.field } : {}),
      correlationId,
    },
  };
}

function websocketErrorBody(err: any, correlationId: string): Record<string, unknown> {
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return {
      type: 'error',
      code: safeErrorCode(err?.code, 'BAD_REQUEST'),
      message: typeof err?.message === 'string' ? err.message : '请求无效',
      correlationId,
    };
  }
  return { type: 'error', code: 'AGENT_ERROR', message: 'Agent 运行失败', correlationId };
}

export interface GatewayInstance {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  config: GatewayConfig;
  store: Store;
  manager: ConnectionManager;
  events: GatewayEvents;
  host: AgentHost;
  skills: SkillStore;
  skillWorker: SkillWorker;
  commands: CommandRunner;
  scheduler: JobScheduler;
  metrics: GatewayMetrics;
  close: () => Promise<void>;
}

export async function createGateway(overrides: Partial<GatewayConfig> = {}): Promise<GatewayInstance> {
  const config = loadConfig(overrides);
  // 契约与命令注册表在启动时自检：声明了不存在的工具、风险写错、章节缺失都当场失败，
  // 而不是等到某个功能被调用时才暴露。
  assertCapabilities(CAPABILITIES, TOOLS);
  assertCommandDefinitions();
  const store = new Store(config.dbPath, config.secret);
  const metrics = new GatewayMetrics();
  const alerts = new AlertSender(config);
  const recovered = store.recoverInterrupted();
  const recoveredCount = recovered.turns + recovered.sessions + recovered.jobs + recovered.artifactRuns + recovered.artifacts + recovered.pipelineRuns + recovered.pipelines + recovered.dashboardCards + recovered.dashboardSchedules + recovered.artifactSchedules;
  if (recoveredCount > 0) {
    metrics.inc('aidb_runtime_recovered_total', {}, recoveredCount);
    const first = recovered.interruptedTurns[0];
    const correlationId = currentCorrelationId();
    logGateway('warn', 'runtime_interrupted_work_recovered', {
      correlationId, instanceId: config.instanceId, counts: {
        turns: recovered.turns, sessions: recovered.sessions, jobs: recovered.jobs, artifactRuns: recovered.artifactRuns,
        artifacts: recovered.artifacts, pipelineRuns: recovered.pipelineRuns, pipelines: recovered.pipelines,
        dashboardCards: recovered.dashboardCards, dashboardSchedules: recovered.dashboardSchedules, artifactSchedules: recovered.artifactSchedules,
      },
    });
    alerts.notify({ type: 'interrupted_work_recovered', correlationId, turnId: first?.turnId, sessionId: first?.sessionId, counts: { recovered: recoveredCount } });
  }
  ensureDemoDatabase(config, store);
  seedBuiltinMcpServers(store);
  bindSearchStore(store);
  const events = new GatewayEvents();
  const manager = new ConnectionManager(store, config, () => store.getSettings(), events);
  const skills = new SkillStore(config.home);
  skills.seedBuiltins();
  const skillRunner = new SkillRunner(skills, config.home, (skillId, names) => store.getSkillSecrets(skillId, names));
  const executor = new ToolExecutor(store, manager, config, () => store.getSettings(), skills, skillRunner, events);
  const host = new AgentHost({ store, manager, executor, config, skills, metrics, alerts, logger: logGateway });
  const commands = new CommandRunner(store, manager, executor, config.home, config.exportDir, metrics, logGateway);
  const skillWorker = new SkillWorker(store, skills, skillRunner, executor);
  executor.setSkillWorker(skillWorker);
  const scheduler = new JobScheduler(store, manager, config, metrics, logGateway);
  scheduler.setPipelineRunner(async (pipelineIds, batchAt, signal, executionId) => {
    const onAbort = () => manager.cancelExecution(executionId);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfAborted(signal);
      if (store.getSettings().features.pipelines !== true) return { ok: 0, failed: pipelineIds.length, message: '数据流处理功能已在设置里关闭' };
      let ok = 0;
      let failed = 0;
      const parts: string[] = [];
      for (const id of pipelineIds) {
        throwIfAborted(signal);
        const pipeline = store.getPipeline(id);
        if (!pipeline) {
          failed += 1;
          parts.push('已删除的流水线：不存在');
          continue;
        }
        try {
          const run = await runPipelineAndRecord({ store, manager, config }, pipeline, { trigger: 'scheduled', batchAt, signal, executionId });
          if (run.status === 'ok') {
            ok += 1;
            parts.push(`${pipeline.name}：${run.message ?? `${run.rowsOut ?? 0} 行`}`);
          } else {
            failed += 1;
            parts.push(`${pipeline.name}：失败（${run.error ?? '未知原因'}）`);
          }
        } catch (err: any) {
          throwIfAborted(signal);
          failed += 1;
          parts.push(`${pipeline.name}：${err?.message ?? '运行失败'}`);
        }
      }
      throwIfAborted(signal);
      return { ok, failed, message: `${ok}/${pipelineIds.length} 条成功｜${parts.join('；')}`.slice(0, 500) };
    } finally {
      signal.removeEventListener('abort', onAbort);
      manager.releaseExecution(executionId);
    }
  });
  const quarantinedArtifacts = new Set<string>();
  scheduler.setArtifactRunner(async (artifactId, signal) => {
    if (quarantinedArtifacts.has(artifactId)) {
      throw Object.assign(new Error('产物上一次定时运行取消后尚未安全结束'), { code: 'ARTIFACT_EXECUTION_QUARANTINED', status: 409 });
    }
    let runId: string | undefined;
    let quarantined = false;
    const onAbort = () => {
      if (runId) commands.cancel(runId);
    };
    try {
      signal.addEventListener('abort', onAbort, { once: true });
      throwIfAborted(signal);
      runId = commands.startArtifact(artifactId).id;
      const finished = await commands.waitForRun(runId);
      throwIfAborted(signal);
      return { ok: finished?.status === 'succeeded', message: finished?.error?.message ?? finished?.status ?? '未完成' };
    } catch (err: any) {
      if (signal.aborted) {
        quarantined = true;
        throwIfAborted(signal);
      }
      return { ok: false, message: err?.message ?? '定时运行失败' };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (quarantined && runId) {
        quarantinedArtifacts.add(artifactId);
        try {
          // cancel() 会先结算 waitForRun，但底层 execute 可能仍在写盘/访问数据库。
          // 只有真正的执行 promise 结算后才解除隔离，迟到工作不能穿透到下一次运行。
          await commands.waitForExecution(runId);
        } finally {
          quarantinedArtifacts.delete(artifactId);
        }
      }
    }
  });
  scheduler.start();
  scheduler.setDashboardRunner(async (connectionId, database, signal) => {
    const cards = store.listDashboardCards(connectionId, database);
    if (!cards.length) return { ok: true, message: '没有卡片' };
    const scheduledManager = {
      query: async (targetConnectionId: string, sql: string, options: Parameters<ConnectionManager['query']>[2]) => {
        throwIfAborted(signal);
        const executionId = randomUUID();
        const onAbort = () => manager.cancelExecution(executionId);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          return await manager.query(targetConnectionId, sql, { ...options, signal, executionId });
        } finally {
          signal.removeEventListener('abort', onAbort);
          manager.releaseExecution(executionId);
        }
      },
    } as unknown as ConnectionManager;
    const results = await refreshDashboardCards({ store, manager: scheduledManager, settings: store.getSettings(), cards });
    throwIfAborted(signal);
    const failed = results.filter((result) => result.status === 'error');
    return {
      ok: failed.length === 0,
      message: `${cards.length - failed.length}/${cards.length} 张卡片已刷新${failed.length ? `；失败：${failed[0].error}` : ''}`,
    };
  });

  const app = express();
  const origins = gatewayOrigins(config);
  app.disable('x-powered-by');
  // frame-ancestors 只能通过响应头生效（meta 里会被浏览器忽略），对 API 与静态页统一下发。
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    const incomingCorrelationId = req.get('x-correlation-id');
    const correlationId = incomingCorrelationId && CORRELATION_ID_PATTERN.test(incomingCorrelationId)
      ? incomingCorrelationId
      : randomUUID();
    res.locals.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    const json = res.json.bind(res);
    res.json = ((body: any) => {
      if (body && typeof body === 'object' && body.error && typeof body.error === 'object' && !Array.isArray(body.error)) {
        return json({ ...body, error: { ...body.error, correlationId: body.error.correlationId ?? correlationId } });
      }
      return json(body);
    }) as Response['json'];
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      delete req.headers['x-forwarded-for'];
      delete req.headers['x-forwarded-host'];
      delete req.headers['x-forwarded-proto'];
    }
    const started = process.hrtime.bigint();
    let logged = false;
    const logRequest = (event: string) => {
      if (logged) return;
      logged = true;
      logGateway('info', event, {
        correlationId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        remoteAddress: req.socket.remoteAddress,
      });
    };
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const labels = { method: req.method, status: String(res.statusCode), route };
      metrics.inc('aidb_http_requests_total', labels);
      metrics.observe('aidb_http_request_duration_ms', durationMs, labels);
      logRequest('http_request');
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        metrics.inc('aidb_http_requests_aborted_total', { method: req.method });
        logRequest('http_request_aborted');
      }
    });
    runWithCorrelation(correlationId, () => next());
  });
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, false);
        if (origins.has(origin)) return callback(null, true);
        callback(Object.assign(new Error('来源不受信任'), { code: 'ORIGIN_NOT_ALLOWED', status: 403 }));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
      exposedHeaders: ['X-Correlation-Id'],
      optionsSuccessStatus: 204,
    }),
  );
  app.use(express.json({ limit: '25mb' }));

  const pairCodes = new Map<string, { expiresAt: number }>();
  const mcpPairCodes = new Map<string, { expiresAt: number }>();
  app.use(
    '/api',
    createApiRouter({
      config,
      store,
      manager,
      host,
      commands,
      executor,
      skills,
      skillWorker,
      skillRunner,
      pairCodes,
      mcpPairCodes,
      scheduler,
      events,
      metrics,
      startedAt: Date.now(),
    }),
  );

  if (existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir, { index: 'index.html' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(join(config.staticDir, 'index.html'));
    });
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: '接口不存在', correlationId: res.locals.correlationId },
    });
  });

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const rawStatus = Number(err?.status);
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
    const correlationId = res.locals.correlationId;
    if (status >= 500) {
      logGateway('error', 'http_error', {
        correlationId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status,
        error: { name: err?.name, code: err?.code, message: err?.message },
      });
    }
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(httpErrorBody(err, correlationId));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin }, done) => {
      if (origin && !origins.has(origin)) {
        done(false, 403, 'Forbidden');
        return;
      }
      done(true);
    },
  });
  // ws 会把 http server 的 'error'（如监听时 EADDRINUSE）转发到自身；
  // 没有接收者就是未处理 error 事件，直接炸进程。退出决策在 index.ts 的 server 错误处理里。
  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') return;
    logGateway('error', 'websocket_server_error', { error: { name: err.name, code: err.code, message: err.message } });
  });

  const authorized = (token: string): AgentAccessContext | null => {
    if (!token) return null;
    if (safeEqual(token, config.token)) return { scope: 'admin', connectionIds: [] };
    const device = store.findDeviceByTokenHash(hashToken(token));
    if (!device || device.scope === 'mcp:readonly') return null;
    if (device.scope === 'admin') return { scope: 'admin', connectionIds: [] };
    return { scope: 'device', deviceId: device.id, connectionIds: store.listDeviceConnectionPermissions(device.id) };
  };
  const clientAccess = new Map<WebSocket, AgentAccessContext>();
  const clientTokens = new Map<WebSocket, string>();

  wss.on('connection', (ws: WebSocket, req) => {
    const correlationId = randomUUID();
    metrics.inc('aidb_websocket_connections_total');
    metrics.gauge('aidb_websocket_connections_active', wss.clients.size);
    logGateway('info', 'websocket_connected', { correlationId, remoteAddress: req.socket.remoteAddress });
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const access = authorized(token);
    if (!access) {
      ws.close(4401, 'unauthorized');
      return;
    }
    clientAccess.set(ws, access);
    clientTokens.set(ws, token);
    let lastSeen = Date.now();
    const turns = new Map<string, string>();
    const abortOwnedTurns = (): void => {
      // 断线/凭据失效属于传输层清理：仍只取消本连接登记的代次，但不受已失效设备 ACL 阻挡。
      for (const [sessionId, turnId] of turns) host.abort(sessionId, 'disconnected', turnId);
      turns.clear();
    };
    const terminate = (): void => {
      abortOwnedTurns();
      ws.terminate();
    };
    const send = (event: unknown) => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
        terminate();
        return;
      }
      try {
        ws.send(JSON.stringify(event));
        metrics.inc('aidb_websocket_messages_total', { direction: 'out' });
      } catch {
        terminate();
      }
    };
    const reauthorize = (): AgentAccessContext | null => {
      const current = authorized(token);
      if (current) {
        clientAccess.set(ws, current);
        return current;
      }
      send({ type: 'error', code: 'UNAUTHORIZED', message: '访问令牌无效、已过期或已吊销', correlationId });
      try {
        abortOwnedTurns();
      } finally {
        clientAccess.delete(ws);
        clientTokens.delete(ws);
        ws.close(4401, 'unauthorized');
      }
      return null;
    };
    const heartbeat = setInterval(() => {
      if (ws.readyState !== 1) return;
      if (Date.now() - lastSeen >= WS_DEAD_AFTER_MS) {
        terminate();
        return;
      }
      send({ type: 'ping' });
    }, 30000);
    ws.on('close', (code) => {
      clearInterval(heartbeat);
      clientAccess.delete(ws);
      clientTokens.delete(ws);
      abortOwnedTurns();
      metrics.gauge('aidb_websocket_connections_active', wss.clients.size);
      logGateway('info', 'websocket_closed', { correlationId, code });
    });
    ws.on('error', (err) => {
      clientAccess.delete(ws);
      clientTokens.delete(ws);
      metrics.inc('aidb_websocket_errors_total');
      logGateway('error', 'websocket_error', { correlationId, error: { name: err.name, code: (err as NodeJS.ErrnoException).code, message: err.message } });
    });
    ws.on('message', (raw, isBinary) => {
      lastSeen = Date.now();
      metrics.inc('aidb_websocket_messages_total', { direction: 'in' });
      void runWithCorrelation(correlationId, () => (async () => {
        const byteLength = Buffer.isBuffer(raw)
          ? raw.byteLength
          : raw instanceof ArrayBuffer ? raw.byteLength : raw.reduce((total, part) => total + part.byteLength, 0);
        if (isBinary || byteLength > WS_MAX_PAYLOAD_BYTES) {
          send({ type: 'error', code: isBinary ? 'BAD_MESSAGE' : 'PAYLOAD_TOO_LARGE', message: isBinary ? '仅支持文本消息' : '消息超过大小限制', correlationId });
          ws.close(1009, isBinary ? 'binary_not_supported' : 'payload_too_large');
          return;
        }
        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8') : Buffer.concat(raw).toString('utf8');
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          send({ type: 'error', code: 'BAD_MESSAGE', message: '消息不是合法 JSON', correlationId });
          return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
          send({ type: 'error', code: 'BAD_MESSAGE', message: '消息格式无效', correlationId });
          return;
        }
        if (msg.type === 'ping') {
          send({ type: 'pong', correlationId });
          return;
        }
        if (msg.type === 'turn') {
          const currentAccess = reauthorize();
          if (!currentAccess) return;
          if (typeof msg.sessionId !== 'string' || !msg.sessionId) throw Object.assign(new Error('sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
          const sessionId = msg.sessionId;
          const previousTurnId = host.getTurnId(sessionId);
          let ownedTurnId: string | undefined;
          try {
            const running = host.startTurn(
              sessionId,
              {
                text: String(msg.text ?? ''),
                mode: msg.mode as PermissionMode | undefined,
                attachments: Array.isArray(msg.attachments) ? msg.attachments.filter((id: unknown): id is string => typeof id === 'string').slice(0, 16) : undefined,
                images: Array.isArray(msg.images) ? msg.images.filter((id: unknown): id is string => typeof id === 'string').slice(0, 4) : undefined,
                connectionId: typeof msg.connectionId === 'string' ? msg.connectionId : undefined,
                database: typeof msg.database === 'string' ? msg.database : undefined,
                ...(typeof msg.idempotencyKey === 'string' && msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : {}),
                disableMcp: true,
              },
              (event: AgentEvent) => send(event),
              currentAccess,
            );
            const turnId = host.getTurnId(sessionId);
            if (turnId && turnId !== previousTurnId) {
              ownedTurnId = turnId;
              turns.set(sessionId, turnId);
            }
            await running;
            send({ type: 'turn_end', correlationId });
          } catch (err: any) {
            send(websocketErrorBody(err, correlationId));
            send({ type: 'turn_end', correlationId });
          } finally {
            if (ownedTurnId && turns.get(sessionId) === ownedTurnId) turns.delete(sessionId);
          }
          return;
        }
        if (msg.type === 'abort') {
          const currentAccess = reauthorize();
          if (!currentAccess) return;
          const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
          const turnId = turns.get(sessionId);
          const ok = Boolean(turnId && host.abort(sessionId, 'user', turnId, currentAccess));
          send({ type: 'abort_ack', ok, correlationId });
          return;
        }
        if (msg.type === 'approval') {
          const currentAccess = reauthorize();
          if (!currentAccess) return;
          const approvalId = typeof msg.approvalId === 'string' ? msg.approvalId : '';
          const owner = host.getApprovalOwner(approvalId);
          const turnId = owner ? turns.get(owner.sessionId) : undefined;
          const ok = Boolean(
            owner?.turnId
            && turnId === owner.turnId
            && host.getTurnId(owner.sessionId) === owner.turnId
            && host.resolveApproval(
              approvalId,
              msg.decision === 'allow' ? 'allow' : 'deny',
              ['once', 'session', 'always'].includes(msg.scope) ? msg.scope : 'once',
              currentAccess,
            ),
          );
          send({ type: 'approval_ack', ok, correlationId });
          return;
        }
        send({ type: 'error', code: 'UNKNOWN_MESSAGE', message: '未知消息类型', correlationId });
      })()).catch((err: any) => {
        metrics.inc('aidb_websocket_errors_total');
        logGateway('error', 'websocket_message_error', { correlationId, error: { name: err?.name, code: err?.code, message: err?.message } });
        send(websocketErrorBody(err, correlationId));
      });
    });
  });

  const broadcast = (event: SchemaChangedEvent | ConnectionsChangedEvent) => {
    const frame = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const token = clientTokens.get(client);
      let access: AgentAccessContext | null | undefined;
      try {
        access = token === undefined ? undefined : authorized(token);
      } catch {
        continue;
      }
      if (!access) {
        clientAccess.delete(client);
        continue;
      }
      clientAccess.set(client, access);
      if (access.scope === 'device' && (!access.deviceId || !store.canDeviceAccessConnection(access.deviceId, event.connectionId))) continue;
      // G5：慢客户端积压超阈值直接丢弃，不能让它拖垮整条广播。
      if (client.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
        metrics.inc('aidb_websocket_backpressure_drops_total');
        client.terminate();
        continue;
      }
      // 逐项保护：一个半死的连接（send 抛错）不能中断后面客户端的投递，
      // 否则它前面的客户端刚收到、后面的一律收不到，症状取决于连接顺序。
      try {
        client.send(frame);
      } catch {
        /* 这个客户端已不可写；它自己的 onclose 会走清理。 */
      }
    }
  };

  // 结构与连接列表变更放在 WS 层广播；设备只接收其持久化 ACL 允许的连接。
  events.onSchemaChanged(broadcast);
  events.onConnectionsChanged(broadcast);

  // 局域网发现：仅当 Bridge 绑定到非回环地址时广播 _aidb._tcp，避免桌面内置桥误报。
  let bonjour: Bonjour | undefined;
  let mdnsService: { stop: (callback?: () => void) => void } | undefined;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopback && process.env.AIDB_MDNS !== '0') {
    try {
      bonjour = new Bonjour();
      mdnsService = bonjour.publish({
        name: `AiDB Studio ${hostname()}`,
        type: 'aidb',
        port: config.port,
        txt: { version: config.version },
      }) as unknown as { stop: (callback?: () => void) => void };
      logGateway('info', 'mdns_advertised', { service: '_aidb._tcp', host: config.host, port: config.port });
    } catch (err) {
      logGateway('warn', 'mdns_advertise_failed', { error: { name: (err as Error).name, message: (err as Error).message } });
    }
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      mdnsService?.stop();
      bonjour?.destroy();
      const drainingScheduler = scheduler.stop();
      shutdownMcpClients();
      // 先截断新传输和回合，再等取消真正收尾，最后才能销毁共享连接和 store。
      const closingTransports = new Promise<void>((resolve) => {
        wss.close(() => resolve());
        for (const client of wss.clients) client.terminate();
      });
      const closingServer = new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
      host.abortAll();
      await drainingScheduler;
      await host.waitIdle();
      await closingTransports;
      await closingServer;
      await manager.closeAll();
      store.close();
    })();
    return closing;
  };

  return { app, server, wss, config, store, manager, events, host, skills, skillWorker, commands, scheduler, metrics, close };
}
