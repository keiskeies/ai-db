import { engineMeta } from '@aidb/core';
import { DuplicateConnectionError } from '../connectionProvisioner';
import { defineTool, ok } from './types';

export const probeEngineTool = defineTool('probe_engine', async (call, _ctx, s) => {
  const result = await s.connectionProvisioner.probe(call.args as { host: unknown; port: unknown; username: unknown; database?: unknown; ssl?: unknown; sslInsecure?: unknown });
  const target = `${result.host}:${result.port}`;
  const summary = result.outcome === 'connected'
    ? `${target} 可连接，识别为 ${engineMeta(result.recommendation!).label}${result.protocolMatches[0]?.version ? `（${result.protocolMatches[0].version}）` : ''}`
    : result.outcome === 'auth_failed'
      ? `${target} 协议已识别为 ${engineMeta(result.recommendation!).label}，但认证失败`
      : `${target} 未能识别数据库类型`;
  return ok(s.started, summary, result);
});

export const createConnectionTool = defineTool('create_connection', async (call, _ctx, s) => {
  try {
    const result = await s.connectionProvisioner.create(call.args);
    const connection = result.connection;
    const suffix = result.warning ? `；${result.warning}` : '';
    return ok(s.started, `已创建连接 ${connection.name}（${engineMeta(connection.engine).label} ${connection.host}:${connection.port}）${suffix}`, {
      connectionId: connection.id,
      name: connection.name,
      engine: connection.engine,
      tested: result.tested,
      version: result.version,
      warning: result.warning,
    });
  } catch (err) {
    if (err instanceof DuplicateConnectionError) {
      return {
        ok: false,
        summary: '连接已存在',
        error: { code: err.code, message: err.message, hint: `直接使用 connectionId=${err.connectionId}` },
        data: { existingConnectionId: err.connectionId },
        meta: { durationMs: Date.now() - s.started },
      };
    }
    throw err;
  }
});
