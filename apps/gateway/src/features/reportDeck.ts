import { flattenDeckSlides, planReportDeck } from '@aidb/core';
import type { ReportCopy, DeckLine, DeckMetric, DeckPlan, DeckSlide, ReportSpec } from '@aidb/core';

const W = 1280;
const H = 720;
export interface DeckTheme {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  gold: string;
  danger: string;
  border: string;
  font: string;
}

export const DEFAULT_DECK_THEME: DeckTheme = {
  bg: '#0A0C0C',
  surface: '#141A1B',
  text: '#F2F5F4',
  muted: '#93A19E',
  accent: '#45C8C3',
  gold: '#D6B45A',
  danger: '#E0604F',
  border: '#26302F',
  font: 'Microsoft YaHei, Arial, sans-serif',
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clip(value: unknown, max: number): string {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : chars.join('');
}

function wrap(value: unknown, max: number, maxLines: number): string[] {
  const paragraphs = String(value ?? '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const chars = Array.from(paragraph);
    for (let index = 0; index < chars.length; index += max) {
      lines.push(chars.slice(index, index + max).join(''));
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  if (!lines.length) lines.push('—');
  return lines;
}

function textLines(lines: string[], x: number, y: number, size: number, fill = DEFAULT_DECK_THEME.text, weight = 400, lineHeight = 1.45): string {
  return `<text x="${x}" y="${y}" font-family="${DEFAULT_DECK_THEME.font}" font-size="${size}" font-weight="${weight}" fill="${fill}">${lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : size * lineHeight}">${esc(line)}</tspan>`)
    .join('')}</text>`;
}

function frame(theme: DeckTheme, pageNo: number, total: number, eyebrow: string, title: string): { open: string; bodyY: number } {
  return {
    bodyY: 236,
    open: `<rect width="${W}" height="${H}" fill="${theme.bg}"/>
<rect x="0" y="0" width="8" height="${H}" fill="${theme.accent}"/>
<text x="64" y="70" font-family="${theme.font}" font-size="20" letter-spacing="5" fill="${theme.accent}">${esc(eyebrow.toUpperCase())}</text>
<text x="64" y="132" font-family="${theme.font}" font-size="46" font-weight="700" fill="${theme.text}">${esc(clip(title, 22))}</text>
<rect x="64" y="160" width="96" height="4" fill="${theme.gold}"/>
<text x="1216" y="70" text-anchor="end" font-family="${theme.font}" font-size="18" fill="${theme.muted}">${pageNo} / ${total}</text>
<rect x="64" y="664" width="1152" height="1" fill="#26302F"/>
<text x="64" y="696" font-family="${theme.font}" font-size="16" fill="${theme.muted}">AiDB Studio</text>
<text x="1216" y="696" text-anchor="end" font-family="${theme.font}" font-size="16" fill="${theme.muted}">AIDB · NATIVE PPTX</text>`,
  };
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${W} ${H}">\n${body}\n</svg>`;
}

function cover(slide: Extract<DeckSlide, { kind: 'cover' }>, total: number, theme: DeckTheme): string {
  const titleLines = wrap(slide.title, 16, 3);
  const goldY = 236 + titleLines.length * 79 + 18;
  return svg(`<rect width="${W}" height="${H}" fill="${theme.bg}"/>
<rect x="0" y="0" width="14" height="${H}" fill="${theme.accent}"/>
<rect x="880" y="0" width="400" height="${H}" fill="${theme.surface}"/>
<text x="64" y="96" font-family="${theme.font}" font-size="22" letter-spacing="7" fill="${theme.accent}">${esc(slide.eyebrow)}</text>
${textLines(titleLines, 64, 236, 68, theme.text, 700, 1.16)}
<rect x="64" y="${goldY}" width="160" height="6" fill="${theme.gold}"/>
<text x="64" y="${goldY + 68}" font-family="${theme.font}" font-size="22" fill="${theme.muted}">${esc(clip(slide.subtitle, 72))}</text>
<text x="64" y="${H - 88}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(slide.meta, 80))}</text>
<text x="1120" y="210" text-anchor="end" font-family="${theme.font}" font-size="20" letter-spacing="4" fill="${theme.accent}">REPORT</text>
<text x="1120" y="${H - 88}" text-anchor="end" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${total}</text>
</svg>`);
}

function metricCard(metric: DeckMetric, x: number, y: number, width: number, height: number, accent: string, theme: DeckTheme): string {
  const delta = metric.deltaText
    ? `<text x="${x + 28}" y="${y + height - 22}" font-family="${theme.font}" font-size="18" font-weight="600" fill="${toneColor(metric.deltaTone, theme)}">${esc(clip(`${metric.baselineLabel ?? ''} ${metric.deltaText}`, 30))}</text>`
    : '';
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${theme.surface}"/>
<rect x="${x}" y="${y}" width="6" height="${height}" rx="3" fill="${accent}"/>
<text x="${x + 28}" y="${y + 44}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(metric.label, 18))}</text>
<text x="${x + 28}" y="${y + 108}" font-family="${theme.font}" font-size="48" font-weight="700" fill="${theme.text}">${esc(clip(metric.value, 14))}</text>
<text x="${x + 28}" y="${y + 144}" font-family="${theme.font}" font-size="20" fill="${metric.unit ? theme.accent : theme.muted}">${esc(clip(metric.unit ?? '', 24))}</text>
${delta}`;
}

function toneColor(tone: DeckMetric['deltaTone'], theme: DeckTheme): string {
  return tone === 'good' ? theme.accent : tone === 'bad' ? theme.danger : theme.muted;
}

function metricsPage(slide: Extract<DeckSlide, { kind: 'metrics' }>, pageNo: number, total: number, theme: DeckTheme): string {
  const { open } = frame(theme, pageNo, total, slide.eyebrow, slide.title);
  const perRow = slide.metrics.length > 2 ? 3 : Math.max(1, slide.metrics.length);
  const cardWidth = Math.min(360, Math.floor((1152 - (perRow - 1) * 28) / perRow));
  const cards = slide.metrics
    .map((metric, index) => {
      const col = index % perRow;
      const row = Math.floor(index / perRow);
      const x = 64 + col * (cardWidth + 28);
      const y = 236 + row * 206;
      const accent = metric.deltaText ? toneColor(metric.deltaTone, theme) : index % 3 === 1 ? theme.gold : theme.accent;
      return metricCard(metric, x, y, cardWidth, 192, accent, theme);
    })
    .join('');
  const overflow = slide.overflow ? `<text x="64" y="640" font-family="${theme.font}" font-size="18" fill="${theme.muted}">${esc(slide.overflow)}</text>` : '';
  return svg(`${open}\n${cards}\n${overflow}`);
}

function executivePage(slide: Extract<DeckSlide, { kind: 'executive' }>, pageNo: number, total: number, theme: DeckTheme): string {
  const { open } = frame(theme, pageNo, total, slide.eyebrow, slide.title);
  const headline = wrap(slide.headline, 30, 4);
  const takeawaySvg = slide.takeaways
    .map((line, index) => {
      const y = 356 + index * 62;
      return `<circle cx="80" cy="${y - 7}" r="5" fill="${theme.accent}"/>
${textLines(wrap(line, 34, 2), 100, y, 22, theme.text, 400, 1.5)}`;
    })
    .join('');
  const riskSvg = slide.risks
    .map((line, index) => `<text x="64" y="${600 + index * 34}" font-family="${theme.font}" font-size="19" fill="${theme.danger}">${esc(clip(line, 56))}</text>`)
    .join('');
  return svg(`${open}
<rect x="64" y="212" width="1152" height="1" fill="${theme.border}"/>
${textLines(headline, 64, 264, 30, theme.text, 700, 1.35)}
${takeawaySvg}
${riskSvg}`);
}

function lineColor(tone: DeckLine['tone'], theme: DeckTheme): string {
  return tone === 'danger' ? theme.danger : tone === 'warning' ? theme.gold : theme.text;
}

function sectionPage(slide: Extract<DeckSlide, { kind: 'section' }>, pageNo: number, total: number, theme: DeckTheme, copy: ReportCopy): string {
  const { open } = frame(theme, pageNo, total, slide.eyebrow, slide.title);
  const conclusion = slide.conclusion ? wrap(slide.conclusion, 40, 2) : [];
  const hasData = Boolean(slide.table || slide.chart);
  const topY = conclusion.length ? 236 + conclusion.length * 36 + 12 : 236;
  const bodyLines = slide.lines.slice(0, hasData ? 4 : 9);
  const conclusionSvg = conclusion.length ? textLines(conclusion, 64, 236, 20, theme.accent, 600, 1.7) : '';
  const left = bodyLines.length
    ? bodyLines.map((line, index) => `<text x="64" y="${topY + index * 36}" font-family="${theme.font}" font-size="22" fill="${lineColor(line.tone, theme)}">${esc(clip(line.text, 46))}</text>`).join('')
    : hasData
      ? ''
      : `<text x="64" y="${topY}" font-family="${theme.font}" font-size="22" fill="${theme.muted}">—</text>`;

  const metricLines = slide.metrics.slice(0, hasData ? 3 : 6);
  const metricPanel = !hasData && metricLines.length
    ? `<rect x="700" y="${topY - 16}" width="516" height="${metricLines.length * 58 + 36}" rx="10" fill="${theme.surface}"/>${metricLines
        .map((metric, index) => {
          const y = topY + 28 + index * 58;
          const delta = metric.deltaText ? ` ${metric.deltaText}` : '';
          return `<text x="728" y="${y}" font-family="${theme.font}" font-size="22" fill="${theme.accent}">${esc(clip(`${metric.label}：${metric.value}${metric.unit ?? ''}${delta}`, 26))}</text>`;
        })
        .join('')}`
    : '';

  let dataSvg = '';
  if (slide.table) {
    const columns = slide.table.columns;
    const rows = slide.table.rows;
    const y = Math.max(400, topY + 120);
    const columnWidth = columns.length ? Math.floor(1152 / columns.length) : 380;
    dataSvg = `<text x="64" y="${y - 14}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(slide.table.title ?? slide.title, 24))}</text>`;
    dataSvg += columns
      .map((column, index) => `<text x="${64 + index * columnWidth}" y="${y + 26}" font-family="${theme.font}" font-size="20" font-weight="700" fill="${theme.gold}">${esc(clip(column, 18))}</text>`)
      .join('');
    dataSvg += rows
      .map((row, rowIndex) => {
        const rowY = y + 62 + rowIndex * 32;
        return `<line x1="64" y1="${rowY - 22}" x2="1216" y2="${rowY - 22}" stroke="${theme.border}"/>${row.cells
          .map((cell, index) => `<text x="${64 + index * columnWidth}" y="${rowY}" font-family="${theme.font}" font-size="20" fill="${theme.text}">${esc(clip(cell, 18))}</text>`)
          .join('')}`;
      })
      .join('');
    if (slide.table.overflow) {
      dataSvg += `<text x="64" y="${y + 62 + rows.length * 32 + 8}" font-family="${theme.font}" font-size="16" fill="${theme.muted}">${esc(slide.table.overflow)}</text>`;
    }
  } else if (slide.chart) {
    const chart = slide.chart;
    const series = chart.points;
    const hasBaseline = series.some((point) => typeof point.baseline === 'number');
    const max = Math.max(...series.map((point) => Math.max(Math.abs(point.value), Math.abs(point.baseline ?? 0))), 1);
    // 条形区从 y 起、到页脚线（664）之前结束：按可用高度决定能画几根，
    // 而不是固定步长往下堆——12 个点的月度趋势以前会画到页脚之外。
    const startY = Math.max(400, topY + 90);
    const rowStep = hasBaseline ? 42 : 30;
    const fit = Math.max(1, Math.floor((640 - startY) / rowStep));
    const drawn = series.slice(0, fit);
    const labelWidth = 300;
    const barWidth = 1216 - 240 - labelWidth - 90;
    // 图的标题要画出来：一节里有多张图时，读者得知道这一页画的是哪一张。
    dataSvg = `<text x="64" y="${startY - 34}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(chart.title, 24))}</text>`;
    dataSvg += drawn
      .map((point, index) => {
        const y = startY + index * rowStep;
        const width = Math.max(8, Math.round((Math.abs(point.value) / max) * barWidth));
        const baseWidth = hasBaseline ? Math.max(0, Math.round((Math.abs(point.baseline ?? 0) / max) * barWidth)) : 0;
        return `<text x="64" y="${y}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(point.label, 20))}</text>
<rect x="240" y="${y - 18}" width="${width}" height="${hasBaseline ? 16 : 18}" rx="4" fill="${theme.accent}"/>
${hasBaseline ? `<rect x="240" y="${y + 2}" width="${baseWidth}" height="11" rx="3" fill="${theme.muted}" opacity="0.45"/>` : ''}
<text x="${248 + width}" y="${y}" font-family="${theme.font}" font-size="20" fill="${theme.text}">${esc(point.value)}</text>`;
      })
      .join('');
    if (hasBaseline && drawn.length) {
      const legendY = startY + (drawn.length - 1) * rowStep + 28;
      dataSvg += `<rect x="240" y="${legendY}" width="10" height="10" fill="${theme.accent}"/><text x="258" y="${legendY + 10}" font-family="${theme.font}" font-size="16" fill="${theme.muted}">${esc(copy.current)}</text>
<rect x="330" y="${legendY}" width="10" height="10" fill="${theme.muted}" opacity="0.45"/><text x="348" y="${legendY + 10}" font-family="${theme.font}" font-size="16" fill="${theme.muted}">${esc(chart.baselineName || copy.previous)}</text>`;
    }
    const footnote = chart.overflow ?? chart.note;
    if (footnote && drawn.length) {
      dataSvg += `<text x="64" y="${startY + drawn.length * rowStep + 10}" font-family="${theme.font}" font-size="16" fill="${theme.muted}">${esc(clip(footnote, 80))}</text>`;
    }
  }
  return svg(`${open}\n${conclusionSvg}\n${left}\n${metricPanel}\n${dataSvg}`);
}

function assumptionsPage(slide: Extract<DeckSlide, { kind: 'assumptions' }>, pageNo: number, total: number, theme: DeckTheme): string {
  const { open } = frame(theme, pageNo, total, slide.eyebrow, slide.title);
  const lines = slide.lines.slice(0, 12);
  const body = lines
    .map((line, index) => {
      const y = 244 + index * 40;
      return `<circle cx="72" cy="${y - 7}" r="4" fill="${theme.gold}"/><text x="92" y="${y}" font-family="${theme.font}" font-size="20" fill="${theme.text}">${esc(clip(line, 62))}</text>`;
    })
    .join('');
  const more = slide.lines.length > lines.length ? `<text x="64" y="640" font-family="${theme.font}" font-size="16" fill="${theme.muted}">+${slide.lines.length - lines.length}</text>` : '';
  return svg(`${open}\n${body}\n${more}`);
}

export interface ReportDeckPage {
  name: string;
  svg: string;
}

const SLUG: Record<DeckSlide['kind'], string> = {
  cover: 'cover',
  executive: 'executive',
  metrics: 'metrics',
  section: 'section',
  assumptions: 'assumptions',
};

/**
 * 报告 → 原生 PPTX 的 SVG 页面。
 * 分页与截断全部来自 planReportDeck：屏幕 / PPTX / 这里三份产物必须说同一套话。
 * 一节里放不下第二张图 / 第二张表时，各占一整页，而不是被静默丢掉。
 */
export function buildReportDeck(spec: ReportSpec, input: Partial<DeckTheme> = {}): ReportDeckPage[] {
  const theme: DeckTheme = { ...DEFAULT_DECK_THEME, ...input };
  const plan: DeckPlan = planReportDeck(spec);
  const bodyOf = (slide: DeckSlide, pageNo: number, total: number): string => {
    if (slide.kind === 'cover') return cover(slide, total, theme);
    if (slide.kind === 'executive') return executivePage(slide, pageNo, total, theme);
    if (slide.kind === 'metrics') return metricsPage(slide, pageNo, total, theme);
    if (slide.kind === 'section') return sectionPage(slide, pageNo, total, theme, plan.copy);
    return assumptionsPage(slide, pageNo, total, theme);
  };

  // 先按「一页一主题」展开，再统一编号：页码必须反映真实页数。
  const laid = flattenDeckSlides(plan.slides).map((slide) => ({ slide, slug: SLUG[slide.kind] }));
  const total = laid.length;
  return laid.map((entry, index) => {
    const pageNo = index + 1;
    return { name: `P${String(pageNo).padStart(2, '0')}_${entry.slug}.svg`, svg: bodyOf(entry.slide, pageNo, total) };
  });
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Read brand/style/layout/deck design_spec.md and map its color roles onto the deck theme. */
export function parseBrandTheme(markdown: string): Partial<DeckTheme> {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? '';
  const colors: Record<string, string> = {};
  const primary = /primary_color:\s*"?([#0-9a-fA-F]{6})"?/i.exec(frontmatter)?.[1];
  if (primary) colors.primary = primary;
  for (const match of markdown.matchAll(/^\|\s*(primary|accent|bg|surface|border|muted-text)\s*\|\s*`?(#[0-9A-Fa-f]{6})`?/gm)) {
    colors[match[1]] = match[2];
  }
  if (!Object.keys(colors).length) return {};
  const bg = colors.bg ?? DEFAULT_DECK_THEME.bg;
  const light = luminance(bg) > 0.55;
  const accent = colors.primary ?? (colors.accent && colors.accent.toLowerCase() !== '#000000' ? colors.accent : DEFAULT_DECK_THEME.accent);
  return {
    bg,
    surface: colors.surface ?? (light ? '#F5F3F7' : DEFAULT_DECK_THEME.surface),
    text: light ? '#111827' : DEFAULT_DECK_THEME.text,
    muted: colors['muted-text'] ?? (light ? '#5B5560' : DEFAULT_DECK_THEME.muted),
    accent,
    gold: colors.accent && colors.accent.toLowerCase() !== '#000000' ? colors.accent : accent,
    border: colors.border ?? (light ? '#DCD8E0' : DEFAULT_DECK_THEME.border),
    font: DEFAULT_DECK_THEME.font,
  };
}
