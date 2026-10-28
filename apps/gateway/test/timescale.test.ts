import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresDriver } from '../src/drivers/postgres';

const PORT = process.env.AIDB_TEST_TIMESCALE_PORT ? Number(process.env.AIDB_TEST_TIMESCALE_PORT) : undefined;

test('TimescaleDB driver annotates hypertables', { skip: !PORT }, async () => {
  const pool = new pg.Pool({ host: '127.0.0.1', port: PORT!, user: 'postgres', password: 'test', database: 'aidb' });
  await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  await pool.query('DROP TABLE IF EXISTS aidb_metrics');
  await pool.query('CREATE TABLE aidb_metrics (ts timestamptz NOT NULL, host text, value double precision)');
  await pool.query("SELECT create_hypertable('aidb_metrics', 'ts')");
  await pool.query("INSERT INTO aidb_metrics VALUES ('2024-01-05T00:00:00Z', 'a', 1), ('2024-02-05T00:00:00Z', 'b', 2)");

  const driver = new PostgresDriver({ host: '127.0.0.1', port: PORT!, user: 'postgres', password: 'test', database: 'aidb' }, 'timescale');
  try {
    const ping = await driver.test();
    assert.equal(ping.ok, true, ping.message);

    const tables = await driver.describe('aidb');
    const metrics = tables.find((table) => table.name === 'aidb_metrics');
    assert.ok(metrics, '超表出现在对象树');
    assert.match(String(metrics?.comment), /超表 · \d+ chunks/);
    assert.ok(metrics?.columns?.some((column) => column.name === 'ts' && column.type === 'timestamp with time zone'));

    const bucket = await driver.run(
      "SELECT time_bucket('1 month', ts) AS bucket, count(*) AS total FROM aidb_metrics GROUP BY 1 ORDER BY 1",
    );
    assert.equal(bucket.rowCount, 2);
    assert.equal(Number(bucket.rows[0][1]), 1);

    const explain = await driver.run('EXPLAIN SELECT count(*) FROM aidb_metrics');
    assert.ok(explain.rowCount > 0);
  } finally {
    await driver.close();
    await pool.end();
  }
});

test('plain PostgreSQL connections skip hypertable metadata', { skip: !PORT }, async () => {
  const driver = new PostgresDriver({ host: '127.0.0.1', port: PORT!, user: 'postgres', password: 'test', database: 'aidb' }, 'postgresql');
  try {
    const tables = await driver.describe('aidb');
    const metrics = tables.find((table) => table.name === 'aidb_metrics');
    assert.ok(metrics);
    assert.equal(metrics?.comment, undefined);
  } finally {
    await driver.close();
  }
});
