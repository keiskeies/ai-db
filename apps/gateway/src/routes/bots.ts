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
      const result = await handleBotEvent(store, host, req.params.id, req.body, req.headers);
      res.status(result.status).json(result.body);
    }),
  );

  return router;
}
