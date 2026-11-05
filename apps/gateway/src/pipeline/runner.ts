import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import {
  pipelineStepKind,
  validatePipelineSpec,
  type PipelineEvent,
  type PipelineInfo,
  type PipelineRunInfo,
  type PipelineStepRun,
} from '@aidb/core';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { DuckdbSession } from './duckdb';
import { executeStep } from './steps';
import { PipelineError, PipelineAbortedError, emptyOutput, type RunFrame, type StepContext, type StepOutput } from './types';

/**
 * 流水线编排器。
 *
 * 顺序执行步骤、把每步输出挂进 `{{ steps.x }}` 作用域、发进度事件、把增量断点
 * 合并回 state。它不认识任何具体步骤类型，也不写数据库——落库由调用方（HTTP
 * 路由 / 调度器）决定，便于试运行复用同一条代码路径。
 */

const SAMPLE_ROWS = 20;
const SAMPLE_CELL_LIMIT = 400;

export interface PipelineDeps {
  store: Store;
  manager: ConnectionManager;
  config: GatewayConfig;
}

export interface RunPipelineOptions {
  pipeline: PipelineInfo;
  trigger: 'manual' | 'scheduled' | 'trial';
  params?: Record<string, unknown>;
  /** 定时任务把调度时刻作为批次时间，同一批次重跑得到同样的窗口。 */
  batchAt?: string;
  /** 试运行：目标写入与外发请求只渲染不执行。 */
  previewOnly?: boolean;
  /** 只跑到第 N 步（含），用于界面上的单步试运行。 */
  uptoIndex?: number;
  onEvent?: (event: PipelineEvent) => void;
  shouldAbort?: () => boolean;
}

export interface PipelineRunOutcome {
  run: PipelineRunInfo;
  state: Record<string, unknown>;
}

function sanitizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.slice(0, SAMPLE_ROWS).map((row) => {
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && value.length > SAMPLE_CELL_LIMIT) record[key] = `${value.slice(0, SAMPLE_CELL_LIMIT)}…`;
      else if (value !== null && typeof value === 'object') {
        const text = JSON.stringify(value);
        record[key] = text.length > SAMPLE_CELL_LIMIT ? `${text.slice(0, SAMPLE_CELL_LIMIT)}…` : value;
      } else record[key] = value;
    }
    return record;
  });
}

export async function runPipeline(deps: PipelineDeps, opts: RunPipelineOptions): Promise<PipelineRunOutcome> {
  const { store, manager } = deps;
  const spec = opts.pipeline.spec;
  const issues = validatePipelineSpec(spec);
  if (issues.length) {
    throw new PipelineError(`流水线定义有问题：${issues.map((issue) => issue.message).join('；')}`, 'PIPELINE_SPEC_INVALID', '按提示修正后重跑');
  }
  const steps = spec.steps.slice(0, opts.uptoIndex === undefined ? undefined : opts.uptoIndex + 1);
  const settings = store.getSettings();
  if (settings.features.pipelines !== true) throw new PipelineError('数据流处理功能已在设置里关闭', 'PIPELINE_FEATURE_DISABLED');

  const params: Record<string, unknown> = {};
  for (const param of spec.params ?? []) {
    if (!param?.key) continue;
    params[param.key] = opts.params?.[param.key] ?? param.default ?? '';
  }
  for (const [key, value] of Object.entries(opts.params ?? {})) if (!(key in params)) params[key] = value;

  const state: Record<string, unknown> = { ...(opts.pipeline.state ?? {}) };
  const runId = randomUUID();
  const batchAt = opts.batchAt ?? new Date().toISOString();
  const batch = new Date(batchAt);
  const startedAt = new Date().toISOString();
  const workDir = path.join(deps.config.home, 'pipeline-runs', runId);
  const frame: RunFrame = {
    id: runId,
    batchAt,
    startedAt,
    trigger: opts.trigger,
    attempt: 1,
  };

  const run: PipelineRunInfo = {
    id: runId,
    pipelineId: opts.pipeline.id,
    pipelineName: opts.pipeline.name,
    trigger: opts.trigger,
    status: 'running',
    batchAt,
    startedAt,
    rowsIn: 0,
    rowsOut: 0,
    steps: steps.map((step) => {
      const kind = pipelineStepKind(step.type);
      return {
        id: step.id,
        type: step.type,
        // 只存用户自己写的标签，没有就用步骤 id。把目录里的中文名写进运行记录，
        // 等于把一种语言烙进数据，英文界面就再也翻不回去了。
        label: step.label?.trim() || step.id,
        role: kind?.role ?? 'transform',
        status: 'pending',
      } satisfies PipelineStepRun;
    }),
  };

  const emit = async (event: PipelineEvent) => {
    opts.onEvent?.(event);
    // 同步驱动的批次不产生真实 I/O 等待，让出一个宏任务，SSE 才能逐条送达。
    if (opts.onEvent) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  await emit({
    type: 'run-start',
    runId,
    pipelineId: opts.pipeline.id,
    batchAt,
    steps: run.steps.map((step) => ({ id: step.id, label: step.label, type: step.type })),
  });

  let session: DuckdbSession | undefined;
  const scope: Record<string, unknown> = {
    params,
    state,
    run: {
      id: runId,
      batchAt,
      batchDate: Number.isNaN(batch.getTime()) ? startedAt.slice(0, 10) : batch.toISOString().slice(0, 10),
      startedAt,
      trigger: opts.trigger,
      attempt: 1,
    },
    steps: {},
  };
  const ctx: StepContext = {
    store,
    manager,
    settings,
    config: deps.config,
    workDir,
    run: frame,
    params,
    state,
    scope,
    credential: (id) => store.getPipelineCredentialSecret(id),
    duckdb: async () => {
      session ??= new DuckdbSession(workDir);
      return session;
    },
    shouldAbort: () => opts.shouldAbort?.() === true,
    previewOnly: opts.previewOnly === true,
  };

  let input: StepOutput = emptyOutput();
  let failed = false;
  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const recorded = run.steps[index];
      if (ctx.shouldAbort()) throw new PipelineAbortedError();
      if (failed) {
        recorded.status = 'skipped';
        await emit({ type: 'step-done', stepId: step.id, index, total: steps.length, run: recorded });
        continue;
      }
      const stepStarted = Date.now();
      recorded.status = 'running';
      recorded.inRows = input.rows.length;
      await emit({ type: 'step-start', stepId: step.id, index, total: steps.length, label: recorded.label });
      try {
        const outputResult = await executeStep(step, input, ctx);
        input = outputResult;
        if (outputResult.state) Object.assign(state, outputResult.state);
        (scope.steps as Record<string, unknown>)[step.id] = {
          rows: outputResult.rows,
          columns: outputResult.columns,
          count: outputResult.rows.length,
          raw: outputResult.raw ?? outputResult.rows,
          meta: outputResult.meta ?? {},
        };
        recorded.status = 'ok';
        recorded.durationMs = Date.now() - stepStarted;
        recorded.outRows = outputResult.rows.length;
        recorded.columns = outputResult.columns.slice(0, 200);
        recorded.sample = sanitizeRows(outputResult.rows);
        recorded.preview = outputResult.preview;
        recorded.meta = outputResult.meta;
        await emit({ type: 'step-done', stepId: step.id, index, total: steps.length, run: recorded });
      } catch (err: any) {
        failed = true;
        recorded.status = 'error';
        recorded.durationMs = Date.now() - stepStarted;
        recorded.error = err instanceof PipelineError ? err.message : (err?.message ?? String(err));
        if (err instanceof PipelineError && err.hint) recorded.meta = { hint: err.hint };
        run.error = `${recorded.label}：${recorded.error}`;
        run.status = 'error';
        await emit({ type: 'step-error', stepId: step.id, index, total: steps.length, run: recorded });
      }
    }
  } finally {
    await session?.close().catch(() => undefined);
    // 脚本与临时数据只在这次运行内有意义；DuckdbSession 已删自己的文件，这里兜底整个目录。
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const finishedAt = new Date().toISOString();
  run.finishedAt = finishedAt;
  run.durationMs = new Date(finishedAt).getTime() - new Date(run.startedAt).getTime();
  run.rowsIn = run.steps[0]?.outRows ?? 0;
  run.rowsOut = run.steps[run.steps.length - 1]?.outRows ?? 0;
  const lastStep = run.steps[run.steps.length - 1];
  if (!failed) {
    run.status = 'ok';
    run.message = `${run.steps.length} 步 / ${run.rowsOut} 行${lastStep?.meta?.written !== undefined ? ` · 写入 ${lastStep.meta.written}` : ''}`;
  }

  if (!failed) await emit({ type: 'done', run, durationMs: run.durationMs ?? 0 });
  return { run, state };
}
