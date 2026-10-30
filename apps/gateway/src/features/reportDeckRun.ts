import { basename } from 'node:path';
import type { ReportSpec, SkillRunInfo } from '@aidb/core';
import type { SkillRunner } from '../skillRunner';
import type { SkillStore } from '../skills';
import { buildReportDeck, parseBrandTheme } from './reportDeck';

export async function runReportDeck(skills: SkillStore, runner: SkillRunner, spec: ReportSpec, template = ''): Promise<SkillRunInfo> {
  const run = runner.createRun('ppt-master');
  try {
    const guard = await runner.run(run.id, 'guard');
    if (guard.status !== 'succeeded') throw new Error(guard.error ?? 'Skill 完整性检查失败');
    const init = await runner.run(run.id, 'project-init');
    if (init.status !== 'succeeded') throw new Error(init.error ?? '项目初始化失败');
    const project = runner.getRun(run.id).project;
    if (!project) throw new Error('项目目录未生成');
    const folder = basename(project);
    let theme = {};
    if (template) {
      if (!/^templates\/(brands|styles|layouts|decks)\/[^/]+$/.test(template)) throw new Error('模板路径必须形如 templates/brands/<id>');
      const specPath = `${template}/templates/design_spec.md`;
      theme = parseBrandTheme(skills.readFile('ppt-master', specPath, 200_000).content);
      if (!Object.keys(theme).length) throw new Error(`模板 ${template} 没有可识别的颜色定义`);
    }
    for (const page of buildReportDeck(spec, theme)) {
      runner.writeFile(run.id, 'workspace', `projects/${folder}/svg_output/${page.name}`, page.svg);
    }
    const quality = await runner.run(run.id, 'quality');
    if (quality.status !== 'succeeded') throw new Error(quality.error ?? '质量检查未通过');
    const exported = await runner.run(run.id, 'export');
    if (exported.status !== 'succeeded') throw new Error(exported.error ?? 'PPTX 导出失败');
    return runner.getRun(run.id);
  } catch (err: any) {
    const failed = runner.getRun(run.id);
    runner.updateRun(run.id, {
      status: 'failed',
      error: err?.message ?? '报告 PPTX 生成失败',
      finishedAt: failed.finishedAt ?? new Date().toISOString(),
    });
    throw err;
  }
}
