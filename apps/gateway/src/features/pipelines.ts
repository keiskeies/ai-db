import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  PIPELINE_STEP_KINDS,
  encodeSse,
  sseHeaders,
  validatePipelineSpec,
  type PipelineCredentialInfo,
  type PipelineEvent,
  type PipelineInfo,
  type PipelineRunInfo,
  type PipelineSpec,
} from '@aidb/core';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { runPipeline } from '../pipeline/runner';
import { checkPython } from '../pipeline/script';
import { PipelineAbortedError, PipelineError } from '../pipeline/types';

/**
 * 数据流处理的 REST 层。
 *
 * 运行有三条入口：界面「运行」（SSE）、界面「试运行到第 N 步」（JSON，目标端只
 * 渲染不执行）、调度器直接调用 runner（进程内，见 scheduler.ts）。三条路共用
 * 同一个 runner，行为不会漂。
 */

const ah =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

function badRequest(message: string, code = 'PIPELINE_INVALID', hint?: string): Error {
  return Object.assign(new Error(message), { code, status: 400, hint });
}

function notFound(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, status: 404 });
}

function readSpec(value: unknown): PipelineSpec {
  if (!value || typeof value !== 'object') throw badRequest('缺少流水线定义 spec');
  const spec = value as PipelineSpec;
  const issues = validatePipelineSpec(spec);
  if (issues.length) throw badRequest(`流水线定义有问题：${issues.map((issue) => issue.message).join('；')}`, 'PIPELINE_SPEC_INVALID', issues[0]?.message);
  return spec;
}

export interface PipelinesDeps {
  store: Store;
  manager: ConnectionManager;
  config: GatewayConfig;
}

export interface ExecuteOptions {
  trigger: 'manual' | 'scheduled' | 'trial';
  params?: Record<string, unknown>;
  previewOnly?: boolean;
  uptoIndex?: number;
  onEvent?: (event: PipelineEvent) => void;
  shouldAbort?: () => boolean;
  /** 定时任务用调度时刻作为批次时间，同一批次重跑得到同样的窗口。 */
  batchAt?: string;
  /** 试运行不落历史、不回写断点，也不记写入审计。 */
  record?: boolean;
}

export function createPipelinesRouter(deps: PipelinesDeps): Router {
  const { store, manager, config } = deps;
  const router = Router();
  /** 正在运行的流水线：同一条不并发跑，取消靠这里传信号。 */
  const active = new Map<string, { aborted: boolean }>();

  const requireEnabled = () => {
    if (store.getSettings().features.pipelines !== true) throw badRequest('数据流处理功能已在设置里关闭', 'PIPELINE_FEATURE_DISABLED');
  };

  const execute = async (pipeline: PipelineInfo, options: ExecuteOptions): Promise<PipelineRunInfo> => {
    if (active.has(pipeline.id)) throw Object.assign(new Error('这条流水线正在运行'), { code: 'PIPELINE_BUSY', status: 409 });
    const slot = { aborted: false };
    active.set(pipeline.id, slot);
    try {
      return await runPipelineAndRecord(deps, pipeline, {
        ...options,
        shouldAbort: () => slot.aborted || options.shouldAbort?.() === true,
      });
    } finally {
      active.delete(pipeline.id);
    }
  };

  router.get('/', (_req, res) => {
    res.json({ pipelines: store.listPipelines() });
  });

  router.get('/meta', ah(async (_req, res) => {
    const settings = store.getSettings();
    res.json({
      steps: PIPELINE_STEP_KINDS,
      python: await checkPython(),
      enabled: settings.features.pipelines === true,
      scriptsEnabled: settings.features.pipelineScripts === true,
    });
  }));

  router.post('/validate', (req, res) => {
    res.json({ issues: validatePipelineSpec(req.body?.spec ?? { version: 1, steps: [] }) });
  });

  router.get('/credentials', (_req, res) => {
    res.json({ credentials: store.listPipelineCredentials() });
  });

  router.post('/credentials', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const kind = String(body.kind ?? '');
    if (!name) throw badRequest('凭证需要名称');
    if (!['bearer', 'basic', 'apikey', 'header'].includes(kind)) throw badRequest('凭证类型不支持');
    const secret = (body.secret ?? {}) as Record<string, unknown>;
    if (kind === 'bearer' && !String(secret.token ?? '').trim()) throw badRequest('Bearer 凭证缺少 token');
    if (kind === 'basic' && !String(secret.username ?? '').trim()) throw badRequest('Basic 凭证缺少用户名');
    if ((kind === 'apikey' || kind === 'header') && !String(secret.value ?? '').trim()) throw badRequest('API Key 凭证缺少密钥值');
    const credential = store.createPipelineCredential({ name, kind: kind as PipelineCredentialInfo['kind'], secret });
    res.status(201).json({ credential });
  });

  router.delete('/credentials/:id', (req, res) => {
    store.deletePipelineCredential(req.params.id);
    res.status(204).end();
  });

  router.get('/runs/:runId', (req, res) => {
    const run = store.getPipelineRun(req.params.runId);
    if (!run) throw notFound('运行记录不存在', 'PIPELINE_RUN_NOT_FOUND');
    res.json({ run });
  });

  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw badRequest('流水线需要名称');
    const pipeline = store.createPipeline({
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
      database: typeof body.database === 'string' ? body.database : undefined,
      spec: readSpec(body.spec),
    });
    res.status(201).json({ pipeline });
  });

  const mustGet = (id: string): PipelineInfo => {
    const pipeline = store.getPipeline(id);
    if (!pipeline) throw notFound('流水线不存在', 'PIPELINE_NOT_FOUND');
    return pipeline;
  };

  router.put('/:id', (req, res) => {
    const existing = mustGet(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pipeline = store.updatePipeline(req.params.id, {
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name,
      description: typeof body.description === 'string' ? body.description : existing.description,
      connectionId: typeof body.connectionId === 'string' ? body.connectionId : existing.connectionId,
      database: typeof body.database === 'string' ? body.database : existing.database,
      spec: body.spec === undefined ? existing.spec : readSpec(body.spec),
      enabled: body.enabled === undefined ? existing.enabled : Boolean(body.enabled),
    });
    res.json({ pipeline });
  });

  router.delete('/:id', (req, res) => {
    store.deletePipeline(req.params.id);
    res.status(204).end();
  });

  router.get('/:id/runs', (req, res) => {
    mustGet(req.params.id);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
    res.json({ runs: store.listPipelineRuns(req.params.id, limit) });
  });

  router.post('/:id/state/reset', (req, res) => {
    mustGet(req.params.id);
    store.resetPipelineState(req.params.id);
    res.json({ pipeline: store.getPipeline(req.params.id) });
  });

  /** 试运行：跑到第 index 步（含），默认目标端只渲染不执行。 */
  router.post('/:id/trial', ah(async (req, res) => {
    requireEnabled();
    const pipeline = mustGet(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const run = await execute(pipeline, {
      trigger: 'trial',
      previewOnly: body.execute !== true,
      uptoIndex: body.index === undefined ? undefined : Math.max(0, Number(body.index) || 0),
      params: (body.params as Record<string, unknown>) ?? undefined,
    });
    res.json({ run });
  }));

  router.post('/:id/run', ah(async (req, res) => {
    requireEnabled();
    const pipeline = mustGet(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const run = await execute(pipeline, { trigger: 'manual', params: (body.params as Record<string, unknown>) ?? undefined });
    res.json({ run });
  }));

  router.post('/:id/stream', ah(async (req, res) => {
    requireEnabled();
    const pipeline = mustGet(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (active.has(pipeline.id)) throw Object.assign(new Error('这条流水线正在运行'), { code: 'PIPELINE_BUSY', status: 409 });
    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    let closed = false;
    let finished = false;
    const heartbeat = setInterval(() => {
      if (!finished && !closed && !res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    res.on('close', () => {
      if (!res.writableEnded) closed = true;
    });
    const send = (event: PipelineEvent) => {
      if (finished || closed || res.writableEnded) return;
      res.write(encodeSse(event));
    };
    try {
      await execute(pipeline, {
        trigger: 'manual',
        previewOnly: body.previewOnly === true,
        uptoIndex: body.uptoIndex === undefined ? undefined : Number(body.uptoIndex),
        params: (body.params as Record<string, unknown>) ?? undefined,
        onEvent: send,
        shouldAbort: () => closed,
      });
      if (!closed && !res.writableEnded) res.end();
    } catch (err: any) {
      const message = err instanceof PipelineError || err instanceof PipelineAbortedError ? err.message : String(err?.message ?? '运行失败');
      if (!closed && !res.writableEnded) {
        send({ type: 'error', code: err?.code ?? 'PIPELINE_ERROR', message });
        res.end();
      }
    } finally {
      finished = true;
      clearInterval(heartbeat);
    }
  }));

  router.post('/:id/cancel', (req, res) => {
    const slot = active.get(req.params.id);
    if (slot) slot.aborted = true;
    res.json({ ok: Boolean(slot) });
  });

  return router;
}

/** 调度器复用：不经过 HTTP，直接跑并落历史与断点。 */
/**
 * 跑一条流水线并落库：历史、断点、审计都集中在这里，REST 与调度器共用，
 * 避免两条路径的记录方式漂开。断点只在成功时前进，失败保留旧水位。
 */
export async function runPipelineAndRecord(deps: PipelinesDeps, pipeline: PipelineInfo, options: ExecuteOptions): Promise<PipelineRunInfo> {
  const { store, manager, config } = deps;
  const started = Date.now();
  const outcome = await runPipeline({ store, manager, config }, {
    pipeline,
    trigger: options.trigger,
    params: options.params,
    previewOnly: options.previewOnly,
    batchAt: options.batchAt,
    uptoIndex: options.uptoIndex,
    onEvent: options.onEvent,
    shouldAbort: options.shouldAbort,
  });
  const run = outcome.run;
  if (options.record === false || options.trigger === 'trial') return run;
  store.recordPipelineRun(run);
  if (run.status === 'ok') {
    store.setPipelineState(pipeline.id, outcome.state);
    store.markPipelineRun(pipeline.id, 'ok');
  } else {
    store.markPipelineRun(pipeline.id, 'error', run.error);
  }
  store.addAudit({
    actor: 'user',
    connectionId: pipeline.connectionId,
    database: pipeline.database,
    tool: `pipeline.${options.trigger}`,
    risk: options.previewOnly ? 'read' : 'write',
    approval: options.trigger === 'scheduled' ? 'scheduled' : 'manual',
    status: run.status === 'ok' ? 'ok' : 'error',
    durationMs: Date.now() - started,
    meta: { pipeline: pipeline.name, pipelineId: pipeline.id, runId: run.id, steps: run.steps.length, rows: run.rowsOut, error: run.error },
  });
  return run;
}

/**
 * 自动化任务（type='pipeline'）的执行体：按列表顺序依次跑选中的流水线。
 *
 * 一条失败不中断后面的流水线——定时窗口里丢一整批数据的代价，通常比跳过一条
 * 有问题的大。失败条数会带回任务状态，界面上能看到「2/3 成功」。
 */
export async function runPipelinesForJob(deps: PipelinesDeps, pipelineIds: string[], batchAt: string): Promise<{ ok: number; failed: number; message: string }> {
  if (deps.store.getSettings().features.pipelines !== true) return { ok: 0, failed: pipelineIds.length, message: '数据流处理功能已在设置里关闭' };
  let ok = 0;
  let failed = 0;
  const parts: string[] = [];
  let firstError: string | undefined;
  for (const id of pipelineIds) {
    const pipeline = deps.store.getPipeline(id);
    if (!pipeline) {
      failed += 1;
      firstError = firstError ?? '有流水线已被删除';
      parts.push('已删除的流水线：不存在');
      continue;
    }
    // 启停属于「自动化任务」这一层，流水线只是定义；不在这里二次判断，避免两处开关。
    try {
      const run = await runPipelineAndRecord(deps, pipeline, { trigger: 'scheduled', batchAt });
      if (run.status === 'ok') {
        ok += 1;
        parts.push(`${pipeline.name}：${run.message ?? `${run.rowsOut ?? 0} 行`}`);
      } else {
        failed += 1;
        firstError = firstError ?? `${pipeline.name}：${run.error ?? '失败'}`;
        parts.push(`${pipeline.name}：失败（${run.error ?? '未知原因'}）`);
      }
    } catch (err: any) {
      failed += 1;
      firstError = firstError ?? `${pipeline.name}：${err?.message ?? '运行失败'}`;
      parts.push(`${pipeline.name}：${err?.message ?? '运行失败'}`);
    }
  }
  return { ok, failed, message: `${ok}/${pipelineIds.length} 条成功｜${parts.join('；')}`.slice(0, 500) };
}
