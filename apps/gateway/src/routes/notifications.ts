import { Router } from 'express';
import {
  type NotificationChannelType,
} from '@aidb/core';
import { channelSummary, sendNotification, validateNotificationChannel } from '../notifications';
import {
  ah,
  obj,
  type ApiDeps,
} from './shared';

export function createNotificationsRouter(deps: ApiDeps): Router {
  const { store, config } = deps;
  const router = Router();

  router.get('/notifications/channels', (_req, res) => {
    res.json({ channels: store.listNotificationChannels() });
  });

  router.post(
    '/notifications/channels',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const type = String(body.type ?? '') as NotificationChannelType;
      const allowedTypes: NotificationChannelType[] = ['feishu', 'wecom', 'qq-onebot', 'dingtalk', 'slack', 'discord', 'telegram'];
      if (!allowedTypes.includes(type)) {
        throw Object.assign(new Error('type 必须是 feishu / wecom / qq-onebot / dingtalk / slack / discord / telegram'), { code: 'INVALID_INPUT', status: 400 });
      }
      const name = String(body.name ?? '').trim();
      if (!name) throw Object.assign(new Error('name 必填'), { code: 'INVALID_INPUT', status: 400 });
      const config = body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : {};
      validateNotificationChannel(type, config);
      res.status(201).json({
        channel: store.createNotificationChannel({ name, type, config, summary: channelSummary(type, config), enabled: body.enabled !== false }),
      });
    }),
  );

  router.put(
    '/notifications/channels/:id',
    ah(async (req, res) => {
      const existing = store.getNotificationChannel(req.params.id);
      if (!existing) throw Object.assign(new Error('通知渠道不存在'), { code: 'CHANNEL_NOT_FOUND', status: 404 });
      const body = obj(req.body, 'body');
      const config = body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : undefined;
      if (config) validateNotificationChannel(existing.type, config);
      res.json({
        channel: store.updateNotificationChannel(req.params.id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          config,
          summary: config ? channelSummary(existing.type, config) : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        }),
      });
    }),
  );

  router.delete('/notifications/channels/:id', (req, res) => {
    store.deleteNotificationChannel(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/notifications/channels/:id/test',
    ah(async (req, res) => {
      res.json({ result: await sendNotification(store, req.params.id, '【AiDB Studio】通知渠道测试消息') });
    }),
  );

  return router;
}
