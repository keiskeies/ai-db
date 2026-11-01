import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server';
import { ToolExecutor } from '../src/executor';
import { listenRandom } from './helpers';

/**
 * grep_files 的 pattern 是「JavaScript 正则」。但模型看到工具名里的 grep/glob，
 * 会直觉传 "*.java" 这类文件名通配符，旧实现直接 new RegExp 就抛 MCP_INVALID_REGEX。
 * 这组测试锁定：文件名 glob 走「按文件名筛选」语义，真正则语义完全不变，
 * 真写坏的正则仍然报错并给出可执行的下一步。
 */
const home = mkdtempSync(join(tmpdir(), 'aidb-grep-glob-'));
const workspace = join(home, 'workspace');
mkdirSync(join(workspace, 'nested', 'deep'), { recursive: true });
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
writeFileSync(
  join(workspace, 'OrderService.java'),
  'package demo;\n\n@Table(name = "orders")\npublic class OrderService {\n  // 订单表\n}\n',
);
writeFileSync(join(workspace, 'Sample.java'), 'alpha\nbeta\n@Table(name = "sample")\ngamma\ndelta\n');
writeFileSync(join(workspace, 'nested', 'deep', 'Deep.java'), 'package demo;\n');
writeFileSync(join(workspace, 'helper.ts'), 'export const answer = 42;\n');

const TOKEN = 'grep-glob-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'grep-glob-secret',
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
  executor.execute({ id: `${name}-${Math.random()}`, name, args }, { sessionId: 'grep-glob' });

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

/** 把内置 filesystem 的授权目录指到本测试的临时工作区，再由下面的用例复用。 */
const fsId = await (async () => {
  const listed = await fetch(`${base}/api/mcp/servers`, { headers });
  const body: any = await listed.json();
  const server = body.servers.find((item: any) => item.builtin === 'filesystem');
  assert.ok(server, 'missing built-in filesystem');
  const updated = await fetch(`${base}/api/mcp/servers/${server.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ args: [workspace] }),
  });
  assert.equal(updated.status, 200, await updated.text());
  return server.id as string;
})();

test('pattern 传 *.java（会话 ad4f8647 的原始调用）不再报错，而是按文件名列出 .java', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: '*.java', include: '*.java', outputMode: 'files', maxMatches: 500 },
  });
  assert.equal(result.ok, true, result.error?.message);
  const data = result.data as any;
  assert.equal(data.mode, 'glob', '文件名 glob 路径要能被调用方识别');
  assert.deepEqual(
    data.files.map((file: any) => file.relative).sort(),
    ['OrderService.java', 'Sample.java', 'nested/deep/Deep.java'],
  );
});

test('只有 pattern 是 glob、没有 include 时，pattern 自己能决定文件集', async () => {
  const result = await run('mcp_call', { server: fsId, tool: 'grep_files', arguments: { path: '.', pattern: '*.ts' } });
  assert.equal(result.ok, true, result.error?.message);
  const data = result.data as any;
  assert.equal(data.mode, 'glob');
  assert.deepEqual(data.files.map((file: any) => file.relative), ['helper.ts']);
  assert.equal(data.matches, undefined, 'glob 走文件名筛选，不该伪装成「0 处内容命中」');
});

test('两端通配的 *foo* 同样按文件名命中', async () => {
  const result = await run('mcp_call', { server: fsId, tool: 'grep_files', arguments: { path: '.', pattern: '*Service*' } });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual((result.data as any).files.map((file: any) => file.relative), ['OrderService.java']);
});

test('pattern 与 include 都是 glob 时只按 include 过滤，不会双重筛选成空', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: '*Service*', include: '*.java', outputMode: 'files' },
  });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(
    (result.data as any).files.map((file: any) => file.relative).sort(),
    ['OrderService.java', 'Sample.java', 'nested/deep/Deep.java'],
    'include 已经限定了文件集，pattern 的 glob 不应再筛一遍',
  );
});

test('真正写坏的正则仍然报错，且错误信息给出可执行的下一步', async () => {
  for (const pattern of ['[', '(?!']) {
    const result = await run('mcp_call', { server: fsId, tool: 'grep_files', arguments: { path: '.', pattern } });
    assert.equal(result.ok, false, `${pattern} 不该被当成 glob 吞掉`);
    assert.equal(result.error?.code, 'MCP_INVALID_REGEX');
    const message = result.error?.message ?? '';
    assert.match(message, /JavaScript 正则/, `要说明 pattern 是 JS 正则不是 glob：${message}`);
    assert.match(message, /include/, `要给出「改用 include」这一步：${message}`);
  }
});

test('带正则元字符的写法即使编译不过也不猜成 glob', async () => {
  // `*foo` 是能被接住的 glob 字面量，但一旦混进 ( ) [ ] | ^ $ + \ 就只可能是写坏的正则，
  // 猜错会把「正则写错了」悄悄变成「筛文件名」，比直接报错更难排查。
  for (const pattern of ['*(foo', '*[a-z]*', '*|b']) {
    const result = await run('mcp_call', { server: fsId, tool: 'grep_files', arguments: { path: '.', pattern } });
    assert.equal(result.ok, false, `${pattern} 不该被当成 glob 吞掉`);
    assert.equal(result.error?.code, 'MCP_INVALID_REGEX');
  }
});

test('含通配符但本身是合法正则时，仍按内容检索而不是列文件', async () => {
  // `al.*a` 能编译，所以绝不能走 glob 分支——判定只在 new RegExp 失败后发生。
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: 'al.*a', include: 'Sample.java' },
  });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal((result.data as any).mode, undefined);
  assert.equal((result.data as any).matches.length, 1);
  assert.equal((result.data as any).matches[0].text, 'alpha');
});

test('glob 路径下 include 的语义与正则路径一致：无通配符时按文件名子串匹配', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: '*.java', include: 'Service', outputMode: 'files' },
  });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(
    (result.data as any).files.map((file: any) => file.relative),
    ['OrderService.java'],
    'include 不含通配符时应按子串匹配，不能退化成「必须整个文件名相等」',
  );
});

test('glob 路径尊重 maxMatches 上限并标记截断', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: '*.java', maxMatches: 2 },
  });
  assert.equal(result.ok, true, result.error?.message);
  const data = result.data as any;
  assert.equal(data.files.length, 2);
  assert.equal(data.truncated, true);
  assert.match(result.summary, /已截断/);
});

test('合法 JavaScript 正则的行为保持不变', async () => {
  const content = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: '@Table\\(name', include: '*.java' },
  });
  assert.equal(content.ok, true, content.error?.message);
  const matches = (content.data as any).matches;
  assert.equal(matches.length, 2);
  assert.equal(matches.find((match: any) => match.relative === 'OrderService.java').line, 3);

  const alternation = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: 'alpha|beta', include: '*.java' },
  });
  assert.equal(alternation.ok, true, alternation.error?.message);
  assert.equal((alternation.data as any).matches.length, 2);

  const fileMode = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: '.', pattern: '@Table', include: '*.java', outputMode: 'files' },
  });
  assert.equal(fileMode.ok, true, fileMode.error?.message);
  assert.equal((fileMode.data as any).mode, undefined, '正则路径不该被标记成 glob');
  assert.equal((fileMode.data as any).files.length, 2);
});
