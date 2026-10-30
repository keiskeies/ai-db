import { getCommand,
  validateCommandInput,
  classifySql,
  type ArtifactType,
  type CommandDefinition,
  type CommandId,
  type CommandRunEvent,
  type CommandRunEventInput,
  type CommandRunInfo,
  type CommandRunInput,
  type CommandStepInfo,
} from '@aidb/core';
import type { ToolExecutor } from '../executor';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { compareValues } from '../features/compare';
import { reconcileData, type ReconLevel, type ReconMapping } from '../features/reconcile';
import { generateReport } from '../features/report';
import { generateAgentReport } from './reportAgent';
import { compareSchemas } from '../features/schemaCompare';

interface RunState {
  info: CommandRunInfo;
  artifactId: string;
  artifactRunId: string;
  events: CommandRunEvent[];
  listeners: Set<(event: CommandRunEvent) => void>;
  controller: AbortController;
  seq: number;
  finished: boolean;
  waiters: Array<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface StartCommandOptions {
  title?: string;
  originSessionId?: string;
  /** 在已有产物上追加一次运行，而不是新建产物。 */
  artifactId?: string;
  /** 整次命令超时；默认 120s。 */
  timeoutMs?: number;
}

interface StepResult {
  summary: string;
  result?: unknown;
}

const DIFF_STEP = 'schema-diff';

function defaultTitle(command: CommandDefinition, input: CommandRunInput): string {
  const labels = (input.sources ?? []).map((source) => source.label || source.connectionId).filter(Boolean);
  return `${command.title.zh}${labels.length ? ` · ${labels.join(' ↔ ')}` : ''}`;
}

export class CommandRunner {
  private runs = new Map<string, RunState>();

  constructor(
    private readonly store: Store,
    private readonly manager: ConnectionManager,
    private readonly executor?: ToolExecutor,
  ) {}

  start(commandId: string, input: CommandRunInput, options: StartCommandOptions = {}): CommandRunInfo {
    const command = getCommand(commandId);
    if (!command) throw Object.assign(new Error('命令不存在'), { code: 'COMMAND_NOT_FOUND', status: 404 });
    if (command.id === 'ask') throw Object.assign(new Error('自由提问请使用 Agent 会话'), { code: 'COMMAND_NOT_FOUND', status: 400 });
    const validation = validateCommandInput(command, input);
    if (!validation.ok) {
      throw Object.assign(new Error(validation.message), { code: 'INVALID_INPUT', status: 400, field: validation.field });
    }
    for (const source of input.sources ?? []) {
      if (!this.store.getConnection(source.connectionId)) {
        throw Object.assign(new Error(`连接不存在：${source.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
      }
    }
    if (!command.artifact) throw Object.assign(new Error('该命令不产出产物'), { code: 'COMMAND_NOT_FOUND', status: 400 });

    const title = options.title?.trim() || defaultTitle(command, input);
    const steps = this.stepPlan(command);
    const artifact = options.artifactId
      ? this.store.getArtifact(options.artifactId)
      : this.store.createArtifact({
          type: command.artifact,
          title,
          spec: {
            version: 1,
            type: command.artifact,
            title,
            command: command.id,
            sources: input.sources ?? [],
            input,
          },
          originSessionId: options.originSessionId,
        });
    if (!artifact) throw Object.assign(new Error('产物不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
    if (artifact.type !== command.artifact) {
      throw Object.assign(new Error('产物类型与命令不匹配'), { code: 'INVALID_INPUT', status: 400 });
    }
    this.store.updateArtifact(artifact.id, { status: 'running' });
    const run = this.store.addArtifactRun({
      artifactId: artifact.id,
      status: 'queued',
      input,
      steps: steps.map((step) => ({ ...step })),
    });
    const info: CommandRunInfo = {
      id: run.id,
      command: command.id,
      title,
      status: 'queued',
      input,
      steps,
      artifactId: artifact.id,
      createdAt: run.startedAt,
    };
    const state: RunState = {
      info,
      artifactId: artifact.id,
      artifactRunId: run.id,
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      seq: 0,
      finished: false,
      waiters: [],
    };
    const defaultTimeoutMs = command.id === 'report' ? 15 * 60_000 : ['compare', 'fix'].includes(command.id) ? 10 * 60_000 : 120_000;
    state.timer = setTimeout(() => {
      if (!state.finished) {
        this.store.updateArtifactRun(state.artifactRunId, {
          status: 'failed',
          error: 'COMMAND_TIMEOUT',
          finishedAt: new Date().toISOString(),
        });
        this.cancel(state.info.id);
      }
    }, options.timeoutMs ?? defaultTimeoutMs);
    state.timer.unref?.();
    this.runs.set(run.id, state);
    this.emit(state, { type: 'run_started', runId: run.id, command: command.id, startedAt: new Date().toISOString() });
    queueMicrotask(() => void this.execute(command, state));
    return { ...info, steps: info.steps.map((step) => ({ ...step })) };
  }

  get(runId: string): CommandRunInfo | undefined {
    const state = this.runs.get(runId);
    if (!state) return undefined;
    return { ...state.info, steps: state.info.steps.map((step) => ({ ...step })) };
  }

  events(runId: string, after = 0): CommandRunEvent[] {
    const state = this.runs.get(runId);
    if (!state) return [];
    return state.events.filter((event) => event.seq > after);
  }

  subscribe(runId: string, listener: (event: CommandRunEvent) => void): () => void {
    const state = this.runs.get(runId);
    if (!state) return () => undefined;
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  isFinished(runId: string): boolean {
    return this.runs.get(runId)?.finished ?? true;
  }

  waitForRun(runId: string): Promise<CommandRunInfo | undefined> {
    const state = this.runs.get(runId);
    if (!state) return Promise.resolve(undefined);
    if (state.finished) return Promise.resolve({ ...state.info, steps: state.info.steps.map((step) => ({ ...step })) });
    return new Promise((resolve) => {
      state.waiters.push(() => resolve({ ...state.info, steps: state.info.steps.map((step) => ({ ...step })) }));
    });
  }

  startArtifact(artifactId: string): CommandRunInfo {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) throw Object.assign(new Error('产物不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
    const spec = artifact.spec as Record<string, unknown>;
    const command = (typeof spec.command === 'string' ? spec.command : artifact.type) as CommandId;
    const input = (spec.input && typeof spec.input === 'object' ? spec.input : { sources: spec.sources }) as CommandRunInput;
    return this.start(command, input, { artifactId: artifact.id, title: artifact.title });
  }

  cancel(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state || state.finished) return false;
    state.controller.abort();
    state.info.status = 'canceled';
    state.info.finishedAt = new Date().toISOString();
    state.info.durationMs = state.info.startedAt ? Date.now() - new Date(state.info.startedAt).getTime() : undefined;
    for (const step of state.info.steps) {
      if (step.status === 'running') {
        step.status = 'canceled';
        step.finishedAt = state.info.finishedAt;
      }
    }
    this.store.updateArtifactRun(state.artifactRunId, {
      status: 'canceled',
      steps: state.info.steps,
      finishedAt: state.info.finishedAt,
      durationMs: state.info.durationMs,
    });
    this.store.updateArtifact(state.artifactId, { status: 'ready' });
    state.finished = true;
    if (state.timer) clearTimeout(state.timer);
    this.emit(state, {
      type: 'run_finished',
      runId: state.info.id,
      status: 'canceled',
      durationMs: state.info.durationMs ?? 0,
    });
    for (const resolve of state.waiters.splice(0)) resolve();
    return true;
  }

  private stepPlan(command: CommandDefinition): CommandStepInfo[] {
    switch (command.id) {
      case 'diff':
        return [{ id: DIFF_STEP, label: '结构差异', kind: 'deterministic', status: 'pending' }];
      case 'recon':
        return [{ id: 'recon', label: '数据对账', kind: 'deterministic', status: 'pending' }];
      case 'report':
        return [{ id: 'report', label: '生成报告', kind: 'deterministic', status: 'pending' }];
      case 'compare':
        return [{ id: 'compare', label: '分析对比', kind: 'agent', status: 'pending' }];
      case 'fix':
        return [{ id: 'fix', label: '体检与修复计划', kind: 'deterministic', status: 'pending' }];
      default:
        return [{ id: 'run', label: command.title.zh, kind: command.execution === 'deterministic' ? 'deterministic' : 'agent', status: 'pending' }];
    }
  }

  private async execute(command: CommandDefinition, state: RunState): Promise<void> {
    state.info.status = 'running';
    state.info.startedAt = new Date().toISOString();
    this.store.updateArtifactRun(state.artifactRunId, { status: 'running' });
    try {
      const step = state.info.steps[0];
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      this.emit(state, { type: 'step_started', runId: state.info.id, stepId: step.id, label: step.label, kind: step.kind });
      if (state.controller.signal.aborted) return;
      const result = await this.executeStep(command, state, step);
      if (state.controller.signal.aborted) return;
      step.status = 'ok';
      step.summary = result.summary;
      step.finishedAt = new Date().toISOString();
      step.durationMs = step.startedAt ? Date.now() - new Date(step.startedAt).getTime() : 0;
      this.emit(state, {
        type: 'step_succeeded',
        runId: state.info.id,
        stepId: step.id,
        summary: result.summary,
        durationMs: step.durationMs,
      });
      state.info.status = 'succeeded';
      state.info.finishedAt = new Date().toISOString();
      state.info.durationMs = Date.now() - new Date(state.info.startedAt).getTime();
      this.store.updateArtifactRun(state.artifactRunId, {
        status: 'succeeded',
        steps: state.info.steps,
        result: result.result,
        finishedAt: state.info.finishedAt,
        durationMs: state.info.durationMs,
      });
      this.store.updateArtifact(state.artifactId, { status: 'ready' });
      this.emit(state, {
        type: 'artifact_ready',
        runId: state.info.id,
        artifactId: state.artifactId,
        artifactType: command.artifact as ArtifactType,
        title: state.info.title,
      });
      this.finish(state, 'succeeded');
    } catch (err: any) {
      if (state.controller.signal.aborted) return;
      const step = state.info.steps[0];
      step.status = 'error';
      step.error = { code: err?.code ?? 'COMMAND_FAILED', message: err?.message ?? '命令执行失败' };
      step.finishedAt = new Date().toISOString();
      step.durationMs = step.startedAt ? Date.now() - new Date(step.startedAt).getTime() : 0;
      this.emit(state, {
        type: 'step_failed',
        runId: state.info.id,
        stepId: step.id,
        error: step.error,
      });
      state.info.status = 'failed';
      state.info.error = step.error;
      state.info.finishedAt = new Date().toISOString();
      state.info.durationMs = Date.now() - new Date(state.info.startedAt).getTime();
      this.store.updateArtifactRun(state.artifactRunId, {
        status: 'failed',
        steps: state.info.steps,
        error: step.error.message,
        finishedAt: state.info.finishedAt,
        durationMs: state.info.durationMs,
      });
      this.store.updateArtifact(state.artifactId, { status: 'error' });
      this.emit(state, { type: 'error', runId: state.info.id, code: step.error.code, message: step.error.message });
      this.finish(state, 'failed');
    }
  }

  private async executeStep(command: CommandDefinition, state: RunState, step: CommandStepInfo): Promise<StepResult> {
    switch (command.id) {
      case 'diff': {
        const [left, right] = state.info.input.sources ?? [];
        const started = Date.now();
        const diff = await compareSchemas(
          this.store,
          this.manager,
          left.connectionId,
          left.database,
          right.connectionId,
          right.database,
          {
            includeDrops: state.info.input.includeDrops === true,
            tables: Array.isArray(state.info.input.tables) ? (state.info.input.tables as string[]) : undefined,
          },
        );
        this.store.addAudit({
          actor: 'user',
          connectionId: left.connectionId,
          database: left.database,
          tool: 'command.diff',
          risk: 'read',
          approval: 'none',
          status: 'ok',
          durationMs: Date.now() - started,
          meta: {
            runId: state.info.id,
            artifactId: state.artifactId,
            sourceId: left.connectionId,
            targetId: right.connectionId,
            tables: state.info.input.tables ?? null,
          },
        });
        return {
          summary: `${diff.tables.length} 张表 · ${diff.summary.statements} 条语句${
            diff.tables.some((table) => table.changes.some((change) => change.destructive)) ? ' · 含破坏性变更' : ''
          }`,
          result: diff,
        };
      }
      case 'recon': {
        const input = state.info.input as Record<string, unknown>;
        const mapping = input.mapping as ReconMapping | undefined;
        if (!mapping || typeof mapping !== 'object') {
          throw Object.assign(new Error('需要键与字段映射'), { code: 'RECON_MAPPING_REQUIRED', status: 400 });
        }
        const started = Date.now();
        const level = (input.level === 'keys' || input.level === 'fields' ? input.level : 'counts') as ReconLevel;
        const result = await reconcileData(this.store, this.manager, { ...mapping, maxKeys: Number(input.maxKeys) || mapping.maxKeys }, level);
        this.store.addAudit({
          actor: 'user',
          connectionId: mapping.left?.connectionId,
          database: mapping.left?.database,
          tool: 'command.recon',
          risk: 'read',
          approval: 'none',
          status: 'ok',
          durationMs: Date.now() - started,
          meta: {
            runId: state.info.id,
            artifactId: state.artifactId,
            left: mapping.left,
            right: mapping.right,
            level,
            comparedKeys: result.summary.comparedKeys,
            truncated: result.summary.truncated,
          },
        });
        const parts = [
          `${result.summary.comparedKeys} 键`,
          `${result.summary.missingInRight} 缺失`,
          `${result.summary.extraInRight} 多余`,
          `${result.summary.valueChanged} 改值`,
        ];
        if (result.summary.typeDrift) parts.push(`${result.summary.typeDrift} 类型漂移`);
        return { summary: parts.join(' · '), result };
      }
      case 'report': {
        const input = state.info.input as Record<string, unknown>;
        const sources = (input.sources ?? []) as Array<{ connectionId: string; database?: string; label?: string }>;
        const started = Date.now();
        const topic = String(input.topic ?? '数据概览');
        const tables = Array.isArray(input.tables) ? (input.tables as string[]) : undefined;
        const settings = this.store.getSettings();
        let spec;
        if (settings.agent.provider !== 'local' && this.executor) {
          try {
            spec = await generateAgentReport(this.store, this.manager, this.executor, { sources, topic, tables }, state.controller.signal);
            spec.meta.notes = [...(spec.meta.notes ?? []), '报告由 Agent 查数并生成；数字经过工具结果来源校验。'];
          } catch (err: any) {
            spec = await generateReport(this.store, this.manager, { sources, topic, tables }, state.controller.signal);
            spec.meta.notes = [...(spec.meta.notes ?? []), `Agent 报告未生成，已回退确定性统计：${err?.message ?? '未知错误'}`];
          }
        } else {
          spec = await generateReport(this.store, this.manager, { sources, topic, tables }, state.controller.signal);
        }
        this.store.addAudit({
          actor: 'user',
          connectionId: sources[0]?.connectionId,
          database: sources[0]?.database,
          tool: 'command.report',
          risk: 'read',
          approval: 'none',
          status: 'ok',
          durationMs: Date.now() - started,
          meta: {
            runId: state.info.id,
            artifactId: state.artifactId,
            sources: sources.map((source) => source.connectionId),
            layout: spec.layout,
            sections: spec.sections.length,
          },
        });
        return { summary: `${spec.sections.length} 个章节 · ${spec.layout}`, result: spec };
      }
      case 'compare': {
        const input = state.info.input as Record<string, unknown>;
        const sources = (input.sources ?? []) as Array<{ connectionId: string; database?: string; label?: string }>;
        const started = Date.now();
        const metric = String(input.metric ?? '指标');
        const leftLabel = String(input.leftLabel ?? 'A');
        const rightLabel = String(input.rightLabel ?? 'B');
        const queryA = typeof input.queryA === 'string' ? input.queryA : undefined;
        const queryB = typeof input.queryB === 'string' ? input.queryB : undefined;
        const settings = this.store.getSettings();
        let spec;
        if (settings.agent.provider !== 'local' && this.executor) {
          try {
            spec = await generateAgentReport(this.store, this.manager, this.executor, {
              sources,
              topic: metric,
              mode: 'compare',
              leftLabel,
              rightLabel,
              queryA,
              queryB,
            }, state.controller.signal);
            spec.meta.notes = [...(spec.meta.notes ?? []), '对比由 Agent 查数并生成；数字经过工具结果来源校验。'];
          } catch (err: any) {
            spec = await compareValues(this.store, this.manager, { sources, metric, leftLabel, rightLabel, queryA, queryB });
            spec.meta.notes = [...(spec.meta.notes ?? []), `Agent 对比未生成，已回退确定性对比：${err?.message ?? '未知错误'}`];
          }
        } else {
          spec = await compareValues(this.store, this.manager, { sources, metric, leftLabel, rightLabel, queryA, queryB });
        }
        this.store.addAudit({
          actor: 'user',
          connectionId: sources[0]?.connectionId,
          database: sources[0]?.database,
          tool: 'command.compare',
          risk: 'read',
          approval: 'none',
          status: 'ok',
          durationMs: Date.now() - started,
          meta: {
            runId: state.info.id,
            artifactId: state.artifactId,
            sources: sources.map((source) => source.connectionId),
            metric,
          },
        });
        return { summary: `对比 ${sources.length} 个源 · ${spec.layout}`, result: spec };
      }
      case 'fix': {
        const input = state.info.input as Record<string, unknown>;
        const sources = (input.sources ?? []) as Array<{ connectionId: string; database?: string; label?: string }>;
        const source = sources[0];
        if (!source) throw Object.assign(new Error('缺少连接'), { code: 'INVALID_INPUT', status: 400 });
        if (!this.executor) throw Object.assign(new Error('执行器未初始化'), { code: 'COMMAND_FAILED', status: 500 });
        const started = Date.now();
        const audit = await this.executor.execute(
          { id: `fix-${state.info.id}`, name: 'audit_database', args: { connectionId: source.connectionId, database: source.database } },
          { sessionId: `command:${state.info.id}`, connectionId: source.connectionId, database: source.database, signal: state.controller.signal },
        );
        if (!audit.ok) {
          throw Object.assign(new Error(audit.error?.message ?? '体检失败'), { code: audit.error?.code ?? 'FIX_FAILED', status: 400 });
        }
        const data = (audit.data ?? {}) as {
          findings?: Array<{ severity: string; code: string; title: string; table?: string; detail: string; suggestedSql?: string }>;
          summary?: Record<string, number>;
        };
        const findings = (data.findings ?? []).map((finding) => {
          let risk: 'read' | 'write' | 'ddl' | 'destructive' = 'read';
          if (finding.suggestedSql) {
            try {
              risk = classifySql(finding.suggestedSql).risk;
            } catch {
              risk = 'ddl';
            }
          }
          return {
            ...finding,
            risk,
            requiresBackup: risk === 'ddl' || risk === 'destructive',
            sql: finding.suggestedSql,
          };
        });
        const mode = input.mode === 'repair' ? 'repair' : 'check';
        const plan = mode === 'repair'
          ? findings.filter((finding) => Boolean(finding.sql)).map((finding) => ({
              finding: finding.code,
              table: finding.table,
              title: finding.title,
              sql: finding.sql,
              risk: finding.risk,
              requiresBackup: finding.requiresBackup,
            }))
          : [];
        this.store.addAudit({
          actor: 'user',
          connectionId: source.connectionId,
          database: source.database,
          tool: mode === 'repair' ? 'command.fix.plan' : 'command.fix.check',
          risk: 'read',
          approval: 'none',
          status: 'ok',
          durationMs: Date.now() - started,
          meta: {
            runId: state.info.id,
            artifactId: state.artifactId,
            findings: findings.length,
            plan: plan.length,
          },
        });
        const summary = data.summary ?? {};
        return {
          summary: `${summary.tablesChecked ?? 0} 张表 · ${findings.length} 项发现${plan.length ? ` · ${plan.length} 条计划` : ''}`,
          result: {
            mode,
            connection: source,
            summary,
            findings,
            plan,
            note: mode === 'repair'
              ? '修复计划已生成；v1 不自动执行，执行前必须备份并逐条审批。'
              : '当前为只检查模式，未生成写操作。',
          },
        };
      }
      default:
        throw Object.assign(new Error(`命令 ${command.id} 尚未实现`), { code: 'COMMAND_NOT_IMPLEMENTED', status: 501 });
    }
  }

  private finish(state: RunState, status: 'succeeded' | 'failed'): void {
    state.info.status = status;
    state.finished = true;
    if (state.timer) clearTimeout(state.timer);
    this.emit(state, {
      type: 'run_finished',
      runId: state.info.id,
      status,
      durationMs: state.info.durationMs ?? 0,
    });
    state.listeners.clear();
    for (const resolve of state.waiters.splice(0)) resolve();
  }

  private emit(state: RunState, event: CommandRunEventInput): void {
    const full = { ...event, seq: ++state.seq } as CommandRunEvent;
    state.events.push(full);
    if (state.events.length > 500) state.events.shift();
    for (const listener of state.listeners) listener(full);
  }
}
