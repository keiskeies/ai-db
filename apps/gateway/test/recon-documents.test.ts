import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { reconcileData, type ReconMapping } from '../src/features/reconcile';

function columns(names: string[]) {
  return names.map((name) => ({ name, type: 'string' }));
}

const fakeManager = {
  async query(_connectionId: string, text: string) {
    const query = JSON.parse(text);
    if (query.collection) {
      if (query.op === 'count') {
        return { sets: [{ columns: columns(['count']), rows: [[3]], rowCount: 1, durationMs: 1 }], messages: [], durationMs: 1 };
      }
      if (query.filter) {
        return {
          sets: [{ columns: columns(['_id', 'name', 'status']), rows: [['1', 'Ada', 'PAID'], ['2', 'Bob', 'NEW'], ['3', 'Cid', 'PAID']], rowCount: 3, durationMs: 1 }],
          messages: [],
          durationMs: 1,
        };
      }
      return { sets: [{ columns: columns(['_id']), rows: [['1'], ['2'], ['3']], rowCount: 3, durationMs: 1 }], messages: [], durationMs: 1 };
    }
    if (query.index) {
      if (query.size === 0) {
        return { sets: [{ columns: [], rows: [], rowCount: 0, durationMs: 1 }], messages: ['total=3'], durationMs: 1 };
      }
      if (query.body?.query?.ids) {
        return {
          sets: [{ columns: columns(['_id', '_score', 'name', 'status']), rows: [['1', null, 'Ada', 'PAID'], ['2', null, 'Bob', 'PAID'], ['4', null, 'Dee', 'PAID']], rowCount: 3, durationMs: 1 }],
          messages: ['total=3'],
          durationMs: 1,
        };
      }
      return { sets: [{ columns: columns(['_id', '_score']), rows: [['1', null], ['2', null], ['4', null]], rowCount: 3, durationMs: 1 }], messages: ['total=3'], durationMs: 1 };
    }
    throw new Error(`unexpected query ${text}`);
  },
} as any;

test('Mongo ↔ Elasticsearch 文档对账适配器', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-recon-docs-'));
  try {
    const store = new Store(join(dir, 'aidb.db'), 'secret');
    const mongo = store.createConnection({ name: 'Mongo', engine: 'mongodb', host: '127.0.0.1', port: 27017, database: 'app' });
    const es = store.createConnection({ name: 'ES', engine: 'elasticsearch', host: 'http://127.0.0.1:9200', database: 'app' });
    const mapping: ReconMapping = {
      mode: 'documents-documents',
      left: { kind: 'documents', connectionId: mongo.id, collection: 'users', idField: '_id', fields: ['name', 'status'] },
      right: { kind: 'documents', connectionId: es.id, collection: 'users', idField: '_id', fields: ['name', 'status'] },
      baseSide: 'left',
      maxKeys: 100,
    };
    const result = await reconcileData(store, fakeManager, mapping, 'fields');
    assert.equal(result.summary.comparedKeys, 3);
    assert.equal(result.summary.missingInRight, 1);
    assert.equal(result.summary.extraInRight, 1);
    assert.equal(result.summary.valueChanged, 1);
    assert.ok(result.target.differences.some((diff) => diff.key === '3' && diff.status === 'missing_in_right'));
    assert.ok(result.target.differences.some((diff) => diff.key === '4' && diff.status === 'extra_in_right'));
    assert.ok(result.target.differences.some((diff) => diff.key === '2' && diff.status === 'value_changed'));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
