import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportBlock } from '../src/commands/reportAgent';

const refs = new Map<string, Set<number>>([['call_1', new Set([42, 7])]]);

test('报告块必须绑定存在的 resultRef，且数字来自该结果', () => {
  const metric = normalizeReportBlock(
    { kind: 'metric', resultRef: 'call_1', metrics: [{ label: '订单数', value: 42 }] },
    new Set([42]),
    refs,
    true,
  );
  assert.ok(!('error' in metric));
  assert.equal((metric as any).resultRef, 'call_1');

  const missing = normalizeReportBlock({ kind: 'metric', metrics: [{ label: '订单数', value: 42 }] }, new Set([42]), refs, true);
  assert.ok('error' in missing);
  assert.match(missing.error, /resultRef/);

  const unknown = normalizeReportBlock(
    { kind: 'chart', resultRef: 'call_missing', chartType: 'bar', series: [{ label: 'a', value: 42 }] },
    new Set([42]),
    refs,
    true,
  );
  assert.ok('error' in unknown);
  assert.match(unknown.error, /不存在/);

  const wrongValue = normalizeReportBlock(
    { kind: 'table', resultRef: 'call_1', columns: ['n'], rows: [[99]] },
    new Set([99]),
    refs,
    true,
  );
  assert.ok('error' in wrongValue);
  assert.match(wrongValue.error, /来源/);

  const comparison = normalizeReportBlock(
    { kind: 'comparison', left: { value: 7, resultRef: 'call_1' }, right: { value: 42, resultRef: 'call_1' } },
    new Set([7, 42]),
    refs,
    true,
  );
  assert.ok(!('error' in comparison));
  assert.equal((comparison as any).delta.absolute, 35);
});
