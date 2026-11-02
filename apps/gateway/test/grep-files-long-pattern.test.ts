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
 * 真实事故：模型想在一批 Java 实体里找 20 个字段名，写了一个字面量交替：
 *
 *   answerOutline|answerContract|contractStatus|…|fullText|parseQuality
 *
 * 271 字符，被「正则过长（最多 200 字符）」直接拒绝。
 *
 * 这个上限的意图是防 ReDoS，但它是按「长度」一刀切，而长度并不等于危险：
 * `a|b|c|…` 这种纯字面量交替匹配是线性的，271 个字符和 27 个字符一样安全；
 * 真正危险的是 `(a+)+$`、`(.*){20}` 这类嵌套量词，它们可以很短。
 *
 * 这里锁的行为：
 *   1. 长但结构简单的 pattern 必须能跑（本次事故的形状）；
 *   2. 真正有回溯风险的结构仍然被拒，且错误要说清怎么改；
 *   3. 纯粹为了加长的垃圾仍然有上限，防止拿超长字符串打爆内存。
 */
const home = mkdtempSync(join(tmpdir(), 'aidb-grep-long-'));
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });

// 造一份带答案契约字段的实体，模仿 kbook 的真实形状。
writeFileSync(
  join(workspace, 'AiAnswer.java'),
  [
    'package com.kbook.entity;',
    '',
    'public class AiAnswer {',
    '  private String answerOutline;',
    '  private String answerContract;',
    '  private String contractStatus;',
    '  private String refusalReason;',
    '  private String citationJson;',
    '  private Integer maxOutputTokens;',
    '  private Boolean thinkingMode;',
    '  private String unrelatedField;',
    '}',
    '',
  ].join('\n'),
);
writeFileSync(join(workspace, 'Book.java'), 'package com.kbook.entity;\n\npublic class Book {\n  private String fullText;\n  private Integer parseQuality;\n}\n');

const TOKEN = 'grep-long-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'grep-long-secret',
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
  executor.execute({ id: `${name}-${Math.random()}`, name, args }, { sessionId: 'grep-long' });

after(async () => {
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

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

/** 事故里的原始 pattern（271 字符，20 个字段名交替）。 */
const LONG_ALTERNATION =
  'answerOutline|answerContract|contractStatus|refusalReason|superseded|citationJson|finishReason|private String sources|thinkingMode|reasoningEffort|returnThinking|sendThinking|maxOutputTokens|inputPrice|outputPrice|contentEmbeddingDim|contentEmbeddingModel|fullText|parseQuality';

test('长字面量交替（271 字符）不再被「正则过长」拒绝，且能查到内容', async () => {
  assert.ok(LONG_ALTERNATION.length > 200, `本测试的 pattern 必须超过旧上限，实际 ${LONG_ALTERNATION.length}`);

  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: workspace, pattern: LONG_ALTERNATION },
  });

  assert.equal(result.ok, true, `纯字面量交替应当能执行：${result.error?.message ?? ''}`);
  const matches = (result.data as any).matches as Array<{ text: string; relative: string }>;
  assert.ok(matches.length >= 5, `应当命中多个字段声明，实际 ${matches.length}`);

  const joined = matches.map((m) => m.text).join('\n');
  for (const field of ['answerOutline', 'contractStatus', 'maxOutputTokens', 'thinkingMode', 'fullText', 'parseQuality']) {
    assert.match(joined, new RegExp(field), `应当命中 ${field}`);
  }
  assert.doesNotMatch(joined, /unrelatedField/, '不相关的字段不该出现');
});

test('长交替加上 -B 上下文行仍可用（事故里还传了 -B 3）', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: workspace, pattern: LONG_ALTERNATION, '-B': 3 },
  });
  assert.equal(result.ok, true, result.error?.message ?? '');
  const matches = (result.data as any).matches as Array<{ before?: string[] }>;
  assert.ok(matches.length > 0, '应当命中');
  assert.ok(matches.some((m) => Array.isArray(m.before) && m.before.length > 0), '应带回上下文行');
});

test('灾难性回溯结构仍然被拒，且错误说明怎么改', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: workspace, pattern: '(a+)+$' },
  });
  assert.equal(result.ok, false, '嵌套量词必须被拒');
  const message = String(result.error?.message ?? '');
  assert.match(message, /回溯|ReDoS|嵌套|量词/, `错误要说明风险来源，实际：${message}`);
  assert.match(message, /建议|改用|拆/, `错误要给出可行出路，实际：${message}`);
});

test('超长 pattern 仍有硬上限，防止用超长字符串打爆内存', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: workspace, pattern: 'x'.repeat(20_001) },
  });
  assert.equal(result.ok, false, '超长 pattern 必须被拒');
  assert.equal(result.error?.code, 'MCP_INVALID_ARGS', `实际：${result.error?.code}`);
});

/* ------------------------------------------------------------------ *
 * 锁定测试：既有正则语义不能被放宽上限改坏。
 * ------------------------------------------------------------------ */

test('普通正则语义不变：分组、锚点、字符类照旧生效', async () => {
  const grouped = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: workspace, pattern: '@Table\\(name = "(orders|sample)"\\)' },
  });
  assert.equal(grouped.ok, true, grouped.error?.message ?? '');

  const anchored = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: workspace, pattern: '^\\s+private' },
  });
  assert.equal(anchored.ok, true, anchored.error?.message ?? '');
  assert.ok(((anchored.data as any).matches as unknown[]).length > 0, '锚点正则应当命中字段声明');
});

test('文件名 glob 回落逻辑不受影响（*.java 仍按文件名列出）', async () => {
  const result = await run('mcp_call', {
    server: fsId,
    tool: 'grep_files',
    arguments: { path: workspace, pattern: '*.java' },
  });
  assert.equal(result.ok, true, result.error?.message ?? '');
  const files = (result.data as any).files as Array<{ path: string }>;
  assert.ok(Array.isArray(files) && files.length >= 2, '应按文件名列出 .java');
});