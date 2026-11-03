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

test('报告图表拒绝热力图/雷达图，而不是静默改成柱状图', () => {
  const heatmap = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_1', chartType: 'heatmap', series: [{ label: 'a', value: 42 }] },
    new Set([42]),
    refs,
    true,
  );
  assert.ok('error' in heatmap);
  assert.match(heatmap.error, /不支持 heatmap/);
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

