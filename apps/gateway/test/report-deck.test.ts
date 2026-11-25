import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReportSpec } from '@aidb/core';
import { buildReportDeck, parseBrandTheme } from '../src/features/reportDeck';

const spec: ReportSpec = {
  version: 1,
  title: '订单 <概览> & 趋势',
  layout: 'sections',
  sources: [{ key: 'left', connectionId: 'c1', connectionName: 'Demo', database: 'shop', engine: 'sqlite', label: 'Demo' }],
  meta: { intent: 'report', createdAt: '2026-10-30T00:00:00.000Z', audience: 'technical' },
  sections: [
    {
      id: 's1',
      title: '概览',
      blocks: [
        { kind: 'metric', metrics: [{ label: '订单数', value: 128 }, { label: '金额', value: 45678.9, unit: '元' }] },
        { kind: 'narrative', text: '本周订单 < 上周，需要关注 & 复核。' },
      ],
    },
    {
      id: 's2',
      title: '明细',
      blocks: [{ kind: 'table', columns: ['表', '行数'], rows: [['orders', 120], ['users', 8]] }],
    },
  ],
};

test('buildReportDeck 生成封面、指标和章节页并转义 XML', () => {
  const pages = buildReportDeck(spec);
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map((page) => page.name), ['P01_cover.svg', 'P02_metrics.svg', 'P03_section.svg', 'P04_section.svg']);
  const all = pages.map((page) => page.svg).join('\n');
  assert.match(all, /订单 &lt;概览&gt; &amp; 趋势/);
  assert.match(all, /订单数/);
  // 大数字按 万 缩写，与屏幕读数一致；deck 把 45678.9 截成「45678…」是以前的漂移。
  assert.match(all, /4\.57 万/);
  assert.match(all, /本周订单 &lt; 上周，需要关注 &amp; 复核。/);
  assert.match(all, /orders/);
  assert.match(all, /lang="zh-CN"/);
  assert.doesNotMatch(all, /<概览>/);
});

test('buildReportDeck 在没有指标时仍生成封面和章节页', () => {
  const pages = buildReportDeck({
    ...spec,
    sections: [{ id: 's1', title: '概览', blocks: [{ kind: 'narrative', text: '一段说明' }] }],
  });
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => page.name), ['P01_cover.svg', 'P02_section.svg']);
});


test('parseBrandTheme 读取 light brand 的颜色并注入页面', () => {
  const theme = parseBrandTheme(`---
brand_id: accenture
primary_color: "#A100FF"
---

| Role | HEX |
|---|---|
| primary | \`#A100FF\` |
| bg | \`#FFFFFF\` |
| surface | \`#F5F3F7\` |
| border | \`#DCD8E0\` |
| muted-text | \`#5B5560\` |
`);
  assert.equal(theme.bg, '#FFFFFF');
  assert.equal(theme.surface, '#F5F3F7');
  assert.equal(theme.accent, '#A100FF');
  assert.equal(theme.text, '#111827');
  const pages = buildReportDeck(spec, theme);
  assert.match(pages[0].svg, /#A100FF/);
  assert.match(pages[0].svg, /#FFFFFF/);
});

/** 一页装得下的图与表有限，但内容不能丢：额外的各占一页，两个 PPT 后端共用这份展开结果。 */
test('一节里的第二张图独立成页，不被静默丢掉', () => {
  const pages = buildReportDeck({
    ...spec,
    sections: [
      {
        id: 's1',
        title: '趋势',
        blocks: [
          { kind: 'chart', title: '月度趋势', chartType: 'line', series: [{ label: '2026-08', value: 1 }, { label: '2026-09', value: 2 }, { label: '2026-10', value: 3 }] },
          { kind: 'chart', title: '渠道构成', chartType: 'pie', series: [{ label: '广告', value: 4 }, { label: '自然', value: 5 }, { label: '活动', value: 6 }] },
        ],
      },
    ],
  });
  const titles = pages.map((page) => page.name);
  assert.deepEqual(titles, ['P01_cover.svg', 'P02_section.svg', 'P03_section.svg']);
  const body = pages.map((page) => page.svg).join('\n');
  assert.match(body, /月度趋势/);
  assert.match(body, /渠道构成/);
  // 页码反映真实页数，不是计划页数。
  assert.match(pages[2].svg, /3 \/ 3/);
});

/** 阅读对象必须真的改变版面：选管理层和选技术拿到同样一份 PPT 是假的「分层」。 */
test('阅读对象决定页数与截断说明', () => {
  const many: ReportSpec = {
    ...spec,
    sections: Array.from({ length: 6 }, (_, index) => ({
      id: `s${index}`,
      title: `章节 ${index + 1}`,
      blocks: [{ kind: 'narrative' as const, text: `第 ${index + 1} 节的说明` }],
    })),
  };
  const executive = buildReportDeck({ ...many, meta: { ...many.meta, audience: 'executive' } });
  const technical = buildReportDeck({ ...many, meta: { ...many.meta, audience: 'technical' } });
  assert.ok(executive.length < technical.length, `管理层 ${executive.length} 页应少于技术 ${technical.length} 页`);
  // 被裁掉的章节必须告诉读者，否则他会以为报告只有这些。
  assert.match(executive.map((page) => page.svg).join('\n'), /共 6 个章节，此处呈现前 2 个/);
  assert.doesNotMatch(technical.map((page) => page.svg).join('\n'), /共 6 个章节/);
});

test('同节表格与图表分别成页，SVG 不再只画表格', () => {
  const pages = buildReportDeck({
    ...spec,
    sections: [{
      id: 'mixed',
      title: '混合内容',
      blocks: [
        { kind: 'table', title: 'Technical detail', columns: ['Month', 'Orders'], rows: [['Aug', 10], ['Sep', 12]] },
        { kind: 'chart', title: 'Monthly trend', chartType: 'line', series: [{ label: 'Aug', value: 10 }, { label: 'Sep', value: 12 }] },
      ],
    }],
  });
  const tablePage = pages.find((page) => page.svg.includes('Technical detail'))?.svg ?? '';
  const chartPage = pages.find((page) => page.svg.includes('Monthly trend'))?.svg ?? '';
  assert.match(tablePage, /Aug/);
  assert.doesNotMatch(tablePage, /<polyline/);
  assert.match(chartPage, /<polyline/);
  assert.doesNotMatch(chartPage, /Technical detail/);
});

test('技术读者的八张指标卡和十五行表格分页后完整保留', () => {
  const pages = buildReportDeck({
    ...spec,
    meta: { ...spec.meta, audience: 'technical' },
    sections: [{
      id: 'long',
      title: '技术明细',
      blocks: [
        { kind: 'metric', metrics: Array.from({ length: 8 }, (_, index) => ({ label: `指标 ${index + 1}`, value: index + 1 })) },
        { kind: 'table', title: '十五行', columns: ['序号'], rows: Array.from({ length: 15 }, (_, index) => [`M${index + 1}`]) },
      ],
    }],
  });
  const all = pages.map((page) => page.svg).join('\n');
  assert.match(all, /指标 8/);
  assert.match(all, /M15/);
  assert.ok(pages.length >= 6);
});

test('单点折线保留圆点，负值柱状使用零轴和反向标签', () => {
  const pages = buildReportDeck({
    ...spec,
    sections: [{
      id: 'signed',
      title: '有符号数据',
      blocks: [
        { kind: 'chart', title: '单点折线', chartType: 'line', series: [{ label: 'Only', value: -5 }] },
        { kind: 'chart', title: '正负柱状', chartType: 'bar', series: [{ label: 'Loss', value: -10 }, { label: 'Profit', value: 20 }] },
      ],
    }],
  });
  const line = pages.find((page) => page.svg.includes('单点折线'))?.svg ?? '';
  const bar = pages.find((page) => page.svg.includes('正负柱状'))?.svg ?? '';
  assert.match(line, /<circle/);
  assert.match(line, />-5</);
  assert.match(bar, /text-anchor="end"/);
  assert.match(bar, />-10</);
});

test('七类图表在 SVG deck 中保持真实图形而非统一退化成柱状图', () => {
  const pages = buildReportDeck({
    ...spec,
    sections: [{
      id: 'charts',
      title: '图表集合',
      blocks: [
        { kind: 'chart', title: '折线趋势', chartType: 'line', xLabel: '月份', yLabel: '金额', series: [{ label: '8月', value: 1, baseline: 2 }, { label: '9月', value: 3 }], extraSeries: [{ name: '目标', values: [4, 5] }] },
        { kind: 'chart', title: '渠道占比', chartType: 'pie', series: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }, { label: 'C', value: 3 }] },
        { kind: 'chart', title: '堆叠构成', chartType: 'stacked', series: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], extraSeries: [{ name: '第二部分', values: [2, 3] }] },
        { kind: 'chart', title: '量价散点', chartType: 'scatter', scatter: [{ label: '甲', x: 1, y: 2 }, { label: '乙', x: 3, y: 4 }] },
        { kind: 'chart', title: '能力雷达', chartType: 'radar', series: [{ label: '速度', value: 3 }, { label: '质量', value: 4 }, { label: '成本', value: 2 }] },
        { kind: 'chart', title: '转化热力', chartType: 'heatmap', heatmap: { xLabels: ['A', 'B'], yLabels: ['上午', '下午'], values: [[1, 2], [3, 4]], valueLabel: '转化率' } },
      ],
    }],
  });
  const page = (title: string) => pages.find((item) => item.svg.includes(title))?.svg ?? '';
  assert.match(page('折线趋势'), /<polyline/);
  assert.match(page('折线趋势'), /目标/);
  assert.match(page('渠道占比'), /<path d="M 420/);
  assert.match(page('量价散点'), /<circle/);
  assert.match(page('能力雷达'), /<polygon/);
  assert.match(page('转化热力'), /fill-opacity=/);
  assert.match(page('转化热力'), /转化率/);
});
