import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReportSpec } from '../src/commands/report';
import { buildReportBrief } from '../src/commands/reportBrief';
import { checkReportCoverage } from '../src/commands/reportQuality';

const brief = buildReportBrief({ topic: '本月经营概览' });
const metrics = Array.from({ length: 4 }, (_, index) => ({ label: `指标${index + 1}`, value: 100 + index, baseline: 90 + index }));

function spec(metricCount = 4): ReportSpec {
  return {
    version: 1,
    title: '经营月报',
    layout: 'sections',
    sources: [{ key: 's1', connectionId: 'c1', connectionName: 'Demo', database: 'shop', engine: 'sqlite', label: 'Demo' }],
    executive: { headline: '订单量 100 笔', takeaways: ['订单量 100 笔'] },
    sections: [{
      id: 'overview', title: '经营概览', conclusion: '核心指标保持增长',
      blocks: [{ kind: 'metric', metrics: metrics.slice(0, metricCount) }],
    }],
    meta: { intent: '本月经营概览', createdAt: '2026-11-01T00:00:00.000Z', brief },
  };
}

test('覆盖闸口要求足量核心指标，具体例外可以放行', () => {
  assert.equal(checkReportCoverage(spec(4), brief).errors.length, 0);
  const thin = checkReportCoverage(spec(2), brief);
  assert.ok(thin.errors.some((error) => /核心指标只有 2 个/.test(error)));
  assert.equal(checkReportCoverage(spec(2), brief, ['业务表只有两个可用指标']).errors.length, 0);
});

test('图表不足和缺失分析会形成可见提示，不伪造覆盖', () => {
  const result = checkReportCoverage(spec(), brief);
  assert.ok(result.notes.some((note) => /只有 0 张图/.test(note)));
  assert.ok(result.notes.some((note) => /trend/.test(note)));
  assert.ok(result.notes.some((note) => /attribution/.test(note)));
});
