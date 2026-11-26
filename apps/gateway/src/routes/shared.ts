import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { classifySql, engineMeta, engineUsesSchema, isSqlEngine, type ConnectionConfig } from '@aidb/core';
import type { GatewayEvents } from '../events';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import type { AgentHost } from '../agentHost';
import type { ToolExecutor } from '../executor';
import type { SkillStore } from '../skills';
import type { SkillWorker } from '../skillWorker';
import type { SkillRunner } from '../skillRunner';
import type { CommandRunner } from '../commands/runner';
import type { JobScheduler } from '../scheduler';
import type { GatewayMetrics } from '../observability';

/** 网关自身的监听地址（不读请求 Host）：MCP CLI 跑在本机，要的是能连上 gateway 的地址，
 *  不能被 Vite 代理带过来的前端 Host（如 localhost:5180）干扰。
 *  端口取内核实际分配的 localPort，兼容 AIDB_PORT=0 的动态端口场景。 */
export function mcpBridgeAddress(req: Request, config: GatewayConfig): { url: string; host: string; port: number } {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const port = Number(req.socket.localPort) || config.port;
  return { url: `http://${host}:${port}`, host, port };
}

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
  /** MCP 配对专用码池，与移动端 pairCodes 完全隔离，防止跨端点铸造凭据。 */
  mcpPairCodes: Map<string, { expiresAt: number }>;
  scheduler: JobScheduler;
  events: GatewayEvents;
  commands: CommandRunner;
  metrics: GatewayMetrics;
  startedAt: number;
}

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

export function requestExecution(manager: ConnectionManager, res: Response) {
  const controller = new AbortController();
  const executionId = randomUUID();
  const onAbort = () => manager.cancelExecution(executionId);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', onClose);
  return {
    executionId,
    signal: controller.signal,
    release: () => {
      res.removeListener('close', onClose);
      controller.signal.removeEventListener('abort', onAbort);
      manager.releaseExecution(executionId);
    },
  };
}

/**
 * SSE 背压护栏（G5）：write() 返回 false 说明缓冲区已满，不读流的慢客户端会让
 * 事件在网关内存里无限积压，超过 1MB 直接断开，由各处已有的 close 清理接管
 * （agent 回合中止、事件流退订）。未超阈值时保留连接，等 drain 自然恢复。
 */
const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;
export function sseWrite(res: Response, chunk: string): void {
  if (res.writableEnded || res.destroyed) return;
  const ok = res.write(chunk);
  if (!ok && res.writableLength > SSE_MAX_BUFFERED_BYTES) res.destroy();
}

/** K5：导出下载 URL。path 在 GET /export/file 里必须通过 exportDir 内的 resolve 校验。 */
export function exportDownloadUrl(filePath: string): string {
  return `/api/export/file?path=${encodeURIComponent(filePath)}`;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

export function obj(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

export function num(value: unknown, fallback: number, min: number, max: number): number {  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 部署形态参数只接受白名单字段；其余一律丢弃，避免把任意 JSON 写进连接配置。 */
export function connectionOptions(value: unknown): ConnectionConfig['options'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: NonNullable<ConnectionConfig['options']> = {};
  if (typeof raw.replicaSet === 'string' && raw.replicaSet.trim()) out.replicaSet = raw.replicaSet.trim();
  if (typeof raw.authSource === 'string' && raw.authSource.trim()) out.authSource = raw.authSource.trim();
  if (typeof raw.directConnection === 'boolean') out.directConnection = raw.directConnection;
  if (raw.redisMode === 'cluster' || raw.redisMode === 'standalone') out.redisMode = raw.redisMode;
  return out;
}

export function bearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function localIp(): string {
  const nets = require('node:os').networkInterfaces() as Record<string, Array<{ family: string; internal: boolean; address: string }> | undefined>;
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/**
 * 配对二维码与移动端提示要使用“客户端实际访问到的地址”。
 * 反代场景优先读取 Host / X-Forwarded-Proto；显式配置 AIDB_PUBLIC_URL 时以其为准。
 */
export function pairingOrigin(req: Request, config: GatewayConfig): { url: string; host: string; port: number } {
  const fallbackHost = config.host === '0.0.0.0' || config.host === '::' ? localIp() : config.host;
  const publicHost = req.get('x-forwarded-host') ?? req.get('host') ?? `${fallbackHost}:${config.port}`;
  const raw = config.publicUrl ?? `${req.protocol}://${publicHost}`;
  const parsed = new URL(raw);
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return { url: parsed.origin, host: parsed.hostname, port };
}

export function defaultSchema(conn: ConnectionConfig): string | undefined {
  if (!engineUsesSchema(conn.engine)) return undefined;
  if (conn.engine === 'sqlserver') return 'dbo';
  if (conn.engine === 'oracle') return (conn.username ?? '').toUpperCase();
  if (conn.engine === 'dm') return (conn.username ?? 'SYSDBA').toUpperCase();
  if (conn.engine === 'cassandra' || conn.engine === 'scylla') return conn.database || 'system';
  if (conn.engine === 'clickhouse') return conn.database ?? 'default';
  return 'public';
}

export function assertSqlEngine(conn: ConnectionConfig): void {
  if (isSqlEngine(conn.engine)) return;
  throw Object.assign(new Error(`${engineMeta(conn.engine).label} 不支持该功能`), {
    code: 'UNSUPPORTED_ENGINE',
    status: 400,
    hint: conn.engine === 'mongodb' ? 'MongoDB 请使用查询窗口的 MQL 或 Agent 的 run_mql' : 'Redis 请使用命令窗口或 Agent 的 run_redis',
  });
}

export function classifyForAudit(sql: string) {
  try {
    return classifySql(sql).risk;
  } catch {
    return undefined;
  }
}
