import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PipelineError } from './types';

/**
 * 脚本步骤：JS / Python 子进程，数据从 stdin 进、stdout 出。
 *
 * 刻意不做进程内沙箱。node:vm 官方文档明确「不是安全机制」，vm2/n8n 的 Code
 * 节点都有过实际逃逸；这里的边界是操作系统进程：用户代码只能看到 stdin 里的
 * 一批行数据，没有数据库句柄、没有网络客户端、没有文件 API。环境变量按白名单
 * 传递，Gateway 的 token 与密钥不会出现在子进程里。
 *
 * 契约固定为一个函数：`transform(rows, ctx)`，返回行数组或 `{rows, state}`。
 */

export type ScriptRuntime = 'node' | 'python';

export interface ScriptPayload {
  rows: Record<string, unknown>[];
  columns: string[];
  params: Record<string, unknown>;
  state: Record<string, unknown>;
  run: Record<string, unknown>;
}

export interface ScriptInput {
  runtime: ScriptRuntime;
  code: string;
  payload: ScriptPayload;
  dir: string;
  timeoutMs: number;
  maxRows: number;
}

export interface ScriptOutput {
  rows: Record<string, unknown>[];
  state?: Record<string, unknown>;
  truncated: boolean;
  stderr: string;
  durationMs: number;
}

const STDOUT_LIMIT = 64 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

const NODE_BOOTSTRAP = (code: string) => `import process from 'node:process';
const _aidb_chunks = [];
for await (const _aidb_chunk of process.stdin) _aidb_chunks.push(_aidb_chunk);
const _aidb_payload = JSON.parse(Buffer.concat(_aidb_chunks).toString('utf8') || '{}');
${code}
if (typeof transform !== 'function') throw new Error('脚本必须定义 transform(rows, ctx)');
const _aidb_result = await transform(_aidb_payload.rows, _aidb_payload);
const _aidb_rows = Array.isArray(_aidb_result)
  ? _aidb_result
  : (_aidb_result && typeof _aidb_result === 'object' && Array.isArray(_aidb_result.rows) ? _aidb_result.rows : []);
process.stdout.write(JSON.stringify({ rows: _aidb_rows, state: (_aidb_result && _aidb_result.state) ?? null }));
`;

const PYTHON_BOOTSTRAP = (code: string) => `import json, sys

_aidb_raw = sys.stdin.read()
_aidb_payload = json.loads(_aidb_raw) if _aidb_raw.strip() else {'rows': []}

${code}

if 'transform' not in dir():
    sys.stderr.write('脚本必须定义 transform(rows, ctx)')
    sys.exit(2)

_aidb_result = transform(_aidb_payload.get('rows', []), _aidb_payload)
if isinstance(_aidb_result, dict):
    _aidb_rows = _aidb_result.get('rows', [])
    _aidb_state = _aidb_result.get('state')
else:
    _aidb_rows = _aidb_result
    _aidb_state = None
if not isinstance(_aidb_rows, list):
    _aidb_rows = []
json.dump({'rows': _aidb_rows, 'state': _aidb_state}, sys.stdout, ensure_ascii=False, default=str)
`;

function pythonCommand(): string {
  return process.env.AIDB_PYTHON || (process.env.OS ? 'python' : 'python3');
}

/** 只传运行所必需的变量：子进程里不该看到网关 token、数据库口令或搜索密钥。 */
function childEnv(runtime: ScriptRuntime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  }
  if (runtime === 'python') {
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
  }
  return env;
}

export async function runScript(input: ScriptInput): Promise<ScriptOutput> {
  const isWindows = process.platform === 'win32';
  const file = path.join(input.dir, input.runtime === 'node' ? 'transform.mjs' : 'transform.py');
  await mkdir(input.dir, { recursive: true });
  await writeFile(file, input.runtime === 'node' ? NODE_BOOTSTRAP(input.code) : PYTHON_BOOTSTRAP(input.code), 'utf8');

  const command = input.runtime === 'node' ? process.execPath : pythonCommand();
  const args = [file];
  const started = Date.now();

  const { stdout, stderr, code, timedOut } = await new Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: input.dir, env: childEnv(input.runtime), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err: any) {
      reject(new PipelineError(`无法启动 ${input.runtime}：${err?.message ?? err}`, 'PIPELINE_SCRIPT_SPAWN'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify(input.payload));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > STDOUT_LIMIT) {
        child.kill('SIGKILL');
        stderr += `\nstdout 超过 ${Math.round(STDOUT_LIMIT / 1024 / 1024)}MB 上限`;
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(0, STDERR_LIMIT);
    });
    child.on('error', (err: any) => {
      clearTimeout(timer);
      reject(
        input.runtime === 'python'
          ? new PipelineError(`未检测到可用的 Python（${command}）：${err?.message ?? err}`, 'PIPELINE_PYTHON_MISSING', '安装 Python 或设置 AIDB_PYTHON 指向解释器')
          : new PipelineError(`脚本进程启动失败：${err?.message ?? err}`, 'PIPELINE_SCRIPT_SPAWN'),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? (timedOut ? 124 : isWindows ? 1 : 0), timedOut });
    });
  });

  if (timedOut) {
    throw new PipelineError(`脚本执行超过 ${Math.round(input.timeoutMs / 1000)} 秒已被终止`, 'PIPELINE_SCRIPT_TIMEOUT', '脚本应当只做数据变换；需要更久的计算请拆小批次或提高超时');
  }
  if (code !== 0) {
    const detail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    throw new PipelineError(`脚本退出码 ${code}${detail ? `：${detail}` : ''}`, 'PIPELINE_SCRIPT_FAILED');
  }

  let parsed: { rows?: unknown; state?: unknown };
  try {
    parsed = JSON.parse(stdout || '{}');
  } catch {
    throw new PipelineError('脚本 stdout 不是合法 JSON，请只输出 {rows, state}', 'PIPELINE_SCRIPT_OUTPUT');
  }
  const raw = Array.isArray(parsed.rows) ? parsed.rows : [];
  const truncated = raw.length > input.maxRows;
  const rows = (truncated ? raw.slice(0, input.maxRows) : raw).map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item }));
  const state = parsed.state && typeof parsed.state === 'object' ? (parsed.state as Record<string, unknown>) : undefined;
  return { rows, state, truncated, stderr, durationMs: Date.now() - started };
}

/** 探测 Python 是否可用，界面用它决定脚本步骤是否可选。 */
export function checkPython(): Promise<{ ok: boolean; version?: string; command: string }> {
  const command = pythonCommand();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv('python') });
    } catch {
      resolve({ ok: false, command });
      return;
    }
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { out += chunk; });
    child.stderr?.on('data', (chunk: string) => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, command });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, version: out.trim(), command } : { ok: false, command });
    });
  });
}
