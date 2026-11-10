import type { QuestionSuggestion } from './suggest';
import type {
  AgentContextBundle,
  AgentPlanItem,
  ConnectionConfig,
  DatabaseSchema,
  Environment,
  Memory,
  PermissionMode,
  Risk,
} from '../types';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: { code: string; message: string; hint?: string };
  meta: {
    durationMs: number;
    rowsAffected?: number;
    truncated?: boolean;
    backupPath?: string;
    /**
     * 长任务进度快照。只在执行结束时上报一次，不是流式推送。
     * 只有声明了 `progress.supported` 的功能对应的工具才填。
     */
    progress?: {
      current: number;
      total: number;
      /** 进度单位，与 capability.progress.unit 对应，如 'table' / 'row' / 'batch'。 */
      unit: string;
      /** 当前正在处理的对象名，如 'orders'。 */
      label?: string;
    };
    /** 终态 id，与 capability.states[].id 对应，供模型用 states[].phrase 组织汇报。 */
    state?: string;
  };
}

export type ToolRisk = Risk | 'dynamic';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: JsonSchema;
  /** Short, human readable argument summary used in tool cards. */
  summarize?: (args: Record<string, unknown>) => string;
}

export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** 随消息一起下发的图片，base64 不带 data: 前缀。 */
export interface ProviderImage {
  mime: string;
  base64: string;
}

export interface ProviderReasoning {
  level: string;
  value: string;
}

export type ProviderMessage =
  | { role: 'user'; content: string; images?: ProviderImage[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AgentSourceContext {
  connection: ConnectionConfig;
  databases: DatabaseSchema[];
  agentContext?: AgentContextBundle;
  glossary?: Memory[];
  sqlExamples?: Memory[];
  label?: string;
}

export interface AgentContextData {
  connection?: ConnectionConfig;
  databases?: DatabaseSchema[];
  /** 命令选中的多个源；存在时优先于 connection / databases。 */
  sources?: AgentSourceContext[];
  memories?: Memory[];
  /** 用户维护的表/列启用状态与业务语义；离线推理器同样据此收敛可用表。 */
  agentContext?: AgentContextBundle;
  /** 术语词典，供离线推理器把简称展开成业务全称。 */
  glossary?: Memory[];
  /** 用户登记的标准问答 SQL：离线推理器命中时直接沿用它的口径。 */
  sqlExamples?: Memory[];
  attachmentTables?: string[];
  /** 回复语言。离线推理器的文案按它切换；云端模型由 system prompt 决定。 */
  locale?: 'zh' | 'en';
}

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  tools: ProviderTool[];
  temperature?: number;
  maxTokens?: number;
  /** 当前推理档位；provider 各自决定怎么下发，value 为空的档位不会走到这里。 */
  reasoning?: ProviderReasoning;
  context?: AgentContextData;
}

/**
 * 一次模型调用的用量明细。
 * 缓存字段各服务商叫法不同，provider 归一化到 cacheHitTokens / cacheMissTokens 后再上报；
 * 服务商不返回缓存信息时两个字段都缺省，调用方必须据此隐藏「缓存命中」而不是显示 0。
 */
export interface ProviderUsage {
  tokensIn: number;
  tokensOut: number;
  /** 命中提示词缓存的输入 tokens。 */
  cacheHitTokens?: number;
  /** 未命中提示词缓存的输入 tokens。 */
  cacheMissTokens?: number;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  /**
   * 直接给出可见的任务计划。
   *
   * 只有离线推理器会发：云端模型靠 update_plan 工具维护计划，规则规划器没有模型可以调工具，
   * 而发一次 update_plan 要多绕一个回合。
   */
  | { type: 'plan'; items: AgentPlanItem[] }
  | ({ type: 'usage' } & ProviderUsage)
  | { type: 'done'; stopReason: string };

export interface LlmProvider {
  id: string;
  label: string;
  stream(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always';
}

export interface ApprovalPayload {
  id: string;
  call: ToolCall;
  risk: Risk;
  summary: string;
  sql?: string;
  expiresAt: number;
}

/**
 * 一个回合为什么被中止。
 *
 * 区分它们是必须的：超时中止不是用户的选择，UI 不能继续显示「已中止」，
 * 上层也要据此写「可续跑」的检查点——用户点停止时不该替他留续跑提示。
 */
export type AgentAbortCause = 'timeout' | 'user';

export type AgentEvent =
  | { type: 'start'; turnId: string; sessionId: string; model: string }
  | { type: 'text_delta'; text: string }
  /** 模型把工具调用当文本吐出来时，更正已经流出去的正文。 */
  | { type: 'text_replace'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; callId: string; tool: string; args: unknown; risk: Risk; summary: string }
  | { type: 'tool_result'; callId: string; tool: string; result: ToolResult }
  | { type: 'approval_required'; approvalId: string; call: { tool: string; args: unknown; risk: Risk; summary: string; sql?: string }; expiresIn: number }
  | { type: 'approval_resolved'; approvalId: string; decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' }
  | { type: 'plan'; items: AgentPlanItem[] }
  | { type: 'memory_used'; memories: { id: string; title: string; kind: string }[] }
  | { type: 'suggestions'; items: QuestionSuggestion[] }
  /** 单次模型调用的用量；一次 agent 回合可能因为多步工具循环而发出多次。 */
  | ({ type: 'usage'; durationMs: number } & ProviderUsage)
  /** 一次 agent 回合结束时的累计用量与步数。 */
  | {
      type: 'turn_usage';
      steps: number;
      tokensIn: number;
      tokensOut: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
      modelCalls: number;
      /** 最近一次模型调用的输入 tokens，即当前上下文占用。 */
      contextTokens: number;
      /** 本回合模型调用的总耗时（不含工具执行），用于算真实的 tok/s。 */
      modelDurationMs: number;
    }
  | { type: 'done'; turnId: string; durationMs: number; summary?: string }
  /** cause 让界面不必从 reason 里猜是超时还是用户点的停止。 */
  | { type: 'aborted'; turnId: string; reason: string; cause?: AgentAbortCause }
  | { type: 'error'; code: string; message: string; retryable?: boolean };

export interface AgentRunInput {
  sessionId: string;
  userText: string;
  /** 本轮附带的图片，仅在模型档案声明支持图片输入时由 Bridge 传入。 */
  images?: ProviderImage[];
  mode: PermissionMode;
  connection?: ConnectionConfig;
  environment: Environment;
  connectionReadonly: boolean;
  history: ProviderMessage[];
  context: AgentContextData;
  sessionAllowed?: Set<string>;
  alwaysAllowed?: Set<string>;
  signal?: AbortSignal;
  /**
   * 本回合的截止时间（毫秒时间戳）。给了之后 runtime 才有「预算」概念：
   * 每步工具结果后按剩余时间追加软提醒。省略时完全无副作用。
   */
  deadlineAt?: number;
  /** 本回合的时间预算，只用于把「已用/剩余」说成人话；省略时用 deadlineAt 与开局时间推算。 */
  turnBudgetMs?: number;
  /**
   * 中止原因取器。用函数而不是快照值：abort 可能发生在 run() 已经拿到 input 之后，
   * 快照会永远读到「还没超时」。上层（agentHost）只需翻转自己的标记。
   */
  abortCause?: () => AgentAbortCause;
}

export interface AgentRuntimeDeps {
  provider: LlmProvider;
  buildSystem: (input: AgentRunInput) => string;
  executeTool: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
  requestApproval: (payload: ApprovalPayload) => Promise<ApprovalDecision>;
  emit: (event: AgentEvent) => void;
  generateId: () => string;
  now?: () => number;
  maxSteps?: number;
  temperature?: number;
  /** 当前模型档案里的最大输出 tokens；未配置时由 provider 兜底。 */
  maxTokens?: number;
  /**
   * 单条工具结果给模型看的字符预算。用函数而不是常量：预算要跟着本回合已用掉的
   * 上下文走（开局给得多，越跑越紧），上层通常按「窗口 − 已用 − 输出 − 提示词余量」推。
   * 省略时 runtime 用固定的 16000 兜底。
   */
  resultCharBudget?: (usedContextTokens: number) => number;
  reasoning?: ProviderReasoning;
  /** 本轮下发给模型的工具；缺省使用全局 40+ 工具目录。 */
  tools?: ProviderTool[];
  /** 命令私有工具的定义解析；缺省只认全局工具目录。 */
  getTool?: (name: string) => ToolDefinition | undefined;
}
