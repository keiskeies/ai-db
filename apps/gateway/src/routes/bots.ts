import { Router } from 'express';
import { handleBotEvent } from '../bots';
import {
  ah,
  type ApiDeps,
} from './shared';

export function createBotsRouter(deps: ApiDeps): Router {
  const { store, host } = deps;
  const router = Router();

  router.post(
    '/bots/:id/events',
    ah(async (req, res) => {
      try {
        const result = await handleBotEvent(store, host, req.params.id, req.body, req.headers);
        if (result.headers) res.set(result.headers);
        res.status(result.status).json(result.body);
      } catch {
        // 回调是公开入口：配置解密/存储等内部异常不能回传堆栈、SQL 或密钥原文。
        res.status(500).json({ error: 'bot event processing failed' });
      }
    }),
  );

  return router;
}
