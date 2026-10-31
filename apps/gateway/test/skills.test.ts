import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';
import { createGateway } from '../src/server';
import { SkillStore } from '../src/skills';
import { SkillRunner } from '../src/skillRunner';
import { SkillWorker } from '../src/skillWorker';
import { ToolExecutor } from '../src/executor';
import { listenRandom } from './helpers';

const home = mkdtempSync(join(tmpdir(), 'aidb-skills-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const skillDir = join(home, 'fixture-skill');
mkdirSync(join(skillDir, 'references'), { recursive: true });
mkdirSync(join(skillDir, 'scripts'), { recursive: true });
writeFileSync(
  join(skillDir, 'SKILL.md'),
  `---\nname: Demo Skill\ndescription: A demo skill for tests\nmetadata:\n  version: "1.2.3"\n  license: MIT\n---\n# Demo\n\nRead references/guide.md when needed.\n`,
);
writeFileSync(join(skillDir, 'references', 'guide.md'), '# Guide\n\nUse the demo workflow.\n');
writeFileSync(join(skillDir, 'references', 'large.md'), 'A'.repeat(2500));
writeFileSync(join(skillDir, 'scripts', 'hello.py'), 'print("hello")\n');
writeFileSync(join(skillDir, 'scripts', 'run.cjs'), "const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(process.env.SKILL_OUTPUT_DIR, 'result.txt'), 'ok'); console.log('done');\n");
writeFileSync(join(skillDir, 'scripts', 'slow.cjs'), "setTimeout(() => console.log('late'), 5000);\n");
writeFileSync(join(skillDir, 'scripts', 'secret.cjs'), "const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(path.join(process.env.SKILL_OUTPUT_DIR,'secret.txt'),process.env.DEMO_TOKEN||'');\n");
writeFileSync(
  join(skillDir, 'scripts', 'project.cjs'),
  "const fs=require('node:fs');const path=require('node:path');const dir=path.join(process.argv[2],'deck_20260101');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'ok.txt'),'ok');console.log('[OK] Project initialized: '+dir);\n",
);
writeFileSync(
  join(skillDir, 'scripts', 'check.cjs'),
  "const fs=require('node:fs');const path=require('node:path');const dir=process.argv[2];if(!fs.existsSync(path.join(dir,'ok.txt'))){console.error('project missing');process.exit(2);}console.log('found '+dir);\n",
);
writeFileSync(
  join(skillDir, 'aidb.skill.json'),
  JSON.stringify({
    permissions: { fs: ['workspace', 'output'], process: ['node'], network: false, mcp: ['other', 'filesystem'] },
    secrets: ['DEMO_TOKEN'],
    entrypoints: [
      { id: 'make', command: ['${node}', '${skillDir}/scripts/run.cjs'], args: ['${workspace}', '${output}'], timeoutMs: 5000 },
      { id: 'slow', command: ['${node}', '${skillDir}/scripts/slow.cjs'], timeoutMs: 1000 },
      { id: 'secret', command: ['${node}', '${skillDir}/scripts/secret.cjs'], timeoutMs: 5000 },
      { id: 'project-init', command: ['${node}', '${skillDir}/scripts/project.cjs', '${workspace}/projects'], timeoutMs: 5000 },
      { id: 'check', command: ['${node}', '${skillDir}/scripts/check.cjs', '${project}'], timeoutMs: 5000 },
    ],
  }),
);
writeFileSync(join(home, 'secret.txt'), 'do not read');

const TOKEN = 'skills-token';
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'skills-secret',
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

after(async () => {
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

test('SkillStore 解析 frontmatter、读取文件并阻止路径越界', () => {
  const store = new SkillStore(home);
  const imported = store.importDirectory(skillDir, 'demo');
  assert.equal(imported.name, 'Demo Skill');
  assert.equal(imported.version, '1.2.3');
  assert.equal(imported.enabled, true);
  const detail = store.getSkill('demo');
  assert.ok(detail);
  assert.ok(detail.files.some((file) => file.path === 'references/guide.md'));
  const guide = store.readFile('demo', 'references/guide.md');
  assert.match(guide.content, /demo workflow/);
  const chunk = store.readFile('demo', 'references/large.md', 1000, 1000);
  assert.equal(chunk.content.length, 1000);
  assert.equal(chunk.offset, 1000);
  assert.equal(chunk.totalChars, 2500);
  assert.equal(chunk.nextOffset, 2000);
  assert.equal(chunk.truncated, true);
  const tail = store.readFile('demo', 'references/large.md', 1000, 2000);
  assert.equal(tail.content.length, 500);
  assert.equal(tail.truncated, false);
  assert.equal(tail.nextOffset, undefined);
  assert.throws(() => store.readFile('demo', '../../secret.txt'), /越界/);
  assert.match(store.catalog(), /demo: Demo Skill v1\.2\.3/);
  const disabled = store.setEnabled('demo', false);
  assert.equal(disabled.enabled, false);
  assert.equal(store.listSkills(false).filter((skill) => !skill.builtin).length, 0);
  store.setEnabled('demo', true);
});

test('zip 导入兼容单层目录并拒绝路径穿越', () => {
  const store = new SkillStore(home);
  const zip = new AdmZip();
  zip.addFile('pack/SKILL.md', Buffer.from('---\nname: Zip Skill\ndescription: from zip\n---\n# Zip\n'));
  zip.addFile('pack/references/a.md', Buffer.from('zip guide'));
  const result = store.importZip(zip.toBuffer(), 'zip-skill');
  assert.equal(result.name, 'Zip Skill');
  assert.match(store.readFile('zip-skill', 'references/a.md').content, /zip guide/);

  const evil = new AdmZip();
  evil.addFile('../escape.txt', Buffer.from('bad'));
  assert.throws(() => store.importZip(evil.toBuffer(), 'evil'));
  assert.equal(existsSync(join(home, 'escape.txt')), false);
});

test('Skills API 与 skill_list/skill_read 工具可用', async () => {
  const imported = await api('/skills/import', { method: 'POST', body: JSON.stringify({ path: skillDir, id: 'api-skill' }) });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const list = await api('/skills');
  assert.ok(list.body.skills.some((skill: any) => skill.id === 'api-skill'));
  const file = await api('/skills/api-skill/file?path=references/guide.md');
  assert.equal(file.status, 200);
  assert.match(file.body.content, /demo workflow/);
  const disabled = await api('/skills/api-skill/enable', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.body.skill.enabled, false);
  await api('/skills/api-skill/enable', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  const savedSecrets = await api('/skills/api-skill/secrets', { method: 'PUT', body: JSON.stringify({ secrets: { DEMO_TOKEN: 'api-secret' } }) });
  assert.equal(savedSecrets.status, 200, JSON.stringify(savedSecrets.body));
  assert.ok(savedSecrets.body.set.includes('DEMO_TOKEN'));
  const listedSecrets = await api('/skills/api-skill/secrets');
  assert.deepEqual(listedSecrets.body.declared, ['DEMO_TOKEN']);
  assert.equal(JSON.stringify(listedSecrets.body).includes('api-secret'), false);

  const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills);
  const tools = await executor.execute({ id: 'skill-list', name: 'skill_list', args: {} }, { sessionId: 'skills' });
  assert.equal(tools.ok, true, tools.error?.message);
  assert.ok((tools.data as any).skills.some((skill: any) => skill.id === 'api-skill'));
  const read = await executor.execute(
    { id: 'skill-read', name: 'skill_read', args: { skill: 'api-skill', path: 'references/guide.md' } },
    { sessionId: 'skills' },
  );
  assert.equal(read.ok, true, read.error?.message);
  assert.match((read.data as any).content, /demo workflow/);
});


test('Skill 沙箱：写入、运行、文件清单、超时与权限', async () => {
  const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills);
  const write = await executor.execute(
    { id: 'sw', name: 'skill_write', args: { skill: 'api-skill', area: 'workspace', path: 'notes/a.txt', content: 'hello sandbox' } },
    { sessionId: 'skills' },
  );
  assert.equal(write.ok, true, write.error?.message);
  const runId = (write.data as any).runId;
  const secondWrite = await executor.execute(
    { id: 'sw2', name: 'skill_write', args: { skill: 'api-skill', area: 'workspace', path: 'notes/b.txt', content: 'same run' } },
    { sessionId: 'skills' },
  );
  assert.equal(secondWrite.ok, true, secondWrite.error?.message);
  assert.equal((secondWrite.data as any).runId, runId);
  const files = await executor.execute({ id: 'sf', name: 'skill_list_files', args: { runId } }, { sessionId: 'skills' });
  assert.equal(files.ok, true);
  assert.ok((files.data as any).files.some((file: any) => file.area === 'workspace' && file.path === 'notes/a.txt'));

  const run = await executor.execute(
    { id: 'sr', name: 'skill_run', args: { skill: 'api-skill', entrypoint: 'make', runId } },
    { sessionId: 'skills' },
  );
  assert.equal(run.ok, true, run.error?.message);
  assert.equal((run.data as any).status, 'succeeded');
  const skillAudit = gateway.store.listAudit({ limit: 30 }).find((entry) => entry.tool === 'skill_run' && (entry.meta as any)?.runId === runId);
  assert.ok(skillAudit);
  assert.equal(skillAudit.status, 'ok');
  const runner = new SkillRunner(gateway.skills, home);
  assert.ok(runner.listFiles(runId).some((file) => file.area === 'output' && file.path === 'result.txt'));

  const timeout = await executor.execute(
    { id: 'st', name: 'skill_run', args: { skill: 'api-skill', entrypoint: 'slow' } },
    { sessionId: 'skills' },
  );
  assert.equal(timeout.ok, false);
  assert.equal((timeout.data as any).status, 'timed_out');

  const escape = await executor.execute(
    { id: 'se', name: 'skill_write', args: { skill: 'api-skill', path: '../escape.txt', content: 'bad' } },
    { sessionId: 'skills' },
  );
  assert.equal(escape.ok, false);

  gateway.store.setSkillSecret('api-skill', 'DEMO_TOKEN', 's3cret');
  const secretRunner = new SkillRunner(gateway.skills, home, (id, names) => gateway.store.getSkillSecrets(id, names));
  const secretRun = await secretRunner.run(runId, 'secret');
  assert.equal(secretRun.status, 'succeeded', secretRun.stderr);
  assert.equal(readFileSync(join(secretRun.workspace, 'output', 'secret.txt'), 'utf8'), 's3cret');
});


test('project-init 将项目固定在 workspace 并解析 ${project}', async () => {
  const runner = new SkillRunner(gateway.skills, home);
  const run = runner.createRun('api-skill');
  const init = await runner.run(run.id, 'project-init');
  assert.equal(init.status, 'succeeded', init.stderr);
  assert.ok(init.project);
  assert.ok(init.project!.startsWith(join(run.workspace, 'workspace', 'projects')));
  assert.ok(existsSync(join(init.project!, 'ok.txt')));
  const check = await runner.run(run.id, 'check');
  assert.equal(check.status, 'succeeded', check.stderr);
  assert.match(check.stdout ?? '', /found /);
  const unresolved = runner.createRun('api-skill');
  await assert.rejects(() => runner.run(unresolved.id, 'check'), /project-init/);
});

test('Skill Worker 使用独立上下文和技能工具白名单', async () => {
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, agent: { ...settings.agent, provider: 'openai', model: 'fake-skill-model', apiKey: 'fake' } });
  let calls = 0;
  const provider: any = {
    id: 'fake',
    label: 'Fake',
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', call: { id: 'tc1', name: 'skill_run', args: { skill: 'api-skill', entrypoint: 'make' } } };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', text: 'skill done' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const worker = new SkillWorker(gateway.store, gateway.skills, new SkillRunner(gateway.skills, home), gateway.store ? new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills) : undefined as any, () => provider);
  const started = worker.start('api-skill', 'build the demo output');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (worker.get(started.runId)?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = worker.get(started.runId)!;
  assert.equal(state.status, 'succeeded', state.error);
  assert.ok(state.events.some((event) => event.type === 'tool_call' && event.tool === 'skill_run'));
  assert.ok(state.events.some((event) => event.type === 'tool_result' && event.tool === 'skill_run' && event.result.ok));
  assert.match(state.text, /skill done/);
});

test('Skill Worker 支持阻塞提问、取消与产物事件', async () => {
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, agent: { ...settings.agent, provider: 'openai', model: 'fake-skill-model', apiKey: 'fake' } });
  let calls = 0;
  const provider: any = {
    id: 'fake',
    label: 'Fake',
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', call: { id: 'ask1', name: 'skill_ask', args: { question: 'How many pages?', options: ['3', '5'] } } };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', text: 'finished after answer' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const worker = new SkillWorker(
    gateway.store,
    gateway.skills,
    new SkillRunner(gateway.skills, home),
    new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills),
    () => provider,
  );
  const started = worker.start('api-skill', 'ask the user');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (worker.get(started.runId)?.events.some((event) => event.type === 'skill_question')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = worker.get(started.runId)!;
  const question = state.events.find((event) => event.type === 'skill_question');
  assert.ok(question);
  assert.equal(question.type, 'skill_question');
  if (question.type !== 'skill_question') return;
  assert.equal(question.question, 'How many pages?');
  assert.equal(worker.answer(started.runId, question.id, '3'), true);
  while (Date.now() < deadline) {
    if (worker.get(started.runId)?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(state.status, 'succeeded', state.error);
  assert.match(state.text, /finished after answer/);
  assert.ok(state.events.some((event) => event.type === 'skill_answer' && event.answer === '3'));
  assert.ok(state.events.some((event) => event.type === 'skill_artifact' && Boolean(event.workspace)));

  let askAgain = 0;
  const askingProvider: any = {
    id: 'fake',
    label: 'Fake',
    async *stream() {
      askAgain++;
      yield { type: 'tool_call', call: { id: `ask-${askAgain}`, name: 'skill_ask', args: { question: 'Continue?' } } };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  const cancelWorker = new SkillWorker(
    gateway.store,
    gateway.skills,
    new SkillRunner(gateway.skills, home),
    new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills),
    () => askingProvider,
  );
  const pending = cancelWorker.start('api-skill', 'wait for user');
  const cancelDeadline = Date.now() + 10000;
  while (Date.now() < cancelDeadline) {
    if (cancelWorker.get(pending.runId)?.events.some((event) => event.type === 'skill_question')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(cancelWorker.cancel(pending.runId), true);
  while (Date.now() < cancelDeadline) {
    if (cancelWorker.get(pending.runId)?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.notEqual(cancelWorker.get(pending.runId)?.status, 'running');
});

test('主 Agent 可通过 skill_worker_run 取得最终答复与产物', async () => {
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, agent: { ...settings.agent, provider: 'openai', model: 'fake-skill-model', apiKey: 'fake' } });
  let calls = 0;
  const provider: any = {
    id: 'fake',
    label: 'Fake',
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', call: { id: 'make', name: 'skill_run', args: { skill: 'api-skill', entrypoint: 'make' } } };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', text: 'worker result for main agent' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills);
  const worker = new SkillWorker(gateway.store, gateway.skills, new SkillRunner(gateway.skills, home), executor, () => provider);
  executor.setSkillWorker(worker);
  const result = await executor.execute(
    { id: 'swr', name: 'skill_worker_run', args: { skill: 'api-skill', prompt: 'produce output', timeoutSeconds: 30 } },
    { sessionId: 'main-agent' },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.match(String((result.data as any).text), /worker result for main agent/);
  assert.ok((result.data as any).outputs.some((file: any) => file.type === 'file' && file.path === 'result.txt'));
});

test('Git/npm 导入只接受合法来源', async () => {
  const store = new SkillStore(home);
  await assert.rejects(() => store.importGit('file:///tmp/skill'), /只支持/);
  await assert.rejects(() => store.importGit('C:\skills\repo'), /只支持/);
  await assert.rejects(() => store.importGit('https://example.com/repo.git', 'x', { ref: '--upload-pack=evil' }), /非法分支/);
  await assert.rejects(() => store.importNpm('../skill'), /非法 npm 包名/);
  await assert.rejects(() => store.importNpm('https://example.com/skill.tgz'), /非法 npm 包名/);
});

test('Skill Worker 拒绝未授权的 MCP Server', async () => {
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, agent: { ...settings.agent, provider: 'openai', model: 'fake-skill-model', apiKey: 'fake' } });
  let calls = 0;
  const provider: any = {
    id: 'fake',
    label: 'Fake',
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', call: { id: 'm1', name: 'mcp_list_tools', args: { server: 'mock' } } };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', text: 'mcp denied' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const worker = new SkillWorker(
    gateway.store,
    gateway.skills,
    new SkillRunner(gateway.skills, home),
    new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills),
    () => provider,
  );
  const started = worker.start('api-skill', 'try mcp');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (worker.get(started.runId)?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = worker.get(started.runId)!;
  assert.equal(state.status, 'succeeded', state.error);
  assert.ok(state.events.some((event) => event.type === 'tool_result' && event.tool === 'mcp_list_tools' && !event.result.ok && event.result.error?.code === 'SKILL_MCP_DENIED'));
});


test('Skill Worker 不执行破坏性 MCP 工具', async () => {
  if (!gateway.skills.getSkill('api-skill')) {
    await api('/skills/import', { method: 'POST', body: JSON.stringify({ path: skillDir, id: 'api-skill' }) });
  }
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({ ...settings, agent: { ...settings.agent, provider: 'openai', model: 'fake-skill-model', apiKey: 'fake' } });
  let calls = 0;
  const provider: any = {
    id: 'fake',
    label: 'Fake',
    async *stream() {
      calls++;
      if (calls === 1) {
        yield {
          type: 'tool_call',
          call: {
            id: 'd1',
            name: 'mcp_call',
            args: { server: 'filesystem', tool: 'delete_file', arguments: { path: 'C:/server/kbook/backend/delete-me.txt', confirm: 'delete-me.txt' } },
          },
        };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', text: 'destroy blocked' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const worker = new SkillWorker(
    gateway.store,
    gateway.skills,
    new SkillRunner(gateway.skills, home),
    new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills),
    () => provider,
  );
  const started = worker.start('api-skill', 'try delete');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (worker.get(started.runId)?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = worker.get(started.runId)!;
  assert.equal(state.status, 'succeeded', state.error);
  assert.ok(
    state.events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.tool === 'mcp_call' &&
        !event.result.ok &&
        event.result.error?.code === 'SKILL_MCP_DESTRUCTIVE_DENIED',
    ),
  );
});

test('Skill 升级保留旧版本备份且新版本生效', () => {
  const store = new SkillStore(home);
  const v1 = join(home, 'upgrade-v1');
  const v2 = join(home, 'upgrade-v2');
  mkdirSync(v1, { recursive: true });
  mkdirSync(v2, { recursive: true });
  writeFileSync(join(v1, 'SKILL.md'), `---
name: Upgrade
description: v1
---
# v1
`);
  writeFileSync(join(v2, 'SKILL.md'), `---
name: Upgrade
description: v2
---
# v2
`);
  store.importDirectory(v1, 'upgrade');
  store.importDirectory(v2, 'upgrade');
  assert.match(store.readFile('upgrade').content, /# v2/);
  const backups = readdirSync(store.root).filter((entry) => entry.startsWith('.backup-upgrade-'));
  assert.equal(backups.length, 1);
  assert.match(readFileSync(join(store.root, backups[0], 'SKILL.md'), 'utf8'), /# v1/);
});

test('缺少 frontmatter name/description 的目录被拒绝', () => {
  const bad = join(home, 'bad-skill');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'SKILL.md'), '---\nname: No Description\n---\n# bad\n');
  const store = new SkillStore(home);
  assert.throws(() => store.importDirectory(bad, 'bad'), /name 和 description/);
});

test('能力开关阻止 Skill、MCP 与 AI PPT', async () => {
  const before = gateway.store.getSettings();
  gateway.store.saveSettings({ ...before, features: { ...before.features, skills: false, mcp: false, reportDeck: false } });
  try {
    const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings(), gateway.skills);
    const skill = await executor.execute({ id: 'feat1', name: 'skill_list', args: {} }, { sessionId: 'features' });
    assert.equal(skill.ok, false);
    assert.equal(skill.error?.code, 'FEATURE_DISABLED');
    const mcp = await executor.execute({ id: 'feat2', name: 'mcp_list_tools', args: { server: 'mock' } }, { sessionId: 'features' });
    assert.equal(mcp.ok, false);
    assert.equal(mcp.error?.code, 'FEATURE_DISABLED');
    const deck = await api('/artifacts/missing/deck', { method: 'POST', body: JSON.stringify({ mode: 'deterministic' }) });
    assert.equal(deck.status, 403);
    assert.equal(deck.body.error?.code, 'FEATURE_DISABLED');
    const worker = new SkillWorker(gateway.store, gateway.skills, new SkillRunner(gateway.skills, home), executor);
    const manual = worker.start('api-skill', 'manual run is still allowed');
    assert.ok(manual.runId);
    worker.cancel(manual.runId);
  } finally {
    gateway.store.saveSettings(before);
  }
});

test('内置技能首次写入，用户卸载后不会复活', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-builtins-'));
  try {
    const store = new SkillStore(dir);
    store.seedBuiltins();
    const builtins = store.listSkills(true).filter((skill) => skill.builtin);
    assert.ok(builtins.length >= 3);
    assert.ok(builtins.some((skill) => skill.id === 'aidb-report'));
    assert.ok(store.readFile('aidb-report').content.length > 0);
    store.deleteSkill('aidb-report');
    store.seedBuiltins();
    assert.equal(store.getSkill('aidb-report'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
