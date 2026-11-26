import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devNull, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getTool, resolveRisk, toolSignature } from '@aidb/core';
import { createGateway } from '../src/server';
import { visibleAgentTools } from '../src/agentHost';
import { ToolExecutor } from '../src/executor';
import { assertPublicUrl, BuiltinMcpClient } from '../src/builtinMcp';
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
mkdirSync(join(workspace, 'nested', 'deep'), { recursive: true });
writeFileSync(join(workspace, 'nested', 'deep', 'Deep.java'), 'package demo;\n');

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

function mockDnsLookup(t: TestContext, lookup: (host: string) => Promise<Array<{ address: string; family: number }>>): () => void {
  const mocked = t.mock.method(dnsPromises, 'lookup', lookup as unknown as typeof dnsPromises.lookup);
  syncBuiltinESMExports();
  return () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
}

function webClient(args: string[]): BuiltinMcpClient {
  const now = new Date().toISOString();
  return new BuiltinMcpClient({ id: 'builtin-web', name: 'web', command: 'builtin:web', args, enabled: true, createdAt: now, updatedAt: now });
}

function filesystemClient(root: string): BuiltinMcpClient {
  const now = new Date().toISOString();
  return new BuiltinMcpClient({ id: 'builtin-filesystem', name: 'filesystem', command: 'builtin:filesystem', args: [root], enabled: true, createdAt: now, updatedAt: now });
}

function gitClient(repo: string): BuiltinMcpClient {
  const now = new Date().toISOString();
  return new BuiltinMcpClient({ id: 'builtin-git', name: 'git', command: 'builtin:git', args: [repo], enabled: true, createdAt: now, updatedAt: now });
}

async function dispatcherPinnedAddress(dispatcher: unknown): Promise<{ address: string; family: number }> {
  // 直接调用连接器的 lookup，证明 fetch 没有把 hostname 再交给系统 DNS。
  const optionsKey = Reflect.ownKeys(dispatcher as object).find((key) => String(key) === 'Symbol(options)');
  assert.ok(optionsKey);
  const lookup = (dispatcher as any)[optionsKey]?.connect?.lookup;
  assert.equal(typeof lookup, 'function');
  return new Promise((resolve, reject) => lookup('allowed.example', {}, (err: Error | null, address: string, family: number) => {
    if (err) reject(err);
    else resolve({ address, family });
  }));
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
  assert.equal((discovered.data as any).tools.find((tool: any) => tool.name === 'move_file').risk, 'destructive');
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
  assert.equal((globSearch.data as any).files.length, 3);
  assert.deepEqual(
    (globSearch.data as any).files.map((file: any) => file.relative).sort(),
    ['OrderService.java', 'Sample.java', 'nested/deep/Deep.java'],
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

  const recursive = await run('mcp_call', { server: fsId, tool: 'list_directory', arguments: { path: '.', recursive: true } });
  assert.equal(recursive.ok, true, recursive.error?.message);
  assert.ok((recursive.data as any).entries.some((entry: any) => entry.path.endsWith('OrderService.java')));
  assert.ok(
    (recursive.data as any).entries.some((entry: any) => entry.path.endsWith('Deep.java') && entry.type === 'file'),
    'recursive listing should reach nested files',
  );

  // The model often omits `server` for built-in tools; the name alone must resolve.
  const inferred = await run('mcp_call', { tool: 'list_directory', arguments: { path: '.' } });
  assert.equal(inferred.ok, true, inferred.error?.message);
  assert.ok((inferred.data as any).entries.some((entry: any) => entry.path.endsWith('Sample.java')));
  const unknownServer = await run('mcp_call', { tool: 'nope_file', arguments: {} });
  assert.equal(unknownServer.ok, false);
  assert.match(String(unknownServer.error?.message), /缺少 server|不存在/);

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

test('move_file 覆盖先保留同目录备份，成功后才删除旧目标', async () => {
  const root = join(home, 'move-overwrite');
  mkdirSync(root, { recursive: true });
  const source = join(root, 'source.txt');
  const destination = join(root, 'destination.txt');
  writeFileSync(source, 'new content\n');
  writeFileSync(destination, 'old content\n');

  const result = await filesystemClient(root).call('move_file', { source, destination, overwrite: true });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(destination, 'utf8'), 'new content\n');
  assert.deepEqual(readdirSync(root).sort(), ['destination.txt']);
});

test('move_file 在 EXDEV、权限失败或取消时回滚旧目标与源文件', async (t) => {
  const originalRename = fs.renameSync;
  let scenario: 'EACCES' | 'EXDEV' | 'backup-denied' | 'abort' | 'abort-after-source' | undefined;
  let activeSource = '';
  let activeDestination = '';
  let controller: AbortController | undefined;
  const mocked = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if ((scenario === 'abort' && String(from) === activeDestination) ||
        (scenario === 'abort-after-source' && String(from) === activeSource && String(to) === activeDestination)) {
      originalRename(from, to);
      controller!.abort();
      return;
    }
    if (scenario === 'backup-denied' && String(from) === activeDestination) {
      throw Object.assign(new Error('injected backup EACCES'), { code: 'EACCES' });
    }
    if ((scenario === 'EACCES' || scenario === 'EXDEV') && String(from) === activeSource && String(to) === activeDestination) {
      throw Object.assign(new Error(`injected ${scenario}`), { code: scenario });
    }
    originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    for (const current of ['EACCES', 'EXDEV', 'backup-denied', 'abort', 'abort-after-source'] as const) {
      const root = join(home, `move-rollback-${current}`);
      mkdirSync(root, { recursive: true });
      const source = join(root, 'source.txt');
      const destination = join(root, 'destination.txt');
      writeFileSync(source, 'new content\n');
      writeFileSync(destination, 'old content\n');
      scenario = current;
      activeSource = source;
      activeDestination = destination;
      controller = new AbortController();

      const result = await filesystemClient(root).call(
        'move_file',
        { source, destination, overwrite: true },
        { signal: controller.signal },
      );
      assert.equal(result.ok, false, result.error?.message);
      assert.equal(result.error?.code, current === 'abort' || current === 'abort-after-source' ? 'MCP_ABORTED' : current === 'EXDEV' ? 'MCP_MOVE_CROSS_DEVICE' : 'MCP_MOVE_FAILED');
      assert.equal(readFileSync(source, 'utf8'), 'new content\n');
      assert.equal(readFileSync(destination, 'utf8'), 'old content\n');
      assert.deepEqual(readdirSync(root).sort(), ['destination.txt', 'source.txt']);
    }
  } finally {
    scenario = undefined;
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('move_file 拒绝通过符号链接或 junction 访问 granted root 外的路径', async (t) => {
  const root = join(home, 'move-links');
  const outside = join(home, 'move-outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const source = join(root, 'source.txt');
  const outsideFile = join(outside, 'victim.txt');
  const linkedRoot = join(root, 'linked');
  writeFileSync(source, 'source content\n');
  writeFileSync(outsideFile, 'outside content\n');
  try {
    symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err: any) {
    if (err?.code === 'EPERM') {
      t.skip('symlink/junction creation is not permitted');
      return;
    }
    throw err;
  }

  const client = filesystemClient(root);
  const escapedDestination = await client.call('move_file', { source, destination: join(linkedRoot, 'victim.txt'), overwrite: true });
  assert.equal(escapedDestination.ok, false);
  assert.equal(escapedDestination.error?.code, 'MCP_PATH_DENIED');
  assert.equal(readFileSync(source, 'utf8'), 'source content\n');
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside content\n');

  const escapedSource = await client.call('move_file', { source: join(linkedRoot, 'victim.txt'), destination: join(root, 'stolen.txt') });
  assert.equal(escapedSource.ok, false);
  assert.equal(escapedSource.error?.code, 'MCP_PATH_DENIED');
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside content\n');
  assert.equal(existsSync(join(root, 'stolen.txt')), false);
});

test('git 只读工具可读取状态与历史', async (t) => {
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : devNull;
  const env = { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
  try {
    if (spawnSync('git', ['--version'], { encoding: 'utf8', env }).status !== 0) {
      t.skip('git is not installed');
      return;
    }
    const repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr || result.error?.message || 'git fixture failed');
      return result;
    };
    git(['init', '--quiet', '--template=']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'AiDB Test']);
    const emptyHooks = join(repo, '.git', 'empty-hooks');
    mkdirSync(emptyHooks, { recursive: true });
    git(['config', 'core.hooksPath', emptyHooks]);
    git(['add', '.']);
    git(['commit', '--no-gpg-sign', '-m', 'init']);

    // Exercise the in-process client directly. The previous gateway API round trips added
    // loopback fetch lifecycles to a test that otherwise needs only a local git fixture.
    const client = gitClient(repo);
    const status = await client.call('git_status', {});
    assert.equal(status.ok, true, status.error?.message);
    assert.match((status.data as any).output, /##/);

    const log = await client.call('git_log', { maxCount: 5 });
    assert.equal(log.ok, true, log.error?.message);
    assert.match((log.data as any).output, /init/);
  } finally {
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
  }
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

test('fetch_url 将 DNS 校验结果固定给实际连接，防止重绑定', async (t) => {
  let lookups = 0;
  const restoreDns = mockDnsLookup(t, async () => {
    lookups += 1;
    return lookups === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }];
  });
  const originalFetch = globalThis.fetch;
  let dispatcher: unknown;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    dispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
    return new Response('public body', { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  try {
    const result = await webClient([]).call('fetch_url', { url: 'https://allowed.example/path' });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(lookups, 1, 'fetch 不应再次解析 hostname');
    assert.ok(dispatcher, 'fetch 必须使用固定 IP 的 dispatcher');
    assert.deepEqual(await dispatcherPinnedAddress(dispatcher), { address: '93.184.216.34', family: 4 });
    await assert.rejects(() => assertPublicUrl(new URL('https://allowed.example/path')), /内网地址/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDns();
  }
});

test('fetch_url 对每个重定向重新检查 allowlist，且只访问允许的首跳', async (t) => {
  const restoreDns = mockDnsLookup(t, async () => [{ address: '93.184.216.34', family: 4 }]);
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requested.push(String(input));
    return new Response(null, { status: 302, headers: { location: 'https://outside.example/secret' } });
  }) as typeof fetch;
  try {
    const result = await webClient(['allowed.example']).call('fetch_url', { url: 'https://allowed.example/start' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'MCP_URL_DENIED');
    assert.deepEqual(requested, ['https://allowed.example/start']);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDns();
  }
});

test('fetch_url 允许的跨子域重定向会逐跳校验并固定新地址', async (t) => {
  const restoreDns = mockDnsLookup(t, async (host) => [{ address: host === 'a.example.com' ? '93.184.216.34' : '93.184.216.35', family: 4 }]);
  const originalFetch = globalThis.fetch;
  const dispatchers: unknown[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    dispatchers.push((init as RequestInit & { dispatcher?: unknown }).dispatcher);
    return String(input).endsWith('/start')
      ? new Response(null, { status: 307, headers: { location: 'https://b.example.com/final' } })
      : new Response('final body', { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  try {
    const result = await webClient(['*.example.com']).call('fetch_url', { url: 'https://a.example.com/start' });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal((result.data as any).text, 'final body');
    assert.equal(dispatchers.length, 2);
    assert.notEqual(dispatchers[0], dispatchers[1]);
    assert.deepEqual(await dispatcherPinnedAddress(dispatchers[0]), { address: '93.184.216.34', family: 4 });
    assert.deepEqual(await dispatcherPinnedAddress(dispatchers[1]), { address: '93.184.216.35', family: 4 });
  } finally {
    globalThis.fetch = originalFetch;
    restoreDns();
  }
});

test('fetch_url 拒绝重定向到私网，且不会发出第二跳', async (t) => {
  const restoreDns = mockDnsLookup(t, async () => [{ address: '93.184.216.34', family: 4 }]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }) as typeof fetch;
  try {
    const result = await webClient([]).call('fetch_url', { url: 'https://allowed.example/start' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'MCP_URL_DENIED');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDns();
  }
});

test('fetch_url 的总超时覆盖重定向后的响应体', async (t) => {
  const restoreDns = mockDnsLookup(t, async () => [{ address: '93.184.216.34', family: 4 }]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: '/stalled' } });
    return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  try {
    const result = await webClient([]).call('fetch_url', { url: 'https://allowed.example/start' }, { timeoutMs: 30 });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'MCP_FETCH_TIMEOUT');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDns();
  }
});

test('fetch_url 对超过字节上限的响应返回明确错误', async (t) => {
  const restoreDns = mockDnsLookup(t, async () => [{ address: '93.184.216.34', family: 4 }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('small', {
    status: 200,
    headers: { 'content-type': 'text/plain', 'content-length': String(1024 * 1024 + 1) },
  })) as typeof fetch;
  try {
    const result = await webClient([]).call('fetch_url', { url: 'https://allowed.example/large' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'MCP_FETCH_TOO_LARGE');
  } finally {
    globalThis.fetch = originalFetch;
    restoreDns();
  }
});

test('mcp_call 风险：内置读工具免审批，写工具与外部服务器仍需审批', () => {
  const tool = getTool('mcp_call')!;
  assert.equal(tool.risk, 'dynamic');
  assert.equal(resolveRisk({ id: '1', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'read_file' } }, tool), 'read');
  assert.equal(resolveRisk({ id: '2', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'write_file' } }, tool), 'write');
  assert.equal(resolveRisk({ id: '2b', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'delete_file' } }, tool), 'destructive');
  assert.equal(resolveRisk({ id: '2c', name: 'mcp_call', args: { server: 'builtin-filesystem', tool: 'move_file', arguments: { source: '/a', destination: '/b', overwrite: true } } }, tool), 'destructive');
  assert.equal(resolveRisk({ id: '3', name: 'mcp_call', args: { server: 'builtin-web', tool: 'fetch_url' } }, tool), 'read');
  assert.equal(resolveRisk({ id: '4', name: 'mcp_call', args: { server: 'filesystem', tool: 'read_file' } }, tool), 'read');
  assert.equal(resolveRisk({ id: '5', name: 'mcp_call', args: { server: 'external', tool: 'read_file' } }, tool), 'write');
  assert.equal(resolveRisk({ id: '6', name: 'mcp_call', args: { server: 'builtin-evil', tool: 'read_file' } }, tool), 'write');
  assert.equal(resolveRisk({ id: '7', name: 'mcp_call', args: { server: 'filesystem', tool: 'delete_file' } }, tool), 'destructive');
  // server omitted: infer from the built-in tool name; an unknown tool stays write.
  assert.equal(resolveRisk({ id: '8', name: 'mcp_call', args: { tool: 'read_file' } }, tool), 'read');
  assert.equal(resolveRisk({ id: '9', name: 'mcp_call', args: { tool: 'delete_file' } }, tool), 'destructive');
  assert.equal(resolveRisk({ id: '10', name: 'mcp_call', args: { tool: 'custom_tool' } }, tool), 'write');
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
