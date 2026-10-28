import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleAgentContext, emptyBundle, isColumnDisabled, isTableDisabled } from '../src/agent/context';
import {
  buildSystemPrompt,
  compressSchema,
  formatBusinessContext,
  formatGlossary,
  formatMemoriesForPrompt,
  formatRelations,
  formatSqlExamples,
} from '../src/agent/prompt';
import { extractHeuristicMemories, rankMemories } from '../src/agent/memory';
import { isAgentContextActive, type AgentContextEntry, type DatabaseSchema, type Memory } from '../src/types';

const iso = new Date('2026-10-27T00:00:00.000Z').toISOString();

function entry(partial: Partial<AgentContextEntry> & { kind: AgentContextEntry['kind']; table: string }): AgentContextEntry {
  return {
    id: `${partial.kind}-${partial.table}-${partial.column ?? ''}-${partial.refTable ?? ''}`,
    connectionId: 'c1',
    database: 'shop',
    enabled: true,
    createdAt: iso,
    updatedAt: iso,
    ...partial,
  };
}

const schema: DatabaseSchema[] = [
  {
    name: 'shop',
    tables: [
      {
        name: 'orders',
        type: 'table',
        rowEstimate: 100,
        columns: [
          { name: 'id', type: 'INT', nullable: false, primaryKey: true },
          { name: 'status', type: 'VARCHAR(20)', nullable: true, primaryKey: false },
          { name: 'internal_flag', type: 'TINYINT', nullable: true, primaryKey: false },
        ],
        foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
      },
      { name: 'audit_log', type: 'table', columns: [{ name: 'id', type: 'INT', nullable: false, primaryKey: true }] },
      { name: 'users', type: 'table', comment: '用户表', columns: [{ name: 'id', type: 'INT', nullable: false, primaryKey: true }] },
    ],
  },
];

function mem(partial: Partial<Memory> & { id: string; kind: Memory['kind']; title: string; content: string }): Memory {
  return {
    scopeType: 'database',
    scopeKey: 'c1/shop',
    tags: [],
    importance: 0.7,
    confidence: 0.7,
    pinned: false,
    archived: false,
    useCount: 0,
    createdAt: iso,
    updatedAt: iso,
    ...partial,
  };
}

// ---------- bundleAgentContext ----------

test('bundleAgentContext is inactive for an empty entry list', () => {
  const bundle = bundleAgentContext([], { connectionId: 'c1', database: 'shop' });
  assert.equal(isAgentContextActive(bundle), false);
  assert.deepEqual(bundle.disabledTables, []);
  assert.deepEqual(bundle.relations, []);
  assert.equal(isAgentContextActive(emptyBundle()), false);
  assert.equal(isAgentContextActive(undefined), false);
});

test('bundleAgentContext splits tables, columns and relations with case-insensitive keys', () => {
  const bundle = bundleAgentContext(
    [
      entry({ kind: 'table', table: 'Audit_Log', enabled: false }),
      entry({ kind: 'table', table: 'orders', alias: '订单表', description: '所有已支付与未支付订单' }),
      entry({ kind: 'column', table: 'ORDERS', column: 'Internal_Flag', enabled: false }),
      entry({ kind: 'column', table: 'orders', column: 'status', description: '枚举值：PAID=已支付，NEW=新建' }),
      entry({ kind: 'relation', table: 'orders', column: 'user_id', refTable: 'users', refColumn: 'id', description: '下单人' }),
    ],
    { connectionId: 'c1', database: 'shop' },
  );

  assert.deepEqual(bundle.disabledTables, ['audit_log']);
  assert.deepEqual(bundle.disabledColumns, { orders: ['internal_flag'] });
  assert.deepEqual(bundle.tableMeta.orders, { alias: '订单表', description: '所有已支付与未支付订单' });
  assert.equal(bundle.columnMeta.orders.status.description, '枚举值：PAID=已支付，NEW=新建');
  assert.equal(bundle.columnMeta.orders.internal_flag, undefined, '只禁用、无语义的列不产生 meta');
  assert.deepEqual(bundle.relations, [{ leftTable: 'orders', leftColumn: 'user_id', rightTable: 'users', rightColumn: 'id', description: '下单人' }]);
  assert.equal(isAgentContextActive(bundle), true);
  assert.equal(isTableDisabled(bundle, 'AUDIT_LOG'), true);
  assert.equal(isColumnDisabled(bundle, 'Orders', 'INTERNAL_FLAG'), true);
});

test('bundleAgentContext drops malformed relations instead of emitting broken join hints', () => {
  const bundle = bundleAgentContext(
    [
      entry({ kind: 'relation', table: 'orders', column: 'user_id' }),
      entry({ kind: 'relation', table: 'orders', column: '', refTable: 'users', refColumn: 'id' }),
      entry({ kind: 'column', table: 'orders' }),
    ],
    { connectionId: 'c1', database: 'shop' },
  );
  assert.deepEqual(bundle.relations, []);
  assert.deepEqual(bundle.disabledColumns, {});
});

// ---------- compressSchema ----------

test('compressSchema without a bundle is byte-identical to the pre-P1 output', () => {
  // 输出顺序沿用既有实现：表名升序，与数组顺序无关
  const expected = [
    '### Database: shop',
    '- table audit_log',
    '  columns: id:INT PK NOT NULL',
    '- table orders (~100 rows)',
    '  columns: id:INT PK NOT NULL, status:VARCHAR(20), internal_flag:TINYINT',
    '  fks: user_id→users(id)',
    '- table users — 用户表',
    '  columns: id:INT PK NOT NULL',
  ].join('\n');
  assert.equal(compressSchema(schema), expected);
  assert.equal(compressSchema(schema, [], 15, undefined), expected);
  assert.equal(compressSchema(schema, [], 15, emptyBundle({ connectionId: 'c1', database: 'shop' })), expected, 'inactive bundle must not change output');
});

test('compressSchema hides disabled tables and columns and reports the hidden count', () => {
  const bundle = bundleAgentContext(
    [
      entry({ kind: 'table', table: 'audit_log', enabled: false }),
      entry({ kind: 'column', table: 'orders', column: 'internal_flag', enabled: false }),
    ],
    { connectionId: 'c1', database: 'shop' },
  );
  const out = compressSchema(schema, [], 15, bundle);
  assert.ok(!out.includes('audit_log'), 'disabled table must not appear as a schema line');
  assert.ok(!out.includes('internal_flag'));
  assert.match(out, /1 tables hidden by the user's context settings/);
  assert.match(out, /columns: id:INT PK NOT NULL, status:VARCHAR\(20\)$/m);
});

test('compressSchema renders aliases and business descriptions, preferring them over native comments', () => {
  const bundle = bundleAgentContext(
    [
      entry({ kind: 'table', table: 'orders', alias: '订单表', description: '含已支付与未支付订单' }),
      entry({ kind: 'column', table: 'orders', column: 'status', alias: '订单状态', description: 'PAID=已支付，NEW=新建' }),
    ],
    { connectionId: 'c1', database: 'shop' },
  );
  const out = compressSchema(schema, [], 15, bundle);
  assert.match(out, /- table orders \(订单表\) — 含已支付与未支付订单 \(~100 rows\)/);
  assert.match(out, /status:VARCHAR\(20\)→订单状态\[PAID=已支付，NEW=新建\]/);
  // 未标注的表保持原样，包括数据库原生 comment
  assert.match(out, /- table users — 用户表/);
});

test('compressSchema gives annotated tables priority for the column-detail budget', () => {
  const bundle = bundleAgentContext([entry({ kind: 'table', table: 'users', description: '会员主表' })], { connectionId: 'c1', database: 'shop' });
  const out = compressSchema(schema, [], 1, bundle);
  const lines = out.split('\n');
  assert.match(lines[1], /- table users — 会员主表/, '被标注的表应排到最前');
  assert.match(lines[2], /^\s+columns: id:INT PK NOT NULL$/, '并占用唯一的明细预算');
  assert.ok(!/- table orders[\s\S]*\n\s+columns/.test(out.split('- table audit_log')[0]), 'orders 未获得明细预算');
});

test('compressSchema keeps its not-loaded placeholder regardless of bundle', () => {
  const bundle = bundleAgentContext([entry({ kind: 'table', table: 'x', enabled: false })], {});
  const text = '(schema not loaded yet — call inspect_schema or search_objects before querying)';
  assert.equal(compressSchema(undefined, [], 15, bundle), text);
  assert.equal(compressSchema([], [], 15, bundle), text);
});

// ---------- business context section ----------

test('formatBusinessContext is empty when nothing is configured', () => {
  assert.equal(formatBusinessContext({}), '');
  assert.equal(formatBusinessContext({ context: emptyBundle(), glossary: [], sqlExamples: [] }), '');
  assert.equal(formatGlossary([]), '');
  assert.equal(formatSqlExamples(undefined), '');
  assert.equal(formatRelations(emptyBundle()), '');
});

test('formatBusinessContext renders terms, join relations and few-shot examples', () => {
  const bundle = bundleAgentContext([entry({ kind: 'relation', table: 'orders', column: 'user_id', refTable: 'users', refColumn: 'id', description: '下单人' })], {});
  const out = formatBusinessContext({
    context: bundle,
    glossary: [mem({ id: 'g1', kind: 'glossary', title: 'JS', content: 'JumpServer 堡垒机' })],
    sqlExamples: [mem({ id: 'e1', kind: 'sql_example', title: '本季度东区赢单总数', content: 'SELECT COUNT(*) FROM deals WHERE region = \'east\';' })],
  });
  assert.match(out, /## Business context \(authoritative — overrides your own guesses\)/);
  assert.match(out, /### Terms\n- JS → JumpServer 堡垒机/);
  assert.match(out, /### Join relations\n- orders\.user_id = users\.id {2}（下单人）/);
  assert.match(out, /Q: 本季度东区赢单总数/);
  assert.match(out, /SELECT COUNT\(\*\) FROM deals WHERE region = 'east';/);
  assert.match(out, /never invent join keys/);
});

test('business context caps example count and truncates long SQL to protect the token budget', () => {
  const examples = Array.from({ length: 6 }, (_, i) => mem({ id: `e${i}`, kind: 'sql_example' as const, title: `问题${i}`, content: `SELECT ${'x'.repeat(2000)} -- ${i}` }));
  const out = formatSqlExamples(examples);
  assert.equal(out.split('```sql').length - 1, 3, '最多注入 3 条示例');
  for (const line of out.split('\n')) assert.ok(line.length <= 600 + 20, 'single example line stays bounded');

  const terms = Array.from({ length: 30 }, (_, i) => mem({ id: `g${i}`, kind: 'glossary' as const, title: `术语${i}`, content: 'y'.repeat(500) }));
  const glossary = formatGlossary(terms);
  assert.equal(glossary.split('\n').length, 20, '术语最多注入 20 条');
  assert.ok(glossary.split('\n').every((l) => l.length <= 60 + 3 + 120 + 3));
});

test('formatMemoriesForPrompt excludes business-semantic kinds so they use their own quota', () => {
  const memories = [
    mem({ id: 'm1', kind: 'fact', title: '金额单位是分', content: 'orders.total_cents' }),
    mem({ id: 'm2', kind: 'glossary', title: 'JS', content: 'JumpServer' }),
    mem({ id: 'm3', kind: 'sql_example', title: '问题', content: 'SELECT 1' }),
  ];
  const out = formatMemoriesForPrompt(memories);
  assert.match(out, /金额单位是分/);
  assert.ok(!out.includes('JumpServer'));
  assert.ok(!out.includes('SELECT 1'));
  assert.equal(formatMemoriesForPrompt([]), '(none recalled for this turn)');
  assert.equal(formatMemoriesForPrompt(undefined), '(none recalled for this turn)');
});

test('buildSystemPrompt omits the whole business section when unconfigured', () => {
  const base = buildSystemPrompt({ databases: schema, mode: 'ask', memories: [] });
  assert.ok(!base.includes('Business context'));
  assert.ok(base.includes('## Schema\n### Database: shop'));
  assert.match(base, /## Schema\n### Database: shop[\s\S]*\n\n## Memories recalled for this turn/);
});

test('buildSystemPrompt injects business context and hides disabled tables together', () => {
  const bundle = bundleAgentContext([entry({ kind: 'table', table: 'audit_log', enabled: false })], { connectionId: 'c1', database: 'shop' });
  const out = buildSystemPrompt({
    databases: schema,
    mode: 'ask',
    memories: [],
    context: bundle,
    glossary: [mem({ id: 'g1', kind: 'glossary', title: 'GMV', content: '成交总额，含退款前金额' })],
  });
  assert.match(out, /## Business context/);
  assert.match(out, /- GMV → 成交总额，含退款前金额/);
  assert.ok(!/- table audit_log\n/.test(out));
});

test('buildSystemPrompt states the exact connectionId so tools stop guessing it', () => {
  const out = buildSystemPrompt({
    databases: schema,
    mode: 'ask',
    memories: [],
    connection: {
      id: 'conn-uuid-1',
      name: 'Demo · Shop DB',
      engine: 'sqlite',
      color: 'green',
      environment: 'dev',
      groupName: '示例',
      database: 'C:\\data\\demo-shop.sqlite',
      readonly: false,
      createdAt: iso,
      updatedAt: iso,
    },
  });
  assert.match(out, /Connection: id=conn-uuid-1 name=Demo · Shop DB engine=sqlite database=C:\\data\\demo-shop\.sqlite/);
  assert.match(out, /exact `id=` value from the Connection line/);
});

// ---------- memory kinds ----------

test('ranking gives business-semantic kinds a tie-break bonus without reordering the legacy five', () => {
  // 词法完全相同、仅 kind 不同，用以隔离出加成本身。生产中术语与示例 SQL 走独立配额，
  // 不与事实记忆竞争；该加成只是同一分区内的排序 tie-break。
  const same = [
    mem({ id: 'a', kind: 'fact', title: '订单金额单位', content: '订单金额以分为单位存储', importance: 0.7 }),
    mem({ id: 'b', kind: 'glossary', title: '订单金额单位', content: '订单金额以分为单位存储', importance: 0.7 }),
  ];
  const ranked = rankMemories('订单金额', same, { connectionId: 'c1', database: 'shop' });
  assert.equal(ranked[0].kind, 'glossary', '词法打平时业务语义优先');

  // 词法明显更相关的事实记忆不应被 kind 加成挤掉
  const mixed = [
    mem({ id: 'strong', kind: 'fact', title: '订单金额单位', content: '订单金额以分为单位存储，换算需除以 100', importance: 0.7 }),
    mem({ id: 'weak', kind: 'glossary', title: '无关术语', content: '完全不含查询词的释义', importance: 0.7 }),
  ];
  assert.equal(rankMemories('订单金额', mixed, {})[0].id, 'strong', '相关度优先于 kind 加成');

  const legacy = [
    mem({ id: 'x', kind: 'fact', title: '甲', content: '订单 金额 分', importance: 0.9 }),
    mem({ id: 'y', kind: 'preference', title: '乙', content: '订单 金额 分', importance: 0.2 }),
  ];
  const legacyRanked = rankMemories('订单 金额', legacy, {});
  assert.deepEqual(
    legacyRanked.map((m) => m.id),
    ['x', 'y'],
    '原有五类的相对排序不受影响',
  );
});

test('extractHeuristicMemories recognises term definitions as glossary entries', () => {
  const glossary = extractHeuristicMemories('记住 JS 就是 JumpServer', { connectionId: 'c1' });
  assert.equal(glossary.length, 1);
  assert.equal(glossary[0].kind, 'glossary');
  assert.equal(glossary[0].title, 'JS');
  assert.equal(glossary[0].content, 'JS = JumpServer');
  assert.equal(glossary[0].scopeType, 'connection');

  const strong = extractHeuristicMemories('GMV 指的是 成交总额（含退款前）', {});
  assert.equal(strong[0]?.kind, 'glossary', '强标记无需「记住」也可收录');
  assert.equal(strong[0]?.title, 'GMV');

  // 既有行为不变
  const preference = extractHeuristicMemories('以后默认用深色主题', {});
  assert.equal(preference[0].kind, 'preference');
  assert.deepEqual(extractHeuristicMemories('查一下 orders 有多少行', {}), []);
  assert.deepEqual(extractHeuristicMemories('记住 password = hunter2', {}), [], '疑似凭据仍然拒收');
  assert.deepEqual(extractHeuristicMemories('这个方案就是我想要的那种', {}), [], '弱标记缺少触发词时不收录，避免污染长期记忆');
  assert.deepEqual(extractHeuristicMemories('GMV means 成交总额', {}), [], '英文弱标记同理');
  assert.equal(extractHeuristicMemories('记住 GMV means 成交总额', {})[0]?.kind, 'glossary', '带上触发词则收录');
});
