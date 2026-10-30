import type { ReportBlock, ReportMetric, ReportSpec } from '@aidb/core';

const W = 1280;
const H = 720;
export interface DeckTheme {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  gold: string;
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
<text x="64" y="696" font-family="${theme.font}" font-size="16" fill="${theme.muted}">AiDB Studio · 数字来自报告 resultRef</text>
<text x="1216" y="696" text-anchor="end" font-family="${theme.font}" font-size="16" fill="${theme.muted}">AIDB · NATIVE PPTX</text>`,
  };
}

function cover(spec: ReportSpec, total: number, theme: DeckTheme): string {
  const sourceLabels = spec.sources.map((source) => `${source.connectionName}${source.database ? ` / ${source.database}` : ''}`).join('  ·  ');
  const titleLines = wrap(spec.title, 16, 3);
  const subtitle = `${spec.meta?.createdAt ? new Date(spec.meta.createdAt).toLocaleString('zh-CN') : ''}${sourceLabels ? `  ·  ${sourceLabels}` : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${theme.bg}"/>
<rect x="0" y="0" width="14" height="${H}" fill="${theme.accent}"/>
<rect x="880" y="0" width="400" height="${H}" fill="${theme.surface}"/>
<text x="64" y="96" font-family="${theme.font}" font-size="22" letter-spacing="7" fill="${theme.accent}">AIDB STUDIO · REPORT</text>
${textLines(titleLines, 64, 236, 68, theme.text, 700, 1.16)}
<rect x="64" y="${236 + titleLines.length * 79 + 18}" width="160" height="6" fill="${theme.gold}"/>
<text x="64" y="${236 + titleLines.length * 79 + 86}" font-family="${theme.font}" font-size="22" fill="${theme.muted}">${esc(clip(subtitle, 72))}</text>
<text x="64" y="${H - 88}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${spec.sections.length} 个章节 · ${spec.layout} · 原生 PPTX</text>
<text x="1120" y="210" text-anchor="end" font-family="${theme.font}" font-size="20" letter-spacing="4" fill="${theme.accent}">REPORT</text>
<text x="1120" y="${H - 88}" text-anchor="end" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${total} 页</text>
</svg>`;
}

function metricsOf(spec: ReportSpec): ReportMetric[] {
  const out: ReportMetric[] = [];
  const seen = new Set<string>();
  for (const section of spec.sections) {
    for (const block of section.blocks) {
      for (const metric of block.kind === 'metric' ? block.metrics ?? [] : block.kind === 'comparison' ? [block.left, block.right].filter(Boolean) as ReportMetric[] : []) {
        const key = `${metric.label}:${metric.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(metric);
      }
    }
  }
  return out;
}

function metricsPage(spec: ReportSpec, total: number, theme: DeckTheme): string | undefined {
  const metrics = metricsOf(spec);
  if (!metrics.length) return undefined;
  const { open } = frame(theme, 2, total, '关键指标', '关键指标');
  const cards = metrics.slice(0, 6).map((metric, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = 64 + col * 388;
    const y = 236 + row * 200;
    return `<rect x="${x}" y="${y}" width="360" height="176" rx="10" fill="${theme.surface}"/>
<rect x="${x}" y="${y}" width="6" height="176" rx="3" fill="${index % 3 === 1 ? theme.gold : theme.accent}"/>
<text x="${x + 28}" y="${y + 44}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(metric.label, 18))}</text>
<text x="${x + 28}" y="${y + 108}" font-family="${theme.font}" font-size="48" font-weight="700" fill="${theme.text}">${esc(clip(metric.value, 12))}</text>
<text x="${x + 28}" y="${y + 146}" font-family="${theme.font}" font-size="20" fill="${metric.unit ? theme.accent : theme.muted}">${esc(clip(metric.unit ?? metric.source ?? '', 24))}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${W} ${H}">
${open}
${cards}
${metrics.length > 6 ? `<text x="64" y="640" font-family="${theme.font}" font-size="18" fill="${theme.muted}">仅展示前 6 项，共 ${metrics.length} 项指标</text>` : ''}
</svg>`;
}

function blockLines(block: ReportBlock): string[] {
  const lines: string[] = [];
  if (block.kind === 'narrative' || block.kind === 'callout') {
    if (block.text) lines.push(...wrap(block.text, 34, block.kind === 'callout' ? 4 : 8));
  } else if (block.kind === 'comparison') {
    lines.push(`${block.left?.label ?? 'A'}：${block.left?.value ?? '—'}${block.left?.unit ?? ''}`);
    lines.push(`${block.right?.label ?? 'B'}：${block.right?.value ?? '—'}${block.right?.unit ?? ''}`);
    if (block.delta) lines.push(`差值：${block.delta.absolute}${block.left?.unit ?? ''}${block.delta.percent === null || block.delta.percent === undefined ? '' : `（${block.delta.percent > 0 ? '+' : ''}${block.delta.percent}%）`}`);
  } else if (block.kind === 'metric') {
    for (const metric of block.metrics ?? []) lines.push(`${metric.label}：${metric.value}${metric.unit ?? ''}`);
  }
  return lines;
}

function sectionPage(section: ReportSpec['sections'][number], pageNo: number, total: number, theme: DeckTheme): string {
  const { open } = frame(theme, pageNo, total, '章节', section.title);
  const narrative: string[] = [];
  const metrics: ReportMetric[] = [];
  let table: { columns?: string[]; rows?: Array<Array<string | number | null>> } | undefined;
  let chart: { series?: Array<{ label: string; value: number }> } | undefined;
  for (const block of section.blocks) {
    if (block.kind === 'table' && !table) table = block;
    else if (block.kind === 'chart' && !chart) chart = block;
    else if (block.kind === 'metric') metrics.push(...(block.metrics ?? []));
    else narrative.push(...blockLines(block));
  }
  const hasData = Boolean(table || chart?.series?.length);
  const leftLines = narrative.slice(0, hasData ? 4 : 9);
  const metricLines = metrics.slice(0, 6).map((metric) => `${clip(metric.label, 14)}：${metric.value}${metric.unit ?? ''}`);
  const left = textLines(leftLines.length ? leftLines : ['—'], 64, 236, 22, theme.text, 400, 1.6);
  const metricPanel = !hasData && metricLines.length
    ? `<rect x="700" y="220" width="516" height="${Math.min(6, metricLines.length) * 58 + 36}" rx="10" fill="${theme.surface}"/>${textLines(metricLines, 728, 264, 22, theme.accent, 600, 2.6)}`
    : '';
  let tableSvg = '';
  if (table) {
    const columns = (table.columns ?? []).slice(0, 3);
    const rows = (table.rows ?? []).slice(0, 6);
    const y = 400;
    tableSvg = `<text x="64" y="${y - 14}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(section.title, 24))} · 数据表</text>`;
    tableSvg += columns.map((column, index) => `<text x="${64 + index * 380}" y="${y + 26}" font-family="${theme.font}" font-size="20" font-weight="700" fill="${theme.gold}">${esc(clip(column, 18))}</text>`).join('');
    tableSvg += rows.map((row, rowIndex) => {
      const rowY = y + 62 + rowIndex * 32;
      return `<line x1="64" y1="${rowY - 22}" x2="1216" y2="${rowY - 22}" stroke="${theme.border}"/>${row.slice(0, 3).map((cell, index) => `<text x="${64 + index * 380}" y="${rowY}" font-family="${theme.font}" font-size="20" fill="${theme.text}">${esc(clip(cell, 18))}</text>`).join('')}`;
    }).join('');
  } else if (chart?.series?.length) {
    const series = chart.series.slice(0, 6);
    const max = Math.max(...series.map((point) => Math.abs(point.value)), 1);
    tableSvg = series.map((point, index) => {
      const y = 410 + index * 28;
      const width = Math.max(8, Math.round((Math.abs(point.value) / max) * 360));
      return `<text x="64" y="${y}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(point.label, 12))}</text>
<rect x="240" y="${y - 18}" width="${width}" height="18" rx="4" fill="${index % 2 ? theme.gold : theme.accent}"/>
<text x="${248 + width}" y="${y}" font-family="${theme.font}" font-size="20" fill="${theme.text}">${esc(point.value)}</text>`;
    }).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${W} ${H}">
${open}
${left}
${metricPanel}
${tableSvg}
</svg>`;
}

export interface ReportDeckPage {
  name: string;
  svg: string;
}

export function buildReportDeck(spec: ReportSpec, input: Partial<DeckTheme> = {}): ReportDeckPage[] {
  const theme: DeckTheme = { ...DEFAULT_DECK_THEME, ...input };
  const pages: ReportDeckPage[] = [];
  const metrics = metricsOf(spec);
  const sectionPages = spec.sections.filter((section) => section.blocks.length > 0).slice(0, 4);
  const total = 1 + (metrics.length ? 1 : 0) + sectionPages.length;
  pages.push({ name: 'P01_cover.svg', svg: cover(spec, total, theme) });
  if (metrics.length) pages.push({ name: 'P02_metrics.svg', svg: metricsPage(spec, total, theme)! });
  sectionPages.forEach((section, index) => {
    pages.push({ name: `P${String(index + (metrics.length ? 3 : 2)).padStart(2, '0')}_${index + 1}.svg`, svg: sectionPage(section, pages.length + 1, total, theme) });
  });
  return pages;
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
