import type { Risk } from '../types';

export type CommandId = 'report' | 'compare' | 'diff' | 'recon' | 'fix' | 'ask';
export type CommandExecution = 'deterministic' | 'agent' | 'hybrid';
export type CommandGroup = 'analysis' | 'compare' | 'ops' | 'general';
export type ArtifactType = 'report' | 'compare' | 'diff' | 'recon' | 'fix';

export interface CommandSourceSpec {
  min: number;
  max: number;
  /** 是否允许同一连接出现两次（例如同一连接的两个库）。 */
  allowSameConnection: boolean;
  /** 是否需要显式选择数据库。 */
  database: 'optional' | 'required' | 'none';
}

export type CommandSlotKind =
  | 'source'
  | 'sources'
  | 'database'
  | 'tables'
  | 'text'
  | 'period'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'mapping';

export interface CommandSlotOption {
  value: string;
  label: { zh: string; en: string };
}

export interface CommandSlot {
  key: string;
  kind: CommandSlotKind;
  label: { zh: string; en: string };
  required?: boolean;
  placeholder?: string;
  options?: CommandSlotOption[];
  min?: number;
  max?: number;
  default?: unknown;
  /** 高级选项默认折叠。 */
  advanced?: boolean;
}

export interface CommandDefinition {
  id: CommandId;
  aliases: string[];
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  group: CommandGroup;
  icon: string;
  sources: CommandSourceSpec;
  slots: CommandSlot[];
  execution: CommandExecution;
  maxRisk: Risk;
  artifact?: ArtifactType;
  /** 自定义表单渲染器；默认 'default'，/recon 使用 'recon'。 */
  form?: 'default' | 'recon';
  /** 命令内允许调用的全局工具；缺省继承全局权限。 */
  allowedTools?: string[];
  /** 命令私有工具（只在本命令的 Agent 步骤中可见，不进入 40 工具目录）。 */
  extraTools?: string[];
  /** 生成阶段使用的系统提示片段。 */
  prompt?: string;
}

export interface CommandSourceInput {
  connectionId: string;
  database?: string;
  /** 表单里的显示名，例如“生产库”“Redis 缓存”。 */
  label?: string;
}

export interface CommandRunInput {
  sources?: CommandSourceInput[];
  tables?: string[];
  [key: string]: unknown;
}

export type CommandRunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';

export interface CommandStepInfo {
  id: string;
  label: string;
  kind: 'deterministic' | 'agent';
  status: 'pending' | 'running' | 'ok' | 'error' | 'canceled';
  summary?: string;
  error?: { code: string; message: string };
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface CommandRunInfo {
  id: string;
  command: CommandId;
  title: string;
  status: CommandRunStatus;
  input: CommandRunInput;
  steps: CommandStepInfo[];
  artifactId?: string;
  error?: { code: string; message: string };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export type CommandRunEvent =
  | { type: 'run_started'; seq: number; runId: string; command: CommandId; startedAt: string }
  | { type: 'step_started'; seq: number; runId: string; stepId: string; label: string; kind: 'deterministic' | 'agent' }
  | { type: 'step_progress'; seq: number; runId: string; stepId: string; message: string; current?: number; total?: number }
  | { type: 'step_succeeded'; seq: number; runId: string; stepId: string; summary: string; durationMs: number }
  | { type: 'step_failed'; seq: number; runId: string; stepId: string; error: { code: string; message: string } }
  | { type: 'artifact_ready'; seq: number; runId: string; artifactId: string; artifactType: ArtifactType; title: string }
  | { type: 'run_finished'; seq: number; runId: string; status: 'succeeded' | 'failed' | 'canceled'; durationMs: number }
  | { type: 'error'; seq: number; runId: string; code: string; message: string };

type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;
export type CommandRunEventInput = WithoutSeq<CommandRunEvent>;

export interface ArtifactSpec {
  version: 1;
  type: ArtifactType;
  title: string;
  sources?: CommandSourceInput[];
  [key: string]: unknown;
}

export interface ArtifactInfo {
  id: string;
  type: ArtifactType;
  title: string;
  spec: ArtifactSpec;
  status: 'draft' | 'ready' | 'running' | 'error';
  scheduleId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRunInfo {
  id: string;
  artifactId: string;
  status: CommandRunStatus;
  steps?: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface ArtifactScheduleInfo {
  id: string;
  artifactId: string;
  intervalSeconds: number;
  enabled: boolean;
  refreshNarrative: boolean;
  notifyChannels: string[];
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
}

export type NotificationChannelType = 'feishu' | 'wecom' | 'qq-onebot' | 'dingtalk' | 'slack' | 'discord' | 'telegram';

export interface NotificationChannelInfo {
  id: string;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  /** 脱敏后的目标摘要，例如飞书/企微 webhook 主机或 OneBot endpoint。 */
  summary?: string;
  createdAt: string;
  updatedAt: string;
}


import type { BuiltinMcpKind } from '../agent/builtinMcp';

export interface McpServerInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  /** Set when the server is a first-party built-in; command is `builtin:<kind>`. */
  builtin?: BuiltinMcpKind;
  createdAt: string;
  updatedAt: string;
}
