import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReportSpec } from '@aidb/core';
import { buildReportDeck, parseBrandTheme } from '../src/features/reportDeck';

const spec: ReportSpec = {
  version: 1,
  title: '订单 <概览> & 趋势',
  layout: 'sections',
  sources: [{ key: 'left', connectionId: 'c1', connectionName: 'Demo', database: 'shop', engine: 'sqlite', label: 'Demo' }],
  meta: { intent: 'report', createdAt: '2026-10-30T00:00:00.000Z' },
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
  assert.deepEqual(pages.map((page) => page.name), ['P01_cover.svg', 'P02_metrics.svg', 'P03_1.svg', 'P04_2.svg']);
  const all = pages.map((page) => page.svg).join('\n');
  assert.match(all, /订单 &lt;概览&gt; &amp; 趋势/);
  assert.match(all, /订单数/);
  assert.match(all, /45678.9/);
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
  assert.deepEqual(pages.map((page) => page.name), ['P01_cover.svg', 'P02_1.svg']);
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
