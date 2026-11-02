import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES,
  applyCapabilityDefaults,
  assertCapabilities,
  fieldVisible,
  getCapability,
  isCallable,
  listCapabilities,
  validateCapabilityInput,
  TOOLS,
  type Capability,
} from '../src/index';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 造一个最小合法契约，测试里按需改坏某一条。 */
function baseCapability(): Capability {
  return {
    id: 'probe',
    title: { zh: '探针', en: 'Probe' },
    description: '测试用',
    whenToUse: '仅测试',
    flow: ['一步'],
    fields: [
      { key: 'connectionId', type: 'connection', label: { zh: '连接', en: 'Connection' }, required: true },
      {
        key: 'mode',
        type: 'enum',
        label: { zh: '模式', en: 'Mode' },
        default: 'append',
        options: [
          { value: 'append', label: { zh: '追加', en: 'Append' } },
          { value: 'replace', label: { zh: '替换', en: 'Replace' }, risk: 'destructive' },
        ],
      },
      { key: 'limit', type: 'number', label: { zh: '行数', en: 'Limit' }, min: 1, max: 100 },
      { key: 'dryRun', type: 'boolean', label: { zh: '预览', en: 'Dry run' }, default: false },
    ],
    states: [{ id: 'ok', label: { zh: '完成', en: 'Done' }, terminal: true, phrase: '完成 {message}' }],
    tools: [],
    maxRisk: 'write',
  };
}

const FAKE_TOOLS = [
  { name: 'transfer_data', risk: 'write' },
  { name: 'run_sql', risk: 'dynamic' },
  { name: 'drop_object', risk: 'destructive' },
  { name: 'search_objects', risk: 'read' },
];

// ---------- 契约自检 ----------

test('13 个内置契约全部通过自检', () => {
  assert.equal(CAPABILITIES.length, 13);
  assert.doesNotThrow(() => assertCapabilities(CAPABILITIES, TOOLS));
});

test('id 必须是 kebab-case 且不重复', () => {
  const bad = clone(baseCapability());
  bad.id = 'Bad_Id';
  assert.throws(() => assertCapabilities([bad], FAKE_TOOLS), /kebab-case/);

  const a = clone(baseCapability());
  const b = clone(baseCapability());
  assert.throws(() => assertCapabilities([a, b], FAKE_TOOLS), /id 重复/);
});

test('enum 字段必须给 options', () => {
  const capability = clone(baseCapability());
  delete capability.fields[1].options;
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /没有 options/);
});

test('code 字段必须有 language', () => {
  const capability = clone(baseCapability());
  capability.fields.push({ key: 'script', type: 'code', label: { zh: '脚本', en: 'Script' } });
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /没有 language/);
});

test('default 类型不匹配要报错', () => {
  const capability = clone(baseCapability());
  capability.fields[2].default = 'ten';
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /default 与 type 不匹配/);

  const enumDefault = clone(baseCapability());
  enumDefault.fields[1].default = 'nope';
  assert.throws(() => assertCapabilities([enumDefault], FAKE_TOOLS), /default 与 type 不匹配/);
});

test('min > max 要报错', () => {
  const capability = clone(baseCapability());
  capability.fields[2].min = 10;
  capability.fields[2].max = 1;
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /min > max/);
});

test('showWhen 指向不存在的字段要报错', () => {
  const capability = clone(baseCapability());
  capability.fields[3].showWhen = { field: 'ghost', equals: true };
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /showWhen 指向不存在的字段/);
});

test('tools 声明了不存在的工具要报错（防漂移）', () => {
  const capability = clone(baseCapability());
  capability.tools = ['not_a_tool'];
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /不存在的工具：not_a_tool/);
});

test('tools 的风险高于 maxRisk 要报错（防低估风险）', () => {
  const capability = clone(baseCapability());
  capability.maxRisk = 'read';
  capability.tools = ['transfer_data'];
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /低于工具 transfer_data 的风险/);
});

test('dynamic 工具不受 maxRisk 限制（运行时再分类）', () => {
  const capability = clone(baseCapability());
  capability.maxRisk = 'read';
  capability.tools = ['run_sql'];
  assert.doesNotThrow(() => assertCapabilities([capability], FAKE_TOOLS));
});

test('states 必须有终态', () => {
  const capability = clone(baseCapability());
  capability.states = [{ id: 'running', label: { zh: '进行中', en: 'Running' }, phrase: '运行中' }];
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /没有任何终态/);
});

test('phrase 占位符必须是字段或约定结果 token', () => {
  const capability = clone(baseCapability());
  capability.states[0].phrase = '完成 {ghostToken}';
  assert.throws(() => assertCapabilities([capability], FAKE_TOOLS), /既不是字段也不是约定的结果 token/);

  const ok = clone(baseCapability());
  ok.states[0].phrase = '完成 {message}，共 {count} 项';
  assert.doesNotThrow(() => assertCapabilities([ok], FAKE_TOOLS));
});

test('route 重复要报错', () => {
  const a = clone(baseCapability());
  const b = clone(baseCapability());
  b.id = 'probe-two';
  a.route = { method: 'POST', path: '/probe' };
  b.route = { method: 'POST', path: '/probe' };
  assert.throws(() => assertCapabilities([a, b], FAKE_TOOLS), /路由重复/);
});

// ---------- 注册表 ----------

test('getCapability / listCapabilities', () => {
  assert.equal(getCapability('transfer')?.title.zh, '数据传输');
  assert.equal(getCapability('nope'), undefined);
  const list = listCapabilities();
  assert.equal(list.length, 13);
  assert.deepEqual(list.map((item) => item.id), CAPABILITIES.map((item) => item.id));
});

test('isCallable 反映 tools 是否为空', () => {
  assert.equal(isCallable(getCapability('transfer')!), true);
  assert.equal(isCallable(getCapability('jobs')!), false);
});

test('13 个契约的 route.path 互不重复', () => {
  const paths = CAPABILITIES.map((item) => item.route?.path).filter(Boolean);
  assert.equal(new Set(paths).size, paths.length);
});

// ---------- 入参校验 ----------

test('必填缺失报错且带字段名', () => {
  const result = validateCapabilityInput(baseCapability(), {});
  assert.equal(result.ok, false);
  assert.equal(result.errors?.[0].field, 'connectionId');
});

test('默认值被填充', () => {
  const result = validateCapabilityInput(baseCapability(), { connectionId: 'c1' });
  assert.equal(result.ok, true);
  assert.equal(result.value?.mode, 'append');
  assert.equal(result.value?.dryRun, false);
});

test('枚举越界报错', () => {
  const result = validateCapabilityInput(baseCapability(), { connectionId: 'c1', mode: 'merge' });
  assert.equal(result.ok, false);
  assert.match(result.errors?.[0].message ?? '', /只能是/);
});

test('数字超上限 / 低于下限报错', () => {
  const high = validateCapabilityInput(baseCapability(), { connectionId: 'c1', limit: 500 });
  assert.equal(high.ok, false);
  assert.match(high.errors?.[0].message ?? '', /不能大于 100/);

  const low = validateCapabilityInput(baseCapability(), { connectionId: 'c1', limit: 0 });
  assert.equal(low.ok, false);
  assert.match(low.errors?.[0].message ?? '', /不能小于 1/);
});

test('字符串数字会被归一化成 number', () => {
  const result = validateCapabilityInput(baseCapability(), { connectionId: 'c1', limit: '42' });
  assert.equal(result.ok, true);
  assert.equal(result.value?.limit, 42);
});

test('未声明的字段被忽略（保持旧调用方兼容）', () => {
  const result = validateCapabilityInput(baseCapability(), { connectionId: 'c1', extra: 'x' });
  assert.equal(result.ok, true);
  assert.equal('extra' in (result.value ?? {}), false);
});

test('showWhen 未满足时既不校验也不填默认值', () => {
  const capability = clone(baseCapability());
  capability.fields[1].showWhen = { field: 'dryRun', equals: true };
  const hidden = validateCapabilityInput(capability, { connectionId: 'c1' });
  assert.equal(hidden.ok, true);
  assert.equal('mode' in (hidden.value ?? {}), false, '隐藏字段不应被填默认值');

  const shown = validateCapabilityInput(capability, { connectionId: 'c1', dryRun: true });
  assert.equal(shown.value?.mode, 'append');
});

test('fieldVisible 与 showWhen 一致', () => {
  const field = { key: 'sql', type: 'code' as const, language: 'sql', label: { zh: 'SQL', en: 'SQL' }, showWhen: { field: 'type', equals: 'query' } };
  assert.equal(fieldVisible(field, { type: 'query' }), true);
  assert.equal(fieldVisible(field, { type: 'backup' }), false);
});

test('body 不是对象时直接失败', () => {
  for (const bad of [null, undefined, [], 'x', 1]) {
    const result = validateCapabilityInput(baseCapability(), bad);
    assert.equal(result.ok, false);
  }
});

test('tables 字段必须是字符串数组', () => {
  const capability = clone(baseCapability());
  capability.fields.push({ key: 'tables', type: 'tables', label: { zh: '表', en: 'Tables' } });
  assert.equal(validateCapabilityInput(capability, { connectionId: 'c1', tables: ['a'] }).ok, true);
  assert.equal(validateCapabilityInput(capability, { connectionId: 'c1', tables: [1] }).ok, false);
});

// ---------- 契约与真实工具的联动 ----------

test('transfer 契约声明的 transfer_data 存在且风险匹配', () => {
  const transfer = getCapability('transfer')!;
  assert.deepEqual(transfer.tools, ['transfer_data']);
  assert.equal(transfer.maxRisk, 'write');
});

test('无工具的功能在契约里显式声明 tools: []', () => {
  for (const id of ['jobs', 'monitor', 'users', 'dictionary', 'advanced-objects', 'compare-data', 'query-builder', 'agent-context']) {
    const capability = getCapability(id);
    assert.ok(capability, `缺少契约：${id}`);
    assert.deepEqual(capability!.tools, [], `${id} 应当声明 tools: []`);
  }
});

// ---------- 默认值与 showWhen 的一致性（渲染契约 #1）----------

test('applyCapabilityDefaults 不修改入参', () => {
  const input = { connectionId: 'c1' };
  const output = applyCapabilityDefaults(getCapability('jobs')!, input);
  assert.deepEqual(input, { connectionId: 'c1' }, '入参不应被修改');
  assert.equal(output.type, 'query');
  assert.equal(output.intervalSeconds, 3600);
  assert.equal(output.enabled, true);
});

test('applyCapabilityDefaults 保留调用方已给的值', () => {
  const output = applyCapabilityDefaults(getCapability('jobs')!, { type: 'backup', intervalSeconds: 60 });
  assert.equal(output.type, 'backup');
  assert.equal(output.intervalSeconds, 60);
});

test('applyCapabilityDefaults 对无默认值的契约安全', () => {
  const output = applyCapabilityDefaults(baseCapability());
  assert.deepEqual(output, { mode: 'append', dryRun: false });
});

test('补过默认值后，showWhen 依赖默认值的字段才会显示（渲染契约 #1 的核心）', () => {
  const jobs = getCapability('jobs')!;
  const sql = jobs.fields.find((field) => field.key === 'sql')!;
  // 未补默认值：type 缺失 → sql 被判为隐藏，但服务端仍要求必填（错位）
  assert.equal(fieldVisible(sql, {}), false);
  // 补过默认值：type = 'query' → sql 显示，与服务端一致
  assert.equal(fieldVisible(sql, applyCapabilityDefaults(jobs)), true);
});

test('渲染器的可见性判断与服务端校验对同一份取值给出一致结论', () => {
  const jobs = getCapability('jobs')!;
  const seeded = applyCapabilityDefaults(jobs, { name: 'x', connectionId: 'c1' });
  const sql = jobs.fields.find((field) => field.key === 'sql')!;
  // 服务端认为 sql 可见且必填
  const missingSql = validateCapabilityInput(jobs, seeded);
  assert.equal(missingSql.ok, false);
  assert.equal(missingSql.errors?.[0].field, 'sql');
  // 渲染器也认为 sql 可见（否则用户看不到输入框却收到必填报错）
  assert.equal(fieldVisible(sql, seeded), true);
});
