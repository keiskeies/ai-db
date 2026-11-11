import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { flattenDeckSlides, planReportDeck, reportSheets } from '@aidb/core';
import type { ArtifactInfo, ArtifactRunInfo, DeckSlide, ReportSpec } from '@aidb/core';
import { writeExportFile } from '../services';
import type { Store } from '../store';

export type ExportFormat = 'xlsx' | 'pptx';

/** 导出只需要落盘目录；接受完整 GatewayConfig，也接受 runner 里只带的 exportDir。 */
export interface ExportTarget {
  exportDir: string;
}

export interface ArtifactExportResult {
  path: string;
  rows: number;
  bytes: number;
  format: ExportFormat;
}

function safeName(value: string): string {
  return value.replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40) || 'artifact';
}

function latestRun(store: Store, artifactId: string): ArtifactRunInfo | undefined {
  return store.listArtifactRuns(artifactId, 1)[0];
}

/** 报告导出走 core 的共享排版：Excel 的多 sheet 划分必须和屏幕 / AI PPT 同源。 */
function reportSheetsOf(spec: ReportSpec) {
  return reportSheets(spec);
}

function diffRows(result: any): { columns: string[]; rows: unknown[][] } {
  const rows: unknown[][] = [];
  for (const table of result?.tables ?? []) {
    for (const change of table.changes ?? []) {
      rows.push([table.name, table.status, change.kind, change.detail, change.sql ?? '', change.destructive ? '是' : '']);
    }
    if (!(table.changes ?? []).length) rows.push([table.name, table.status, '', '', '', '']);
  }
  return { columns: ['表', '状态', '变更', '说明', 'SQL', '破坏性'], rows };
}

function reconRows(result: any): { columns: string[]; rows: unknown[][] } {
  const rows: unknown[][] = [];
  for (const diff of result?.target?.differences ?? []) {
    rows.push([diff.key, diff.status, (diff.fields ?? []).join(', '), JSON.stringify(diff.left ?? null), JSON.stringify(diff.right ?? null)]);
  }
  return { columns: ['键', '状态', '字段', '左侧', '右侧'], rows };
}

function fixRows(result: any): { columns: string[]; rows: unknown[][] } {
  const rows: unknown[][] = [];
  for (const finding of result?.findings ?? []) {
    rows.push([finding.severity, finding.table ?? '', finding.title, finding.detail, finding.sql ?? '', finding.risk ?? '']);
  }
  for (const step of result?.plan ?? []) rows.push(['plan', step.table ?? '', step.title, step.sql, step.sql, step.risk]);
  return { columns: ['级别', '表', '标题', '说明', 'SQL', '风险'], rows };
}

function tabular(artifact: ArtifactInfo, run: ArtifactRunInfo | undefined): { columns: string[]; rows: unknown[][] } {
  if (artifact.type === 'report' || artifact.type === 'compare') {
    const spec = run?.result as ReportSpec | undefined;
    if (spec?.sections) {
      // 报告是多结构的（摘要 / 指标 / 表格 / 图表），压成一张表会丢信息；
      // 这里给「只能出一张表」的调用方一个汇总视图，Excel 导出走 reportSheetsOf 的多 sheet。
      const sheets = reportSheetsOf(spec);
      const columns = ['sheet', ...Array.from({ length: Math.max(...sheets.map((sheet) => sheet.columns.length), 0) }, (_, index) => `col${index + 1}`)];
      const rows: unknown[][] = [];
      for (const sheet of sheets) {
        rows.push([sheet.name, ...sheet.columns.map((column) => String(column ?? ''))]);
        for (const row of sheet.rows) rows.push([sheet.name, ...row.map((cell) => cell ?? '')]);
      }
      return { columns, rows };
    }
  }
  if (artifact.type === 'diff') return diffRows(run?.result);
  if (artifact.type === 'recon') return reconRows(run?.result);
  if (artifact.type === 'fix') return fixRows(run?.result);
  return { columns: ['内容'], rows: [] };
}

const INK = '1F2937';
const MUTED = '6B7280';
const BODY = '374151';
const ACCENT = '0F766E';
const DANGER = 'B03A2E';

/**
 * 报告 PPTX。
 * 页与页的内容划分来自 planReportDeck —— 与 AI PPT（SVG deck）共用同一份计划，
 * 两份产物不能一个给 4 页一个给 8 页，也不能一个缩写数字一个不缩写。
 */
function writeReportSlides(pptx: PptxGenJS, spec: ReportSpec): void {
  const plan = planReportDeck(spec);
  const copy = plan.copy;
  const slides = flattenDeckSlides(plan.slides);
  slides.forEach((slide: DeckSlide, index) => {
    const page = pptx.addSlide();
    page.background = { color: 'FFFFFF' };
    const pageNo = `${index + 1} / ${slides.length}`;
    page.addText(pageNo, { x: 11.0, y: 0.25, w: 1.8, h: 0.35, fontSize: 10, color: MUTED, align: 'right' });

    if (slide.kind === 'cover') {
      page.addText(slide.title, { x: 0.7, y: 2.1, w: 11.9, h: 1.4, fontSize: 32, bold: true, color: INK });
      page.addText(slide.eyebrow, { x: 0.7, y: 1.5, w: 11.9, h: 0.4, fontSize: 13, color: ACCENT, charSpacing: 3 });
      page.addText(slide.subtitle, { x: 0.7, y: 3.7, w: 11.9, h: 0.5, fontSize: 14, color: MUTED });
      page.addText(slide.meta, { x: 0.7, y: 4.3, w: 11.9, h: 0.4, fontSize: 12, color: MUTED });
      return;
    }

    page.addText(slide.title, { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 22, bold: true, color: INK });
    if (slide.eyebrow !== slide.title) {
      page.addText(slide.eyebrow, { x: 0.62, y: 0.06, w: 8, h: 0.3, fontSize: 10, color: ACCENT, charSpacing: 2 });
    }

    if (slide.kind === 'executive') {
      page.addText(slide.headline, { x: 0.7, y: 1.1, w: 11.8, h: 1.0, fontSize: 18, bold: true, color: ACCENT });
      if (slide.takeaways.length) {
        page.addText(slide.takeaways.map((line) => ({ text: line })), {
          x: 0.8, y: 2.3, w: 11.6, h: 3.4, fontSize: 14, color: BODY, breakLine: true, valign: 'top', bullet: true,
        });
      }
      if (slide.risks.length) {
        page.addText(slide.risks.map((line) => ({ text: line })), {
          x: 0.8, y: 5.8, w: 11.6, h: 1.2, fontSize: 13, color: DANGER, breakLine: true, valign: 'top',
        });
      }
      return;
    }

    if (slide.kind === 'metrics') {
      const perRow = slide.metrics.length > 2 ? 3 : Math.max(1, slide.metrics.length);
      const cardW = 3.7;
      const cardH = 1.7;
      slide.metrics.forEach((metric, position) => {
        const col = position % perRow;
        const row = Math.floor(position / perRow);
        const x = 0.6 + col * (cardW + 0.25);
        const y = 1.2 + row * (cardH + 0.25);
        page.addShape('rect', { x, y, w: cardW, h: cardH, fill: { color: 'F3F4F6' }, line: { color: 'E5E7EB', pt: 0.5 } });
        page.addText(metric.label, { x: x + 0.15, y: y + 0.12, w: cardW - 0.3, h: 0.35, fontSize: 11, color: MUTED });
        page.addText(metric.value, { x: x + 0.15, y: y + 0.5, w: cardW - 0.3, h: 0.6, fontSize: 26, bold: true, color: INK });
        if (metric.unit) page.addText(metric.unit, { x: x + 0.15, y: y + 1.08, w: cardW - 0.3, h: 0.3, fontSize: 11, color: ACCENT });
        if (metric.deltaText) {
          const color = metric.deltaTone === 'good' ? ACCENT : metric.deltaTone === 'bad' ? DANGER : MUTED;
          page.addText(`${metric.baselineLabel ?? copy.previous} ${metric.deltaText}`, { x: x + 0.15, y: y + 1.34, w: cardW - 0.3, h: 0.3, fontSize: 10, color, bold: true });
        }
      });
      if (slide.overflow) page.addText(slide.overflow, { x: 0.6, y: 6.6, w: 12, h: 0.35, fontSize: 10, color: MUTED });
      return;
    }

    if (slide.kind === 'assumptions') {
      page.addText(slide.lines.map((line) => ({ text: line })), {
        x: 0.8, y: 1.2, w: 11.6, h: 5.6, fontSize: 12, color: '4B5563', breakLine: true, valign: 'top', bullet: true,
      });
      return;
    }

    // section：结论先行，然后叙述，再落到表格或图。
    let cursorY = 1.15;
    if (slide.conclusion) {
      page.addText(slide.conclusion, { x: 0.7, y: cursorY, w: 11.8, h: 0.55, fontSize: 15, bold: true, color: ACCENT });
      cursorY += 0.62;
    }
    if (slide.lines.length) {
      const height = Math.min(2.2, 0.32 * slide.lines.length + 0.2);
      page.addText(slide.lines.map((line) => ({ text: line.text })), {
        x: 0.8, y: cursorY, w: 11.6, h: height, fontSize: 13,
        color: BODY, breakLine: true, valign: 'top',
      });
      cursorY += height + 0.1;
    }
    if (slide.metrics.length && !slide.table && !slide.chart) {
      page.addText(
        slide.metrics.map((metric) => ({ text: `${metric.label}: ${metric.value}${metric.unit ?? ''}${metric.deltaText ? `  ${metric.baselineLabel ?? ''} ${metric.deltaText}` : ''}` })),
        { x: 0.8, y: cursorY, w: 11.6, h: Math.min(2.4, 0.3 * slide.metrics.length + 0.2), fontSize: 13, color: ACCENT, breakLine: true, valign: 'top' },
      );
      return;
    }
    if (slide.table) {
      const header = slide.table.columns.map((column) => ({ text: String(column), options: { bold: true, color: INK } }));
      const rows = [header, ...slide.table.rows.map((row) => row.cells.map((cell) => String(cell)))];
      page.addTable(rows as any, {
        x: 0.6, y: Math.min(cursorY, 4.4), w: 12, fontSize: 10, color: BODY,
        border: { pt: 0.5, color: 'D1D5DB' }, valign: 'middle',
      });
      if (slide.table.overflow) {
        page.addText(slide.table.overflow, { x: 0.6, y: 6.7, w: 12, h: 0.3, fontSize: 9, color: MUTED });
      }
    }
    if (slide.chart) {
      const chart = slide.chart;
      const series = [{ name: copy.current, labels: chart.points.map((point) => point.label), values: chart.points.map((point) => point.value) }];
      if (chart.points.some((point) => typeof point.baseline === 'number')) {
        series.push({
          name: chart.baselineName || copy.previous,
          labels: chart.points.map((point) => point.label),
          values: chart.points.map((point) => point.baseline ?? 0),
        });
      }
      const chartTop = Math.min(cursorY, 4.2);
      page.addText(chart.title, { x: 0.6, y: Math.max(1.1, chartTop - 0.34), w: 12, h: 0.3, fontSize: 11, color: MUTED });
      const type = chart.chartType === 'line' ? pptx.ChartType.line : chart.chartType === 'pie' ? pptx.ChartType.pie : pptx.ChartType.bar;
      page.addChart(type, series as any, {
        x: 0.6, y: chartTop, w: 12, h: Math.max(2.2, 6.4 - chartTop),
        showLegend: series.length > 1,
        showValue: chart.chartType === 'pie',
        chartColors: ['0F766E', '93A19E', 'D6B45A', '5B8DEF', 'E0604F'],
      } as any);
      const footnote = chart.overflow ?? chart.note;
      if (footnote) page.addText(footnote, { x: 0.6, y: 6.7, w: 12, h: 0.3, fontSize: 9, color: MUTED });
    }
    if (!slide.lines.length && !slide.table && !slide.chart && !slide.metrics.length) {
      page.addText(copy.noText, { x: 0.8, y: cursorY, w: 11.6, h: 0.5, fontSize: 13, color: MUTED });
    }
  });
}

async function writePptx(artifact: ArtifactInfo, run: ArtifactRunInfo | undefined, config: ExportTarget): Promise<{ path: string; rows: number }> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'AiDB Studio';
  pptx.subject = artifact.title;
  const spec = (run?.result ?? undefined) as ReportSpec | undefined;

  if ((artifact.type === 'report' || artifact.type === 'compare') && spec?.sections) {
    writeReportSlides(pptx, spec);
  } else {
    const table = tabular(artifact, run);
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: 'FFFFFF' };
    titleSlide.addText(artifact.title, { x: 0.7, y: 2.1, w: 11.9, h: 1.1, fontSize: 30, bold: true, color: INK });
    titleSlide.addText(`${artifact.type} · ${new Date(artifact.updatedAt).toLocaleString()} · AiDB Studio`, {
      x: 0.7, y: 3.3, w: 11.9, h: 0.5, fontSize: 13, color: MUTED,
    });
    const slide = pptx.addSlide();
    slide.addText(artifact.title, { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 22, bold: true, color: INK });
    const rows = [table.columns.map((column) => ({ text: column, options: { bold: true } })), ...table.rows.slice(0, 20).map((row) => row.map((cell) => String(cell ?? '')))];
    slide.addTable(rows as any, { x: 0.5, y: 1.2, w: 12, fontSize: 9, border: { pt: 0.5, color: 'D1D5DB' } });
  }

  mkdirSync(config.exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(config.exportDir, `${safeName(artifact.title)}-${stamp}.pptx`);
  await pptx.writeFile({ fileName: path });
  return { path, rows: tabular(artifact, run).rows.length };
}

export async function exportArtifact(
  store: Store,
  config: ExportTarget,
  artifactId: string,
  format: ExportFormat,
): Promise<ArtifactExportResult> {
  const artifact = store.getArtifact(artifactId);
  if (!artifact) throw Object.assign(new Error('产物不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
  const run = latestRun(store, artifactId);
  if (!run) throw Object.assign(new Error('产物还没有运行结果'), { code: 'ARTIFACT_NOT_RUN', status: 400 });
  if (format === 'pptx') {
    const result = await writePptx(artifact, run, config);
    return { ...result, bytes: statSync(result.path).size, format };
  }
  const reportSpec = (artifact.type === 'report' || artifact.type === 'compare') && (run?.result as ReportSpec | undefined)?.sections
    ? (run!.result as ReportSpec)
    : undefined;
  const table = reportSpec ? { columns: [] as string[], rows: [] as unknown[][] } : tabular(artifact, run);
  const file = writeExportFile({
    dir: config.exportDir,
    format: 'xlsx',
    columns: table.columns,
    rows: table.rows,
    tableName: safeName(artifact.title),
    engine: 'sqlite',
    baseName: safeName(artifact.title),
    // 报告按结构分 sheet：摘要、指标、每个表格块各一张，图表与对比另存。
    ...(reportSpec ? { sheets: reportSheetsOf(reportSpec) } : {}),
  });
  return { path: file.path, rows: file.rows, bytes: file.bytes ?? 0, format };
}
