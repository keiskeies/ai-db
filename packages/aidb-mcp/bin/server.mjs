#!/usr/bin/env node
/**
 * AiDB MCP Server (stdio) — headless, reads the credential file written by `aidb-mcp pair`.
 * stdout carries ONLY line-delimited JSON-RPC; all diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { readCredentials } from './credentials.mjs';

let base;
let token;
try {
  const credentials = readCredentials();
  base = (credentials.url || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  token = credentials.token;
} catch (err) {
  // 兼容旧的显式环境变量用法（不推荐：主令牌权限过大）。
  if (process.env.AIDB_TOKEN) {
    base = (process.env.AIDB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    token = process.env.AIDB_TOKEN;
    process.stderr.write('[aidb-mcp] 使用 AIDB_TOKEN 环境变量（不推荐，建议运行 npx -y @aidb/mcp pair）\n');
  } else {
    process.stderr.write(`[aidb-mcp] ${err.message}\n`);
    process.exit(1);
  }
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
let tools;

async function loadTools() {
  if (tools) return tools;
  const response = await fetch(`${base}/api/agent/tools?for=mcp`, { headers });
  if (!response.ok) throw new Error(`GET /api/agent/tools failed: ${response.status}`);
  const body = await response.json();
  tools = (body.tools ?? []).filter((tool) => tool.risk === 'read' || tool.risk === 'dynamic');
  return tools;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callTool(name, args) {
  const response = await fetch(`${base}/api/agent/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args: args ?? {}, sessionId: 'mcp' }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(body.result ?? body, null, 2) }] };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write('[aidb-mcp] invalid JSON-RPC line\n');
    return;
  }
  if (message.id === undefined) return;
  void (async () => {
    try {
      if (message.method === 'initialize') {
        reply(message.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'aidb-studio', version: '0.1.0' },
        });
        return;
      }
      if (message.method === 'ping') {
        reply(message.id, {});
        return;
      }
      if (message.method === 'tools/list') {
        const list = await loadTools();
        reply(message.id, {
          tools: list.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        });
        return;
      }
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        if (typeof name !== 'string') {
          fail(message.id, -32602, 'tools/call requires params.name');
          return;
        }
        reply(message.id, await callTool(name, message.params?.arguments));
        return;
      }
      fail(message.id, -32601, `Method not found: ${message.method}`);
    } catch (err) {
      fail(message.id, -32603, String(err?.message ?? err));
    }
  })();
});
input.on('close', () => process.exit(0));
