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
