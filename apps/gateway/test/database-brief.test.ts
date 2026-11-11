import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ColumnInfo, ConnectionConfig, DatabaseSchema, TableInfo } from '@aidb/core';
import {
  briefDrift,
  briefPromptBlock,
  composeDatabaseBrief,
  parseTableTiers,
  loadBrief,
  schemaFingerprint,
  selectCoreTables,
  type BriefInput,
} from '../src/features/databaseBrief';

const connection: ConnectionConfig = {
  id: 'conn-1',
  name: 'Demo MySQL',
  engine: 'mysql',
  color: 'cyan',
  environment: 'dev',
  groupName: '默认',
  host: '127.0.0.1',
  port: 3306,
  database: 'shop',
  readonly: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function column(name: string, type = 'text', extra: Partial<ColumnInfo> = {}) {
  return { name, type, nullable: true, primaryKey: false, ...extra };
}

function table(name: string, opts: { columns?: any[]; fks?: any[]; rows?: number; type?: 'table' | 'view'; comment?: string } = {}): TableInfo {
  return {
    name,
    type: opts.type ?? 'table',
    rowEstimate: opts.rows ?? 100,
    columns: opts.columns ?? [column('id', 'int', { primaryKey: true, nullable: false }), column('name', 'varchar')],
    foreignKeys: opts.fks ?? [],
    indexes: [],
    comment: opts.comment,
  };
}

function schema(extra: TableInfo[] = []): DatabaseSchema[] {
  return [
    {
      name: 'shop',
      tables: [
        table('users', { rows: 5000, columns: [column('id', 'int', { primaryKey: true }), column('email', 'varchar')] }),
        table('orders', {
          rows: 120000,
          comment: '订单主表',
          columns: [
            column('id', 'int', { primaryKey: true }),
            column('user_id', 'int'),
            column('status', 'varchar'),
            column('total_cents', 'int'),
            column('created_at', 'datetime'),
          ],
          fks: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
        }),
        table('order_items', {
          rows: 400000,
          columns: [column('id', 'int', { primaryKey: true }), column('order_id', 'int'), column('sku', 'varchar')],
          fks: [{ columns: ['order_id'], refTable: 'orders', refColumns: ['id'] }],
        }),
        table('payments', {
          rows: 90000,
          columns: [column('id', 'int', { primaryKey: true }), column('order_id', 'int'), column('status', 'varchar')],
          fks: [{ columns: ['order_id'], refTable: 'orders', refColumns: ['id'] }],
        }),
        ...extra,
      ],
    },
  ];
}

function filler(count: number): TableInfo[] {
  return Array.from({ length: count }, (_, index) => table(`audit_log_${String(index + 1).padStart(2, '0')}`, { rows: 10 }));
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    connection,
    schemas: schema(),
    home: 'C:\\aidb-home',
    requestedPath: 'C:\\project\\.aidb',
    ...overrides,
  };
}

test('brief always contains a complete inventory even when core tables are capped', async () => {
  const big = schema(filler(40));
  const result = await composeDatabaseBrief(input({ schemas: big }));
  assert.equal(result.stats.tables + result.stats.views, big[0].tables.length);
  assert.equal(result.stats.tableNames.length, big[0].tables.length);
  assert.equal(result.stats.coreTables.length, 20);
  assert.equal(result.path.endsWith('AI_DB.md'), true);
  assert.match(result.markdown, /## 9\. 附录：全量表清单/);
  assert.match(result.markdown, /audit_log_40/);
  assert.match(result.markdown, /<!-- aidb:inventory/);
  assert.match(result.markdown, /engine: "mysql"/);
  assert.match(result.markdown, /选择|core|核心表手册/);
  assert.equal(result.stats.annotations, 'none');
});

test('core selection includes hub tables and never makes the appendix lossy', async () => {
  const facts = selectCoreTables(schema(filler(10)));
  const names = facts.map((fact) => fact.name);
  assert.equal(names.includes('orders'), true);
  assert.equal(names.includes('order_items'), true);
  assert.equal(names.includes('payments'), true);
});

test('user-maintained context can promote a low-score table into core', () => {
  const facts = selectCoreTables(schema(filler(30)), {
    connectionId: connection.id,
    database: 'shop',
    disabledTables: [],
    disabledColumns: {},
    tableMeta: { audit_log_07: { description: '合规审计必须查的表' } },
    columnMeta: {},
    relations: [],
  });
  assert.equal(facts.some((fact) => fact.name === 'audit_log_07'), true);
});

test('the generated brief includes joins, cents and soft-delete warnings', async () => {
  const result = await composeDatabaseBrief(input());
  assert.match(result.markdown, /orders\.user_id.*users\.id/);
  assert.match(result.markdown, /total_cents/);
  assert.match(result.markdown, /金额列名含 cents/);
  assert.match(result.markdown, /一行代表什么/);
  assert.match(result.markdown, /数据库/);
});

test('every auto section hash matches the bytes written to disk', async () => {
  const result = await composeDatabaseBrief(input());
  const blocks = [...result.markdown.matchAll(/<!-- aidb:auto:([a-z-]+) hash=([a-f0-9]+) -->([\s\S]*?)<!-- \/aidb:auto:\1 -->/g)];
  assert.ok(blocks.length >= 8);
  for (const [, name, stored, body] of blocks) {
    const actual = createHash('sha256').update(body.trim()).digest('hex').slice(0, 12);
    assert.equal(actual, stored, `${name} 段落 hash 与磁盘内容不一致`);
  }
});

test('an unedited rerun replaces auto sections instead of mistaking them for manual edits', async () => {
  const first = await composeDatabaseBrief(input());
  const second = await composeDatabaseBrief(input({ existing: first.markdown }));
  assert.deepEqual([...second.stats.preservedSections].sort(), ['custom', 'dataflow', 'tiers']);
  assert.equal(second.stats.preservedSections.includes('business'), false);
  assert.match(second.markdown, /## 3\. 核心表手册/);
});

test('rerunning refreshes every auto section but keeps manual sections', async () => {
  const first = await composeDatabaseBrief(input());
  const edited = first.markdown
    .replace('尚未生成业务说明', '人工改过的业务说明：这是电商交易库')
    .replace('上游系统：待补充', '上游系统：订单中台（Kafka）');
  assert.notEqual(edited, first.markdown);
  const second = await composeDatabaseBrief(input({ existing: edited }));
  // 自动段落必须刷新，不能把旧内容当成“人工编辑”永久保留
  assert.doesNotMatch(second.markdown, /人工改过的业务说明/);
  assert.match(second.markdown, /尚未生成业务说明/);
  assert.match(second.markdown, /上游系统：订单中台（Kafka）/);
  assert.deepEqual([...second.stats.preservedSections].sort(), ['custom', 'dataflow', 'tiers']);
});

test('a rerun reflects added and removed tables in the auto sections', async () => {
  const first = await composeDatabaseBrief(input());
  const grown = schema([table('reviews', { rows: 500 })]);
  grown[0].tables = grown[0].tables.filter((item) => item.name !== 'payments');
  const second = await composeDatabaseBrief(input({ schemas: grown, existing: first.markdown }));
  assert.match(second.markdown, /reviews/);
  assert.doesNotMatch(second.markdown, /payments/);
  assert.equal(second.stats.tableNames.includes('reviews'), true);
  assert.equal(second.stats.tableNames.includes('payments'), false);
  assert.match(second.markdown, /4 张表/);
});

test('drift reports added and changed tables without touching manual text', async () => {
  const first = await composeDatabaseBrief(input());
  const next = schema([...filler(1), table('reviews', { rows: 500 })]);
  next[0].tables = next[0].tables.map((item) => item.name === 'orders' ? table('orders', {
    rows: 120000,
    columns: [column('id', 'int', { primaryKey: true }), column('user_id', 'int'), column('status', 'varchar'), column('total_cents', 'int'), column('created_at', 'datetime'), column('paid_at', 'datetime')],
    fks: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
  }) : item);
  const drift = briefDrift(first.markdown, next);
  assert.equal(drift.added.includes('reviews'), true);
  assert.equal(drift.changed.includes('orders'), true);
  const loaded = loadBrief(first.markdown, first.path, next);
  const block = briefPromptBlock(loaded);
  assert.match(block, /STALE/);
  assert.match(block, /reviews/);
  assert.match(block, /not a whitelist/i);
  assert.match(block, /tool result wins/i);
});

test('model annotations are validated and marked inferred; invented objects are dropped', async () => {
  const provider = {
    id: 'openai',
    label: 'Mock LLM',
    async *stream(req: any) {
      assert.equal(req.tools.length, 0);
      yield {
        type: 'text',
        text: JSON.stringify({
          business: '这是一个电商交易库，核心是用户、订单与订单明细。',
          tables: [
            { table: 'orders', purpose: '订单主表', grain: '一行一笔订单', notes: '金额存分' },
            { table: 'ghost_table', purpose: '不存在的表' },
          ],
          joins: [
            { leftTable: 'orders', leftColumn: 'user_id', rightTable: 'users', rightColumn: 'id', cardinality: 'N:1', note: '下单用户' },
            { leftTable: 'orders', leftColumn: 'nope', rightTable: 'users', rightColumn: 'id', cardinality: 'N:1' },
            { leftTable: 'ghost_table', leftColumn: 'id', rightTable: 'users', rightColumn: 'id', cardinality: 'N:1' },
          ],
          metrics: [
            { name: 'GMV', definition: '订单金额合计', sql: 'SELECT SUM(total_cents) AS gmv FROM orders' },
            { name: '坏指标', definition: '引用了不存在的表', sql: 'SELECT * FROM missing_table' },
          ],
          recipes: [
            { question: '查订单和用户', sql: 'SELECT o.id, u.email FROM orders o JOIN users u ON u.id = o.user_id', tables: ['orders', 'users'] },
            { question: '坏 recipe', sql: 'SELECT * FROM missing_table' },
          ],
          pitfalls: ['金额单位是分'],
          performance: ['orders 表很大，先按时间过滤'],
        }),
      };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const result = await composeDatabaseBrief(input({ provider: provider as any }));
  assert.equal(result.stats.annotations, 'model');
  assert.match(result.markdown, /这是一个电商交易库/);
  assert.match(result.markdown, /模型推断（inferred）/);
  assert.match(result.markdown, /SELECT SUM\(total_cents\) AS gmv FROM orders/);
  assert.match(result.markdown, /下单用户/);
  assert.match(result.markdown, /金额单位是分（模型推断）/);
  assert.match(result.markdown, /orders 表很大/);
  assert.doesNotMatch(result.markdown, /ghost_table/);
  assert.doesNotMatch(result.markdown, /missing_table/);
  assert.doesNotMatch(result.markdown, /nope/);
  assert.equal(result.stats.metrics, 1);
});

test('brief fingerprint changes with columns and indexes', () => {
  const before = schemaFingerprint(schema());
  const changed = schema();
  changed[0].tables[0].indexes = [{ name: 'idx_users_email', columns: ['email'], unique: true }];
  assert.notEqual(schemaFingerprint(changed), before);
});

test('custom folder wins over the stored path; stored path is used otherwise', async () => {
  const custom = await composeDatabaseBrief(input({ requestedPath: 'D:\\notes\\AI_DB.md' }));
  assert.equal(custom.path, 'D:\\notes\\AI_DB.md');
  const stored = await composeDatabaseBrief(input({ requestedPath: undefined, storedPath: 'D:\\saved\\shop.md' }));
  assert.equal(stored.path, 'D:\\saved\\shop.md');
});

// ---------- 表用途分档（brief 侧） ----------

// 分档 fixture：在 base schema（users/orders/order_items/payments）之上补三类典型表。
// 自动分类的真实结果（有单测兜住，改动规则会在这里先炸）：
//   pay_channel_dict → config（字典）、order_audit_log / sku_backup_2023 → cold、
//   payments → bridge，其余（users/orders/order_items）为活跃、不落盘。
function tiered(extra: TableInfo[] = []): DatabaseSchema[] {
  return schema([
    table('pay_channel_dict', {
      rows: 24,
      comment: '支付方式 0=支付宝 1=微信',
      columns: [column('id', 'int', { primaryKey: true }), column('name', 'varchar')],
    }),
    table('order_audit_log', { rows: 5_000_000, columns: [column('id', 'int', { primaryKey: true })] }),
    table('sku_backup_2023', { rows: 500, columns: [column('id', 'int', { primaryKey: true })] }),
    ...extra,
  ]);
}

/** 取人工分档段落里的表行（三列表格），用于断言段落内容而不是全文搜索。 */
function tierRows(markdown: string): string[] {
  const block = /<!-- aidb:manual:tiers -->([\s\S]*?)<!-- \/aidb:manual:tiers -->/.exec(markdown)?.[1] ?? '';
  return block.split('\n').filter((line) => /^\| `[^`]+` \|/.test(line));
}

test('/init computes explainable tiers and writes them to frontmatter plus a manual override table', async () => {
  const result = await composeDatabaseBrief(input({ schemas: tiered() }));
  const meta = loadBrief(result.markdown, result.path, tiered()).meta;
  assert.equal(meta.tiers?.pay_channel_dict?.tier, 'config');
  assert.equal(meta.tiers?.order_audit_log?.tier, 'cold');
  assert.equal(meta.tiers?.payments?.tier, 'bridge');
  // active 是默认档，不写进 frontmatter（省一半体积），所以「不在表里」就是活跃。
  assert.equal(meta.tiers?.orders, undefined);
  assert.match(meta.tiers?.order_audit_log?.reason ?? '', /日志|历史/);

  // 人工段落：逐张列出非活跃表 + 理由，用户看得懂才有机会纠错。
  assert.match(result.markdown, /aidb:manual:tiers/);
  assert.deepEqual(tierRows(result.markdown).map((row) => row.split('|')[1].trim()).sort(), [
    '`order_audit_log`',
    '`pay_channel_dict`',
    '`payments`',
    '`sku_backup_2023`',
  ]);
  assert.match(result.markdown, /删掉那一行/);
});

test('the manual tier table only reads its own rows, not the full inventory appendix', async () => {
  // 附录是七列表格。早先的三列正则会把它每行都当成分档行，于是每张表都被盖上
  // 「人工指定」的档，自动分类整体失效——这条钉住行解析只认三列。
  const result = await composeDatabaseBrief(input({ schemas: tiered() }));
  const meta = loadBrief(result.markdown, result.path, tiered()).meta;
  assert.deepEqual(Object.keys(meta.tiers ?? {}).sort(), ['order_audit_log', 'pay_channel_dict', 'payments', 'sku_backup_2023']);
  assert.ok(
    Object.values(meta.tiers ?? {}).every((info) => !/人工在 brief/.test(info.reason)),
    '首次 /init 没有人工改动，理由必须是自动分类的理由',
  );
  assert.match(result.markdown, /\| `orders` \| table \|/,'附录清单仍在（它不该被当成分档行）');
});

test('the tier table survives a rerun: hand edits stay, deleted rows are not resurrected', async () => {
  const first = await composeDatabaseBrief(input({ schemas: tiered() }));
  // 用户认为备份表其实常用，删掉那一行升档。
  const withoutBackup = first.markdown
    .split('\n')
    .filter((line) => !/^\| `sku_backup_2023` \| 低频 \|/.test(line))
    .join('\n');
  assert.notEqual(withoutBackup, first.markdown, 'fixture must contain a sku_backup_2023 row');

  const second = await composeDatabaseBrief(input({ schemas: tiered(), existing: withoutBackup }));
  const meta = loadBrief(second.markdown, second.path, tiered()).meta;
  assert.equal(meta.tiers?.sku_backup_2023, undefined, '用户删了行，规则不能把它再降回去');
  assert.equal(meta.tiers?.order_audit_log?.tier, 'cold', '没动过的行照旧');
  assert.equal(meta.tiers?.pay_channel_dict?.tier, 'config');
  // 正文与人工说明文字原样保留，只补新增表、重算统计行。
  assert.match(second.markdown, /本表是「非活跃表」的权威清单/);
  assert.equal(tierRows(second.markdown).filter((row) => row.includes('`order_audit_log`')).length, 1, '重跑不能把同一张表补成两行');
  assert.equal(tierRows(second.markdown).filter((row) => row.includes('`sku_backup_2023`')).length, 0);
});

test('a tier row the user re-tiers wins over the rules, and a dropped table loses its row', async () => {
  const first = await composeDatabaseBrief(input({ schemas: tiered() }));
  // 把低频的日志表改成字典档（用户知道它是维表）。
  const retiered = first.markdown.replace('| `order_audit_log` | 低频 |', '| `order_audit_log` | 字典/配置 |');
  assert.notEqual(retiered, first.markdown);
  const second = await composeDatabaseBrief(input({ schemas: tiered(), existing: retiered }));
  const meta = loadBrief(second.markdown, second.path, tiered()).meta;
  assert.equal(meta.tiers?.order_audit_log?.tier, 'config');
  // 人工行的理由列原样保留（可解释性不能因人工指定而丢失）。
  assert.match(meta.tiers?.order_audit_log?.reason ?? '', /日志|历史/);

  // 表被删掉后，人工表里的那一行要一起消失，否则模型会去查不存在的表。
  const shrunk = tiered().map((db) => ({ ...db, tables: db.tables.filter((t) => t.name !== 'order_audit_log') }));
  const third = await composeDatabaseBrief(input({ schemas: shrunk, existing: second.markdown }));
  assert.doesNotMatch(third.markdown, /\| `order_audit_log` \| 字典/);
  assert.equal(loadBrief(third.markdown, third.path, shrunk).meta.tiers?.order_audit_log, undefined);
});

test('「活跃业务表」等价于删行', async () => {
  const first = await composeDatabaseBrief(input({ schemas: tiered() }));
  const promoted = first.markdown.replace('| `pay_channel_dict` | 字典/配置 |', '| `pay_channel_dict` | 活跃业务表 |');
  assert.notEqual(promoted, first.markdown);
  const second = await composeDatabaseBrief(input({ schemas: tiered(), existing: promoted }));
  const meta = loadBrief(second.markdown, second.path, tiered()).meta;
  assert.equal(meta.tiers?.pay_channel_dict, undefined);
  // 用户写的行保留下来当记录（不复活成降档），下一轮再读仍是活跃。
  assert.equal(tierRows(second.markdown).filter((row) => row.includes('`pay_channel_dict` | 活跃业务表')).length, 1);
  const third = await composeDatabaseBrief(input({ schemas: tiered(), existing: second.markdown }));
  assert.equal(loadBrief(third.markdown, third.path, tiered()).meta.tiers?.pay_channel_dict, undefined, '多次重跑不能把档加回来');
});

test('a new table is appended to the existing tier table instead of opening a second one', async () => {
  const first = await composeDatabaseBrief(input({ schemas: tiered() }));
  const grown = tiered([table('daily_snapshot', { rows: 900, columns: [column('id', 'int', { primaryKey: true })] })]);
  const second = await composeDatabaseBrief(input({ schemas: grown, existing: first.markdown }));
  assert.equal((second.markdown.match(/\| 表 \/ 视图 \| 档位 \| 判定理由 \|/g) ?? []).length, 1, '表头只能有一份');
  assert.equal(tierRows(second.markdown).filter((row) => row.includes('`daily_snapshot`')).length, 1);
  assert.equal(loadBrief(second.markdown, second.path, grown).meta.tiers?.daily_snapshot?.tier, 'cold');
  // 统计行随新增表重算，段落正文其它部分不动。
  assert.match(second.markdown, /分档统计：活跃业务表 3 张；[^\n]*低频 3 张/);
});

test('a brief written before tiers still loads, and its frontmatter parses round-trip', async () => {
  const result = await composeDatabaseBrief(input({ schemas: tiered() }));
  const raw = /table_tiers: "(.*)"/.exec(result.markdown)?.[1];
  assert.ok(raw, 'frontmatter 要有 table_tiers');
  const parsed = parseTableTiers(raw);
  assert.equal(parsed.order_audit_log?.tier, 'cold');
  // 理由里的标点不能把条目切开。
  assert.ok(!Object.keys(parsed).some((name) => name.includes(':') || name.includes('=')), `键里混进了结构符：${Object.keys(parsed).join(', ')}`);
  assert.ok(Object.values(parsed).every((info) => info.reason.length > 0));

  const legacy = result.markdown
    .replace(/table_tiers: ".*"\n/, '')
    .replace(/<!--[ ]?aidb:manual:tiers -->[\s\S]*?<!--[ ]?\/aidb:manual:tiers -->/, '');
  const loaded = loadBrief(legacy, result.path, tiered());
  assert.equal(loaded.meta.tiers, undefined, '没有分档信息就按无档处理，不报错');
});
