import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConnectionManager } from '../src/manager';
import { composeDashboardCard, previewDashboardSql } from '../src/features/dashboardCompose';
import { Store } from '../src/store';

const schema = [
  {
    name: 'main',
    tables: [
      {
        name: 'orders',
        type: 'table',
        rowEstimate: 900,
        comment: '订单表',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'status', type: 'text', nullable: false },
          { name: 'total_cents', type: 'integer', nullable: false, comment: '订单金额（分）' },
          { name: 'created_at', type: 'text', nullable: false },
          { name: 'user_id', type: 'integer', nullable: false },
        ],
      },
    ],
  },
];

function fakeManager(onQuery?: (sql: string) => void): ConnectionManager {
  return {
    schema: async () => schema,
    query: async (_connectionId: string, sql: string) => {
      onQuery?.(sql);
      return {
        sets: [
          {
            columns: [{ name: 'dim_value', type: 'text' }, { name: 'cnt', type: 'integer' }],
            rows: [
              ['paid', 3],
              ['pending', 2],
            ],
            rowCount: 2,
            durationMs: 1,
            statement: sql,
          },
        ],
        messages: [],
        durationMs: 1,
      };
    },
  } as unknown as ConnectionManager;
}

function withStore(fn: (store: Store, dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-compose-'));
  const store = new Store(join(dir, 'store.sqlite'), 'test-secret');
  return Promise.resolve()
    .then(() => fn(store, dir))
    .finally(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

test('offline compose matches a built-in metric and returns a preview', async () => {
  await withStore(async (store, dir) => {
    const conn = store.createConnection({ name: 'Demo', engine: 'sqlite', database: join(dir, 'demo.sqlite') });
    const settings = store.getSettings();
    store.saveSettings({ ...settings, agent: { ...settings.agent, provider: 'local' } });
    let executed = '';
    const result = await composeDashboardCard({
      store,
      manager: fakeManager((sql) => (executed = sql)),
      connectionId: conn.id,
      database: conn.database,
      prompt: '按状态统计订单',
    });
    assert.equal(result.usedModel, false);
    assert.match(result.sql, /GROUP BY/i);
    assert.match(executed, /GROUP BY/i, '试跑执行的就是返回给 UI 的 SQL');
    assert.equal(result.preview.rows.length, 2);
    assert.equal(result.x, 'dim_value');
    assert.equal(result.y, 'cnt');
    assert.ok(result.notes.some((note) => note.includes('离线')), result.notes.join(' | '));
  });
});

test('offline compose refuses to invent SQL when nothing matches', async () => {
  await withStore(async (store, dir) => {
    const conn = store.createConnection({ name: 'Demo', engine: 'sqlite', database: join(dir, 'demo.sqlite') });
    const settings = store.getSettings();
    store.saveSettings({ ...settings, agent: { ...settings.agent, provider: 'local' } });
    await assert.rejects(
      () =>
        composeDashboardCard({
          store,
          manager: fakeManager(),
          connectionId: conn.id,
          database: conn.database,
          prompt: '讲个笑话',
        }),
      (err: any) => err?.code === 'MODEL_UNAVAILABLE',
    );
  });
});

test('preview never executes writes', async () => {
  await withStore(async (store, dir) => {
    const conn = store.createConnection({ name: 'Demo', engine: 'sqlite', database: join(dir, 'demo.sqlite') });
    let called = false;
    const manager = fakeManager(() => (called = true));
    const preview = await previewDashboardSql({ store, manager, connectionId: conn.id, database: conn.database, sql: 'DELETE FROM orders' });
    assert.equal(called, false);
    assert.match(String(preview.error), /查询语句|read/i);
    const ok = await previewDashboardSql({ store, manager, connectionId: conn.id, database: conn.database, sql: 'SELECT status, count(*) AS cnt FROM orders GROUP BY status' });
    assert.equal(called, true);
    assert.equal(ok.error, undefined);
    assert.equal(ok.rowCount, 2);
  });
});
