import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { MongoDriver } from '../src/drivers/mongodb';
import { supportsDocumentWrite } from '../src/drivers/types';

const MONGO_PORT = process.env.AIDB_TEST_MONGO_PORT ? Number(process.env.AIDB_TEST_MONGO_PORT) : undefined;
const DB = 'aidb_write';
const OBJECT_ID = '64b0c0d0e0f0a0b0c0d0e0f0';

test('MongoDB driver writes, replaces and deletes documents', { skip: !MONGO_PORT }, async () => {
  const admin = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { serverSelectionTimeoutMS: 5000 });
  await admin.connect();
  await admin.db(DB).dropDatabase();
  await admin.close();

  const driver = new MongoDriver({ host: '127.0.0.1', port: MONGO_PORT!, database: DB });
  try {
    assert.equal(supportsDocumentWrite(driver), true);

    const written = await driver.upsertDocuments({
      collection: 'widgets',
      documents: [{ _id: OBJECT_ID, name: 'Ada', weight: 1 }, { name: 'Linus', weight: 2 }],
    });
    assert.equal(written.upserted, 2);
    assert.equal(written.ids[0], OBJECT_ID);
    assert.match(written.ids[1], /^[0-9a-f]{24}$/);

    const found = await driver.executeQuery({ language: 'mql', collection: 'widgets', op: 'find', sort: { weight: 1 } });
    assert.equal(found.rowCount, 2);
    assert.deepEqual(found.columns.map((column) => column.name).filter((name) => ['name', 'weight'].includes(name)), ['name', 'weight']);

    const replaced = await driver.upsertDocuments({
      collection: 'widgets',
      documents: [{ _id: OBJECT_ID, name: 'Ada Lovelace', weight: 3 }],
    });
    assert.deepEqual(replaced.ids, [OBJECT_ID]);
    const afterReplace = await driver.executeQuery({ language: 'mql', collection: 'widgets', op: 'find', sort: { weight: 1 } });
    const nameIndex = afterReplace.columns.findIndex((column) => column.name === 'name');
    assert.equal(afterReplace.rowCount, 2, '同 _id 覆盖而不是重复插入');
    assert.ok(afterReplace.rows.some((row) => String(row[nameIndex]) === 'Ada Lovelace'));
    assert.equal(afterReplace.rows.some((row) => String(row[nameIndex]) === 'Ada'), false);

    const count = await driver.executeQuery({ language: 'mql', collection: 'widgets', op: 'count' });
    assert.equal(Number(count.rows[0][0]), 2);

    const deleted = await driver.deleteDocuments({ collection: 'widgets', ids: [OBJECT_ID] });
    assert.equal(deleted.deleted, 1);
    const remaining = await driver.executeQuery({ language: 'mql', collection: 'widgets', op: 'count' });
    assert.equal(Number(remaining.rows[0][0]), 1);

    await assert.rejects(() => driver.upsertDocuments({ collection: '', documents: [{ a: 1 }] }), /集合名/);
    await assert.rejects(() => driver.deleteDocuments({ collection: 'widgets', ids: [] }), /ids/);
  } finally {
    await driver.close();
  }
});

test('MongoDB documents import from CSV through the write channel', { skip: !MONGO_PORT }, async () => {
  const driver = new MongoDriver({ host: '127.0.0.1', port: MONGO_PORT!, database: DB });
  try {
    const header = ['id', 'name', 'weight'];
    const rows = ['1,Alpha,10', '2,Beta,20'];
    const documents = rows.map((line) => {
      const cells = line.split(',');
      return { _id: cells[0], name: cells[1], weight: Number(cells[2]) };
    });
    assert.equal(header.length, 3);
    const written = await driver.upsertDocuments({ collection: 'imported', documents });
    assert.equal(written.upserted, 2);
    const listed = await driver.executeQuery({ language: 'mql', collection: 'imported', op: 'find', sort: { weight: -1 } });
    assert.deepEqual(listed.rows.map((row) => row.find((cell) => String(cell) === 'Beta' || String(cell) === 'Alpha')), ['Beta', 'Alpha']);
    const deleted = await driver.deleteDocuments({ collection: 'imported', ids: ['1', '2'] });
    assert.equal(deleted.deleted, 2);
  } finally {
    await driver.close();
  }
});
