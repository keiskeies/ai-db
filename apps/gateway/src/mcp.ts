import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { builtinMcpKindOf, builtinMcpServerForTool, type JsonSchema, type McpServerInfo, type ToolResult } from '@aidb/core';
import { killTree } from './processTree';
import type { Store } from './store';
import { BuiltinMcpClient } from './builtinMcp';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  risk?: 'read' | 'write' | 'destructive';
}

/** 契约 K1：可选参数，旧调用（不传 opts）行为不变，默认超时仍是 20s。 */
export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface McpClientLike {
  tools(): Promise<McpTool[]>;
  call(tool: string, args: Record<string, unknown>, opts?: McpCallOptions): Promise<ToolResult>;
  close(): void;
}

class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private initialized = false;
  private starting?: Promise<void>;
  private stderr = '';

  constructor(private server: McpServerInfo, private env: Record<string, string>) {}

  private start(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.child = spawn(this.server.command, this.server.args, {
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
        // POSIX 下自成进程组，close 时 killTree 的 kill(-pid) 才能连带孙进程；
        // Windows shell:true 的 pid 是 cmd.exe，靠 taskkill /T 杀树，不需要 detached
        detached: process.platform !== 'win32',
      }) as ChildProcessWithoutNullStreams;
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-4000);
      });
      this.child.on('exit', (code) => {
        const error = new Error(`MCP Server 已退出（code=${code}）：${this.stderr.slice(-500)}`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.initialized = false;
        this.starting = undefined;
        this.child = undefined;
      });
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'AiDB Studio', version: '0.0.10' },
      }, 30_000);
      this.notify('notifications/initialized', {});
      this.initialized = true;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onMessage(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error('MCP Server 未启动或已退出');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: unknown, timeoutMs = 20_000, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        settle(() => reject(new Error(`MCP 调用超时：${method}`)));
      }, timeoutMs);
      const onAbort = (): void => {
        this.pending.delete(id);
        // stdio 子进程没有真正的请求级取消；按 MCP 规范发 cancelled 通知，服务端支持则尽力终止
        try {
          this.notify('notifications/cancelled', { requestId: id, reason: 'client aborted' });
        } catch {
          /* 进程可能已退出 */
        }
        settle(() =>
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : Object.assign(new Error(`MCP 调用已中止：${method}`), { name: 'AbortError' }),
          ),
        );
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
        timer,
      });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        settle(() => reject(err as Error));
      }
    });
  }

  async tools(): Promise<McpTool[]> {
    await this.start();
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? (result.tools as McpTool[]) : [];
  }

  async call(tool: string, args: Record<string, unknown>, opts?: McpCallOptions): Promise<ToolResult> {
    if (opts?.signal?.aborted) throw Object.assign(new Error('MCP 调用已中止'), { name: 'AbortError' });
    await this.start();
    const started = Date.now();
    const result = await this.request('tools/call', { name: tool, arguments: args }, opts?.timeoutMs ?? 20_000, opts?.signal);
    const content = Array.isArray(result?.content) ? result.content : [];
    const texts = content
      .map((item: any) => (item?.type === 'text' ? String(item.text ?? '') : item?.type ? `[${item.type}]` : ''))
      .filter(Boolean);
    const summary = (texts.join('\n') || 'MCP 工具执行完成').slice(0, 500);
    return {
      ok: result?.isError !== true,
      summary,
      data: result ?? null,
      ...(result?.isError === true ? { error: { code: 'MCP_TOOL_ERROR', message: summary } } : {}),
      meta: { durationMs: Date.now() - started },
    };
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    this.starting = undefined;
    // 只 kill 直接子进程会遗留孙进程（Windows shell:true 时 pid 还是 cmd.exe 的）
    if (child) killTree(child);
  }
}

interface CachedClient {
  client: McpClientLike;
  signature: string;
  lastUsed: number;
}

const clients = new Map<string, CachedClient>();
/** 常驻 MCP 子进程不能只增不减：10 分钟没人用就回收，避免配置过一堆 server 后进程越攒越多。 */
const CLIENT_IDLE_MS = 10 * 60 * 1000;
let idleSweeper: ReturnType<typeof setInterval> | undefined;

function ensureIdleSweeper(): void {
  if (idleSweeper) return;
  idleSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of clients) {
      if (now - entry.lastUsed > CLIENT_IDLE_MS) {
        entry.client.close();
        clients.delete(id);
      }
    }
  }, 5 * 60 * 1000);
  idleSweeper.unref?.();
}

function resolveServer(store: Store, ref: string): McpServerInfo {
  const servers = store.listMcpServers();
  const wanted = ref.trim();
  if (!wanted) {
    const enabled = servers.filter((server) => server.enabled);
    const ids = enabled.map((server) => server.id).join(', ') || '(none enabled)';
    throw Object.assign(new Error(`缺少 server：请传入 MCP Server id，可用：${ids}`), { code: 'MCP_SERVER_REQUIRED', status: 400 });
  }
  const server = servers.find((item) => item.id === wanted || item.name === wanted);
  if (!server) {
    const ids = servers.map((item) => `${item.id}${item.enabled ? '' : '(disabled)'}`).join(', ') || '(none configured)';
    throw Object.assign(new Error(`MCP Server 不存在：${ref}。可用：${ids}`), { code: 'MCP_SERVER_NOT_FOUND', status: 404 });
  }
  if (!server.enabled) throw Object.assign(new Error(`MCP Server 已禁用：${server.name}`), { code: 'MCP_SERVER_DISABLED', status: 400 });
  return server;
}

/** A built-in tool name identifies its server; use it when the model omits `server`. */
function inferServerForTool(store: Store, tool: string): McpServerInfo | undefined {
  const definition = builtinMcpServerForTool(tool);
  if (!definition) return undefined;
  return store.listMcpServers().find((server) => server.builtin === definition.kind || builtinMcpKindOf(server.command) === definition.kind);
}

function clientFor(store: Store, server: McpServerInfo): McpClientLike {
  const signature = `${server.command}\u0000${server.args.join('\u0000')}`;
  const cached = clients.get(server.id);
  if (cached && cached.signature === signature) {
    cached.lastUsed = Date.now();
    return cached.client;
  }
  cached?.client.close();
  const client: McpClientLike = builtinMcpKindOf(server.command)
    ? new BuiltinMcpClient(server)
    : new McpClient(server, store.getMcpServerEnv(server.id));
  clients.set(server.id, { client, signature, lastUsed: Date.now() });
  ensureIdleSweeper();
  return client;
}

export async function listMcpTools(store: Store, ref: string): Promise<{ server: McpServerInfo; tools: McpTool[] }> {
  const server = resolveServer(store, ref);
  const tools = await clientFor(store, server).tools();
  return { server, tools };
}

export async function callMcpTool(
  store: Store,
  ref: string,
  tool: string,
  args: Record<string, unknown> = {},
  opts?: McpCallOptions,
): Promise<{ server: McpServerInfo; result: ToolResult }> {
  const name = tool.trim();
  if (!name) throw Object.assign(new Error('tool 必填：先调用 mcp_list_tools 查看工具名'), { code: 'INVALID_INPUT', status: 400 });
  const inferred = ref.trim() ? undefined : inferServerForTool(store, name);
  if (inferred && !inferred.enabled) {
    throw Object.assign(new Error(`MCP Server 已禁用：${inferred.name}。请在 设置 → MCP 与工具 启用`), { code: 'MCP_SERVER_DISABLED', status: 400 });
  }
  const resolved = ref.trim() ? resolveServer(store, ref) : inferred ?? resolveServer(store, ref);
  const result = await clientFor(store, resolved).call(name, args, opts);
  return { server: resolved, result };
}

export function shutdownMcpClients(): void {
  if (idleSweeper) clearInterval(idleSweeper);
  idleSweeper = undefined;
  for (const entry of clients.values()) entry.client.close();
  clients.clear();
}
