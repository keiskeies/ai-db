import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoDriver } from '../src/drivers/mongodb';
import { Store } from '../src/store';

test('Mongo replica set, auth source and direct connection reach the URI', () => {
  const driver = new MongoDriver({ host: '127.0.0.1', port: 27017 });
  assert.equal((driver as any).uri(), 'mongodb://127.0.0.1:27017');

  const multi = new MongoDriver({
    host: '10.0.0.1,10.0.0.2',
    port: 27017,
    user: 'u',
    password: 'p',
    database: 'app',
    replicaSet: 'rs0',
    authSource: 'admin',
    directConnection: true,
  });
  assert.equal(
    (multi as any).uri(),
    'mongodb://u:p@10.0.0.1:27017,10.0.0.2:27017/app?replicaSet=rs0&authSource=admin&directConnection=true',
  );

  const tls = new MongoDriver({ host: 'h', port: 0, ssl: true });
  assert.match((tls as any).uri(), /tls=true/);

  const full = new MongoDriver({ host: 'mongodb+srv://user:pw@cluster.example', port: 0 });
  assert.equal((full as any).uri(), 'mongodb+srv://user:pw@cluster.example');
});

test('connection options persist and can be cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-options-'));
  const store = new Store(join(dir, 't.db'), 'unit-secret');
  try {
    const created = store.createConnection({
      name: 'mongo',
      engine: 'mongodb',
      host: 'a,b',
      port: 27017,
      options: { replicaSet: 'rs0', authSource: 'admin', directConnection: true },
    });
    assert.deepEqual(created.options, { replicaSet: 'rs0', authSource: 'admin', directConnection: true });

    const updated = store.updateConnection(created.id, { options: { replicaSet: 'rs1' } });
    assert.deepEqual(updated.options, { replicaSet: 'rs1' });

    const cleared = store.updateConnection(created.id, { options: {} });
    assert.equal(cleared.options?.replicaSet, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
