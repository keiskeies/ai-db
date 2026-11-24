import { engineMeta, writesLineProtocol } from '@aidb/core';
import { DbError } from '../drivers';
import { importDocuments } from '../services';
import { defineTool, ok } from './types';

export const createCollectionTool = defineTool('create_collection', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const name = String(a.name ?? '').trim();
  if (!name) throw new DbError('name 不能为空', { code: 'OBJECT_NAME' });
  const fields = Array.isArray(a.fields)
    ? (a.fields as Array<Record<string, unknown>>).map((field) => ({
        name: String(field.name ?? '').trim(),
        type: String(field.type ?? 'keyword').trim(),
      }))
    : [];
  const settings = s.getSettings();
  const result = await s.manager.createObject(
    conn.id,
    {
      name,
      dimension: a.dimension === undefined ? undefined : Number(a.dimension),
      distance: typeof a.distance === 'string' ? a.distance : undefined,
      fields,
      edge: a.edge === true,
    },
    {
      database: s.databaseOf(call, conn),
      timeoutMs: settings.queryTimeoutMs,
      actor: 'agent',
      executionId: ctx.executionId,
      signal: ctx.signal,
    },
  );
  const kindLabel = result.kind === 'index' ? '索引' : result.kind === 'edge_label' ? '边集合' : '集合';
  return ok(started, `已创建${kindLabel} ${result.name}`, result);
});

export const deleteCollectionTool = defineTool('delete_collection', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const name = String(a.name ?? '').trim();
  if (!name) throw new DbError('name 不能为空', { code: 'OBJECT_NAME' });
  if (String(a.confirm ?? '') !== name) {
    throw new DbError('删除集合需要 confirm 与 name 完全一致', { code: 'CONFIRM_REQUIRED', hint: '先向用户确认影响范围，再带上 confirm 重试' });
  }
  const result = await s.manager.dropObject(conn.id, name, {
    database: s.databaseOf(call, conn),
    timeoutMs: s.getSettings().queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, `已删除集合 ${result.name}`, result);
});

export const upsertDocumentTool = defineTool('upsert_document', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const collection = String(a.collection ?? '').trim();
  if (!collection) throw new DbError('collection 不能为空', { code: 'WRITE_COLLECTION' });
  const raw = Array.isArray(a.documents) ? a.documents : a.document ? [a.document] : [];
  const documents = raw.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
  if (!documents.length) throw new DbError('document 或 documents 必须是非空 JSON 对象', { code: 'WRITE_DOCUMENT' });
  const settings = s.getSettings();
  const result = await s.manager.writeDocuments(
    conn.id,
    { collection, documents },
    {
      database: s.databaseOf(call, conn),
      timeoutMs: settings.queryTimeoutMs,
      actor: 'agent',
      executionId: ctx.executionId,
      signal: ctx.signal,
    },
  );
  return ok(started, `写入 ${result.upserted} 条`, result);
});

export const writeLineProtocolTool = defineTool('write_line_protocol', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  if (!writesLineProtocol(conn.engine)) {
    throw new DbError(`${engineMeta(conn.engine).label} 不支持行协议写入`, {
      code: 'UNSUPPORTED_ENGINE',
      hint: '只有 InfluxDB 需要走行协议写入；其它引擎请用 run_sql / upsert_document',
    });
  }
  const raw = typeof a.lines === 'string' ? a.lines.split(/\r?\n/) : Array.isArray(a.lines) ? (a.lines as unknown[]).map(String) : [];
  const lines = raw.map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new DbError('lines 需要至少一行行协议', { code: 'WRITE_LINES' });
  const result = await s.manager.writeLineProtocol(conn.id, lines, {
    database: s.databaseOf(call, conn),
    timeoutMs: s.getSettings().queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, `写入 ${result.written} 行`, result);
});

export const importDocumentsTool = defineTool('import_documents', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const collection = String(a.collection ?? '').trim();
  if (!collection) throw new DbError('collection 不能为空', { code: 'WRITE_COLLECTION' });
  const csv = typeof a.csv === 'string' ? a.csv : undefined;
  const path = typeof a.path === 'string' ? a.path : undefined;
  if (!csv?.trim() && !path) throw new DbError('需要 csv 文本或本地文件路径', { code: 'EMPTY_CSV' });
  const result = await importDocuments(s.store, s.manager, s.config, conn.id, {
    collection,
    csv,
    path,
    hasHeader: a.hasHeader !== false,
    delimiter: typeof a.delimiter === 'string' ? a.delimiter : undefined,
    idColumn: typeof a.idColumn === 'string' ? a.idColumn : undefined,
    vectorColumn: typeof a.vectorColumn === 'string' ? a.vectorColumn : undefined,
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, `导入 ${result.imported} 条`, result);
});

export const deleteDocumentsTool = defineTool('delete_documents', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const collection = String(a.collection ?? '').trim();
  if (!collection) throw new DbError('collection 不能为空', { code: 'WRITE_COLLECTION' });
  const ids = Array.isArray(a.ids) ? a.ids.map((id) => String(id).trim()).filter(Boolean) : [];
  if (!ids.length) throw new DbError('ids 不能为空：删除必须给出明确 id 列表', { code: 'WRITE_IDS' });
  const settings = s.getSettings();
  const result = await s.manager.deleteDocuments(
    conn.id,
    { collection, ids },
    {
      database: s.databaseOf(call, conn),
      timeoutMs: settings.queryTimeoutMs,
      actor: 'agent',
      executionId: ctx.executionId,
      signal: ctx.signal,
    },
  );
  return ok(started, `删除 ${result.deleted} 条`, result);
});
