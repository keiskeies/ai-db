import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import {
  AgentRuntime,
  builtinMcpServer,
  builtinMcpServerForTool,
  builtinMcpToolRisk,
  createProvider,
  getTool,
  providerTools,
  type AgentEvent,
  type AgentRunInput,
  type ProviderTool,
  type SkillRunFile,
  type ToolDefinition,
} from '@aidb/core';
import type { ToolExecutor } from './executor';
import type { SkillRunner } from './skillRunner';
import type { SkillStore } from './skills';
import type { Store } from './store';

const WORKER_TOOL_NAMES = ['skill_read', 'skill_write', 'skill_run', 'skill_list_files', 'update_plan'];

export const SKILL_ASK_TOOL: ToolDefinition = {
  name: 'skill_ask',
  description: 'Ask the user one blocking clarification question. Use only when the skill workflow cannot proceed without a human decision.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One concise question.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  summarize: (args) => String(args.question ?? '').slice(0, 120),
};

export interface SkillWorkerQuestion {
  id: string;
  question: string;
  options?: string[];
  createdAt: string;
}

export type SkillWorkerEvent =
  | AgentEvent
  | { type: 'skill_question'; id: string; question: string; options?: string[] }
  | { type: 'skill_answer'; id: string; answer: string }
  | { type: 'skill_artifact'; workspace: string; files: SkillRunFile[] };

interface PendingQuestion {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

interface WorkerState {
  runId: string;
  skill: string;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  text: string;
  error?: string;
  events: SkillWorkerEvent[];
  listeners: Set<(event: SkillWorkerEvent) => void>;
  questions: Map<string, PendingQuestion>;
  controller: AbortController;
  outputs: SkillRunFile[];
  startedAt: string;
  finishedAt?: string;
}

function workerTools(mcpAllowed: boolean): ProviderTool[] {
  const names = mcpAllowed ? [...WORKER_TOOL_NAMES, 'mcp_list_tools', 'mcp_call'] : WORKER_TOOL_NAMES;
  return [...providerTools().filter((tool) => names.includes(tool.name)), SKILL_ASK_TOOL];
}

export class SkillWorker {
  private workers = new Map<string, WorkerState>();
  private providerFactory: (settings: ReturnType<Store['getSettings']>['agent']) => ReturnType<typeof createProvider>;

  constructor(
    private store: Store,
    private skills: SkillStore,
    private runner: SkillRunner,
    private executor: ToolExecutor,
    providerFactory?: (settings: ReturnType<Store['getSettings']>['agent']) => ReturnType<typeof createProvider>,
  ) {
    this.providerFactory = providerFactory ?? ((settings) => createProvider(settings));
  }

  start(skillId: string, prompt?: string): { runId: string; skill: string; status: string } {
    const skill = this.skills.getSkill(skillId);
    if (!skill) throw Object.assign(new Error('Skill 不存在'), { code: 'SKILL_NOT_FOUND', status: 404 });
    if (!skill.enabled) throw Object.assign(new Error('Skill 已禁用'), { code: 'SKILL_DISABLED', status: 400 });
    const manifest = this.skills.getManifest(skillId);
    if (!manifest?.entrypoints?.length) throw Object.assign(new Error('Skill 未声明 aidb.skill.json entrypoints'), { code: 'SKILL_MANIFEST_REQUIRED', status: 400 });
    const settings = this.store.getSettings();
    if (settings.agent.provider === 'local') throw Object.assign(new Error('Skill Worker 需要配置模型'), { code: 'MODEL_REQUIRED', status: 400 });
    const provider = this.providerFactory(settings.agent);
    const run = this.runner.createRun(skillId);
    const state: WorkerState = {
      runId: run.id,
      skill: skillId,
      status: 'running',
      text: '',
      events: [],
      listeners: new Set(),
      questions: new Map(),
      controller: new AbortController(),
      outputs: [],
      startedAt: new Date().toISOString(),
    };
    this.workers.set(run.id, state);
    queueMicrotask(() => void this.execute(state, skill, manifest, provider, prompt));
    return { runId: run.id, skill: skillId, status: 'running' };
  }

  get(runId: string): WorkerState | undefined {
    return this.workers.get(runId);
  }

  runInfo(runId: string): ReturnType<SkillRunner['getRun']> | undefined {
    try {
      return this.runner.getRun(runId);
    } catch {
      return undefined;
    }
  }

  runFile(runId: string, area: 'workspace' | 'input' | 'output', relative: string): string {
    return this.runner.resolveFile(runId, area, relative);
  }

  runFiles(runId: string): SkillRunFile[] {
    return this.runner.listFiles(runId).filter((file) => file.type === 'file');
  }

  events(runId: string, after = 0): SkillWorkerEvent[] {
    return this.workers.get(runId)?.events.slice(after) ?? [];
  }

  subscribe(runId: string, listener: (event: SkillWorkerEvent) => void): () => void {
    const state = this.workers.get(runId);
    if (!state) return () => undefined;
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  isFinished(runId: string): boolean {
    const state = this.workers.get(runId);
    return !state || state.status !== 'running';
  }

  cancel(runId: string): boolean {
    const state = this.workers.get(runId);
    if (!state || state.status !== 'running') return false;
    for (const pending of state.questions.values()) pending.reject(new Error('Skill 运行已取消'));
    state.questions.clear();
    state.controller.abort();
    return true;
  }

  answer(runId: string, questionId: string, answer: string): boolean {
    const state = this.workers.get(runId);
    const pending = state?.questions.get(questionId);
    if (!state || !pending) return false;
    state.questions.delete(questionId);
    pending.resolve(answer);
    this.emit(state, { type: 'skill_answer', id: questionId, answer });
    return true;
  }

  private emit(state: WorkerState, event: SkillWorkerEvent): void {
    state.events.push(event);
    if (state.events.length > 1000) state.events.shift();
    if (event.type === 'text_delta') state.text += event.text;
    for (const listener of state.listeners) listener(event);
  }

  private ask(state: WorkerState, question: string, options?: unknown): Promise<string> {
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const items = Array.isArray(options) ? options.map(String).filter(Boolean).slice(0, 8) : undefined;
    this.emit(state, { type: 'skill_question', id, question, options: items });
    return new Promise<string>((resolve, reject) => {
      state.questions.set(id, { resolve, reject });
    });
  }

  private failBeforeStart(state: WorkerState, runDir: string, code: string, message: string): void {
    state.status = 'failed';
    state.error = message;
    state.finishedAt = new Date().toISOString();
    this.emit(state, { type: 'error', code, message });
    this.emit(state, { type: 'skill_artifact', workspace: runDir, files: [] });
    this.runner.updateRun(state.runId, { status: 'failed', error: message, finishedAt: state.finishedAt });
    for (const listener of state.listeners) listener({ type: 'done', turnId: state.runId, durationMs: 0 });
    state.listeners.clear();
  }

  private async execute(
    state: WorkerState,
    skill: NonNullable<ReturnType<SkillStore['getSkill']>>,
    manifest: NonNullable<ReturnType<SkillStore['getManifest']>>,
    provider: ReturnType<typeof createProvider>,
    userPrompt?: string,
  ): Promise<void> {
    const settings = this.store.getSettings();
    const runDir = this.runner.getRun(state.runId).workspace;
    const workspace = `${runDir}/workspace`;
    const skillDir = this.skills.skillDir(state.skill);
    const readCounts = new Map<string, number>();
    const readTotals = new Map<string, number>();
    try {
      await this.runner.verifyRuntime(manifest);
    } catch (err: any) {
      this.failBeforeStart(state, runDir, 'SKILL_RUNTIME_MISSING', err?.message ?? 'Skill 运行时不可用');
      return;
    }
    let bootstrapNote = '';
    const bootstrapIds = manifest.bootstrap ? [manifest.bootstrap].flat() : [];
    let project = this.runner.getRun(state.runId).project;
    for (const bootstrapId of bootstrapIds) {
      const bootCallId = `boot-${bootstrapId}`;
      this.emit(state, {
        type: 'tool_call',
        callId: bootCallId,
        tool: 'skill_run',
        args: { entrypoint: bootstrapId },
        risk: 'read',
        summary: `bootstrap ${bootstrapId}`,
      });
      const boot = await this.runner.run(state.runId, bootstrapId, [], state.controller.signal);
      this.emit(state, {
        type: 'tool_result',
        callId: bootCallId,
        tool: 'skill_run',
        result: {
          ok: boot.status === 'succeeded',
          summary: boot.status === 'succeeded' ? `bootstrap ${bootstrapId} 完成` : boot.error ?? `bootstrap ${bootstrapId} 失败`,
          meta: { durationMs: boot.durationMs ?? 0 },
        },
      });
      if (boot.status !== 'succeeded') {
        this.failBeforeStart(state, runDir, 'SKILL_BOOTSTRAP_FAILED', boot.error ?? `Bootstrap entrypoint ${bootstrapId} 失败`);
        return;
      }
      project = boot.project ?? project;
    }
    if (project) {
      bootstrapNote = `\nBootstrap steps ${bootstrapIds.join(', ')} already ran. Project directory: ${project}\nProject directory relative to workspace: ${relative(workspace, project).replace(/\\/g, '/')}\nDo not run bootstrap entrypoints again. Write page files with skill_write into that project's svg_output before running quality or export.`;
    }
    const mcpServers = manifest.permissions?.mcp ?? [];
    const declaredMcp = this.store
      .listMcpServers()
      .filter((server) => mcpServers.includes('*') || mcpServers.includes(server.id) || mcpServers.includes(server.name));
    const mcpCatalog = declaredMcp
      .filter((server) => server.enabled)
      .map((server) => {
        const definition = server.builtin ? builtinMcpServer(server.builtin) : undefined;
        const tools = definition ? `tools: ${definition.tools.map((tool) => `${tool.name}(${tool.risk})`).join(', ')}` : 'call mcp_list_tools for its tools';
        const args = definition && server.args.length ? `; ${definition.argsLabel}: ${server.args.join(', ')}` : '';
        return `- ${server.id} (name: ${server.name}); ${tools}${args}`;
      })
      .join('\n');
    const entrypoints = (manifest.entrypoints ?? []).map((entry) => `- ${entry.id}: ${entry.command.join(' ')}${entry.args ? ` ${entry.args.join(' ')}` : ''}`).join('\n');
    const system = `You are AiDB Skill Worker for "${skill.name}" (${state.skill}). Follow the skill instructions below and complete the task in the sandbox.
Skill directory: ${skillDir}
Run id: ${state.runId}
Run dir: ${runDir}
Workspace (write generated files here): ${workspace}
Input dir: ${runDir}/input
Output dir: ${runDir}/output
Declared entrypoints (use skill_run):
${entrypoints}
${mcpServers.length ? `Authorized MCP servers (use the exact id with mcp_list_tools / mcp_call):\n${mcpCatalog || '(none enabled)'}` : 'MCP tools are not authorized for this skill.'}
${bootstrapNote}

Rules:
- Read only the skill documents you actually need via skill_read; for long documents use offset/nextOffset instead of re-reading. references/workflows are not loaded automatically.
- The run id is injected automatically; you may omit runId. Pass skill="${state.skill}" on every skill tool call.
- Write generated files with skill_write (workspace) and run only the entrypoints declared by aidb.skill.json with skill_run.
- Use skill_ask for one blocking question when human input is truly required; otherwise decide and continue.
- Never try to access databases, shell, network or files outside the skill/workspace.
- Put deliverables in the output directory when the skill workflow permits, and report their paths in the final answer.
${manifest.guide ? `\n## AiDB adapter guide (takes precedence for tool sequencing)\n${manifest.guide}\n` : ''}
## SKILL.md
${(skill.body ?? '').slice(0, 20000)}`;
    const runtime = new AgentRuntime({
      provider,
      maxSteps: Math.min(120, Math.max(60, (settings.agent.maxSteps || 20) * 2)),
      temperature: settings.agent.temperature,
      generateId: () => randomUUID(),
      tools: workerTools(mcpServers.length > 0),
      getTool: (name) => name === 'skill_ask' ? SKILL_ASK_TOOL : WORKER_TOOL_NAMES.includes(name) || (mcpServers.length > 0 && (name === 'mcp_list_tools' || name === 'mcp_call')) ? getTool(name) : undefined,
      buildSystem: () => system,
      requestApproval: async () => ({ decision: 'allow', scope: 'once' }),
      emit: (event) => this.emit(state, event),
      executeTool: async (call, signal) => {
        if (call.name === 'skill_read') {
          const path = String(call.args.path ?? 'SKILL.md');
          const offset = Math.max(0, Math.trunc(Number(call.args.offset) || 0));
          const key = `${path}:${offset}`;
          const repeats = (readCounts.get(key) ?? 0) + 1;
          readCounts.set(key, repeats);
          const total = (readTotals.get(path) ?? 0) + 1;
          readTotals.set(path, total);
          if (repeats > 1) {
            return {
              ok: false,
              summary: '同一片段已读取',
              error: { code: 'SKILL_READ_BUDGET', message: '该片段已读取过；请用 nextOffset 继续读取后续内容，不要重复同一片段。' },
              meta: { durationMs: 0 },
            };
          }
          if (total > 12) {
            return {
              ok: false,
              summary: '该文件读取次数过多',
              error: { code: 'SKILL_READ_BUDGET', message: '同一文件最多读取 12 段；请基于已读内容继续产出。' },
              meta: { durationMs: 0 },
            };
          }
        }
        if (call.name === 'skill_ask') {
          const started = Date.now();
          const question = String(call.args.question ?? '').trim();
          if (!question) {
            return {
              ok: false,
              summary: '缺少问题内容',
              error: { code: 'INVALID_INPUT', message: 'skill_ask 需要 question' },
              meta: { durationMs: 0 },
            };
          }
          try {
            const answer = await this.ask(state, question, call.args.options);
            return { ok: true, summary: `用户回答：${answer.slice(0, 200)}`, data: { answer }, meta: { durationMs: Date.now() - started } };
          } catch (err: any) {
            return {
              ok: false,
              summary: '提问已取消',
              error: { code: 'SKILL_QUESTION_CANCELED', message: err?.message ?? '提问已取消' },
              meta: { durationMs: Date.now() - started },
            };
          }
        }
        const mcpCall = call.name === 'mcp_list_tools' || call.name === 'mcp_call';
        let resolvedMcpServer = '';
        if (mcpCall) {
          const requested = String(call.args.server ?? '');
          // A built-in tool name alone resolves to its server; authorize the resolved ref,
          // otherwise omitting `server` would bypass a skill's server allowlist.
          const inferred = call.name === 'mcp_call' && !requested.trim()
            ? this.store.listMcpServers().find((item) => item.enabled && item.builtin && builtinMcpServerForTool(String(call.args.tool ?? ''))?.kind === item.builtin)
            : undefined;
          const server = requested || inferred?.id || '';
          resolvedMcpServer = server;
          if (!mcpServers.includes('*') && !declaredMcp.some((item) => item.id === server || item.name === server)) {
            return {
              ok: false,
              summary: 'MCP Server 未授权',
              error: { code: 'SKILL_MCP_DENIED', message: `Skill 未授权 MCP Server：${server || '(未指定)'}` },
              meta: { durationMs: 0 },
            };
          }
          const declared = declaredMcp.find((item) => item.id === server || item.name === server);
          if (call.name === 'mcp_call' && builtinMcpToolRisk(declared?.id ?? server, String(call.args.tool ?? '')) === 'destructive') {
            return {
              ok: false,
              summary: 'Skill 不能执行破坏性 MCP 工具',
              error: { code: 'SKILL_MCP_DESTRUCTIVE_DENIED', message: 'Skill Worker 不执行破坏性 MCP 工具（如 delete_file），请让用户在主会话确认' },
              meta: { durationMs: 0 },
            };
          }
        } else if (!WORKER_TOOL_NAMES.includes(call.name)) {
          return {
            ok: false,
            summary: 'Skill Worker 不允许该工具',
            error: { code: 'SKILL_TOOL_DENIED', message: `Skill Worker 不允许调用 ${call.name}` },
            meta: { durationMs: 0 },
          };
        }
        const boundCall = {
          ...call,
          args: { ...call.args, ...(resolvedMcpServer && !String(call.args.server ?? '').trim() ? { server: resolvedMcpServer } : {}), runId: state.runId },
        };
        return this.executor.execute(boundCall, { sessionId: `skill:${state.runId}`, signal });
      },
    });
    try {
      const result = await runtime.run({
        sessionId: `skill:${state.runId}`,
        userText: userPrompt?.trim() || 'Run this skill and produce its deliverables.',
        mode: 'auto',
        environment: 'dev',
        connectionReadonly: false,
        history: [],
        context: {},
        signal: state.controller.signal,
      } as AgentRunInput);
      state.status = result.status === 'done' ? 'succeeded' : result.status === 'aborted' ? 'canceled' : 'failed';
      state.error = result.error?.message;
      state.finishedAt = new Date().toISOString();
      state.outputs = this.runner.listFiles(state.runId).filter((file) => file.type === 'file');
      this.emit(state, { type: 'skill_artifact', workspace: runDir, files: state.outputs });
      this.runner.updateRun(state.runId, {
        status: state.status === 'succeeded' ? 'succeeded' : 'failed',
        stdout: state.text.slice(0, 200_000),
        error: state.error,
        finishedAt: state.finishedAt,
        durationMs: Date.now() - new Date(state.startedAt).getTime(),
      });
    } catch (err: any) {
      state.status = 'failed';
      state.error = err?.message ?? 'Skill Worker 失败';
      state.finishedAt = new Date().toISOString();
      state.outputs = this.runner.listFiles(state.runId).filter((file) => file.type === 'file');
      this.emit(state, { type: 'skill_artifact', workspace: runDir, files: state.outputs });
      this.runner.updateRun(state.runId, { status: 'failed', error: state.error, finishedAt: state.finishedAt });
    } finally {
      for (const pending of state.questions.values()) pending.reject(new Error('Skill 运行已结束'));
      state.questions.clear();
      for (const listener of state.listeners) listener({ type: 'done', turnId: state.runId, durationMs: 0, summary: state.text.slice(0, 200) });
      state.listeners.clear();
    }
  }
}
