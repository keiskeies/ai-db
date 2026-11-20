import { looksLikeSecret, type MemoryCandidate } from '@aidb/core';
import { DbError } from '../drivers';
import { defineTool, ok } from './types';

export const updatePlanTool = defineTool('update_plan', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  return ok(started, '计划已更新', { items: a.items ?? [] });
});

export const memoryWriteTool = defineTool('memory_write', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.connectionIdOf(call, ctx) ? s.store.getConnection(s.connectionIdOf(call, ctx)!) : undefined;
  const title = String(a.title ?? '').trim();
  const content = String(a.content ?? '').trim();
  const kind = String(a.kind ?? 'fact') as MemoryCandidate['kind'];
  if (!title || !content) throw new DbError('title 与 content 不能为空');
  if (!['fact', 'preference', 'schema', 'procedural'].includes(kind)) throw new DbError('不支持的记忆类型');
  if (looksLikeSecret(`${title} ${content}`)) throw new DbError('疑似包含密钥或凭据，拒绝写入记忆', { code: 'SECRET_REJECTED' });
  const scopeType = ['global', 'connection', 'database', 'table'].includes(String(a.scopeType)) ? (String(a.scopeType) as MemoryCandidate['scopeType']) : undefined;
  let scopeKey = typeof a.scopeKey === 'string' ? a.scopeKey : undefined;
  if (scopeType === 'table' && scopeKey && conn && !scopeKey.includes('/')) scopeKey = `${conn.id}/${scopeKey}`;
  if (scopeType === 'database' && scopeKey && conn && !scopeKey.includes('/')) scopeKey = `${conn.id}/${scopeKey}`;
  const candidate: MemoryCandidate = {
    kind,
    title,
    content,
    tags: Array.isArray(a.tags) ? (a.tags as string[]).map(String) : undefined,
    importance: typeof a.importance === 'number' ? a.importance : 0.65,
    scopeType,
    scopeKey,
  };
  const { memory, merged } = s.store.upsertMemoryCandidate(candidate, {
    connectionId: conn?.id,
    database: s.databaseOf(call, conn ?? {}),
    sessionId: ctx.sessionId,
  });
  return ok(started, `已记住：${memory.title}（${merged ? '已合并相近记忆' : '新记忆'}）`, { memory, merged });
});

export const memorySearchTool = defineTool('memory_search', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.connectionIdOf(call, ctx) ? s.store.getConnection(s.connectionIdOf(call, ctx)!) : undefined;
  const memories = s.store.searchMemories(String(a.query ?? ''), {
    connectionId: conn?.id,
    database: s.databaseOf(call, conn ?? {}),
    limit: Math.min(20, Number(a.limit) || 8),
  });
  return ok(started, `检索到 ${memories.length} 条记忆`, { memories });
});
