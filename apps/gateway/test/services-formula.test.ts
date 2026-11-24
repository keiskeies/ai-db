import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCsv, importCsv, toCsv } from '../src/services';

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

test('CSV 导入查表与写入都使用会话选中的数据库和执行追踪', async () => {
  const calls: Array<{ kind: string; database?: string; executionId?: string }> = [];
  const store = {
    getConnection: () => ({ id: 'c1', engine: 'sqlite', database: 'main', readonly: false }),
  };
  const manager = {
    findTable: async (_id: string, database?: string) => {
      calls.push({ kind: 'findTable', database });
      return {
        table: {
          name: 'items',
          columns: [{ name: 'name', type: 'TEXT', autoIncrement: false }],
        },
      };
    },
    runParams: async (_id: string, _sql: string, _params: unknown[], opts: { database?: string; executionId?: string }) => {
      calls.push({ kind: 'runParams', database: opts.database, executionId: opts.executionId });
      return { affected: 1 };
    },
  };
  const result = await importCsv(store as any, manager as any, {} as any, 'c1', {
    table: 'items',
    csv: 'name\nalpha\n',
    hasHeader: true,
    database: 'session_db',
    executionId: 'exec-1',
  });
  assert.equal(result.inserted, 1);
  assert.deepEqual(calls, [
    { kind: 'findTable', database: 'session_db' },
    { kind: 'runParams', database: 'session_db', executionId: 'exec-1' },
  ]);
});
