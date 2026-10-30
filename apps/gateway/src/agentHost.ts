import { randomUUID } from 'node:crypto';
import {
  activeReasoningTier,
  AgentRuntime,
  buildSystemPrompt,
  compactHistory,
  createProvider,
  extractHeuristicMemories,
  getModelProfile,
  getTool,
  historyTokenBudget,
  providerTools,
  maxOutputTokensOf,
  suggestFollowUps,
  supportsInput,
  tablesFromSql,
  disabledTableInSql,
  type AgentContextBundle,
  type AgentEvent,
  type AgentMessageBlock,
  type AgentRunInput,
  type ApprovalDecision,
  type ApprovalPayload,
  type DatabaseSchema,
  type Memory,
  type MemoryCandidate,
  type PermissionMode,
  type ProviderImage,
  type ProviderMessage,
  type QuestionSuggestion,
  type Risk,
  type ToolCall,
  type ToolResult,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { DbError } from './drivers';
import type { ToolExecutor } from './executor';
import type { ConnectionManager } from './manager';
import type { Store } from './store';
import type { SkillStore } from './skills';
import { readAttachment } from './attachments';
import { allTableScanNeedsScope, disabledTableTarget, disabledToolError, filterDisabledObjects, metadataBlockedError, scopeRequiredError, systemCatalogQuery } from './agentContextGuard';
import {
  briefPathFromRegistry,
  briefPromptBlock,
  composeDatabaseBrief,
  defaultBriefPath,
  loadBrief,
  readBrief,
  summarizeInit,
  writeDatabaseBrief,
  type LoadedBrief,
} from './features/databaseBrief';

export interface TurnInput {
  text: string;
  mode?: PermissionMode;
  attachments?: string[];
  /** 已上传到 Bridge 的图片附件 id。 */
  images?: string[];
  connectionId?: string;
  /** 本回合的目标库；缺省用会话记录的库，再缺省用连接默认库。 */
  database?: string;
}

export interface AgentHostOptions {
  store: Store;
  manager: ConnectionManager;
  executor: ToolExecutor;
  config: GatewayConfig;
  skills?: SkillStore;
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
  payload: ApprovalPayload;
}

const MODES: PermissionMode[] = ['readonly', 'ask', 'auto', 'full'];

/** 一轮最多带几张图，再多只会让 prompt 变贵，不会更准。 */
const MAX_IMAGES_PER_TURN = 4;

/** ProviderImage 加附件标识，便于把图片写回消息 blocks。 */
interface AttachedImage extends ProviderImage {
  id: string;
  bytes: number;
}

function imagesOf(blocks: AgentMessageBlock[], dir: string): AttachedImage[] {
  const out: AttachedImage[] = [];
  for (const block of blocks) {
    if (block.type !== 'image' || !block.attachmentId) continue;
    const file = readAttachment(dir, block.attachmentId);
    if (file) out.push({ id: block.attachmentId, mime: file.mime, base64: file.buffer.toString('base64'), bytes: file.buffer.length });
  }
  return out;
}

export class AgentHost {
  private active = new Map<string, AbortController>();
  private approvals = new Map<string, PendingApproval>();

  constructor(private opts: AgentHostOptions) {}

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  abort(sessionId: string): boolean {
    const controller = this.active.get(sessionId);
    if (!controller) return false;
    controller.abort();
    // 立即落状态：provider 卡住时 runtime 可能迟迟不返回，UI 不能一直显示“运行中”
    this.opts.store.updateSession(sessionId, { status: 'aborted' });
    for (const [id, pending] of this.approvals) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.approvals.delete(id);
      pending.resolve({ decision: 'deny', scope: 'once' });
    }
    return true;
  }

  resolveApproval(id: string, decision: ApprovalDecision['decision'], scope: ApprovalDecision['scope']): boolean {
    const pending = this.approvals.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.approvals.delete(id);
    const session = this.opts.store.getSession(pending.sessionId);
    const connId =
      typeof pending.payload.call.args.connectionId === 'string'
        ? pending.payload.call.args.connectionId
        : session?.connectionId;
    this.opts.store.addAudit({
      actor: 'agent',
      connectionId: connId,
      tool: pending.payload.call.name,
      sql: pending.payload.sql,
      risk: pending.payload.risk,
      approval: `${decision}:${scope}`,
      status: decision === 'allow' ? 'ok' : 'denied',
      meta: { approvalId: id, sessionId: pending.sessionId, scope },
    });
    pending.resolve({ decision, scope });
    return true;
  }

  private waitApproval(payload: ApprovalPayload, sessionId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(payload.id);
        resolve({ decision: 'deny', scope: 'once' });
      }, 5 * 60 * 1000);
      this.approvals.set(payload.id, { resolve, timer, sessionId, payload });
    });
  }

  private loadImages(ids?: string[]): AttachedImage[] {
    const out: AttachedImage[] = [];
    for (const id of (ids ?? []).slice(0, MAX_IMAGES_PER_TURN)) {
      const file = readAttachment(this.opts.config.attachmentDir, id);
      if (!file) throw new DbError(`图片附件不存在，请重新上传：${id}`, { code: 'ATTACHMENT_NOT_FOUND', status: 400 });
      out.push({ id, mime: file.mime, base64: file.buffer.toString('base64'), bytes: file.buffer.length });
    }
    return out;
  }

  async startTurn(sessionId: string, input: TurnInput, emit: (event: AgentEvent) => void): Promise<void> {
    if (this.active.has(sessionId)) throw new DbError('该会话正在运行，请先中止或等待完成', { code: 'SESSION_BUSY', status: 409 });
    const rawText = input.text?.trim();
    if (!rawText) throw new DbError('消息不能为空', { code: 'EMPTY_MESSAGE', status: 400 });
    const reportMatch = /^\/report(?:\s+([\s\S]+))?$/i.exec(rawText);
    const reportMode = Boolean(reportMatch?.[1]?.trim());
    const text = reportMatch?.[1]?.trim() || rawText;
    const session = this.opts.store.getSession(sessionId);
    if (!session) throw new DbError('会话不存在', { code: 'SESSION_NOT_FOUND', status: 404 });
    const mode = MODES.includes(input.mode as PermissionMode) ? (input.mode as PermissionMode) : session.permissionMode;
    const connectionId = input.connectionId ?? session.connectionId;
    const stored = connectionId ? this.opts.store.getConnection(connectionId) : undefined;
    // 目标库按「本回合 > 会话记录 > 连接默认」取，并替换进 conn，
    // 让 schema、召回、业务上下文、提示词和工具默认库都指向同一个库。
    // 会话库只在连接没换时才有意义，换了连接就退回新连接的默认库
    const sameConnection = !session.connectionId || !connectionId || session.connectionId === connectionId;
    const database = input.database || (sameConnection ? session.database : undefined) || stored?.database;
    const conn = stored ? { ...stored, database } : undefined;
    const initMatch = /^\/init(?:\s+([\s\S]+))?$/i.exec(rawText);
    if (initMatch) {
      await this.runInit(sessionId, input, rawText, initMatch[1]?.trim(), emit);
      return;
    }
    const settings = this.opts.store.getSettings();
    const profile = getModelProfile(settings.agent);
    if (input.images?.length && !supportsInput(profile, 'image')) {
      throw new DbError('当前模型没有开启图片输入，请在 设置 → 模型能力 里勾选「图片」。', { code: 'MODEL_NO_VISION', status: 400 });
    }
    const images = this.loadImages(input.images);
    const provider = createProvider(settings.agent);
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    // 硬上限：模型端整条流卡死时也要结束回合，避免会话永远 running
    const turnTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort();
      this.opts.store.updateSession(sessionId, { status: 'aborted' });
    }, Math.max(30_000, Number(process.env.AIDB_AGENT_TURN_MS ?? (reportMode ? 15 * 60_000 : 480_000))));
    turnTimer.unref();

    const store = this.opts.store;
    const historyMessages = store.listMessages(sessionId);
    const history: ProviderMessage[] = [];
    for (const m of historyMessages) {
      if (m.role === 'user') {
        const past = imagesOf(m.blocks, this.opts.config.attachmentDir);
        history.push({ role: 'user', content: m.content, ...(past.length ? { images: past } : {}) });
      } else if (m.role === 'assistant' && (m.content || m.blocks.length)) {
        const trace = m.blocks.filter((b) => b.type === 'tool_call').map((b) => b.tool).filter(Boolean);
        history.push({
          role: 'assistant',
          content: `${m.content}${trace.length ? `\n\n[used tools: ${[...new Set(trace)].join(', ')}]` : ''}`.trim(),
        });
      }
    }

    let schemas: DatabaseSchema[] | undefined;
    let schemaError: string | undefined;
    if (conn) {
      try {
        schemas = await this.opts.manager.schema(conn.id, conn.database);
      } catch (err: any) {
        schemaError = err?.message ?? '无法读取结构';
      }
    }
    let brief: LoadedBrief | undefined;
    if (conn) {
      const record = this.opts.store.getDatabaseBrief(conn.id, conn.database);
      const briefPath = record?.path ?? defaultBriefPath(this.opts.config.home, conn);
      const briefMarkdown = await readBrief(briefPath);
      if (briefMarkdown && schemas) brief = loadBrief(briefMarkdown, briefPath, schemas);
    }

    const recall = conn
      ? store.recallForTurn(text, { connectionId: conn.id, database: conn.database })
      : { memories: [] as Memory[], glossary: [] as Memory[], sqlExamples: [] as Memory[] };
    const memories = recall.memories;
    const businessContext = conn ? store.agentContextBundle(conn.id, conn.database) : undefined;
    const attachmentTables = (input.attachments ?? []).map(String).slice(0, 12);
    const compacted = compactHistory(history.slice(-24), historyTokenBudget(settings.agent, profile));

    const title = session.title === '新会话' || !session.title ? rawText.slice(0, 28) : session.title;
    store.updateSession(sessionId, {
      connectionId,
      database,
      title,
      permissionMode: mode,
      status: 'running',
      model: settings.agent.provider === 'local' ? 'local' : settings.agent.model,
    });
    store.appendMessage({
      sessionId,
      role: 'user',
      content: rawText,
      blocks: images.map((img) => ({ type: 'image' as const, attachmentId: img.id, mime: img.mime, bytes: img.bytes })),
    });

    const blocks: AgentMessageBlock[] = [];
    const callInfo = new Map<string, { call: ToolCall; risk: Risk }>();
    let thinking = '';
    const sessionForAudit = session;

    const wrappedEmit = (event: AgentEvent): void => {
      switch (event.type) {
        case 'thinking_delta':
          thinking += event.text;
          break;
        case 'tool_call':
          callInfo.set(event.callId, { call: { id: event.callId, name: event.tool, args: (event.args ?? {}) as Record<string, unknown> }, risk: event.risk });
          blocks.push({ type: 'tool_call', callId: event.callId, tool: event.tool, args: event.args, risk: event.risk });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            callId: event.callId,
            tool: event.tool,
            result: event.result,
            status: event.result.ok ? 'ok' : 'error',
          });
          store.addToolRun({
            id: event.callId,
            sessionId,
            tool: event.tool,
            args: callInfo.get(event.callId)?.call.args,
            result: event.result,
            status: event.result.ok ? 'ok' : 'error',
            risk: callInfo.get(event.callId)?.risk,
            durationMs: event.result.meta.durationMs,
          });
          break;
        case 'plan':
          blocks.push({ type: 'plan', items: event.items });
          break;
        default:
          break;
      }
      emit(event);
    };

    const memoryContext: Memory[] = memories;
    const allowedTools = providerTools().filter(
      (tool) => (settings.features.skills || !tool.name.startsWith('skill_')) && (settings.features.mcp || !tool.name.startsWith('mcp_')),
    );
    const runtime = new AgentRuntime({
      provider,
      maxSteps: settings.agent.maxSteps,
      temperature: settings.agent.temperature,
      maxTokens: maxOutputTokensOf(settings.agent, profile),
      reasoning: activeReasoningTier(settings.agent, profile),
      generateId: () => randomUUID(),
      buildSystem: (run: AgentRunInput) => {
        const base = buildSystemPrompt({
          connection: conn,
          databases: schemas,
          memories: memoryContext,
          glossary: recall.glossary,
          sqlExamples: recall.sqlExamples,
          context: businessContext,
          mode: run.mode,
          attachmentTables,
          question: run.userText,
          focusMode: settings.agent.schemaFocus ?? 'auto',
        });
        const extra: string[] = [];
        if (brief) extra.push(briefPromptBlock(brief));
        if (sessionForAudit.summary) extra.push(`## Earlier session summary\n${sessionForAudit.summary}`);
        if (schemaError) extra.push(`## Schema loading warning\n${schemaError}`);
        if (settings.agent.provider === 'local') {
          extra.push('## Runtime\nYou are running with the offline Local Reasoner. Keep to clear, rule-parsable instructions; if a request is ambiguous, explain what you can do.');
        }
        return `${base}\n${extra.join('\n\n')}`;
      },
      tools: allowedTools,
      getTool: (name) => allowedTools.some((tool) => tool.name === name) ? getTool(name) : undefined,
      executeTool: (call, signal) => {
        const contextDb = businessContext?.database?.toLowerCase() ?? '';
        const targetDb = String(call.args.database ?? conn?.database ?? '').toLowerCase();
        const scoped = !contextDb || !targetDb || targetDb === contextDb;
        const disabled = scoped ? businessContext?.disabledTables ?? [] : [];
        if (disabled.length) {
          if (allTableScanNeedsScope(call, disabled)) return Promise.resolve(scopeRequiredError(call.name));
          const target = disabledTableTarget(call, disabled);
          if (target) return Promise.resolve(disabledToolError(target));
          if (typeof call.args.sql === 'string') {
            const sql = call.args.sql;
            if (systemCatalogQuery(sql)) return Promise.resolve(metadataBlockedError());
            const blocked = disabledTableInSql(sql, disabled);
            if (blocked) {
              return Promise.resolve({
                ok: false,
                summary: '表已被业务上下文禁用',
                error: {
                  code: 'TABLE_DISABLED',
                  message: `表 ${blocked} 已在业务上下文中禁用，不能执行包含它的 SQL。`,
                  hint: '改用未禁用的表；若确需该表，请让用户在 Agent 上下文里启用它。',
                },
                meta: { durationMs: 0 },
              });
            }
          }
        }
        return this.opts.executor
          .execute(call, { sessionId, connectionId: conn?.id, database: conn?.database, disabledTables: disabled, signal })
          .then((result) => filterDisabledObjects(call, result, disabled));
      },
      requestApproval: (payload) => this.waitApproval(payload, sessionId),
      emit: wrappedEmit,
    });

    let status: 'done' | 'aborted' | 'error' = 'done';
    let usage = { tokensIn: 0, tokensOut: 0 };
    try {
      const result = await runtime.run({
        sessionId,
        userText: text,
        ...(images.length ? { images } : {}),
        mode,
        connection: conn,
        environment: conn?.environment ?? 'dev',
        connectionReadonly: conn?.readonly ?? false,
        history: compacted,
        context: { connection: conn, databases: schemas, memories, agentContext: businessContext, glossary: recall.glossary, attachmentTables },
        sessionAllowed: new Set<string>(),
        alwaysAllowed: new Set<string>(),
        signal: controller.signal,
      });
      status = result.status;
      usage = result.usage;
      const finalBlocks = thinking ? [{ type: 'thinking' as const, text: thinking }, ...blocks] : blocks;
      store.appendMessage({ sessionId, role: 'assistant', content: result.text, blocks: finalBlocks, tokens: result.usage.tokensOut });
      const previous = store.getSession(sessionId);
      const summaryLine = `Q: ${text.slice(0, 200)}\nA: ${result.text.slice(0, 400)}`;
      const summary = `${previous?.summary ? `${previous.summary}\n---\n` : ''}${summaryLine}`.slice(-6000);
      store.updateSession(sessionId, {
        status: result.status === 'done' ? 'done' : result.status === 'aborted' ? 'aborted' : 'error',
        summary,
        tokensIn: (previous?.tokensIn ?? 0) + result.usage.tokensIn,
        tokensOut: (previous?.tokensOut ?? 0) + result.usage.tokensOut,
        model: settings.agent.provider === 'local' ? 'local' : settings.agent.model,
      });
      if (result.status === 'done' && settings.agent.followUpSuggestions) {
        for (const item of this.followUps(blocks, schemas, businessContext)) emit({ type: 'suggestions', items: item });
      }
      if (settings.agent.autoMemory) this.captureMemories(text, result.text, sessionId, conn);
    } catch (err: any) {
      status = 'error';
      store.updateSession(sessionId, { status: 'error' });
      emit({ type: 'error', code: err?.code ?? 'AGENT_ERROR', message: err?.message ?? 'Agent 运行失败', retryable: false });
    } finally {
      clearTimeout(turnTimer);
      this.active.delete(sessionId);
      for (const [id, pending] of this.approvals) {
        if (pending.sessionId !== sessionId) continue;
        clearTimeout(pending.timer);
        this.approvals.delete(id);
        pending.resolve({ decision: 'deny', scope: 'once' });
      }
    }
    if (status === 'done' && usage.tokensIn + usage.tokensOut > 0) {
      // usage already emitted by the runtime; kept here for future analytics
    }
  }

  /**
   * `/init`：扫描当前库并维护 AI_DB.md。每次执行全量刷新自动段落（新表/删表/改列都会反映），
   * 只有数据流与人工补充这两个 manual 段落保留；确定性清单是主体，模型只补充注解。
   */
  private async runInit(sessionId: string, input: TurnInput, rawText: string, requestedPath: string | undefined, emit: (event: AgentEvent) => void): Promise<void> {
    const store = this.opts.store;
    const session = store.getSession(sessionId);
    if (!session) {
      emit({ type: 'error', code: 'SESSION_NOT_FOUND', message: '会话不存在' });
      return;
    }
    const connectionId = input.connectionId ?? session.connectionId;
    const stored = connectionId ? store.getConnection(connectionId) : undefined;
    if (!stored) {
      emit({ type: 'error', code: 'NO_CONNECTION', message: '请先在 Agent 顶部选择一个连接和数据库，再运行 /init' });
      return;
    }
    const sameConnection = !session.connectionId || !connectionId || session.connectionId === connectionId;
    const database = input.database || (sameConnection ? session.database : undefined) || stored.database;
    const conn = { ...stored, database };
    const turnId = randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    timer.unref();
    const started = Date.now();
    store.updateSession(sessionId, {
      connectionId,
      database,
      status: 'running',
      title: session.title === '新会话' || !session.title ? `AI_DB · ${database || conn.name}` : session.title,
      model: 'init',
    });
    store.appendMessage({ sessionId, role: 'user', content: rawText });
    emit({ type: 'start', turnId, sessionId, model: 'init' });
    try {
      const schemas = await this.opts.manager.schema(conn.id, conn.database);
      if (controller.signal.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      const settings = store.getSettings();
      const recall = store.recallForTurn('', { connectionId: conn.id, database: conn.database });
      const history = store.listHistory({ connectionId: conn.id, limit: 100 }).map((item) => ({ sql: item.sql, status: item.status }));
      const record = store.getDatabaseBrief(conn.id, conn.database);
      const path = briefPathFromRegistry({
        home: this.opts.config.home,
        connection: conn,
        storedPath: record?.path,
        requestedPath,
      });
      const existing = await readBrief(path);
      let provider: ReturnType<typeof createProvider> | undefined;
      if (settings.agent.provider !== 'local') {
        try {
          provider = createProvider(settings.agent);
        } catch {
          /* 注解失败不能挡住确定性文档 */
        }
      }
      const result = await composeDatabaseBrief({
        connection: conn,
        schemas,
        bundle: store.agentContextBundle(conn.id, conn.database),
        glossary: recall.glossary,
        sqlExamples: recall.sqlExamples,
        history,
        provider,
        signal: controller.signal,
        home: this.opts.config.home,
        requestedPath,
        storedPath: record?.path,
        existing: existing ?? undefined,
      });
      if (controller.signal.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      await writeDatabaseBrief(result.path, result.markdown, existing ?? undefined);
      const generatedAt = new Date().toISOString();
      store.saveDatabaseBrief({
        connectionId: conn.id,
        database: conn.database,
        path: result.path,
        schemaHash: result.schemaHash,
        generatedAt,
      });
      const content = [summarizeInit(result), existing ? '\n\n已更新现有文件：自动段落全部刷新，数据流与人工补充段落保留。' : '\n\n这是首次生成，后续对话会自动加载它。'].join('');
      store.appendMessage({ sessionId, role: 'assistant', content });
      clearTimeout(timer);
      this.active.delete(sessionId);
      store.updateSession(sessionId, {
        status: 'done',
        summary: `Q: ${rawText.slice(0, 200)}\nA: ${content.slice(0, 400)}`,
      });
      emit({ type: 'text_delta', text: content });
      emit({ type: 'done', turnId, durationMs: Date.now() - started, summary: content.slice(0, 280) });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database: conn.database,
        tool: 'command.init',
        risk: 'read',
        approval: 'none',
        status: 'ok',
        durationMs: Date.now() - started,
        meta: {
          path: result.path,
          tables: result.stats.tableNames.length,
          coreTables: result.stats.coreTables.length,
          joins: result.stats.joins,
          annotations: result.stats.annotations,
          schemaHash: result.schemaHash,
        },
      });
    } catch (err: any) {
      clearTimeout(timer);
      this.active.delete(sessionId);
      const aborted = controller.signal.aborted || err?.code === 'ABORTED';
      store.updateSession(sessionId, { status: aborted ? 'aborted' : 'error' });
      if (aborted) emit({ type: 'aborted', turnId, reason: '用户中止' });
      else emit({ type: 'error', code: err?.code ?? 'INIT_FAILED', message: err?.message ?? '初始化失败' });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database: conn.database,
        tool: 'command.init',
        risk: 'read',
        approval: 'none',
        status: 'error',
        durationMs: Date.now() - started,
        meta: { path: requestedPath, aborted },
      });
    }
  }

  /**
   * 追问建议：只看本轮真正调用过的工具与涉及的表，用本地规则生成。
   * 对所有 provider 一视同仁，不依赖模型输出特定标签，也不产生额外 token 成本。
   */
  private followUps(blocks: AgentMessageBlock[], schemas: DatabaseSchema[] | undefined, bundle?: AgentContextBundle): QuestionSuggestion[][] {
    const usedTools: string[] = [];
    const touched = new Set<string>();
    for (const block of blocks) {
      if (block.type !== 'tool_call') continue;
      if (block.tool) usedTools.push(block.tool);
      const args = (block.args ?? {}) as Record<string, unknown>;
      if (typeof args.table === 'string' && args.table.trim()) touched.add(args.table.trim());
      if (typeof args.sql === 'string') for (const name of tablesFromSql(args.sql)) touched.add(name);
    }
    const items = suggestFollowUps({ schemas, tables: [...touched], usedTools, bundle, limit: 3 });
    return items.length ? [items] : [];
  }

  private captureMemories(text: string, answer: string, sessionId: string, conn?: { id: string; database?: string }): void {
    const store = this.opts.store;
    const candidates = extractHeuristicMemories(text, { connectionId: conn?.id, sessionId });
    for (const candidate of candidates) {
      try {
        store.upsertMemoryCandidate(candidate, { connectionId: conn?.id, database: conn?.database, sessionId });
      } catch {
        /* ignore rejected memories */
      }
    }
    if (answer.trim()) {
      const episodic: MemoryCandidate = {
        kind: 'episodic',
        title: text.slice(0, 60),
        content: `用户: ${text.slice(0, 600)}\n助手: ${answer.slice(0, 900)}`,
        importance: 0.35,
        confidence: 0.6,
      };
      try {
        store.upsertMemoryCandidate(episodic, { connectionId: conn?.id, database: conn?.database, sessionId });
      } catch {
        /* ignore */
      }
    }
  }
}

export type { ToolResult };
