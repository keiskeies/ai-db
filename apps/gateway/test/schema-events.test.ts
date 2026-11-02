import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayEvents, type SchemaChangedEvent } from '../src/events';

test('事件总线把事件送达每个订阅者', () => {
  const bus = new GatewayEvents();
  const first: SchemaChangedEvent[] = [];
  const second: SchemaChangedEvent[] = [];
  bus.onSchemaChanged((event) => first.push(event));
  bus.onSchemaChanged((event) => second.push(event));

  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'agent', at: '2026-11-02T00:00:00.000Z' });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].connectionId, 'c1');
  assert.equal(first[0].cause, 'agent');
});

test('取消订阅后不再收到事件', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  const off = bus.onSchemaChanged((event) => seen.push(event));
  off();
  bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' });
  assert.equal(seen.length, 0);
});

test('一个监听器抛错不影响其它监听器', () => {
  const bus = new GatewayEvents();
  const seen: SchemaChangedEvent[] = [];
  bus.onSchemaChanged(() => {
    throw new Error('boom');
  });
  bus.onSchemaChanged((event) => seen.push(event));

  assert.doesNotThrow(() =>
    bus.emitSchemaChanged({ type: 'schema_changed', connectionId: 'c1', cause: 'user', at: '2026-11-02T00:00:00.000Z' }),
  );
  assert.equal(seen.length, 1);
});
