import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@aidb/core';
import { createGateway } from '../src/server';
import { AgentHost, resolveTurnBudgetMs } from '../src/agentHost';
import { ToolExecutor } from '../src/executor';

// 事故背景：会话 ad4f8647 跑到 493 秒被 480 秒硬上限掐断，状态写 'aborted'、
// assistant 消息整条丢失，下一轮模型既不知道断在哪、也不知道还剩什么。
// 这个文件锁住三件事：超时能被认出来、超时留下可续跑的检查点、预算与步数自洽。

const home = mkdtempSync(join(tmpdir(), 'aidb-timeout-'));
for (const dir of ['demo', 'exports', 'imports', 'backups']) mkdirSync(join(home, dir), { recursive: true });
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'timeout-secret',
  token: 'timeout-token',
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
const executor = new ToolExecutor(gateway.store, gateway.manager, gateway.config, () => gateway.store.getSettings());

const stubs: Array<{ server: Server; close: () => Promise<void> }> = [];
after(async () => {
  for (const stub of stubs) await stub.close();
  await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

/**
 * 假模型：第一次请求正常返回一个 update_plan 工具调用，之后就一直挂着。
 *
 * 这正是事故里的时序——工具执行只要 0.7 秒，剩下的时间全在等模型往回吐字。
 * 挂住不返回才能让超时定时器成为唯一能结束回合的东西。
 */
async function hangingProvider(planItems: Array<{ text: string; status: string }>): Promise<{ baseUrl: string; started: Promise<void> }> {
  let calls = 0;
  let markHanging: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (markHanging = resolve));
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (calls === 1) {
        const delta = {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: 'call_plan', function: { name: 'update_plan', arguments: JSON.stringify({ items: planItems }) } }] },
              finish_reason: 'tool_use',
            },
          ],
        };
        res.write(`data: ${JSON.stringify(delta)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      markHanging();
      // 只发注释帧，永远不结束：模拟「模型正在慢慢生成」的那 462 秒
      res.write(': generating\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  stubs.push({
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, started };
}

function makeHost(turnBudgetMs?: (budget: { maxSteps: number; intentTimeoutMs?: number }) => number): AgentHost {
  return new AgentHost({
    store: gateway.store,
    manager: gateway.manager,
    executor,
    config: gateway.config,
    ...(turnBudgetMs ? { turnBudgetMs } : {}),
  });
}

async function useStubProvider(baseUrl: string): Promise<void> {
  const settings = gateway.store.getSettings();
  gateway.store.saveSettings({
    ...settings,
    agent: { ...settings.agent, provider: 'openai', baseUrl, model: 'stub-model', apiKey: undefined },
  });
}

const PLAN = [
  { text: '读取 backend 的 53 张表结构', status: 'done' },
  { text: '为每张表补表注释', status: 'doing' },
  { text: '为 741 个字段补列注释', status: 'todo' },
];

test('超时中止：reason 不再谎报「用户中止」，并落下可续跑的检查点消息', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  const host = makeHost(() => 1_200);
  const session = gateway.store.createSession({ title: '给 53 张表补注释' });
  const events: AgentEvent[] = [];

  await host.startTurn(session.id, { text: '根据 backend 补全每个表的注释，包括表字段注释' }, (event) => events.push(event));

  const abortedEvent = events.find((event) => event.type === 'aborted');
  assert.ok(abortedEvent && abortedEvent.type === 'aborted', '超时必须走 aborted 分支');
  assert.equal(abortedEvent.cause, 'timeout');
  assert.notEqual(abortedEvent.reason, '用户中止', '用户根本没点停止，不能这么写');

  const messages = gateway.store.listMessages(session.id);
  const checkpoint = messages.filter((message) => message.role === 'assistant').at(-1);
  assert.ok(checkpoint, '超时后必须留下 assistant 检查点，而不是整条丢失');
  // 检查点要能被下一轮模型直接读懂：做到哪、剩什么、下一步干什么
  assert.match(checkpoint.content, /继续/, '要明确告诉用户/模型这句还能接着做');
  assert.match(checkpoint.content, /时间预算/, '要解释时间是怎么耗尽的，否则用户以为是 bug');
  assert.match(checkpoint.content, /已跑 \d+ 步/, '要记下跑到第几步');
  assert.match(checkpoint.content, /为每张表补表注释/, '计划里正在做的那项要落库');
  assert.match(checkpoint.content, /为 741 个字段补列注释/, '剩余项要落库，才知道还剩什么');
  assert.match(checkpoint.content, /下一步/);
  assert.equal(gateway.store.getSession(session.id)?.status, 'aborted');
});

test('超时检查点会被回灌进下一轮的历史，模型能接着干而不是重来', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  const host = makeHost(() => 1_200);
  const session = gateway.store.createSession({ title: '续跑' });
  await host.startTurn(session.id, { text: '补注释' }, () => undefined);

  // 下一轮的历史构建逻辑与 startTurn 内一致：assistant 消息正文必须带着检查点
  const history = gateway.store.listMessages(session.id).filter((message) => message.role === 'assistant');
  assert.ok(history.length >= 1);
  assert.match(history.at(-1)!.content, /下一步/, '检查点必须进历史，否则「继续」等于从头再来');
});

test('用户手动中止：仍然保持原样，不写续跑检查点，也不改口说超时', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  const host = makeHost(() => 600_000);
  const session = gateway.store.createSession({ title: '手动停止' });
  const events: AgentEvent[] = [];

  const turn = host.startTurn(session.id, { text: '补注释' }, (event) => events.push(event));
  await stub.started; // 等模型进入「慢慢生成」阶段再中止
  host.abort(session.id);
  await turn;

  const abortedEvent = events.find((event) => event.type === 'aborted');
  assert.ok(abortedEvent && abortedEvent.type === 'aborted');
  assert.equal(abortedEvent.cause, 'user');
  assert.equal(abortedEvent.reason, '用户中止', '用户点的停止必须照实说');
  const messages = gateway.store.listMessages(session.id);
  assert.ok(
    messages.every((message) => message.role !== 'assistant' || !/时间预算/.test(message.content)),
    '用户主动停止不该被塞一条「超时检查点」',
  );
});

// ---------- 预算推导：时间预算必须与步数预算自洽 ----------
//
// 事故根因不是「8 分钟太短」而是「承诺 100 步、实给 30 步」：
// 实测每步约 15 秒，480 秒只够 32 步，于是时间抢在步数前面把回合截断。

test('默认 12 步时预算严格等于 480000，老用户感知不到任何变化', () => {
  assert.equal(resolveTurnBudgetMs({ maxSteps: 12, env: {} }), 480_000);
});

test('步数越多预算越长，100 步不会再被 8 分钟提前截断', () => {
  const budget = resolveTurnBudgetMs({ maxSteps: 100, env: {} });
  assert.ok(budget > 480_000, '100 步还给 8 分钟等于必然被截断');
  assert.equal(budget, 1_800_000, '上限封顶 30 分钟：再长用户就没有回合级反馈了');
  // 15 秒/步的实测速度下，预算必须撑得住它承诺的步数
  assert.ok(budget / 15_000 >= 100, `预算 ${budget}ms 撑不起 100 步`);
});

test('env 与命令意图的既有优先级不变', () => {
  assert.equal(resolveTurnBudgetMs({ maxSteps: 100, intentTimeoutMs: 600_000, env: { AIDB_AGENT_TURN_MS: '90000' } }), 90_000, 'env 最高');
  assert.equal(resolveTurnBudgetMs({ maxSteps: 100, intentTimeoutMs: 600_000, env: {} }), 600_000, '意图次之');
  assert.equal(resolveTurnBudgetMs({ maxSteps: 100, env: {} }), 1_800_000, '都没有才按步数推导');
});

test('时间预算永不低于 30 秒，避免把正常回合截成碎片', () => {
  assert.equal(resolveTurnBudgetMs({ maxSteps: 1, env: {} }), 480_000);
  assert.equal(resolveTurnBudgetMs({ maxSteps: 1, env: { AIDB_AGENT_TURN_MS: '1000' } }), 30_000);
});
