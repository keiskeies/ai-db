import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReportMetric, ReportSpec } from '../src/commands/report';
import {
  describeEvidence,
  flattenDeckSlides,
  formatMetricValue,
  planReportDeck,
  reportCopy,
  reportDensity,
  reportSheets,
} from '../src/commands/reportRender';

const metric = (label: string, value: number, extra: Partial<ReportMetric> = {}): ReportMetric => ({
  label,
  value,
  ...extra,
});

const spec = (overrides: Partial<ReportSpec> = {}): ReportSpec => ({
  version: 1,
  title: '订单报告',
  layout: 'sections',
  sources: [{ key: 's1', connectionId: 'c1', connectionName: 'Demo', database: 'shop', engine: 'sqlite', label: 'Demo' }],
  sections: [
    {
      id: 'overview',
      title: '概览',
      blocks: [
        { kind: 'metric', metrics: [metric('订单量', 12_345_678, { baseline: 1000, baselineLabel: '环比 上月' })] },
        { kind: 'narrative', text: '订单量上涨。' },
        { kind: 'table', title: '渠道明细', columns: ['渠道', '单量'], rows: [['广告', 10], ['自然', 5]] },
      ],
    },
  ],
  meta: { intent: '订单', createdAt: '2026-11-01T00:00:00.000Z' },
  ...overrides,
});

test('大数字在展示层缩写，原值不变', () => {
  assert.equal(formatMetricValue(12_345_678).text, '1234.57 万');
  assert.equal(formatMetricValue(12_345_678).exact, '12,345,678');
  assert.equal(formatMetricValue(123).text, '123');
  assert.equal(formatMetricValue('待确认').text, '待确认');
});

test('deck 的页数与截断由阅读对象决定，且截断必须可见', () => {
  const many = (count: number): ReportSpec =>
    spec({
      sections: Array.from({ length: count }, (_, index) => ({
        id: `s${index}`,
        title: `第 ${index + 1} 节`,
        blocks: [{ kind: 'table' as const, title: `表 ${index + 1}`, columns: ['a'], rows: Array.from({ length: 20 }, (_, row) => [row]) }],
      })),
    });

  assert.equal(reportDensity('executive').sections, 2);
  assert.equal(reportDensity('technical').sections, 8);
  // 未知阅读对象退回业务档，不能崩成一页。
  assert.equal(reportDensity('someone-else').sections, reportDensity('business').sections);

  const executive = planReportDeck({ ...many(5), meta: { ...many(5).meta, audience: 'executive' } });
  const sectionSlides = executive.slides.filter((slide) => slide.kind === 'section');
  assert.equal(sectionSlides.length, 2);
  // 表格只留 4 行，但页面上要写明一共多少行。
  const table = sectionSlides[0]!.table!;
  assert.equal(table.rows.length, 4);
  assert.equal(table.overflow, '共 20 行，此处呈现前 4 行');
  // 章节被裁掉也要说出来。
  const lastLines = sectionSlides[sectionSlides.length - 1]!.lines.map((line) => line.text);
  assert.ok(lastLines.some((line) => line.includes('共 5 个章节，此处呈现前 2 个')), lastLines.join(' / '));

  const technical = planReportDeck({ ...many(5), meta: { ...many(5).meta, audience: 'technical' } });
  assert.equal(technical.slides.filter((slide) => slide.kind === 'section').length, 5);
  assert.equal(technical.slides.filter((slide) => slide.kind === 'section')[0]!.table!.rows.length, 15);
});

test('口径与假设只给需要明细的读者', () => {
  const withAssumptions = spec({ meta: { intent: '订单', createdAt: '2026-11-01T00:00:00.000Z', assumptions: ['金额口径：SUM(amount)'] } });
  assert.ok(planReportDeck({ ...withAssumptions, meta: { ...withAssumptions.meta, audience: 'business' } }).slides.some((slide) => slide.kind === 'assumptions'));
  assert.ok(!planReportDeck({ ...withAssumptions, meta: { ...withAssumptions.meta, audience: 'executive' } }).slides.some((slide) => slide.kind === 'assumptions'));
});

test('多余的图与表展开成独立页，不静默丢内容', () => {
  const multi = spec({
    sections: [
      {
        id: 'trend',
        title: '趋势',
        blocks: [
          { kind: 'chart', title: '月度', chartType: 'line', series: [{ label: '2026-08', value: 1 }, { label: '2026-09', value: 2 }, { label: '2026-10', value: 3 }] },
          { kind: 'chart', title: '渠道', chartType: 'pie', series: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }, { label: 'c', value: 3 }] },
          { kind: 'table', title: '明细 A', columns: ['x'], rows: [[1]] },
          { kind: 'table', title: '明细 B', columns: ['y'], rows: [[2]] },
        ],
      },
    ],
  });
  const plan = planReportDeck({ ...multi, meta: { ...multi.meta, audience: 'technical' } });
  const flat = flattenDeckSlides(plan.slides);
  // 首页带主图（月度）与主表（明细 A），其余各占一页。
  const sectionTitles = flat.filter((slide) => slide.kind === 'section').map((slide) => slide.title);
  assert.deepEqual(sectionTitles, ['趋势', '趋势 · 渠道', '趋势 · 明细 B']);
  const head = flat[flat.length - 3]!;
  assert.equal(head.kind === 'section' ? head.chart?.title : undefined, '月度');
  assert.equal(head.kind === 'section' ? head.table?.title : undefined, '明细 A');
  // 独立页只带自己那一份数据，否则同一张图会在两页里重复。
  const chartPage = flat.find((slide) => slide.title === '趋势 · 渠道')!;
  assert.equal(chartPage.kind === 'section' ? chartPage.chart?.title : undefined, '渠道');
  assert.equal(chartPage.kind === 'section' ? chartPage.table : undefined, undefined);
  // 展开后不留残余：任何一页都不该再挂着待展开的额外数据。
  for (const slide of flat) {
    if (slide.kind !== 'section') continue;
    assert.deepEqual(slide.extraCharts, []);
    assert.deepEqual(slide.extraTables, []);
  }
});

test('Excel 按结构分 sheet，数字保持数字类型', () => {
  const sheets = reportSheets(spec({ meta: { intent: '订单', createdAt: '2026-11-01T00:00:00.000Z', locale: 'zh' } }));
  const names = sheets.map((sheet) => sheet.name);
  assert.deepEqual(names, ['管理层摘要', '关键指标', '渠道明细']);
  const detail = sheets.find((sheet) => sheet.name === '渠道明细')!;
  assert.deepEqual(detail.columns, ['渠道', '单量']);
  assert.equal(typeof detail.rows[0]![1], 'number', '单元格必须是数字，Excel 才能求和');
});

test('同名表格的 sheet 名不冲突，且不超过 Excel 的 31 字符上限', () => {
  const long = '渠道明细统计口径说明补充标题长度超过三十个字符上限的部分应当被截断';
  const sheets = reportSheets({
    ...spec(),
    sections: [
      { id: 'a', title: long, blocks: [{ kind: 'table', title: long, columns: ['x'], rows: [[1]] }] },
      { id: 'b', title: long, blocks: [{ kind: 'table', title: long, columns: ['x'], rows: [[2]] }] },
    ],
  });
  const detailNames = sheets.map((sheet) => sheet.name).filter((name) => name !== '管理层摘要' && name !== '关键指标');
  assert.equal(new Set(detailNames).size, detailNames.length, detailNames.join(' / '));
  for (const name of detailNames) assert.ok(name.length <= 31, `${name} 超过 31 字符`);
});

test('证据摘要把 SQL 与口径拼成一行读者能读的话', () => {
  const copy = reportCopy('zh');
  assert.equal(
    describeEvidence({ ref: 'q1', tool: 'run_sql', sql: 'SELECT COUNT(*) FROM orders', rowCount: 3, truncated: true, durationMs: 12, ranAt: '' }, copy),
    'SELECT COUNT(*) FROM orders\nrun_sql · 3 行 · 结果被行数上限截断 · 12 ms',
  );
  assert.equal(describeEvidence(undefined, copy), copy.noSql);
  assert.match(describeEvidence({ ref: 'q1', tool: 'run_sql', rowCount: 2, ranAt: '' }, reportCopy('en')), /2 rows/);
});

test('英文报告的分页文案跟着 locale 走', () => {
  const plan = planReportDeck({ ...spec(), meta: { intent: 'orders', createdAt: '2026-11-01T00:00:00.000Z', locale: 'en', audience: 'executive' } });
  const cover = plan.slides.find((slide) => slide.kind === 'cover')!;
  assert.match(cover.meta, /1 sections/);
  assert.ok(plan.slides.some((slide) => slide.kind === 'metrics'));
  assert.equal(reportCopy('en').executive, 'Executive summary');
});
