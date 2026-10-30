import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerInfo, ToolResult } from '@aidb/core';
import type { Store } from './store';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
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
        clientInfo: { name: 'AiDB Studio', version: '0.1.0' },
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

  private request(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async tools(): Promise<McpTool[]> {
    await this.start();
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? (result.tools as McpTool[]) : [];
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.start();
    const started = Date.now();
    const result = await this.request('tools/call', { name: tool, arguments: args });
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
    this.child?.kill();
    this.child = undefined;
    this.initialized = false;
  }
}

const clients = new Map<string, McpClient>();

function resolveServer(store: Store, ref: string): McpServerInfo {
  const servers = store.listMcpServers();
  const server = servers.find((item) => item.id === ref || item.name === ref);
  if (!server) throw Object.assign(new Error(`MCP Server 不存在：${ref}`), { code: 'MCP_SERVER_NOT_FOUND', status: 404 });
  if (!server.enabled) throw Object.assign(new Error(`MCP Server 已禁用：${server.name}`), { code: 'MCP_SERVER_DISABLED', status: 400 });
  return server;
}

function clientFor(store: Store, server: McpServerInfo): McpClient {
  const signature = `${server.command}\u0000${server.args.join('\u0000')}`;
  const cached = clients.get(server.id);
  if (cached && (cached as any).signature === signature) return cached;
  cached?.close();
  const client = new McpClient(server, store.getMcpServerEnv(server.id));
  (client as any).signature = signature;
  clients.set(server.id, client);
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
): Promise<{ server: McpServerInfo; result: ToolResult }> {
  const server = resolveServer(store, ref);
  if (!tool.trim()) throw Object.assign(new Error('tool 必填'), { code: 'INVALID_INPUT', status: 400 });
  const result = await clientFor(store, server).call(tool.trim(), args);
  return { server, result };
}

export function shutdownMcpClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}
