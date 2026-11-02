import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';
import { listenRandom } from './helpers';

/**
 * 真实事故：模型对 `read_file` 传了 `paths: [要读的那个文件]`。
 *
 * `read_file` 的 schema 只认 `path` / `file_path`，`paths` 是 `read_multiple_files` 的参数。
 * 旧实现里 `target()` 在取不到路径时会**静默回落到授权根目录**，于是：
 *   参数名写错 → 读到的是目录 → 报「不是文件：C:\server\kbook」
 * 错误信息指向了一个完全无关的事实（根目录不是文件），既没说是哪个参数出了问题，
 * 也没说正确参数名是什么。模型拿到这句话无法自我修正，只能重试同样的调用。
 *
 * 这里锁两件事：
 *   1. 单元素 `paths` 直接当成那个文件（意图无歧义，容忍它比报错更有用）；
 *   2. 真正缺路径时，错误必须说清「缺哪个参数」与「可以传什么」，绝不再回落到根目录。
 */
const home = mkdtempSync(join(tmpdir(), 'aidb-fs-paths-'));
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
writeFileSync(join(workspace, 'AiScene.java'), 'package com.kbook.entity;\n\npublic class AiScene {}\n');
writeFileSync(join(workspace, 'Other.java'), 'package com.kbook.entity;\n\npublic class Other {}\n');

const TOKEN = 'fs-paths-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'fs-paths-secret',
  token: TOKEN,
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
await listenRandom(gateway.server);
const port = (gateway.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());
const run = (name: string, args: Record<string, unknown>) =>
  executor.execute({ id: `${name}-${Math.random()}`, name, args }, { sessionId: 'fs-paths' });

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let fsId = '';
after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

test('准备：内置 filesystem 授权到 workspace', async () => {
  const listed = await api('/mcp/servers');
  fsId = listed.body.servers.find((item: any) => item.builtin === 'filesystem').id;
  const updated = await api(`/mcp/servers/${fsId}`, { method: 'PUT', body: JSON.stringify({ args: [workspace] }) });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
});

/* ------------------------------------------------------------------ *
 * 特性测试：本次事故的形状，修复前必须红。
 * ------------------------------------------------------------------ */

test('read_file 收到单元素 paths 时读取该文件，而不是回落到授权根目录', async () => {
  const target = join(workspace, 'AiScene.java');
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'read_file',
    arguments: { paths: [target] },
  });

  assert.equal(result.ok, true, `单元素 paths 应当被接受：${result.error?.message ?? ''}`);
  const data = result.data as { path: string; content: string };
  assert.equal(data.path, target, '必须读的是 paths 里那个文件，不是根目录');
  assert.match(data.content, /class AiScene/, '拿到的是那个文件的内容');
  // 事故里的原始错误信息不能再出现：它说明实现回落到根目录后去 stat 了一个目录。
  assert.doesNotMatch(String(result.error?.message ?? ''), /不是文件/, '不得再回落到授权根目录');
});

test('read_file 完全没给路径时，错误点明缺参数与可用参数名，且不回落到根目录', async () => {
  const result = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: {} });

  assert.equal(result.ok, false, '没有路径时不该读出任何内容');
  const message = String(result.error?.message ?? '');
  assert.doesNotMatch(message, /不是文件/, `错误信息不该是回落到根目录的产物，实际：${message}`);
  assert.match(message, /path|paths|file_path/, `错误必须指出可用的参数名，实际：${message}`);
  assert.match(message, /read_multiple_files/, '多文件场景应当被指向 read_multiple_files');
});

test('单元素 paths 对 write_file 同样生效，且真的写到那个路径', async () => {
  const target = join(workspace, 'written-by-paths.txt');
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'write_file',
    arguments: { paths: [target], content: 'hello' },
  });
  assert.equal(result.ok, true, `write_file 也应接受单元素 paths：${result.error?.message ?? ''}`);
  const readBack = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: { path: target } });
  assert.equal(readBack.ok, true, readBack.error?.message);
  assert.equal((readBack.data as any).content, 'hello');
});

/* ------------------------------------------------------------------ *
 * 锁定测试：目录类工具「省略路径=授权根目录」是有意义的默认，不能被改坏。
 * ------------------------------------------------------------------ */

test('list_directory 省略路径时仍然列出授权根目录（默认行为保留）', async () => {
  const result = await run('mcp_call', { server: fsId, tool: 'list_directory', arguments: {} });
  assert.equal(result.ok, true, result.error?.message ?? '');
  const entries = (result.data as any).entries as Array<{ path: string }>;
  assert.ok(entries.some((e) => e.path.endsWith('AiScene.java')), '默认列出根目录下的文件');
});

test('read_file 的多文件场景仍走 read_multiple_files，且逐文件返回错误', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'read_multiple_files',
    arguments: { paths: [join(workspace, 'AiScene.java'), join(workspace, 'Other.java')] },
  });
  assert.equal(result.ok, true, result.error?.message ?? '');
  const files = (result.data as any).files as Array<{ path: string; content?: string; error?: string }>;
  assert.equal(files.length, 2, '两个文件都要处理');
  assert.ok(files.every((f) => typeof f.content === 'string'), '两个文件都应读到内容');
});

test('路径逃逸在单元素 paths 下依然被拦截', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'read_file',
    arguments: { paths: [join(workspace, '..', 'outside.txt')] },
  });
  assert.equal(result.ok, false, '越界路径必须被拒');
  assert.equal(result.error?.code, 'MCP_PATH_DENIED', `实际：${result.error?.code}`);
});