import type { AgentPlanItem, QueryBatchResult, Risk, ToolResult } from '@aidb/core';

export type TabKey = 'chat' | 'data' | 'tools' | 'me';

export interface LiveTool {
  callId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  status: 'running' | 'ok' | 'error' | 'awaiting';
  summary?: string;
  result?: ToolResult;
}

/** 与桌面端 store.ts 的 TimelineItem 同一形状：顺序即发生顺序。 */
export type TimelineItem =
  | { kind: 'thinking'; text: string; step?: number }
  | { kind: 'text'; text: string; step?: number }
  | { kind: 'tool'; callId: string };

export interface LiveTurn {
  userText: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  timeline: TimelineItem[];
  /** 当前这一步还没交付的正文/思考（step_text / step_thinking 一到就清空并入 timeline）。 */
  stream: string;
  streamThinking: string;
  plan: AgentPlanItem[];
  status: 'streaming' | 'awaiting' | 'done' | 'aborted' | 'error';
  /** 中止事由：连接停摆不是用户点的停止，不能一律显示「已中止」。 */
  abortReason?: string;
  error?: string;
  startedAt: number;
  memories: Array<{ id: string; title: string; kind: string }>;
}

export interface ApprovalState {
  approvalId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  summary: string;
  sql?: string;
}

export type SqlSet = QueryBatchResult['sets'][number];

export type PickerKind = 'sessions' | 'databases' | 'connections' | 'tables' | null;

export interface MemoryDraft {
  id?: string;
  kind: string;
  title: string;
  content: string;
}

export interface RenameTarget {
  id: string;
  title: string;
}

/** 与 react-native-safe-area-context 的 EdgeInsets 结构兼容，供 sheet props 使用。 */
export interface EdgeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
