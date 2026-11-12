import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

/**
 * `loadSchema` 发出的 URL 形状。
 *
 * 起因是一条实测的 400：`GET /connections/<mysql>/schema?refresh=0`（不带 database），
 * 服务端只能回 `NO_DATABASE` —— MySQL 驱动没有库就没法查 information_schema。
 * 「没默认库」对 MySQL/PG 是**合法配置**（对象树本来就靠逐库 ?database= 展开），
 * 所以这不是数据问题，是调用方漏了参数；而漏参数在客户端里是**可达**的：
 * 只要 `state.connections` 里查不到这个 id，旧实现那个 `conn &&` 就短路掉整个
 * 逐库分支，`engineMeta` 又对未知引擎回落到 sqlite，于是直接裸拉 /schema。
 * 查不到 id 的正当路径有好几条（组件 effect 在 boot 之前挂载、恢复一条历史会话
 * 带回来的连接还没进列表）。
 *
 * 这些断言拿住的是：除文件库外，任何 /schema 请求都必须带 database。
 */

type Route = { status?: number; body?: unknown };
const installed = await (async () => {
  const calls: string[] = [];
  const routes = new Map<string, Route>();

  globalThis.location = { hash: '#token=t', pathname: '/', search: '' } as unknown as Location;
  globalThis.history = { replaceState() {} } as unknown as History;
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  } as unknown as Storage;
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  globalThis.fetch = (async (input: any) => {
    const path = String(input);
    calls.push(path);
    const route = routes.get(path) ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(route.body ?? { ok: true }), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const store = await import('../src/store');
  return { store, calls, routes };
})();

const { store, calls, routes } = installed;
const { useApp } = store;
const state = () => useApp.getState();

const MYSQL = { id: 'c-mysql', name: 'localhost3306', engine: 'mysql', database: undefined } as const;
const SQLITE = { id: 'c-lite', name: 'Demo', engine: 'sqlite', database: '/x/demo.sqlite' } as const;

const schemaCalls = () => calls.filter((path) => path.includes('/schema?'));
const bareSchemaCalls = () => schemaCalls().filter((path) => !path.includes('database='));
const errorToasts = () => state().toasts.filter((toast) => toast.kind === 'error');
const withDatabases = (list: string[]) =>
  routes.set('/api/connections/c-mysql/databases', { status: 200, body: { databases: list } });

beforeEach(() => {
  calls.length = 0;
  routes.clear();
  routes.set('/api/connections', { status: 200, body: { connections: [MYSQL, SQLITE] } });
  withDatabases(['shop', 'mysql']);
  useApp.setState({
    connections: [MYSQL, SQLITE] as any,
    schemas: {},
    loadedDatabases: {},
    schemaLoading: {},
    toasts: [],
  });
});

test('MySQL 无默认库：只取库名，绝不发不带 database 的 /schema', async () => {
  await state().loadSchema('c-mysql');
  assert.ok(calls.includes('/api/connections/c-mysql/databases'), '先取库名，把对象树搭起来');
  assert.deepEqual(bareSchemaCalls(), [], '裸拉只会换回 400 NO_DATABASE');
  // 多个库时一个都不预取（用户点哪个库才内省哪个）。这是既有语义，
  // 不能被「顺手修好」成展开全部库——那会让选中连接变成全库内省。
  assert.deepEqual(schemaCalls(), []);
  assert.deepEqual(
    (state().schemas['c-mysql'] ?? []).map((item) => item.name),
    ['shop', 'mysql'],
  );
});

test('MySQL 只有一个库时预取它，选中连接不至于只剩空壳', async () => {
  withDatabases(['only-db']);
  await state().loadSchema('c-mysql');
  assert.deepEqual(schemaCalls(), ['/api/connections/c-mysql/schema?refresh=0&database=only-db']);
});

test('连接不在本地列表时：补拉连接列表判引擎，不退回 sqlite 分支', async () => {
  useApp.setState({ connections: [] as any });
  await state().loadSchema('c-mysql');
  assert.ok(calls.includes('/api/connections'), '先补拉一次连接列表，而不是猜引擎');
  assert.ok(calls.includes('/api/connections/c-mysql/databases'), '认出是 MySQL 后走逐库路径');
  assert.deepEqual(bareSchemaCalls(), [], '这条就是那条 400 的形状，必须不再出现');
});

test('连接确实不存在：一个 /schema 都不发，也不弹错', async () => {
  useApp.setState({ connections: [] as any });
  routes.set('/api/connections', { status: 200, body: { connections: [] } });
  await state().loadSchema('c-gone');
  assert.deepEqual(schemaCalls(), [], '猜不出引擎就不发注定 400/404 的请求');
  assert.deepEqual(errorToasts(), [], '连接被删是用户自己刚做完的操作，不该报错');
});

test('文件库仍是裸拉：sqlite 只有唯一的 main，带 database 反而对不上', async () => {
  await state().loadSchema('c-lite');
  assert.deepEqual(schemaCalls(), ['/api/connections/c-lite/schema?refresh=0']);
});

test('连接配了默认库时预取那个库，不碰其它库', async () => {
  useApp.setState({ connections: [{ ...MYSQL, database: 'mysql' }] as any });
  await state().loadSchema('c-mysql');
  assert.deepEqual(schemaCalls(), ['/api/connections/c-mysql/schema?refresh=0&database=mysql']);
});
