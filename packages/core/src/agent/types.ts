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

export interface AgentContextData {
  connection?: ConnectionConfig;
  databases?: DatabaseSchema[];
  memories?: Memory[];
  /** 用户维护的表/列启用状态与业务语义；离线推理器同样据此收敛可用表。 */
  agentContext?: AgentContextBundle;
  /** 术语词典，供离线推理器把简称展开成业务全称。 */
  glossary?: Memory[];
  attachmentTables?: string[];
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

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
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
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'done'; turnId: string; durationMs: number; summary?: string }
  | { type: 'aborted'; turnId: string; reason: string }
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
  reasoning?: ProviderReasoning;
}
