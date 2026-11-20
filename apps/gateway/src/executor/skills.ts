import { defineTool, ok } from './types';

/** G6：skill_worker_run 轮询总时长上限，与 skillRunner 的 10min 默认超时对齐。 */
const SKILL_WORKER_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export const skillListTool = defineTool('skill_list', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const skills = s.skills.listSkills(a.includeDisabled === true);
  return ok(started, `${skills.length} 个 Skill`, { skills });
});

export const skillReadTool = defineTool('skill_read', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const skill = String(a.skill ?? '');
  const result = s.skills.readFile(skill, typeof a.path === 'string' ? a.path : 'SKILL.md', typeof a.maxChars === 'number' ? a.maxChars : undefined, typeof a.offset === 'number' ? a.offset : undefined);
  return ok(started, `${skill}/${result.path}${result.truncated ? '（已截断）' : ''}`, result);
});

export const skillWriteTool = defineTool('skill_write', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const runId = s.skillRunId(ctx, String(a.skill ?? ''), a.runId);
  const area = a.area === 'output' ? 'output' : 'workspace';
  const file = s.skillRunner.writeFile(runId, area, String(a.path ?? ''), String(a.content ?? ''));
  return ok(started, `已写入 ${area}/${String(a.path)}`, { runId, path: file });
});

export const skillRunTool = defineTool('skill_run', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const runId = s.skillRunId(ctx, String(a.skill ?? ''), a.runId);
  const result = await s.skillRunner.run(runId, String(a.entrypoint ?? ''), Array.isArray(a.args) ? a.args.map(String) : [], ctx.signal);
  return {
    ok: result.status === 'succeeded',
    summary: result.status === 'succeeded' ? `Skill ${result.skill} 运行完成` : result.error ?? `Skill 状态 ${result.status}`,
    data: result,
    ...(result.status === 'succeeded' ? {} : { error: { code: result.status === 'timed_out' ? 'SKILL_TIMEOUT' : 'SKILL_RUN_FAILED', message: result.error ?? 'Skill 运行失败' } }),
    meta: { durationMs: result.durationMs ?? 0 },
  };
});

export const skillListFilesTool = defineTool('skill_list_files', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const runId = s.skillRunId(ctx, String(a.skill ?? ''), a.runId);
  return ok(started, `${runId} 文件清单`, { runId, files: s.skillRunner.listFiles(runId) });
});

export const skillWorkerRunTool = defineTool('skill_worker_run', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  if (!s.skillWorker) throw new Error('Skill Worker 未启用');
  const worker = s.skillWorker;
  const prompt = String(a.prompt ?? '');
  const startedRun = worker.start(String(a.skill ?? ''), prompt);
  // G6：轮询必须有总时长上限——worker 卡在非终态（子进程僵尸、事件丢失）时
  // 无限等待会把 Agent 回合永久钉死。与 skillRunner 的 10min 默认超时对齐，
  // 超时取消并按失败处理。长任务（PPT）的时长问题应在 skillRunner 层解决
  // （其超时可按 skill 配置），而不是靠这里无限轮询兜底。
  const pollDeadline = Date.now() + SKILL_WORKER_POLL_TIMEOUT_MS;
  for (;;) {
    if (ctx.signal?.aborted) {
      worker.cancel(startedRun.runId);
      return { ok: false, summary: 'Skill Worker 已取消', error: { code: 'CANCELED', message: '运行已取消' }, meta: { durationMs: Date.now() - started } };
    }
    const state = worker.get(startedRun.runId);
    if (!state || state.status !== 'running') {
      const outputs = state?.outputs ?? [];
      let project: string | undefined;
      try {
        project = s.skillRunner.getRun(startedRun.runId).project;
      } catch {
        project = undefined;
      }
      const succeeded = state?.status === 'succeeded';
      return {
        ok: succeeded,
        summary: succeeded ? `Skill Worker 完成 · ${outputs.filter((file) => file.type === 'file').length} 个文件` : state?.error ?? 'Skill Worker 失败',
        data: { runId: startedRun.runId, skill: String(a.skill ?? ''), status: state?.status, text: state?.text ?? '', outputs, project },
        ...(succeeded ? {} : { error: { code: 'SKILL_WORKER_FAILED', message: state?.error ?? 'Skill Worker 失败' } }),
        meta: { durationMs: Date.now() - started },
      };
    }
    if (Date.now() > pollDeadline) {
      worker.cancel(startedRun.runId);
      return { ok: false, summary: 'Skill Worker 超时', error: { code: 'SKILL_TIMEOUT', message: `Skill Worker 超过 ${SKILL_WORKER_POLL_TIMEOUT_MS}ms 未到终态，已取消` }, meta: { durationMs: Date.now() - started } };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
