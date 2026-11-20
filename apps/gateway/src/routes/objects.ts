import { Router } from 'express';
import { importDocuments } from '../services';
import {
  ah,
  str,
  obj,
  type ApiDeps,
} from './shared';

export function createObjectsRouter(deps: ApiDeps): Router {
  const { store, manager, config } = deps;
  const router = Router();

  router.post(
    '/vector/search',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      if (!connectionId || !collection) {
        throw Object.assign(new Error('connectionId 与 collection 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const vector = Array.isArray(body.vector) ? (body.vector as unknown[]).map(Number).filter((value) => Number.isFinite(value)) : undefined;
      const text = str(body.text);
      const field = str(body.field);
      const filter = body.filter && typeof body.filter === 'object' && !Array.isArray(body.filter) ? (body.filter as Record<string, unknown>) : undefined;
      const query = {
        language: 'vector' as const,
        collection,
        topK: Math.max(1, Math.min(1000, Number(body.topK) || 10)),
        op: body.op === 'scroll' ? ('scroll' as const) : undefined,
        ...(vector?.length ? { vector } : {}),
        ...(text ? { text } : {}),
        ...(field ? { field } : {}),
        ...(filter ? { filter } : {}),
      };
      const settings = store.getSettings();
      const started = Date.now();
      try {
        const result = await manager.vectorSearch(connectionId, query, {
          database: str(body.database),
          maxRows: query.topK,
          timeoutMs: settings.queryTimeoutMs,
          actor: 'user',
        });
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'vector.search',
          sql: JSON.stringify(query),
          risk: 'read',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'vector.search',
          sql: JSON.stringify(query),
          risk: 'read',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  const documentBatch = (body: Record<string, unknown>) => {
    const connectionId = str(body.connectionId);
    const collection = str(body.collection);
    if (!connectionId || !collection) {
      throw Object.assign(new Error('connectionId 与 collection 必填'), { code: 'INVALID_INPUT', status: 400 });
    }
    const raw = Array.isArray(body.documents) ? body.documents : body.document ? [body.document] : [];
    const documents = raw.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    );
    if (!documents.length) {
      throw Object.assign(new Error('document 或 documents 必须是非空 JSON 对象'), { code: 'INVALID_INPUT', status: 400 });
    }
    return { connectionId, collection, documents };
  };

  router.post(
    '/documents/upsert',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const { connectionId, collection, documents } = documentBatch(body);
      const database = str(body.database);
      const settings = store.getSettings();
      const started = Date.now();
      try {
        const result = await manager.writeDocuments(connectionId, { collection, documents }, { database, timeoutMs: settings.queryTimeoutMs, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.upsert',
          sql: JSON.stringify({ collection, count: result.upserted, ids: result.ids.slice(0, 5) }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.upsert',
          sql: JSON.stringify({ collection, count: documents.length }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/documents/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id).trim()).filter(Boolean) : [];
      if (!connectionId || !collection || !ids.length) {
        throw Object.assign(new Error('connectionId、collection 与非空 ids 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const settings = store.getSettings();
      const started = Date.now();
      try {
        const result = await manager.deleteDocuments(connectionId, { collection, ids }, { database, timeoutMs: settings.queryTimeoutMs, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.delete',
          sql: JSON.stringify({ collection, ids: ids.slice(0, 5), count: ids.length }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'documents.delete',
          sql: JSON.stringify({ collection, ids: ids.slice(0, 5), count: ids.length }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/documents/import',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      if (!connectionId || !collection) {
        throw Object.assign(new Error('connectionId 与 collection 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const csvText = str(body.csv);
      const started = Date.now();
      const summary = {
        collection,
        rows: csvText ? csvText.split('\n').filter((line: string) => line.trim()).length : undefined,
        path: str(body.path),
      };
      try {
        const result = await importDocuments(store, manager, config, connectionId, {
          collection,
          csv: str(body.csv),
          path: str(body.path),
          hasHeader: body.hasHeader !== false,
          delimiter: str(body.delimiter),
          idColumn: str(body.idColumn),
          vectorColumn: str(body.vectorColumn),
        });
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'documents.import',
          sql: JSON.stringify(summary),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
          meta: { imported: result.imported, skipped: result.skipped },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'documents.import',
          sql: JSON.stringify(summary),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/objects/drop',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const name = str(body.name);
      if (!connectionId || !name) {
        throw Object.assign(new Error('connectionId 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.dropObject(connectionId, name, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/fields/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const object = str(body.object);
      const name = str(body.name);
      if (!connectionId || !object || !name) {
        throw Object.assign(new Error('connectionId、object 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const type = str(body.type) || 'text';
      try {
        const result = await manager.createField(connectionId, { object, name, type }, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'fields.create',
          sql: JSON.stringify({ object, name, type }),
          risk: 'ddl',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'fields.create',
          sql: JSON.stringify({ object, name, type }),
          risk: 'ddl',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/indexes/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      const columns = Array.isArray(body.columns) ? (body.columns as unknown[]).map((column) => String(column ?? '')).filter(Boolean) : [];
      if (!connectionId || !collection || !columns.length) {
        throw Object.assign(new Error('connectionId、collection 与 columns 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const ttl = Number(body.expireAfterSeconds ?? 0);
      const spec = {
        collection,
        name: str(body.name) || undefined,
        columns,
        unique: body.unique === true,
        sparse: body.sparse === true,
        expireAfterSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : undefined,
        type: str(body.type) || undefined,
      };
      try {
        const result = await manager.createCollectionIndex(connectionId, spec, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.create',
          sql: JSON.stringify(spec),
          risk: 'ddl',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.create',
          sql: JSON.stringify(spec),
          risk: 'ddl',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/indexes/drop',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const collection = str(body.collection);
      const name = str(body.name);
      if (!connectionId || !collection || !name) {
        throw Object.assign(new Error('connectionId、collection 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.dropCollectionIndex(connectionId, { collection, name }, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.drop',
          sql: JSON.stringify({ collection, name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'indexes.drop',
          sql: JSON.stringify({ collection, name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.get(
    '/documents/get',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      const collection = str(req.query.collection);
      const id = str(req.query.id);
      if (!connectionId || !collection || !id) {
        throw Object.assign(new Error('connectionId、collection 与 id 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const detail = await manager.documentDetail(connectionId, { collection, id }, { database: str(req.query.database) });
      res.json({ detail });
    }),
  );

  router.get(
    '/redis/key',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      const key = str(req.query.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      const detail = await manager.keyDetail(connectionId, key, { database: str(req.query.database) });
      res.json({ detail });
    }),
  );

  router.post(
    '/influx/write',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const raw = typeof body.lines === 'string' ? body.lines.split(/\r?\n/) : Array.isArray(body.lines) ? body.lines.map(String) : [];
      const lines = raw.map((line) => line.trim()).filter(Boolean);
      if (!lines.length) throw Object.assign(new Error('lines 需要至少一行行协议'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      try {
        const result = await manager.writeLineProtocol(connectionId, lines, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'influx.write',
          sql: `write_lp ${result.written} 行`,
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { written: result.written },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'influx.write',
          sql: `write_lp ${lines.length} 行`,
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/list-item',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (typeof body.value !== 'string') throw Object.assign(new Error('value 需要是字符串'), { code: 'INVALID_INPUT', status: 400 });
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0) {
        throw Object.assign(new Error('index 需要是非负整数'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const value = body.value;
      try {
        const result = await manager.setListItem(connectionId, key, index, value, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.list-item',
          sql: JSON.stringify({ key, index }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.list-item',
          sql: JSON.stringify({ key, index }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/member',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const member = str(body.member);
      if (!connectionId || !key || !member) {
        throw Object.assign(new Error('connectionId、key 与 member 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const score = body.score === undefined || body.score === null || body.score === '' ? undefined : Number(body.score);
      if (score !== undefined && !Number.isFinite(score)) {
        throw Object.assign(new Error('score 需要是数字'), { code: 'INVALID_INPUT', status: 400 });
      }
      try {
        const result = await manager.addKeyMember(connectionId, key, member, { database, actor: 'user', score });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member',
          sql: JSON.stringify({ key, member, score }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { added: result.added },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member',
          sql: JSON.stringify({ key, member }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/member/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const member = str(body.member);
      if (!connectionId || !key || !member) {
        throw Object.assign(new Error('connectionId、key 与 member 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.removeKeyMember(connectionId, key, member, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member.delete',
          sql: JSON.stringify({ key, member }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          meta: { deleted: result.deleted, keyGone: result.keyGone },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.member.delete',
          sql: JSON.stringify({ key, member }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/hash/field',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const field = str(body.field);
      if (!connectionId || !key || !field) {
        throw Object.assign(new Error('connectionId、key 与 field 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (typeof body.value !== 'string') throw Object.assign(new Error('value 需要是字符串'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const value = body.value;
      try {
        const result = await manager.setHashField(connectionId, key, field, value, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field',
          sql: JSON.stringify({ key, field }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { created: result.created },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field',
          sql: JSON.stringify({ key, field }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/hash/field/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const field = str(body.field);
      if (!connectionId || !key || !field) {
        throw Object.assign(new Error('connectionId、key 与 field 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.deleteHashField(connectionId, key, field, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field.delete',
          sql: JSON.stringify({ key, field }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          meta: { deleted: result.deleted, keyGone: result.keyGone },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.hash.field.delete',
          sql: JSON.stringify({ key, field }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/value',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (typeof body.value !== 'string') throw Object.assign(new Error('value 需要是字符串'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const value = body.value;
      try {
        const result = await manager.setKeyValue(connectionId, key, value, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.value',
          sql: JSON.stringify({ key, bytes: value.length }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { ttl: result.ttl },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.value',
          sql: JSON.stringify({ key, bytes: value.length }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const type = str(body.type);
      if (!connectionId || !key || !type) {
        throw Object.assign(new Error('connectionId、key 与 type 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (!['string', 'hash', 'list', 'set', 'zset'].includes(type)) {
        throw Object.assign(new Error('type 需要是 string/hash/list/set/zset'), { code: 'INVALID_INPUT', status: 400 });
      }
      if (body.value === undefined) throw Object.assign(new Error('value 必填'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const ttl = body.ttl === null || body.ttl === undefined || body.ttl === '' ? null : Number(body.ttl);
      if (ttl !== null && (!Number.isFinite(ttl) || ttl < 1)) {
        throw Object.assign(new Error('ttl 需要是正整数秒，或 null 表示永不过期'), { code: 'INVALID_INPUT', status: 400 });
      }
      const input = { key, type: type as 'string' | 'hash' | 'list' | 'set' | 'zset', value: body.value, ttl };
      try {
        const result = await manager.createKey(connectionId, input, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.create',
          sql: JSON.stringify({ key, type }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { ttl: result.ttl },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.create',
          sql: JSON.stringify({ key, type }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/ttl',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      if (!connectionId || !key) throw Object.assign(new Error('connectionId 与 key 必填'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(body.database);
      const seconds = body.seconds === null || body.seconds === undefined || body.seconds === '' ? null : Number(body.seconds);
      if (seconds !== null && (!Number.isFinite(seconds) || seconds < 1)) {
        throw Object.assign(new Error('seconds 需要是正整数秒，或 null 表示移除过期'), { code: 'INVALID_INPUT', status: 400 });
      }
      try {
        const result = await manager.setKeyTtl(connectionId, key, seconds, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.ttl',
          sql: JSON.stringify({ key, seconds }),
          risk: 'write',
          approval: 'manual',
          status: 'ok',
          meta: { ttl: result.ttl },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.ttl',
          sql: JSON.stringify({ key, seconds }),
          risk: 'write',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/key/rename',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const key = str(body.key);
      const to = str(body.to);
      if (!connectionId || !key || !to) {
        throw Object.assign(new Error('connectionId、key 与 to 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.renameKey(connectionId, key, to, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.rename',
          sql: JSON.stringify({ from: key, to }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.key.rename',
          sql: JSON.stringify({ from: key, to }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/keys/delete',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const keys = Array.isArray(body.keys) ? (body.keys as unknown[]).map((key) => String(key ?? '')) : [];
      if (!connectionId || !keys.length) {
        throw Object.assign(new Error('connectionId 与 keys 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const sql = JSON.stringify({ keys: keys.slice(0, 5), count: keys.length });
      try {
        const result = await manager.deleteKeys(connectionId, keys, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.keys.delete',
          sql,
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
          meta: { deleted: result.deleted },
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.keys.delete',
          sql,
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/redis/index/drop',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const name = str(body.name);
      if (!connectionId || !name) {
        throw Object.assign(new Error('connectionId 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      try {
        const result = await manager.dropIndex(connectionId, name, { database, actor: 'user' });
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.index.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'redis.index.drop',
          sql: JSON.stringify({ name }),
          risk: 'destructive',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/objects/create',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const name = str(body.name);
      if (!connectionId || !name) {
        throw Object.assign(new Error('connectionId 与 name 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const settings = store.getSettings();
      const fields = Array.isArray(body.fields)
        ? (body.fields as Array<Record<string, unknown>>)
            .map((field) => ({ name: String(field.name ?? '').trim(), type: String(field.type ?? 'keyword').trim() }))
            .filter((field) => field.name)
        : [];
      try {
        const result = await manager.createObject(
          connectionId,
          {
            name,
            dimension: body.dimension === undefined || body.dimension === null || body.dimension === '' ? undefined : Number(body.dimension),
            distance: str(body.distance),
            fields,
            edge: body.edge === true,
          },
          { database, timeoutMs: settings.queryTimeoutMs, actor: 'user' },
        );
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.create',
          sql: JSON.stringify({ name, dimension: body.dimension, distance: str(body.distance), fields, edge: body.edge === true }),
          risk: 'ddl',
          approval: 'manual',
          status: 'ok',
        });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database,
          tool: 'objects.create',
          sql: JSON.stringify({ name, dimension: body.dimension, distance: str(body.distance), fields }),
          risk: 'ddl',
          approval: 'manual',
          status: 'error',
          meta: { error: err.message },
        });
        throw err;
      }
    }),
  );

  return router;
}
