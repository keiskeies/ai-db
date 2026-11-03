import test from 'node:test';
import assert from 'node:assert/strict';
import { chartSuitability, recommendChartType } from '../src/analysis/chartFit';

const points = (labels: string[], value = 1) => labels.map((label) => ({ label, value }));

test('折线图只接受有序的时间/数值轴，柱状图接受分类', () => {
  const monthly = chartSuitability({ series: points(['2026-01', '2026-02', '2026-03']) });
  assert.equal(monthly.line.ok, true);
  assert.equal(monthly.bar.ok, true);

  const categories = chartSuitability({ series: points(['待支付', '已完成', '已退款', '已取消']) });
  assert.equal(categories.line.ok, false);
  assert.equal(categories.bar.ok, true);
  assert.equal(recommendChartType(categories), 'bar');
});

test('饼图只接受 3–8 个非负切片，且不能混入多度量', () => {
  const four = chartSuitability({ series: points(['a', 'b', 'c', 'd']) });
  assert.equal(four.pie.ok, true);

  const ten = chartSuitability({ series: points(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) });
  assert.equal(ten.pie.ok, false);
  assert.match(ten.pie.reason ?? '', /最多 8 个/);

  const negative = chartSuitability({ series: [{ label: 'a', value: -1 }, { label: 'b', value: 2 }, { label: 'c', value: 3 }] });
  assert.equal(negative.pie.ok, false);

  const multi = chartSuitability({
    series: points(['a', 'b', 'c']),
    extraSeries: [{ name: 'gmv', values: [1, 2, 3] }],
  });
  assert.equal(multi.pie.ok, false);
  assert.match(multi.pie.reason ?? '', /多个度量/);
  assert.equal(multi.stacked.ok, true);
});

test('雷达图只接受 3–8 个无序、同单位非负轴', () => {
  const four = chartSuitability({ series: points(['质量', '速度', '成本', '体验']) });
  assert.equal(four.radar.ok, true);

  const monthly = chartSuitability({ series: points(['2026-01', '2026-02', '2026-03']) });
  assert.equal(monthly.radar.ok, false);
  assert.match(monthly.radar.reason ?? '', /有序/);

  const ten = chartSuitability({ series: points(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) });
  assert.equal(ten.radar.ok, false);
  assert.match(ten.radar.reason ?? '', /超过 8 个/);
});

test('散点与热力图按自己的数据结构判定', () => {
  const scatter = chartSuitability({
    series: points(['a', 'b']),
    scatter: [{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }],
  });
  assert.equal(scatter.scatter.ok, true);

  const heatmap = chartSuitability({
    series: points(['周一', '周二', '周三']),
    heatmap: { xLabels: ['00', '01'], yLabels: ['周一', '周二'] },
  });
  assert.equal(heatmap.heatmap.ok, true);
});
