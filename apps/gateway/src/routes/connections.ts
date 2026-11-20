import { Router } from 'express';
import {
  engineDefaultPort,
  isEngine,
  type ConnectionConfig,
} from '@aidb/core';
import {
  ah,
  str,
  obj,
  connectionOptions,
  type ApiDeps,
} from './shared';

export function createConnectionsRouter(deps: ApiDeps): Router {
  const { store, manager, host } = deps;
  const router = Router();

  // ---------- connections ----------
  router.get('/connections', (_req, res) => res.json({ connections: store.listConnections() }));

  router.post(
    '/connections',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      if (!str(body.name)) throw Object.assign(new Error('连接名称不能为空'), { code: 'INVALID_INPUT', status: 400 });
      if (!isEngine(body.engine)) throw Object.assign(new Error('不支持的数据库类型'), { code: 'INVALID_ENGINE', status: 400 });
      const created = store.createConnection({
        name: String(body.name),
        engine: body.engine as ConnectionConfig['engine'],
        color: (str(body.color) as ConnectionConfig['color']) ?? 'blue',
        environment: (str(body.environment) as ConnectionConfig['environment']) ?? 'dev',
        groupName: str(body.groupName),
        host: str(body.host),
        port: body.port ? Number(body.port) : engineDefaultPort(body.engine as import('@aidb/core').Engine),
        database: str(body.database),
        username: str(body.username),
        password: str(body.password),
        sshPassword: str(body.sshPassword),
        sshPrivateKey: str(body.sshPrivateKey),
        ssl: Boolean(body.ssl),
        sslInsecure: Boolean(body.sslInsecure),
        authMode: body.authMode === 'apikey' ? 'apikey' : body.authMode === 'basic' ? 'basic' : undefined,
        options: connectionOptions(body.options),
        ssh: body.ssh as ConnectionConfig['ssh'],
        readonly: Boolean(body.readonly),
        note: str(body.note),
      });
      res.status(201).json({ connection: created });
    }),
  );

  router.put(
    '/connections/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      if (body.engine !== undefined && !isEngine(body.engine)) throw Object.assign(new Error('不支持的数据库类型'), { code: 'INVALID_ENGINE', status: 400 });
      const updated = store.updateConnection(req.params.id, {
        name: str(body.name),
        engine: str(body.engine) as ConnectionConfig['engine'] | undefined,
        color: str(body.color) as ConnectionConfig['color'] | undefined,
        environment: str(body.environment) as ConnectionConfig['environment'] | undefined,
        groupName: str(body.groupName),
        host: str(body.host),
        port: body.port === undefined ? undefined : Number(body.port),
        database: str(body.database),
        username: str(body.username),
        password: str(body.password),
        sshPassword: str(body.sshPassword),
        sshPrivateKey: str(body.sshPrivateKey),
        ssl: body.ssl === undefined ? undefined : Boolean(body.ssl),
        sslInsecure: body.sslInsecure === undefined ? undefined : Boolean(body.sslInsecure),
        authMode: body.authMode === 'apikey' ? 'apikey' : body.authMode === 'basic' ? 'basic' : body.authMode === undefined ? undefined : 'basic',
        options: body.options === undefined ? undefined : connectionOptions(body.options),
        ssh: body.ssh as ConnectionConfig['ssh'],
        readonly: body.readonly === undefined ? undefined : Boolean(body.readonly),
        note: str(body.note),
      });
      await manager.close(req.params.id);
      manager.invalidate(req.params.id);
      res.json({ connection: updated });
    }),
  );

  router.post(
    '/groups/rename',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const from = str(body.from);
      const to = str(body.to);
      if (!from || !to) throw Object.assign(new Error('from 与 to 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ renamed: store.renameGroup(from, to) });
    }),
  );

  router.post(
    '/groups/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const name = str(body.name);
      if (!name) throw Object.assign(new Error('name 必填'), { code: 'INVALID_INPUT', status: 400 });
      res.json({ moved: store.deleteGroup(name) });
    }),
  );

  router.delete(
    '/connections/:id',
    ah(async (req, res) => {
      await manager.close(req.params.id);
      store.deleteConnection(req.params.id);
      res.status(204).end();
    }),
  );

  router.post(
    '/connections/:id/test',
    ah(async (req, res) => {
      res.json({ result: await manager.testSaved(req.params.id) });
    }),
  );

  router.post(
    '/connections/test',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const now = new Date().toISOString();
      const conn: ConnectionConfig = {
        id: 'draft',
        name: str(body.name) ?? 'draft',
        engine: (str(body.engine) as ConnectionConfig['engine']) ?? 'sqlite',
        color: 'blue',
        environment: 'dev',
        groupName: '',
        host: str(body.host),
        port: body.port ? Number(body.port) : engineDefaultPort(body.engine as import('@aidb/core').Engine),
        database: str(body.database),
        username: str(body.username),
        ssl: Boolean(body.ssl),
        sslInsecure: Boolean(body.sslInsecure),
        authMode: body.authMode === 'apikey' ? 'apikey' : body.authMode === 'basic' ? 'basic' : undefined,
        options: connectionOptions(body.options),
        ssh: body.ssh as ConnectionConfig['ssh'],
        readonly: false,
        createdAt: now,
        updatedAt: now,
      };
      // 编辑已有连接时密钥框留空表示「沿用已存那份」：草稿测试也得回落到库里的 secret，
      // 否则「编辑 → 不动密码直接测试」会拿空密码去连，报一个表单里根本没体现的错。
      const savedId = str(body.id);
      const saved = savedId ? store.getConnectionSecret(savedId) : {};
      const result = await manager.testConfig(conn, {
        password: str(body.password) ?? saved.password,
        sshPassword: str(body.sshPassword) ?? (body.ssh as ConnectionConfig['ssh'])?.password ?? saved.sshPassword,
        sshPrivateKey: str(body.sshPrivateKey) ?? saved.sshPrivateKey,
        sshPassphrase: saved.sshPassphrase,
      });
      res.json({ result });
    }),
  );

  router.get(
    '/connections/:id/databases',
    ah(async (req, res) => {
      res.json({ databases: await manager.listDatabases(req.params.id) });
    }),
  );

  router.get(
    '/connections/:id/schema',
    ah(async (req, res) => {
      const schemas = await manager.schema(req.params.id, str(req.query.database), req.query.refresh === '1');
      res.json({ schemas });
    }),
  );

  router.get(
    '/connections/:id/tables',
    ah(async (req, res) => {
      const database = str(req.query.database);
      const schemas = await manager.schema(req.params.id, database);
      res.json({
        database: database ?? store.getConnection(req.params.id)?.database,
        tables: schemas.flatMap((s) => s.tables),
      });
    }),
  );

  router.post(
    '/connections/:id/refresh',
    ah(async (req, res) => {
      manager.invalidate(req.params.id);
      const schemas = await manager.schema(req.params.id, str((req.body as Record<string, unknown>)?.database), true);
      res.json({ schemas });
    }),
  );

  return router;
}
