import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getTool, resolveRisk, toolSignature } from '@aidb/core';
import { createGateway } from '../src/server';
import { visibleAgentTools } from '../src/agentHost';
import { ToolExecutor } from '../src/executor';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-builtin-mcp-'));
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
writeFileSync(
  join(workspace, 'OrderService.java'),
  'package demo;\n\n@Table(name = "orders")\npublic class OrderService {\n  // 订单表\n}\n',
);
writeFileSync(join(workspace, 'Sample.java'), 'alpha\nbeta\n@Table(name = "sample")\ngamma\ndelta\n');
writeFileSync(join(workspace, 'move-me.txt'), 'move\n');

const TOKEN = 'builtin-mcp-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'builtin-mcp-secret',
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
const run = (name: string, args: Record<string, unknown>) => executor.execute({ id: `${name}-${Math.random()}`, name, args }, { sessionId: 'builtin-mcp' });

let localServer: Server | undefined;

after(async () => {
  if (localServer) await new Promise<void>((resolve) => localServer!.close(() => resolve()));
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

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

async function serverId(kind: 'filesystem' | 'git' | 'web'): Promise<string> {
  const listed = await api('/mcp/servers');
  const server = listed.body.servers.find((item: any) => item.builtin === kind);
  assert.ok(server, `missing built-in ${kind}`);
  return server.id;
}

test('内置 MCP 默认预置且不可删除/改造', async () => {
  const listed = await api('/mcp/servers');
  const kinds = listed.body.servers.map((server: any) => server.builtin).filter(Boolean).sort();
  assert.deepEqual(kinds, ['filesystem', 'git', 'web']);

  const fsId = await serverId('filesystem');
  const removed = await api(`/mcp/servers/${fsId}`, { method: 'DELETE' });
  assert.equal(removed.status, 400);

  const renamed = await api(`/mcp/servers/${fsId}`, { method: 'PUT', body: JSON.stringify({ name: 'my-fs' }) });
  assert.equal(renamed.status, 400);

  const created = await api('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name: 'fake-builtin', command: 'builtin:filesystem', args: [] }),
  });
  assert.equal(created.status, 400);
  const reserved = await api('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name: 'filesystem', command: process.execPath, args: [] }),
  });
  assert.equal(reserved.status, 400);

  const catalog = await run('mcp_list_servers', {});
  assert.equal(catalog.ok, true, catalog.error?.message);
  const servers = (catalog.data as any).servers;
  assert.ok(servers.some((server: any) => server.id === fsId && server.tools.some((tool: any) => tool.name === 'read_file')));
  assert.ok(!servers.some((server: any) => server.builtin === 'web'), 'disabled web server should be hidden by default');
});

test('filesystem 只在授权目录内读写，并拦截路径逃逸', async () => {
  const fsId = await serverId('filesystem');
  const updated = await api(`/mcp/servers/${fsId}`, { method: 'PUT', body: JSON.stringify({ args: [workspace] }) });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const discovered = await run('mcp_list_tools', { server: fsId });
  assert.equal(discovered.ok, true, discovered.error?.message);
  const names = (discovered.data as any).tools.map((tool: any) => tool.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('read_multiple_files'));
  assert.ok(names.includes('write_file'));
  assert.ok(names.includes('move_file'));
  assert.ok(names.includes('delete_file'));
  assert.equal((discovered.data as any).tools.find((tool: any) => tool.name === 'read_file').risk, 'read');
  assert.equal((discovered.data as any).tools.find((tool: any) => tool.name === 'delete_file').risk, 'destructive');

  const read = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: { path: 'OrderService.java' } });
  assert.equal(read.ok, true, read.error?.message);
  assert.match((read.data as any).content, /@Table\(name = "orders"\)/);

  const aliasRead = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: { file_path: 'OrderService.java' } });
  assert.equal(aliasRead.ok, true, aliasRead.error?.message);

  const globSearch = await run('mcp_call', {
    server: fsId,
    tool: 'search_files',
    arguments: { path: '.', pattern: '**/*.java' },
  });
  assert.equal(globSearch.ok, true, globSearch.error?.message);
  assert.equal((globSearch.data as any).files.length, 2);
  assert.deepEqual(
    (globSearch.data as any).files.map((file: any) => file.relative).sort(),
    ['OrderService.java', 'Sample.java'],
  );

  const batch = await run('mcp_call', {
    server: fsId,
    tool: 'read_multiple_files',
    arguments: { paths: ['OrderService.java', 'Sample.java', 'missing.java'], limit: 10 },
  });
  assert.equal(batch.ok, true, batch.error?.message);
  const batchFiles = (batch.data as any).files;
  assert.equal(batchFiles.length, 3);
  assert.match(batchFiles[0].content, /@Table/);
  assert.match(batchFiles[1].content, /sample/);
  assert.ok(batchFiles[2].error);

  const batchAlias = await run('mcp_call', {
    server: fsId,
    tool: 'read_multiple_files',
    arguments: { files: ['OrderService.java', 'Sample.java'], limit: 5 },
  });
  assert.equal(batchAlias.ok, true, batchAlias.error?.message);
  assert.equal((batchAlias.data as any).files.length, 2);

  const grep = await run('mcp_call', { server: fsId, tool: 'grep_files', arguments: { pattern: 'OrderService', include: '*.java' } });
  assert.equal(grep.ok, true, grep.error?.message);
  assert.equal((grep.data as any).matches.length, 1);

  const context = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { pattern: '@Table', include: 'Sample.java', context: 1 },
  });
  assert.equal(context.ok, true, context.error?.message);
  const contextMatch = (context.data as any).matches[0];
  assert.deepEqual(contextMatch.before, ['beta']);
  assert.deepEqual(contextMatch.after, ['gamma']);

  const aliasGrep = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { pattern: '@Table', glob: 'Sample.java', output_mode: 'files_with_matches', head_limit: 5 },
  });
  assert.equal(aliasGrep.ok, true, aliasGrep.error?.message);
  assert.equal((aliasGrep.data as any).files.length, 1);
  const claudeContext = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { pattern: '@table', glob: 'Sample.java', '-C': 1, '-i': true, output_mode: 'content' },
  });
  assert.equal(claudeContext.ok, true, claudeContext.error?.message);
  assert.equal((claudeContext.data as any).matches.length, 1);
  assert.deepEqual((claudeContext.data as any).matches[0].before, ['beta']);

  const fileMode = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { pattern: '@Table', include: '*.java', outputMode: 'files' },
  });
  assert.equal(fileMode.ok, true, fileMode.error?.message);
  assert.equal((fileMode.data as any).files.length, 2);
  const countMode = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { pattern: '@Table', include: '*.java', outputMode: 'count' },
  });
  assert.equal(countMode.ok, true, countMode.error?.message);
  assert.equal((countMode.data as any).files.length, 2);

  // Rust regex (ripgrep) has no lookbehind; this must fall back to the JS scanner.
  const lookbehind = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { pattern: '(?<=@Table)\\(name', include: 'Sample.java' },
  });
  assert.equal(lookbehind.ok, true, lookbehind.error?.message);
  assert.equal((lookbehind.data as any).engine, 'js');
  assert.equal((lookbehind.data as any).matches.length, 1);

  const listed = await run('mcp_call', { server: fsId, tool: 'list_directory', arguments: { path: '.' } });
  assert.equal(listed.ok, true, listed.error?.message);
  assert.ok((listed.data as any).entries.some((entry: any) => entry.path.endsWith('OrderService.java')));
  const aliasList = await run('mcp_call', { server: fsId, tool: 'list_directory', arguments: { file_path: '.' } });
  assert.equal(aliasList.ok, true, aliasList.error?.message);

  const aliasWrite = await run('mcp_call', {
    server: fsId,
    tool: 'write_file',
    arguments: { file_path: 'out/alias.md', content: '# alias\n' },
  });
  assert.equal(aliasWrite.ok, true, aliasWrite.error?.message);
  const aliasMove = await run('mcp_call', {
    server: fsId,
    tool: 'move_file',
    arguments: { source_path: 'out/alias.md', destination_path: 'out/alias-moved.md' },
  });
  assert.equal(aliasMove.ok, true, aliasMove.error?.message);
  const aliasDelete = await run('mcp_call', {
    server: fsId,
    tool: 'delete_file',
    arguments: { file_path: 'out/alias-moved.md', confirm: 'alias-moved.md' },
  });
  assert.equal(aliasDelete.ok, true, aliasDelete.error?.message);

  const escaped = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: { path: '../outside.txt' } });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error?.code, 'MCP_PATH_DENIED');

  const write = await run('mcp_call', { server: fsId, tool: 'write_file', arguments: { path: 'out/notes.md', content: '# notes\n' } });
  assert.equal(write.ok, true, write.error?.message);
  const overwrite = await run('mcp_call', { server: fsId, tool: 'write_file', arguments: { path: 'out/notes.md', content: '# again\n' } });
  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.error?.code, 'MCP_FILE_EXISTS');
  const forced = await run('mcp_call', { server: fsId, tool: 'write_file', arguments: { path: 'out/notes.md', content: '# again\n', overwrite: true } });
  assert.equal(forced.ok, true, forced.error?.message);

  const edited = await run('mcp_call', { server: fsId, tool: 'edit_file', arguments: { path: 'out/notes.md', oldText: '# again', newText: '# edited' } });
  assert.equal(edited.ok, true, edited.error?.message);
  const aliasEdit = await run('mcp_call', {
    server: fsId,
    tool: 'edit_file',
    arguments: { file_path: 'out/notes.md', old_string: '# edited', new_string: '# aliased', replace_all: true },
  });
  assert.equal(aliasEdit.ok, true, aliasEdit.error?.message);
  const aliasInfo = await run('mcp_call', { server: fsId, tool: 'file_info', arguments: { file_path: 'out/notes.md' } });
  assert.equal(aliasInfo.ok, true, aliasInfo.error?.message);

  const move = await run('mcp_call', {
    server: fsId,
    tool: 'move_file',
    arguments: { source: 'move-me.txt', destination: 'moved/renamed.txt' },
  });
  assert.equal(move.ok, true, move.error?.message);
  const moved = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: { path: 'moved/renamed.txt' } });
  assert.equal(moved.ok, true, moved.error?.message);
  const oldPath = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: { path: 'move-me.txt' } });
  assert.equal(oldPath.ok, false);

  const escapeMove = await run('mcp_call', {
    server: fsId,
    tool: 'move_file',
    arguments: { source: 'out/notes.md', destination: '../escape.md' },
  });
  assert.equal(escapeMove.ok, false);
  assert.equal(escapeMove.error?.code, 'MCP_PATH_DENIED');

  const wrongConfirm = await run('mcp_call', {
    server: fsId,
    tool: 'delete_file',
    arguments: { path: 'moved/renamed.txt', confirm: 'nope' },
  });
  assert.equal(wrongConfirm.ok, false);
  const deleteDir = await run('mcp_call', {
    server: fsId,
    tool: 'delete_file',
    arguments: { path: 'moved', confirm: 'moved' },
  });
  assert.equal(deleteDir.ok, false);
  const deleted = await run('mcp_call', {
    server: fsId,
    tool: 'delete_file',
    arguments: { path: 'moved/renamed.txt', confirm: 'renamed.txt' },
  });
  assert.equal(deleted.ok, true, deleted.error?.message);
  const gone = await run('mcp_call', { server: fsId, tool: 'read_file', arguments: { path: 'moved/renamed.txt' } });
  assert.equal(gone.ok, false);
});

test('git 只读工具可读取状态与历史', async (t) => {
  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('git is not installed');
    return;
  }
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  const git = (args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(git(['init']).status, 0);
  assert.equal(git(['config', 'user.email', 'test@example.com']).status, 0);
  assert.equal(git(['config', 'user.name', 'AiDB Test']).status, 0);
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['commit', '-m', 'init']).status, 0);

  const gitId = await serverId('git');
  const updated = await api(`/mcp/servers/${gitId}`, { method: 'PUT', body: JSON.stringify({ args: [repo] }) });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const status = await run('mcp_call', { server: gitId, tool: 'git_status', arguments: {} });
  assert.equal(status.ok, true, status.error?.message);
  assert.match((status.data as any).output, /##/);

  const log = await run('mcp_call', { server: gitId, tool: 'git_log', arguments: { maxCount: 5 } });
  assert.equal(log.ok, true, log.error?.message);
  assert.match((log.data as any).output, /init/);
});

test('web 拒绝内网地址，且默认关闭', async () => {
  localServer = createServer((_req, res) => res.end('secret'));
  const localPort = await listenRandom(localServer);
  const webId = await serverId('web');
  const before = await run('mcp_list_servers', {});
  assert.ok(!(before.data as any).servers.some((server: any) => server.id === webId));

  const enabled = await api(`/mcp/servers/${webId}`, { method: 'PUT', body: JSON.stringify({ enabled: true, args: [] }) });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

  const blocked = await run('mcp_call', {
    server: webId,
    tool: 'fetch_url',
    arguments: { url: `http://127.0.0.1:${localPort}/` },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, 'MCP_URL_DENIED');

  const mapped = await run('mcp_call', {
    server: webId,
    tool: 'fetch_url',
    arguments: { url: `http://[::ffff:7f00:1]:${localPort}/` },
  });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.error?.code, 'MCP_URL_DENIED');
});

test('mcp_call 风险：内置读工具免审批，写工具与外部服务器仍需审批', () => {
  const tool = getTool('mcp_call')!;
  assert.equal(tool.risk, 'dynamic');
  assert.equal(resolveRisk({ id: '1', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'read_file' } }, tool), 'read');
  assert.equal(resolveRisk({ id: '2', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'write_file' } }, tool), 'write');
  assert.equal(resolveRisk({ id: '2b', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'delete_file' } }, tool), 'destructive');
  assert.equal(resolveRisk({ id: '3', name: 'mcp_call', args: { server: 'builtin-web', tool: 'fetch_url' } }, tool), 'read');
  assert.equal(resolveRisk({ id: '4', name: 'mcp_call', args: { server: 'filesystem', tool: 'read_file' } }, tool), 'read');
  assert.equal(resolveRisk({ id: '5', name: 'mcp_call', args: { server: 'external', tool: 'read_file' } }, tool), 'write');
  assert.equal(resolveRisk({ id: '6', name: 'mcp_call', args: { server: 'builtin-evil', tool: 'read_file' } }, tool), 'write');
  assert.equal(resolveRisk({ id: '7', name: 'mcp_call', args: { server: 'filesystem', tool: 'delete_file' } }, tool), 'destructive');
  assert.notEqual(
    toolSignature({ id: 'a', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'write_file', arguments: { path: 'C:/a.txt' } } }),
    toolSignature({ id: 'b', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'write_file', arguments: { path: 'C:/b.txt' } } }),
    'MCP write approvals must be per path',
  );
});

test('远程回合看不到任何 MCP 工具', () => {
  const settings = gateway.store.getSettings();
  const local = visibleAgentTools(settings, true).map((tool) => tool.name);
  assert.ok(local.includes('mcp_list_servers'));
  assert.ok(local.includes('mcp_call'));
  const remote = visibleAgentTools(settings, false).map((tool) => tool.name);
  assert.ok(!remote.some((name) => name.startsWith('mcp_')));
  assert.ok(remote.includes('run_sql'));
});
