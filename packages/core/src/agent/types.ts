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
 * 'user' 之外只留 'stalled'：模型/连接彻底不动了，多等一秒都不会变。
 * 曾经还有个 'timeout'（回合跑满固定分钟数就被掐断），已删——回合该不该结束由
 * 「还有没有进展」决定，不由挂钟决定；健康长回合被计时器掐断是纯粹的浪费，
 * 用户看到的还是「跑到一半莫名其妙停了」。
 *
 * 区分仍然是必须的：停摆中止不是用户的选择，UI 不能继续显示「已中止」，
 * 上层也要据此写「可续跑」的检查点——用户点停止时不该替他留续跑提示。
 */
export type AgentAbortCause = 'stalled' | 'user';

/**
 * 一个「正常返回」的回合究竟是怎么结束的。
 *
 * 存在这条类型的理由：'done' 曾经把三种完全不同的事混成同一个状态——模型真说完了、
 * 输出被 max_tokens 拦腰截断（常发生在工具调用写一半时，界面看起来就是「莫名其妙停了，
 * 计划还转着圈」）、工具步数跑到上限。前两种尤其必须区分：截断不是结束，是事故。
 */
export type AgentStopReason =
  /** 模型自己说完了。 */
  | 'end_turn'
  /** 输出撞到 max_tokens 被截断；工具调用可能只写了一半。 */
  | 'max_output_tokens'
  /** 跑满 maxSteps 步数上限。 */
  | 'max_steps'
  /**
   * 模型这一轮既没说正文也没发起工具调用，等于空转一圈就返回。
   *
   * 它和 end_turn 必须分开：end_turn 是「我做完了」，空回复是「我什么都没给」。
   * 混在一起时界面只能显示一个空的完成，计划卡还停在执行中——正是
   * 「莫名其妙停了、也说不出原因」里最难查的那一种。
   *
   * 调用失败不在这份表里：那种出口自己带 code（PROVIDER_ERROR 等），且刻意不写
   * 续跑检查点——失败的原因可能是鉴权、额度或参数，替用户留一句「可以继续」没意义。
   */
  | 'empty_response'
  /**
   * 与服务端的连接静默到上限，客户端主动断开（客户端侧观察，服务商不会发这个值）。
   *
   * 半开的 TCP 既不报错也不结束，不认出来就只能永远等在 read() 上。它和停摆同族：
   * 用户没点停止、事也没做完。
   *
   * runtime 看不见这个值——signal.aborted 在它眼里就是「用户中止」。落点在服务端：
   * SSE 的连接关闭由 `AgentHost.abort(sessionId, 'disconnected')` 登记，续跑检查点
   * 据此而写。本成员目前只活在客户端（store 把它挂到 live.stop 上，界面据此给「继续」）。
   */
  | 'channel_idle';

/** 服务商 stop_reason 里表示「输出被截断」的取值（OpenAI 系 length，Anthropic 系 max_tokens）。 */
export function isTruncatedStop(reason: string | undefined): boolean {
  if (!reason) return false;
  return /^(length|max_tokens|max_output_tokens|incomplete)$/i.test(reason);
}

/**
 * 回合没做完就结束的那些原因。界面据此给「继续」，服务端据此写续跑检查点。
 *
 * end_turn 不在里面：那是模型自己说完了，不该催用户继续。
 */
export const UNFINISHED_STOP_REASONS = ['max_output_tokens', 'max_steps', 'empty_response', 'channel_idle'] as const;

export function isUnfinishedStop(reason: AgentStopReason | undefined): boolean {
  return Boolean(reason && (UNFINISHED_STOP_REASONS as readonly string[]).includes(reason));
}

export type AgentEvent =
  | { type: 'start'; turnId: string; sessionId: string; model: string }
  | { type: 'text_delta'; text: string }
  /** 模型把工具调用当文本吐出来时，更正已经流出去的正文。 */
  | { type: 'text_replace'; text: string }
  | { type: 'thinking_delta'; text: string }
  /**
   * 单步正文收尾：把这一步模型说的话整段交付，用于把文字与工具调用按真实顺序交错渲染。
   *
   * text_delta 只是打字机增量，步骤边界在它里面不存在 —— 过去所有步骤的正文被拼成
   * 一个字符串（runtime 里的 finalText），「哪段话是哪个工具之前说的」在落盘前就丢了，
   * 界面只能「工具堆在上、文字堆在下」。本事件不替代 text_delta（流式照旧），
   * 只在每步结束时补一个边界，消费方按需分段。
   */
  | { type: 'step_text'; text: string; step: number }
  /** 同 step_text：这一步的思考过程整段交付，让思考挂在对应步骤上而不是一坨置顶。 */
  | { type: 'step_thinking'; text: string; step: number }
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
  /**
   * 回合结束。`stop` 说明**为什么**结束；老客户端忽略这个字段仍然能正常渲染。
   *
   * 界面不能只靠 status==='done' 决定要不要让计划继续转圈：截断与跑满步数也是 done，
   * 但那不代表计划做完了。
   */
  | { type: 'done'; turnId: string; durationMs: number; summary?: string; stop?: AgentStopReason }
  /** cause 让界面不必从 reason 里猜是超时还是用户点的停止。 */
  | { type: 'aborted'; turnId: string; reason: string; cause?: AgentAbortCause }
  /**
   * 服务商报错终止。
   *
   * `stop` 不是装饰：输出连写两次都超出上限时，回合是以 error 收场的（没有 done 事件），
   * 界面若只看 done 事件上的 stop，恰好在这个最需要「继续」按钮的分支里给不出按钮。
   * 只有如实知道回合没做完的分支才填它——普通调用失败不填，那种情况没有续跑检查点。
   */
  | { type: 'error'; code: string; message: string; retryable?: boolean; stop?: AgentStopReason };

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
  /**
   * 本回合累积的可控词元预算。上下文占用触及它时，runtime 会压缩/丢弃最早的
   * 工具结果，保证长回合（尤其 maxSteps=0 无限制）不会把窗口顶穿、也不会在
   * 循环中途被服务商硬截断。省略时不做中途压缩（行为与改造前一致）。
   * 0 或空也表示「不设限、不压缩」。
   */
  contextTokenBudget?: number;
  reasoning?: ProviderReasoning;
  /** 本轮下发给模型的工具；缺省使用全局 40+ 工具目录。 */
  tools?: ProviderTool[];
  /** 命令私有工具的定义解析；缺省只认全局工具目录。 */
  getTool?: (name: string) => ToolDefinition | undefined;
}
