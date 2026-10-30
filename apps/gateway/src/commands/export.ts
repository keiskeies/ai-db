import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import PptxGenJS from 'pptxgenjs';
import type { ArtifactInfo, ArtifactRunInfo, ReportSpec } from '@aidb/core';
import type { GatewayConfig } from '../config';
import { writeExportFile } from '../services';
import type { Store } from '../store';

export type ExportFormat = 'xlsx' | 'pptx';

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

function reportRows(spec: ReportSpec): { columns: string[]; rows: unknown[][] } {
  const rows: unknown[][] = [];
  for (const section of spec.sections) {
    for (const block of section.blocks) {
      if (block.kind === 'narrative') rows.push([section.title, '叙述', block.text ?? '']);
      else if (block.kind === 'metric') {
        for (const metric of block.metrics ?? []) rows.push([section.title, '指标', `${metric.label}: ${metric.value}${metric.unit ?? ''}`]);
      } else if (block.kind === 'table') {
        for (const row of block.rows ?? []) rows.push([section.title, '表格', row.join(' | ')]);
      } else if (block.kind === 'chart') {
        for (const point of block.series ?? []) rows.push([section.title, '图表', `${point.label}: ${point.value}`]);
      } else if (block.kind === 'comparison') {
        rows.push([section.title, '对比', `${block.left?.label}=${block.left?.value} / ${block.right?.label}=${block.right?.value} / 差值=${block.delta?.absolute ?? ''}`]);
      } else if (block.kind === 'callout') {
        rows.push([section.title, '说明', block.text ?? '']);
      }
    }
  }
  return { columns: ['章节', '类型', '内容'], rows };
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
    if (spec?.sections) return reportRows(spec);
  }
  if (artifact.type === 'diff') return diffRows(run?.result);
  if (artifact.type === 'recon') return reconRows(run?.result);
  if (artifact.type === 'fix') return fixRows(run?.result);
  return { columns: ['内容'], rows: [] };
}

async function writePptx(artifact: ArtifactInfo, run: ArtifactRunInfo | undefined, config: GatewayConfig): Promise<{ path: string; rows: number }> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'AiDB Studio';
  pptx.subject = artifact.title;
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: 'FFFFFF' };
  titleSlide.addText(artifact.title, { x: 0.7, y: 2.1, w: 11.9, h: 1.1, fontSize: 30, bold: true, color: '1F2937' });
  titleSlide.addText(
    `${artifact.type} · ${new Date(artifact.updatedAt).toLocaleString()} · AiDB Studio`,
    { x: 0.7, y: 3.3, w: 11.9, h: 0.5, fontSize: 13, color: '6B7280' },
  );

  if (artifact.type === 'report' || artifact.type === 'compare') {
    const spec = run?.result as ReportSpec | undefined;
    for (const section of spec?.sections ?? []) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(section.title, { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 22, bold: true, color: '111827' });
      const lines: string[] = [];
      for (const block of section.blocks) {
        if (block.kind === 'narrative' && block.text) lines.push(block.text);
        else if (block.kind === 'metric') for (const metric of block.metrics ?? []) lines.push(`${metric.label}: ${metric.value}${metric.unit ?? ''}`);
        else if (block.kind === 'comparison') lines.push(`${block.left?.label}: ${block.left?.value}    ${block.right?.label}: ${block.right?.value}    差值: ${block.delta?.absolute ?? ''}`);
        else if (block.kind === 'callout' && block.text) lines.push(block.text);
        else if (block.kind === 'table') for (const row of (block.rows ?? []).slice(0, 10)) lines.push(row.join('  |  '));
        else if (block.kind === 'chart') for (const point of block.series ?? []) lines.push(`${point.label}: ${point.value}`);
      }
      slide.addText(lines.length ? lines.map((line) => ({ text: line, options: { bullet: false } })) : [{ text: '（本节无文本内容）' }], {
        x: 0.8,
        y: 1.2,
        w: 11.6,
        h: 5.6,
        fontSize: 14,
        color: '374151',
        breakLine: true,
        valign: 'top',
      });
    }
  } else {
    const table = tabular(artifact, run);
    const slide = pptx.addSlide();
    slide.addText(artifact.title, { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 22, bold: true, color: '111827' });
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
  config: GatewayConfig,
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
  const table = tabular(artifact, run);
  const file = writeExportFile({
    dir: config.exportDir,
    format: 'xlsx',
    columns: table.columns,
    rows: table.rows,
    tableName: safeName(artifact.title),
    engine: 'sqlite',
    baseName: safeName(artifact.title),
  });
  return { path: file.path, rows: file.rows, bytes: file.bytes ?? 0, format };
}
