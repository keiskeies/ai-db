import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportBlock } from '../src/commands/reportAgent';

const refs = new Map<string, Set<number>>([['call_1', new Set([42, 7])]]);

test('报告块必须绑定存在的 resultRef，且数字来自该结果', () => {
  const metric = normalizeReportBlock(
    { kind: 'metric', resultRef: 'call_1', metrics: [{ label: '订单数', value: 42 }] },
    new Set([42]),
    refs,
    true,
  );
  assert.ok(!('error' in metric));
  assert.equal((metric as any).resultRef, 'call_1');

  const missing = normalizeReportBlock({ kind: 'metric', metrics: [{ label: '订单数', value: 42 }] }, new Set([42]), refs, true);
  assert.ok('error' in missing);
  assert.match(missing.error, /resultRef/);

  const unknown = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_missing', chartType: 'bar', series: [{ label: 'a', value: 42 }] },
    new Set([42]),
    refs,
    true,
  );
  assert.ok('error' in unknown);
  assert.match(unknown.error, /不存在/);

  const wrongValue = normalizeReportBlock(
    { kind: 'table', resultRef: 'call_1', columns: ['n'], rows: [[99]] },
    new Set([99]),
    refs,
    true,
  );
  assert.ok('error' in wrongValue);
  assert.match(wrongValue.error, /来源/);

  const comparison = normalizeReportBlock(
    { kind: 'comparison', left: { value: 7, resultRef: 'call_1' }, right: { value: 42, resultRef: 'call_1' } },
    new Set([7, 42]),
    refs,
    true,
  );
  assert.ok(!('error' in comparison));
  assert.equal((comparison as any).delta.absolute, 35);
});

test('报告图表支持散点/热力/雷达，并继续校验每个数字的来源', () => {
  const scatter = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'scatter', xLabel: '订单数', yLabel: '金额', scatter: [{ x: 42, y: 7, label: 'A' }, { x: 7, y: 42, label: 'B' }] },
    new Set([42, 7]),
    refs,
    true,
  );
  assert.ok(!('error' in scatter));
  assert.equal((scatter as any).scatter.length, 2);

  const heatmap = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'heatmap', heatmap: { xLabels: ['周一', '周二'], yLabels: ['白天', '夜晚'], values: [[42, 7], [7, 42]] } },
    new Set([42, 7]),
    refs,
    true,
  );
  assert.ok(!('error' in heatmap));
  assert.equal((heatmap as any).heatmap.values.length, 2);

  const radar = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'radar', series: [{ label: '速度', value: 42 }, { label: '质量', value: 7 }, { label: '成本', value: 42 }] },
    new Set([42, 7]),
    refs,
    true,
  );
  assert.ok(!('error' in radar));

  const wrongScatter = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'scatter', scatter: [{ x: 99, y: 7 }, { x: 7, y: 42 }] },
    new Set([99, 42, 7]),
    refs,
    true,
  );
  assert.ok('error' in wrongScatter);
  assert.match(wrongScatter.error, /来源/);
});

test('图表与补充基线保留各自的 resultRef', () => {
  const localRefs = new Map(refs);
  localRefs.set('call_2', new Set([7]));
  const chart = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'line', series: [{ label: 'A', value: 42, baseline: 7, baselineResultRef: 'call_2' }] },
    new Set([42, 7]),
    localRefs,
    true,
  );
  assert.ok(!('error' in chart));
  assert.equal((chart as any).series[0].baselineResultRef, 'call_2');

  const metric = normalizeReportBlock(
    { kind: 'metric', resultRef: 'call_1', metrics: [{ label: '订单数', value: 42, alternativeBaselines: [{ label: '上周', value: 7, resultRef: 'call_2' }] }] },
    new Set([42, 7]),
    localRefs,
    true,
  );
  assert.ok(!('error' in metric));
  assert.equal((metric as any).metrics[0].alternativeBaselines[0].resultRef, 'call_2');
});

test('多系列长度一致且附加值也必须来自 resultRef', () => {
  const valid = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'bar', series: [{ label: 'A', value: 42 }, { label: 'B', value: 7 }], extraSeries: [{ name: '上期', values: [7, 42] }] },
    new Set([42, 7]),
    refs,
    true,
  );
  assert.ok(!('error' in valid));
  assert.equal((valid as any).extraSeries[0].name, '上期');

  const wrongLength = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'bar', series: [{ label: 'A', value: 42 }, { label: 'B', value: 7 }], extraSeries: [{ name: '上期', values: [42] }] },
    new Set([42, 7]),
    refs,
    true,
  );
  assert.ok('error' in wrongLength);
  assert.match(wrongLength.error, /等长/);
});

test('报告饼图按 3–8 个切片校验，避免把 Top N 伪装成整体', () => {
  const valid = normalizeReportBlock(
    {
      kind: 'chart',
      resultRef: 'call_1',
      chartType: 'pie',
      series: [
        { label: 'a', value: 42 },
        { label: 'b', value: 7 },
        { label: 'c', value: 42 },
      ],
    },
    new Set([42, 7]),
    refs,
    true,
  );
  assert.ok(!('error' in valid));

  const tooMany = normalizeReportBlock(
    {
      kind: 'chart',
      resultRef: 'call_1',
      chartType: 'pie',
      series: Array.from({ length: 9 }, (_, index) => ({ label: String(index), value: 42 })),
    },
    new Set([42]),
    refs,
    true,
  );
  assert.ok('error' in tooMany);
  assert.match(tooMany.error, /3–8/);
});


/**
 * 表格与图表以前可以在不带 resultRef 的情况下退回全局数字池，
 * 「必须绑定来源」对它们其实没生效：模型能把 A 查询的数字写进标着 B 的表里。
 */
test('表格与图表不带 resultRef 时不再退回全局数字池', () => {
  const table = normalizeReportBlock({ kind: 'table', columns: ['n'], rows: [[7]] }, new Set([7]), refs, true);
  assert.ok('error' in table);
  assert.match(table.error, /表格/);

  const chart = normalizeReportBlock({ kind: 'chart', chartType: 'bar', series: [{ label: 'a', value: 7 }] }, new Set([7]), refs, true);
  assert.ok('error' in chart);
  assert.match(chart.error, /图表/);

  // 多来源块：refs 全部存在才放行，数字只能来自这些结果。
  const merged = normalizeReportBlock(
    { kind: 'chart', resultRefs: ['call_1'], chartType: 'bar', series: [{ label: 'a', value: 7 }] },
    new Set([7]),
    refs,
    true,
  );
  assert.ok(!('error' in merged));

  const unknownRefs = normalizeReportBlock(
    { kind: 'chart', resultRefs: ['call_nope'], chartType: 'bar', series: [{ label: 'a', value: 7 }] },
    new Set([7]),
    refs,
    true,
  );
  assert.ok('error' in unknownRefs);
  assert.match(unknownRefs.error, /不存在/);
});
