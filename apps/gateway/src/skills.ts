import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import { execFile } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { SkillDetail, SkillEntrypoint, SkillFileEntry, SkillManifest, SkillReadResult, SkillSummary } from '@aidb/core';

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build']);
const TEXT_EXT = new Set(['', '.md', '.txt', '.json', '.yaml', '.yml', '.py', '.js', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.cmd', '.svg', '.html', '.css', '.csv', '.xml', '.toml', '.ini', '.env']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_CHARS = 120_000;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** Minimal npm tarball extractor: regular files/dirs only, rejects traversal and links. */
function extractTarGz(file: string, destination: string): void {
  const buffer = gunzipSync(readFileSync(file));
  let offset = 0;
  let total = 0;
  let longName = '';
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const full = prefix ? `${prefix}/${rawName}` : rawName;
    const name = longName || full;
    longName = '';
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (!name || type === 'x' || type === 'g') continue;
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`npm 包含非法路径：${name}`);
    if (type === '1' || type === '2') continue;
    const relative = name.replace(/^package\//, '');
    if (!relative) continue;
    const target = resolve(join(destination, relative));
    if (!target.startsWith(resolve(destination) + sep) && target !== resolve(destination)) throw new Error(`npm 路径越界：${name}`);
    if (type === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }
    total += size;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('npm 包解压后超过 200MB 限制');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

function npmInvocation(): { command: string; prefix: string[] } {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli] };
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, prefix: [process.env.npm_execpath] };
  }
  throw new Error('未找到 npm CLI；请安装 Node.js 或设置 npm_execpath');
}

function findSkillRoots(root: string, depth = 0): string[] {
  if (depth > 3) return [];
  if (existsSync(join(root, 'SKILL.md'))) return [root];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    found.push(...findSkillRoots(join(root, entry.name), depth + 1));
  }
  return found;
}

/** 已适配的上游 skill：不修改上游 SKILL.md，只提供 AiDB 运行入口。 */
const BUILTIN_MANIFESTS: Record<string, SkillManifest> = {
  'ppt-master': {
    runtime: { python: '>=3.10 <3.15', pythonPackages: ['pptx'] },
    bootstrap: ['guard', 'project-init'],
    guide: `AiDB quick-start for a simple deck (follow this before any workflow document):
1. The integrity guard and project-init already ran; do not run them again.
2. Do not read workflows/*.md for a simple deck. Read at most one extra reference only if a chart, table, or image is unavoidable. When the user names a templates/brands|styles|layouts|decks path, read only that template's spec/SVG files and apply it.
3. Write each page with skill_write (area=workspace) to <projectRel>/svg_output/P01_name.svg, P02_name.svg, ...
   Use a complete SVG root: <svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 1280 720">.
   Allowed elements: rect, text, tspan, line, circle, path, g. No foreignObject. Use raw Unicode, never HTML entities.
   Fonts: "Microsoft YaHei" for Chinese, Arial for Latin. Title 44-64px, body 20-28px. Add a full-canvas background rect.
4. Write all requested pages before running quality.
5. Run entrypoint quality with no args. If it reports blocking errors, fix the SVG files and rerun once.
6. Run entrypoint export with no args. The native .pptx path is printed in stdout.`,
    permissions: { fs: ['workspace', 'output'], process: ['python'], network: false },
    entrypoints: [
      {
        id: 'guard',
        command: ['${python}', '${skillDir}/scripts/attribution_guard.py'],
        allowArgs: false,
        timeoutMs: 30_000,
      },
      {
        id: 'project-init',
        command: ['${python}', '${skillDir}/scripts/project_manager.py', 'init', 'deck', '--quick-generate', '--dir', '${workspace}/projects'],
        allowArgs: false,
        timeoutMs: 60_000,
      },
      {
        id: 'quality',
        command: ['${python}', '${skillDir}/scripts/svg_quality_checker.py', '${project}', '--quick-generate', '--stage', 'final', '--json'],
        allowArgs: false,
        timeoutMs: 120_000,
      },
      {
        id: 'export',
        command: ['${python}', '${skillDir}/scripts/svg_to_pptx.py', '${project}', '--quick-generate'],
        allowArgs: false,
        timeoutMs: 180_000,
      },
    ],
  },
};

const BUILTIN_SKILLS: Record<string, { name: string; description: string; body: string }> = {
  'aidb-report': {
    name: 'AiDB 报告写作',
    description: '把查询结果组织成结论先行、数字可追溯的报告；适合 /report 与汇报材料。',
    body: `# AiDB 报告写作

## 原则

1. 结论先行：每节第一句写结论，再给数字和依据。
2. 数字只来自工具结果或 resultRef；不手写、不四舍五入、不跨口径相加。
3. 区分事实与推测：推测必须标注“推测”，并说明依据。
4. 异常优先：先写变化最大、风险最高的指标，再写背景。
5. 每节至少回答一个问题：发生了什么、为什么、下一步做什么。

## 参考结构

- 概览：3–5 个关键指标，带对比基线与时间范围。
- 趋势：按时间轴描述拐点，指出最大增幅/降幅。
- 结构：按分组给出占比与贡献度。
- 异常：列出异常值、影响面和可能原因。
- 建议：可执行、可验证，避免空泛表述。
`,
  },
  'aidb-sql-review': {
    name: 'SQL 审查',
    description: '执行前检查 SQL 的读写风险、索引、事务与回滚方案。',
    body: `# SQL 审查清单

- 读写分类：确认是 SELECT / DML / DDL；只读连接禁止写。
- 范围：UPDATE/DELETE 必须有 WHERE；先用 SELECT 确认影响行数。
- 性能：检查过滤列索引、避免 SELECT *、关注大表全扫描。
- 事务：多语句写入使用事务；确认隔离级别与锁等待风险。
- 备份：DDL/破坏性操作前备份；记录回滚 SQL。
- 校验：执行后复核行数、约束与关键指标。
`,
  },
  'aidb-data-dictionary': {
    name: '数据字典',
    description: '为表、列、枚举和关联关系生成可维护的数据字典说明。',
    body: `# 数据字典

## 每张表写清楚

- 业务含义、数据来源、更新频率、负责人。
- 主键、唯一键、外键与关联表。
- 列的物理类型、业务含义、枚举值、空值规则、示例。
- 敏感字段与脱敏要求。
- 常见查询口径与已知坑（时区、软删除、历史表）。
`,
  },
};

interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
  license?: string;
  metadata?: Record<string, unknown>;
}

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  let meta: Frontmatter = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Frontmatter;
  } catch {
    meta = {};
  }
  return { meta, body: match[2] };
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id) || id.includes('..')) throw new Error('非法 skill id');
  return id;
}

function isTextFile(path: string): boolean {
  return TEXT_EXT.has(extname(path).toLowerCase());
}

function countFiles(root: string, max = 20_000): number {
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (count >= max) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.backup-')) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) count++;
    }
  };
  walk(root);
  return count;
}

function listFiles(root: string): SkillFileEntry[] {
  const out: SkillFileEntry[] = [];
  const walk = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.backup-')) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        out.push({ path: rel, type: 'directory' });
        if (out.length < 5000) walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push({ path: prefix ? `${prefix}/${entry.name}` : entry.name, type: 'file', size: statSync(join(dir, entry.name)).size });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.path.localeCompare(b.path));
}

export class SkillStore {
  readonly root: string;
  readonly adaptersRoot: string;

  constructor(home: string) {
    this.root = join(home, 'skills');
    this.adaptersRoot = join(home, 'skill-adapters');
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.adaptersRoot, { recursive: true });
  }

  /** 首次启动写入内置技能；用标记保证用户卸载后不会被反复加回。 */
  seedBuiltins(): void {
    const marker = join(this.root, '.builtins-v1');
    if (existsSync(marker)) return;
    for (const [id, skill] of Object.entries(BUILTIN_SKILLS)) {
      const dir = join(this.root, id);
      if (existsSync(join(dir, 'SKILL.md'))) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---
name: ${skill.name}
description: ${skill.description}
metadata:
  version: "1.0.0"
  license: MIT
---

${skill.body}`,
      );
      writeFileSync(join(dir, '.builtin'), new Date().toISOString());
    }
    writeFileSync(marker, new Date().toISOString());
  }

  skillDir(id: string): string {
    return this.skillPath(id);
  }

  getManifest(id: string): SkillManifest | undefined {
    const adapterFile = join(this.adaptersRoot, safeId(id), 'aidb.skill.json');
    const file = existsSync(adapterFile) ? adapterFile : join(this.skillPath(id), 'aidb.skill.json');
    if (!existsSync(file)) return BUILTIN_MANIFESTS[id];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SkillManifest;
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  getEntrypoint(id: string, entrypoint: string): { manifest: SkillManifest; entry: SkillEntrypoint } {
    const manifest = this.getManifest(id);
    if (!manifest?.entrypoints?.length) throw new Error('Skill 未声明 aidb.skill.json entrypoints');
    const entry = manifest.entrypoints.find((item) => item.id === entrypoint);
    if (!entry) throw new Error(`Skill entrypoint 不存在：${entrypoint}`);
    return { manifest, entry };
  }

  private skillPath(id: string): string {
    const path = join(this.root, safeId(id));
    if (!path.startsWith(this.root + sep)) throw new Error('非法 skill 路径');
    return path;
  }

  private summary(id: string): SkillSummary | undefined {
    const dir = this.skillPath(id);
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) return undefined;
    const text = readFileSync(skillFile, 'utf8');
    const { meta } = parseFrontmatter(text);
    const metadata = meta.metadata ?? {};
    return {
      id,
      name: String(meta.name ?? id),
      description: String(meta.description ?? ''),
      version: meta.version ?? (typeof metadata.version === 'string' ? metadata.version : undefined),
      license: meta.license ?? (typeof metadata.license === 'string' ? metadata.license : undefined),
      enabled: !existsSync(join(dir, '.disabled')),
      builtin: existsSync(join(dir, '.builtin')),
      runnable: Boolean(this.getManifest(id)?.entrypoints?.length),
      fileCount: countFiles(dir),
      updatedAt: statSync(skillFile).mtime.toISOString(),
    };
  }

  listSkills(includeDisabled = true): SkillSummary[] {
    const out: SkillSummary[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      try {
        const summary = this.summary(entry.name);
        if (summary && (includeDisabled || summary.enabled)) out.push(summary);
      } catch {
        /* skip unreadable skill */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkill(id: string): SkillDetail | undefined {
    const summary = this.summary(id);
    if (!summary) return undefined;
    const dir = this.skillPath(id);
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const { body } = parseFrontmatter(text);
    return { ...summary, files: listFiles(dir), body: body.slice(0, MAX_READ_CHARS) };
  }

  readFile(id: string, relative = 'SKILL.md', maxChars = MAX_READ_CHARS, offset = 0): SkillReadResult {
    const dir = this.skillPath(id);
    const targetInput = relative.trim() || 'SKILL.md';
    if (targetInput.startsWith('/') || targetInput.includes('\u0000')) throw new Error('非法文件路径');
    const target = resolve(join(dir, targetInput));
    const real = existsSync(target) ? realpathSync(target) : target;
    if (!real.startsWith(realpathSync(dir) + sep) && real !== realpathSync(dir)) throw new Error('文件路径越界');
    if (!existsSync(real) || !lstatSync(real).isFile()) throw new Error('文件不存在');
    if (statSync(real).size > MAX_FILE_BYTES) throw new Error('文件超过 2MB，不能通过 skill_read 读取');
    if (!isTextFile(real)) throw new Error('只支持读取文本文件');
    const text = readFileSync(real, 'utf8');
    const limit = Math.max(1000, Math.min(maxChars, MAX_READ_CHARS));
    const start = Math.max(0, Math.min(Math.trunc(offset) || 0, text.length));
    const content = text.slice(start, start + limit);
    const truncated = start + content.length < text.length;
    return {
      skill: id,
      path: targetInput,
      content,
      truncated,
      offset: start,
      totalChars: text.length,
      nextOffset: truncated ? start + content.length : undefined,
    };
  }

  catalog(limit = 30): string {
    const skills = this.listSkills(false).slice(0, limit);
    if (!skills.length) return '';
    return skills
      .map((skill) => `- ${skill.id}: ${skill.name}${skill.version ? ` v${skill.version}` : ''} — ${skill.description.replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n');
  }

  setEnabled(id: string, enabled: boolean): SkillSummary {
    const dir = this.skillPath(id);
    if (!existsSync(dir)) throw new Error('Skill 不存在');
    const marker = join(dir, '.disabled');
    if (enabled && existsSync(marker)) rmSync(marker);
    if (!enabled) writeFileSync(marker, new Date().toISOString());
    return this.summary(id)!;
  }

  importDirectory(source: string, requestedId?: string): SkillSummary {
    const sourcePath = resolve(source);
    const skillFile = join(sourcePath, 'SKILL.md');
    if (!existsSync(skillFile)) throw new Error('目录缺少 SKILL.md');
    const meta = parseFrontmatter(readFileSync(skillFile, 'utf8')).meta;
    if (!meta.name || !meta.description) throw new Error('SKILL.md 必须包含 name 和 description');
    let totalBytes = 0;
    let totalFiles = 0;
    const measure = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.backup-')) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          measure(join(dir, entry.name));
        } else if (entry.isFile()) {
          totalFiles += 1;
          totalBytes += statSync(join(dir, entry.name)).size;
          if (totalFiles > 100_000) throw new Error('Skill 文件数量超过 100,000 限制');
          if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error('Skill 目录超过 200MB 限制');
        }
      }
    };
    measure(sourcePath);
    const id = safeId(requestedId || basename(sourcePath));
    const target = this.skillPath(id);
    if (existsSync(target)) {
      const backup = join(this.root, `.backup-${id}-${Date.now()}`);
      renameSync(target, backup);
    }
    mkdirSync(target, { recursive: true });
    const copy = (from: string, to: string) => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (entry.name.startsWith('.backup-')) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          mkdirSync(join(to, entry.name), { recursive: true });
          copy(join(from, entry.name), join(to, entry.name));
        } else if (entry.isFile()) {
          cpSync(join(from, entry.name), join(to, entry.name));
        }
      }
    };
    copy(sourcePath, target);
    return this.summary(id)!;
  }

  importZip(buffer: Buffer, requestedId?: string): SkillSummary {
    if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('压缩包超过 200MB 限制');
    const temp = join(this.root, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(temp, { recursive: true });
    try {
      const zip = new AdmZip(buffer);
      let total = 0;
      for (const entry of zip.getEntries()) {
        const name = entry.entryName.replace(/\\/g, '/');
        if (!name || entry.isDirectory) continue;
        if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`压缩包路径非法：${name}`);
        total += entry.header.size;
        if (total > MAX_ARCHIVE_BYTES) throw new Error('压缩包解压后超过 200MB 限制');
        const target = resolve(join(temp, name));
        if (!target.startsWith(resolve(temp) + sep)) throw new Error(`压缩包路径越界：${name}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.getData());
      }
      let root = temp;
      if (!existsSync(join(root, 'SKILL.md'))) {
        const dirs = readdirSync(temp, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        const withSkill = dirs.find((entry) => existsSync(join(temp, entry.name, 'SKILL.md')));
        if (withSkill) root = join(temp, withSkill.name);
      }
      if (!existsSync(join(root, 'SKILL.md'))) throw new Error('压缩包中找不到 SKILL.md');
      return this.importDirectory(root, requestedId || basename(root));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /** 从 Git 仓库导入；不执行仓库脚本，只复制当前检出内容。 */
  async importGit(url: string, requestedId?: string, options: { ref?: string; subdir?: string } = {}): Promise<SkillSummary> {
    if (!/^(https:\/\/|ssh:\/\/|git@)/.test(url)) throw new Error('只支持 https / ssh / git@ 仓库地址');
    if (options.ref && !/^[A-Za-z0-9._/-]+$/.test(options.ref)) throw new Error('非法分支或 tag');
    const repoName = basename(new URL(url.replace(/^git@([^:]+):/, 'https://$1/')).pathname).replace(/\.git$/, '') || 'skill';
    const temp = join(this.root, `.tmp-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(temp, { recursive: true });
    try {
      const args = ['clone', '--depth', '1'];
      if (options.ref) args.push('--branch', options.ref);
      args.push(url, temp);
      try {
        await execFileAsync('git', args, { timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      } catch (err: any) {
        if (err?.code === 'ENOENT') throw new Error('未安装 git，无法从仓库导入');
        const detail = String(err?.stderr || err?.message || err).replace(url, '<repo>').slice(0, 500);
        throw new Error(`git clone 失败：${detail}`);
      }
      let root = temp;
      if (options.subdir) {
        const target = resolve(join(temp, options.subdir));
        if (!target.startsWith(resolve(temp) + sep)) throw new Error('subdir 越界');
        root = target;
      } else if (!existsSync(join(temp, 'SKILL.md'))) {
        const roots = findSkillRoots(temp);
        if (roots.length === 1) root = roots[0];
        else if (roots.length > 1) throw new Error(`仓库中找到 ${roots.length} 个 SKILL.md，请用 subdir 指定`);
      }
      if (!existsSync(join(root, 'SKILL.md'))) throw new Error('仓库中找不到 SKILL.md');
      return this.importDirectory(root, requestedId || basename(root) || repoName);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /** 从 npm 包导入；只下载 tarball 并复制文件，不执行生命周期脚本。 */
  async importNpm(packageSpec: string, requestedId?: string, subdir?: string): Promise<SkillSummary> {
    const spec = packageSpec.trim();
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._^~-]+)?$/i.test(spec)) {
      throw new Error('非法 npm 包名');
    }
    const name = spec.replace(/@[^/]+$/, '').split('/').pop() || 'skill';
    const temp = join(this.root, `.tmp-npm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(temp, { recursive: true });
    try {
      try {
        const npm = npmInvocation();
        await execFileAsync(npm.command, [...npm.prefix, 'pack', spec, '--ignore-scripts', '--json', '--pack-destination', temp], {
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch (err: any) {
        throw new Error(`npm pack 失败：${String(err?.stderr || err?.message || err).slice(0, 500)}`);
      }
      const tarball = readdirSync(temp).find((entry) => entry.endsWith('.tgz'));
      if (!tarball) throw new Error('npm pack 未生成 tarball');
      extractTarGz(join(temp, tarball), temp);
      let root = temp;
      if (subdir) {
        const target = resolve(join(temp, subdir));
        if (!target.startsWith(resolve(temp) + sep)) throw new Error('subdir 越界');
        root = target;
      } else {
        const roots = findSkillRoots(temp);
        if (roots.length === 1) root = roots[0];
        else if (roots.length > 1) throw new Error(`npm 包中找到 ${roots.length} 个 SKILL.md，请用 subdir 指定`);
      }
      if (!existsSync(join(root, 'SKILL.md'))) throw new Error('npm 包中找不到 SKILL.md');
      return this.importDirectory(root, requestedId || name);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  deleteSkill(id: string): void {
    const dir = this.skillPath(id);
    if (!existsSync(dir)) throw new Error('Skill 不存在');
    const backup = join(this.root, `.backup-${id}-${Date.now()}`);
    renameSync(dir, backup);
  }
}
