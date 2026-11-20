import { Router } from 'express';
import {
  COMMANDS,
  encodeSse,
  sseHeaders,
  type ArtifactType,
  type ReportSpec,
} from '@aidb/core';
import { exportArtifact } from '../commands/export';
import { runReportDeck } from '../features/reportDeckRun';
import { executeFixPlan } from '../commands/fixExecute';
import { executeReconRepair } from '../commands/reconExecute';
import {
  ah,
  sseWrite,
  exportDownloadUrl,
  str,
  obj,
  num,
  type ApiDeps,
} from './shared';

function reportDeckOutline(result: any): string {
  const lines: string[] = [];
  for (const section of result?.sections ?? []) {
    lines.push(`## ${String(section.title ?? '')}`);
    for (const block of section.blocks ?? []) {
      if (block.kind === 'narrative' && block.text) lines.push(String(block.text));
      else if (block.kind === 'metric') for (const metric of block.metrics ?? []) lines.push(`- ${metric.label}: ${metric.value}${metric.unit ?? ''}`);
      else if (block.kind === 'comparison') lines.push(`- ${block.left?.label}: ${block.left?.value} / ${block.right?.label}: ${block.right?.value} / 差值 ${block.delta?.absolute ?? ''}`);
      else if (block.kind === 'callout' && block.text) lines.push(`> ${block.text}`);
      else if (block.kind === 'table') for (const row of (block.rows ?? []).slice(0, 30)) lines.push(`| ${row.join(' | ')} |`);
      else if (block.kind === 'chart') for (const point of (block.series ?? []).slice(0, 30)) lines.push(`- ${point.label}: ${point.value}`);
    }
  }
  return lines.join('\n').slice(0, 30_000);
}

export function createCommandsRouter(deps: ApiDeps): Router {
  const { store, manager, config, commands, executor, skills, skillWorker, skillRunner } = deps;
  const router = Router();

  // ---------- commands / artifacts ----------
  router.get('/commands', (_req, res) => res.json({ commands: COMMANDS }));

  router.post(
    '/commands/:id/runs',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const input = obj(body.input, 'input');
      const saveAs = body.saveAs && typeof body.saveAs === 'object' ? (body.saveAs as Record<string, unknown>) : {};
      const run = commands.start(req.params.id, input, { title: str(saveAs.title) });
      res.status(202).json({ run });
    }),
  );

  router.get('/commands/runs/:id', (req, res) => {
    const run = commands.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在' } });
      return;
    }
    res.json({ run });
  });

  router.get('/commands/runs/:id/events', (req, res) => {
    const runId = req.params.id;
    if (!commands.get(runId)) {
      res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在' } });
      return;
    }
    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    const after = Number(req.query.after) || 0;
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) sseWrite(res, ': ping\n\n');
    }, 15000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const send = (event: unknown) => {
      if (!closed && !res.writableEnded) sseWrite(res, encodeSse(event as Parameters<typeof encodeSse>[0]));
      const type = (event as { type?: string })?.type;
      if (type === 'run_finished') {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    };
    res.on('close', cleanup);
    for (const event of commands.events(runId, after)) {
      send(event);
      if (closed) return;
    }
    if (commands.isFinished(runId)) {
      cleanup();
      if (!res.writableEnded) res.end();
      return;
    }
    unsubscribe = commands.subscribe(runId, send);
  });

  router.post('/commands/runs/:id/cancel', (req, res) => {
    res.json({ ok: commands.cancel(req.params.id) });
  });

  router.get('/artifacts', (req, res) => {
    res.json({
      artifacts: store.listArtifacts({
        type: str(req.query.type) as ArtifactType | undefined,
        limit: num(req.query.limit, 100, 1, 500),
      }),
    });
  });

  router.get('/artifacts/:id', (req, res) => {
    const artifact = store.getArtifact(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    res.json({ artifact });
  });

  router.get('/artifacts/:id/runs', (req, res) => {
    if (!store.getArtifact(req.params.id)) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    res.json({ runs: store.listArtifactRuns(req.params.id, num(req.query.limit, 20, 1, 100)) });
  });

  router.get(
    '/artifacts/:id/export',
    ah(async (req, res) => {
      const format = str(req.query.format) === 'pptx' ? 'pptx' : 'xlsx';
      const result = await exportArtifact(store, config, req.params.id, format);
      // K5：与 /export 一致，inline 改返回下载 URL（exportArtifact 同样落在 exportDir）。
      const inline = str(req.query.inline) === '1' ? { downloadUrl: exportDownloadUrl(result.path) } : {};
      res.json({ ...result, ...inline });
    }),
  );

  router.post('/artifacts/:id/deck', (req, res) => {
    if (!store.getSettings().features.reportDeck) {
      res.status(403).json({ error: { code: 'FEATURE_DISABLED', message: 'AI PPT 已在设置中关闭' } });
      return;
    }
    const artifact = store.getArtifact(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    const run = store.listArtifactRuns(artifact.id, 1)[0];
    if (!run) {
      res.status(400).json({ error: { code: 'ARTIFACT_RUN_REQUIRED', message: '产物还没有运行结果' } });
      return;
    }
    const body = obj(req.body, 'body');
    const skill = typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : 'ppt-master';
    const template = typeof body.template === 'string' ? body.template.trim() : '';
    const deterministic = body.mode === 'deterministic' || store.getSettings().agent.provider === 'local';
    if (deterministic) {
      const spec = run.result as ReportSpec;
      if (!spec || !Array.isArray(spec.sections) || !spec.sections.length) {
        res.status(400).json({ error: { code: 'REPORT_REQUIRED', message: '确定性排版需要报告结果（report/compare）' } });
        return;
      }
      runReportDeck(skills, skillRunner, spec, template)
        .then((info) => {
          if (!res.writableEnded) res.status(201).json({ run: { runId: info.id, skill: info.skill, status: info.status }, mode: 'deterministic' });
        })
        .catch((err: any) => {
          if (!res.writableEnded) res.status(500).json({ error: { code: 'DECK_FAILED', message: err?.message ?? '报告 PPTX 生成失败' } });
        });
      return;
    }
    const outline = reportDeckOutline(run.result);
    const prompt = [
      `把下面的 AiDB 报告做成 3 页左右的中文演示文稿，直接产出原生 PPTX。`,
      `报告标题：${artifact.title}`,
      `所有数字必须逐字来自报告，不得改写、四舍五入或补充报告之外的事实。`,
      template ? `使用模板：${template}` : '',
      `报告内容：\n${outline || JSON.stringify(run.result).slice(0, 30_000)}`,
    ].filter(Boolean).join('\n\n');
    res.status(202).json({ run: skillWorker.start(skill, prompt), mode: 'agent' });
  });

  router.post(
    '/artifacts/:id/recon/execute',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      res.json(
        await executeReconRepair(store, manager, config, req.params.id, {
          confirm: String(body.confirm ?? ''),
          steps: Array.isArray(body.steps) ? body.steps.map(Number).filter((value) => Number.isInteger(value) && value >= 0) : undefined,
        }),
      );
    }),
  );

  router.post(
    '/artifacts/:id/fix/execute',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      res.json(
        await executeFixPlan(
          store,
          manager,
          config,
          req.params.id,
          {
            confirm: String(body.confirm ?? ''),
            backup: body.backup === true,
            dryRun: body.dryRun === true,
            steps: Array.isArray(body.steps) ? body.steps.map(Number).filter((value) => Number.isInteger(value) && value >= 0) : undefined,
          },
          executor,
        ),
      );
    }),
  );

  router.get('/artifacts/:id/schedule', (req, res) => {    if (!store.getArtifact(req.params.id)) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    res.json({ schedule: store.getArtifactSchedule(req.params.id) ?? null });
  });

  router.post('/artifacts/:id/schedule', (req, res) => {
    if (!store.getArtifact(req.params.id)) {
      res.status(404).json({ error: { code: 'ARTIFACT_NOT_FOUND', message: '产物不存在' } });
      return;
    }
    const body = obj(req.body, 'body');
    const intervalSeconds = num(body.intervalSeconds, 3600, 60, 30 * 86400);
    const schedule = store.upsertArtifactSchedule(req.params.id, {
      intervalSeconds,
      enabled: body.enabled !== false,
      refreshNarrative: body.refreshNarrative === true,
    });
    if (Array.isArray(body.notifyChannels)) {
      store.setArtifactScheduleNotifyChannels(
        req.params.id,
        body.notifyChannels.filter((value): value is string => typeof value === 'string'),
      );
    }
    res.json({ schedule: store.getArtifactSchedule(req.params.id) ?? schedule });
  });

  router.delete('/artifacts/:id/schedule', (req, res) => {
    store.deleteArtifactSchedule(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/artifacts/:id/runs',
    ah(async (req, res) => {
      const artifact = store.getArtifact(req.params.id);
      if (!artifact) throw Object.assign(new Error('产物不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
      const spec = artifact.spec as Record<string, unknown>;
      const command = str(spec.command) ?? artifact.type;
      const input = (spec.input && typeof spec.input === 'object' ? spec.input : { sources: spec.sources }) as Record<string, unknown>;
      const run = commands.start(command, input, { title: artifact.title, artifactId: artifact.id });
      res.status(202).json({ run });
    }),
  );

  router.delete('/artifacts/:id', (req, res) => {
    store.deleteArtifact(req.params.id);
    res.status(204).end();
  });

  return router;
}
