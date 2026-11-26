import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  activeReasoningTier,
  AgentRuntime,
  buildSystemPrompt,
  buildReportBrief,
  builtinMcpServer,
  compactHistory,
  createProvider,
  extractHeuristicMemories,
  formatPeriodForPrompt,
  formatReportBriefForPrompt,
  getModelProfile,
  getTool,
  historyTokenBudget,
  providerTools,
  redactToolSecrets,
  maxOutputTokensOf,
  modelResultCharBudget,
  midContextTokenBudget,
  resolvePeriod,
  suggestFollowUps,
  supportsInput,
  tablesFromSql,
  disabledTableInSql,
  CAPABILITIES,
  isCallable,
  isDevicePermissionMode,
  type Capability,
  type AgentContextBundle,
  type AgentEvent,
  type AgentMessage,
  type AgentMessageBlock,
  type AgentRunInput,
  type AgentResumeCause,
  type AppSettings,
  type ApprovalDecision,
  type ApprovalPayload,
  type DatabaseSchema,
  type Memory,
  type MemoryCandidate,
  type PermissionMode,
  type ProviderImage,
  type ProviderMessage,
  type QuestionSuggestion,
  type Risk,
  type ToolCall,
  type ToolResult,
  type AgentPlanItem,
} from '@aidb/core';
import type { GatewayConfig } from './config';
import { DbError } from './drivers';
import { throwIfAborted } from './drivers/timeout';
import type { ToolExecutor } from './executor';
import type { ConnectionManager } from './manager';
import type { Store } from './store';
import type { AgentTurnClaim, AgentTurnStatus } from './store/runtime';
import { currentCorrelationId, logGateway, type AlertSender, type GatewayLogger, type GatewayMetrics } from './observability';
import type { SkillStore } from './skills';
import { readAttachment } from './attachments';
import { allTableScanNeedsScope, disabledTableTarget, disabledToolError, filterDisabledObjects, metadataBlockedError, scopeRequiredError, systemCatalogQuery } from './agentContextGuard';
import {
  briefPathFromRegistry,
  briefPromptBlock,
  composeDatabaseBrief,
  defaultBriefPath,
  loadBrief,
  readBrief,
  summarizeInit,
  writeDatabaseBrief,
  type LoadedBrief,
} from './features/databaseBrief';
import { parseCommandIntent } from './commandIntents';

/**
 * 工具结果落库/推送的尺寸上限。驱动层已按字节封顶源头，但完整结果原样写进 SQLite、
 * 每回合 listMessages 全量读回、每个 WS 客户端再拿一份完整帧，长会话仍会把堆堆高。
 * UI 预览本来只渲染前几行，模型侧另有更紧的 serializeForModel 预算，这里按展示预算裁剪。
 */
const TOOL_RESULT_STORE_CHARS = 256 * 1024;

/** 超长的单元格字符串截到预算内，保留行结构（列数/列序不变）。 */
function capRowCells(row: unknown, cellBudget: number): unknown {
  if (!Array.isArray(row)) return row;
  return row.map((cell) => (typeof cell === 'string' && cell.length > cellBudget ? `${cell.slice(0, cellBudget)}…(truncated)` : cell));
}

export function capToolResult(result: ToolResult, maxChars = TOOL_RESULT_STORE_CHARS): ToolResult {
  const data = result.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.rows)) {
    const rows = data.rows as unknown[];
    const kept: unknown[] = [];
    let chars = 64;
    let modified = false;
    for (const row of rows) {
      let candidate = row;
      let size = JSON.stringify(row)?.length ?? 0;
      if (size > maxChars) {
        candidate = capRowCells(row, Math.floor(maxChars / 2));
        size = JSON.stringify(candidate)?.length ?? 0;
        modified = true;
      }
      if (kept.length > 0 && chars + size > maxChars) break;
      chars += size + 1;
      kept.push(candidate);
    }
    if (!modified && kept.length >= rows.length) return result;
    return {
      ...result,
      data: { ...data, rows: kept, truncated: true },
      meta: { ...result.meta, truncated: true },
    };
  }
  if (typeof result.data === 'string') {
    if (result.data.length <= maxChars) return result;
    return { ...result, data: `${result.data.slice(0, maxChars)}…(truncated)`, meta: { ...result.meta, truncated: true } };
  }
  if (data && typeof data === 'object') {
    const text = JSON.stringify(data);
    if (text.length <= maxChars) return result;
    return { ...result, data: { truncated: true, preview: text.slice(0, maxChars) }, meta: { ...result.meta, truncated: true } };
  }
  return result;
}

/** 工具入参同样可能巨大（write_file 的正文等）：只裁超长的字符串值，保留参数形状。 */
export function capToolArgs(args: unknown, maxChars = TOOL_RESULT_STORE_CHARS): unknown {
  args = redactToolSecrets(args);
  if (args === null || args === undefined || typeof args !== 'object' || Array.isArray(args)) return args;
  const text = JSON.stringify(args);
  if (text.length <= maxChars) return args;
  const cellBudget = Math.floor(maxChars / 4);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = typeof value === 'string' && value.length > cellBudget ? `${value.slice(0, cellBudget)}…(truncated)` : value;
  }
  return out;
}

export interface TurnInput {
  text: string;
  mode?: PermissionMode;
  attachments?: string[];
  /** 已上传到 Bridge 的图片附件 id。 */
  images?: string[];
  connectionId?: string;
  /** 本回合的目标库；缺省用会话记录的库，再缺省用连接默认库。 */
  database?: string;
  /** 调用方重试时复用，防止重复创建同一回合。 */
  idempotencyKey?: string;
  /** 机器人等远程入口不得触达本机 MCP（文件系统 / Git / 网页抓取）。 */
  disableMcp?: boolean;
}

/** 已鉴权请求的 Agent 能力上下文；device 必须同时携带持久化 ACL 中的 deviceId。 */
export interface AgentAccessContext {
  scope: 'admin' | 'device';
  deviceId?: string;
  connectionIds: readonly string[];
}

const ADMIN_ACCESS: AgentAccessContext = { scope: 'admin', connectionIds: [] };
const agentAccessStorage = new AsyncLocalStorage<AgentAccessContext>();

/** HTTP/WS 入口在调用 Host 前建立上下文；Host 仍会独立复核，不信任调用方入参。 */
export function runWithAgentAccess<T>(access: AgentAccessContext, callback: () => T): T {
  return agentAccessStorage.run(access, callback);
}

/**
 * device 只使用与当前授权数据库有关的正向工具白名单。连接/引擎管理、MCP、技能、
 * 记忆、历史、导入导出、备份与数据迁移不暴露给设备，也不能靠 prompt 约束绕过。
 */
const DEVICE_AGENT_TOOLS = new Set([
  'inspect_schema',
  'search_objects',
  'run_sql',
  'run_mql',
  'run_redis',
  'run_cypher',
  'run_cql',
  'run_aql',
  'vector_search',
  'upsert_document',
  'delete_documents',
  'write_line_protocol',
  'search_index',
  'create_collection',
  'delete_collection',
  'explain_sql',
  'sample_rows',
  'profile_column',
  'create_table',
  'alter_table',
  'drop_object',
  'manage_index',
  'begin_transaction',
  'commit_transaction',
  'rollback_transaction',
  'render_chart',
  'analyze_chart',
  'forecast_chart',
  'check_data_quality',
  'generate_data',
  'update_plan',
]);

export function isDeviceAgentToolAllowed(name: string): boolean {
  return DEVICE_AGENT_TOOLS.has(name);
}

export interface AgentHostOptions {
  store: Store;
  manager: ConnectionManager;
  executor: ToolExecutor;
  config: GatewayConfig;
  skills?: SkillStore;
  metrics?: GatewayMetrics;
  alerts?: AlertSender;
  logger?: GatewayLogger;
}

/** 绝对预算与 provider 字节停摆检测并存：前者限制资源占用，后者识别无进展连接。 */

/** 把毫秒说成「M 分 S 秒」，避免检查点里出现 493000 这种没人读的数字。 */
function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/**
 * 回合没跑完就结束时写进会话的「续跑检查点」。
 *
 * 为什么要单独写一条：回合中止/截断后 runtime 只留下半截正文，用户再问「继续」时，
 * 模型从历史里只能看到那半截，等于从零开始重新摸索——上一回合烧掉的时间白费。
 * 这条把「做到哪、剩下什么、下一步做什么」显式留在历史里，续跑才有落点。
 *
 * 触发条件是「非用户主动停止且没跑完」：连接停摆、客户端连接断开、输出被 max_tokens
 * 截断、空响应、跑满步数、服务商未完成。用户点停止不写检查点——那是他自己的决定，不该替他留一句「可以继续」。
 *
 * 措辞同时面向两类读者：模型（拿它当上下文继续干）和人（看懂为什么断在这里）。
 */
export function buildResumeCheckpoint(input: {
  plan: AgentPlanItem[];
  steps: number;
  toolCalls: number;
  elapsedMs: number;
  toolTrace: string[];
  /** 断在哪件事上；决定标题与正文的说法，不能一律写成「连接无响应」。 */
  cause?: AgentResumeCause;
}): string {
  const { plan, steps, toolCalls, elapsedMs, toolTrace, cause = 'stalled' } = input;
  const headline =
    cause === 'truncated'
      ? '本回合因模型回复超出输出上限而未完成（进度已保留，回复「继续」可接着做）'
      : cause === 'empty'
        ? '本回合模型没有给出内容就返回了（进度已保留，回复「继续」可接着做）'
        : cause === 'disconnected'
          ? '本回合因客户端连接中断而未完成（进度已保留，回复「继续」可接着做）'
          : cause === 'max_steps'
            ? '本回合跑满工具步数上限而未完成（进度已保留，回复「继续」可接着做）'
            : cause === 'provider_incomplete'
          ? '本回合因模型返回未完成状态而未完成（进度已保留，回复「继续」可接着做）'
          : cause === 'deadline'
            ? '本回合到达绝对时间预算而未完成（进度已保留，回复「继续」可接着做）'
            : cause === 'interrupted'
              ? '本回合因网关进程中断而未完成（进度已保留，回复「继续」可接着做）'
              : '本回合因模型连接无响应而中止（进度已保留，回复「继续」可接着做）';
  const why =
    cause === 'truncated'
      ? `已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）后，模型的回复连续写到超出单次输出上限，最后一步没有执行。这不是执行出错，也不是模型放弃——已完成的部分都算数。`
      : cause === 'empty'
        ? `已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）后，模型返回了一条空回复。已完成的部分都算数。`
      : cause === 'disconnected'
        ? `已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）后，界面那一侧的连接断了（页面关闭，或客户端判定通道无响应后主动断开），本回合因此中止。**没有人点过停止**，已完成的部分都算数。`
      : cause === 'max_steps'
        ? `已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）后，到达本次允许的工具步数上限，剩下的步骤没有执行。这不是执行出错，也不是模型放弃——已完成的部分都算数。续跑时把同类操作合并成批量写法，同样的工作量能少花很多步。`
      : cause === 'provider_incomplete'
        ? `已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）后，模型返回了内容过滤、暂停或上下文超限等未完成状态，不能视为正常结束。已完成的部分都算数。`
        : cause === 'deadline'
          ? `已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）后到达网关配置的绝对预算。已完成的部分都算数，未开始的写入不会自动恢复。`
          : cause === 'interrupted'
            ? `网关进程中断，已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）。已完成的部分都算数，未开始的写入不会自动恢复。`
            : `已跑 ${steps} 步、${toolCalls} 次工具调用（共 ${humanDuration(elapsedMs)}）后，模型端连续无响应，连接被判定为已死。这不是执行出错，也不是模型放弃——已完成的部分都算数。`;
  const lines: string[] = [`## ${headline}`, '', why];
  if (plan.length) {
    lines.push('', '计划状态：');
    for (const item of plan) {
      lines.push(`- [${item.status}] ${item.text}`);
    }
  } else {
    lines.push('', '计划状态：本回合没有登记计划，续跑时请先 update_plan 建立计划再动手。');
  }
  if (toolTrace.length) {
    const counts = new Map<string, number>();
    for (const tool of toolTrace) counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const rendered = [...counts.entries()].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join('、');
    lines.push('', `本回合已用工具：${rendered}。已有结果都在会话里，不要重复相同的读取。`);
  }
  const next = plan.find((item) => item.status === 'doing') ?? plan.find((item) => item.status === 'todo');
  lines.push(
    '',
    next
      ? `下一步：继续「${next.text}」。优先用一条语句覆盖多个对象的批量写法，减少往返。`
      : '下一步：接续上一个动作继续。已经拿到的结论不要重新查证；优先用批量写法减少往返。',
  );
  return lines.join('\n');
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
  turnId?: string;
  payload: ApprovalPayload;
  onAbort?: () => void;
}

interface ActiveTurn {
  id: string;
  ownerId: string;
  claim?: AgentTurnClaim;
  controller: AbortController;
  signal: AbortSignal;
  deadlineTimer?: NodeJS.Timeout;
  deadlineExpired: boolean;
  invalidated: boolean;
  abortCause?: 'user' | 'disconnected' | 'deadline';
  outcome: Exclude<AgentTurnStatus, 'running'>;
  started: boolean;
  seq: number;
  terminalEvent?: AgentEvent;
  finished: boolean;
  settled: Promise<void>;
  finish: () => void;
}

const MODES: PermissionMode[] = ['readonly', 'ask', 'auto', 'full'];

/** 一轮最多带几张图，再多只会让 prompt 变贵，不会更准。 */
const MAX_IMAGES_PER_TURN = 4;

/** ProviderImage 加附件标识，便于把图片写回消息 blocks。 */
interface AttachedImage extends ProviderImage {
  id: string;
  bytes: number;
}

async function imagesOf(blocks: AgentMessageBlock[], dir: string): Promise<AttachedImage[]> {
  const out: AttachedImage[] = [];
  for (const block of blocks) {
    if (block.type !== 'image' || !block.attachmentId) continue;
    const file = await readAttachment(dir, block.attachmentId);
    if (file) out.push({ id: block.attachmentId, mime: file.mime, base64: file.buffer.toString('base64'), bytes: file.buffer.length });
  }
  return out;
}

function toolResultContent(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

/**
 * 把落库的 blocks 还原成 ProviderMessage。工具调用必须保留完整参数，并且每条
 * tool_result 都要紧跟对应的 assistant.toolCalls；只留工具名会让下一轮模型
 * 忘记查过什么，而没有宿主的孤立 tool 消息则会被服务商直接拒绝。
 */
export async function providerHistory(messages: AgentMessage[], attachmentDir: string): Promise<ProviderMessage[]> {
  const history: ProviderMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const past = await imagesOf(message.blocks, attachmentDir);
      history.push({ role: 'user', content: message.content, ...(past.length ? { images: past } : {}) });
      continue;
    }
    if (message.role !== 'assistant' || (!message.content && !message.blocks.length)) continue;

    const resultIds = new Set(
      message.blocks.filter((block) => block.type === 'tool_result' && block.callId).map((block) => block.callId!),
    );
    const calls: ToolCall[] = [];
    const callIds = new Set<string>();
    for (const block of message.blocks) {
      // 中止发生在工具执行中时可能只有 call 没有 result；丢弃未完成的一对，
      // 否则下一轮会因 tool_calls 缺少对应 tool 消息而被服务商拒绝。
      if (block.type !== 'tool_call' || !block.callId || !block.tool || !resultIds.has(block.callId)) continue;
      calls.push({
        id: block.callId,
        name: block.tool,
        args: block.args && typeof block.args === 'object' && !Array.isArray(block.args)
          ? block.args as Record<string, unknown>
          : {},
      });
      callIds.add(block.callId);
    }
    if (!calls.length) {
      // 兼容没有 callId 的老 blocks：仍保留原来的工具摘要，不制造孤立 tool 消息。
      const trace = message.blocks.filter((block) => block.type === 'tool_call').map((block) => block.tool).filter(Boolean);
      history.push({
        role: 'assistant',
        content: `${message.content}${trace.length ? `\n\n[used tools: ${[...new Set(trace)].join(', ')}]` : ''}`.trim(),
      });
      continue;
    }
    history.push({ role: 'assistant', content: message.content, toolCalls: calls });
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || !block.callId || !callIds.has(block.callId)) continue;
      history.push({
        role: 'tool',
        toolCallId: block.callId,
        name: block.tool ?? calls.find((call) => call.id === block.callId)?.name ?? '',
        content: toolResultContent(block.result),
      });
    }
  }
  return history;
}

/** 压缩历史时按 tool_call/tool_result 整组保留，避免预算裁剪制造服务商拒绝的残对。 */
export function compactProviderHistory(messages: ProviderMessage[], maxTokens: number): ProviderMessage[] {
  const compacted = compactHistory(messages, maxTokens);
  const out: ProviderMessage[] = [];
  for (let i = 0; i < compacted.length;) {
    const message = compacted[i];
    if (message.role === 'tool') {
      // 压缩可能已裁掉对应的 assistant.toolCalls；孤立 tool 消息不能送给服务商。
      i += 1;
      continue;
    }
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      out.push(message);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < compacted.length && compacted[end].role === 'tool') end += 1;
    const results = compacted.slice(i + 1, end).filter((item) => item.role === 'tool');
    const resultIds = new Set(results.map((item) => item.toolCallId));
    if (message.toolCalls.every((call) => resultIds.has(call.id))) {
      out.push(message, ...results);
    } else if (message.content) {
      // 结果被预算裁掉时保留正文，但去掉不完整的 toolCalls。
      out.push({ role: 'assistant', content: message.content });
    }
    i = end;
  }
  return out;
}

/** Give the model the actual MCP catalog; guessing server names produces 404s. */
function mcpPromptBlock(store: Store): string {
  const servers = store.listMcpServers().filter((server) => server.enabled);
  if (!servers.length) return '## MCP servers\n(none configured — do not call MCP tools)';
  const lines = servers.map((server) => {
    const definition = server.builtin ? builtinMcpServer(server.builtin) : undefined;
    if (!definition) return `- ${server.id} — external server (name: ${server.name}); call mcp_list_tools for its tools.`;
    const tools = definition.tools.map((tool) => `${tool.name}(${tool.risk})`).join(', ');
    const args = server.args.length
      ? `${definition.argsLabel}: ${server.args.join(', ')}`
      : definition.kind === 'web'
        ? '域名限制: 未设置（允许所有公网地址；内网与回环始终拦截）'
        : `${definition.argsLabel}: (未配置，需用户在 设置 → MCP 与工具 配置)`;
    const searchNote = definition.kind === 'web' && server.enabled
      ? ' Use web_search for discovery (Exa/Parallel/Bing + optional keyed backends); use fetch_url only for a known URL.'
      : '';
    return `- ${server.id} — built-in ${definition.kind} (name: ${server.name}); ${args}. Tools: ${tools}.${searchNote}`;
  });
  return `## MCP servers\nUse the exact server id for mcp_list_tools / mcp_call; never guess a server name. For built-in tools you may omit \`server\` — it is inferred from the tool name. Built-in read tools run directly; writes need approval in ask mode.\n${lines.join('\n')}`;
}

/**
 * 把「软件自带功能」的目录注入系统提示。
 *
 * 模型必须知道：哪些功能可以直接用工具调、哪些只能引导用户去工具箱操作。
 * 没有这一段，模型会编造参数去发 REST 请求，或者谎称已经完成。
 *
 * 采用两级写法控制 token：可调用的功能给完整字段与状态；不可调用的压成一行，
 * 只留「去哪个工具箱模块操作」——它们本来就没有可填的参数。
 */
export function capabilityPromptBlock(capabilities: Capability[] = CAPABILITIES): string {
  if (!capabilities.length) return '## Capabilities\n(none registered)';
  const callable: string[] = [];
  const guideOnly: string[] = [];
  for (const capability of capabilities) {
    const head = `- ${capability.id} — ${capability.title.zh}：${capability.description}`;
    if (!isCallable(capability)) {
      guideOnly.push(`- ${capability.title.zh}（${capability.id}）：${capability.description} → 引导用户到「工具箱 → ${capability.title.zh}」，不要假装能执行`);
      continue;
    }
    const fields = capability.fields
      .map((field) => `${field.key}:${field.type}${field.required ? '*' : ''}`)
      .join(', ');
    const states = capability.states.map((state) => state.id).join('/');
    const lines = [
      head,
      `  Call: ${capability.tools.join(', ')}；参数 ${fields}`,
      `  States: ${states}`,
    ];
    if (capability.constraints?.length) lines.push(`  Limits: ${capability.constraints.slice(0, 2).join('；')}`);
    callable.push(lines.join('\n'));
  }
  return [
    '## Capabilities（软件自带功能）',
    '这些是产品自带的功能，不是你临时发明的能力。能用工具的直接调；「只能引导」的必须让用户去工具箱操作——**不要编造参数、不要声称已完成、不要自己拼 REST 请求**。结果按 States 里的话术汇报，不要自己编状态名。',
    callable.join('\n'),
    guideOnly.length ? `### 只能引导（无 Agent 工具）\n${guideOnly.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Tools visible to a turn; remote (bot/mobile/external WS) turns must not reach local MCP. */
export function visibleAgentTools(
  settings: Pick<AppSettings, 'features'>,
  allowMcp: boolean,
  restrictedDevice = false,
) {
  return providerTools().filter(
    (tool) =>
      (settings.features.skills || !tool.name.startsWith('skill_')) &&
      ((settings.features.mcp && allowMcp) || !tool.name.startsWith('mcp_')) &&
      (!restrictedDevice || DEVICE_AGENT_TOOLS.has(tool.name)),
  );
}

export class AgentHost {
  private active = new Map<string, ActiveTurn>();
  /** 删除会话期间禁止新回合，直到旧回合收尾并从 store 删除。 */
  private deletingSessions = new Set<string>();
  /** 网关停机后不再接受任何来源的新回合。 */
  private shuttingDown = false;
  private approvals = new Map<string, PendingApproval>();
  /** "本会话允许"：跨回合保留，直到会话删除或进程退出。 */
  private sessionAllowed = new Map<string, Set<string>>();
  /** "始终允许"：本次运行内跨会话保留；重启 AiDB 后重新询问。 */
  private alwaysAllowed = new Set<string>();

  constructor(private opts: AgentHostOptions) {}

  private getAccess(explicit?: AgentAccessContext): AgentAccessContext {
    const access = explicit ?? agentAccessStorage.getStore() ?? ADMIN_ACCESS;
    if (access.scope !== 'admin' && access.scope !== 'device') {
      throw new DbError('当前凭据不能访问 Agent', { code: 'SCOPE_DENIED', status: 403 });
    }
    if (access.scope === 'device' && !access.deviceId) {
      throw new DbError('设备 Agent 缺少持久化授权上下文', { code: 'SCOPE_DENIED', status: 403 });
    }
    return access;
  }

  private assertConnectionAccess(access: AgentAccessContext, connectionId?: string): void {
    if (access.scope === 'admin') return;
    // 每次重新读取设备状态与 ACL；撤销、到期、降级后残留的权限行不能继续授权。
    if (!access.deviceId || !connectionId || !this.opts.store.canDeviceAccessConnection(access.deviceId, connectionId)) {
      throw new DbError('设备无权访问该连接', { code: 'CONNECTION_FORBIDDEN', status: 403 });
    }
  }

  private assertPermissionMode(mode: PermissionMode, access: AgentAccessContext): void {
    if (access.scope === 'device' && !isDevicePermissionMode(mode)) {
      throw new DbError('设备 Agent 只能使用 readonly 或 ask 模式', { code: 'MODE_NOT_ALLOWED', status: 403 });
    }
  }

  private assertSessionAccess(sessionId: string, access: AgentAccessContext, requireConnection = true) {
    const session = this.opts.store.getSession(sessionId);
    if (!session) throw new DbError('会话不存在', { code: 'SESSION_NOT_FOUND', status: 404 });
    if (session.connectionId || requireConnection) {
      this.assertConnectionAccess(access, session.connectionId);
    }
    return session;
  }

  forgetSessionApprovals(sessionId: string): void {
    this.sessionAllowed.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** WebSocket 用代次识别自己发起的回合，旧连接关闭不能中止同会话的新回合。 */
  getTurnId(sessionId: string): string | undefined {
    return this.active.get(sessionId)?.id;
  }

  private isCurrentTurn(sessionId: string, turn: ActiveTurn): boolean {
    return this.active.get(sessionId) === turn;
  }

  waitForTurn(sessionId: string): Promise<void> {
    return this.active.get(sessionId)?.settled ?? Promise.resolve();
  }

  /** 停机时先拒绝新回合，再取消全部来源；会话 ACL 不限制内部停机清理。 */
  abortAll(): void {
    this.shuttingDown = true;
    for (const [sessionId, turn] of this.active) {
      this.abort(sessionId, 'user', turn.id, ADMIN_ACCESS);
    }
  }

  /** 等待实际执行链结算，而不只是收到取消信号。 */
  async waitIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((turn) => turn.settled));
    }
  }

  getApprovalOwner(id: string): { sessionId: string; turnId?: string } | undefined {
    const pending = this.approvals.get(id);
    return pending ? { sessionId: pending.sessionId, turnId: pending.turnId } : undefined;
  }

  private beginTurn(sessionId: string, claim?: AgentTurnClaim): ActiveTurn {
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const deadlineController = new AbortController();
    const turn: ActiveTurn = {
      id: claim?.id ?? randomUUID(),
      ownerId: claim?.ownerId ?? this.opts.config.instanceId ?? randomUUID(),
      claim,
      controller,
      signal: AbortSignal.any([controller.signal, deadlineController.signal]),
      deadlineExpired: false,
      invalidated: false,
      outcome: 'failed',
      started: false,
      seq: 0,
      finished: false,
      settled,
      finish: () => {
        if (turn.finished) return;
        turn.finished = true;
        if (turn.deadlineTimer) clearTimeout(turn.deadlineTimer);
        if (this.active.get(sessionId) === turn) this.active.delete(sessionId);
        try {
          if (turn.claim) {
            const terminal = turn.terminalEvent ?? (turn.deadlineExpired
              ? { type: 'error', code: 'TURN_DEADLINE', message: 'Agent 回合已到达绝对时间预算', retryable: false }
              : turn.outcome === 'aborted'
                ? { type: 'aborted', turnId: turn.id, reason: '回合已中止', cause: 'user' }
                : { type: 'error', code: 'AGENT_ERROR', message: 'Agent 回合异常结束', retryable: false });
            try {
              this.opts.store.finishTurn(turn.id, turn.ownerId, turn.outcome, turn.abortCause, terminal);
            } catch (err) {
              logGateway('error', 'agent_turn_finish_failed', { turnId: turn.id, sessionId, error: { name: (err as Error)?.name, message: (err as Error)?.message } });
            }
            try {
              this.opts.store.pruneRuntime();
            } catch (err) {
              logGateway('error', 'runtime_prune_failed', { turnId: turn.id, sessionId, error: { name: (err as Error)?.name, message: (err as Error)?.message } });
            }
          }
          this.opts.metrics?.gauge('aidb_agent_turns_active', this.active.size);
          this.opts.metrics?.inc('aidb_agent_turns_total', { status: turn.outcome });
          this.opts.metrics?.observe('aidb_agent_turn_duration_ms', Date.now() - new Date(turn.claim?.startedAt ?? Date.now()).getTime(), { status: turn.outcome });
          if (turn.deadlineExpired) this.opts.metrics?.inc('aidb_agent_turn_deadlines_total');
          const correlationId = currentCorrelationId();
          this.opts.logger?.(turn.outcome === 'failed' ? 'error' : 'info', 'agent_turn_finished', {
            correlationId, turnId: turn.id, sessionId, ownerId: turn.ownerId, status: turn.outcome, abortCause: turn.abortCause,
          });
          if (turn.started && (turn.deadlineExpired || turn.outcome === 'failed')) {
            this.opts.alerts?.notify({
              type: turn.deadlineExpired ? 'turn_deadline' : 'agent_terminal_failure',
              correlationId, turnId: turn.id, sessionId, ...(turn.deadlineExpired ? {} : { code: 'AGENT_ERROR' }),
            });
          }
        } catch (err) {
          logGateway('error', 'agent_turn_finalize_failed', { turnId: turn.id, sessionId, error: { name: (err as Error)?.name, message: (err as Error)?.message } });
        } finally {
          finish();
        }
      },
    };
    if (claim?.deadlineAt) {
      const delay = Math.max(0, new Date(claim.deadlineAt).getTime() - Date.now());
      turn.deadlineTimer = setTimeout(() => {
        if (turn.deadlineExpired || turn.claim?.status !== 'running') return;
        turn.deadlineExpired = true;
        if (!turn.abortCause) turn.abortCause = 'deadline';
        deadlineController.abort(Object.assign(new Error('Agent 回合已到达绝对时间预算'), { code: 'TURN_DEADLINE' }));
        try {
          this.opts.store.setTurnAbortCause(turn.id, turn.ownerId, 'deadline');
        } catch (err) {
          logGateway('error', 'agent_deadline_persist_failed', { turnId: turn.id, sessionId, error: { name: (err as Error)?.name, message: (err as Error)?.message } });
        }
      }, delay);
      turn.deadlineTimer.unref?.();
    }
    this.active.set(sessionId, turn);
    this.opts.metrics?.gauge('aidb_agent_turns_active', this.active.size);
    return turn;
  }

  private persistEvent(turn: ActiveTurn, event: AgentEvent): void {
    if (!turn.claim) return;
    this.opts.store.appendAgentEvent(turn.id, ++turn.seq, event);
    if (event.type === 'done' || event.type === 'aborted' || event.type === 'error') turn.terminalEvent = event;
  }

  private throwIfExpired(turn: ActiveTurn): void {
    if (!turn.deadlineExpired) return;
    throw Object.assign(new Error('Agent 回合已到达绝对时间预算'), { code: 'TURN_DEADLINE', status: 504 });
  }

  /** Schema 读取也必须受同一绝对预算约束；0 关闭预算时不注入 timeoutMs。 */
  private async schemaForTurn(turn: ActiveTurn, connectionId: string, database?: string): Promise<DatabaseSchema[]> {
    this.throwIfExpired(turn);
    throwIfAborted(turn.signal);
    let timeoutMs: number | undefined;
    if (turn.claim?.deadlineAt) {
      timeoutMs = Math.max(0, new Date(turn.claim.deadlineAt).getTime() - Date.now());
      if (timeoutMs <= 0) {
        throw Object.assign(new Error('Agent 回合已到达绝对时间预算'), { code: 'TURN_DEADLINE', status: 504 });
      }
    }
    try {
      const schemas = await this.opts.manager.schema(connectionId, database, false, undefined, {
        signal: turn.signal,
        executionId: turn.id,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      this.throwIfExpired(turn);
      throwIfAborted(turn.signal);
      return schemas;
    } catch (err: any) {
      this.throwIfExpired(turn);
      throwIfAborted(turn.signal);
      // timeoutMs 只来自回合剩余预算；管理器先触发时也统一成回合deadline语义。
      if (err?.code === 'SCHEMA_TIMEOUT' && turn.claim?.deadlineAt) {
        throw Object.assign(new Error('Agent 回合已到达绝对时间预算'), { code: 'TURN_DEADLINE', status: 504 });
      }
      throw err;
    }
  }

  /**
   * 中止一个回合，并记下是谁中止的。传 turnId 时只中止该代次，旧 WebSocket
   * 的迟到 close 不会影响同会话已经启动的新回合。
   */
  abort(
    sessionId: string,
    cause: 'user' | 'disconnected' = 'user',
    turnId?: string,
    access?: AgentAccessContext,
  ): boolean {
    const turn = this.active.get(sessionId);
    if (!turn || (turnId !== undefined && turn.id !== turnId)) return false;
    try {
      this.assertSessionAccess(sessionId, this.getAccess(access));
    } catch {
      return false;
    }
    if (!turn.abortCause) turn.abortCause = cause;
    // 只有用户手动停止/删除才让回合失效；断线仍要写续跑检查点。
    if (cause === 'user') turn.invalidated = true;
    turn.controller.abort();
    for (const [id, pending] of this.approvals) {
      if (pending.sessionId !== sessionId) continue;
      pending.onAbort?.();
      this.approvals.delete(id);
      pending.resolve({ decision: 'deny', scope: 'once' });
    }
    try {
      if (turn.claim) this.opts.store.setTurnAbortCause(turn.id, turn.ownerId, turn.abortCause);
      // 立即落状态：provider 卡住时 runtime 可能迟迟不返回，UI 不能一直显示“运行中”。
      this.opts.store.updateSession(sessionId, { status: 'aborted' });
    } catch (err) {
      logGateway('error', 'agent_abort_persist_failed', { turnId: turn.id, sessionId, error: { name: (err as Error)?.name, message: (err as Error)?.message } });
    }
    return true;
  }

  /** 先封住新回合，再取消并等待旧回合收尾，最后按原语义删除会话。 */
  async deleteSession(sessionId: string, access?: AgentAccessContext): Promise<void> {
    const resolvedAccess = this.getAccess(access);
    this.assertSessionAccess(sessionId, resolvedAccess);
    this.deletingSessions.add(sessionId);
    try {
      this.abort(sessionId, 'user', undefined, resolvedAccess);
      await this.waitForTurn(sessionId);
      this.forgetSessionApprovals(sessionId);
      this.opts.store.deleteSession(sessionId);
    } finally {
      this.deletingSessions.delete(sessionId);
    }
  }

  resolveApproval(
    id: string,
    decision: ApprovalDecision['decision'],
    scope: ApprovalDecision['scope'],
    access?: AgentAccessContext,
  ): boolean {
    const pending = this.approvals.get(id);
    if (!pending) return false;
    let resolvedAccess: AgentAccessContext;
    try {
      resolvedAccess = this.getAccess(access);
      this.assertSessionAccess(pending.sessionId, resolvedAccess);
    } catch {
      return false;
    }
    const session = this.opts.store.getSession(pending.sessionId);
    const connectionScoped = pending.payload.call.name !== 'create_connection';
    const connId = connectionScoped
      ? typeof pending.payload.call.args.connectionId === 'string'
        ? pending.payload.call.args.connectionId
        : session?.connectionId
      : undefined;
    if (connectionScoped) {
      try {
        this.assertConnectionAccess(resolvedAccess, connId);
      } catch {
        return false;
      }
    }
    this.opts.store.addAudit({
      actor: 'agent',
      connectionId: connId,
      tool: pending.payload.call.name,
      sql: pending.payload.sql,
      risk: pending.payload.risk,
      approval: `${decision}:${scope}`,
      status: decision === 'allow' ? 'ok' : 'denied',
      meta: {
        approvalId: id,
        sessionId: pending.sessionId,
        scope,
        ...(!connectionScoped ? { target: { host: pending.payload.call.args.host, port: pending.payload.call.args.port, engine: pending.payload.call.args.engine, username: pending.payload.call.args.username } } : {}),
      },
    });
    // 审计成功后才消费审批并结算 Promise；审计失败时保留 pending 和超时，
    // 调用方可重试，不会出现审批已消失、runtime 却永远等待的情况。
    clearTimeout(pending.timer);
    pending.onAbort?.();
    pending.resolve({ decision, scope });
    return true;
  }

  private waitApproval(payload: ApprovalPayload, sessionId: string, turn: ActiveTurn): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        turn.signal.removeEventListener('abort', onAbort);
        this.approvals.delete(payload.id);
      };
      const onAbort = () => {
        cleanup();
        resolve({ decision: 'deny', scope: 'once' });
      };
      const remaining = turn.claim?.deadlineAt ? Math.max(0, new Date(turn.claim.deadlineAt).getTime() - Date.now()) : 5 * 60 * 1000;
      const timer = setTimeout(onAbort, Math.min(5 * 60 * 1000, remaining));
      turn.signal.addEventListener('abort', onAbort, { once: true });
      this.approvals.set(payload.id, { resolve, timer, sessionId, turnId: turn.id, payload, onAbort: cleanup });
      if (turn.signal.aborted) onAbort();
    });
  }

  private async loadImages(ids?: string[]): Promise<AttachedImage[]> {
    const out: AttachedImage[] = [];
    for (const id of (ids ?? []).slice(0, MAX_IMAGES_PER_TURN)) {
      const file = await readAttachment(this.opts.config.attachmentDir, id);
      if (!file) throw new DbError(`图片附件不存在，请重新上传：${id}`, { code: 'ATTACHMENT_NOT_FOUND', status: 400 });
      out.push({ id, mime: file.mime, base64: file.buffer.toString('base64'), bytes: file.buffer.length });
    }
    return out;
  }

  async startTurn(
    sessionId: string,
    input: TurnInput,
    emit: (event: AgentEvent) => void,
    access?: AgentAccessContext,
  ): Promise<void> {
    if (this.shuttingDown) throw new DbError('网关正在停机', { code: 'GATEWAY_SHUTDOWN', status: 503 });
    const resolvedAccess = this.getAccess(access);
    // 在任何会话变更、附件读取、provider/schema 加载之前完成服务端上限校验。
    const existing = this.assertSessionAccess(sessionId, resolvedAccess, false);
    const requestedMode = MODES.includes(input.mode as PermissionMode)
      ? (input.mode as PermissionMode)
      : existing.permissionMode;
    this.assertPermissionMode(requestedMode, resolvedAccess);
    this.assertConnectionAccess(resolvedAccess, input.connectionId ?? existing.connectionId);
    if (this.deletingSessions.has(sessionId) || this.active.has(sessionId)) {
      throw new DbError('该会话正在运行或删除，请先中止或等待完成', { code: 'SESSION_BUSY', status: 409 });
    }
    // 持久化 claim 与内存占用都必须在首个 await 前完成；唯一索引负责跨 Host 实例互斥。
    const id = randomUUID();
    const budgetMs = this.opts.config.agentTurnMs ?? 0;
    const claim = this.opts.store.claimTurn({
      id,
      sessionId,
      ownerId: this.opts.config.instanceId ?? randomUUID(),
      idempotencyKey: input.idempotencyKey?.slice(0, 128) || randomUUID(),
      ...(budgetMs > 0 ? { deadlineAt: new Date(Date.now() + budgetMs).toISOString() } : {}),
    });
    const turn = this.beginTurn(sessionId, claim);
    const durableEmit = (event: AgentEvent): void => {
      this.persistEvent(turn, event);
      if (event.type === 'tool_result') {
        this.opts.metrics?.inc('aidb_agent_tool_calls_total', { tool: event.tool, status: event.result.ok ? 'ok' : 'error' });
        this.opts.metrics?.observe('aidb_agent_tool_duration_ms', event.result.meta.durationMs, { tool: event.tool });
      }
      emit(event);
    };
    try {
      this.throwIfExpired(turn);
      await this.startTurnOwned(sessionId, input, durableEmit, turn, resolvedAccess);
    } finally {
      for (const [id, pending] of this.approvals) {
        if (pending.sessionId !== sessionId || pending.turnId !== turn.id) continue;
        pending.onAbort?.();
        this.approvals.delete(id);
        pending.resolve({ decision: 'deny', scope: 'once' });
      }
      // 只清理自己的代次；即使测试/异常路径替换了 active，也不能删掉新回合。
      turn.finish();
    }
  }

  private async startTurnOwned(
    sessionId: string,
    input: TurnInput,
    emit: (event: AgentEvent) => void,
    turn: ActiveTurn,
    access: AgentAccessContext,
  ): Promise<void> {
    this.throwIfExpired(turn);
    const rawText = input.text?.trim();
    if (!rawText) throw new DbError('消息不能为空', { code: 'EMPTY_MESSAGE', status: 400 });
    // 斜杠命令是目的信号：裸命令也有默认任务，不让用户补表单参数。
    const parsedCommand = parseCommandIntent(rawText);
    const intent = parsedCommand?.intent;
    const text = parsedCommand?.task ?? rawText;
    const session = this.opts.store.getSession(sessionId);
    if (!session) throw new DbError('会话不存在', { code: 'SESSION_NOT_FOUND', status: 404 });
    const mode = MODES.includes(input.mode as PermissionMode) ? (input.mode as PermissionMode) : session.permissionMode;
    const connectionId = input.connectionId ?? session.connectionId;
    this.assertPermissionMode(mode, access);
    this.assertConnectionAccess(access, connectionId);
    const stored = connectionId ? this.opts.store.getConnection(connectionId) : undefined;
    // 目标库按「本回合 > 会话记录 > 连接默认」取，并替换进 conn，
    // 让 schema、召回、业务上下文、提示词和工具默认库都指向同一个库。
    // 会话库只在连接没换时才有意义，换了连接就退回新连接的默认库
    const sameConnection = !session.connectionId || !connectionId || session.connectionId === connectionId;
    const database = input.database || (sameConnection ? session.database : undefined) || stored?.database;
    const conn = stored ? { ...stored, database } : undefined;
    const initMatch = /^\/init(?:\s+([\s\S]+))?$/i.exec(rawText);
    if (initMatch) {
      if (access.scope === 'device') {
        throw new DbError('设备 Agent 不能执行 /init', { code: 'COMMAND_NOT_ALLOWED', status: 403 });
      }
      await this.runInit(sessionId, input, rawText, initMatch[1]?.trim(), emit, turn);
      return;
    }
    const settings = this.opts.store.getSettings();
    const profile = getModelProfile(settings.agent);
    if (input.images?.length && !supportsInput(profile, 'image')) {
      throw new DbError('当前模型没有开启图片输入，请在 设置 → 模型能力 里勾选「图片」。', { code: 'MODEL_NO_VISION', status: 400 });
    }
    const images = await this.loadImages(input.images);
    this.throwIfExpired(turn);
    this.assertConnectionAccess(access, connectionId);
    if (!this.isCurrentTurn(sessionId, turn) || turn.signal.aborted) return;
    const provider = createProvider(settings.agent);
    // 语义命令通常要「看结构 → 多次查数 → 出图」，给足步数；普通提问保持用户设置。
    // 0 表示不限步数；绝对时间预算由持久化 claim 的 deadline_at 单独约束。
    const maxSteps = intent ? Math.min(40, Math.max(16, (settings.agent.maxSteps || 12) * 2)) : settings.agent.maxSteps;
    const startedAt = Date.now();

    const store = this.opts.store;
    const historyMessages = store.listMessages(sessionId);
    // 按落库消息成组还原，避免先切 ProviderMessage 再把 tool_call 与结果拆散。
    const history = await providerHistory(historyMessages.slice(-24), this.opts.config.attachmentDir);
    this.throwIfExpired(turn);
    this.assertConnectionAccess(access, connectionId);
    if (!this.isCurrentTurn(sessionId, turn) || turn.signal.aborted) return;

    let schemas: DatabaseSchema[] | undefined;
    let schemaError: string | undefined;
    if (conn) {
      try {
        schemas = await this.schemaForTurn(turn, conn.id, conn.database);
      } catch (err: any) {
        // 结构读取失败可以降级继续，但用户停止/绝对deadline不能被吞成普通 schemaError。
        if (turn.signal.aborted || turn.deadlineExpired || err?.code === 'TURN_DEADLINE' || err?.code === 'ABORTED') throw err;
        schemaError = err?.message ?? '无法读取结构';
      }
    }
    this.throwIfExpired(turn);
    this.assertConnectionAccess(access, connectionId);
    let brief: LoadedBrief | undefined;
    if (conn) {
      const record = this.opts.store.getDatabaseBrief(conn.id, conn.database);
      const briefPath = record?.path ?? defaultBriefPath(this.opts.config.home, conn);
      const briefMarkdown = await readBrief(briefPath);
      this.throwIfExpired(turn);
      if (briefMarkdown && schemas) brief = loadBrief(briefMarkdown, briefPath, schemas);
    }

    const recall = conn
      ? store.recallForTurn(text, { connectionId: conn.id, database: conn.database })
      : { memories: [] as Memory[], glossary: [] as Memory[], sqlExamples: [] as Memory[] };
    const memories = recall.memories;
    const businessContext = conn ? store.agentContextBundle(conn.id, conn.database) : undefined;
    const attachmentTables = (input.attachments ?? []).map(String).slice(0, 12);
    const reportBrief = intent?.id === 'report'
      ? buildReportBrief({
        topic: text,
        databases: schemas,
        context: businessContext,
        glossary: recall.glossary,
        sqlExamples: recall.sqlExamples,
        focusTables: attachmentTables,
      })
      : undefined;
    const compacted = compactProviderHistory(history, historyTokenBudget(settings.agent, profile));
    this.throwIfExpired(turn);
    this.assertConnectionAccess(access, connectionId);
    if (!this.isCurrentTurn(sessionId, turn) || turn.signal.aborted) return;
    turn.started = true;

    const title = session.title === '新会话' || !session.title ? rawText.slice(0, 28) : session.title;
    store.updateSession(sessionId, {
      connectionId,
      database,
      title,
      permissionMode: mode,
      status: 'running',
      // 上一回合的「可以继续」到这就过期了：新回合要么跑出新的检查点，要么正常做完，
      // 两种都不该在跑的过程中还挂着旧提示。null 而不是 undefined——后者是「不改」。
      resume: null,
      model: settings.agent.provider === 'local' ? 'local' : settings.agent.model,
    });
    store.appendMessage({
      sessionId,
      role: 'user',
      content: rawText,
      blocks: images.map((img) => ({ type: 'image' as const, attachmentId: img.id, mime: img.mime, bytes: img.bytes })),
    });

    const blocks: AgentMessageBlock[] = [];
    const callInfo = new Map<string, { call: ToolCall; risk: Risk }>();
    let thinking = '';
    const sessionForAudit = session;

    const wrappedEmit = (event: AgentEvent): void => {
      if (turn.deadlineExpired && event.type === 'aborted') {
        event = { type: 'error', code: 'TURN_DEADLINE', message: 'Agent 回合已到达绝对时间预算', retryable: false };
      }
      switch (event.type) {
        case 'thinking_delta':
          thinking += event.text;
          break;
        // 按步交付的正文/思考：顺序就是渲染顺序，块数组是这段对话的唯一时间线。
        // 老的「整回合 thinking 一坨」仍在 thinking 变量里，只在没有分段块时兜底用。
        case 'step_text':
          blocks.push({ type: 'text', text: event.text, step: event.step });
          break;
        case 'step_thinking':
          blocks.push({ type: 'thinking', text: event.text, step: event.step });
          break;
        case 'tool_call': {
          const args = capToolArgs(event.args);
          callInfo.set(event.callId, { call: { id: event.callId, name: event.tool, args: (event.args ?? {}) as Record<string, unknown> }, risk: event.risk });
          blocks.push({ type: 'tool_call', callId: event.callId, tool: event.tool, args, risk: event.risk });
          emit({ ...event, args });
          return;
        }
        case 'tool_result': {
          if (turn.invalidated || !this.isCurrentTurn(sessionId, turn)) return;
          // 落库/推送用裁剪副本；runtime 自己那份完整结果只用于当步模型序列化，不受影响。
          const capped = capToolResult(event.result);
          blocks.push({
            type: 'tool_result',
            callId: event.callId,
            tool: event.tool,
            result: capped,
            status: capped.ok ? 'ok' : 'error',
          });
          store.addToolRun({
            id: event.callId,
            sessionId,
            tool: event.tool,
            args: capToolArgs(callInfo.get(event.callId)?.call.args),
            result: capped,
            status: capped.ok ? 'ok' : 'error',
            risk: callInfo.get(event.callId)?.risk,
            durationMs: capped.meta.durationMs,
          });
          emit({ ...event, result: capped });
          return;
        }
        case 'plan':
          blocks.push({ type: 'plan', items: event.items });
          break;
        default:
          break;
      }
      emit(event);
    };

    const memoryContext: Memory[] = memories;
    const restrictedDevice = access.scope === 'device';
    // device 的 disableMcp:false 不能重新打开宿主命令；自定义 MCP 仅 admin 可执行。
    const allowMcp = !restrictedDevice && input.disableMcp !== true;
    const allowedTools = visibleAgentTools(settings, allowMcp, restrictedDevice);
    // 管理员此前授予的会话/全局工具允许项不能继承给受限设备。
    const sessionAllowed = restrictedDevice
      ? new Set<string>()
      : this.sessionAllowed.get(sessionId) ?? new Set<string>();
    const alwaysAllowed = restrictedDevice ? new Set<string>() : this.alwaysAllowed;
    if (!restrictedDevice) this.sessionAllowed.set(sessionId, sessionAllowed);
    const runtime = new AgentRuntime({
      provider,
      maxSteps,
      temperature: settings.agent.temperature,
      maxTokens: maxOutputTokensOf(settings.agent, profile),
      // 单条工具结果给模型看的字符预算：窗口越大开局给得越多，跑到后半程按已用 tokens
      // 自动收窄。没填档案时按默认档位（256K/32K）算——就是设置页输入框里预填的那两个数。
      resultCharBudget: (usedTokens) =>
        modelResultCharBudget({
          contextWindow: profile?.contextWindow,
          maxOutputTokens: maxOutputTokensOf(settings.agent, profile),
          usedTokens,
        }),
      // 长回合的中途压缩线：contextTokens 超过它时折叠最早的工具往返，防止窗口顶穿。
      // 没填档案也开着（按默认档位算）——以前这条在最常见配置下是关的。
      contextTokenBudget: midContextTokenBudget(profile?.contextWindow, maxOutputTokensOf(settings.agent, profile)),
      reasoning: activeReasoningTier(settings.agent, profile),
      generateId: () => randomUUID(),
      buildSystem: (run: AgentRunInput) => {
        const base = buildSystemPrompt({
          connection: conn,
          databases: schemas,
          memories: memoryContext,
          glossary: recall.glossary,
          sqlExamples: recall.sqlExamples,
          context: businessContext,
          mode: run.mode,
          attachmentTables,
          question: run.userText,
          contextWindow: profile?.contextWindow,
          maxOutputTokens: maxOutputTokensOf(settings.agent, profile),
          // /init 落盘的表用途分档：决定 schema 段每张表的展开形状。brief 早于分档
          // 功能（没有 table_tiers）时为 undefined，prompt 退回旧的窗口聚焦逻辑。
          tiers: brief?.meta.tiers,
        });
        const extra: string[] = [];
        if (intent) {
          extra.push(intent.instruction);
          // 模型没有时钟：日期话术必须由网关解析成确定边界，否则「本周」「上月」全靠猜。
          const period = resolvePeriod({ topic: text });
          if (intent.id === 'report') {
            extra.push(formatPeriodForPrompt(period));
            if (reportBrief) extra.push(formatReportBriefForPrompt(reportBrief));
            extra.push(
              `## Report period rules\nEvery query in this report must stay inside ${period.current.from} ~ ${period.current.to}` +
                (period.previous ? `; the baseline is ${period.previous.from} ~ ${period.previous.to} (${period.previous.label.split('（')[0]?.trim()}).` : '.') +
                ' If the user explicitly names a different period, follow the user and state the window you used.',
            );
          } else {
            extra.push(`## Clock\nToday is ${period.today}. Resolve relative periods ("this week", "last month", "近 7 天") into exact dates before querying, and state the dates you used.`);
          }
        }
        if (brief) extra.push(briefPromptBlock(brief));
        if (sessionForAudit.summary) extra.push(`## Earlier session summary\n${sessionForAudit.summary}`);
        if (schemaError) extra.push(`## Schema loading warning\n${schemaError}`);
        if (settings.features.mcp && allowMcp) extra.push(mcpPromptBlock(this.opts.store));
        // 能力目录是常量开销（12 条约 1.4k token），本地推理器用不到，跳过。
        if (!restrictedDevice && settings.agent.provider !== 'local') extra.push(capabilityPromptBlock());
        if (settings.agent.provider === 'local') {
          extra.push('## Runtime\nYou are running with the offline Local Reasoner. Keep to clear, rule-parsable instructions; if a request is ambiguous, explain what you can do.');
        }
        return `${base}\n${extra.join('\n\n')}`;
      },
      tools: allowedTools,
      getTool: (name) => allowedTools.some((tool) => tool.name === name) ? getTool(name) : undefined,
      executeTool: (call, signal) => {
        if (restrictedDevice) {
          if (!DEVICE_AGENT_TOOLS.has(call.name)) {
            return Promise.resolve({
              ok: false,
              summary: '设备不能使用该工具',
              error: {
                code: 'TOOL_NOT_ALLOWED',
                message: `设备 Agent 不能调用 ${call.name}`,
                hint: '请在本机管理员界面执行该操作。',
              },
              meta: { durationMs: 0 },
            });
          }
          const targetConnectionId = typeof call.args.connectionId === 'string'
            ? call.args.connectionId
            : conn?.id;
          if (!access.deviceId || !targetConnectionId || !this.opts.store.canDeviceAccessConnection(access.deviceId, targetConnectionId)) {
            return Promise.resolve({
              ok: false,
              summary: '设备无权访问该连接',
              error: {
                code: 'CONNECTION_FORBIDDEN',
                message: '工具目标连接不在设备授权列表中',
                hint: '请联系管理员授权连接后再试。',
              },
              meta: { durationMs: 0 },
            });
          }
          // 即便 ACL 中有多个连接，本回合也只允许当前会话绑定的连接，避免模型静默换库。
          if (targetConnectionId !== conn?.id) {
            return Promise.resolve({
              ok: false,
              summary: '工具目标连接与当前会话不一致',
              error: {
                code: 'CONNECTION_FORBIDDEN',
                message: '设备回合不能切换到其他连接',
                hint: '请新建或选择目标连接的会话。',
              },
              meta: { durationMs: 0 },
            });
          }
          call = { ...call, args: { ...call.args, connectionId: targetConnectionId } };
        }
        const contextDb = businessContext?.database?.toLowerCase() ?? '';
        const targetDb = String(call.args.database ?? conn?.database ?? '').toLowerCase();
        const scoped = !contextDb || !targetDb || targetDb === contextDb;
        const contextDisabled = businessContext?.disabledTables ?? [];
        const disabled = scoped ? contextDisabled : [];
        // SQL 检查不随 args.database 关闭：传一个不同的库名就能把 disabled 置空，
        // 跨库写法 bizdb.禁用表 也拦不住。名字匹配本来就是「宁可误伤」的硬约束，
        // 与目标库无关；对象级工具仍按目标库作用域判定。
        if (contextDisabled.length && typeof call.args.sql === 'string') {
          const sql = call.args.sql;
          if (systemCatalogQuery(sql)) return Promise.resolve(metadataBlockedError());
          const blocked = disabledTableInSql(sql, contextDisabled);
          if (blocked) {
            return Promise.resolve({
              ok: false,
              summary: '表已被业务上下文禁用',
              error: {
                code: 'TABLE_DISABLED',
                message: `表 ${blocked} 已在业务上下文中禁用，不能执行包含它的 SQL。`,
                hint: '改用未禁用的表；若确需该表，请让用户在 Agent 上下文里启用它。',
              },
              meta: { durationMs: 0 },
            });
          }
        }
        if (disabled.length) {
          if (allTableScanNeedsScope(call, disabled)) return Promise.resolve(scopeRequiredError(call.name));
          const target = disabledTableTarget(call, disabled);
          if (target) return Promise.resolve(disabledToolError(target));
        }
        return this.opts.executor
          .execute(call, { sessionId, connectionId: conn?.id, database: conn?.database, disabledTables: disabled, signal })
          .then((result) => filterDisabledObjects(call, result, disabled));
      },
      requestApproval: (payload) => this.waitApproval(payload, sessionId, turn),
      emit: wrappedEmit,
    });

    let status: 'done' | 'aborted' | 'error' = 'done';
    let usage = { tokensIn: 0, tokensOut: 0 };
    try {
      const result = await runtime.run({
        sessionId,
        userText: text,
        ...(images.length ? { images } : {}),
        mode,
        connection: conn,
        environment: conn?.environment ?? 'dev',
        connectionReadonly: conn?.readonly ?? false,
        history: compacted,
        context: { connection: conn, databases: schemas, memories, agentContext: businessContext, glossary: recall.glossary, sqlExamples: recall.sqlExamples, attachmentTables, locale: /^zh/i.test(this.opts.store.getSettings().locale) ? 'zh' : 'en' },
        sessionAllowed,
        alwaysAllowed,
        signal: turn.signal,
      });
      status = result.status;
      turn.outcome = turn.deadlineExpired ? 'failed' : result.status === 'done' ? 'succeeded' : result.status === 'aborted' ? 'aborted' : 'failed';
      usage = result.usage;
      if (!this.isCurrentTurn(sessionId, turn)) return;
      // 被中止（用户停止或断线触发 abort）的回合不再写「完成」终态：
      // abort 已经置过 status='aborted' 并清了审批，runtime 的收尾若照常写
      // assistant 消息/检查点/summary/turns，会把用户已停掉的回合伪装成正常收尾。
      const invalidated = turn.invalidated;
      if (!invalidated) {
        // 有分段思考块就不再拼整回合那一坨（同一段文字存两遍，界面也会重复渲染）；
        // 没有分段块的模型（不发 step_thinking 的旧路径/本地推理器）保留原兜底。
        const hasStepThinking = blocks.some((b) => b.type === 'thinking' && b.step !== undefined);
        const finalBlocks = thinking && !hasStepThinking ? [{ type: 'thinking' as const, text: thinking }, ...blocks] : blocks;
        store.appendMessage({ sessionId, role: 'assistant', content: result.text, blocks: finalBlocks, tokens: result.usage.tokensOut });
        // 回合**没跑完就结束**时补一条续跑检查点。六种情况共用这一手：连接停摆、界面那侧
        // 连接断开、回复被输出上限截断、模型空返回、跑满步数、服务商未完成。共同点是「进度还在，但事没做完」。
        // 没有检查点的话，用户点「继续」时模型只能看到半截正文，等于把已烧掉的时间扔掉重来。
        // 必须写在半截正文之后：正文是模型说过的话，检查点是「它本来还要做什么」，
        // 两者顺序颠倒会让下一轮的上下文读起来像倒叙。
        // 界面那侧的连接断开（关页面 / 客户端判定通道静默后主动断开）在 runtime 眼里与
        // 用户点停止一模一样——都只是 signal.aborted，所以 abortCause 一律是 'user'。
        // 区别只存在于传输层，只能由 abort() 记下的那一份来补：没人点过停止的中止，
        // 就该留检查点，否则用户重开页面点「继续」时模型只看得到半截正文。
        const disconnected = turn.abortCause === 'disconnected';
        const unfinished: AgentResumeCause | undefined = turn.deadlineExpired
          ? 'deadline'
          : result.status === 'aborted' && result.abortCause === 'stalled'
            ? 'stalled'
          : result.status === 'aborted' && disconnected
            ? 'disconnected'
            : result.stop === 'max_output_tokens'
              ? 'truncated'
              : result.stop === 'empty_response'
                ? 'empty'
                : // 跑满步数过去不写检查点，于是出现一整套自相矛盾：界面按 stop 判定为
                  // 「未完成（可继续）」并给出「继续」按钮，服务端那边却什么都没留，
                  // 点下去等于让模型从半截正文里猜自己刚才在干什么。
                  result.stop === 'max_steps'
                  ? 'max_steps'
                  : result.stop === 'provider_incomplete'
                    ? 'provider_incomplete'
                    : undefined;
        if (unfinished) {
          store.appendMessage({
            sessionId,
            role: 'assistant',
            content: buildResumeCheckpoint({
              plan: result.plan,
              steps: result.steps,
              toolCalls: result.toolCalls,
              elapsedMs: Date.now() - startedAt,
              toolTrace: blocks.filter((b) => b.type === 'tool_call').map((b) => b.tool).filter(Boolean) as string[],
              cause: unfinished,
            }),
          });
        }
        const previous = store.getSession(sessionId);
        const summaryLine = `Q: ${text.slice(0, 200)}\nA: ${result.text.slice(0, 400)}`;
        const summary = `${previous?.summary ? `${previous.summary}\n---\n` : ''}${summaryLine}`.slice(-6000);
        store.updateSession(sessionId, {
          status: turn.deadlineExpired ? 'error' : result.status === 'done' ? 'done' : result.status === 'aborted' ? 'aborted' : 'error',
          summary,
          tokensIn: (previous?.tokensIn ?? 0) + result.usage.tokensIn,
          tokensOut: (previous?.tokensOut ?? 0) + result.usage.tokensOut,
          // 轮次 = 用户发起的对话轮数：中止/出错的回合也是用户真问过一次，同样计入。
          // 只统计跑完的回合会出现「0 轮却跑了 30 步」这种读不通的状态条。
          turns: (previous?.turns ?? 0) + 1,
          steps: (previous?.steps ?? 0) + result.steps,
          cacheHitTokens: (previous?.cacheHitTokens ?? 0) + (result.usage.cacheHitTokens ?? 0),
          cacheMissTokens: (previous?.cacheMissTokens ?? 0) + (result.usage.cacheMissTokens ?? 0),
          // 上下文占用取最近一次调用的输入，重开会话时状态条才有可显示的值
          contextTokens: result.contextTokens,
          // 「可以继续」要跨连接活下来：界面上的提示挂在 live 上，而回合一结束 live 就会被
          // 历史替换掉；关页面走掉的人回来时本地什么都没有。只有落了检查点的回合才写。
          resume: unfinished ?? null,
          model: settings.agent.provider === 'local' ? 'local' : settings.agent.model,
        });
      } else {
        // 中止的回合只保留 aborted 状态与「不可继续」，不累积任何统计。
        store.updateSession(sessionId, { status: 'aborted', resume: null });
      }
      if (!turn.invalidated && !turn.deadlineExpired && result.status === 'done' && turn.outcome === 'succeeded' && settings.agent.followUpSuggestions) {
        for (const item of this.followUps(blocks, schemas, businessContext)) emit({ type: 'suggestions', items: item });
      }
      if (!turn.invalidated && !turn.deadlineExpired && turn.outcome === 'succeeded' && settings.agent.autoMemory) this.captureMemories(text, result.text, sessionId, conn);
    } catch (err: any) {
      status = 'error';
      turn.outcome = turn.invalidated ? 'aborted' : 'failed';
      // 已停止的回合出错不再把状态改成 error：abort 时说好的 aborted 就是最终状态。
      if (!turn.invalidated && this.isCurrentTurn(sessionId, turn)) {
        const deadline = turn.deadlineExpired || err?.code === 'TURN_DEADLINE';
        const terminal: AgentEvent = {
          type: 'error',
          code: deadline ? 'TURN_DEADLINE' : err?.code ?? 'AGENT_ERROR',
          message: deadline ? 'Agent 回合已到达绝对时间预算' : err?.message ?? 'Agent 运行失败',
          retryable: false,
        };
        turn.terminalEvent = terminal;
        try {
          store.updateSession(sessionId, { status: 'error', ...(deadline ? { resume: 'deadline' as const } : {}) });
        } finally {
          emit(terminal);
        }
      }
    }
    if (status === 'done' && usage.tokensIn + usage.tokensOut > 0) {
      // usage already emitted by the runtime; kept here for future analytics
    }
  }

  /**
   * `/init`：扫描当前库并维护 AI_DB.md。每次执行全量刷新自动段落（新表/删表/改列都会反映），
   * 只有数据流与人工补充这两个 manual 段落保留；确定性清单是主体，模型只补充注解。
   */
  private async runInit(sessionId: string, input: TurnInput, rawText: string, requestedPath: string | undefined, emit: (event: AgentEvent) => void, turn: ActiveTurn): Promise<void> {
    const store = this.opts.store;
    const session = store.getSession(sessionId);
    if (!session) {
      emit({ type: 'error', code: 'SESSION_NOT_FOUND', message: '会话不存在' });
      return;
    }
    const connectionId = input.connectionId ?? session.connectionId;
    const stored = connectionId ? store.getConnection(connectionId) : undefined;
    if (!stored) {
      emit({ type: 'error', code: 'NO_CONNECTION', message: '请先在 Agent 顶部选择一个连接和数据库，再运行 /init' });
      return;
    }
    const sameConnection = !session.connectionId || !connectionId || session.connectionId === connectionId;
    const database = input.database || (sameConnection ? session.database : undefined) || stored.database;
    const conn = { ...stored, database };
    const turnId = turn.id;
    const signal = turn.signal;
    const started = Date.now();
    turn.started = true;
    store.updateSession(sessionId, {
      connectionId,
      database,
      status: 'running',
      title: session.title === '新会话' || !session.title ? `AI_DB · ${database || conn.name}` : session.title,
      model: 'init',
      // /init 不写续跑检查点，跑完这一趟，上一回合留下的「可以继续」就不再是最新事实了
      resume: null,
    });
    store.appendMessage({ sessionId, role: 'user', content: rawText });
    emit({ type: 'start', turnId, sessionId, model: 'init' });
    try {
      const schemas = await this.schemaForTurn(turn, conn.id, conn.database);
      this.throwIfExpired(turn);
      if (!this.isCurrentTurn(sessionId, turn) || signal.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      const settings = store.getSettings();
      const recall = store.recallForTurn('', { connectionId: conn.id, database: conn.database });
      const history = store.listHistory({ connectionId: conn.id, limit: 100 }).map((item) => ({ sql: item.sql, status: item.status }));
      const record = store.getDatabaseBrief(conn.id, conn.database);
      const path = briefPathFromRegistry({
        home: this.opts.config.home,
        connection: conn,
        storedPath: record?.path,
        requestedPath,
      });
      const existing = await readBrief(path);
      this.throwIfExpired(turn);
      let provider: ReturnType<typeof createProvider> | undefined;
      if (settings.agent.provider !== 'local') {
        try {
          provider = createProvider(settings.agent);
        } catch {
          /* 注解失败不能挡住确定性文档 */
        }
      }
      const result = await composeDatabaseBrief({
        connection: conn,
        schemas,
        bundle: store.agentContextBundle(conn.id, conn.database),
        glossary: recall.glossary,
        sqlExamples: recall.sqlExamples,
        history,
        provider,
        signal: signal,
        home: this.opts.config.home,
        requestedPath,
        storedPath: record?.path,
        existing: existing ?? undefined,
      });
      this.throwIfExpired(turn);
      if (!this.isCurrentTurn(sessionId, turn) || signal.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      await writeDatabaseBrief(result.path, result.markdown, existing ?? undefined);
      this.throwIfExpired(turn);
      if (!this.isCurrentTurn(sessionId, turn) || signal.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      const generatedAt = new Date().toISOString();
      store.saveDatabaseBrief({
        connectionId: conn.id,
        database: conn.database,
        path: result.path,
        schemaHash: result.schemaHash,
        generatedAt,
      });
      const content = [summarizeInit(result), existing ? '\n\n已更新现有文件：自动段落全部刷新，数据流与人工补充段落保留。' : '\n\n这是首次生成，后续对话会自动加载它。'].join('');
      store.appendMessage({ sessionId, role: 'assistant', content });
      store.updateSession(sessionId, {
        status: 'done',
        summary: `Q: ${rawText.slice(0, 200)}\nA: ${content.slice(0, 400)}`,
      });
      emit({ type: 'text_delta', text: content });
      turn.outcome = 'succeeded';
      emit({ type: 'done', turnId, durationMs: Date.now() - started, summary: content.slice(0, 280) });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database: conn.database,
        tool: 'command.init',
        risk: 'read',
        approval: 'none',
        status: 'ok',
        durationMs: Date.now() - started,
        meta: {
          path: result.path,
          tables: result.stats.tableNames.length,
          coreTables: result.stats.coreTables.length,
          joins: result.stats.joins,
          annotations: result.stats.annotations,
          schemaHash: result.schemaHash,
        },
      });
    } catch (err: any) {
      if (!this.isCurrentTurn(sessionId, turn)) return;
      const deadline = turn.deadlineExpired || err?.code === 'TURN_DEADLINE';
      const aborted = !deadline && (signal.aborted || err?.code === 'ABORTED');
      turn.outcome = turn.invalidated ? 'aborted' : deadline ? 'failed' : aborted ? 'aborted' : 'failed';
      if (!turn.invalidated) store.updateSession(sessionId, { status: deadline ? 'error' : aborted ? 'aborted' : 'error', ...(deadline ? { resume: 'deadline' as const } : {}) });
      if (deadline) emit({ type: 'error', code: 'TURN_DEADLINE', message: 'Agent 回合已到达绝对时间预算', retryable: false });
      else if (aborted) emit({ type: 'aborted', turnId, reason: turn.abortCause === 'disconnected' ? '客户端连接中断' : '用户中止' });
      else emit({ type: 'error', code: err?.code ?? 'INIT_FAILED', message: err?.message ?? '初始化失败' });
      store.addAudit({
        actor: 'user',
        connectionId: conn.id,
        database: conn.database,
        tool: 'command.init',
        risk: 'read',
        approval: 'none',
        status: 'error',
        durationMs: Date.now() - started,
        meta: { path: requestedPath, aborted },
      });
    }
  }

  /**
   * 追问建议：只看本轮真正调用过的工具与涉及的表，用本地规则生成。
   * 对所有 provider 一视同仁，不依赖模型输出特定标签，也不产生额外 token 成本。
   */
  private followUps(blocks: AgentMessageBlock[], schemas: DatabaseSchema[] | undefined, bundle?: AgentContextBundle): QuestionSuggestion[][] {
    const usedTools: string[] = [];
    const touched = new Set<string>();
    for (const block of blocks) {
      if (block.type !== 'tool_call') continue;
      if (block.tool) usedTools.push(block.tool);
      const args = (block.args ?? {}) as Record<string, unknown>;
      if (typeof args.table === 'string' && args.table.trim()) touched.add(args.table.trim());
      if (typeof args.sql === 'string') for (const name of tablesFromSql(args.sql)) touched.add(name);
    }
    const items = suggestFollowUps({ schemas, tables: [...touched], usedTools, bundle, limit: 3, locale: /^zh/i.test(this.opts.store.getSettings().locale) ? 'zh' : 'en' });
    return items.length ? [items] : [];
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
