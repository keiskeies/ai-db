import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, auditCsv } from '../src/services';

test('CSV 导出中和公式前缀：= + @ - 开头不再被 Excel 当公式', () => {
  const csv = toCsv(['值'], [['=SUM(A1:A9)'], ['+x'], ['@cmd'], ['-1'], ['普通文本'], [1]]);
  assert.match(csv, /'=SUM\(A1:A9\)/, '= 前缀应被中和');
  assert.match(csv, /'\+x/, '+ 前缀应被中和');
  assert.match(csv, /'@cmd/, '@ 前缀应被中和');
  assert.match(csv, /'-1/, '- 前缀应被中和');
  assert.match(csv, /普通文本/);
  assert.match(csv, /\r\n1\r\n$/, '数值不应被破坏');
});

test('auditCsv(导出审计) 同样中和公式前缀', () => {
  const csv = auditCsv([{ tool: '=cmd', status: 'ok' }]);
  assert.match(csv, /'=cmd/);
  assert.doesNotMatch(csv, /,\s*=cmd/);
});
