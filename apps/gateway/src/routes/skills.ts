import { existsSync } from 'node:fs';
import { Router } from 'express';
import {
  encodeSse,
  sseHeaders,
} from '@aidb/core';
import {
  ah,
  sseWrite,
  str,
  obj,
  type ApiDeps,
} from './shared';

export function createSkillsRouter(deps: ApiDeps): Router {
  const { store, skills, skillWorker } = deps;
  const router = Router();

  router.get('/skills', (req, res) => {
    res.json({ skills: skills.listSkills(str(req.query.includeDisabled) === '1') });
  });

  router.post('/skills/:id/runs', (req, res) => {
    const body = obj(req.body, 'body');
    res.status(202).json({ run: skillWorker.start(req.params.id, typeof body.prompt === 'string' ? body.prompt : undefined) });
  });

  router.get('/skills/runs/:id', (req, res) => {
    const state = skillWorker.get(req.params.id);
    if (!state) {
      const stored = skillWorker.runInfo(req.params.id);
      if (!stored) {
        res.status(404).json({ error: { code: 'SKILL_RUN_NOT_FOUND', message: 'Skill 运行不存在' } });
        return;
      }
      res.json({
        run: {
          runId: stored.id,
          skill: stored.skill,
          status: stored.status,
          text: stored.stdout ?? '',
          error: stored.error,
          outputs: skillWorker.runFiles(stored.id),
          workspace: stored.workspace,
          project: stored.project,
          startedAt: stored.startedAt,
          finishedAt: stored.finishedAt,
        },
      });
      return;
    }
    const run = skillWorker.runInfo(state.runId);
    res.json({
      run: {
        runId: state.runId,
        skill: state.skill,
        status: state.status,
        text: state.text,
        error: state.error,
        outputs: state.outputs,
        workspace: run?.workspace,
        project: run?.project,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      },
    });
  });

  router.post('/skills/runs/:id/answers', (req, res) => {
    const body = obj(req.body, 'body');
    const questionId = typeof body.questionId === 'string' ? body.questionId : '';
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!questionId || !answer) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'questionId 与 answer 不能为空' } });
      return;
    }
    res.json({ ok: skillWorker.answer(req.params.id, questionId, answer) });
  });

  router.get('/skills/runs/:id/files', (req, res) => {
    const area = str(req.query.area) === 'output' ? 'output' : str(req.query.area) === 'input' ? 'input' : 'workspace';
    try {
      const file = skillWorker.runFile(req.params.id, area, str(req.query.path) ?? '');
      if (!existsSync(file)) {
        res.status(404).json({ error: { code: 'SKILL_FILE_NOT_FOUND', message: '文件不存在' } });
        return;
      }
      res.sendFile(file);
    } catch (err: any) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: err?.message ?? '非法文件路径' } });
    }
  });

  router.get('/skills/runs/:id/events', (req, res) => {
    const runId = req.params.id;
    if (!skillWorker.get(runId)) {
      res.status(404).json({ error: { code: 'SKILL_RUN_NOT_FOUND', message: 'Skill 运行不存在' } });
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
      if ((event as { type?: string })?.type === 'done') {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    };
    res.on('close', cleanup);
    for (const event of skillWorker.events(runId, after)) send(event);
    if (skillWorker.isFinished(runId)) {
      cleanup();
      if (!res.writableEnded) res.end();
      return;
    }
    unsubscribe = skillWorker.subscribe(runId, send);
  });

  router.post('/skills/runs/:id/cancel', (req, res) => {
    res.json({ ok: skillWorker.cancel(req.params.id) });
  });

  router.get('/skills/:id/secrets', (req, res) => {
    const skill = skills.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: { code: 'SKILL_NOT_FOUND', message: 'Skill 不存在' } });
      return;
    }
    const manifest = skills.getManifest(req.params.id);
    res.json({ declared: manifest?.secrets ?? [], set: store.listSkillSecretNames(req.params.id) });
  });

  router.put('/skills/:id/secrets', (req, res) => {
    const manifest = skills.getManifest(req.params.id);
    const declared = manifest?.secrets ?? [];
    const body = obj(req.body, 'body');
    const secrets = body.secrets && typeof body.secrets === 'object' && !Array.isArray(body.secrets) ? (body.secrets as Record<string, unknown>) : {};
    for (const [name, value] of Object.entries(secrets)) {
      if (!declared.includes(name)) {
        res.status(400).json({ error: { code: 'SECRET_NOT_DECLARED', message: `Skill 未声明密钥 ${name}` } });
        return;
      }
      if (typeof value === 'string' && value) store.setSkillSecret(req.params.id, name, value);
      else store.deleteSkillSecret(req.params.id, name);
    }
    res.json({ declared, set: store.listSkillSecretNames(req.params.id) });
  });

  router.delete('/skills/:id/secrets/:name', (req, res) => {
    store.deleteSkillSecret(req.params.id, req.params.name);
    res.json({ declared: skills.getManifest(req.params.id)?.secrets ?? [], set: store.listSkillSecretNames(req.params.id) });
  });

  router.get('/skills/:id', (req, res) => {
    const skill = skills.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: { code: 'SKILL_NOT_FOUND', message: 'Skill 不存在' } });
      return;
    }
    res.json({ skill });
  });

  router.get('/skills/:id/file', (req, res) => {
    try {
      res.json(skills.readFile(req.params.id, str(req.query.path) ?? 'SKILL.md'));
    } catch (err: any) {
      res.status(400).json({ error: { code: 'SKILL_READ_FAILED', message: err?.message ?? '读取失败' } });
    }
  });

  router.post(
    '/skills/import',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const requestedId = str(body.id);
      if (typeof body.zipBase64 === 'string' && body.zipBase64.trim()) {
        if (body.zipBase64.length > 280_000_000) throw Object.assign(new Error('压缩包超过限制'), { code: 'SKILL_TOO_LARGE', status: 400 });
        res.status(201).json({ skill: skills.importZip(Buffer.from(body.zipBase64, 'base64'), requestedId) });
        return;
      }
      if (typeof body.git === 'string' && body.git.trim()) {
        res.status(201).json({
          skill: await skills.importGit(body.git.trim(), requestedId, { ref: str(body.ref), subdir: str(body.subdir) }),
        });
        return;
      }
      if (typeof body.npm === 'string' && body.npm.trim()) {
        res.status(201).json({ skill: await skills.importNpm(body.npm.trim(), requestedId, str(body.subdir)) });
        return;
      }
      const path = str(body.path);
      if (!path) throw Object.assign(new Error('需要 path、zipBase64、git 或 npm'), { code: 'INVALID_INPUT', status: 400 });
      res.status(201).json({ skill: skills.importDirectory(path, requestedId) });
    }),
  );

  router.post('/skills/:id/enable', (req, res) => {
    const body = obj(req.body, 'body');
    res.json({ skill: skills.setEnabled(req.params.id, body.enabled !== false) });
  });

  router.delete('/skills/:id', (req, res) => {
    skills.deleteSkill(req.params.id);
    res.status(204).end();
  });

  return router;
}
