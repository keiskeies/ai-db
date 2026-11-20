import { Router, type Request, type Response } from 'express';
import { pairingCode, hashToken, randomToken } from '../crypto';
import {
  ah,
  str,
  obj,
  pairingOrigin,
  mcpBridgeAddress,
  type ApiDeps,
} from './shared';

/** 配对码有效期：60 秒，桌面端显示倒计时。移动端与 MCP 共用同一窗口。 */
const PAIR_CODE_TTL_MS = 60_000;
const PAIR_CODE_TTL_SECONDS = PAIR_CODE_TTL_MS / 1000;

export function createPairingRouter(deps: ApiDeps): Router {
  const { store, host, config } = deps;
  const router = Router();
  const pairHits = new Map<string, number[]>();
  const allowPairHit = (bucket: string, req: Request, limit: number, windowMs: number): boolean => {
    // 不能用 req.ip：server.ts 设了 trust proxy=true，客户端可用 X-Forwarded-For 伪造它绕过限流。
    // socket.remoteAddress 是 TCP 层真实来源，不可由请求头控制。
    const ip = req.socket.remoteAddress || 'unknown';
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const hits = (pairHits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (hits.length >= limit) {
      pairHits.set(key, hits);
      return false;
    }
    hits.push(now);
    pairHits.set(key, hits);
    return true;
  };
  const pairRateLimited = (res: Response, seconds: number): void => {
    res.setHeader('Retry-After', String(seconds));
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } });
  };
  // ---------- pairing ----------
  // 移动端与 MCP 是两条完全隔离的链路：独立端点、独立码池、scope 由服务端硬编码。
  // 调用方无法通过 body.scope 铸造另一种凭据，码也不能跨端点兑换。
  function startPair(pool: Map<string, { expiresAt: number }>, bucket: string, withQr: boolean, forMcp = false) {
    return ah(async (req, res) => {
      if (!allowPairHit(bucket, req, 30, 60_000)) {
        pairRateLimited(res, 60);
        return;
      }
      const code = pairingCode();
      pool.set(code, { expiresAt: Date.now() + PAIR_CODE_TTL_MS });
      for (const [k, v] of pool) if (v.expiresAt < Date.now()) pool.delete(k);
      // 移动端二维码要「客户端实际访问到的地址」；MCP CLI 要网关自身监听地址。
      const origin = forMcp ? mcpBridgeAddress(req, config) : pairingOrigin(req, config);
      res.json({
        code,
        expiresIn: PAIR_CODE_TTL_SECONDS,
        ...(withQr ? { qrPayload: JSON.stringify({ v: 1, url: origin.url, host: origin.host, port: origin.port, code }) } : {}),
        host: origin.host,
        port: origin.port,
        url: origin.url,
      });
    });
  }

  function claimPair(pool: Map<string, { expiresAt: number }>, bucket: string, scope: 'full' | 'mcp:readonly', defaultName: string) {
    return ah(async (req, res) => {
      if (!allowPairHit(bucket, req, 10, 5 * 60_000)) {
        pairRateLimited(res, 300);
        return;
      }
      const body = obj(req.body, 'body');
      const code = String(body.code ?? '').trim();
      const entry = pool.get(code);
      if (!entry || entry.expiresAt < Date.now()) throw Object.assign(new Error('配对码无效或已过期'), { code: 'PAIR_INVALID', status: 401 });
      pool.delete(code);
      const token = randomToken(32);
      const device = store.createDevice({
        name: str(body.deviceName) ?? defaultName,
        platform: str(body.platform) ?? 'unknown',
        tokenHash: hashToken(token),
        scope,
      });
      const origin = pairingOrigin(req, config);
      res.json({
        token,
        device,
        bridge: { host: origin.host, port: origin.port, url: origin.url, version: config.version },
      });
    });
  }

  const mcpPairingEnabled = (res: Response): boolean => {
    if (store.getSettings().features.mcp) return true;
    res.status(403).json({ error: { code: 'FEATURE_DISABLED', message: 'MCP 已在设置中关闭' } });
    return false;
  };

  router.post('/pair/start', startPair(deps.pairCodes, 'start', true));
  router.post('/pair/claim', claimPair(deps.pairCodes, 'claim', 'full', '移动设备'));

  router.post('/pair/mcp/start', (req, res, next) => {
    if (!mcpPairingEnabled(res)) return;
    next();
  }, startPair(deps.mcpPairCodes, 'mcp-start', false, true));
  router.post('/pair/mcp/claim', (req, res, next) => {
    if (!mcpPairingEnabled(res)) return;
    next();
  }, claimPair(deps.mcpPairCodes, 'mcp-claim', 'mcp:readonly', 'MCP Client'));

  router.get('/devices', (_req, res) => res.json({ devices: store.listDevices() }));
  router.delete('/devices/:id', (req, res) => {
    store.revokeDevice(req.params.id);
    res.status(204).end();
  });

  return router;
}
