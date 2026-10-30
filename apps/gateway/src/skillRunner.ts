import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { SkillEntrypoint, SkillManifest, SkillRunFile, SkillRunInfo } from '@aidb/core';
import type { SkillStore } from './skills';

const MAX_OUTPUT = 200_000;
const execFileAsync = promisify(execFile);

function compareVersion(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function safePath(root: string, relative: string): string {
  if (!relative || relative.startsWith('/') || relative.includes('\u0000') || relative.split(/[\\/]/).includes('..')) {
    throw new Error('非法文件路径');
  }
  const target = resolve(join(root, relative));
  if (!target.startsWith(root + sep) && target !== root) throw new Error('文件路径越界');
  return target;
}

function resolveCommand(command: string, manifest: { permissions?: { process?: string[] } }): string {
  if (command === '${node}') return process.execPath;
  if (command === '${python}') {
    if (manifest.permissions?.process && !manifest.permissions.process.includes('python')) throw new Error('Skill 未声明 python 执行权限');
    return process.env.AIDB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  }
  throw new Error(`不允许的 skill 命令：${command}`);
}

function render(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([a-zA-Z]+)\}/g, (_, key: string) => vars[key] ?? '');
}

export class SkillRunner {
  readonly root: string;

  constructor(
    private skills: SkillStore,
    home: string,
    private getSecrets?: (skillId: string, names: string[]) => Record<string, string>,
  ) {
    this.root = join(home, 'skill-runs');
    mkdirSync(this.root, { recursive: true });
  }

  private runPath(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('非法 runId');
    return join(this.root, runId);
  }

  private writeRun(run: SkillRunInfo): void {
    writeFileSync(join(this.runPath(run.id), 'run.json'), JSON.stringify(run, null, 2));
  }

  updateRun(runId: string, patch: Partial<SkillRunInfo>): SkillRunInfo {
    const run = { ...this.getRun(runId), ...patch };
    this.writeRun(run);
    return run;
  }

  createRun(skillId: string): SkillRunInfo {
    if (!this.skills.getSkill(skillId)) throw new Error('Skill 不存在');
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = this.runPath(id);
    for (const area of ['workspace', 'input', 'output', 'logs']) mkdirSync(join(dir, area), { recursive: true });
    const run: SkillRunInfo = {
      id,
      skill: skillId,
      workspace: dir,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.writeRun(run);
    return run;
  }

  getRun(runId: string): SkillRunInfo {
    const file = join(this.runPath(runId), 'run.json');
    if (!existsSync(file)) throw new Error('Skill 运行不存在');
    return JSON.parse(readFileSync(file, 'utf8')) as SkillRunInfo;
  }

  /** 在启动 Worker 前检查声明的 Python 版本与包，缺依赖时给出可执行的安装提示。 */
  async verifyRuntime(manifest: SkillManifest): Promise<void> {
    const runtime = manifest.runtime;
    if (!runtime?.python) return;
    if (!manifest.permissions?.process?.includes('python')) throw new Error('Skill 声明了 Python 运行时但未声明 process 权限');
    const bin = process.env.AIDB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    let output = '';
    try {
      const result = await execFileAsync(bin, ['--version'], { timeout: 10_000, windowsHide: true });
      output = `${result.stdout} ${result.stderr}`.trim();
    } catch (err: any) {
      throw new Error(`找不到可用的 Python（${bin}）：${err?.message ?? err}`);
    }
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (!match) throw new Error(`无法识别 Python 版本：${output}`);
    const current = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (const token of runtime.python.split(/\s+/).filter(Boolean)) {
      const spec = /^(>=|<=|>|<)(\d+)\.(\d+)(?:\.(\d+))?$/.exec(token);
      if (!spec) continue;
      const target = [Number(spec[2]), Number(spec[3]), Number(spec[4] ?? 0)];
      const cmp = compareVersion(current, target);
      const failed =
        (spec[1] === '>=' && cmp < 0) ||
        (spec[1] === '>' && cmp <= 0) ||
        (spec[1] === '<=' && cmp > 0) ||
        (spec[1] === '<' && cmp >= 0);
      if (failed) throw new Error(`Python ${current.join('.')} 不满足要求 ${runtime.python}（${bin}）`);
    }
    for (const pkg of runtime.pythonPackages ?? []) {
      const script = `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec(${JSON.stringify(pkg)}) else 1)`;
      try {
        await execFileAsync(bin, ['-c', script], { timeout: 10_000, windowsHide: true });
      } catch {
        throw new Error(`缺少 Python 包 ${pkg}；请运行 ${bin} -m pip install ${pkg}`);
      }
    }
  }

  /** 解析 `${project}`：优先读取 project-init 写入的标记，否则取 projects/ 下最新的目录。 */
  private projectPath(runId: string, workspace: string): string | undefined {
    const marker = join(workspace, '.aidb', 'project.json');
    if (existsSync(marker)) {
      try {
        const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { path?: string };
        if (parsed.path && existsSync(parsed.path)) return parsed.path;
      } catch {
        /* fall back to scanning */
      }
    }
    const projects = join(workspace, 'projects');
    if (!existsSync(projects)) return undefined;
    const dirs = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ path: join(projects, entry.name), mtime: statSync(join(projects, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return dirs[0]?.path;
  }

  writeFile(runId: string, area: 'workspace' | 'output', relative: string, content: string): string {
    const run = this.getRun(runId);
    const manifest = this.skills.getManifest(run.skill);
    const allowed = manifest?.permissions?.fs ?? [];
    if (!allowed.includes(area)) throw new Error(`Skill 未声明 ${area} 写权限`);
    const dir = join(this.runPath(runId), area);
    const target = safePath(dir, relative);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
    return target;
  }

  resolveFile(runId: string, area: 'workspace' | 'input' | 'output', relative: string): string {
    this.getRun(runId);
    if (!['workspace', 'input', 'output'].includes(area)) throw new Error('非法文件区域');
    return safePath(join(this.runPath(runId), area), relative);
  }

  listFiles(runId: string): SkillRunFile[] {
    const run = this.getRun(runId);
    const out: SkillRunFile[] = [];
    for (const area of ['workspace', 'input', 'output'] as const) {
      const root = join(this.runPath(runId), area);
      const walk = (dir: string, prefix = '') => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            out.push({ path: rel, area, type: 'directory' });
            walk(join(dir, entry.name), rel);
          } else if (entry.isFile()) {
            out.push({ path: rel, area, type: 'file', size: statSync(join(dir, entry.name)).size });
          }
        }
      };
      walk(root);
    }
    return out;
  }

  async run(runId: string, entrypointId: string, extraArgs: string[] = [], signal?: AbortSignal): Promise<SkillRunInfo> {
    const existing = this.getRun(runId);
    const { manifest, entry } = this.skills.getEntrypoint(existing.skill, entrypointId);
    const skillDir = this.skills.skillDir(existing.skill);
    const workspace = join(this.runPath(runId), 'workspace');
    const input = join(this.runPath(runId), 'input');
    const output = join(this.runPath(runId), 'output');
    const project = this.projectPath(runId, workspace);
    const vars = { skillDir, workspace, input, output, runId, project: project ?? '' };
    const command = resolveCommand(entry.command[0], manifest);
    if (extraArgs.length && entry.allowArgs !== true) throw new Error(`entrypoint ${entrypointId} 不接受额外参数`);
    if (manifest.bootstrap && [manifest.bootstrap].flat().includes(entrypointId) && existing.project) {
      throw new Error(`bootstrap entrypoint ${entrypointId} 已执行`);
    }
    const rawArgs = [...(entry.command.slice(1) ?? []), ...(entry.args ?? []), ...extraArgs];
    if (rawArgs.some((arg) => arg.includes('${project}')) && !project) {
      throw new Error('Skill 尚未创建项目，请先运行 project-init');
    }
    const args = rawArgs.map((arg) => render(arg, vars));
    const timeoutMs = Math.max(1000, Math.min(entry.timeoutMs ?? 10 * 60 * 1000, 30 * 60 * 1000));
    const run: SkillRunInfo = {
      ...existing,
      status: 'running',
      entrypoint: entrypointId,
      startedAt: new Date().toISOString(),
      error: undefined,
      exitCode: undefined,
      stdout: '',
      stderr: '',
      finishedAt: undefined,
      durationMs: undefined,
    };
    this.writeRun(run);
    const started = Date.now();
    return new Promise((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let canceled = false;
      const child = spawn(command, args, {
        cwd: workspace,
        env: {
          ...process.env,
          SKILL_DIR: skillDir,
          SKILL_WORKSPACE: workspace,
          SKILL_INPUT_DIR: input,
          SKILL_OUTPUT_DIR: output,
          ...(manifest.secrets?.length && this.getSecrets ? this.getSecrets(existing.skill, manifest.secrets) : {}),
          ...(entry.env ?? {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      const onAbort = () => {
        canceled = true;
        child.kill('SIGKILL');
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-MAX_OUTPUT);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_OUTPUT);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        run.status = 'failed';
        run.error = err.message;
        run.finishedAt = new Date().toISOString();
        run.durationMs = Date.now() - started;
        this.writeRun(run);
        resolvePromise(run);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        run.status = timedOut ? 'timed_out' : canceled ? 'failed' : code === 0 ? 'succeeded' : 'failed';
        run.exitCode = code;
        run.stdout = stdout;
        run.stderr = stderr;
        run.error = timedOut
          ? `Skill 运行超时（${timeoutMs}ms）`
          : canceled
            ? 'Skill 运行已取消'
            : code === 0
              ? undefined
              : `退出码 ${code}`;
        if (code === 0 && entrypointId === 'project-init') {
          const created = this.projectPath(runId, workspace);
          if (created) {
            mkdirSync(join(workspace, '.aidb'), { recursive: true });
            writeFileSync(join(workspace, '.aidb', 'project.json'), JSON.stringify({ path: created }, null, 2));
            run.project = created;
          }
        }
        run.finishedAt = new Date().toISOString();
        run.durationMs = Date.now() - started;
        this.writeRun(run);
        resolvePromise(run);
      });
    });
  }
}
