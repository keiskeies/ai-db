import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReportSpec } from '../src/commands/report';
import { checkReportQuality } from '../src/commands/reportQuality';

const base = (sections: ReportSpec['sections'], executive?: ReportSpec['executive']): ReportSpec => ({
  version: 1,
  title: '订单报告',
  layout: 'sections',
  sources: [{ key: 's1', connectionId: 'c1', connectionName: 'Demo', database: 'shop', engine: 'sqlite', label: 'Demo' }],
  sections,
  ...(executive ? { executive } : {}),
  meta: { intent: '订单', createdAt: '2026-11-01T00:00:00.000Z' },
});

test('全是文字、没有数字的报告被拒', () => {
  const result = checkReportQuality(
    base([{ id: 'a', title: '概览', conclusion: '整体平稳', blocks: [{ kind: 'narrative', text: '本月经营情况整体平稳。' }] }]),
  );
  assert.ok(result.errors.some((error) => /没有任何数字/.test(error)), result.errors.join(' / '));
});

test('headline 没有数字、也没有说明为什么没有，算硬伤', () => {
  const spec = base([
    { id: 'a', title: '概览', conclusion: '订单量 120 笔', blocks: [{ kind: 'metric', metrics: [{ label: '订单量', value: 120 }] }] },
  ], { headline: '整体表现不错', takeaways: ['订单量 120 笔'] });
  assert.ok(checkReportQuality(spec).errors.some((error) => /headline/.test(error)));

  const honest = base([{ id: 'a', title: '概览', blocks: [{ kind: 'narrative', text: '缺少时间列，无法统计。' }] }], {
    headline: '缺少可用的时间列，无法给出数字',
    takeaways: ['请补充时间列'],
  });
  assert.ok(!checkReportQuality(honest).errors.some((error) => /headline/.test(error)));
});

test('既没结论也没数字的章节被拒，只有结论没数字只提示', () => {
  const empty = checkReportQuality(base([{ id: 'a', title: '明细', blocks: [{ kind: 'narrative', text: '略' }] }]));
  assert.ok(empty.errors.some((error) => /既没有结论也没有数字/.test(error)), empty.errors.join(' / '));

  const conclusionOnly = checkReportQuality(
    base([
      { id: 'a', title: '概览', conclusion: '订单量 120 笔', blocks: [{ kind: 'narrative', text: '本月共 120 笔' }] },
      // 有数字但没写结论：读者至少能看到数，所以只提示不打回。
      { id: 'b', title: '明细', blocks: [{ kind: 'metric', metrics: [{ label: '退款量', value: 3 }] }]},
    ]),
  );
  assert.ok(!conclusionOnly.errors.some((error) => /既没有结论也没有数字/.test(error)), conclusionOnly.errors.join(' / '));
  assert.ok(conclusionOnly.notes.some((note) => /缺少一句话结论/.test(note)), conclusionOnly.notes.join(' / '));
});

test('正文泄漏表名列名与 SQL 术语是硬伤', () => {
  const spec = base([
    {
      id: 'a',
      title: '概览',
      conclusion: 'orders.created_at 过滤后 COUNT(*) 得到 120',
      blocks: [{ kind: 'metric', metrics: [{ label: '订单量', value: 120, baseline: 100 }] }],
    },
  ], { headline: '订单量 120 笔', takeaways: ['is_deleted = 0 的订单 120 笔'] });
  const result = checkReportQuality(spec);
  assert.ok(result.errors.some((error) => /技术术语/.test(error)), result.errors.join(' / '));
});

test('month / status 这类词形列名只提示，不反复打回好报告', () => {
  const spec = base([
    {
      id: 'a',
      title: '概览',
      conclusion: 'This month orders grew',
      blocks: [{ kind: 'metric', metrics: [{ label: '订单量', value: 120, baseline: 100 }] }],
    },
  ], { headline: 'Orders grew 20% this month', takeaways: ['status changed for 12 orders'] });
  const result = checkReportQuality(spec, ['month', 'status']);
  assert.ok(!result.errors.some((error) => /技术术语/.test(error)), result.errors.join(' / '));
  assert.ok(result.notes.some((note) => /疑似字段名/.test(note)), result.notes.join(' / '));
});

test('笼统的建议、全无基线、口径漂移都进读者可见的提示', () => {
  const spec = base([
    {
      id: 'a',
      title: '概览',
      conclusion: '订单量 120 笔',
      blocks: [
        { kind: 'metric', metrics: [{ label: '订单量', value: 120 }, { label: '订单额', value: 3000 }] },
        { kind: 'actions', actions: [{ text: '建议优化' }] },
      ],
    },
    {
      id: 'b',
      title: '明细',
      conclusion: '同一口径复查',
      blocks: [{ kind: 'metric', metrics: [{ label: '订单量', value: 118 }] }],
    },
  ], { headline: '订单量 120 笔', takeaways: ['订单量 120 笔'] });
  const notes = checkReportQuality(spec).notes;
  assert.ok(notes.some((note) => /太笼统/.test(note)), notes.join(' / '));
  assert.ok(notes.some((note) => /没有对比基线/.test(note)), notes.join(' / '));
  assert.ok(notes.some((note) => /订单量.*2 个不同的值/.test(note)), notes.join(' / '));
});

test('折线图横轴不是时间分桶时提示', () => {
  const raw = checkReportQuality(
    base([
      {
        id: 'a',
        title: '概览',
        conclusion: '订单量 120 笔',
        blocks: [
          {
            kind: 'chart',
            chartType: 'line',
            series: Array.from({ length: 8 }, (_, index) => ({ label: `2026-10-0${(index % 5) + 1} 1${index}:00:00`, value: index + 1 })),
          },
        ],
      },
    ]),
  );
  assert.ok(raw.notes.some((note) => /原始时间戳|不像时间分桶/.test(note)), raw.notes.join(' / '));

  const bucketed = checkReportQuality(
    base([
      {
        id: 'a',
        title: '概览',
        conclusion: '订单量 120 笔',
        blocks: [
          {
            kind: 'chart',
            chartType: 'line',
            series: Array.from({ length: 6 }, (_, index) => ({ label: `2026-${String(index + 1).padStart(2, '0')}`, value: index + 1 })),
          },
        ],
      },
    ]),
  );
  assert.ok(!bucketed.notes.some((note) => /分桶/.test(note)), bucketed.notes.join(' / '));
});
