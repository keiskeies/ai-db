import { builtinMcpServer } from '@aidb/core';
import { callMcpTool, listMcpTools } from '../mcp';
import type { Store } from '../store';
import { defineTool, ok } from './types';

export const mcpListServersTool = defineTool('mcp_list_servers', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const includeDisabled = a.includeDisabled === true;
  const servers = s.store.listMcpServers().filter((server) => includeDisabled || server.enabled);
  return ok(started, `${servers.length} 个 MCP Server`, {
    servers: servers.map((server) => {
      const definition = server.builtin ? builtinMcpServer(server.builtin) : undefined;
      return {
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        builtin: definition?.kind ?? null,
        description: definition?.description,
        argsLabel: definition?.argsLabel,
        args: definition ? server.args : undefined,
        tools: definition?.tools.map((tool) => ({ name: tool.name, risk: tool.risk })),
      };
    }),
  });
});

export const mcpListToolsTool = defineTool('mcp_list_tools', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const { server, tools } = await listMcpTools(s.store, String(a.server ?? ''));
  return ok(started, `${server.name} 提供 ${tools.length} 个 MCP 工具`, {
    server,
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk })),
  });
});

export const mcpCallTool = defineTool('mcp_call', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  // 契约 K1：WP3 给 mcp client.call / callMcpTool 增加可选 { signal } 参数，
  // 上游中止时 MCP 调用随之取消。对方签名落地前直接传第五参会 typecheck
  // 失败，暂用断言放宽；运行时多余参数被忽略，集成后移除断言。
  const callWithSignal = callMcpTool as (
    store: Store,
    serverRef: string,
    tool: string,
    args?: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ) => ReturnType<typeof callMcpTool>;
  const { server, result } = await callWithSignal(s.store, String(a.server ?? ''), String(a.tool ?? ''), (a.arguments as Record<string, unknown>) ?? {}, { signal: ctx.signal });
  if (!result.ok) return result;
  return ok(started, `${server.name}.${String(a.tool)} · ${result.summary.slice(0, 200)}`, result.data);
});
