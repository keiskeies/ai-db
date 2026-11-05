import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_TEMPLATES,
  applyMapRule,
  applyPipelineTemplate,
  checkExpression,
  checkJsonPath,
  isPipelineStepType,
  mapRuleFromValues,
  columnsOf,
  defaultPipelineStep,
  describePipelineLanguage,
  evaluateExpression,
  firstJsonPath,
  newPipelineSpec,
  queryJsonPath,
  resolveBinding,
  validatePipelineSpec,
} from '../src/index';

const rows = [
  { id: 1, name: '苹果', price: 6.5, qty: 4, status: 'paid', created_at: '2026-11-01 09:00:00', attrs: { sku: 'A-1', tags: ['fruit', 'red'] } },
  { id: 2, name: '香蕉', price: 3, qty: 10, status: 'new', created_at: '2026-11-02 09:00:00', attrs: { sku: 'B-2', tags: ['fruit'] } },
  { id: 3, name: '牛奶', price: 12, qty: 2, status: 'paid', created_at: '2026-11-03 09:00:00', attrs: { sku: 'C-3', tags: ['drink'] } },
  { id: 4, name: null, price: 0, qty: 0, status: 'cancelled', created_at: '2026-11-03 10:00:00', attrs: { sku: 'D-4', tags: [] } },
];

const scope = { current: null as unknown, root: {} as Record<string, unknown> };
const row = (value: unknown) => ({ current: value, root: value as Record<string, unknown> });

// ---------- 表达式 ----------

test('expression: 算术、比较与逻辑', () => {
  assert.equal(evaluateExpression('6.5 * 4', scope), 26);
  assert.equal(evaluateExpression('1 + 2 * 3', scope), 7);
  assert.equal(evaluateExpression('(1 + 2) * 3', scope), 9);
  assert.equal(evaluateExpression('10 / 0', scope), null);
  assert.equal(evaluateExpression('true && false', scope), false);
  assert.equal(evaluateExpression('null ?? 7', scope), 7);
  assert.equal(evaluateExpression('@.price * @.qty', row(rows[0])), 26);
  assert.equal(evaluateExpression('price > 5', row(rows[0])), true);
  assert.equal(evaluateExpression("@.status in ('paid','new')", row(rows[1])), true);
  assert.equal(evaluateExpression("@.status in ('paid',)", row(rows[1])), false);
  assert.deepEqual(evaluateExpression('(1, 2, 3)', scope), [1, 2, 3]);
  assert.deepEqual(evaluateExpression('[1, 2,]', scope), [1, 2]);
  assert.equal(evaluateExpression("@.status == 'paid' ? 1 : 0", row(rows[3])), 0);
});

test('expression: 字符串与集合函数', () => {
  assert.equal(evaluateExpression("upper('abc')", scope), 'ABC');
  assert.equal(evaluateExpression("concat('a', '-', 1)", scope), 'a-1');
  assert.equal(evaluateExpression("length(@.attrs.tags)", row(rows[0])), 2);
  assert.equal(evaluateExpression("join(@.attrs.tags, '+')", row(rows[0])), 'fruit+red');
  assert.deepEqual(evaluateExpression("split('a,b,c', ',')", scope), ['a', 'b', 'c']);
  assert.deepEqual(evaluateExpression('pick(@, "id,name")', row(rows[0])), { id: 1, name: '苹果' });
  assert.deepEqual((evaluateExpression('omit(@, "attrs")', row(rows[0])) as { name?: unknown }).name, '苹果');
  assert.equal(evaluateExpression('max(sum(@.price, @.qty), 100)', row(rows[0])), 100);
});

test('expression: 类型转换与空值容错', () => {
  assert.equal(evaluateExpression("number('12.5')", scope), 12.5);
  assert.equal(evaluateExpression("number('abc')", scope), null);
  assert.equal(evaluateExpression('coalesce(@.missing, 5)', row(rows[0])), 5);
  assert.equal(evaluateExpression('string(1e3)', scope), '1000');
  assert.equal(evaluateExpression("date_part('2026-11-03 09:00:00', 'month')", scope), 11);
  assert.equal(evaluateExpression("days_between('2026-11-01', '2026-11-04')", scope), 3);
});

test('expression: 拒绝赋值、循环、原型链与宿主对象', () => {
  assert.ok(checkExpression('a = 1'));
  assert.ok(checkExpression("system('ls')"));
  assert.equal(evaluateExpression('process.env', scope), undefined);
  assert.equal(evaluateExpression('@.__proto__', row(rows[0])), undefined);
  assert.equal(evaluateExpression('@.constructor', row(rows[0])), undefined);
  assert.ok(checkExpression('for (i=0;;) i'));
  assert.ok(checkExpression('@.price *'));
});

test('expression: 未知函数与参数数量报错可读', () => {
  assert.match(checkExpression('nowx()') ?? '', /未知函数/);
  assert.match(checkExpression('upper()') ?? '', /参数数量/);
});

// ---------- JSONPath ----------

test('jsonpath: 成员、下标、切片与通配', () => {
  const payload = { data: { items: rows, next_cursor: 'c-9' }, total: 4 };
  // RFC 语义：`$.data.items` 命中数组这个节点本身，`[*]` 才是逐行。
  assert.equal(queryJsonPath(payload, '$.data.items').length, 1);
  assert.equal(queryJsonPath(payload, '$.data.items[*]').length, 4);
  assert.equal(firstJsonPath(payload, '$.data.items[0].name'), '苹果');
  assert.equal(firstJsonPath(payload, '$.data.items[-1].id'), 4);
  assert.equal(firstJsonPath(payload, '$.data.next_cursor'), 'c-9');
  assert.equal(queryJsonPath(payload, '$.data.items[1:3]').length, 2);
  assert.equal(queryJsonPath(payload, '$.data.items[*].attrs.sku').join(','), 'A-1,B-2,C-3,D-4');
  assert.equal(firstJsonPath(payload, 'data.items[2].attrs.sku'), 'C-3');
});

test('jsonpath: 过滤器与递归下降', () => {
  assert.equal(queryJsonPath(rows, '$[?(@.status == "paid")].id').join(','), '1,3');
  assert.equal(queryJsonPath(rows, '$[?(@.price * @.qty > 20)].id').join(','), '1,2,3');
  assert.equal(queryJsonPath({ a: { b: { sku: 'x' }, sku: 'y' } }, '$..sku').join(','), 'y,x');
  assert.deepEqual(queryJsonPath(rows, "[?status in ('paid','new')].name").sort(), ['牛奶', '苹果', '香蕉'].sort());
});

test('jsonpath: 非法语法抛错，checkJsonPath 给出可读信息', () => {
  assert.ok(queryJsonPathThrows('$[unclosed'));
  assert.ok(queryJsonPathThrows('$.a['));
  assert.ok(checkJsonPath('$[bad]'));
});

function queryJsonPathThrows(path: string): boolean {
  try {
    queryJsonPath({}, path);
    return false;
  } catch {
    return true;
  }
}

// ---------- map 变换 ----------

test('map: 选取 → 过滤 → 投影 → 排序 → 截断', () => {
  const result = applyMapRule({ data: { items: rows } }, {
    select: '$.data.items',
    filter: "@.status == 'paid'",
    project: { 名称: '@.name', 金额: '@.price * @.qty' },
    sortBy: '@.金额',
    sortDir: 'desc',
  });
  assert.deepEqual(result.columns, ['名称', '金额']);
  assert.equal(result.rows[0].金额, 26);
  assert.equal(result.dropped, 2);
});

test('map: explode 把嵌套数组摊平成多行', () => {
  const result = applyMapRule(rows.slice(0, 2), { explode: '$.attrs.tags', project: { sku: '@.attrs.sku', tag: '@.value' }, keepUnmapped: false });
  assert.equal(result.rows.length, 3);
  assert.deepEqual(columnsOf(result.rows), ['sku', 'tag']);
});

test('map: distinct 与 limit', () => {
  const dup = [{ a: 1 }, { a: 1 }, { a: 2 }];
  assert.equal(applyMapRule(dup, { distinct: true }).rows.length, 2);
  assert.equal(applyMapRule(dup, { limit: 1 }).rows.length, 1);
});

test('map: 表达式错误带出行号，便于 Agent 自我修复', () => {
  assert.match((() => {
    try {
      applyMapRule([{ x: 1 }], { project: { y: 'x +' } });
      return '';
    } catch (err: any) {
      return err.message;
    }
  })(), /字段 y 的表达式错误/);
});

// ---------- 绑定 ----------

test('binding: 整串占位符保留类型，混合串按文本拼接', () => {
  const env = { params: { limit: 50, token: 't' }, state: { max: '2026-11-01' }, run: { batchAt: '2026-11-04T00:00:00.000Z' } };
  assert.equal(resolveBinding('{{ params.limit }}', env), 50);
  assert.equal(resolveBinding('LIMIT {{ params.limit }}', env), 'LIMIT 50');
  assert.equal((resolveBinding({ since: '{{ state.max }}' }, env) as { since?: unknown }).since, '2026-11-01');
  assert.equal((resolveBinding(['{{ state.max }}', 'x'], env) as unknown[])[0], '2026-11-01');
  assert.equal(resolveBinding('{{ steps.a.rows[0].id }}', { steps: { a: { rows: [{ id: 7 }] } } }), 7);
});

// ---------- spec 校验 ----------

test('spec: 默认模板只缺必填的连接与目标表', () => {
  const issues = validatePipelineSpec(newPipelineSpec());
  assert.deepEqual(issues.map((issue) => issue.message), ['步骤 fetch：连接必填', '步骤 output：连接必填', '步骤 output：目标表必填']);
});

test('spec: 完整可用的两步流水线零问题', () => {
  const spec = {
    version: 1,
    params: [{ key: 'day', default: '2026-11-04' }],
    steps: [
      { id: 'fetch', type: 'db.query', with: { connectionId: 'c1', sql: "SELECT id FROM t WHERE dt = '{{ params.day }}'" } },
      { id: 'calc', type: 'sql', with: { sql: 'SELECT COUNT(*) AS n FROM input' } },
      { id: 'out', type: 'db.write', with: { connectionId: 'c2', table: 'stat', mode: 'delete_insert', keyColumns: ['n'] } },
    ],
  };
  assert.deepEqual(validatePipelineSpec(spec), []);
  assert.match(String(defaultPipelineStep('script.js', 'x').with.code), /transform\(rows/);
  assert.match(describePipelineLanguage('zh'), /script\.py/);
});

test('spec: 拒绝未知类型、缺必填、重复 id、非法表达式', () => {
  const issues = validatePipelineSpec({
    version: 1,
    steps: [
      { id: 'a', type: 'db.query', with: {} },
      { id: 'a', type: 'nope', with: {} },
      { id: 'c', type: 'map', with: { filter: '@.x >>', zzz: 1 } },
      { id: 'd', type: 'db.write', with: { connectionId: 'x', table: 't', mode: 'delete_insert' } },
    ],
  });
  const text = JSON.stringify(issues);
  assert.match(text, /SQL必填/);
  assert.match(text, /未知步骤类型/);
  assert.match(text, /步骤 id 重复/);
  assert.match(text, /主键列必填/);
  assert.match(text, /不认识的配置项 zzz/);
  assert.match(text, /意外的符号/);
});

test('templates: 每个模板都能过契约校验，review 指向的字段真实存在', () => {
  for (const template of PIPELINE_TEMPLATES) {
    assert.equal(isPipelineStepType(template.spec.steps[0].type), true);
    assert.equal(['http.fetch', 'db.query'].includes(template.spec.steps[0].type), true, `${template.id} 第一步必须取数`);
    const applied = applyPipelineTemplate(template, { connectionId: 'c-1', database: 'shop' });
    // 模板里唯一允许的空缺是连接：套上默认连接后必须能直接保存运行。
    assert.deepEqual(validatePipelineSpec(applied), [], `${template.id} 套默认连接后应当可保存`);
    for (const step of applied.steps) {
      if ('connectionId' in step.with) assert.equal(step.with.connectionId || 'c-1', 'c-1');
    }
    for (const item of template.review) {
      const step = template.spec.steps.find((candidate) => candidate.id === item.step);
      assert.ok(step, `${template.id} 的 review 指向不存在的步骤 ${item.step}`);
      assert.ok(item.field in (step?.with ?? {}), `${template.id} 的 review 指向不存在的配置 ${item.field}`);
    }
  }
});

test('spec: 先删后插的主键必须落在要写入的列里', () => {
  const specWith = (columns: Record<string, string> | undefined, keys: string[]) => ({
    version: 1,
    steps: [
      { id: 's', type: 'db.query', with: { connectionId: 'c', sql: 'SELECT 1' } },
      { id: 'w', type: 'db.write', with: { connectionId: 'c', table: 't', mode: 'delete_insert', keyColumns: keys, ...(columns ? { columns } : {}) } },
    ],
  });
  const bad = validatePipelineSpec(specWith({ status: 'status', n: 'n' }, ['dt']));
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /主键列 dt 不在要写入的列里/);
  assert.deepEqual(validatePipelineSpec(specWith({ status: 'status' }, ['status'])), []);
  // 没写列映射时目标列由源决定，运行期才清楚，这里不能瞎报。
  assert.deepEqual(validatePipelineSpec(specWith(undefined, ['dt'])), []);
});

test('mapRuleFromValues: 界面预览与 gateway 执行同一口径', () => {
  const rule = mapRuleFromValues({ filter: ' @.a > 1 ', project: { b: '@.c' }, limit: '10', sortDir: 'desc', distinct: true });
  assert.equal(rule.filter, '@.a > 1');
  assert.deepEqual(rule.project, { b: '@.c' });
  assert.equal(rule.limit, 10);
  assert.equal(rule.distinct, true);
  assert.equal(rule.sortDir, 'desc');
  assert.deepEqual(applyMapRule([{ a: 5, c: 'x' }, { a: 0, c: 'y' }], rule).rows, [{ b: 'x' }]);
  assert.equal(mapRuleFromValues({}).filter, undefined);
});

test('spec: 语法检查覆盖 JSONPath、表达式与未知参数绑定', () => {
  const issues = validatePipelineSpec(
    {
      version: 1,
      params: [{ key: 'day' }],
      steps: [
        { id: 's', type: 'db.query', with: { connectionId: 'c', sql: 'SELECT 1' } },
        { id: 'm', type: 'map', with: { select: '$[', filter: 'unknownfn(1)' } },
        { id: 'w', type: 'http.push', with: { url: '{{ params.token }}' } },
      ],
    },
    { strictParams: true },
  );
  assert.equal(issues.length, 3);
  assert.match(JSON.stringify(issues), /未知函数/);
  assert.match(JSON.stringify(issues), /params\.token/);
});
