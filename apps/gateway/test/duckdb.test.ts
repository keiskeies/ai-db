import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckdbDriver } from '../src/drivers/duckdb';

test('DuckDB driver contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-duckdb-'));
  const path = join(dir, 'test.duckdb');
  const driver = new DuckdbDriver(path, false);
  try {
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);
    assert.match(String(ping.version), /DuckDB/i);

    await driver.run('CREATE TABLE metrics (id INTEGER, name VARCHAR, amount DOUBLE)');
    await driver.runParams('INSERT INTO metrics VALUES (?, ?, ?)', [1, 'Ada', 12.5]);
    await driver.runParams('INSERT INTO metrics VALUES (?, ?, ?)', [2, 'Linus', 7]);
    const rows = await driver.run('SELECT id, name, amount FROM metrics ORDER BY id');
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows, [
      [1, 'Ada', 12.5],
      [2, 'Linus', 7],
    ]);

    const tables = await driver.describe();
    const metrics = tables.find((table) => table.name === 'metrics');
    assert.ok(metrics, 'metrics table listed');
    assert.equal(metrics.type, 'table');
    assert.ok(metrics.columns?.some((column) => column.name === 'name' && /VARCHAR/i.test(column.type)));
  } finally {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
