import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SkillEntrypoint, SkillManifest, SkillRunFile, SkillRunInfo } from '@aidb/core';
import { killTree } from './processTree';
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

function normalizeCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(normalizeCase(root), normalizeCase(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function relativeParts(value: string): string[] {
  if (!value || value.includes('\u0000') || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error('非法文件路径');
  }
  return value.split(/[\\/]/).filter(Boolean);
}

function nearestExisting(value: string): string {
  let current = value;
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`路径不存在：${value}`);
    current = parent;
  }
}

/** 对不存在的尾部做 realpath 校验；已存在的祖先（含符号链接）决定最终 canonical 路径。 */
function canonicalPath(value: string): string {
  const existing = nearestExisting(value);
  const real = realpathSync(existing);
  const suffix = relative(existing, value);
  return suffix ? resolve(join(real, suffix)) : real;
}

function assertInside(root: string, candidate: string): string {
  if (!isInside(root, candidate)) throw new Error('文件路径越界');
  return candidate;
}

function safePath(root: string, relativePath: string): string {
  relativeParts(relativePath);
  return assertInside(root, canonicalPath(resolve(root, relativePath)));
}

function existingDirectory(root: string, value: string): string {
  const canonical = assertInside(root, realpathSync(value));
  if (!statSync(canonical).isDirectory()) throw new Error(`不是目录：${value}`);
  return canonical;
}

/** 逐级创建并复核目录，避免 recursive mkdir 跟随一个刚被替换成外链的中间目录。 */
function ensureDirectory(root: string, relativePath = ''): string {
  const parts = relativePath ? relativeParts(relativePath) : [];
  let current = root;
  for (const part of parts) {
    const next = join(current, part);
    try {
      const info = lstatSync(next);
      if (info.isSymbolicLink()) current = existingDirectory(root, next);
      else {
        if (!info.isDirectory()) throw new Error(`不是目录：${next}`);
        current = next;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      try {
        mkdirSync(next);
      } catch (mkdirErr: any) {
        if (mkdirErr?.code !== 'EEXIST') throw mkdirErr;
      }
      current = existingDirectory(root, next);
    }
  }
  return existingDirectory(root, current);
}

function canonicalFileTarget(root: string, parent: string, name: string): string {
  const target = join(parent, name);
  try {
    return assertInside(root, realpathSync(target));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    try {
      lstatSync(target);
    } catch (lstatErr: any) {
      if (lstatErr?.code === 'ENOENT') return target;
      throw lstatErr;
    }
    // dangling symlink：不能把它当成“尚不存在的文件”创建。
    throw new Error(`无效的文件符号链接：${target}`);
  }
}

/** 写前、写后都复核 canonical 路径；POSIX 再用 O_NOFOLLOW/O_EXCL 关闭最终文件的替换竞态。 */
function writeTextWithin(root: string, relativePath: string, content: string): string {
  const parts = relativeParts(relativePath);
  const name = parts[parts.length - 1];
  const parent = ensureDirectory(root, parts.slice(0, -1).join(sep));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = canonicalFileTarget(root, parent, name);
    const exists = existsSync(target);
    // Windows/libuv 不接受 open 的 O_TRUNC，截断放到已打开 fd 上执行。
    let flags = constants.O_WRONLY | (exists ? 0 : constants.O_CREAT | constants.O_EXCL);
    if (process.platform !== 'win32' && constants.O_NOFOLLOW !== undefined) flags |= constants.O_NOFOLLOW;
    let fd: number | undefined;
    try {
      fd = openSync(target, flags, 0o600);
      if (!fstatSync(fd).isFile()) throw new Error(`不是文件：${target}`);
      // 父目录若在 open 前被换成外链，先复核已打开文件的真实路径再截断；写后复核已经太晚。
      // Node 没有 openat，检查与写入之间仍存在同用户进程竞态，manifest 权限也不是 OS 沙箱。
      const openedPath = realpathSync(target);
      if (normalizeCase(openedPath) !== normalizeCase(target)) throw new Error('文件在写入期间发生变化，请重试');
      assertInside(root, openedPath);
      if (exists) ftruncateSync(fd, 0);
      writeFileSync(fd, content, 'utf8');
      const finalPath = realpathSync(target);
      if (normalizeCase(finalPath) !== normalizeCase(target)) throw new Error('文件在写入期间发生变化，请重试');
      assertInside(root, finalPath);
      return finalPath;
    } catch (err: any) {
      if (!exists && err?.code === 'EEXIST') continue;
      throw err;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new Error('文件在写入期间频繁发生变化，请重试');
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

/**
 * Skill 文件 API 的路径边界与权限声明检查。manifest.permissions 不是 OS 沙箱：
 * 用户安装的脚本仍拥有当前进程权限，可自行访问网络、进程与工作区之外的文件。
 */
export class SkillRunner {
  readonly root: string;

  constructor(
    private skills: SkillStore,
    home: string,
    private getSecrets?: (skillId: string, names: string[]) => Record<string, string>,
  ) {
    const root = join(home, 'skill-runs');
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  private runPath(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('非法 runId');
    return join(this.root, runId);
  }

  private runDirectory(runId: string): string {
    return existingDirectory(this.root, this.runPath(runId));
  }

  private runFile(runId: string, relativePath: string): string {
    return safePath(this.runDirectory(runId), relativePath);
  }

  private writeRun(run: SkillRunInfo): void {
    writeTextWithin(this.runDirectory(run.id), 'run.json', JSON.stringify(run, null, 2));
  }

  updateRun(runId: string, patch: Partial<SkillRunInfo>): SkillRunInfo {
    const run = { ...this.getRun(runId), ...patch };
    this.writeRun(run);
    return run;
  }

  createRun(skillId: string): SkillRunInfo {
    if (!this.skills.getSkill(skillId)) throw new Error('Skill 不存在');
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(this.runPath(id));
    const dir = this.runDirectory(id);
    for (const area of ['workspace', 'input', 'output', 'logs']) ensureDirectory(dir, area);
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
    const file = this.runFile(runId, 'run.json');
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
    const runDir = this.runDirectory(runId);
    const marker = this.runFile(runId, join('.aidb', 'project.json'));
    if (existsSync(marker)) {
      try {
        const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { path?: string };
        if (typeof parsed.path === 'string' && parsed.path) {
          const absolute = resolve(workspace, parsed.path);
          assertInside(workspace, absolute);
          const project = existingDirectory(workspace, absolute);
          if (isInside(join(workspace, 'projects'), project)) return project;
        }
      } catch {
        /* fall back to scanning */
      }
    }
    const projects = join(workspace, 'projects');
    if (!existsSync(projects)) return undefined;
    const projectRoot = existingDirectory(runDir, projects);
    const dirs = readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .flatMap((entry) => {
        const path = join(projectRoot, entry.name);
        try {
          const real = existingDirectory(workspace, path);
          return entry.isDirectory() && isInside(projectRoot, real) ? [{ path: real, mtime: statSync(real).mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    return dirs[0]?.path;
  }

  writeFile(runId: string, area: 'workspace' | 'output', relative: string, content: string): string {
    const run = this.getRun(runId);
    const manifest = this.skills.getManifest(run.skill);
    const allowed = manifest?.permissions?.fs ?? [];
    if (!allowed.includes(area)) throw new Error(`Skill 未声明 ${area} 写权限`);
    const dir = existingDirectory(this.root, join(this.runDirectory(runId), area));
    return writeTextWithin(dir, relative, content);
  }

  resolveFile(runId: string, area: 'workspace' | 'input' | 'output', relative: string): string {
    this.getRun(runId);
    if (!['workspace', 'input', 'output'].includes(area)) throw new Error('非法文件区域');
    const dir = existingDirectory(this.root, join(this.runDirectory(runId), area));
    return safePath(dir, relative);
  }

  listFiles(runId: string): SkillRunFile[] {
    this.getRun(runId);
    const out: SkillRunFile[] = [];
    for (const area of ['workspace', 'input', 'output'] as const) {
      const root = existingDirectory(this.root, join(this.runDirectory(runId), area));
      const walk = (dir: string, prefix = '') => {
        let current: string;
        try {
          current = existingDirectory(root, dir);
        } catch {
          return;
        }
        let entries;
        try {
          entries = readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const full = join(current, entry.name);
          try {
            const real = assertInside(root, realpathSync(full));
            if (entry.isDirectory()) {
              out.push({ path: rel, area, type: 'directory' });
              walk(real, rel);
            } else if (entry.isFile()) {
              out.push({ path: rel, area, type: 'file', size: statSync(real).size });
            }
          } catch {
            // 文件在枚举期间被删除、移动或替换时跳过，绝不沿新链接继续遍历。
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
    const skillDir = realpathSync(this.skills.skillDir(existing.skill));
    const runDir = this.runDirectory(runId);
    const workspace = existingDirectory(runDir, join(runDir, 'workspace'));
    const input = existingDirectory(runDir, join(runDir, 'input'));
    const output = existingDirectory(runDir, join(runDir, 'output'));
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
    for (const [label, path] of [['workspace', workspace], ['input', input], ['output', output]] as const) {
      if (normalizeCase(realpathSync(path)) !== normalizeCase(path)) throw new Error(`Skill ${label} 在启动前发生变化，请重试`);
    }
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
        // POSIX 下自成进程组，killTree 的 kill(-pid) 才能连带杀掉脚本再 spawn 的孙进程
        detached: process.platform !== 'win32',
      });
      const onAbort = () => {
        canceled = true;
        killTree(child);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
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
            ensureDirectory(workspace, '.aidb');
            writeTextWithin(workspace, join('.aidb', 'project.json'), JSON.stringify({ path: created }, null, 2));
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
