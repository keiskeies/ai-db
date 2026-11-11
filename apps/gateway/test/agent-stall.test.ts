import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentRunInput } from '@aidb/core';
import { createGateway } from '../src/server';
import { AgentHost, buildResumeCheckpoint, type AgentHostOptions } from '../src/agentHost';
import { ToolExecutor } from '../src/executor';

// 事故背景有两起，方向相反：
// ① 会话 ad4f8647 跑到 493 秒被 480 秒硬上限掐断——健康长回合被时间截断。
//    修法不是放宽上限，而是取消回合级计时器：回合该不该结束取决于还有没有进展。
// ② 真卡死的连接必须结束，否则会话永远 running。这件事交给模型字节流那一层的停摆
//    阈值（providers/common.ts），它知道「连续无字节」和「生成得慢」的区别。
// 这个文件锁住：停摆能被认出来、留下可续跑的检查点、用户手动停止不写检查点、
// 以及最要紧的一条——时间不再参与任何中止判定。

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
 * 假模型：第一次请求正常返回一个 update_plan 工具调用，之后就一直挂着不回话。
 *
 * 挂住不返回才能让「连续无字节」成为唯一能结束回合的东西——回合级计时器已经不存在了，
 * 如果停摆看门狗也失效，这个用例就会一直挂着直到测试超时。
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

function makeHost(): AgentHost {
  return new AgentHost({
    store: gateway.store,
    manager: gateway.manager,
    executor,
    config: gateway.config,
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

/** 把停摆阈值压到毫秒级，让「连接死了」这条分支能在秒级测通。 */
async function withStallMs<T>(ms: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AIDB_PROVIDER_STALL_MS;
  process.env.AIDB_PROVIDER_STALL_MS = ms;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AIDB_PROVIDER_STALL_MS;
    else process.env.AIDB_PROVIDER_STALL_MS = previous;
  }
}

test('连接停摆：reason 不谎报「用户中止」，并落下可续跑的检查点消息', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  await withStallMs('400', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '给 53 张表补注释' });
    const events: AgentEvent[] = [];

    await host.startTurn(session.id, { text: '根据 backend 补全每个表的注释，包括表字段注释' }, (event) => events.push(event));

    const abortedEvent = events.find((event) => event.type === 'aborted');
    assert.ok(abortedEvent && abortedEvent.type === 'aborted', '停摆必须走 aborted 分支');
    assert.equal(abortedEvent.cause, 'stalled');
    assert.notEqual(abortedEvent.reason, '用户中止', '用户根本没点停止，不能这么写');

    const messages = gateway.store.listMessages(session.id);
    const checkpoint = messages.filter((message) => message.role === 'assistant').at(-1);
    assert.ok(checkpoint, '停摆后必须留下 assistant 检查点，而不是整条丢失');
    // 检查点要能被下一轮模型直接读懂：做到哪、剩什么、下一步干什么
    assert.match(checkpoint.content, /继续/, '要明确告诉用户/模型这句还能接着做');
    assert.match(checkpoint.content, /无响应/, '要解释为什么断，否则用户以为是 bug');
    assert.match(checkpoint.content, /已跑 \d+ 步/, '要记下跑到第几步');
    assert.match(checkpoint.content, /为每张表补表注释/, '计划里正在做的那项要落库');
    assert.match(checkpoint.content, /为 741 个字段补列注释/, '剩余项要落库，才知道还剩什么');
    assert.match(checkpoint.content, /下一步/);
    assert.equal(gateway.store.getSession(session.id)?.status, 'aborted');
  });
});

test('停摆检查点会被回灌进下一轮的历史，模型能接着干而不是重来', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  await withStallMs('400', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '续跑' });
    await host.startTurn(session.id, { text: '补注释' }, () => undefined);

    // 下一轮的历史构建逻辑与 startTurn 内一致：assistant 消息正文必须带着检查点
    const history = gateway.store.listMessages(session.id).filter((message) => message.role === 'assistant');
    assert.ok(history.length >= 1);
    assert.match(history.at(-1)!.content, /下一步/, '检查点必须进历史，否则「继续」等于从头再来');
  });
});

test('用户手动中止：仍然保持原样，不写续跑检查点，也不改口说无响应', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  // 阈值给足：这条用例要证明「是人停的，不是连接死的」
  await withStallMs('600000', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '手动停止' });
    const events: AgentEvent[] = [];

    const turn = host.startTurn(session.id, { text: '补注释' }, (event) => events.push(event));
    await stub.started; // 等模型进入「不回话」阶段再中止
    host.abort(session.id);
    await turn;

    const abortedEvent = events.find((event) => event.type === 'aborted');
    assert.ok(abortedEvent && abortedEvent.type === 'aborted');
    assert.equal(abortedEvent.cause, 'user');
    assert.equal(abortedEvent.reason, '用户中止', '用户点的停止必须照实说');
    const messages = gateway.store.listMessages(session.id);
    assert.ok(
      messages.every((message) => message.role !== 'assistant' || !/无响应/.test(message.content)),
      '用户主动停止不该被塞一条「停摆检查点」',
    );
  });
});

// ---------- 时间不再参与中止判定 ----------
//
// 事故根因不是「8 分钟太短」，而是拿总时长当结束条件：承诺 100 步却只给 8 分钟，
// 时间必然抢在步数前面把健康回合截断。现在整套时间预算（deriveTurnBudgetMs /
// resolveTurnBudgetMs / deadlineAt / [deadline reminder]）都不存在了，这几条把它们钉死。

/** 编译期断言：字段还在的话这里就通不过类型检查（false 不能赋给 true）。 */
type HasKey<T, K extends string> = K extends keyof T ? true : false;

test('回合时间预算这一整套 API 已经不存在', async () => {
  const hostModule = await import('../src/agentHost');
  assert.equal((hostModule as Record<string, unknown>).resolveTurnBudgetMs, undefined, '时间预算解析器必须删干净');
  assert.equal((hostModule as Record<string, unknown>).deriveTurnBudgetMs, undefined);

  // 输入与选项上的时间字段同样要删净：只要它们还在，agentHost 就还有地方塞截止时间。
  const noDeadline: HasKey<AgentRunInput, 'deadlineAt'> = false;
  const noTurnBudget: HasKey<AgentRunInput, 'turnBudgetMs'> = false;
  const noAbortCause: HasKey<AgentRunInput, 'abortCause'> = false;
  const noHostBudgetOption: HasKey<AgentHostOptions, 'turnBudgetMs'> = false;
  assert.deepEqual([noDeadline, noTurnBudget, noAbortCause, noHostBudgetOption], [false, false, false, false]);
});

test('检查点说「无响应」，不再提任何「时间预算耗尽」', () => {
  const text = buildResumeCheckpoint({
    plan: PLAN.map((item, index) => ({ id: `p${index + 1}`, text: item.text, status: item.status as 'done' | 'doing' | 'todo' })),
    steps: 12,
    toolCalls: 30,
    elapsedMs: 493_000,
    toolTrace: ['inspect_schema', 'inspect_schema', 'run_sql'],
  });
  assert.match(text, /无响应/);
  assert.match(text, /已跑 12 步/);
  assert.match(text, /inspect_schema ×2/, '工具去重计数仍然要有');
  assert.doesNotMatch(text, /时间预算|上限/, '回合没有上限，检查点不能暗示还有');
});
