import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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

/** 回合 SSE 路由那一段源码：路由里的 cause 只能这样钉住。 */
const turnRouteSource = readFileSync(join(import.meta.dirname, '../src/routes.ts'), 'utf8');

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
  await withStallMs('3000', async () => {
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
  await withStallMs('3000', async () => {
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

// ---------- 停摆之外的两种「没跑完」：截断与空返回 ----------
//
// 检查点过去只为停摆而写，于是「模型把回复写到超出 max_tokens」这一档什么也没留下：
// 界面写着已完成，用户点继续时模型只看得到半截正文。现在三种原因共用同一手检查点，
// 但**必须各说各的话**——把截断写成「连接无响应」会把用户送去查网络，而问题在输出上限。

test('截断原因的检查点说「超出输出上限」，不含糊成连接无响应', () => {
  const text = buildResumeCheckpoint({
    plan: PLAN.map((item, index) => ({ id: `p${index + 1}`, text: item.text, status: item.status as 'done' | 'doing' | 'todo' })),
    steps: 9,
    toolCalls: 21,
    elapsedMs: 120_000,
    toolTrace: ['run_sql'],
    cause: 'truncated',
  });
  assert.match(text, /超出输出上限/);
  assert.doesNotMatch(text, /无响应/, '截断不是断线：写「无响应」会把用户送去查网络');
  assert.match(text, /回复「继续」可接着做/);
  assert.match(text, /已跑 9 步、21 次工具调用（共 2 分 0 秒）/);
  assert.match(text, /不是执行出错/, '要说清这不是模型的失败，已完成的部分仍算数');
  assert.match(text, /为每张表补表注释/, '计划状态与下一步照旧要写全');
});

test('空返回原因的检查点如实说「没有给出内容」', () => {
  const text = buildResumeCheckpoint({
    plan: [],
    steps: 1,
    toolCalls: 0,
    elapsedMs: 1_000,
    toolTrace: [],
    cause: 'empty',
  });
  assert.match(text, /没有给出内容/);
  assert.doesNotMatch(text, /无响应|超出输出上限/);
  // 没登记计划时必须教模型下一步先建计划，否则「继续」连落点都没有
  assert.match(text, /没有登记计划/);
  assert.match(text, /update_plan/);
});

test('省略 cause 时仍是停摆措辞：老调用方不会因为新字段改变文案', () => {
  const text = buildResumeCheckpoint({ plan: [], steps: 1, toolCalls: 0, elapsedMs: 1000, toolTrace: [] });
  assert.match(text, /连接无响应/);
});

test('界面连接断开（不是用户点停止）：也落检查点，并且说是连接中断', async () => {
  // 半开连接、客户端的 90 秒静默上限、用户关页面——runtime 眼里都只是 signal.aborted，
  // abortCause 一律 'user'。区别只在传输层，由 abort() 带 cause 补回来。
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  await withStallMs('600000', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '客户端断开' });
    const events: AgentEvent[] = [];

    const turn = host.startTurn(session.id, { text: '补注释' }, (event) => events.push(event));
    await stub.started;
    // 这一句就是 SSE 路由 res.on('close') 里做的事
    host.abort(session.id, 'disconnected');
    await turn;

    const abortedEvent = events.find((event) => event.type === 'aborted');
    assert.ok(abortedEvent && abortedEvent.type === 'aborted');
    // runtime 仍然只能报 user：它看见的就是一个被 abort 的 signal，不欠它传输层的信息
    assert.equal(abortedEvent.cause, 'user');

    const checkpoint = gateway.store.listMessages(session.id).filter((m) => m.role === 'assistant').at(-1);
    assert.ok(checkpoint, '断线必须留检查点：用户重开页面点「继续」时，模型不能只看半截正文');
    // 只查标题：正文里本来就要解释「客户端判定通道无响应后主动断开」，
    // 拿整篇 doesNotMatch(/无响应/) 会把这句正确的说明也判成错。
    const headline = checkpoint.content.split('\n')[0];
    assert.match(headline, /客户端连接中断/);
    assert.doesNotMatch(headline, /无响应/, '断线不是模型不回话，标题写错了会把人送去查模型');
    assert.match(checkpoint.content, /没有人点过停止/, '要给模型一句实话，否则它会以为用户不要了');
    assert.match(checkpoint.content, /为每张表补表注释/, '计划状态照旧要写全');
  });
});

test('SSE 连接关闭时按 disconnected 中止，而不是默认成用户停止', () => {
  // 路由那行只有一个 token 的差别，通不过任何行为测试：显式断言钉住。
  const closeHandler = /res\.on\('close', \(\) => \{[\s\S]{0,420}?host\.abort\(([\s\S]{0,60}?)\);/.exec(turnRouteSource);
  assert.ok(closeHandler, '找不到回合 SSE 的 close 处理');
  assert.match(closeHandler![1], /'disconnected'/, '连接被对端掐断时不能再走默认的「用户中止」');
});

test('用户点停止时不写检查点，即便随后连接也跟着关闭', async () => {
  // 两条中止会先后到达：先 POST /abort（cause 记为 user），随后流关闭再报一次 disconnected。
  // 只认第一次记录，否则用户明确喊停的回合也会被写成「可以继续」。
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  await withStallMs('600000', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '先停止后断线' });
    const turn = host.startTurn(session.id, { text: '补注释' }, () => undefined);
    await stub.started;
    host.abort(session.id); // 用户点的
    host.abort(session.id, 'disconnected'); // 流随后关闭，重复登记不该改口
    await turn;

    const assistant = gateway.store.listMessages(session.id).filter((m) => m.role === 'assistant');
    assert.ok(
      assistant.every((m) => !/继续」可接着做/.test(m.content)),
      '用户主动停止不该被塞续跑检查点，也不该被后来的断线登记改口',
    );
  });
});

// ---------- 检查点必须活过连接 ----------
//
// 「继续」过去只挂在客户端的 live 上，而 sendAgent 收尾时会用服务端历史替换掉 live。
// 于是回合正常结束那一刻提示就没了，关页面走掉的人回来时本地更是什么都没有——
// 服务端留了检查点，界面却已经没有地方挂「继续」。原因必须落在 agent_sessions 上。

test('写了检查点的回合把原因记在会话上，重开会话才给得出「继续」', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  await withStallMs('3000', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '跨连接续跑' });
    await host.startTurn(session.id, { text: '补注释' }, () => undefined);

    // getSession 走的是完整读路径（rowToSession），不是内存里的对象
    assert.equal(gateway.store.getSession(session.id)?.resume, 'stalled');
  });
});

test('下一回合开始时清空「可以继续」：旧提示不能一直挂着', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  await withStallMs('3000', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '清空旧提示' });
    await host.startTurn(session.id, { text: '补注释' }, () => undefined);
    assert.equal(gateway.store.getSession(session.id)?.resume, 'stalled');

    // 用户点了「继续」。新回合跑起来时先清空，跑完再按新结果重写。
    const cleared = gateway.store.updateSession(session.id, { status: 'running', resume: null });
    assert.equal(cleared.resume, undefined, 'null 必须真的写进库，undefined 在这套 patch 语义里是「本次不改」');
  });
});

test('用户点停止不写 resume：那不是「可以继续」，是用户自己喊的停', async () => {
  const stub = await hangingProvider(PLAN);
  await useStubProvider(stub.baseUrl);
  await withStallMs('600000', async () => {
    const host = makeHost();
    const session = gateway.store.createSession({ title: '手动停止不留提示' });
    const turn = host.startTurn(session.id, { text: '补注释' }, () => undefined);
    await stub.started;
    host.abort(session.id);
    await turn;
    assert.equal(gateway.store.getSession(session.id)?.resume, undefined);
  });
});

test('跑满步数也落检查点：界面说「可继续」时服务端必须有东西可续', () => {
  const text = buildResumeCheckpoint({
    plan: PLAN.map((item, index) => ({ id: `p${index + 1}`, text: item.text, status: item.status as 'done' | 'doing' | 'todo' })),
    steps: 12,
    toolCalls: 40,
    elapsedMs: 60_000,
    toolTrace: ['run_sql'],
    cause: 'max_steps',
  });
  assert.match(text, /跑满工具步数上限/);
  assert.doesNotMatch(text, /无响应|超出输出上限/, '跑满步数既不是断线也不是截断');
  assert.match(text, /批量写法/, '续跑要多绕几个回合，检查点就该教它合并');
  assert.match(text, /为每张表补表注释/);
});

test('分类那段确实把 max_steps 认成没做完，而不是留成 undefined', () => {
  // 整跑一遍回合要假模型 + 步数上限，而这个分支的错法只有一种：漏一条 stop。
  // 分类那段是 result 与 disconnected 的纯表达式，直接从源码里取出来当真代码跑，
  // 比对着源文件念一遍断言强——改坏了立刻红。
  const src = readFileSync(join(import.meta.dirname, '../src/agentHost.ts'), 'utf8');
  const head = 'const unfinished: AgentResumeCause | undefined =';
  const from = src.indexOf(head);
  assert.ok(from >= 0, '找不到续跑原因的分类表达式');
  const body = src.slice(from + head.length, src.indexOf(';\n', from)).trim();
  const classify = (result: any, disconnected: boolean): unknown => {
    const unfinished = eval(body);
    return unfinished;
  };
  assert.ok(body.startsWith('result.status'), '取出来的必须是那个三元表达式本体');
  assert.ok(body.length < 900, '截取的片段过长，说明分号定位跑偏了');
  const done = (stop: string) => ({ status: 'done', stop });
  assert.equal(classify({ status: 'aborted', abortCause: 'stalled' }, false), 'stalled');
  assert.equal(classify({ status: 'aborted', abortCause: 'user' }, true), 'disconnected');
  assert.equal(classify(done('max_output_tokens'), false), 'truncated');
  assert.equal(classify(done('empty_response'), false), 'empty');
  assert.equal(classify(done('max_steps'), false), 'max_steps', '界面给「继续」时服务端必须留了东西可续');
  // 反向也要钉住：说完了、以及用户自己喊的停，都不该留「可以继续」
  assert.equal(classify(done('end_turn'), false), undefined);
  assert.equal(classify({ status: 'aborted', abortCause: 'user' }, false), undefined);
});
