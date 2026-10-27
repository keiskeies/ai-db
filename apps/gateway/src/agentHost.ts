import { randomUUID } from 'node:crypto';
import {
  AgentRuntime,
  buildSystemPrompt,
  compactHistory,
  createProvider,
  extractHeuristicMemories,
  type AgentEvent,
  type AgentMessageBlock,
  type AgentRunInput,
  type ApprovalDecision,
  type ApprovalPayload,
  type DatabaseSchema,
  type Memory,
  type MemoryCandidate,
  type PermissionMode,
  type ProviderMessage,
  type Risk,
  type ToolCall,
  type ToolResult,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { DbError } from './drivers';
import type { ToolExecutor } from './executor';
import type { ConnectionManager } from './manager';
import type { Store } from './store';

export interface TurnInput {
  text: string;
  mode?: PermissionMode;
  attachments?: string[];
  connectionId?: string;
}

export interface AgentHostOptions {
  store: Store;
  manager: ConnectionManager;
  executor: ToolExecutor;
  config: GatewayConfig;
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
  payload: ApprovalPayload;
}

const MODES: PermissionMode[] = ['readonly', 'ask', 'auto', 'full'];

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

  async startTurn(sessionId: string, input: TurnInput, emit: (event: AgentEvent) => void): Promise<void> {
    if (this.active.has(sessionId)) throw new DbError('该会话正在运行，请先中止或等待完成', { code: 'SESSION_BUSY', status: 409 });
    const text = input.text?.trim();
    if (!text) throw new DbError('消息不能为空', { code: 'EMPTY_MESSAGE', status: 400 });
    const session = this.opts.store.getSession(sessionId);
    if (!session) throw new DbError('会话不存在', { code: 'SESSION_NOT_FOUND', status: 404 });
    const mode = MODES.includes(input.mode as PermissionMode) ? (input.mode as PermissionMode) : session.permissionMode;
    const connectionId = input.connectionId ?? session.connectionId;
    const conn = connectionId ? this.opts.store.getConnection(connectionId) : undefined;
    const settings = this.opts.store.getSettings();
    const provider = createProvider(settings.agent);
    const controller = new AbortController();
    this.active.set(sessionId, controller);

    const store = this.opts.store;
    const historyMessages = store.listMessages(sessionId);
    const history: ProviderMessage[] = [];
    for (const m of historyMessages) {
      if (m.role === 'user') history.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant' && (m.content || m.blocks.length)) {
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

    const memories = store.searchMemories(text, { connectionId: conn?.id, database: conn?.database, limit: 6 });
    const attachmentTables = (input.attachments ?? []).map(String).slice(0, 12);
    const compacted = compactHistory(history.slice(-24), Math.max(4000, Math.floor(settings.agent.compactionThreshold / 2)));

    const title = session.title === '新会话' || !session.title ? text.slice(0, 28) : session.title;
    store.updateSession(sessionId, {
      connectionId,
      title,
      permissionMode: mode,
      status: 'running',
      model: settings.agent.provider === 'local' ? 'local' : settings.agent.model,
    });
    store.appendMessage({ sessionId, role: 'user', content: text });

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
    const runtime = new AgentRuntime({
      provider,
      maxSteps: settings.agent.maxSteps,
      temperature: settings.agent.temperature,
      generateId: () => randomUUID(),
      buildSystem: (run: AgentRunInput) => {
        const base = buildSystemPrompt({
          connection: conn,
          databases: schemas,
          memories: memoryContext,
          mode: run.mode,
          attachmentTables,
        });
        const extra: string[] = [];
        if (sessionForAudit.summary) extra.push(`## Earlier session summary\n${sessionForAudit.summary}`);
        if (schemaError) extra.push(`## Schema loading warning\n${schemaError}`);
        if (settings.agent.provider === 'local') {
          extra.push('## Runtime\nYou are running with the offline Local Reasoner. Keep to clear, rule-parsable instructions; if a request is ambiguous, explain what you can do.');
        }
        return `${base}\n${extra.join('\n\n')}`;
      },
      executeTool: (call, signal) => this.opts.executor.execute(call, { sessionId, connectionId: conn?.id, signal }),
      requestApproval: (payload) => this.waitApproval(payload, sessionId),
      emit: wrappedEmit,
    });

    let status: 'done' | 'aborted' | 'error' = 'done';
    let usage = { tokensIn: 0, tokensOut: 0 };
    try {
      const result = await runtime.run({
        sessionId,
        userText: text,
        mode,
        connection: conn,
        environment: conn?.environment ?? 'dev',
        connectionReadonly: conn?.readonly ?? false,
        history: compacted,
        context: { connection: conn, databases: schemas, memories, attachmentTables },
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
      if (settings.agent.autoMemory) this.captureMemories(text, result.text, sessionId, conn);
    } catch (err: any) {
      status = 'error';
      store.updateSession(sessionId, { status: 'error' });
      emit({ type: 'error', code: err?.code ?? 'AGENT_ERROR', message: err?.message ?? 'Agent 运行失败', retryable: false });
    } finally {
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
