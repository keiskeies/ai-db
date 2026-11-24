import { type PipelineSpec, validatePipelineSpec, type ToolResult } from '@aidb/core';
import { DbError } from '../drivers';
import { runPipelineAndRecord } from '../features/pipelines';
import { transferData } from '../features/transfer';
import { defineTool, ok } from './types';

export const transferDataTool = defineTool('transfer_data', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  // 进度快照：只保留最后一个 table-start / phase-done，执行结束后随 meta 返回。
  // 这不是流式——Agent 工具仍是一次调用返回一次结果。
  let progress: ToolResult['meta']['progress'];
  const result = await transferData(s.store, s.manager, {
    sourceId: String(a.sourceConnectionId ?? ''),
    sourceDatabase: typeof a.sourceDatabase === 'string' ? a.sourceDatabase : undefined,
    targetId: String(a.targetConnectionId ?? ''),
    targetDatabase: typeof a.targetDatabase === 'string' ? a.targetDatabase : undefined,
    tables: Array.isArray(a.tables) ? a.tables.filter((value): value is string => typeof value === 'string') : undefined,
    mode: a.mode === 'replace' ? 'replace' : 'append',
    createMissing: a.createMissing !== false,
    limit: typeof a.limit === 'number' ? a.limit : undefined,
    executionId: ctx.executionId,
    signal: ctx.signal,
    onEvent: (event) => {
      if (event.type === 'table-start') {
        progress = { current: event.index, total: event.total, unit: 'table', label: event.table };
      } else if (event.type === 'phase-done') {
        progress = { current: progress?.current ?? 0, total: progress?.total ?? 0, unit: 'table', label: event.table };
      }
    },
  });
  const failed = result.results.filter((item) => item.status === 'error');
  const state = failed.length === 0 ? 'ok' : failed.length === result.results.length ? 'failed' : 'partial';
  const failures = failed.map((item) => `${item.table}:${item.error ?? ''}`).slice(0, 3).join('；');
  const summary = failed.length
    ? `传输 ${result.results.length} 张表 · ${result.totalRows} 行 · ${failed.length} 张失败${failures ? `（${failures}）` : ''}`
    : `传输 ${result.results.length} 张表 · ${result.totalRows} 行`;
  return ok(started, summary, result, {
    state,
    ...(progress ? { progress } : {}),
    rowsAffected: result.totalRows,
  });
});

export const managePipelineTool = defineTool('manage_pipeline', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const action = String(a.action ?? 'list');

  if (action === 'list') {
    const list = s.store.listPipelines().map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      state: item.state,
      lastStatus: item.lastStatus,
      lastError: item.lastError,
      steps: item.spec.steps.map((step) => ({ id: step.id, type: step.type, label: step.label })),
    }));
    return ok(started, `${list.length} 条数据流`, { pipelines: list });
  }

  const specIssues = (value: unknown) => validatePipelineSpec(value, { strictParams: true });

  if (action === 'validate') {
    const issues = specIssues(a.spec);
    return ok(started, issues.length ? `定义有 ${issues.length} 处问题` : '定义可用', { issues }, { state: issues.length ? 'failed' : 'ok' });
  }

  if (action === 'create' || action === 'update') {
    const issues = specIssues(a.spec);
    if (issues.length) {
      return {
        ok: false,
        summary: `定义有 ${issues.length} 处问题，先修再来`,
        error: { code: 'PIPELINE_SPEC_INVALID', message: issues.map((issue) => issue.message).join('；'), hint: '按 message 逐条改 spec，再 validate 一次' },
        meta: { durationMs: Date.now() - started, state: 'failed' },
      };
    }
    const spec = a.spec as PipelineSpec;
    if (action === 'create') {
      const name = String(a.name ?? '').trim();
      if (!name) throw new DbError('创建数据流需要 name', { code: 'INVALID_INPUT' });
      const created = s.store.createPipeline({
        name,
        description: typeof a.description === 'string' ? a.description : undefined,
        connectionId: typeof a.connectionId === 'string' ? a.connectionId : undefined,
        database: typeof a.database === 'string' ? a.database : undefined,
        spec,
      });
      return ok(started, `已创建数据流「${created.name}」（${spec.steps.length} 步）`, { id: created.id, steps: spec.steps.map((step) => ({ id: step.id, type: step.type })) }, { state: 'ok' });
    }
    const target = s.findPipeline(a.id, a.name);
    const updated = s.store.updatePipeline(target.id, {
      name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : target.name,
      description: typeof a.description === 'string' ? a.description : target.description,
      spec,
    });
    return ok(started, `已更新数据流「${updated.name}」（${spec.steps.length} 步）`, { id: updated.id }, { state: 'ok' });
  }

  if (action === 'run') {
    const target = s.findPipeline(a.id, a.name);
    const dryRun = a.dryRun === true;
    const run = await runPipelineAndRecord({ store: s.store, manager: s.manager, config: s.config }, target, {
      trigger: 'manual',
      params: a.params && typeof a.params === 'object' ? (a.params as Record<string, unknown>) : undefined,
      previewOnly: dryRun,
      executionId: ctx.executionId,
      signal: ctx.signal,
    });
    // 样本行不上对话：一行几百字节，历史里已经存过了。
    const stepViews = run.steps.map((step) => ({
      id: step.id,
      type: step.type,
      label: step.label,
      status: step.status,
      inRows: step.inRows,
      outRows: step.outRows,
      durationMs: step.durationMs,
      error: step.error,
      hint: step.meta?.hint,
      ...(dryRun && step.preview ? { preview: step.preview.slice(0, 1200) } : {}),
    }));
    const summary = run.status === 'ok'
      ? `${dryRun ? '预览通过' : '数据流完成'}：${run.steps.length} 步 / ${run.rowsOut ?? 0} 行`
      : `数据流失败：${run.error ?? '未知错误'}`;
    return ok(started, summary, { runId: run.id, status: run.status, steps: stepViews }, {
      state: run.status === 'ok' ? 'ok' : 'failed',
      rowsAffected: run.rowsOut,
    });
  }

  if (action === 'delete') {
    const target = s.findPipeline(a.id, a.name);
    s.store.deletePipeline(target.id);
    return ok(started, `已删除数据流「${target.name}」`, { id: target.id }, { state: 'ok' });
  }

  throw new DbError(`未知的 action：${action}`, { code: 'INVALID_INPUT', hint: '可用：list / validate / create / update / run / delete' });
});
