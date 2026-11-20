import { Router } from 'express';
import {
  TOOLS,
  encodeSse,
  getTool,
  isAgentContextActive,
  listProviderModels,
  resolveRisk,
  sseHeaders,
  suggestQuestions,
  tablesFromSql,
  type MemoryCandidate,
  type PermissionMode,
  type ProviderKind,
} from '@aidb/core';
import { readAttachment, saveAttachment } from '../attachments';
import type { AgentHost } from '../agentHost';
import {
  ah,
  sseWrite,
  str,
  obj,
  num,
  type ApiDeps,
} from './shared';

/** The outbound MCP bridge is for database reads; never expose the local MCP proxy (filesystem/web). */
const MCP_BRIDGE_EXCLUDED = new Set(['mcp_list_servers', 'mcp_list_tools', 'mcp_call']);

/**
 * 出站只读桥的工具白名单。不能只靠 tool.risk：memory_write / update_plan /
 * backup_database 等被（错误地）标成 risk='read'，但会写持久状态或落盘。
 * 这里只列真正「读数据、无副作用」的工具，作为 mcp:readonly 凭据的硬边界。
 */
const MCP_READONLY_TOOLS = new Set([
  'list_connections',
  'inspect_schema',
  'search_objects',
  'run_sql',            // 桥上仍由 resolveRisk 判定为 read 才放行
  'explain_sql',
  'sample_rows',
  'profile_column',
  'get_query_history',
  'analyze_chart',
  'forecast_chart',
  'render_chart',
  'schema_diff',
  'recon_data',
  'memory_search',
  'vector_search',
  'search_index',
  'run_mql',
  'run_redis',
  'run_cypher',
  'run_cql',
  'run_aql',
]);

export function createAgentRouter(deps: ApiDeps): Router {
  const { store, manager, host, config, executor } = deps;
  const router = Router();

  // ---------- agent ----------
  router.get('/agent/tools', (req, res) => {
    // 受限凭据永远只看到出站桥的工具目录，不能借省略 for=mcp 枚举全部 52 个工具。
    const forMcp = str(req.query.for) === 'mcp' || res.locals.mcpReadonly === true;
    if (forMcp && !store.getSettings().features.mcp) {
      res.status(403).json({ error: { code: 'FEATURE_DISABLED', message: 'MCP 已在设置中关闭' } });
      return;
    }
    const tools = res.locals.mcpReadonly === true
      ? TOOLS.filter((tool) => MCP_READONLY_TOOLS.has(tool.name) && !MCP_BRIDGE_EXCLUDED.has(tool.name))
      : forMcp
        ? TOOLS.filter((tool) => !MCP_BRIDGE_EXCLUDED.has(tool.name))
        : TOOLS;
    res.json({ tools });
  });

  router.post(
    '/agent/tools/:name',
    ah(async (req, res) => {
      if (!store.getSettings().features.mcp) {
        res.status(403).json({ error: { code: 'FEATURE_DISABLED', message: 'MCP 已在设置中关闭' } });
        return;
      }
      const name = req.params.name;
      if (MCP_BRIDGE_EXCLUDED.has(name)) {
        res.status(403).json({ error: { code: 'TOOL_NOT_EXPOSED', message: `出站 MCP 桥不暴露 ${name}；本地 MCP 工具只能在 AiDB 内使用` } });
        return;
      }
      const tool = getTool(name);
      if (!tool) {
        res.status(404).json({ error: { code: 'TOOL_NOT_FOUND', message: `工具不存在：${name}` } });
        return;
      }
      // mcp:readonly 配对凭据走显式白名单：risk 字段不可信（见 MCP_READONLY_TOOLS）。
      if (res.locals.mcpReadonly && !MCP_READONLY_TOOLS.has(name)) {
        res.status(403).json({ error: { code: 'TOOL_NOT_EXPOSED', message: `只读 MCP 凭据不允许调用 ${name}` } });
        return;
      }
      const body = obj(req.body, 'body');
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
      const call = { id: `http-${Date.now()}`, name, args };
      const riskConnId = typeof args.connectionId === 'string' ? args.connectionId
        : typeof body.connectionId === 'string' && body.connectionId ? body.connectionId : undefined;
      const risk = resolveRisk(call, tool, riskConnId ? store.getConnection(riskConnId)?.engine : undefined);
      if (risk !== 'read') {
        res.status(403).json({ error: { code: 'TOOL_READ_ONLY', message: `MCP 只读桥不允许执行 ${name}（风险 ${risk}）` } });
        return;
      }
      const result = await executor.execute(call, {
        sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'mcp',
        connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
        database: typeof body.database === 'string' ? body.database : undefined,
      });
      res.status(result.ok ? 200 : 400).json({ result });
    }),
  );

  /**
   * 图表卡一键解读/预测：合成 ToolCall 走执行器，统计与外推全部复用 analyze_chart / forecast_chart。
   * 不经过模型（零 token），审计、只读强制、500 行护栏与 Agent 工具调用完全一致。
   */
  router.post(
    '/agent/chart-insight',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const sql = str(body.sql);
      const mode = str(body.mode) ?? 'analyze';
      if (!connectionId || !sql) throw Object.assign(new Error('connectionId 与 sql 必填'), { code: 'INVALID_INPUT', status: 400 });
      if (mode !== 'analyze' && mode !== 'forecast') throw Object.assign(new Error('mode 只能是 analyze 或 forecast'), { code: 'INVALID_INPUT', status: 400 });
      const args: Record<string, unknown> = { sql };
      const x = str(body.x);
      const y = str(body.y);
      if (x) args.x = x;
      if (y) args.y = y;
      if (mode === 'forecast') {
        if (body.periods !== undefined) {
          const periods = Number(body.periods);
          if (!Number.isInteger(periods) || periods < 1 || periods > 12) throw Object.assign(new Error('periods 必须是 1..12 的整数'), { code: 'INVALID_INPUT', status: 400 });
          args.periods = periods;
        }
        if (body.method !== undefined) {
          const method = String(body.method);
          if (!['linear', 'moving_average', 'auto'].includes(method)) throw Object.assign(new Error('method 只能是 linear、moving_average 或 auto'), { code: 'INVALID_INPUT', status: 400 });
          args.method = method;
        }
      }
      const call = { id: `insight-${Date.now()}`, name: mode === 'analyze' ? 'analyze_chart' : 'forecast_chart', args };
      const result = await executor.execute(call, { sessionId: 'chart-insight', connectionId, database: str(body.database) });
      // 失败时顶层 error 与 result.error 同源：桌面 request() 只读顶层 error，人话提示不能丢。
      res.status(result.ok ? 200 : 400).json(result.ok ? { result } : { result, error: result.error });
    }),
  );

  router.post(
    '/agent/models',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const kind = String(body.kind ?? '') as ProviderKind;
      if (!['local', 'anthropic', 'openai', 'ollama'].includes(kind)) {
        throw Object.assign(new Error('未知的模型协议'), { code: 'INVALID_INPUT', status: 400 });
      }
      const stored = store.getSettings().agent;
      const configId = str(body.modelConfigId);
      const config = configId ? stored.modelConfigs?.find((item) => item.id === configId) : undefined;
      const apiKey =
        str(body.apiKey) ??
        (config ? store.getModelApiKey(config.id) : kind === stored.provider ? stored.apiKey : undefined);
      try {
        res.json(await listProviderModels({ kind, baseUrl: String(body.baseUrl ?? ''), apiKey }));
      } catch (err: any) {
        throw Object.assign(err, { status: Number(err?.status) || 400 });
      }
    }),
  );

  router.post(
    '/agent/attachments',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const attachment = await saveAttachment(config.attachmentDir, { mime: str(body.mime), base64: str(body.base64) });
      res.status(201).json({ attachment });
    }),
  );

  router.get(
    '/agent/attachments/:id',
    ah(async (req, res) => {
      const file = await readAttachment(config.attachmentDir, req.params.id);
      if (!file) {
        res.status(404).json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: '图片附件不存在或已被清理' } });
        return;
      }
      res.setHeader('cache-control', 'private, max-age=86400');
      res.contentType(file.mime);
      res.send(file.buffer);
    }),
  );

  // 不传参数时与旧行为完全一致（全量），前端按库过滤时带 connectionId / database
  router.get('/agent/sessions', (req, res) =>
    res.json({
      sessions: store.listSessions({
        connectionId: typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined,
        database: typeof req.query.database === 'string' ? req.query.database : undefined,
        archived: req.query.archived === '1',
      }),
    }),
  );
  router.post(
    '/agent/sessions',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const session = store.createSession({
        connectionId: str(body.connectionId),
        database: str(body.database),
        title: str(body.title),
        model: str(body.model),
        permissionMode: str(body.permissionMode) as PermissionMode | undefined,
      });
      res.status(201).json({ session });
    }),
  );

  router.get(
    '/agent/sessions/:id',
    ah(async (req, res) => {
      const session = store.getSession(req.params.id);
      if (!session) throw Object.assign(new Error('会话不存在'), { code: 'SESSION_NOT_FOUND', status: 404 });
      res.json({ session, messages: store.listMessages(session.id), toolRuns: store.listToolRuns(session.id) });
    }),
  );

  router.patch(
    '/agent/sessions/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const session = store.updateSession(req.params.id, {
        title: str(body.title),
        connectionId: body.connectionId === null ? undefined : str(body.connectionId),
        database: str(body.database),
        permissionMode: str(body.permissionMode) as PermissionMode | undefined,
        archived: body.archived === undefined ? undefined : Boolean(body.archived),
      });
      res.json({ session });
    }),
  );

  router.delete('/agent/sessions/:id', (req, res) => {
    host.forgetSessionApprovals(req.params.id);
    store.deleteSession(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/agent/sessions/:id/turns',
    ah(async (req, res) => {
      const sessionId = req.params.id;
      const session = store.getSession(sessionId);
      if (!session) throw Object.assign(new Error('会话不存在'), { code: 'SESSION_NOT_FOUND', status: 404 });
      if (host.isRunning(sessionId)) throw Object.assign(new Error('会话正在运行'), { code: 'SESSION_BUSY', status: 409 });
      const body = obj(req.body, 'body');
      res.writeHead(200, sseHeaders());
      res.flushHeaders?.();
      let finished = false;
      const heartbeat = setInterval(() => {
        if (!finished) sseWrite(res, ': ping\n\n');
      }, 15000);
      res.on('close', () => {
        if (!res.writableEnded) {
          finished = true;
          clearInterval(heartbeat);
          // 走到这里说明流是被**对端**掐的：客户端的静默上限、用户关页面、或半开连接。
          // 用户一次停止都没点过，所以记成 disconnected 而不是 user——回合结束时
          // 据此落续跑检查点（见 AgentHost.abortCauses）。
          host.abort(sessionId, 'disconnected');
        }
      });
      try {
        await host.startTurn(
          sessionId,
          {
            text: String(body.text ?? ''),
            mode: str(body.mode) as Parameters<AgentHost['startTurn']>[1]['mode'],
            attachments: Array.isArray(body.attachments) ? (body.attachments as string[]) : undefined,
            images: Array.isArray(body.images) ? (body.images as string[]).map(String).slice(0, 4) : undefined,
            connectionId: str(body.connectionId),
            database: str(body.database),
          },
          (event) => {
            if (!finished && !res.writableEnded) sseWrite(res, encodeSse(event));
          },
        );
      } catch (err: any) {
        if (!res.writableEnded) {
          sseWrite(res, encodeSse({ type: 'error', code: err?.code ?? 'AGENT_ERROR', message: err?.message ?? 'Agent 运行失败' }));
        }
      } finally {
        finished = true;
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    }),
  );

  router.post('/agent/sessions/:id/abort', (req, res) => {
    const ok = host.abort(req.params.id);
    res.json({ ok });
  });

  router.post('/agent/approvals/:id', (req, res) => {
    const body = obj(req.body, 'body');
    const decision = body.decision === 'allow' ? 'allow' : 'deny';
    const scope = ['once', 'session', 'always'].includes(String(body.scope)) ? (String(body.scope) as 'once' | 'session' | 'always') : 'once';
    const ok = host.resolveApproval(req.params.id, decision, scope);
    res.status(ok ? 200 : 404).json({ ok });
  });

  /** 同义词清洗：trim/去重/限长；坏条目丢弃而不是让整条记忆写入失败。 */
  const cleanSynonyms = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const text = item.trim().slice(0, 40);
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push(text);
      if (out.length >= 12) break;
    }
    return out;
  };

  router.get('/agent/memories', (req, res) => {
    res.json({
      memories: store.listMemories({
        q: str(req.query.q),
        kind: str(req.query.kind),
        scopeType: str(req.query.scopeType),
        includeArchived: req.query.includeArchived === '1',
        limit: num(req.query.limit, 200, 1, 500),
      }),
    });
  });

  router.post(
    '/agent/memories',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const title = str(body.title);
      const content = str(body.content);
      if (!title || !content) throw Object.assign(new Error('title 与 content 必填'), { code: 'INVALID_INPUT', status: 400 });
      const connectionId = str(body.connectionId);
      const candidate: MemoryCandidate = {
        kind: (str(body.kind) as MemoryCandidate['kind']) ?? 'fact',
        title,
        content,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        synonyms: cleanSynonyms(body.synonyms),
        importance: typeof body.importance === 'number' ? body.importance : 0.6,
        scopeType: str(body.scopeType) as MemoryCandidate['scopeType'],
        scopeKey: str(body.scopeKey),
      };
      const result = store.upsertMemoryCandidate(candidate, { connectionId, database: str(body.database) });
      res.status(201).json(result);
    }),
  );

  router.put(
    '/agent/memories/:id',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const memory = store.updateMemory(req.params.id, {
        title: str(body.title),
        content: str(body.content),
        kind: str(body.kind) as MemoryCandidate['kind'],
        importance: typeof body.importance === 'number' ? body.importance : undefined,
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        archived: typeof body.archived === 'boolean' ? body.archived : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        synonyms: cleanSynonyms(body.synonyms),
      });
      res.json({ memory });
    }),
  );

  router.delete('/agent/memories/:id', (req, res) => {
    store.deleteMemory(req.params.id);
    res.status(204).end();
  });

  /** 猜你想问：纯本地规则，不查库、不调模型，离线模式同样可用。 */
  router.get(
    '/agent/suggest',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const database = str(req.query.database);
      const limit = num(req.query.limit, 6, 1, 12);
      const locale = /^zh/i.test(String(req.query.locale ?? '')) ? 'zh' : 'en';
      const sessionId = str(req.query.sessionId);
      // 换一换：客户端累积传入已展示过的 prompt（可重复参数），上限 60 条防滥用。
      const excludeRaw = req.query.exclude;
      const exclude = (Array.isArray(excludeRaw) ? excludeRaw : excludeRaw ? [excludeRaw] : [])
        .map((v) => String(v).slice(0, 200))
        .filter(Boolean)
        .slice(0, 60);
      // 最近会话里真实问过的问题进入推荐问；排除当前会话，避免把刚问完的问题又推回来。
      let recentQuestions: string[] = [];
      try {
        recentQuestions = store
          .listSessions({ connectionId, limit: 8 })
          .filter((s) => s.id !== sessionId)
          .flatMap((s) => store.listMessages(s.id))
          .filter((m) => m.role === 'user' && m.content.trim())
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 30)
          .map((m) => m.content);
      } catch {
        recentQuestions = [];
      }
      // 建议只是锦上添花：连接还没选库（MySQL 常见）或库不可达时，返回空建议而不是 400，
      // 否则每次打开查询页都会在控制台留下一个失败请求。历史问题不依赖 schema，仍可推荐。
      let schemas: Awaited<ReturnType<typeof manager.schema>> = [];
      try {
        schemas = await manager.schema(connectionId, database);
      } catch {
        res.json({ suggestions: suggestQuestions([], { limit, recentQuestions, locale, exclude }) });
        return;
      }
      const history = store.listHistory({ connectionId, limit: 50 }).flatMap((h) => tablesFromSql(h.sql));
      res.json({
        suggestions: suggestQuestions(schemas, { limit, history, bundle: store.agentContextBundle(connectionId, database), locale, recentQuestions, exclude }),
      });
    }),
  );

  // ---------- agent business context ----------
  router.get('/agent/context', (req, res) => {
    const connectionId = str(req.query.connectionId);
    if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
    const database = str(req.query.database) ?? '';
    const entries = store.listAgentContext(connectionId, database);
    const bundle = store.agentContextBundle(connectionId, database);
    res.json({ entries, bundle, active: isAgentContextActive(bundle) });
  });

  router.put('/agent/context/entry', (req, res) => {
    const body = obj(req.body, 'body');
    const connectionId = str(body.connectionId);
    const table = str(body.table);
    const kindRaw = str(body.kind) ?? 'table';
    if (!connectionId || !table) throw Object.assign(new Error('connectionId 与 table 必填'), { code: 'INVALID_INPUT', status: 400 });
    if (kindRaw !== 'table' && kindRaw !== 'column') throw Object.assign(new Error('kind 只能是 table 或 column'), { code: 'INVALID_INPUT', status: 400 });
    const entry = store.upsertAgentContextEntry({
      connectionId,
      database: str(body.database) ?? '',
      kind: kindRaw,
      table,
      column: str(body.column),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      alias: body.alias === null ? null : str(body.alias),
      description: body.description === null ? null : str(body.description),
    });
    res.json({ entry });
  });

  router.put('/agent/context/relation', (req, res) => {
    const body = obj(req.body, 'body');
    const connectionId = str(body.connectionId);
    const table = str(body.table);
    const column = str(body.column);
    const refTable = str(body.refTable);
    const refColumn = str(body.refColumn);
    if (!connectionId || !table || !column || !refTable || !refColumn) {
      throw Object.assign(new Error('connectionId、table、column、refTable、refColumn 均必填'), { code: 'INVALID_INPUT', status: 400 });
    }
    const entry = store.upsertAgentRelation({
      connectionId,
      database: str(body.database) ?? '',
      table,
      column,
      refTable,
      refColumn,
      description: body.description === null ? null : str(body.description),
    });
    res.json({ entry });
  });

  router.post('/agent/context/bulk', (req, res) => {
    const body = obj(req.body, 'body');
    const connectionId = str(body.connectionId);
    if (!connectionId || !Array.isArray(body.tables)) {
      throw Object.assign(new Error('connectionId 与 tables[] 必填'), { code: 'INVALID_INPUT', status: 400 });
    }
    const tables = (body.tables as unknown[]).map(String).slice(0, 2000);
    const touched = store.bulkSetAgentContextTables({
      connectionId,
      database: str(body.database) ?? '',
      tables,
      enabled: body.enabled !== false,
    });
    res.json({ touched });
  });

  router.delete('/agent/context/entry/:id', (req, res) => {
    store.deleteAgentContext(req.params.id);
    res.status(204).end();
  });

  /** 清空某个连接（可选某个库）的全部业务上下文配置，回到「未配置」的默认行为。 */
  router.delete('/agent/context', (req, res) => {
    const connectionId = str(req.query.connectionId);
    if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
    const removed = store.clearAgentContext(connectionId, str(req.query.database));
    res.json({ removed });
  });

  return router;
}
