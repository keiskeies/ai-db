import { Router } from 'express';
import { validateBuiltinMcpArgs } from '../builtinMcp';
import { listMcpTools } from '../mcp';
import {
  ah,
  obj,
  type ApiDeps,
} from './shared';

export function createMcpRouter(deps: ApiDeps): Router {
  const { store } = deps;
  const router = Router();

  router.get('/mcp/servers', (_req, res) => {
    res.json({ servers: store.listMcpServers() });
  });

  router.post(
    '/mcp/servers',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const name = String(body.name ?? '').trim();
      const command = String(body.command ?? '').trim();
      if (!name || !command) throw Object.assign(new Error('name 与 command 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (/^builtin[:-]/i.test(name) || ['filesystem', 'git', 'web'].includes(name.toLowerCase())) {
        throw Object.assign(new Error('该名称保留给内置 MCP（filesystem / git / web），请换一个名称'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (command.startsWith('builtin:')) {
        throw Object.assign(new Error('内置 MCP 由系统预置，不能手动创建'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (store.listMcpServers().some((server) => server.name === name)) {
        throw Object.assign(new Error('MCP Server 名称已存在'), { code: 'INVALID_INPUT', status: 400 });
      }
      const args = Array.isArray(body.args) ? body.args.map(String) : [];
      const env = body.env && typeof body.env === 'object' ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : undefined;
      res.status(201).json({ server: store.createMcpServer({ name, command, args, env, enabled: body.enabled !== false }) });
    }),
  );

  router.put(
    '/mcp/servers/:id',
    ah(async (req, res) => {
      const current = store.getMcpServer(req.params.id);
      if (!current) throw Object.assign(new Error('MCP Server 不存在'), { code: 'MCP_SERVER_NOT_FOUND', status: 404 });
      const body = obj(req.body, 'body');
      if (current.builtin) {
        if (typeof body.command === 'string' && body.command.trim() !== current.command) {
          throw Object.assign(new Error('内置 MCP 的命令不可修改'), { code: 'INVALID_INPUT', status: 400 });
        }
        if (typeof body.name === 'string' && body.name.trim() !== current.name) {
          throw Object.assign(new Error('内置 MCP 的名称不可修改'), { code: 'INVALID_INPUT', status: 400 });
        }
      }
      const args = Array.isArray(body.args) ? body.args.map(String) : undefined;
      res.json({
        server: store.updateMcpServer(req.params.id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          command: typeof body.command === 'string' ? body.command : undefined,
          args: current.builtin && args ? validateBuiltinMcpArgs(current.builtin, args) : args,
          env: body.env && typeof body.env === 'object' ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        }),
      });
    }),
  );

  router.delete('/mcp/servers/:id', (req, res) => {
    const current = store.getMcpServer(req.params.id);
    if (current?.builtin) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: '内置 MCP 不能删除，请在列表中停用' } });
      return;
    }
    store.deleteMcpServer(req.params.id);
    res.status(204).end();
  });

  router.get(
    '/mcp/servers/:id/tools',
    ah(async (req, res) => {
      res.json(await listMcpTools(store, req.params.id));
    }),
  );

  return router;
}
