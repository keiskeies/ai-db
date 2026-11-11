import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTable, extractEnumGloss, TIER_GUIDE, type TableTiers } from '../src/agent/schemaTiers';
import { buildSystemPrompt, compressSchema, tierDetailBudget } from '../src/agent/prompt';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../src/types';

function column(name: string, type = 'INT', extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, type, nullable: true, primaryKey: false, ...extra };
}

function table(name: string, opts: Partial<TableInfo> = {}): TableInfo {
  return { name, type: 'table', columns: [column('id', 'INT', { primaryKey: true })], ...opts };
}

function columns(count: number, prefix = 'c'): ColumnInfo[] {
  return Array.from({ length: count }, (_, i) => column(`${prefix}${i}`));
}

// ---------- classifyTable ----------

test('classifyTable keeps the rule order: system and cold names win over everything else', () => {
  assert.equal(classifyTable({ table: table('pg_stat_activity') }).tier, 'system');
  assert.equal(classifyTable({ table: table('information_schema.tables') }).tier, 'system');
  assert.equal(classifyTable({ table: table('flyway_schema_history') }).tier, 'system');
  // 日志命名即使带业务列也不展开：它不是查询目标。
  assert.equal(classifyTable({ table: table('order_logs', { columns: [column('created_at', 'DATETIME')] }) }).tier, 'cold');
  // 按日期分区的备份表。
  assert.equal(classifyTable({ table: table('orders_2024_01') }).tier, 'cold');
});

test('classifyTable separates dictionary tables from business tables by name and size', () => {
  const dict = classifyTable({ table: table('pay_channel_dict', { rowEstimate: 20 }) });
  assert.equal(dict.tier, 'config');
  assert.match(dict.reason, /字典|配置/);
  // 同名的巨表不再是字典：体量说明它其实在承载业务事实。
  assert.notEqual(classifyTable({ table: table('pay_channel_dict', { rowEstimate: 9_000_000 }) }).tier, 'config');
  // 业务实体带时间列 → 活跃。
  const orders = classifyTable({ table: table('orders', { columns: [column('id', 'INT', { primaryKey: true }), column('paid_at', 'DATETIME')], rowEstimate: 500_000 }) });
  assert.equal(orders.tier, 'active');
  assert.match(orders.reason, /时间列/);
});

test('classifyTable uses reference count and query history as its own signals', () => {
  // 小体量 + 大量入向引用 = 被别人引用的维度表，命名没命中也算字典。
  const region = classifyTable({ table: table('t_dim_zone', { rowEstimate: 400 }), incoming: 5 });
  assert.equal(region.tier, 'config', `t_dim_zone 命名里没有字典词，只能靠引用数判定：${region.reason}`);
  assert.match(region.reason, /引用/);
  // 有历史 = 团队真的在查它。
  assert.equal(classifyTable({ table: table('weird_name_x'), hits: 3 }).tier, 'active');
  // 用户维护过 → 除了系统表，命名规则都不能把它降档。
  assert.equal(classifyTable({ table: table('tmp_orders'), curated: true }).tier, 'active');
  assert.equal(classifyTable({ table: table('weird_name_x'), curated: true }).tier, 'active');
  assert.equal(classifyTable({ table: table('pg_stat_activity'), curated: true }).tier, 'system');
});

test('classifyTable only calls a table a bridge when it really is join-only', () => {
  const bridge = classifyTable({
    table: table('user_role', {
      columns: [column('user_id'), column('role_id')],
      foreignKeys: [
        { columns: ['user_id'], refTable: 'users', refColumns: ['id'] },
        { columns: ['role_id'], refTable: 'roles', refColumns: ['id'] },
      ],
      rowEstimate: 9_000,
    }),
  });
  assert.equal(bridge.tier, 'bridge');
  // 带业务时间列的关联表在记事实，不是纯桥接。
  assert.notEqual(
    classifyTable({
      table: table('user_role', {
        columns: [column('user_id'), column('role_id'), column('created_at', 'DATETIME')],
        foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
      }),
    }).tier,
    'bridge',
  );
  // 除主键外只剩一列才算桥接；再多就是普通关联表。
  assert.notEqual(
    classifyTable({
      table: table('user_role', {
        columns: [column('user_id'), column('role_id'), column('score'), column('note', 'VARCHAR(64)')],
        foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
      }),
    }).tier,
    'bridge',
  );
});

test('classifyTable always explains itself so a wrong call can be overridden', () => {
  const info = classifyTable({ table: table('mystery_thing', { rowEstimate: 5_000, columns: columns(4) }) });
  assert.equal(info.tier, 'active', '判不准时宁可给明细');
  assert.ok(info.reason.length > 0);
  assert.match(info.reason, /误判|覆盖|标注/);
  const low = classifyTable({ table: table('mystery_thing', { rowEstimate: 200, columns: columns(4) }) });
  assert.equal(low.tier, 'cold');
  assert.ok(low.reason.length > 0, '降档也要给出可读理由');
});

// ---------- extractEnumGloss ----------

test('extractEnumGloss reads value meanings from comments in the common spellings', () => {
  assert.equal(extractEnumGloss('订单状态 0-待支付 1-已支付 2-已退款'), '0=待支付, 1=已支付, 2=已退款');
  assert.equal(extractEnumGloss('状态: 0=待支付, 1=已支付'), '0=待支付, 1=已支付');
  assert.equal(extractEnumGloss('level：1=普通 2=VIP'), '1=普通, 2=VIP');
  // 一个取值不构成枚举说明；没有注释也不报错。
  assert.equal(extractEnumGloss('状态 0=待支付'), undefined);
  assert.equal(extractEnumGloss(undefined), undefined);
  assert.equal(extractEnumGloss(''), undefined);
});

// ---------- tierDetailBudget ----------

test('tierDetailBudget sizes column detail from the window instead of a fixed table count', () => {
  const wide = Array.from({ length: 60 }, () => ({ columns: 20 }));
  const small = tierDetailBudget({ contextWindow: 32_000, candidates: wide, schemaTokens: 2_000 });
  const big = tierDetailBudget({ contextWindow: 1_000_000, candidates: wide, schemaTokens: 500_000 });
  assert.ok(small > 0 && small < 60, `小预算只能容下一部分明细（got ${small}）`);
  assert.equal(big, 60, '预算够时应容得下全部候选表');
  // 列越多，同样预算能容的表越少 —— 按实际列数算，不拍平均列数。
  const skinny = Array.from({ length: 60 }, () => ({ columns: 3 }));
  assert.ok(
    tierDetailBudget({ contextWindow: 32_000, candidates: skinny, schemaTokens: 2_000 }) > small,
    '窄表应比宽表容纳更多张',
  );
  // 没有窗口档案 → 退回旧的 15 上限；有窗口但没算出上限 → 不设限。
  assert.equal(tierDetailBudget({ candidates: wide }), 15);
  assert.equal(tierDetailBudget({ contextWindow: 32_000, candidates: wide }), 60);
  assert.equal(tierDetailBudget({ contextWindow: 32_000, candidates: [{ columns: 4 }], schemaTokens: 10_000 }), 1);
});

// ---------- compressSchema with tiers ----------

function tieredSchemas(): DatabaseSchema[] {
  return [
    {
      name: 'shop',
      tables: [
        table('orders', {
          comment: '订单主表',
          rowEstimate: 500_000,
          columns: [column('id', 'INT', { primaryKey: true }), column('amount', 'DECIMAL(10,2)'), column('paid_at', 'DATETIME')],
        }),
        table('pay_channel', {
          comment: '支付方式 0=支付宝 1=微信 2=对公转账',
          rowEstimate: 30,
          columns: [column('id', 'INT', { primaryKey: true }), column('name', 'VARCHAR(32)')],
        }),
        table('user_role', { columns: [column('user_id'), column('role_id')], rowEstimate: 9_000 }),
        table('order_logs', { columns: [column('id', 'INT', { primaryKey: true })], rowEstimate: 9_000_000 }),
        table('pg_stat_activity', { columns: [column('pid', 'INT')] }),
      ],
    },
  ];
}

const shopTiers: TableTiers = {
  orders: { tier: 'active', reason: '含业务时间列' },
  pay_channel: { tier: 'config', reason: '命名与体量都像字典/配置表' },
  user_role: { tier: 'bridge', reason: '列几乎全是外键' },
  order_logs: { tier: 'cold', reason: '日志命名' },
  pg_stat_activity: { tier: 'system', reason: '系统内部表' },
};

test('tier mode gives each table a shape instead of a binary expand/skip', () => {
  const out = compressSchema(tieredSchemas(), [], 15, undefined, shopTiers, 128_000);
  assert.ok(out.includes(TIER_GUIDE), '要先给模型图例，否则标记是噪音');
  // 活跃表：列明细在。
  assert.match(out, /table orders[\s\S]*columns: id:INT PK/);
  // 字典表：不展开列，但枚举含义必须在 —— 藏起含义会让模型算出看起来正确的错数字。
  const dictLine = out.split('\n').find((line) => line.includes('pay_channel'));
  assert.ok(dictLine, '字典表要出现');
  assert.ok(dictLine!.includes('0=支付宝'), `字典表要带取值含义：${dictLine}`);
  assert.ok(!/columns:.*channel_name/.test(out), '字典表不占列明细预算');
  // 桥接/系统表：进同一行名字清单，并带标记。
  assert.match(out, /dictionary\/bridge\/internal[^\n]*user_role \[bridge\]/);
  assert.match(out, /pg_stat_activity \[sys\]/);
  // 冷表：名行 + [low]，表存在这件事不能让模型不知道。
  assert.match(out, /order_logs \[low\]/);
  assert.ok(!out.includes('other tables'), 'tier 模式下不并成 other tables 行，标记会丢');
});

test('a focused table wins its columns back even when tiered low', () => {
  const out = compressSchema(tieredSchemas(), ['order_logs'], 15, undefined, shopTiers, 128_000);
  assert.match(out, /table order_logs[\s\S]*columns: id:INT PK/, '本轮问题要它的列，就该给');
  const stillLow = compressSchema(tieredSchemas(), ['orders'], 15, undefined, shopTiers, 128_000);
  assert.match(stillLow, /order_logs \[low\]/, '没被问到就仍按低频掠过');
});

test('tier output is byte-stable across turns when the tiers are the same', () => {
  // system 前缀要逐字节稳定才吃得到服务商 prompt caching。
  const a = compressSchema(tieredSchemas(), [], 15, undefined, shopTiers, 128_000);
  const b = compressSchema(tieredSchemas(), [], 15, undefined, shopTiers, 128_000);
  assert.equal(a, b);
});

test('a small window still keeps every table visible, only dropping column detail', () => {
  const many: DatabaseSchema[] = [
    {
      name: 'warehouse',
      tables: Array.from({ length: 120 }, (_, i) =>
        table(`fact_${i}`, { rowEstimate: 100_000, columns: Array.from({ length: 25 }, (_, c) => column(`col_${c}`)) }),
      ),
    },
  ];
  const tiers: TableTiers = Object.fromEntries(many[0].tables.map((t) => [t.name, { tier: 'active' as const, reason: '业务表' }]));
  const out = compressSchema(many, [], 15, undefined, tiers, 32_000);
  const lines = out.split('\n');
  const withColumns = lines.filter((line) => line.trim().startsWith('columns:')).length;
  const named = lines.filter((line) => /^- (table|view) fact_/.test(line)).length;
  assert.ok(named >= 100, `表名行要基本保留（got ${named}）`);
  assert.ok(withColumns < named, `小窗口下只有部分表拿到列明细（${withColumns}/${named}）`);
  assert.match(out, /\[core; columns omitted: context budget\]/, '被砍掉列的核心表要说明原因，不能让模型以为它没列');
});

test('compressSchema without tiers is unchanged from the pre-tier behaviour', () => {
  const schemas = tieredSchemas();
  const plain = compressSchema(schemas);
  assert.ok(!plain.includes('Tier legend'));
  assert.ok(!plain.includes('[dict]'));
  assert.ok(plain.includes('- table order_logs'), '无档时不猜用途，逐张照常列出');
});

// ---------- buildSystemPrompt 接档 ----------

test('buildSystemPrompt renders the tier shapes and keeps the no-tier output untouched', () => {
  const withTiers = buildSystemPrompt({
    mode: 'readonly',
    databases: tieredSchemas(),
    tiers: shopTiers,
    contextWindow: 128_000,
    question: '本月订单总额',
  });
  assert.match(withTiers, /Tier legend/);
  assert.match(withTiers, /pay_channel: 0=支付宝, 1=微信, 2=对公转账 \[dict\]/, '字典取值要进 system 段');
  assert.match(withTiers, /Each table is shown with the detail its tier deserves/);
  assert.ok(!/Column detail is prioritized/.test(withTiers), '分档模式不是「按问题裁剪」，两句话说反会误导模型');

  const without = buildSystemPrompt({ mode: 'readonly', databases: tieredSchemas(), contextWindow: 128_000 });
  assert.ok(!without.includes('Tier legend'));
  assert.ok(without.includes('- table order_logs'));
});

test('the "N more tables" count excludes tables already listed by name', () => {
  // tier 模式下超过 120 张活跃表才会触发「还有 N 张」的省略行。进了字典/低频名字清单的
  // 表同样算「出现过」，早先只按展开明细的表数减，会让模型以为库里表更少、进而断定
  // 某张表不存在。
  const total = 160;
  const schemas: DatabaseSchema[] = [
    { name: 'shop', tables: Array.from({ length: total }, (_, i) => table(`fact_${i}`, { columns: columns(3) })) },
  ];
  const tiers: TableTiers = Object.fromEntries(
    schemas[0].tables.map((t, i) => [t.name, { tier: i < 140 ? ('active' as const) : ('cold' as const), reason: 'x' }]),
  );
  const out = compressSchema(schemas, [], 15, undefined, tiers, 1_000_000);
  const claimed = Number(/… (\d+) more tables/.exec(out)?.[1] ?? -1);
  assert.ok(claimed >= 0, '160 张表应触发省略行');
  // 140 张活跃 - 120 条明细上限 = 20 张真没出现；20 张冷表已在低频行里报了名字。
  assert.equal(claimed, 20, '冷表已按名字列出，不能被算成「没出现」');
  assert.match(out, /low-frequency tables/, '冷表要有名行');
});
