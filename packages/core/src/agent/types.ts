import type {
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

export type ProviderMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AgentContextData {
  connection?: ConnectionConfig;
  databases?: DatabaseSchema[];
  memories?: Memory[];
  attachmentTables?: string[];
}

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  tools: ProviderTool[];
  temperature?: number;
  maxTokens?: number;
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
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; callId: string; tool: string; args: unknown; risk: Risk; summary: string }
  | { type: 'tool_result'; callId: string; tool: string; result: ToolResult }
  | { type: 'approval_required'; approvalId: string; call: { tool: string; args: unknown; risk: Risk; summary: string; sql?: string }; expiresIn: number }
  | { type: 'approval_resolved'; approvalId: string; decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' }
  | { type: 'plan'; items: AgentPlanItem[] }
  | { type: 'memory_used'; memories: { id: string; title: string; kind: string }[] }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'done'; turnId: string; durationMs: number; summary?: string }
  | { type: 'aborted'; turnId: string; reason: string }
  | { type: 'error'; code: string; message: string; retryable?: boolean };

export interface AgentRunInput {
  sessionId: string;
  userText: string;
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
}
