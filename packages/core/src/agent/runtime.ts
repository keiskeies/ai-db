import type { AgentPlanItem, Risk } from '../types';
import { describeCall, evaluatePermission, resolveRisk, toolSignature } from './policy';
import { getTool, providerTools } from './tools';
import type {
  AgentEvent,
  AgentRunInput,
  AgentRuntimeDeps,
  ApprovalDecision,
  ProviderMessage,
  ToolCall,
  ToolResult,
} from './types';

export interface AgentRunResult {
  text: string;
  status: 'done' | 'aborted' | 'error';
  usage: { tokensIn: number; tokensOut: number };
  toolCalls: number;
  plan: AgentPlanItem[];
  error?: { code: string; message: string };
}

const MAX_MODEL_RESULT_CHARS = 16000;

function serializeForModel(result: ToolResult): string {
  const compact: ToolResult = { ...result };
  const data = result.data as { rows?: unknown[] } | undefined;
  if (data && Array.isArray(data.rows) && data.rows.length > 50) {
    compact.data = { ...(data as object), rows: data.rows.slice(0, 50), truncated: true };
    compact.meta = { ...compact.meta, truncated: true };
  }
  const json = JSON.stringify(compact);
  if (json.length <= MAX_MODEL_RESULT_CHARS) return json;
  return JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    error: result.error,
    meta: compact.meta,
    data: '(result too large and was omitted; narrow the query or request fewer rows)',
  });
}

function permissionDenied(mode: string, readonly: boolean): ToolResult {
  return {
    ok: false,
    summary: '权限被拒绝',
    error: {
      code: 'PERMISSION_DENIED',
      message: readonly ? '该连接为只读，写操作被服务端拒绝。' : `当前权限模式（${mode}）不允许执行该操作。`,
      hint: '可切换到 ask/auto/full 模式，或由用户在连接设置中取消只读。',
    },
    meta: { durationMs: 0 },
  };
}

function approvalDenied(): ToolResult {
  return {
    ok: false,
    summary: '用户拒绝了操作',
    error: { code: 'APPROVAL_DENIED', message: '用户拒绝执行该工具调用。', hint: '不要重试；询问用户希望如何调整。' },
    meta: { durationMs: 0 },
  };
}

function toolFailed(message: string, code = 'TOOL_ERROR'): ToolResult {
  return { ok: false, summary: '工具执行失败', error: { code, message }, meta: { durationMs: 0 } };
}

export class AgentRuntime {
  constructor(private deps: AgentRuntimeDeps) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const deps = this.deps;
    const now = deps.now ?? Date.now;
    const started = now();
    const turnId = deps.generateId();
    const maxSteps = deps.maxSteps ?? 12;
    const messages: ProviderMessage[] = [
      ...input.history,
      { role: 'user', content: input.userText, ...(input.images?.length ? { images: input.images } : {}) },
    ];
    let finalText = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let toolCount = 0;
    let plan: AgentPlanItem[] = [];

    deps.emit({ type: 'start', turnId, sessionId: input.sessionId, model: deps.provider.label });
    if (input.context.memories?.length) {
      deps.emit({
        type: 'memory_used',
        memories: input.context.memories.map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
      });
    }

    const finish = (status: AgentRunResult['status'], error?: AgentRunResult['error']): AgentRunResult => {
      if (status === 'done') {
        deps.emit({ type: 'done', turnId, durationMs: now() - started, summary: finalText.slice(0, 280) });
      }
      return { text: finalText.trim(), status, usage: { tokensIn, tokensOut }, toolCalls: toolCount, plan, error };
    };

    const aborted = (): AgentRunResult => {
      deps.emit({ type: 'aborted', turnId, reason: '用户中止' });
      return { text: finalText.trim(), status: 'aborted', usage: { tokensIn, tokensOut }, toolCalls: toolCount, plan };
    };

    for (let step = 0; step < maxSteps; step++) {
      if (input.signal?.aborted) return aborted();
      const request = {
        system: deps.buildSystem(input),
        messages,
        tools: providerTools(),
        temperature: deps.temperature,
        ...(deps.maxTokens ? { maxTokens: deps.maxTokens } : {}),
        ...(deps.reasoning ? { reasoning: deps.reasoning } : {}),
        context: input.context,
      };
      const calls: ToolCall[] = [];
      let stepText = '';
      let providerError: { code: string; message: string } | undefined;

      try {
        for await (const ev of deps.provider.stream(request, input.signal)) {
          if (input.signal?.aborted) break;
          if (ev.type === 'text') {
            stepText += ev.text;
            deps.emit({ type: 'text_delta', text: ev.text });
          } else if (ev.type === 'thinking') {
            deps.emit({ type: 'thinking_delta', text: ev.text });
          } else if (ev.type === 'tool_call') {
            calls.push(ev.call);
          } else if (ev.type === 'usage') {
            tokensIn += ev.tokensIn;
            tokensOut += ev.tokensOut;
            deps.emit({ type: 'usage', tokensIn: ev.tokensIn, tokensOut: ev.tokensOut });
          }
        }
      } catch (err: any) {
        if (input.signal?.aborted || err?.name === 'AbortError') return aborted();
        providerError = { code: err?.code ?? 'PROVIDER_ERROR', message: err?.message ?? '模型调用失败' };
      }
      if (input.signal?.aborted) return aborted();
      if (providerError) {
        deps.emit({ type: 'error', code: providerError.code, message: providerError.message, retryable: true });
        return { text: finalText.trim(), status: 'error', usage: { tokensIn, tokensOut }, toolCalls: toolCount, plan, error: providerError };
      }

      if (stepText) finalText += (finalText ? '\n\n' : '') + stepText;
      if (!calls.length) return finish('done');

      messages.push({ role: 'assistant', content: stepText, toolCalls: calls });

      for (const call of calls) {
        if (input.signal?.aborted) return aborted();
        toolCount++;
        const tool = getTool(call.name);
        if (!tool) {
          const res = toolFailed(`未知工具：${call.name}`, 'UNKNOWN_TOOL');
          deps.emit({ type: 'tool_result', callId: call.id, tool: call.name, result: res });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res) });
          continue;
        }
        const risk = resolveRisk(call, tool);
        const described = describeCall(call);
        const summary = tool.summarize?.(call.args) ?? described.summary;
        deps.emit({ type: 'tool_call', callId: call.id, tool: call.name, args: call.args, risk, summary });

        if (call.name === 'update_plan') {
          const raw = Array.isArray(call.args.items) ? (call.args.items as Array<Record<string, unknown>>) : [];
          plan = raw.slice(0, 20).map((it, i) => ({
            id: `p${i + 1}`,
            text: String(it.text ?? ''),
            status: it.status === 'done' || it.status === 'doing' ? it.status : 'todo',
          }));
          deps.emit({ type: 'plan', items: plan });
          const res: ToolResult = { ok: true, summary: `计划已更新（${plan.length} 项）`, data: { items: plan }, meta: { durationMs: 0 } };
          deps.emit({ type: 'tool_result', callId: call.id, tool: call.name, result: res });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res) });
          continue;
        }

        const verdict = evaluatePermission(
          risk,
          {
            mode: input.mode,
            connectionReadonly: input.connectionReadonly,
            environment: input.environment,
            sessionAllowed: input.sessionAllowed,
            alwaysAllowed: input.alwaysAllowed,
          },
          call,
        );

        if (verdict === 'deny') {
          const res = permissionDenied(input.mode, input.connectionReadonly);
          deps.emit({ type: 'tool_result', callId: call.id, tool: call.name, result: res });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res) });
          continue;
        }

        if (verdict === 'ask') {
          const approvalId = deps.generateId();
          deps.emit({
            type: 'approval_required',
            approvalId,
            call: { tool: call.name, args: call.args, risk, summary: described.summary, sql: described.sql },
            expiresIn: 5 * 60 * 1000,
          });
          let decision: ApprovalDecision;
          try {
            decision = await deps.requestApproval({
              id: approvalId,
              call,
              risk,
              summary: described.summary,
              sql: described.sql,
              expiresAt: now() + 5 * 60 * 1000,
            });
          } catch {
            if (input.signal?.aborted) return aborted();
            decision = { decision: 'deny', scope: 'once' };
          }
          if (input.signal?.aborted) return aborted();
          deps.emit({ type: 'approval_resolved', approvalId, decision: decision.decision, scope: decision.scope });
          if (decision.decision === 'deny') {
            const res = approvalDenied();
            deps.emit({ type: 'tool_result', callId: call.id, tool: call.name, result: res });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res) });
            continue;
          }
          const sig = toolSignature(call);
          if (decision.scope === 'session') input.sessionAllowed?.add(sig);
          if (decision.scope === 'always') input.alwaysAllowed?.add(sig);
        }

        let res: ToolResult;
        try {
          res = await deps.executeTool(call, input.signal ?? new AbortController().signal);
        } catch (err: any) {
          if (input.signal?.aborted || err?.name === 'AbortError') return aborted();
          res = toolFailed(err?.message ?? '工具执行失败');
        }
        if (input.signal?.aborted) return aborted();
        deps.emit({ type: 'tool_result', callId: call.id, tool: call.name, result: res });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res) });
      }
    }

    if (!finalText) {
      finalText = '已达到本次最大工具步数（' + maxSteps + '），我先停在这里。可以继续提问，我会接着处理。';
      deps.emit({ type: 'text_delta', text: finalText });
    }
    return finish('done');
  }
}

export type { AgentEvent, Risk };
