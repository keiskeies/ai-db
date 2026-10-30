import type { AgentPlanItem, Risk } from '../types';
import { describeCall, evaluatePermission, resolveRisk, toolSignature } from './policy';
import { getTool, providerTools } from './tools';
import { rescueXmlToolCalls } from './xmlTools';
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
const MAX_SQL_REPAIRS = 2;
const NON_REPAIRABLE = new Set([
  'PERMISSION_DENIED',
  'APPROVAL_DENIED',
  'READONLY',
  'UNKNOWN_TOOL',
  'TABLE_DISABLED',
  'TABLE_SCOPE_REQUIRED',
  'METADATA_BLOCKED',
]);

function serializeForModel(result: ToolResult, extra?: Record<string, unknown>): string {
  const compact: Record<string, unknown> = { ...result, ...(extra ?? {}) };
  const data = result.data as { rows?: unknown[] } | undefined;
  if (data && Array.isArray(data.rows) && data.rows.length > 50) {
    compact.data = { ...(data as object), rows: data.rows.slice(0, 50), truncated: true };
    compact.meta = { ...(compact.meta as object), truncated: true };
  }
  const json = JSON.stringify(compact);
  if (json.length <= MAX_MODEL_RESULT_CHARS) return json;
  return JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    error: result.error,
    ...(extra ?? {}),
    meta: compact.meta,
    data: '(result too large and was omitted; narrow the query or request fewer rows)',
  });
}

/** 提取 FROM / JOIN 后的表名；支持 `db.table` 与反引号包裹。 */
function referencedTables(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join|update|into|table)\s+(?:`?([A-Za-z_][A-Za-z0-9_$]*)`?\.)?`?([A-Za-z_][A-Za-z0-9_$]*)`?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) out.add(match[2].toLowerCase());
  return [...out];
}

const UNKNOWN_COLUMN_PATTERNS = [
  /Unknown column '([^']+)'/i,
  /Invalid column name '([^']+)'/i,
  /column "([^"]+)" does not exist/i,
  /no such column:?\s*([A-Za-z0-9_.]+)/i,
  /ORA-00904:\s*"([^"]+)"/i,
];
const UNKNOWN_TABLE_PATTERNS = [
  /Table '([^']+)' doesn't exist/i,
  /Invalid object name '([^']+)'/i,
  /relation "([^"]+)" does not exist/i,
  /no such table:?\s*([A-Za-z0-9_.]+)/i,
];

function parseMissingIdentifier(message: string): { kind: 'column' | 'table'; name: string } | undefined {
  for (const pattern of UNKNOWN_COLUMN_PATTERNS) {
    const match = message.match(pattern);
    if (match?.[1]) return { kind: 'column', name: match[1].split('.').pop() ?? match[1] };
  }
  for (const pattern of UNKNOWN_TABLE_PATTERNS) {
    const match = message.match(pattern);
    if (match?.[1]) return { kind: 'table', name: match[1].split('.').pop() ?? match[1] };
  }
  return undefined;
}

/** 只用于修复提示的轻量编辑距离，候选量很小。 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const next = [i];
    for (let j = 1; j < cols; j++) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return prev[b.length];
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function suggestIdentifiers(
  missing: { kind: 'column' | 'table'; name: string },
  candidates: Array<{ name: string; table?: string }>,
): string[] {
  const target = missing.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!target) return [];
  const scored: Array<{ label: string; score: number }> = [];
  for (const candidate of candidates) {
    const value = candidate.name.toLowerCase();
    const normalized = value.replace(/[^a-z0-9]/g, '');
    if (!normalized || normalized === target) continue;
    const distance = editDistance(target, normalized);
    const prefix = commonPrefix(target, normalized);
    const threshold = Math.max(2, Math.floor(target.length * 0.34));
    if (distance > threshold && prefix < Math.max(4, Math.floor(Math.min(target.length, normalized.length) * 0.5))) continue;
    scored.push({
      label: `${candidate.name}${candidate.table ? ` (${candidate.table})` : ''}`,
      score: distance - prefix * 0.2,
    });
  }
  return [...new Set(scored.sort((a, b) => a.score - b.score).slice(0, 5).map((item) => item.label))];
}

/**
 * SQL 报错后把「错误 + 涉及表的真实列」回灌给模型。
 * 只给相关表，避免整库 schema 再次淹没上下文；列数有上限，防止提示本身过大。
 */
function buildRepairHint(
  sql: string,
  result: ToolResult,
  databases: AgentRunInput['context']['databases'],
  attempt: number,
): Record<string, unknown> {
  const error = result.error;
  if (attempt > MAX_SQL_REPAIRS) {
    return {
      attempt,
      exhausted: true,
      instruction: `自动修复已尝试 ${MAX_SQL_REPAIRS} 次仍未成功。不要再重复同一 SQL；向用户说明错误原因和下一步建议。`,
      ...(error ? { error: `${error.code}: ${error.message}` } : {}),
    };
  }
  const wanted = referencedTables(sql);
  const all = (databases ?? []).flatMap((schema) => (schema.tables ?? []).map((table) => ({ schema: schema.name, table })));
  let picked = all.filter((item) => wanted.includes(item.table.name.toLowerCase())).slice(0, 4);
  if (!picked.length && wanted.length) {
    picked = all
      .filter((item) => wanted.some((name) => item.table.name.toLowerCase().includes(name) || name.includes(item.table.name.toLowerCase())))
      .slice(0, 6);
  }
  const tables = picked.map(({ schema, table }) => {
    const columns = (table.columns ?? [])
      .slice(0, 40)
      .map((column) => `${column.name}:${column.type}${column.primaryKey ? ' PK' : ''}${column.comment ? ` // ${column.comment}` : ''}`)
      .join(', ');
    return `- ${schema ? `${schema}.` : ''}${table.name}${table.comment ? ` // ${table.comment}` : ''}: ${columns}`;
  });
  if (!tables.length && wanted.length) {
    const names = all.map((item) => item.table.name).filter((name) => wanted.some((w) => name.toLowerCase().includes(w))).slice(0, 8);
    if (names.length) tables.push(`可能想用的表：${names.join(', ')}`);
  }
  const missing = error ? parseMissingIdentifier(error.message) : undefined;
  let suggestions: string[] = [];
  if (missing?.kind === 'table') {
    suggestions = suggestIdentifiers(missing, all.map(({ table }) => ({ name: table.name })));
  } else if (missing?.kind === 'column') {
    const scope = picked.length ? picked : all.slice(0, 60);
    suggestions = suggestIdentifiers(
      missing,
      scope.flatMap(({ table }) => (table.columns ?? []).slice(0, 48).map((column) => ({ name: column.name, table: table.name }))),
    );
  }
  return {
    attempt,
    instruction:
      (suggestions.length ? '优先使用 suggestions 中的真实标识符；' : '') +
      '上一条 SQL 执行失败。请根据错误与下面的真实列定义修正 SQL，然后重新调用 run_sql；不要重复原 SQL。仍不确定列名时先调用 inspect_schema。',
    ...(error ? { error: `${error.code}: ${error.message}` } : {}),
    ...(suggestions.length ? { suggestions } : {}),
    ...(tables.length ? { referenced: tables } : {}),
  };
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
    let sqlRepairs = 0;
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
        tools: deps.tools ?? providerTools(),
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

      if (!calls.length && stepText) {
        // 兜底：模型没走结构化 tool_calls，而是把 XML 调用写进了正文
        const rescued = rescueXmlToolCalls(stepText, (name) => Boolean((deps.getTool ?? getTool)(name)));
        if (rescued.calls.length) {
          calls.push(...rescued.calls);
          stepText = rescued.text;
          deps.emit({ type: 'text_replace', text: stepText });
        }
      }
      if (stepText) finalText += (finalText ? '\n\n' : '') + stepText;
      if (!calls.length) return finish('done');

      messages.push({ role: 'assistant', content: stepText, toolCalls: calls });

      for (const call of calls) {
        if (input.signal?.aborted) return aborted();
        toolCount++;
        const tool = (deps.getTool ?? getTool)(call.name);
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
        let modelContent = serializeForModel(res, { resultRef: call.id });
        if (call.name === 'run_sql' && !res.ok && typeof call.args.sql === 'string' && !NON_REPAIRABLE.has(res.error?.code ?? '')) {
          sqlRepairs += 1;
          modelContent = serializeForModel(res, {
            resultRef: call.id,
            repair: buildRepairHint(String(call.args.sql), res, input.context.databases, sqlRepairs),
          });
        }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: modelContent });
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
