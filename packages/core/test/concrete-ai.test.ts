import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider, detectIntent } from '../src/agent/providers/local';
import type { AgentContextData, ProviderEvent } from '../src/agent/types';
import type { ConnectionConfig, TableInfo } from '../src/types';

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'Demo',
  engine: 'sqlite',
  color: 'green',
  environment: 'dev',
  groupName: 'demo',
  database: '/tmp/demo.sqlite',
  readonly: false,
  createdAt: '',
  updatedAt: '',
};

const tables: TableInfo[] = [
  { name: 'users', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'name', type: 'TEXT', nullable: false, primaryKey: false }] },
  { name: 'orders', type: 'table', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'status', type: 'TEXT', nullable: true, primaryKey: false }] },
];

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('intent detection recognizes concrete AI skills', () => {
  assert.equal(detectIntent('给数据库做一次体检'), 'audit');
  assert.equal(detectIntent('检查 orders 的空值和重复主键'), 'quality');
  assert.equal(detectIntent('按 status 统计 orders 并画柱状图'), 'chart');
});

test('local reasoner invokes audit, chart and quality tools', async () => {
  const provider = new LocalProvider();
  const context: AgentContextData = { connection, databases: [{ name: 'main', tables }] };

  const auditEvents = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '给数据库做一次体检' }], tools: [], context }));
  const auditCall = auditEvents.find((event) => event.type === 'tool_call');
  assert.ok(auditCall && auditCall.type === 'tool_call' && auditCall.call.name === 'audit_database');

  const chartEvents = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '按 status 统计 orders 并画柱状图' }], tools: [], context }));
  const chartCall = chartEvents.find((event) => event.type === 'tool_call');
  assert.ok(chartCall && chartCall.type === 'tool_call' && chartCall.call.name === 'render_chart');
  assert.match(String((chartCall as any).call.args.sql), /GROUP BY "status"/);

  const qualityEvents = await collect(provider.stream({ system: '', messages: [{ role: 'user', content: '检查 orders 的空值和重复主键' }], tools: [], context }));
  const qualityCall = qualityEvents.find((event) => event.type === 'tool_call');
  assert.ok(qualityCall && qualityCall.type === 'tool_call' && qualityCall.call.name === 'check_data_quality');
});
