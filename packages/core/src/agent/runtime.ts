import type { AgentPlanItem, Risk } from '../types';
import { describeCall, evaluatePermission, resolveRisk, toolSignature } from './policy';
import { getTool, providerTools } from './tools';
import { rescueXmlToolCalls } from './xmlTools';
import { PROVIDER_STALL_CODE } from './providers/common';
import type {
  AgentAbortCause,
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
  usage: {
    tokensIn: number;
    tokensOut: number;
    /** 命中提示词缓存的输入 tokens；服务商未返回缓存信息时缺省。 */
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  };
  /** 本回合实际走过的模型步数（工具循环轮数），至少为 1。 */
  steps: number;
  /** 本回合发生的模型调用次数（含重试与多步工具循环）。 */
  modelCalls: number;
  /** 最近一次模型调用的输入 tokens，即本回合结束时的上下文占用。 */
  contextTokens: number;
  /** 本回合模型调用总耗时，用于计算真实的 tok/s。 */
  modelDurationMs: number;
  toolCalls: number;
  plan: AgentPlanItem[];
  /** 中止原因；只有 status 为 aborted 时才有值，上次调用方据此决定是否写续跑检查点。 */
  abortCause?: AgentAbortCause;
  error?: { code: string; message: string };
}

/** 没有 deps.resultCharBudget 时的兜底，与改造前的写死值一致。 */
const MAX_MODEL_RESULT_CHARS = 16000;
const MAX_SQL_REPAIRS = 2;
/** 裁剪后仍要告诉模型怎么拿剩下的数据，否则它只能反复补问同一件事。 */
const RESULT_CONTINUATION_HINT =
  '[truncated] 上面的结果被截断了。不要假设剩下的内容：需要更多行就带上明确的 LIMIT/OFFSET 或更窄的 WHERE 重新查一次；'
  + '需要单列的完整内容（长文本/JSON/BLOB）就只 SELECT 那一列并把 LIMIT 设为 1。';
/** 预算被 summary / meta 挤到低于这个值时，宁可只给一句说明也不产出半截结构。 */
const MIN_USABLE_RESULT_CHARS = 512;
const NON_REPAIRABLE = new Set([
  'PERMISSION_DENIED',
  'APPROVAL_DENIED',
  'READONLY',
  'UNKNOWN_TOOL',
  'TABLE_DISABLED',
  'TABLE_SCOPE_REQUIRED',
  'METADATA_BLOCKED',
]);

/**
 * 把工具结果序列化成给模型看的文本，长度受 maxChars 约束。
 *
 * 两条裁剪路径都按预算算，不再按固定行数：
 *  - 行式结果逐行装箱，装到预算边为止。1M 窗口的模型一次能看到几百行，
 *    128K 的本地模型自动只看到几十行；原来那条「超过 50 行就砍到 50」的死规矩
 *    对两边都不对。
 *  - 非行式结果（schema、文件正文、MCP 文本）整块超预算时保留前缀，
 *    留开头永远比整块丢掉有用。
 * 两种情况都在尾部留一句续跑指引，模型才知道该带 LIMIT/OFFSET 再查一次。
 */
function serializeForModel(result: ToolResult, extra?: Record<string, unknown>, maxChars = MAX_MODEL_RESULT_CHARS): string {
  const budget = Math.max(0, Math.floor(maxChars));
  const whole = JSON.stringify({ ...result, ...(extra ?? {}) });
  if (whole.length <= budget) return whole;

  const rows = Array.isArray((result.data as { rows?: unknown[] } | undefined)?.rows)
    ? ((result.data as { rows: unknown[] }).rows as unknown[])
    : undefined;

  /** 外层字段保持和 whole 一致，只替换 data，模型读起来格式统一。 */
  const envelope = (data: unknown): string =>
    JSON.stringify({
      ok: result.ok,
      summary: result.summary,
      error: result.error,
      meta: { ...(result.meta as object | undefined), truncated: true },
      ...(extra ?? {}),
      data,
    });

  const omitted = (reason: string) => envelope(`(result omitted: ${reason})${RESULT_CONTINUATION_HINT}`);

  /**
   * 行式结果里「连第一行都装不进预算」时的兜底（典型是 GROUP_CONCAT 把整表列并成
   * 一行、或宽表单行超长）。整行丢掉会让模型连这一行的列名都看不到，只能瞎猜；
   * 这里保留该行的 JSON 前缀，并用显式占位符标注「行被截」，模型至少知道这行开头
   * 长什么样、该不该换更窄的查询去取全。
   */
  const singleRowPrefix = (omittedReason: string): string => {
    const single = rows?.[0];
    const text = typeof single === 'object' && single !== null ? JSON.stringify(single) : String(single ?? '');
    if (!text) return omitted(omittedReason);
    // 用和下面非行式路径一致的「实测回退」：JSON 转义会让正文变长，先估再试，越界就再让。
    const tail = `…(row truncated)${RESULT_CONTINUATION_HINT}`;
    let room = budget - envelope('').length - tail.length - 12;
    if (room <= 40) return omitted(omittedReason);
    for (let attempt = 0; attempt < 4; attempt++) {
      const built = envelope(`${text.slice(0, room)}${tail}`);
      if (built.length <= budget) return `${built}\n`;
      room -= built.length - budget + 8;
      if (room <= 40) break;
    }
    return omitted(omittedReason);
  };

  if (rows?.length) {
    const packed: unknown[] = [];
    // 估算就带上最终会出现的 rowRange / totalRows，装箱才不会差出几十字符。
    let bytes = envelope({ rows: packed, totalRows: rows.length, rowRange: '1-999' }).length + RESULT_CONTINUATION_HINT.length + 1;
    for (const row of rows) {
      const size = JSON.stringify(row).length + 1;
      if (bytes + size > budget) break;
      packed.push(row);
      bytes += size;
    }
    if (!packed.length) return singleRowPrefix('the current context budget is too small for even one row; narrow the query or request fewer columns');
    const built = `${envelope({ rows: packed, totalRows: rows.length, rowRange: `1-${packed.length}` })}\n${RESULT_CONTINUATION_HINT}`;
    // 装箱是估算，越界就丢掉最后一行重来，绝不把超预算的内容发给模型。
    if (built.length <= budget) return built;
    packed.pop();
    if (!packed.length) return singleRowPrefix('the current context budget is too small for even one row; narrow the query or request fewer columns');
    return `${envelope({ rows: packed, totalRows: rows.length, rowRange: `1-${packed.length}` })}\n${RESULT_CONTINUATION_HINT}`;
  }

  if (budget < MIN_USABLE_RESULT_CHARS) return omitted('the envelope alone fills the current context budget');
  const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null);
  // 外壳（ok/summary/meta/extra）的实际长度要量出来再决定 data 能留多少；
  // JSON 转义还会让正文变长，所以裁完必须实测一次，超了就按溢出量回退。
  const tail = `…(truncated)${RESULT_CONTINUATION_HINT}`;
  const shellLength = envelope('').length + tail.length + 8;
  let room = budget - shellLength;
  if (room <= 0 || !text) return omitted('the envelope alone fills the current context budget');
  for (let attempt = 0; attempt < 4; attempt++) {
    const built = envelope(`${text.slice(0, room)}${tail}`);
    if (built.length <= budget) return built;
    room -= built.length - budget + 8;
    if (room <= 0) break;
  }
  return omitted('the envelope alone fills the current context budget');
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

/**
 * 长回合中途压缩消息历史（不依赖任何 summarizer，无额外 LLM 调用）。
 *
 * 策略：从最老的开始，成对丢弃「assistant(工具调用) + 对应 tool 结果」，直到总 token
 * 落回预算内；首尾 user（历史起点令牌 + 当前回合提问）与最近几轮工具往返被保留。
 * 丢弃的最老结果用一条靠前的 user 占位说明顶替，让模型知道「前面有些结果因上下文
 * 预算被归档了」——否则它可能误以为那些步骤没发生过、或结果对不上而重复查询。
 *
 * 代价可接受：长工具回合的后续步骤通常只需要最近结果与当前计划；早先的查询数值
 * 若真被引用，模型会再查一次（这正是截断提示想让它做的）。
 */
function compactMessages(messages: ProviderMessage[], budget: number): ProviderMessage[] {
  const cjk = (s: string) => (s.match(/[一-鿿]/g) || []).length;
  const estimate = (m: ProviderMessage): number => {
    const text = 'content' in m ? String(m.content ?? '') : '';
    return 20 + Math.max(2, Math.ceil(cjk(text) * 1.3 + (text.length - cjk(text)) / 4)) + ('images' in m ? (m.images?.length ?? 0) * 1000 : 0);
  };
  const total = (list: ProviderMessage[]) => list.reduce((sum, m) => sum + estimate(m), 0);
  if (total(messages) <= budget) return messages;

  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  const out: ProviderMessage[] = [...messages];
  const trimmed: string[] = [];

  // 迭代地从最老开始，删「assistant(工具) + 随后最近的 tool」，直到达标。
  let guard = 0;
  while (total(out) > budget && guard < 200) {
    guard++;
    let found = false;
    for (let i = 1; i < out.length - 1; i++) {
      if (out[i].role === 'tool') {
        // tool 之前最近的 assistant（成对宿主的另一侧）
        let host = -1;
        for (let j = i - 1; j >= 0; j--) if (out[j].role === 'assistant') { host = j; break; }
        const start = host >= 0 ? host : i;
        out.splice(start, i - start + 1);
        trimmed.push(start === host ? 'assistant+tool' : 'tool');
        found = true;
        break;
      }
    }
    if (!found) {
      // 无可成对删的 tool（只剩 user/纯文本 assistant），删最老非 user
      for (let i = 1; i < out.length - 1; i++) {
        if (out[i].role !== 'user') { out.splice(i, 1); trimmed.push('message'); found = true; break; }
      }
    }
    if (!found) break; // 剩头尾 user，删无可删
  }

  if (trimmed.length) {
    // 在第一个 user 之后插一条说明，功劳真话：别让模型以为归档步骤从没发生。
    const note = `[context trimmed] 早先的 ${trimmed.length} 段工具往返因接近上下文预算被折叠，结果与中间推理已归档。回答仍不确定的数值时，请务必重新查询，不要凭印象。`;
    out.splice(firstUserIdx + 1, 0, { role: 'user', content: note });
  }

  // 极端：单条消息本身超预算（超宽单行）。保头尾 user，中间宁可空。
  if (total(out) > budget) {
    const tail = out.length > firstUserIdx + 1 ? out.slice(-1) : [];
    const head = firstUserIdx >= 0 ? out.slice(0, firstUserIdx + 1) : [];
    return [...head, ...tail];
  }
  return out;
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
      error?.code === 'SCRIPT_TOO_LARGE'
        ? '这段脚本的语句条数超过单次上限。请分批执行：每批控制在合理条数内，逐次调用 run_sql，确认上一批结果后再继续。'
        : (suggestions.length ? '优先使用 suggestions 中的真实标识符；' : '') +
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
    let messages: ProviderMessage[] = [
      ...input.history,
      { role: 'user', content: input.userText, ...(input.images?.length ? { images: input.images } : {}) },
    ];
    let finalText = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheHitTokens = 0;
    let cacheMissTokens = 0;
    /** 服务商是否真的返回过缓存统计——没返回过就不能对外报 0%。 */
    let cacheReported = false;
    let modelCalls = 0;
    let steps = 0;
    /** 最近一次模型调用的输入 tokens，即当前上下文占用。 */
    let contextTokens = 0;
    /** 本回合模型调用的总耗时；tok/s 要用它而不是墙钟时间，否则工具执行会被算进生成速度。 */
    let modelDurationMs = 0;
    let toolCount = 0;
    let sqlRepairs = 0;
    let plan: AgentPlanItem[] = [];
    let toolsSincePlan = 0;

    const usageSummary = () => ({
      tokensIn,
      tokensOut,
      ...(cacheReported ? { cacheHitTokens, cacheMissTokens: cacheMissTokens || Math.max(0, tokensIn - cacheHitTokens) } : {}),
    });

    /**
     * 单条工具结果的字符预算。每次调用都重新算：contextTokens 随模型调用增长，
     * 所以开局能给一大块、跑到后半程自动收窄，不会在第 10 步把窗口顶穿。
     */
    const resultBudget = () => {
      try {
        return deps.resultCharBudget?.(contextTokens) ?? MAX_MODEL_RESULT_CHARS;
      } catch {
        return MAX_MODEL_RESULT_CHARS;
      }
    };

    deps.emit({ type: 'start', turnId, sessionId: input.sessionId, model: deps.provider.label });
    if (input.context.memories?.length) {
      deps.emit({
        type: 'memory_used',
        memories: input.context.memories.map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
      });
    }

    /** 回合收尾统一发一次累计用量：状态条上的步数、缓存命中都靠这条事件定格。 */
    const emitTurnUsage = (): void => {
      deps.emit({
        type: 'turn_usage',
        steps,
        modelCalls,
        tokensIn,
        tokensOut,
        contextTokens,
        modelDurationMs,
        ...(cacheReported ? { cacheHitTokens, cacheMissTokens: cacheMissTokens || Math.max(0, tokensIn - cacheHitTokens) } : {}),
      });
    };

    /**
     * 本步的正文与思考。声明在回合层而不是循环体内：三条出口（正常推进、服务商报错、
     * 回合收尾）要读到同一份，声明在循环里就得复制三遍取法。
     */
    let stepText = '';
    let stepThinking = '';

    /**
     * 把这一步的正文/思考整段交付给消费方（step_text / step_thinking），然后清空。
     *
     * 为什么需要：finalText 会把所有步骤的正文拼成一坨，「哪段话在哪个工具之前说」当场消失，
     * 界面只能把工具堆上、文字堆下。这里补回边界，finalText 原样保留（搜索、导出、
     * 会话摘要都靠它，不能动）。
     *
     * 正文与思考分开发：中止可能发生在模型调用之后、工具执行之中——那时正文已经随
     * 步骤推进交付过，思考还留着。合并成一个函数会把残留思考用**上一步的步号**重发一遍，
     * 界面就会看到同一段思考挂错步骤。
     */
    const commitStepText = (): void => {
      // 正文在边界处入账，而不是在「模型没再调工具」那个分支里：中止与调用失败也走
      // 这里。过去半截正文只发过 text_delta——屏幕上看得见，result.text 里没有，
      // 于是落库与回灌给模型的上下文里那句话凭空消失，续跑时等于没说过。
      if (stepText.trim()) {
        finalText += (finalText ? '\n\n' : '') + stepText;
        deps.emit({ type: 'step_text', text: stepText.trim(), step: steps });
      }
      stepText = '';
    };
    const commitStepThinking = (): void => {
      if (stepThinking.trim()) deps.emit({ type: 'step_thinking', text: stepThinking.trim(), step: steps });
      stepThinking = '';
    };
    const commitStep = (): void => {
      commitStepText();
      commitStepThinking();
    };

    const finish = (status: AgentRunResult['status'], error?: AgentRunResult['error']): AgentRunResult => {
      commitStep();
      emitTurnUsage();
      if (status === 'done') {
        deps.emit({ type: 'done', turnId, durationMs: now() - started, summary: finalText.slice(0, 280) });
      }
      return { text: finalText.trim(), status, usage: usageSummary(), steps, modelCalls, contextTokens, modelDurationMs, toolCalls: toolCount, plan, error };
    };

    /**
     * 中止文案必须诚实：停摆不是用户的选择。
     */
    const abortReason = (cause: AgentAbortCause): string =>
      cause === 'stalled' ? '模型连接无响应（可继续）' : '用户中止';

    /**
     * 中止原因由 runtime 自己判：**只有两种**——模型连接彻底不动了（stalled），或者用户点了停止。
     *
     * 曾经还有第三种 'timeout'：回合跑满固定分钟数就被上层掐断。已删——回合该不该结束
     * 取决于「还有没有进展」，而不是挂了多久；上层计时器看不见进展，只能连健康长回合一起掐。
     * 现在卡死的判定权在字节流那一层（见 providers/common.ts 的停摆阈值），它知道区别。
     */
    const aborted = (cause: AgentAbortCause = 'user'): AgentRunResult => {
      commitStep();
      emitTurnUsage();
      deps.emit({ type: 'aborted', turnId, reason: abortReason(cause), cause });
      return {
        text: finalText.trim(),
        status: 'aborted',
        usage: usageSummary(),
        steps,
        modelCalls,
        contextTokens,
        modelDurationMs,
        toolCalls: toolCount,
        plan,
        abortCause: cause,
      };
    };

    /**
     * 这里曾经有一个「时间预算快用完了」的软提醒，随回合级计时器一起删掉了。
     *
     * 它是计时器的同伙：提醒的存在只是因为「再不收敛就要被掐断」。没有掐断之后还留着它，
     * 等于让模型自己去做本来不该发生的提前收尾——用户看到的还是「跑一半就草草结论」，
     * 只是这次是模型听招呼，不是定时器动的手。长回合的收敛靠步数上限与上下文预算，
     * 两者都是「资源真的不够了」才说话，不是「时间到了」。
     */

    // 0 表示「无步数上限」：一直跑到模型主动结束、用户中止、或预算压缩后仍超窗为止。
    // 无限制不代表失去约束——真正约束来自上下文 token 预算（contextTokenBudget，见下）：
    // 它顶不住时会压缩早期工具结果，而不是把整回合掐掉。时间从来不是约束。
    for (let step = 0; maxSteps === 0 || step < maxSteps; step++) {
      if (input.signal?.aborted) return aborted();
      steps = step + 1;
      modelCalls++;

      // 中途压缩：上下文占用越过窗口预算时，把最早的几段「assistant+工具结果」折叠成一行说明，
      // 而不是让它们把窗口顶穿到最后服务商硬报 context 超限。长回合（尤其无步数上限）真正
      // 靠这一手保命——单条结果预算（resultCharBudget）只放缓新数据进窗，不回收已进窗的旧数据。
      const tokenBudget = deps.contextTokenBudget;
      if (tokenBudget && tokenBudget > 0 && contextTokens > 0 && contextTokens > tokenBudget) {
        const before = messages.length;
        messages = compactMessages(messages, tokenBudget);
        if (messages.length !== before) {
          deps.emit({
            type: 'text_delta',
            text: `\n[上下文已随预算压缩：早期工具结果被归档，共 ${before - messages.length} 条历史消息。不确定的数值会重新查询。]\n`,
          });
        }
      }

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
      // stepText / stepThinking 是回合层的变量（见 commitStep 注释）：上一步在出口处
      // 已经把它们交付并清空，这里直接复用，不能再声明一次把外层遮掉。
      let providerError: { code: string; message: string } | undefined;
      const callStarted = now();

      try {
        for await (const ev of deps.provider.stream(request, input.signal)) {
          if (input.signal?.aborted) break;
          if (ev.type === 'text') {
            stepText += ev.text;
            deps.emit({ type: 'text_delta', text: ev.text });
          } else if (ev.type === 'thinking') {
            stepThinking += ev.text;
            deps.emit({ type: 'thinking_delta', text: ev.text });
          } else if (ev.type === 'plan') {
            // 离线推理器没有模型可以调 update_plan，计划由规划器直接给出。
            plan = ev.items.slice(0, 20);
            deps.emit({ type: 'plan', items: plan });
          } else if (ev.type === 'tool_call') {
            calls.push(ev.call);
          } else if (ev.type === 'usage') {
            tokensIn += ev.tokensIn;
            tokensOut += ev.tokensOut;
            // 单次调用的输入 tokens 就是这一刻的上下文占用
            contextTokens = ev.tokensIn;
            if (ev.cacheHitTokens !== undefined || ev.cacheMissTokens !== undefined) {
              cacheReported = true;
              cacheHitTokens += ev.cacheHitTokens ?? 0;
              cacheMissTokens += ev.cacheMissTokens ?? 0;
            }
            deps.emit({
              type: 'usage',
              tokensIn: ev.tokensIn,
              tokensOut: ev.tokensOut,
              durationMs: now() - callStarted,
              ...(ev.cacheHitTokens !== undefined ? { cacheHitTokens: ev.cacheHitTokens } : {}),
              ...(ev.cacheMissTokens !== undefined ? { cacheMissTokens: ev.cacheMissTokens } : {}),
            });
          }
        }
      } catch (err: any) {
        if (input.signal?.aborted || err?.name === 'AbortError') return aborted();
        // 字节流停摆：连接彻底不动了，多等一秒也不会变。它不是「调用失败」——
        // 报 error 会让界面显示红色失败并丢掉续跑检查点，而进度其实还在。
        if (err?.code === PROVIDER_STALL_CODE) return aborted('stalled');
        providerError = { code: err?.code ?? 'PROVIDER_ERROR', message: err?.message ?? '模型调用失败' };
      }
      // 模型调用的耗时单独累计：tok/s 只该反映生成速度，不该被工具执行时间稀释
      modelDurationMs += now() - callStarted;
      if (input.signal?.aborted) return aborted();
      if (providerError) {
        // 半截正文与思考也要交边界：调用方按 step_text/step_thinking 分段渲染，漏发会让
        // 界面里「这一步说过的话」凭空消失，而 text_delta 已经把它打在屏幕上了。
        commitStep();
        emitTurnUsage();
        deps.emit({ type: 'error', code: providerError.code, message: providerError.message, retryable: true });
        return { text: finalText.trim(), status: 'error', usage: usageSummary(), steps, modelCalls, contextTokens, modelDurationMs, toolCalls: toolCount, plan, error: providerError };
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
      // 正文入账交给 commitStepText（下面那一步边界），这里不再自己拼一次，否则
      // XML 兜底改写过的文本会在 finalText 里出现两遍。
      if (!calls.length) return finish('done');

      // 步骤边界：这一步的话说完了，下面就是它的工具。放在这里而不是循环末尾——
      // 工具执行期间也可能被中止，先把边界发出去，中止后界面里这段还在。
      // 思考一起交：否则它会一路累积到回合结束、整坨挂在最后一步上。
      // 先取正文再提交：commitStepText 会清空 stepText（它现在负责把正文入账到 finalText）。
      const assistantText = stepText;
      commitStep();
      messages.push({ role: 'assistant', content: assistantText, toolCalls: calls });

      let planUpdatedThisStep = false;
      for (const call of calls) {
        if (input.signal?.aborted) return aborted();
        toolCount++;
        const tool = (deps.getTool ?? getTool)(call.name);
        if (!tool) {
          const res = toolFailed(`未知工具：${call.name}`, 'UNKNOWN_TOOL');
          deps.emit({ type: 'tool_result', callId: call.id, tool: call.name, result: res });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res, undefined, resultBudget()) });
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
          toolsSincePlan = 0;
          planUpdatedThisStep = true;
          const res: ToolResult = { ok: true, summary: `计划已更新（${plan.length} 项）`, data: { items: plan }, meta: { durationMs: 0 } };
          deps.emit({ type: 'tool_result', callId: call.id, tool: call.name, result: res });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res, undefined, resultBudget()) });
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
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res, undefined, resultBudget()) });
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
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeForModel(res, undefined, resultBudget()) });
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
        // repair / plan 提醒是往尾部追加的短句，这里先留出一点余量，
        // 免得拼完恰好越过预算。
        const budget = Math.max(1024, resultBudget() - 512);
        let modelContent = serializeForModel(res, { resultRef: call.id }, budget);
        if (call.name === 'run_sql' && !res.ok && typeof call.args.sql === 'string' && !NON_REPAIRABLE.has(res.error?.code ?? '')) {
          sqlRepairs += 1;
          modelContent = serializeForModel(res, {
            resultRef: call.id,
            repair: buildRepairHint(String(call.args.sql), res, input.context.databases, sqlRepairs),
          }, budget);
        }
        toolsSincePlan += 1;
        // 模型常常只在开头建一次计划就忘了更新：连续两个工具后仍停在旧状态时，
        // 在工具结果尾部追加一次提醒，让计划卡真的能走到 5/5。
        if (!planUpdatedThisStep && plan.length && toolsSincePlan >= 2 && plan.some((item) => item.status !== 'done')) {
          modelContent += '\n\n[plan reminder] The visible task plan is stale. Call update_plan now with the same items: mark finished steps done, mark the current step doing, then continue. Do not replace the plan with a shorter one.';
          toolsSincePlan = 0;
        }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: modelContent });
      }
    }

    if (!finalText) {
      // maxSteps=0 不会停在这里（循环只有在模型结束/中止时退出），但仍防御性地覆盖：
      // 若未来某处还在意步数上限，这里不能说出误导的「已达最大步数」。
      finalText = maxSteps === 0 ? '本回合已结束。' : '已达到本次最大工具步数（' + maxSteps + '），我先停在这里。可以继续提问，我会接着处理。';
      deps.emit({ type: 'text_delta', text: finalText });
    }
    return finish('done');
  }
}

export type { AgentEvent, Risk };
