import http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentEvent, PermissionMode } from '@aidb/core';
import { AgentHost } from './agentHost';
import { CommandRunner } from './commands/runner';
import { shutdownMcpClients } from './mcp';
import { SkillStore } from './skills';
import { SkillRunner } from './skillRunner';
import { SkillWorker } from './skillWorker';
import { hashToken, safeEqual } from './crypto';
import { loadConfig, type GatewayConfig } from './config';
import { ConnectionManager } from './manager';
import { ToolExecutor } from './executor';
import { ensureDemoDatabase } from './seed';
import { createApiRouter } from './routes';
import { JobScheduler } from './scheduler';
import { Store } from './store';

export interface GatewayInstance {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  config: GatewayConfig;
  store: Store;
  manager: ConnectionManager;
  host: AgentHost;
  skills: SkillStore;
  skillWorker: SkillWorker;
  commands: CommandRunner;
  scheduler: JobScheduler;
  close: () => Promise<void>;
}

export async function createGateway(overrides: Partial<GatewayConfig> = {}): Promise<GatewayInstance> {
  const config = loadConfig(overrides);
  const store = new Store(config.dbPath, config.secret);
  ensureDemoDatabase(config, store);
  const manager = new ConnectionManager(store, config, () => store.getSettings());
  const skills = new SkillStore(config.home);
  skills.seedBuiltins();
  const skillRunner = new SkillRunner(skills, config.home, (skillId, names) => store.getSkillSecrets(skillId, names));
  const executor = new ToolExecutor(store, manager, config, () => store.getSettings(), skills, skillRunner);
  const host = new AgentHost({ store, manager, executor, config, skills });
  const commands = new CommandRunner(store, manager, executor);
  const skillWorker = new SkillWorker(store, skills, skillRunner, executor);
  executor.setSkillWorker(skillWorker);
  const scheduler = new JobScheduler(store, manager, config);
  scheduler.setArtifactRunner(async (artifactId) => {
    try {
      const run = commands.startArtifact(artifactId);
      const finished = await commands.waitForRun(run.id);
      return { ok: finished?.status === 'succeeded', message: finished?.error?.message ?? finished?.status ?? '未完成' };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? '定时运行失败' };
    }
  });
  scheduler.start();

  const app = express();
  app.disable('x-powered-by');
  app.use(
    cors({
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '25mb' }));

  const pairCodes = new Map<string, { expiresAt: number }>();
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
      scheduler,
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
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error('[gateway]', err);
    res.status(status).json({
      error: {
        code: err?.code ?? 'INTERNAL_ERROR',
        message: err?.message ?? '服务器内部错误',
        hint: err?.hint,
        field: err?.field,
      },
    });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const authorized = (token: string): boolean => {
    if (!token) return false;
    if (safeEqual(token, config.token)) return true;
    return Boolean(store.findDeviceByTokenHash(hashToken(token)));
  };

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    if (!authorized(token)) {
      ws.close(4401, 'unauthorized');
      return;
    }
    const send = (event: unknown) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(event));
    };
    const heartbeat = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
    ws.on('close', () => clearInterval(heartbeat));
    ws.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send({ type: 'error', code: 'BAD_MESSAGE', message: '消息不是合法 JSON' });
        return;
      }
      if (msg.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      if (msg.type === 'turn') {
        try {
          await host.startTurn(
            String(msg.sessionId),
            {
              text: String(msg.text ?? ''),
              mode: msg.mode as PermissionMode | undefined,
              attachments: Array.isArray(msg.attachments) ? (msg.attachments as string[]) : undefined,
              connectionId: typeof msg.connectionId === 'string' ? msg.connectionId : undefined,
            },
            (event: AgentEvent) => send(event),
          );
          send({ type: 'turn_end' });
        } catch (err: any) {
          send({ type: 'error', code: err?.code ?? 'AGENT_ERROR', message: err?.message ?? 'Agent 运行失败' });
          send({ type: 'turn_end' });
        }
        return;
      }
      if (msg.type === 'abort') {
        send({ type: 'abort_ack', ok: host.abort(String(msg.sessionId)) });
        return;
      }
      if (msg.type === 'approval') {
        const ok = host.resolveApproval(String(msg.approvalId), msg.decision === 'allow' ? 'allow' : 'deny', ['once', 'session', 'always'].includes(msg.scope) ? msg.scope : 'once');
        send({ type: 'approval_ack', ok });
        return;
      }
      send({ type: 'error', code: 'UNKNOWN_MESSAGE', message: `未知消息类型：${msg.type}` });
    });
  });

  const close = async (): Promise<void> => {
    scheduler.stop();
    shutdownMcpClients();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
      for (const client of wss.clients) client.terminate();
    });
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    await manager.closeAll();
    store.close();
  };

  return { app, server, wss, config, store, manager, host, skills, skillWorker, commands, scheduler, close };
}
