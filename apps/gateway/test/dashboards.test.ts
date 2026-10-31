import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store';
import { applyTimeRange, assertDashboardSql, disabledTablesTouched } from '../src/features/dashboards';
import { metricCandidates, trialVerdict } from '../src/features/dashboardGenerate';

function fakeFact(overrides: Record<string, unknown> = {}) {
  return {
    displayName: 'ziyou_mall_center.t_order',
    name: 't_order',
    schemaName: 'ziyou_mall_center',
    fingerprint: 'fp',
    table: {
      name: 't_order',
      type: 'table',
      rowEstimate: 129757,
      comment: '订单表',
      columns: [
        { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
        { name: 'order_amount', type: 'decimal(10,2)', nullable: false, primaryKey: false, comment: '订单金额' },
        { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false, comment: '订单状态' },
        { name: 'invalid', type: 'tinyint', nullable: false, primaryKey: false },
        { name: 'created_timestamp', type: 'datetime', nullable: false, primaryKey: false },
      ],
    },
    ...overrides,
  } as never;
}

const resultSet = (columns: string[], rows: unknown[][]) =>
  ({ columns: columns.map((name) => ({ name })), rows, rowCount: rows.length, durationMs: 1 }) as never;

test('metric candidates are money-first and business-titled', () => {
  const [trend, distribution] = metricCandidates([fakeFact()], 'mysql', [], 4);
  assert.match(trend.sql, /DATE_FORMAT\(`created_timestamp`, '%Y-%m'\)/);
  assert.match(trend.sql, /SUM\(`order_amount`\)/);
  assert.match(trend.sql, /WHERE `invalid` = 0/, '软删除必须过滤，否则口径全是水');
  assert.equal(trend.chartType, 'line');
  assert.equal(trend.y, 'amount');
  assert.ok(!/t_order|ziyou_mall_center/.test(trend.title), `标题不该出现表名/库名：${trend.title}`);
  assert.match(trend.title, /订单/);
  assert.match(distribution.sql, /GROUP BY dim_value/);
  assert.ok(!/t_order/.test(distribution.title));
});

test('information-value gates block junk charts', () => {
  const oneBar = resultSet(['dim_value', 'cnt'], [['0', 101000]]);
  assert.equal(trialVerdict(oneBar, { x: 'dim_value', y: 'cnt', chartType: 'bar' }), '分类只有一个取值');
  const skewed = resultSet(['dim_value', 'cnt'], [['A', 999], ['B', 1], ['C', 0]]);
  assert.match(String(trialVerdict(skewed, { x: 'dim_value', y: 'cnt', chartType: 'bar' })), /99%/);
  const rawTimestamps = resultSet(
    ['period', 'cnt'],
    [
      ['2025-01-01 10:00:00', 1],
      ['2025-01-01 10:05:00', 1],
      ['2025-01-01 10:11:00', 1],
    ],
  );
  assert.match(String(trialVerdict(rawTimestamps, { x: 'period', y: 'cnt', chartType: 'line' })), /按天|分桶/);
  const monthly = resultSet(
    ['period', 'amount'],
    Array.from({ length: 12 }, (_, index) => [`2025-${String(index + 1).padStart(2, '0')}`, index * 1000 + 500]),
  );
  assert.equal(trialVerdict(monthly, { x: 'period', y: 'amount', chartType: 'line' }), undefined);
  assert.equal(trialVerdict(undefined, { chartType: 'bar' }), '没有返回数据');
});

function withStore(fn: (store: Store) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-dash-'));
  const store = new Store(join(dir, 'store.sqlite'), 'test-secret');
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const card = (title: string, sql = `SELECT month, gmv FROM ${title}`) => ({
  connectionId: 'conn-a',
  database: 'shop',
  title,
  sql,
  chartType: 'bar' as const,
  pinned: false,
});

test('dashboard cards are scoped to connection + database', () => {
  withStore((store) => {
    store.insertDashboardCard(card('甲'));
    store.insertDashboardCard(card('乙'));
    store.insertDashboardCard({ ...card('丙'), database: 'crm' });
    assert.equal(store.listDashboardCards('conn-a', 'shop').length, 2, '每个库一块板');
    assert.equal(store.listDashboardCards('conn-a', 'crm').length, 1);
    assert.equal(store.listDashboardCards('conn-a').length, 0, '不指定库时不串到别的板');
  });
});

test('update patches only the given fields and truncates the snapshot', () => {
  withStore((store) => {
    const saved = store.insertDashboardCard(card('订单'));
    const renamed = store.updateDashboardCard(saved.id, { title: '近 30 天订单', pinned: false });
    assert.equal(renamed?.title, '近 30 天订单');
    assert.equal(renamed?.sql, saved.sql, '没传 sql 就不能动口径');
    assert.equal(renamed?.pinned, false);

    const rows = Array.from({ length: 320 }, (_, index) => [index, index * 2]);
    const ran = store.updateDashboardCard(saved.id, {
      lastStatus: 'ok',
      lastResult: { columns: [{ name: 'x' }, { name: 'y' }], rows },
    });
    assert.equal(ran?.lastResult?.rows.length, 200, '快照行数封顶，别把 App 存储撑爆');
    assert.equal(ran?.lastResult?.columns.length, 2);
    assert.equal(ran?.title, '近 30 天订单', '快照写回不能顺手改标题');
  });
});

test('draft replacement only discards unpinned cards', () => {
  withStore((store) => {
    const kept = store.insertDashboardCard(card('我要固定'));
    store.updateDashboardCard(kept.id, { pinned: true });
    store.insertDashboardCard(card('草稿一'));
    store.insertDashboardCard(card('草稿二'));

    const after = store.setDraftCards('conn-a', 'shop', [card('新草稿'), card('另一张新草稿')]);
    assert.equal(after.length, 3, '固定卡留下，草稿整批替换');
    assert.deepEqual(
      after.filter((item) => item.pinned).map((item) => item.title),
      ['我要固定'],
    );
    assert.ok(after.some((item) => item.title === '新草稿' && !item.pinned));
    assert.ok(!after.some((item) => item.title === '草稿一'), '旧草稿应被替换掉');
  });
});

test('draft replacement cannot exceed the board limit', () => {
  withStore((store) => {
    for (let index = 0; index < 10; index += 1) store.insertDashboardCard({ ...card(`固定 ${index}`), pinned: true });
    const drafts = Array.from({ length: 8 }, (_, index) => card(`草稿 ${index}`));
    const after = store.setDraftCards('conn-a', 'shop', drafts);
    assert.equal(after.length, 12, '上限 12 张卡');
    assert.equal(after.filter((item) => !item.pinned).length, 2);
  });
});

test('discard drafts leaves pinned cards and reorder rewrites positions', () => {
  withStore((store) => {
    store.insertDashboardCard({ ...card('固定甲'), pinned: true });
    store.insertDashboardCard({ ...card('固定乙'), pinned: true });
    store.insertDashboardCard(card('草稿甲'));
    store.insertDashboardCard(card('草稿乙'));
    assert.equal(store.discardDashboardDrafts('conn-a', 'shop'), 2, '只丢草稿');
    const list = store.listDashboardCards('conn-a', 'shop');
    assert.deepEqual(list.map((item) => item.title), ['固定甲', '固定乙']);

    const reordered = store.reorderDashboardCards(list.map((item) => item.id).reverse());
    assert.deepEqual(reordered.map((item) => item.position), [1, 2]);
    assert.deepEqual(reordered.map((item) => item.title), ['固定乙', '固定甲']);
  });
});

test('draft cards keep the generator trial snapshot', () => {
  withStore((store) => {
    store.setDraftCards('conn-a', 'shop', [
      { ...card('月度订单'), lastResult: { columns: [{ name: 'month' }, { name: 'orders' }], rows: [['2026-01', 3]] } },
    ]);
    const [draft] = store.listDashboardCards('conn-a', 'shop');
    assert.equal(draft.pinned, false);
    assert.equal(draft.lastStatus, 'ok', '试跑结果直接当快照，入板就能画');
    assert.deepEqual(draft.lastResult?.rows, [['2026-01', 3]]);
  });
});

test('null clears a field while undefined leaves it alone', () => {
  withStore((store) => {
    const saved = store.insertDashboardCard({ ...card('趋势'), timeColumn: 'month', x: 'month', y: 'orders' });
    assert.equal(saved.timeColumn, 'month');
    const untouched = store.updateDashboardCard(saved.id, { title: '换了标题' });
    assert.equal(untouched?.timeColumn, 'month', '没传时间列就不能动');
    const cleared = store.updateDashboardCard(saved.id, { timeColumn: null });
    assert.equal(cleared?.timeColumn, undefined, '显式 null 才是清空——否则 UI 上「不参与时间筛选」点了没反应');
  });
});

test('scheduled refresh is off by default and throttled to a 60s floor', () => {
  withStore((store) => {
    assert.equal(store.getDashboardSchedule('conn-a', 'shop'), undefined, '没设置过就没有定时');
    const set = store.setDashboardSchedule({ connectionId: 'conn-a', database: 'shop', intervalSeconds: 5, enabled: true, notifyChannels: ['c1'] });
    assert.equal(set?.intervalSeconds, 60, '最小 60 秒，不给后台打爆库的机会');
    assert.deepEqual(set?.notifyChannels, ['c1']);

    store.markDashboardScheduleRun('conn-a', 'shop', 'error', '查询超时');
    const marked = store.getDashboardSchedule('conn-a', 'shop');
    assert.equal(marked?.lastStatus, 'error');
    assert.equal(marked?.lastError, '查询超时');
    assert.ok(marked?.lastRunAt);
    assert.equal(store.listDashboardSchedules().length, 1);

    store.setDashboardSchedule({ connectionId: 'conn-a', database: 'shop', intervalSeconds: 300, enabled: false });
    assert.equal(store.listDashboardSchedules().length, 0, '关掉就不再被轮询');
    store.removeDashboardSchedule('conn-a', 'shop');
    assert.equal(store.getDashboardSchedule('conn-a', 'shop'), undefined);
  });
});

test('deleting a connection clears its boards', () => {
  withStore((store) => {
    store.insertDashboardCard(card('残留'));
    store.removeDashboardScope('conn-a');
    assert.equal(store.listDashboardCards('conn-a', 'shop').length, 0);
  });
});

test('dashboards only accept single read-only statements', () => {
  assert.equal(assertDashboardSql('SELECT month, gmv FROM v'), undefined);
  assert.ok(assertDashboardSql('DELETE FROM orders'));
  assert.ok(assertDashboardSql('UPDATE orders SET amount = 0'));
  assert.ok(assertDashboardSql('SELECT 1; SELECT 2'), '多语句会让只读保证失效');
  assert.ok(assertDashboardSql('   '));
  assert.deepEqual(disabledTablesTouched('SELECT * FROM secret_tbl a JOIN orders b ON a.id = b.id', ['secret_tbl']), ['secret_tbl']);
  assert.deepEqual(disabledTablesTouched('SELECT * FROM orders', ['secret_tbl']), []);
});

test('time range wraps the card query instead of rewriting it', () => {
  const wrapped = applyTimeRange('SELECT month, gmv FROM v;\n', 'month', { from: '2026-01-01', to: '2026-04-01' });
  assert.equal(wrapped, "SELECT * FROM (SELECT month, gmv FROM v) dash_t WHERE dash_t.month >= '2026-01-01' AND dash_t.month < '2026-04-01'");
  assert.equal(applyTimeRange('SELECT month, gmv FROM v', 'month', {}), 'SELECT month, gmv FROM v', '没选范围就不包裹');
  const injected = applyTimeRange('SELECT 1 AS a', 'a', { from: "2026-01-01' OR '1'='1" });
  assert.equal((injected.match(/'/g) ?? []).length, 2, '时间边界只能作为单个字面量出现，引号被剥掉');
  assert.ok(injected.includes(">= '2026-01-01 OR 1=1'"), injected);
  assert.equal(applyTimeRange('SELECT 1 AS a', 'a"b', { from: '2026-01-01' }), "SELECT * FROM (SELECT 1 AS a) dash_t WHERE dash_t.ab >= '2026-01-01'");
});
