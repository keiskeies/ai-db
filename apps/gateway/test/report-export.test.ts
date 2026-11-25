import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import type { ReportSpec } from '@aidb/core';
import { exportArtifact } from '../src/commands/export';
import { Store } from '../src/store';

const specCreatedAt = '2026-11-24T00:00:00.000Z';

const spec: ReportSpec = {
  version: 1,
  title: 'Rich report export',
  layout: 'sections',
  sources: [{ key: 'main', connectionId: 'c1', connectionName: 'Demo', database: 'shop', engine: 'sqlite', label: 'Demo' }],
  meta: {
    intent: 'report', createdAt: '2026-11-24T00:00:00.000Z', audience: 'technical', locale: 'en',
    evidence: {
      q1: { ref: 'q1', tool: 'run_sql', sql: 'SELECT month, value FROM metrics', ranAt: specCreatedAt },
      q2: { ref: 'q2', tool: 'run_sql', sql: 'SELECT month, baseline FROM targets', ranAt: specCreatedAt },
    },
  },
  sections: [{
    id: 'charts',
    title: 'Charts',
    blocks: [
      {
        kind: 'table', title: 'Technical detail', columns: ['Month', 'Orders'],
        rows: Array.from({ length: 15 }, (_, index) => [`M${index + 1}`, index + 1]),
      },
      {
        kind: 'chart', title: 'Bars with baseline', resultRef: 'q1', resultRefs: ['q1', 'q2'], chartType: 'bar', xLabel: 'Month', yLabel: 'Orders', baselineName: 'Target',
        series: [{ label: 'Aug', value: 10, baseline: 8, baselineResultRef: 'q2' }, { label: 'Sep', value: 12, baseline: 9, baselineResultRef: 'q2' }],
      },
      {
        kind: 'chart', title: 'Stacked bars', chartType: 'stacked', xLabel: 'Month', yLabel: 'Orders',
        series: [{ label: 'Aug', value: 10 }, { label: 'Sep', value: 12 }],
        extraSeries: [{ name: 'Last year', values: [8, 9] }],
      },
      {
        kind: 'chart', title: 'Dual axis', chartType: 'line',
        xLabel: 'Month', yLabel: 'Revenue', baselineName: 'Target', dualAxis: true,
        series: [{ label: 'Aug', value: 100 }, { label: 'Sep', value: 120 }],
        extraSeries: [{ name: 'Cost', values: [60, 70] }],
      },
      {
        kind: 'chart', title: 'Composition', chartType: 'pie', yLabel: 'Share',
        series: [{ label: 'Ads', value: 4 }, { label: 'Search', value: 5 }, { label: 'Direct', value: 6 }],
      },
      {
        kind: 'chart', title: 'Capability', chartType: 'radar', yLabel: 'Score',
        series: [{ label: 'Speed', value: 4 }, { label: 'Quality', value: 5 }, { label: 'Cost', value: 3 }],
      },
      {
        kind: 'chart', title: 'Correlation', chartType: 'scatter', xLabel: 'Orders', yLabel: 'Revenue',
        scatter: [{ label: 'A', x: 1, y: 2 }, { label: 'B', x: 3, y: 4 }],
      },
      {
        kind: 'chart', title: 'Matrix', chartType: 'heatmap', xLabel: 'Channel', yLabel: 'Region',
        heatmap: {
          xLabels: Array.from({ length: 13 }, (_, index) => `C${index + 1}`),
          yLabels: Array.from({ length: 9 }, (_, index) => `R${index + 1}`),
          values: Array.from({ length: 9 }, (_, row) => Array.from({ length: 13 }, (_, column) => row * 13 + column)),
          valueLabel: 'Conversion',
        },
      },
    ],
  }],
};

test('report export writes native charts and preserves the full Excel heatmap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-report-export-'));
  const store = new Store(join(dir, 'store.sqlite'), 'test-secret');
  try {
    const artifact = store.createArtifact({ type: 'report', title: spec.title, spec: { ...spec, type: 'report' } });
    store.addArtifactRun({ artifactId: artifact.id, status: 'succeeded', result: spec });
    const target = { exportDir: join(dir, 'exports') };

    const deck = await exportArtifact(store, target, artifact.id, 'pptx');
    const pptx = new AdmZip(deck.path);
    const chartXml = pptx.getEntries()
      .filter((entry) => /^ppt\/charts\/chart\d+\.xml$/.test(entry.entryName))
      .map((entry) => entry.getData().toString('utf8'))
      .join('\n');
    assert.match(chartXml, /<c:barChart>/);
    assert.match(chartXml, /<c:grouping val="stacked"\/>/);
    assert.match(chartXml, /<c:lineChart>/);
    assert.match(chartXml, /<c:pieChart>/);
    assert.match(chartXml, /<c:radarChart>/);
    assert.match(chartXml, /<c:scatterChart>/);
    assert.match(chartXml, /<c:valAx>/);
    const slideXmls = pptx.getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => entry.getData().toString('utf8'));
    const slides = slideXmls.join('\n');
    assert.match(slides, /Conversion/);
    assert.match(slides, /C12/);
    assert.match(slides, /M15/);
    assert.doesNotMatch(slides, /C13/);
    assert.ok(slideXmls.every((slide) => !(slide.includes('<c:chart') && slide.includes('<a:tbl>'))), '表格和图表必须分页，不能重叠');

    const workbook = await exportArtifact(store, target, artifact.id, 'xlsx');
    const xlsx = new AdmZip(workbook.path);
    const sheetXml = xlsx.getEntries()
      .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
      .map((entry) => entry.getData().toString('utf8'))
      .join('\n');
    assert.match(sheetXml, /heatmap/);
    assert.match(sheetXml, /R9\|C13/);
    assert.match(sheetXml, /<v>104<\/v>/);
    assert.match(sheetXml, /Last year/);
    assert.match(sheetXml, /Target/);
    assert.match(sheetXml, /result_ref/);
    assert.match(sheetXml, /baseline_result_ref/);
    assert.match(sheetXml, /SELECT month, value FROM metrics/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
