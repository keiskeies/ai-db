import { randomUUID } from 'node:crypto';
import {
  activeReasoningTier,
  AgentRuntime,
  buildSystemPrompt,
  builtinMcpServer,
  compactHistory,
  createProvider,
  extractHeuristicMemories,
  formatPeriodForPrompt,
  getModelProfile,
  getTool,
  historyTokenBudget,
  providerTools,
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
  type Capability,
  type AgentContextBundle,
  type AgentEvent,
  type AgentMessageBlock,
  type AgentRunInput,
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
import type { ToolExecutor } from './executor';
import type { ConnectionManager } from './manager';
import type { Store } from './store';
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

export interface TurnInput {
  text: string;
  mode?: PermissionMode;
  attachments?: string[];
  /** 已上传到 Bridge 的图片附件 id。 */
  images?: string[];
  connectionId?: string;
  /** 本回合的目标库；缺省用会话记录的库，再缺省用连接默认库。 */
  database?: string;
  /** 机器人等远程入口不得触达本机 MCP（文件系统 / Git / 网页抓取）。 */
  disableMcp?: boolean;
}

export interface AgentHostOptions {
  store: Store;
  manager: ConnectionManager;
  executor: ToolExecutor;
  config: GatewayConfig;
  skills?: SkillStore;
  /**
   * 本回合时间预算解析器，返回 undefined 表示回落到默认规则。
   *
   * 为什么需要它：`Math.max(30_000, ...)` 的 30 秒地板让超时分支无法在秒级测通，
   * 而超时后落检查点这条路径必须有测试。多入口（bot / 远程）按入口分配预算也用得上，
   * 不是纯测试桩——生产默认路径仍是 env > intent > 步数推导，见 resolveTurnBudgetMs。
   */
  turnBudgetMs?: (context: { maxSteps: number; intentTimeoutMs?: number }) => number | undefined;
}

/** 每步模型调用的实测中位耗时（15s）留三分之一余量，用来把步数预算折成时间预算。 */
const PER_STEP_MS = 20_000;
/** 时间预算下限：默认 12 步的推导结果必须落在这里，保证与旧行为（480s）一致。 */
const MIN_TURN_MS = 480_000;
/** 时间预算上限：再长就不该靠一个回合硬扛，而该靠检查点续跑。 */
const MAX_TURN_MS = 1_800_000;

/**
 * 由步数预算推导时间预算。
 *
 * 不给「更长」而给「自洽」：承诺 100 步却只给 8 分钟，必然在 32 步左右被时间抢先截断，
 * 用户看到的就是「跑一半停了」。上限跟着步数走之后，先卡住的才是步数而不是时间。
 * 长回合的安全性来自软提醒（80% 收敛）与检查点（断了能接），不来自放宽上限本身。
 */
export function deriveTurnBudgetMs(maxSteps: number): number {
  return Math.min(MAX_TURN_MS, Math.max(MIN_TURN_MS, maxSteps * PER_STEP_MS));
}

/**
 * 解析本回合的时间预算。优先级：env > 命令意图 > 按步数推导。
 *
 * 保留 env 与 intent 的既有语义（运维与 /init 之类命令依赖它们），只把最后一档
 * 从写死的 480_000 换成随步数走——这一步就是「承诺 100 步却只给 8 分钟」的解药。
 * 30 秒地板保持原样：预算再小只会把正常回合截成碎片。
 */
export function resolveTurnBudgetMs(input: {
  maxSteps: number;
  intentTimeoutMs?: number;
  env?: Record<string, string | undefined>;
}): number {
  const env = input.env ?? process.env;
  const raw = env.AIDB_AGENT_TURN_MS ?? input.intentTimeoutMs ?? deriveTurnBudgetMs(input.maxSteps);
  return Math.max(30_000, Number(raw));
}

/** 把毫秒说成「M 分 S 秒」，避免检查点里出现 493000 这种没人读的数字。 */
function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/**
 * 超时中止时写进会话的「续跑检查点」。
 *
 * 为什么要单独写一条：abort 之后 runtime 只留下半截正文，用户再问「继续」时，
 * 模型从历史里只能看到那半截，等于从零开始重新摸索——上一回合烧掉的时间白费。
 * 这条把「做到哪、剩下什么、下一步做什么」显式留在历史里，续跑才有落点。
 *
 * 措辞同时面向两类读者：模型（拿它当上下文继续干）和人（看懂为什么断在这里）。
 */
export function buildResumeCheckpoint(input: {
  plan: AgentPlanItem[];
  steps: number;
  toolCalls: number;
  elapsedMs: number;
  budgetMs: number;
  toolTrace: string[];
}): string {
  const { plan, steps, toolCalls, elapsedMs, budgetMs, toolTrace } = input;
  const lines: string[] = [
    `## 本回合因超时中止（进度已保留，回复「继续」可接着做）`,
    ``,
    `时间预算 ${humanDuration(budgetMs)}已用尽（实际 ${humanDuration(elapsedMs)}），已跑 ${steps} 步、${toolCalls} 次工具调用后被中止。这不是执行出错，也不是模型放弃。`,
  ];
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
  payload: ApprovalPayload;
}

const MODES: PermissionMode[] = ['readonly', 'ask', 'auto', 'full'];

/** 一轮最多带几张图，再多只会让 prompt 变贵，不会更准。 */
const MAX_IMAGES_PER_TURN = 4;

/** ProviderImage 加附件标识，便于把图片写回消息 blocks。 */
interface AttachedImage extends ProviderImage {
  id: string;
  bytes: number;
}

function imagesOf(blocks: AgentMessageBlock[], dir: string): AttachedImage[] {
  const out: AttachedImage[] = [];
  for (const block of blocks) {
    if (block.type !== 'image' || !block.attachmentId) continue;
    const file = readAttachment(dir, block.attachmentId);
    if (file) out.push({ id: block.attachmentId, mime: file.mime, base64: file.buffer.toString('base64'), bytes: file.buffer.length });
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
export function visibleAgentTools(settings: Pick<AppSettings, 'features'>, allowMcp: boolean) {
  return providerTools().filter(
    (tool) =>
      (settings.features.skills || !tool.name.startsWith('skill_')) &&
      ((settings.features.mcp && allowMcp) || !tool.name.startsWith('mcp_')),
  );
}

export class AgentHost {
  private active = new Map<string, AbortController>();
  private approvals = new Map<string, PendingApproval>();
  /** "本会话允许"：跨回合保留，直到会话删除或进程退出。 */
  private sessionAllowed = new Map<string, Set<string>>();
  /** "始终允许"：本次运行内跨会话保留；重启 AiDB 后重新询问。 */
  private alwaysAllowed = new Set<string>();

  constructor(private opts: AgentHostOptions) {}

  forgetSessionApprovals(sessionId: string): void {
    this.sessionAllowed.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  abort(sessionId: string): boolean {
    const controller = this.active.get(sessionId);
    if (!controller) return false;
    controller.abort();
    // 立即落状态：provider 卡住时 runtime 可能迟迟不返回，UI 不能一直显示“运行中”
    this.opts.store.updateSession(sessionId, { status: 'aborted' });
    for (const [id, pending] of this.approvals) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.approvals.delete(id);
      pending.resolve({ decision: 'deny', scope: 'once' });
    }
    return true;
  }

  resolveApproval(id: string, decision: ApprovalDecision['decision'], scope: ApprovalDecision['scope']): boolean {
    const pending = this.approvals.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.approvals.delete(id);
    const session = this.opts.store.getSession(pending.sessionId);
    const connId =
      typeof pending.payload.call.args.connectionId === 'string'
        ? pending.payload.call.args.connectionId
        : session?.connectionId;
    this.opts.store.addAudit({
      actor: 'agent',
      connectionId: connId,
      tool: pending.payload.call.name,
      sql: pending.payload.sql,
      risk: pending.payload.risk,
      approval: `${decision}:${scope}`,
      status: decision === 'allow' ? 'ok' : 'denied',
      meta: { approvalId: id, sessionId: pending.sessionId, scope },
    });
    pending.resolve({ decision, scope });
    return true;
  }

  private waitApproval(payload: ApprovalPayload, sessionId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(payload.id);
        resolve({ decision: 'deny', scope: 'once' });
      }, 5 * 60 * 1000);
      this.approvals.set(payload.id, { resolve, timer, sessionId, payload });
    });
  }

  private loadImages(ids?: string[]): AttachedImage[] {
    const out: AttachedImage[] = [];
    for (const id of (ids ?? []).slice(0, MAX_IMAGES_PER_TURN)) {
      const file = readAttachment(this.opts.config.attachmentDir, id);
      if (!file) throw new DbError(`图片附件不存在，请重新上传：${id}`, { code: 'ATTACHMENT_NOT_FOUND', status: 400 });
      out.push({ id, mime: file.mime, base64: file.buffer.toString('base64'), bytes: file.buffer.length });
    }
    return out;
  }

  async startTurn(sessionId: string, input: TurnInput, emit: (event: AgentEvent) => void): Promise<void> {
    if (this.active.has(sessionId)) throw new DbError('该会话正在运行，请先中止或等待完成', { code: 'SESSION_BUSY', status: 409 });
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
    const stored = connectionId ? this.opts.store.getConnection(connectionId) : undefined;
    // 目标库按「本回合 > 会话记录 > 连接默认」取，并替换进 conn，
    // 让 schema、召回、业务上下文、提示词和工具默认库都指向同一个库。
    // 会话库只在连接没换时才有意义，换了连接就退回新连接的默认库
    const sameConnection = !session.connectionId || !connectionId || session.connectionId === connectionId;
    const database = input.database || (sameConnection ? session.database : undefined) || stored?.database;
    const conn = stored ? { ...stored, database } : undefined;
    const initMatch = /^\/init(?:\s+([\s\S]+))?$/i.exec(rawText);
    if (initMatch) {
      await this.runInit(sessionId, input, rawText, initMatch[1]?.trim(), emit);
      return;
    }
    const settings = this.opts.store.getSettings();
    const profile = getModelProfile(settings.agent);
    if (input.images?.length && !supportsInput(profile, 'image')) {
      throw new DbError('当前模型没有开启图片输入，请在 设置 → 模型能力 里勾选「图片」。', { code: 'MODEL_NO_VISION', status: 400 });
    }
    const images = this.loadImages(input.images);
    const provider = createProvider(settings.agent);
    // 步数预算在这里先定：它同时喂给 runtime 与时间预算推导，两处各算一次必然漂移。
    // 语义命令通常要「看结构 → 多次查数 → 出图」，给足步数；普通提问保持用户设置。
    const maxSteps = intent ? Math.min(40, Math.max(16, (settings.agent.maxSteps || 12) * 2)) : settings.agent.maxSteps;
    const turnBudgetMs =
      this.opts.turnBudgetMs?.({ maxSteps, ...(intent?.timeoutMs ? { intentTimeoutMs: intent.timeoutMs } : {}) }) ??
      resolveTurnBudgetMs({ maxSteps, ...(intent?.timeoutMs ? { intentTimeoutMs: intent.timeoutMs } : {}), env: process.env });
    const startedAt = Date.now();
    // 超时不是用户的选择，续跑检查点也不该在用户主动停止时出现——这个标记是两者唯一的分水岭。
    // runtime 用 abortCause() 取它，因此必须在中止发生后才被读，不能在创建时快照。
    let timedOut = false;
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    // 硬上限：模型端整条流卡死时也要结束回合，避免会话永远 running
    const turnTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
      this.opts.store.updateSession(sessionId, { status: 'aborted' });
    }, turnBudgetMs);
    turnTimer.unref();

    const store = this.opts.store;
    const historyMessages = store.listMessages(sessionId);
    const history: ProviderMessage[] = [];
    for (const m of historyMessages) {
      if (m.role === 'user') {
        const past = imagesOf(m.blocks, this.opts.config.attachmentDir);
        history.push({ role: 'user', content: m.content, ...(past.length ? { images: past } : {}) });
      } else if (m.role === 'assistant' && (m.content || m.blocks.length)) {
        const trace = m.blocks.filter((b) => b.type === 'tool_call').map((b) => b.tool).filter(Boolean);
        history.push({
          role: 'assistant',
          content: `${m.content}${trace.length ? `\n\n[used tools: ${[...new Set(trace)].join(', ')}]` : ''}`.trim(),
        });
      }
    }

    let schemas: DatabaseSchema[] | undefined;
    let schemaError: string | undefined;
    if (conn) {
      try {
        schemas = await this.opts.manager.schema(conn.id, conn.database);
      } catch (err: any) {
        schemaError = err?.message ?? '无法读取结构';
      }
    }
    let brief: LoadedBrief | undefined;
    if (conn) {
      const record = this.opts.store.getDatabaseBrief(conn.id, conn.database);
      const briefPath = record?.path ?? defaultBriefPath(this.opts.config.home, conn);
      const briefMarkdown = await readBrief(briefPath);
      if (briefMarkdown && schemas) brief = loadBrief(briefMarkdown, briefPath, schemas);
    }

    const recall = conn
      ? store.recallForTurn(text, { connectionId: conn.id, database: conn.database })
      : { memories: [] as Memory[], glossary: [] as Memory[], sqlExamples: [] as Memory[] };
    const memories = recall.memories;
    const businessContext = conn ? store.agentContextBundle(conn.id, conn.database) : undefined;
    const attachmentTables = (input.attachments ?? []).map(String).slice(0, 12);
    const compacted = compactHistory(history.slice(-24), historyTokenBudget(settings.agent, profile));

    const title = session.title === '新会话' || !session.title ? rawText.slice(0, 28) : session.title;
    store.updateSession(sessionId, {
      connectionId,
      database,
      title,
      permissionMode: mode,
      status: 'running',
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
      switch (event.type) {
        case 'thinking_delta':
          thinking += event.text;
          break;
        case 'tool_call':
          callInfo.set(event.callId, { call: { id: event.callId, name: event.tool, args: (event.args ?? {}) as Record<string, unknown> }, risk: event.risk });
          blocks.push({ type: 'tool_call', callId: event.callId, tool: event.tool, args: event.args, risk: event.risk });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            callId: event.callId,
            tool: event.tool,
            result: event.result,
            status: event.result.ok ? 'ok' : 'error',
          });
          store.addToolRun({
            id: event.callId,
            sessionId,
            tool: event.tool,
            args: callInfo.get(event.callId)?.call.args,
            result: event.result,
            status: event.result.ok ? 'ok' : 'error',
            risk: callInfo.get(event.callId)?.risk,
            durationMs: event.result.meta.durationMs,
          });
          break;
        case 'plan':
          blocks.push({ type: 'plan', items: event.items });
          break;
        default:
          break;
      }
      emit(event);
    };

    const memoryContext: Memory[] = memories;
    const allowMcp = input.disableMcp !== true;
    const allowedTools = visibleAgentTools(settings, allowMcp);
    const sessionAllowed = this.sessionAllowed.get(sessionId) ?? new Set<string>();
    this.sessionAllowed.set(sessionId, sessionAllowed);
    const runtime = new AgentRuntime({
      provider,
      maxSteps,
      temperature: settings.agent.temperature,
      maxTokens: maxOutputTokensOf(settings.agent, profile),
      // 单条工具结果给模型看的字符预算：模型档案声明了上下文窗口才谈得上「智能计算」，
      // 窗口越大开局给得越多，跑到后半程按已用 tokens 自动收窄。没配档案时
      // 退回原来的 16000 固定值（设置 → 模型能力 里填了上下文窗口即可启用）。
      resultCharBudget: (usedTokens) =>
        modelResultCharBudget({
          contextWindow: profile?.contextWindow,
          maxOutputTokens: maxOutputTokensOf(settings.agent, profile),
          usedTokens,
        }),
      // 长回合的中途压缩线：contextTokens 超过它时折叠最早的工具往返，防止窗口顶穿。
      // 声明了上下文窗口的模型才有意义；没声明 → 0 = 不压缩，行为与改造前一致。
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
        if (settings.agent.provider !== 'local') extra.push(capabilityPromptBlock());
        if (settings.agent.provider === 'local') {
          extra.push('## Runtime\nYou are running with the offline Local Reasoner. Keep to clear, rule-parsable instructions; if a request is ambiguous, explain what you can do.');
        }
        return `${base}\n${extra.join('\n\n')}`;
      },
      tools: allowedTools,
      getTool: (name) => allowedTools.some((tool) => tool.name === name) ? getTool(name) : undefined,
      executeTool: (call, signal) => {
        const contextDb = businessContext?.database?.toLowerCase() ?? '';
        const targetDb = String(call.args.database ?? conn?.database ?? '').toLowerCase();
        const scoped = !contextDb || !targetDb || targetDb === contextDb;
        const disabled = scoped ? businessContext?.disabledTables ?? [] : [];
        if (disabled.length) {
          if (allTableScanNeedsScope(call, disabled)) return Promise.resolve(scopeRequiredError(call.name));
          const target = disabledTableTarget(call, disabled);
          if (target) return Promise.resolve(disabledToolError(target));
          if (typeof call.args.sql === 'string') {
            const sql = call.args.sql;
            if (systemCatalogQuery(sql)) return Promise.resolve(metadataBlockedError());
            const blocked = disabledTableInSql(sql, disabled);
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
        }
        return this.opts.executor
          .execute(call, { sessionId, connectionId: conn?.id, database: conn?.database, disabledTables: disabled, signal })
          .then((result) => filterDisabledObjects(call, result, disabled));
      },
      requestApproval: (payload) => this.waitApproval(payload, sessionId),
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
        alwaysAllowed: this.alwaysAllowed,
        signal: controller.signal,
        // 预算相关的三个字段一起给：runtime 靠 deadlineAt 决定何时追加收敛提醒，
        // 靠 turnBudgetMs 把「还剩多少」说成人话，靠 abortCause 区分超时与用户中止。
        deadlineAt: startedAt + turnBudgetMs,
        turnBudgetMs,
        abortCause: () => (timedOut ? 'timeout' : 'user'),
      });
      status = result.status;
      usage = result.usage;
      const finalBlocks = thinking ? [{ type: 'thinking' as const, text: thinking }, ...blocks] : blocks;
      store.appendMessage({ sessionId, role: 'assistant', content: result.text, blocks: finalBlocks, tokens: result.usage.tokensOut });
      // 超时中止时补一条续跑检查点。必须写在半截正文之后：正文是模型说过的话，
      // 检查点是「它本来还要做什么」，两者顺序颠倒会让下一轮的上下文读起来像倒叙。
      if (result.status === 'aborted' && result.abortCause === 'timeout') {
        store.appendMessage({
          sessionId,
          role: 'assistant',
          content: buildResumeCheckpoint({
            plan: result.plan,
            steps: result.steps,
            toolCalls: result.toolCalls,
            elapsedMs: Date.now() - startedAt,
            budgetMs: turnBudgetMs,
            toolTrace: blocks.filter((b) => b.type === 'tool_call').map((b) => b.tool).filter(Boolean) as string[],
          }),
        });
      }
      const previous = store.getSession(sessionId);
      const summaryLine = `Q: ${text.slice(0, 200)}\nA: ${result.text.slice(0, 400)}`;
      const summary = `${previous?.summary ? `${previous.summary}\n---\n` : ''}${summaryLine}`.slice(-6000);
      store.updateSession(sessionId, {
        status: result.status === 'done' ? 'done' : result.status === 'aborted' ? 'aborted' : 'error',
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
        model: settings.agent.provider === 'local' ? 'local' : settings.agent.model,
      });
      if (result.status === 'done' && settings.agent.followUpSuggestions) {
        for (const item of this.followUps(blocks, schemas, businessContext)) emit({ type: 'suggestions', items: item });
      }
      if (settings.agent.autoMemory) this.captureMemories(text, result.text, sessionId, conn);
    } catch (err: any) {
      status = 'error';
      store.updateSession(sessionId, { status: 'error' });
      emit({ type: 'error', code: err?.code ?? 'AGENT_ERROR', message: err?.message ?? 'Agent 运行失败', retryable: false });
    } finally {
      clearTimeout(turnTimer);
      this.active.delete(sessionId);
      for (const [id, pending] of this.approvals) {
        if (pending.sessionId !== sessionId) continue;
        clearTimeout(pending.timer);
        this.approvals.delete(id);
        pending.resolve({ decision: 'deny', scope: 'once' });
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
  private async runInit(sessionId: string, input: TurnInput, rawText: string, requestedPath: string | undefined, emit: (event: AgentEvent) => void): Promise<void> {
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
    const turnId = randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    timer.unref();
    const started = Date.now();
    store.updateSession(sessionId, {
      connectionId,
      database,
      status: 'running',
      title: session.title === '新会话' || !session.title ? `AI_DB · ${database || conn.name}` : session.title,
      model: 'init',
    });
    store.appendMessage({ sessionId, role: 'user', content: rawText });
    emit({ type: 'start', turnId, sessionId, model: 'init' });
    try {
      const schemas = await this.opts.manager.schema(conn.id, conn.database);
      if (controller.signal.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
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
        signal: controller.signal,
        home: this.opts.config.home,
        requestedPath,
        storedPath: record?.path,
        existing: existing ?? undefined,
      });
      if (controller.signal.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      await writeDatabaseBrief(result.path, result.markdown, existing ?? undefined);
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
      clearTimeout(timer);
      this.active.delete(sessionId);
      store.updateSession(sessionId, {
        status: 'done',
        summary: `Q: ${rawText.slice(0, 200)}\nA: ${content.slice(0, 400)}`,
      });
      emit({ type: 'text_delta', text: content });
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
      clearTimeout(timer);
      this.active.delete(sessionId);
      const aborted = controller.signal.aborted || err?.code === 'ABORTED';
      store.updateSession(sessionId, { status: aborted ? 'aborted' : 'error' });
      if (aborted) emit({ type: 'aborted', turnId, reason: '用户中止' });
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
