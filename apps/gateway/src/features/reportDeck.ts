import { flattenDeckSlides, planReportDeck } from '@aidb/core';
import type { ReportCopy, DeckChart, DeckLine, DeckMetric, DeckPlan, DeckSlide, ReportSpec } from '@aidb/core';

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

const CHART_COLORS = ['#45C8C3', '#D6B45A', '#8FA8F0', '#E0604F', '#A9C97E'];

function chartSeries(chart: DeckChart, current: string): Array<{ name: string; values: number[]; color: string }> {
  const out = [{ name: chart.yLabel || current, values: chart.points.map((point) => point.value), color: CHART_COLORS[0] }];
  if (chart.points.some((point) => typeof point.baseline === 'number')) {
    out.push({ name: chart.baselineName || '上期', values: chart.points.map((point) => point.baseline ?? 0), color: CHART_COLORS[1] });
  }
  for (const [index, series] of (chart.extraSeries ?? []).entries()) {
    out.push({ name: series.name, values: series.values, color: CHART_COLORS[(index + out.length) % CHART_COLORS.length] });
  }
  return out;
}

function categoryRowStep(chart: DeckChart, current: string): number {
  if (chart.stacked === true || chart.chartType === 'stacked') return 46;
  const count = chartSeries(chart, current).length;
  return count > 1 ? Math.max(58, count * 14 + 8) : 34;
}

function svgNum(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
}

function chartOverflow(copy: ReportCopy, count: number, shown: number): string {
  return copy.truncatedPoints.replace('{n}', String(count)).replace('{m}', String(shown));
}

function legend(chart: DeckChart, y: number, theme: DeckTheme, current: string): string {
  const series = chartSeries(chart, current);
  if (series.length < 2) return '';
  return series.map((entry, index) => `<rect x="${300 + index * 180}" y="${y - 12}" width="12" height="12" rx="2" fill="${entry.color}"/><text x="${320 + index * 180}" y="${y}" font-family="${theme.font}" font-size="16" fill="${theme.muted}">${esc(clip(entry.name, 14))}</text>`).join('');
}

function axisChart(chart: DeckChart, startY: number, theme: DeckTheme, current: string): string {
  const series = chartSeries(chart, current);
  const values = series.flatMap((entry) => entry.values).filter(Number.isFinite);
  if (!values.length) return '';
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    min = -1;
    max = 1;
  }
  const left = 300;
  const right = 1180;
  const bottom = 630;
  const xAt = (index: number, count: number) => count <= 1 ? (left + right) / 2 : left + (index / (count - 1)) * (right - left);
  const yAt = (value: number) => bottom - ((value - min) / (max - min)) * (bottom - startY);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = min + (max - min) * ratio;
    const y = yAt(value);
    return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${theme.border}" stroke-width="1"/><text x="${left - 12}" y="${y + 5}" text-anchor="end" font-family="${theme.font}" font-size="14" fill="${theme.muted}">${esc(svgNum(value))}</text>`;
  }).join('');
  const zeroY = yAt(0);
  const zero = min < 0 && max > 0 ? `<line x1="${left}" y1="${zeroY}" x2="${right}" y2="${zeroY}" stroke="${theme.muted}" stroke-width="1.5"/>` : '';
  const labels = chart.points.map((point, index) => {
    if (chart.points.length > 8 && index % Math.ceil(chart.points.length / 8) !== 0 && index !== chart.points.length - 1) return '';
    return `<text x="${xAt(index, chart.points.length)}" y="${bottom + 28}" text-anchor="middle" font-family="${theme.font}" font-size="15" fill="${theme.muted}">${esc(clip(point.label, 12))}</text>`;
  }).join('');
  const paths = series.map((entry) => {
    const points = entry.values.map((value, index) => `${xAt(index, entry.values.length)},${yAt(value)}`).join(' ');
    const dots = entry.values.map((value, index) => `<circle cx="${xAt(index, entry.values.length)}" cy="${yAt(value)}" r="4" fill="${entry.color}"/>`).join('');
    return `<polyline points="${points}" fill="none" stroke="${entry.color}" stroke-width="3" stroke-linejoin="round"/>${dots}`;
  }).join('');
  return `${grid}${zero}<line x1="${left}" y1="${startY}" x2="${left}" y2="${bottom}" stroke="${theme.border}"/>${paths}${labels}${legend(chart, 656, theme, current)}`;
}

function categoryChart(chart: DeckChart, startY: number, theme: DeckTheme, current: string): string {
  const series = chartSeries(chart, current);
  const stacked = chart.stacked === true || chart.chartType === 'stacked';
  const rowStep = categoryRowStep(chart, current);
  const fit = Math.max(1, Math.floor((630 - startY) / rowStep));
  const drawn = chart.points.slice(0, fit);
  const sums = drawn.map((_, index) => {
    let positive = 0;
    let negative = 0;
    for (const entry of series) {
      const value = entry.values[index] ?? 0;
      if (value >= 0) positive += value;
      else negative += value;
    }
    return { positive, negative };
  });
  const values = series.flatMap((entry) => entry.values).filter(Number.isFinite);
  const min = stacked ? Math.min(0, ...sums.map((sum) => sum.negative)) : Math.min(0, ...values);
  const max = stacked ? Math.max(0, ...sums.map((sum) => sum.positive)) : Math.max(0, ...values);
  const domainMin = min === max ? -1 : min;
  const domainMax = min === max ? 1 : max;
  const left = 256;
  const right = 1180;
  const scale = (right - left) / (domainMax - domainMin);
  const zeroX = left + (0 - domainMin) * scale;
  const rows = drawn.map((point, index) => {
    const y = startY + index * rowStep;
    const label = `<text x="64" y="${y + 18}" font-family="${theme.font}" font-size="18" fill="${theme.muted}">${esc(clip(point.label, 16))}</text>`;
    if (stacked) {
      let positive = 0;
      let negative = 0;
      const bars = series.map((entry) => {
        const value = entry.values[index] ?? 0;
        const width = value === 0 ? 0 : Math.max(2, Math.round(Math.abs(value) * scale));
        const x = value >= 0 ? zeroX + positive * scale : zeroX + negative * scale - width;
        if (value >= 0) positive += value;
        else negative += value;
        return `<rect x="${x}" y="${y + 2}" width="${width}" height="22" rx="3" fill="${entry.color}"/>`;
      }).join('');
      const net = positive + negative;
      const labelX = zeroX + (net >= 0 ? positive * scale : negative * scale) + (net >= 0 ? 6 : -6);
      return `${label}${bars}<text x="${labelX}" y="${y + 19}" text-anchor="${net >= 0 ? 'start' : 'end'}" font-family="${theme.font}" font-size="16" fill="${theme.text}">${esc(svgNum(net))}</text>`;
    }
    const bars = series.map((entry, seriesIndex) => {
      const value = entry.values[index] ?? 0;
      const width = value === 0 ? 0 : Math.max(2, Math.round(Math.abs(value) * scale));
      const x = value >= 0 ? zeroX : zeroX - width;
      const barY = y + seriesIndex * 14;
      return `<rect x="${x}" y="${barY}" width="${width}" height="10" rx="2" fill="${entry.color}"/><text x="${value >= 0 ? x + width + 6 : x - 6}" y="${barY + 10}" text-anchor="${value >= 0 ? 'start' : 'end'}" font-family="${theme.font}" font-size="13" fill="${theme.text}">${esc(svgNum(value))}</text>`;
    }).join('');
    return `${label}${bars}`;
  }).join('');
  const zero = `<line x1="${zeroX}" y1="${startY - 6}" x2="${zeroX}" y2="${Math.min(630, startY + drawn.length * rowStep)}" stroke="${theme.muted}" stroke-width="1.5"/>`;
  return `${zero}${rows}${legend(chart, 656, theme, current)}`;
}

function pointOnCircle(cx: number, cy: number, radius: number, angle: number): [number, number] {
  return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
}

function pieChart(chart: DeckChart, startY: number, theme: DeckTheme): string {
  const values = chart.points.map((point) => Math.max(0, point.value));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return `<text x="64" y="${startY + 40}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">—</text>`;
  const cx = 420;
  const cy = (startY + 630) / 2;
  const radius = Math.min(150, (630 - startY) / 2 - 10);
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const span = (value / total) * Math.PI * 2;
    const end = angle + span;
    const [x1, y1] = pointOnCircle(cx, cy, radius, angle);
    const [x2, y2] = pointOnCircle(cx, cy, radius, end);
    const large = span > Math.PI ? 1 : 0;
    const path = `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/>`;
    angle = end;
    return path;
  }).join('');
  const labels = chart.points.map((point, index) => `<rect x="720" y="${startY + index * 42}" width="14" height="14" rx="3" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/><text x="748" y="${startY + 12 + index * 42}" font-family="${theme.font}" font-size="18" fill="${theme.text}">${esc(clip(point.label, 18))}</text><text x="1160" y="${startY + 12 + index * 42}" text-anchor="end" font-family="${theme.font}" font-size="18" fill="${theme.muted}">${esc(svgNum(point.value))} · ${(point.value / total * 100).toFixed(1)}%</text>`).join('');
  return `${slices}${labels}`;
}

function scatterChart(chart: DeckChart, startY: number, theme: DeckTheme): string {
  const points = chart.scatter ?? [];
  if (!points.length) return '';
  const left = 300;
  const right = 1180;
  const bottom = 630;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const xAt = (value: number) => left + ((value - minX) / spanX) * (right - left);
  const yAt = (value: number) => bottom - ((value - minY) / spanY) * (bottom - startY);
  const dots = points.map((point, index) => `<circle cx="${xAt(point.x)}" cy="${yAt(point.y)}" r="6" fill="${CHART_COLORS[index % CHART_COLORS.length]}" fill-opacity="0.82"><title>${esc(`${point.label ?? ''} (${point.x}, ${point.y})`)}</title></circle>${point.label ? `<text x="${xAt(point.x) + 10}" y="${yAt(point.y) - 8}" font-family="${theme.font}" font-size="14" fill="${theme.muted}">${esc(clip(point.label, 12))}</text>` : ''}`).join('');
  return `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${theme.border}"/><line x1="${left}" y1="${startY}" x2="${left}" y2="${bottom}" stroke="${theme.border}"/><text x="${left}" y="${bottom + 28}" font-family="${theme.font}" font-size="15" fill="${theme.muted}">${esc(svgNum(minX))}</text><text x="${right}" y="${bottom + 28}" text-anchor="end" font-family="${theme.font}" font-size="15" fill="${theme.muted}">${esc(svgNum(maxX))}</text><text x="${left - 12}" y="${startY + 5}" text-anchor="end" font-family="${theme.font}" font-size="15" fill="${theme.muted}">${esc(svgNum(maxY))}</text><text x="${left - 12}" y="${bottom}" text-anchor="end" font-family="${theme.font}" font-size="15" fill="${theme.muted}">${esc(svgNum(minY))}</text>${dots}`;
}

function radarChart(chart: DeckChart, startY: number, theme: DeckTheme, current: string): string {
  const count = chart.points.length;
  const series = chartSeries(chart, current);
  const max = Math.max(...series.flatMap((entry) => entry.values.map((value) => Math.abs(value))), 1);
  const cx = 720;
  const cy = (startY + 630) / 2;
  const radius = Math.min(170, (630 - startY) / 2 - 12);
  const at = (index: number, ratio: number) => pointOnCircle(cx, cy, radius * ratio, -Math.PI / 2 + index * Math.PI * 2 / count);
  const grid = [0.25, 0.5, 0.75, 1].map((ratio) => `<polygon points="${chart.points.map((_, index) => at(index, ratio).join(',')).join(' ')}" fill="none" stroke="${theme.border}"/>`).join('');
  const labels = chart.points.map((point, index) => {
    const [x, y] = at(index, 1.18);
    return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${theme.font}" font-size="16" fill="${theme.muted}">${esc(clip(point.label, 12))}</text>`;
  }).join('');
  const shapes = series.map((entry) => `<polygon points="${entry.values.map((value, index) => at(index, Math.max(0, Math.min(1, Math.abs(value) / max))).join(',')).join(' ')}" fill="${entry.color}" fill-opacity="0.12" stroke="${entry.color}" stroke-width="3"/>`).join('');
  return `${grid}${labels}${shapes}${legend(chart, 656, theme, current)}`;
}

function heatmapChart(chart: DeckChart, startY: number, theme: DeckTheme): string {
  const matrix = chart.heatmap;
  if (!matrix) return '';
  const rows = matrix.yLabels.length;
  const columns = matrix.xLabels.length;
  const cellW = Math.min(88, Math.floor(900 / Math.max(1, columns)));
  const cellH = Math.min(42, Math.floor(220 / Math.max(1, rows)));
  const max = Math.max(...matrix.values.flat().map((value) => Math.abs(value)), 1);
  const headers = matrix.xLabels.map((label, index) => `<text x="${280 + index * cellW + cellW / 2}" y="${startY - 12}" text-anchor="middle" font-family="${theme.font}" font-size="14" fill="${theme.muted}">${esc(clip(label, 8))}</text>`).join('');
  const cells = matrix.values.map((row, rowIndex) => row.map((value, columnIndex) => {
    const x = 280 + columnIndex * cellW;
    const y = startY + rowIndex * cellH;
    const opacity = 0.12 + Math.abs(value) / max * 0.75;
    return `<rect x="${x}" y="${y}" width="${cellW - 3}" height="${cellH - 3}" rx="4" fill="${theme.accent}" fill-opacity="${opacity.toFixed(2)}"/><text x="${x + cellW / 2}" y="${y + cellH / 2 + 5}" text-anchor="middle" font-family="${theme.font}" font-size="14" fill="${theme.text}">${esc(svgNum(value))}</text>`;
  }).join('')).join('');
  const rowLabels = matrix.yLabels.map((label, index) => `<text x="264" y="${startY + index * cellH + cellH / 2 + 5}" text-anchor="end" font-family="${theme.font}" font-size="15" fill="${theme.muted}">${esc(clip(label, 12))}</text>`).join('');
  return `${headers}${rowLabels}${cells}`;
}

function reportChartSvg(chart: DeckChart, startY: number, theme: DeckTheme, copy: ReportCopy): string {
  const title = `<text x="64" y="${startY - 34}" font-family="${theme.font}" font-size="20" fill="${theme.muted}">${esc(clip(chart.title, 30))}</text>`;
  const axes = chart.xLabel || chart.yLabel || chart.heatmap?.valueLabel ? `<text x="1216" y="${startY - 34}" text-anchor="end" font-family="${theme.font}" font-size="14" fill="${theme.muted}">${esc(clip([chart.xLabel, chart.heatmap?.valueLabel ?? chart.yLabel].filter(Boolean).join(' / '), 40))}</text>` : '';
  let body = '';
  if (chart.chartType === 'pie') body = pieChart(chart, startY, theme);
  else if (chart.chartType === 'scatter') body = scatterChart(chart, startY, theme);
  else if (chart.chartType === 'radar') body = radarChart(chart, startY, theme, copy.current);
  else if (chart.chartType === 'heatmap') body = heatmapChart(chart, startY, theme);
  else if (chart.chartType === 'line') body = axisChart(chart, startY, theme, copy.current);
  else body = categoryChart(chart, startY, theme, copy.current);
  const footnote = chart.overflow ?? chart.note;
  return `${title}${axes}${body}${footnote ? `<text x="64" y="682" font-family="${theme.font}" font-size="14" fill="${theme.muted}">${esc(clip(footnote, 110))}</text>` : ''}`;
}

function sectionPage(slide: Extract<DeckSlide, { kind: 'section' }>, pageNo: number, total: number, theme: DeckTheme, copy: ReportCopy): string {
  const { open } = frame(theme, pageNo, total, slide.eyebrow, slide.title);
  const conclusion = slide.conclusion ? wrap(slide.conclusion, 40, 2) : [];
  const hasData = Boolean(slide.table || slide.chart);
  const topY = conclusion.length ? 236 + conclusion.length * 36 + 12 : 236;
  const bodyLines = slide.lines.slice(0, hasData ? 2 : 9);
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
    const y = Math.max(400, topY + 72);
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
      dataSvg += `<text x="64" y="${Math.min(648, y + 50 + rows.length * 32)}" font-family="${theme.font}" font-size="16" fill="${theme.muted}">${esc(slide.table.overflow)}</text>`;
    }
  } else if (slide.chart) {
    const chart = slide.chart;
    const startY = Math.max(400, topY + 90);
    const categoryChart = chart.chartType === 'bar' || chart.chartType === 'stacked';
    const rowStep = categoryRowStep(chart, copy.current);
    const fit = Math.max(1, Math.floor((630 - startY) / rowStep));
    const overflow = categoryChart && chart.points.length > fit
      ? chart.overflow ?? chartOverflow(copy, chart.points.length, fit)
      : chart.overflow;
    dataSvg = reportChartSvg({ ...chart, overflow }, startY, theme, copy);
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
