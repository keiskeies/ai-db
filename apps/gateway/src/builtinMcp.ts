import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  BUILTIN_MCP_SERVERS,
  builtinMcpKindOf,
  builtinMcpServer,
  type BuiltinMcpKind,
  type McpServerInfo,
  type ToolResult,
} from '@aidb/core';
import type { McpTool } from './mcp';
import type { Store } from './store';
import { runSearch } from './search';

/** Set by the gateway so built-in web_search can use the current settings/keys. */
let searchStore: Store | undefined;

export function bindSearchStore(store: Store): void {
  searchStore = store;
}

function getSearchStore(): Store | undefined {
  return searchStore;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_WEB_BYTES = 1024 * 1024;
const MAX_ROOT_COUNT = 20;
const MAX_OUTPUT_CHARS = 120_000;

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
]);

class BuiltinMcpError extends Error {
  constructor(message: string, readonly code = 'MCP_BUILTIN_ERROR') {
    super(message);
    this.name = 'BuiltinMcpError';
  }
}

function failure(message: string, code = 'MCP_BUILTIN_ERROR'): never {
  throw new BuiltinMcpError(message, code);
}

function canonicalDirectory(value: string, label: string): string {
  if (!value.trim()) failure(`${label}不能为空`, 'MCP_INVALID_ARGS');
  if (!isAbsolute(value)) failure(`${label}必须是绝对路径：${value}`, 'MCP_INVALID_ARGS');
  let real: string;
  try {
    real = realpathSync(value);
  } catch {
    failure(`${label}不存在：${value}`, 'MCP_ROOT_MISSING');
  }
  if (!statSync(real).isDirectory()) failure(`${label}不是目录：${value}`, 'MCP_INVALID_ARGS');
  return real;
}

function normalizeHostPattern(value: string): string {
  const raw = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!raw) failure('域名不能为空', 'MCP_INVALID_ARGS');
  const [host, port, ...rest] = raw.split(':');
  if (rest.length) failure(`域名格式不正确：${value}`, 'MCP_INVALID_ARGS');
  if (port && !/^\d{1,5}$/.test(port)) failure(`端口格式不正确：${value}`, 'MCP_INVALID_ARGS');
  const bare = host.replace(/^\*\./, '');
  if (!bare || bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) {
    failure(`不允许把本机/内网域名加入允许列表：${value}`, 'MCP_INVALID_ARGS');
  }
  if (isIP(bare) !== 0 && isPrivateIp(bare)) failure(`不允许把内网地址加入允许列表：${value}`, 'MCP_INVALID_ARGS');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(bare) && isIP(bare) === 0) {
    failure(`域名格式不正确：${value}`, 'MCP_INVALID_ARGS');
  }
  return `${host}${port ? `:${port}` : ''}`;
}

export function validateBuiltinMcpArgs(kind: BuiltinMcpKind, input: unknown): string[] {
  if (!Array.isArray(input)) failure('参数必须是字符串数组', 'MCP_INVALID_ARGS');
  const values = input.map((item) => String(item).trim()).filter(Boolean);
  if (values.length > MAX_ROOT_COUNT) failure(`最多配置 ${MAX_ROOT_COUNT} 项`, 'MCP_INVALID_ARGS');
  const out = new Set<string>();
  for (const value of values) {
    if (value.length > 500) failure('单项配置过长', 'MCP_INVALID_ARGS');
    out.add(kind === 'web' ? normalizeHostPattern(value) : canonicalDirectory(value, kind === 'git' ? '仓库目录' : '允许目录'));
  }
  return [...out];
}

export class BuiltinMcpClient {
  constructor(private server: McpServerInfo) {}

  private kind(): BuiltinMcpKind {
    const kind = builtinMcpKindOf(this.server.command);
    if (!kind) failure(`不是内置 MCP Server：${this.server.command}`, 'MCP_NOT_BUILTIN');
    return kind;
  }

  async tools(): Promise<McpTool[]> {
    const definition = builtinMcpServer(this.kind());
    if (!definition) failure(`未知的内置 MCP：${this.server.command}`, 'MCP_NOT_BUILTIN');
    return definition.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      risk: tool.risk,
    }));
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = Date.now();
    try {
      const result = await runBuiltinMcpTool(this.kind(), this.server.args, tool, args);
      return { ok: true, summary: result.summary, data: result.data, meta: { durationMs: Date.now() - started } };
    } catch (err: any) {
      return {
        ok: false,
        summary: '内置 MCP 工具执行失败',
        error: { code: err?.code ?? 'MCP_BUILTIN_ERROR', message: err?.message ?? String(err) },
        meta: { durationMs: Date.now() - started },
      };
    }
  }

  close(): void {}
}

export function seedBuiltinMcpServers(store: Store): void {
  const existing = store.listMcpServers();
  for (const definition of BUILTIN_MCP_SERVERS) {
    if (existing.some((server) => server.id === definition.id)) continue;
    if (existing.some((server) => server.name === definition.name)) {
      console.warn(`[mcp] 内置 ${definition.kind} 未预置：名称 ${definition.name} 已被占用`);
      continue;
    }
    store.seedMcpServer({
      id: definition.id,
      name: definition.name,
      command: `builtin:${definition.kind}`,
      args: [],
      enabled: definition.defaultEnabled,
    });
  }
}

async function runBuiltinMcpTool(
  kind: BuiltinMcpKind,
  serverArgs: string[],
  tool: string,
  input: Record<string, unknown>,
): Promise<{ summary: string; data: unknown }> {
  if (kind === 'filesystem') return runFilesystemTool(serverArgs, tool, input);
  if (kind === 'git') return runGitTool(serverArgs, tool, input);
  return runWebTool(serverArgs, tool, input);
}

/* ------------------------------------------------------------------ filesystem */

function rootsOf(args: string[], requestedPath?: string): string[] {
  const roots = args.map((value) => canonicalDirectory(value, '允许目录'));
  if (!roots.length) {
    const target = requestedPath ? `，无法访问 ${requestedPath}` : '';
    failure(`未配置允许目录${target}：请在 设置 → MCP 与工具 → 文件系统 添加该目录（或它的上级目录）`, 'MCP_FS_NO_ROOTS');
  }
  return roots;
}

function normalizeCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(normalizeCase(root), normalizeCase(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function nearestExisting(value: string): string {
  let current = value;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) failure(`路径不存在：${value}`, 'MCP_PATH_MISSING');
    current = parent;
  }
}

function resolveGrantedPath(input: unknown, roots: string[], label = 'path'): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) failure(`缺少 ${label}`, 'MCP_INVALID_ARGS');
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(roots[0], raw);
  const existing = nearestExisting(abs);
  const realExisting = realpathSync(existing);
  const suffix = relative(existing, abs);
  const candidate = suffix ? join(realExisting, suffix) : realExisting;
  if (!roots.some((root) => isInside(root, candidate))) {
    failure(`路径不在允许目录内：${raw}`, 'MCP_PATH_DENIED');
  }
  return candidate;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function readText(value: string): string {
  const stat = statSync(value);
  if (!stat.isFile()) failure(`不是文件：${value}`, 'MCP_INVALID_ARGS');
  if (stat.size > MAX_READ_BYTES) failure(`文件超过 ${MAX_READ_BYTES / 1024 / 1024} MB：${value}`, 'MCP_FILE_TOO_LARGE');
  const buffer = readFileSync(value);
  if (isBinary(buffer)) failure(`二进制文件不支持读取：${value}`, 'MCP_BINARY_FILE');
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function globToRegExp(pattern: string, flags = 'i'): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, flags);
}

function walkFiles(
  root: string,
  options: { maxFiles?: number; maxDepth?: number; filter?: (name: string) => boolean } = {},
): { files: string[]; truncated: boolean } {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxDepth = options.maxDepth ?? 20;
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return { files, truncated: true };
      if (entry.isSymbolicLink()) continue;
      const full = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (current.depth < maxDepth) stack.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.filter && !options.filter(entry.name)) continue;
      files.push(full);
    }
  }
  return { files, truncated: false };
}

function argString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function argInt(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = Number(input[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function argBool(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof input[key] === 'boolean' ? (input[key] as boolean) : fallback;
}

function argStringAny(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function argIntAny(input: Record<string, unknown>, keys: string[], fallback: number, min: number, max: number): number {
  for (const key of keys) {
    const value = Number(input[key]);
    if (Number.isFinite(value)) return Math.min(max, Math.max(min, Math.trunc(value)));
  }
  return fallback;
}

function argBoolAny(input: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    if (typeof input[key] === 'boolean') return input[key] as boolean;
  }
  return fallback;
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  return match[1].split(',').flatMap((part) => expandBraces(pattern.replace(match[0], part)));
}

function globToPathRegExp(pattern: string): RegExp {
  const value = pattern.replace(/\\/g, '/');
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*') {
      if (value[index + 1] === '*') {
        if (value[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$+.|()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function globMatchers(pattern: string): RegExp[] {
  return expandBraces(pattern).map(globToPathRegExp);
}

type GrepOutputMode = 'content' | 'files' | 'count';

function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
        resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

let ripgrepProbe: Promise<boolean> | undefined;

function rgBinary(): string {
  return process.env.AIDB_RG_PATH?.trim() || 'rg';
}

function ripgrepAvailable(): Promise<boolean> {
  if (process.env.AIDB_DISABLE_RG === '1') return Promise.resolve(false);
  if (!ripgrepProbe) {
    ripgrepProbe = runCommand(rgBinary(), ['--version'], 5_000).then((result) => result.code === 0);
  }
  return ripgrepProbe;
}

async function runRipgrepGrep(
  root: string,
  pattern: string,
  options: { include: string; caseSensitive: boolean; maxMatches: number; context: number; outputMode: GrepOutputMode },
): Promise<{ summary: string; data: unknown } | undefined> {
  if (!(await ripgrepAvailable())) return undefined;
  const args = ['--json', '--no-messages', '--color', 'never', '--max-count', String(options.maxMatches)];
  if (!options.caseSensitive) args.push('-i');
  if (options.outputMode === 'content' && options.context > 0) args.push('-C', String(options.context));
  if (options.include) {
    args.push('--glob', /[*?]/.test(options.include) ? options.include : `*${options.include}*`);
  }
  args.push('--', pattern, root);
  const result = await runCommand(rgBinary(), args, 20_000);
  if (result.code === 1) {
    return options.outputMode === 'content'
      ? { summary: '匹配 0 处（rg）', data: { root, pattern, engine: 'rg', matches: [], truncated: false } }
      : { summary: '命中 0 个文件（rg）', data: { root, pattern, engine: 'rg', files: [], truncated: false } };
  }
  if (result.code !== 0) return undefined;

  const records = new Map<string, Array<{ line: number; text: string; match: boolean }>>();
  for (const raw of result.stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    if (message.type !== 'match' && message.type !== 'context') continue;
    const pathText = message.data?.path?.text;
    const lineNumber = Number(message.data?.line_number);
    if (typeof pathText !== 'string' || !Number.isFinite(lineNumber)) continue;
    const absolute = isAbsolute(pathText) ? pathText : resolve(root, pathText);
    let real = absolute;
    try {
      real = realpathSync(absolute);
    } catch {
      /* keep absolute */
    }
    if (!isInside(root, real)) continue;
    const text = String(message.data?.lines?.text ?? '').replace(/\r?\n$/, '');
    const list = records.get(real) ?? [];
    list.push({ line: lineNumber, text, match: message.type === 'match' });
    records.set(real, list);
  }

  const matches: Array<{ path: string; relative: string; line: number; text: string; before?: string[]; after?: string[] }> = [];
  const files: Array<{ path: string; relative: string; matches: number }> = [];
  let totalMatches = 0;
  let truncated = false;
  for (const [file, list] of records) {
    list.sort((a, b) => a.line - b.line);
    const lineMatches = list.filter((item) => item.match);
    if (!lineMatches.length) continue;
    totalMatches += lineMatches.length;
    if (options.outputMode === 'content') {
      for (const item of lineMatches) {
        const before = options.context
          ? list.filter((row) => row.line < item.line && row.line >= item.line - options.context).map((row) => row.text.slice(0, 400))
          : undefined;
        const after = options.context
          ? list.filter((row) => row.line > item.line && row.line <= item.line + options.context).map((row) => row.text.slice(0, 400))
          : undefined;
        matches.push({
          path: file,
          relative: relative(root, file).split(sep).join('/'),
          line: item.line,
          text: item.text.slice(0, 400),
          ...(before?.length ? { before } : {}),
          ...(after?.length ? { after } : {}),
        });
        if (matches.length >= options.maxMatches) {
          truncated = true;
          break;
        }
      }
    } else {
      files.push({ path: file, relative: relative(root, file).split(sep).join('/'), matches: lineMatches.length });
      if (files.length >= options.maxMatches) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  if (options.outputMode === 'content') {
    return {
      summary: `匹配 ${matches.length} 处（rg）${truncated ? '（已截断）' : ''}`,
      data: { root, pattern, engine: 'rg', matches, truncated },
    };
  }
  return {
    summary: `命中 ${files.length} 个文件 · ${totalMatches} 处（rg）${truncated ? '（已截断）' : ''}`,
    data: { root, pattern, engine: 'rg', files, truncated },
  };
}

async function runFilesystemTool(
  serverArgs: string[],
  tool: string,
  input: Record<string, unknown>,
): Promise<{ summary: string; data: unknown }> {
  const roots = rootsOf(serverArgs, argStringAny(input, ['path', 'file_path']));
  const target = (keys: string[] = ['path', 'file_path']) => {
    const raw = argStringAny(input, keys);
    if (!raw) return roots[0];
    return resolveGrantedPath(raw, roots, keys[0]);
  };

  if (tool === 'list_directory') {
    const dir = target();
    const stat = statSync(dir);
    if (!stat.isDirectory()) failure(`不是目录：${dir}`, 'MCP_INVALID_ARGS');
    const depth = argBool(input, 'recursive', false) ? 8 : argInt(input, 'depth', 1, 1, 8);
    const maxEntries = argInt(input, 'maxEntries', 400, 1, 3000);
    const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number; mtime?: string }> = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 1 }];
    let truncated = false;
    while (queue.length) {
      const current = queue.shift()!;
      let children;
      try {
        children = readdirSync(current.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }
      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        if (IGNORED_DIRS.has(child.name)) continue;
        if (child.isSymbolicLink()) continue;
        const full = join(current.dir, child.name);
        if (child.isDirectory()) {
          entries.push({ path: full, type: 'dir' });
          if (current.depth < depth) queue.push({ dir: full, depth: current.depth + 1 });
        } else if (child.isFile()) {
          const info = statSync(full);
          entries.push({ path: full, type: 'file', size: info.size, mtime: info.mtime.toISOString() });
        }
      }
      if (truncated) break;
    }
    entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
    return { summary: `列出 ${dir} · ${entries.length} 项${truncated ? '（已截断）' : ''}`, data: { root: roots.find((root) => isInside(root, dir)) ?? roots[0], path: dir, entries, truncated } };
  }

  if (tool === 'read_file') {
    const file = target();
    const text = readText(file);
    const lines = text.split(/\r?\n/);
    const offset = argInt(input, 'offset', 0, 0, Math.max(0, lines.length - 1));
    const limit = argInt(input, 'limit', 400, 1, 2000);
    const end = Math.min(lines.length, offset + limit);
    const content = lines.slice(offset, end).join('\n');
    return {
      summary: `读取 ${file} · 第 ${offset + 1}-${end} 行 / 共 ${lines.length} 行${end < lines.length ? '（还有后续）' : ''}`,
      data: { path: file, content, startLine: offset + 1, endLine: end, totalLines: lines.length, truncated: end < lines.length },
    };
  }

  if (tool === 'read_multiple_files') {
    const rawPaths = Array.isArray(input.paths)
      ? input.paths.map((value) => String(value).trim()).filter(Boolean)
      : Array.isArray(input.files)
        ? input.files.map((value) => String(value).trim()).filter(Boolean)
        : [];
    if (!rawPaths.length) failure('缺少 paths 或 files', 'MCP_INVALID_ARGS');
    if (rawPaths.length > 20) failure('一次最多读取 20 个文件', 'MCP_INVALID_ARGS');
    const offset = argIntAny(input, ['offset'], 0, 0, 1_000_000);
    const limit = argIntAny(input, ['limit'], 400, 1, 2000);
    const maxTotalChars = argIntAny(input, ['maxTotalChars'], 120_000, 1000, 400_000);
    const files: Array<Record<string, unknown>> = [];
    let totalChars = 0;
    let truncatedTotal = false;
    for (const raw of rawPaths) {
      try {
        const file = resolveGrantedPath(raw, roots);
        const text = readText(file);
        const lines = text.split(/\r?\n/);
        const start = Math.min(offset, Math.max(0, lines.length - 1));
        const end = Math.min(lines.length, start + limit);
        let content = lines.slice(start, end).join('\n');
        if (totalChars + content.length > maxTotalChars) {
          content = content.slice(0, Math.max(0, maxTotalChars - totalChars));
          truncatedTotal = true;
        }
        totalChars += content.length;
        files.push({
          path: file,
          content,
          startLine: start + 1,
          endLine: end,
          totalLines: lines.length,
          truncated: end < lines.length || truncatedTotal,
        });
      } catch (err: any) {
        files.push({ path: raw, error: { code: err?.code ?? 'MCP_READ_FAILED', message: err?.message ?? String(err) } });
      }
      if (truncatedTotal) break;
    }
    return {
      summary: `批量读取 ${files.length} 个文件 · ${totalChars} 字符${truncatedTotal ? '（已截断）' : ''}`,
      data: { files, totalChars, truncated: truncatedTotal },
    };
  }

  if (tool === 'search_files') {
    const query = argStringAny(input, ['query', 'pattern']);
    if (!query) failure('缺少 query 或 pattern（Glob 模式可传 **/*.java）', 'MCP_INVALID_ARGS');
    const base = target();
    const baseStat = statSync(base);
    const root = baseStat.isDirectory() ? base : dirname(base);
    const wildcard = /[*?]/.test(query);
    const lowered = query.toLowerCase();
    const matchers = wildcard ? globMatchers(query) : [];
    const { files, truncated } = walkFiles(root, { maxFiles: 20_000 });
    const matched = files.filter((file) => {
      const rel = relative(root, file).split(sep).join('/');
      if (wildcard) return matchers.some((matcher) => matcher.test(rel) || matcher.test(basename(file)));
      return rel.toLowerCase().includes(lowered) || basename(file).toLowerCase().includes(lowered);
    });
    const maxResults = argIntAny(input, ['maxResults', 'head_limit'], 200, 1, 500);
    const sliced = matched.slice(0, maxResults);
    return {
      summary: `搜索 ${query} · ${sliced.length} 个文件${truncated || matched.length > sliced.length ? '（已截断）' : ''}`,
      data: {
        root,
        files: sliced.map((file) => ({ path: file, relative: relative(root, file).split(sep).join('/'), size: statSync(file).size })),
        truncated: truncated || matched.length > sliced.length,
      },
    };
  }

  if (tool === 'grep_files') {
    const pattern = argString(input, 'pattern');
    if (!pattern) failure('缺少 pattern', 'MCP_INVALID_ARGS');
    if (pattern.length > 200) failure('正则过长（最多 200 字符）', 'MCP_INVALID_ARGS');
    const caseSensitive =
      typeof input.caseSensitive === 'boolean'
        ? input.caseSensitive
        : typeof input.ignore_case === 'boolean'
          ? !input.ignore_case
          : typeof input['-i'] === 'boolean'
            ? !input['-i']
            : false;
    let re: RegExp;
    try {
      re = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (err: any) {
      failure(`正则无效：${err?.message ?? pattern}`, 'MCP_INVALID_REGEX');
    }
    const base = target();
    const root = statSync(base).isDirectory() ? base : dirname(base);
    const include = argStringAny(input, ['include', 'glob']) || (typeof input.type === 'string' && input.type.trim() ? `*.${input.type.trim().replace(/^\./, '')}` : '');
    const maxMatches = argIntAny(input, ['maxMatches', 'head_limit'], 100, 1, 500);
    const context = Math.max(
      argIntAny(input, ['context', '-C'], 0, 0, 5),
      argIntAny(input, ['-A', 'afterContext'], 0, 0, 5),
      argIntAny(input, ['-B', 'beforeContext'], 0, 0, 5),
    );
    const requestedMode = input.outputMode ?? input.output_mode;
    const outputMode: GrepOutputMode =
      requestedMode === 'files' || requestedMode === 'files_with_matches'
        ? 'files'
        : requestedMode === 'count'
          ? 'count'
          : 'content';
    const viaRipgrep = await runRipgrepGrep(root, pattern, { include, caseSensitive, maxMatches, context, outputMode });
    if (viaRipgrep) return viaRipgrep;

    const includeMatcher = include ? (/[*?]/.test(include) ? globToRegExp(include) : undefined) : undefined;
    const includeLower = include.toLowerCase();
    const { files, truncated } = walkFiles(root, {
      maxFiles: 5_000,
      maxDepth: 12,
      filter: include ? (name) => (includeMatcher ? includeMatcher.test(name) : name.toLowerCase().includes(includeLower)) : undefined,
    });
    const matches: Array<{ path: string; relative: string; line: number; text: string; before?: string[]; after?: string[] }> = [];
    const counts = new Map<string, number>();
    let scanned = 0;
    let totalMatches = 0;
    let truncatedByCap = false;
    for (const file of files) {
      let info;
      try {
        info = statSync(file);
      } catch {
        continue;
      }
      if (info.size > MAX_READ_BYTES) continue;
      let buffer: Buffer;
      try {
        buffer = readFileSync(file);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;
      scanned += 1;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      let fileMatches = 0;
      for (let index = 0; index < lines.length; index += 1) {
        if (!re.test(lines[index])) continue;
        fileMatches += 1;
        totalMatches += 1;
        if (outputMode === 'content') {
          const before = context ? lines.slice(Math.max(0, index - context), index).map((line) => line.slice(0, 400)) : undefined;
          const after = context ? lines.slice(index + 1, Math.min(lines.length, index + 1 + context)).map((line) => line.slice(0, 400)) : undefined;
          matches.push({
            path: file,
            relative: relative(root, file).split(sep).join('/'),
            line: index + 1,
            text: lines[index].slice(0, 400),
            ...(before?.length ? { before } : {}),
            ...(after?.length ? { after } : {}),
          });
        }
        if (totalMatches >= maxMatches) {
          truncatedByCap = true;
          break;
        }
      }
      if (fileMatches) counts.set(file, fileMatches);
      if (truncatedByCap) break;
    }
    if (outputMode === 'content') {
      return {
        summary: `匹配 ${matches.length} 处 / 扫描 ${scanned} 个文件${truncatedByCap || truncated ? '（已截断）' : ''}`,
        data: { root, pattern, engine: 'js', matches, filesScanned: scanned, truncated: truncatedByCap || truncated },
      };
    }
    const fileRows = [...counts.entries()].slice(0, maxMatches).map(([file, count]) => ({
      path: file,
      relative: relative(root, file).split(sep).join('/'),
      matches: count,
    }));
    return {
      summary: `命中 ${fileRows.length} 个文件 · ${totalMatches} 处 / 扫描 ${scanned} 个文件${truncatedByCap || truncated ? '（已截断）' : ''}`,
      data: { root, pattern, engine: 'js', files: fileRows, filesScanned: scanned, truncated: truncatedByCap || truncated },
    };
  }

  if (tool === 'file_info') {
    const file = target();
    const info = statSync(file);
    return {
      summary: `文件信息 ${file}`,
      data: {
        path: file,
        type: info.isDirectory() ? 'dir' : 'file',
        size: info.size,
        mtime: info.mtime.toISOString(),
        insideRoot: roots.find((root) => isInside(root, file)) ?? null,
      },
    };
  }

  if (tool === 'write_file') {
    const file = target();
    const content = argString(input, 'content');
    if (typeof input.content !== 'string') failure('content 必须是字符串', 'MCP_INVALID_ARGS');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) failure(`内容超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB`, 'MCP_FILE_TOO_LARGE');
    const exists = existsSync(file);
    if (exists && statSync(file).isDirectory()) failure(`目标是目录：${file}`, 'MCP_INVALID_ARGS');
    if (exists && !argBool(input, 'overwrite', false)) {
      failure(`文件已存在；需要覆盖请传 overwrite=true：${file}`, 'MCP_FILE_EXISTS');
    }
    if (argBool(input, 'createDirs', true)) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    return { summary: `${exists ? '覆盖' : '写入'} ${file} · ${bytes} B`, data: { path: file, bytes, created: !exists } };
  }

  if (tool === 'edit_file') {
    const file = target();
    const oldText = argStringAny(input, ['oldText', 'old_string']);
    if (!oldText) failure('oldText / old_string 不能为空', 'MCP_INVALID_ARGS');
    const newTextValue = typeof input.newText === 'string' ? input.newText : typeof input.new_string === 'string' ? input.new_string : undefined;
    if (newTextValue === undefined) failure('newText / new_string 必须是字符串', 'MCP_INVALID_ARGS');
    const source = readText(file);
    const count = source.split(oldText).length - 1;
    if (!count) failure(`未找到要替换的文本：${file}`, 'MCP_EDIT_NOT_FOUND');
    const replaceAll = argBoolAny(input, ['replaceAll', 'replace_all'], false);
    if (count > 1 && !replaceAll) failure(`oldText 出现 ${count} 次；需要全部替换请传 replaceAll=true`, 'MCP_EDIT_AMBIGUOUS');
    const next = replaceAll ? source.split(oldText).join(newTextValue) : source.replace(oldText, newTextValue);
    const bytes = Buffer.byteLength(next, 'utf8');
    if (bytes > MAX_WRITE_BYTES) failure(`内容超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB`, 'MCP_FILE_TOO_LARGE');
    writeFileSync(file, next, 'utf8');
    return { summary: `编辑 ${file} · ${replaceAll ? count : 1} 处`, data: { path: file, replacements: replaceAll ? count : 1, bytes } };
  }

  if (tool === 'move_file') {
    const source = resolveGrantedPath(argStringAny(input, ['source', 'source_path']), roots, 'source');
    const destination = resolveGrantedPath(argStringAny(input, ['destination', 'destination_path']), roots, 'destination');
    if (!existsSync(source)) failure(`源路径不存在：${source}`, 'MCP_PATH_MISSING');
    const sourceStat = statSync(source);
    if (source === destination) failure('源路径和目标路径相同', 'MCP_INVALID_ARGS');
    if (sourceStat.isDirectory() && isInside(source, destination)) failure('不能把目录移动到自身内部', 'MCP_INVALID_ARGS');
    if (existsSync(destination)) {
      if (statSync(destination).isDirectory() || sourceStat.isDirectory()) failure('不支持覆盖目录', 'MCP_FILE_EXISTS');
      if (!argBool(input, 'overwrite', false)) failure(`目标已存在；需要覆盖请传 overwrite=true：${destination}`, 'MCP_FILE_EXISTS');
      unlinkSync(destination);
    }
    mkdirSync(dirname(destination), { recursive: true });
    try {
      renameSync(source, destination);
    } catch (err: any) {
      if (err?.code === 'EXDEV') failure('跨盘移动不支持，请先复制再删除', 'MCP_MOVE_CROSS_DEVICE');
      throw err;
    }
    return { summary: `移动 ${source} → ${destination}`, data: { source, destination } };
  }

  if (tool === 'delete_file') {
    const file = resolveGrantedPath(argStringAny(input, ['path', 'file_path']), roots);
    if (!existsSync(file)) failure(`文件不存在：${file}`, 'MCP_PATH_MISSING');
    const info = statSync(file);
    if (!info.isFile()) failure('只允许删除文件，不能删除目录', 'MCP_INVALID_ARGS');
    const confirm = argString(input, 'confirm').trim();
    if (confirm !== basename(file) && confirm !== file) {
      failure(`需要 confirm 等于文件名 ${basename(file)} 或完整路径`, 'MCP_INVALID_ARGS');
    }
    unlinkSync(file);
    return { summary: `删除 ${file} · ${info.size} B`, data: { path: file, bytes: info.size } };
  }

  failure(`未知的 filesystem 工具：${tool}`, 'MCP_UNKNOWN_TOOL');
}

/* ------------------------------------------------------------------ git */

function runProcess(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      {
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stderr: String(stderr ?? '') }));
          return;
        }
        resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function gitRepos(serverArgs: string[]): string[] {
  const repos = serverArgs.map((value) => canonicalDirectory(value, '仓库目录'));
  if (!repos.length) failure('未配置 Git 仓库目录：请在 设置 → MCP 与工具 为 git 添加仓库', 'MCP_GIT_NO_REPOS');
  return repos;
}

function pickRepo(serverArgs: string[], value: unknown): string {
  const repos = gitRepos(serverArgs);
  if (typeof value === 'string' && value.trim()) {
    const wanted = normalizeCase(resolve(value.trim()));
    const found = repos.find((repo) => normalizeCase(repo) === wanted);
    if (!found) failure(`仓库不在允许列表内：${value}`, 'MCP_GIT_REPO_DENIED');
    return found;
  }
  if (repos.length === 1) return repos[0];
  failure(`配置了多个仓库，请传 repo（${repos.join(' | ')}）`, 'MCP_INVALID_ARGS');
}

function gitPath(repo: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (value.startsWith('-')) failure(`路径不能以 - 开头：${value}`, 'MCP_INVALID_ARGS');
  const abs = resolveGrantedPath(value, [repo], 'path');
  return relative(repo, abs).split(sep).join('/');
}

function gitOutput(stdout: string): { output: string; truncated: boolean } {
  const output = stdout.trim();
  return { output: output.slice(0, MAX_OUTPUT_CHARS), truncated: output.length > MAX_OUTPUT_CHARS };
}

async function runGit(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runProcess('git', ['-c', 'core.quotepath=false', '-C', repo, ...args]);
    return stdout;
  } catch (err: any) {
    if (err?.code === 'ENOENT') failure('未找到 git 命令，请先安装 Git 并加入 PATH', 'MCP_GIT_MISSING');
    const message = String(err?.stderr || err?.message || 'git 执行失败').trim();
    failure(message.slice(0, 800) || 'git 执行失败', 'MCP_GIT_FAILED');
  }
}

async function runGitTool(
  serverArgs: string[],
  tool: string,
  input: Record<string, unknown>,
): Promise<{ summary: string; data: unknown }> {
  const repo = pickRepo(serverArgs, input.repo);

  if (tool === 'git_status') {
    const { output, truncated } = gitOutput(await runGit(repo, ['status', '--short', '--branch']));
    return { summary: `git status · ${output ? output.split('\n').length : 0} 行${truncated ? '（已截断）' : ''}`, data: { repo, output, truncated } };
  }

  if (tool === 'git_log') {
    const count = argInt(input, 'maxCount', 20, 1, 100);
    const path = gitPath(repo, input.path);
    const args = ['log', '--oneline', '--decorate', '--no-color', '-n', String(count), ...(path ? ['--', path] : [])];
    const { output, truncated } = gitOutput(await runGit(repo, args));
    return { summary: `git log · ${count} 条${truncated ? '（已截断）' : ''}`, data: { repo, output, truncated } };
  }

  if (tool === 'git_diff') {
    const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
    if (ref && (!/^[A-Za-z0-9_./~^@{}-]+$/.test(ref) || ref.startsWith('-'))) failure(`ref 不合法：${ref}`, 'MCP_INVALID_ARGS');
    const path = gitPath(repo, input.path);
    const args = ['diff', '--no-color'];
    if (argBool(input, 'staged', false)) args.push('--cached');
    if (ref) args.push(ref);
    if (path) args.push('--', path);
    const { output, truncated } = gitOutput(await runGit(repo, args));
    return { summary: `git diff · ${output ? output.split('\n').length : 0} 行${truncated ? '（已截断）' : ''}`, data: { repo, output, truncated } };
  }

  if (tool === 'git_show') {
    const ref = argString(input, 'ref').trim();
    if (!ref) failure('缺少 ref', 'MCP_INVALID_ARGS');
    if (!/^[A-Za-z0-9_./~^@{}-]+$/.test(ref) || ref.startsWith('-')) failure(`ref 不合法：${ref}`, 'MCP_INVALID_ARGS');
    const patch = argBool(input, 'patch', false);
    const { output, truncated } = gitOutput(await runGit(repo, ['show', '--no-color', '--format=fuller', patch ? '--patch' : '--stat', ref]));
    return { summary: `git show ${ref}${truncated ? '（已截断）' : ''}`, data: { repo, ref, output, truncated } };
  }

  failure(`未知的 git 工具：${tool}`, 'MCP_UNKNOWN_TOOL');
}

/* ------------------------------------------------------------------ web */

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function ipv4FromMappedIpv6(value: string): string | undefined {
  const rest = value.slice('::ffff:'.length);
  if (isIP(rest) === 4) return rest;
  const groups = rest.split(':');
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) return undefined;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(value) === 4) return isPrivateIpv4(value);
  if (isIP(value) === 6) {
    if (value.startsWith('::ffff:')) {
      const mapped = ipv4FromMappedIpv6(value);
      return mapped ? isPrivateIpv4(mapped) : true;
    }
    if (value === '::' || value === '::1') return true;
    if (/^f[cd]/.test(value)) return true;
    if (/^fe[89ab]/.test(value)) return true;
    if (/^ff/.test(value)) return true;
    return false;
  }
  return true;
}

function blockedHostName(host: string): boolean {
  const value = host.toLowerCase();
  return (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value.endsWith('.local') ||
    value.endsWith('.internal') ||
    value === 'metadata.google.internal' ||
    value === 'instance-data'
  );
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') failure(`只支持 http/https：${url.protocol}`, 'MCP_URL_DENIED');
  if (url.username || url.password) failure('URL 不能携带用户名或密码', 'MCP_URL_DENIED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (blockedHostName(host)) failure(`禁止访问本机/内网地址：${host}`, 'MCP_URL_DENIED');
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) failure(`禁止访问内网地址：${host}`, 'MCP_URL_DENIED');
    return;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    failure(`域名解析失败：${host}`, 'MCP_DNS_FAILED');
  }
  for (const address of addresses) {
    if (isPrivateIp(address.address)) failure(`域名解析到内网地址，已拒绝：${host} → ${address.address}`, 'MCP_URL_DENIED');
  }
}

function hostAllowed(url: URL, patterns: string[]): boolean {
  if (!patterns.length) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return patterns.some((pattern) => {
    const [patternHost, patternPort] = pattern.split(':');
    if (patternPort && patternPort !== port) return false;
    const bare = patternHost.replace(/^\*\./, '');
    return patternHost.startsWith('*.') ? host === bare || host.endsWith(`.${bare}`) : host === bare;
  });
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n'),
  ).trim();
}

async function readCappedBody(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (size + value.byteLength > cap) {
      chunks.push(Buffer.from(value.subarray(0, cap - size)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function runWebTool(
  serverArgs: string[],
  tool: string,
  input: Record<string, unknown>,
): Promise<{ summary: string; data: unknown }> {
  if (tool === 'web_search') {
    const query = argString(input, 'query').trim();
    if (!query) failure('缺少 query', 'MCP_INVALID_ARGS');
    const settingsStore = getSearchStore();
    if (!settingsStore) failure('搜索运行时未初始化', 'SEARCH_RUNTIME_MISSING');
    const settings = settingsStore.getSettings().search;
    const numResults = argInt(input, 'numResults', settings.numResults, 1, 20);
    const response = await runSearch(query, settingsStore, { numResults });
    const failedList = response.backends.filter((item) => !item.ok);
    const failed = failedList.map((item) => `${item.id}: ${item.error}`).join('; ');
    if (!response.results.length && failedList.length === response.backends.length && failedList.length > 0) {
      failure(`所有搜索后端失败：${failed}`, 'SEARCH_ALL_FAILED');
    }
    const lines = response.results.slice(0, numResults).map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`).join('\n\n');
    return {
      summary: `搜索 ${query} · ${response.results.length} 条${failed ? ' · 部分后端失败' : ''}`,
      data: { ...response, results: response.results.slice(0, numResults), rendered: lines || '（无结果）', failed },
    };
  }
  if (tool !== 'fetch_url') failure(`未知的 web 工具：${tool}`, 'MCP_UNKNOWN_TOOL');
  const raw = argString(input, 'url').trim();
  if (!raw) failure('缺少 url', 'MCP_INVALID_ARGS');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    failure(`URL 格式不正确：${raw}`, 'MCP_INVALID_ARGS');
  }
  const patterns = serverArgs.map((value) => normalizeHostPattern(value));
  if (!hostAllowed(url, patterns)) failure(`域名不在允许列表内：${url.hostname}`, 'MCP_URL_DENIED');
  const maxChars = argInt(input, 'maxChars', 20_000, 500, 200_000);
  let current = url;
  for (let hop = 0; hop <= 5; hop += 1) {
    await assertPublicUrl(current);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': 'AiDB-Studio/0.1 (+local)', accept: 'text/html,application/json,text/plain,*/*' },
      });
    } catch (err: any) {
      failure(`请求失败：${err?.message ?? current}`, 'MCP_FETCH_FAILED');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) failure(`重定向缺少 Location：HTTP ${response.status}`, 'MCP_FETCH_FAILED');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) failure(`HTTP ${response.status} ${response.statusText}`.trim(), 'MCP_FETCH_STATUS');
    const contentType = response.headers.get('content-type') ?? '';
    const body = await readCappedBody(response, MAX_WEB_BYTES);
    const isHtml = /html|xml/i.test(contentType);
    const isText = isHtml || /text\/|json|javascript|yaml|csv/i.test(contentType) || !contentType;
    if (!isText) failure(`不支持的内容类型：${contentType || '未知'}`, 'MCP_FETCH_TYPE');
    const text = isHtml ? htmlToText(body.text) : body.text;
    const clipped = text.slice(0, maxChars);
    return {
      summary: `抓取 ${current.host} · HTTP ${response.status} · ${clipped.length} 字符${body.truncated || text.length > maxChars ? '（已截断）' : ''}`,
      data: {
        url: current.toString(),
        status: response.status,
        contentType,
        text: clipped,
        truncated: body.truncated || text.length > maxChars,
      },
    };
  }
  failure('重定向次数过多', 'MCP_FETCH_REDIRECT');
}
