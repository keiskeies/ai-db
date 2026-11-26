import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckdbSession } from '../src/pipeline/duckdb';

function literal(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/'/g, "''")}'`;
}

test('DuckDB materializes controlled JSON input before locking all external access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-duckdb-sandbox-'));
  const session = new DuckdbSession(join(dir, 'work'));
  const hostFile = join(dir, 'host.csv');
  const copyFile = join(dir, 'copy.csv');
  writeFileSync(hostFile, 'secret\nmust-not-read\n');
  try {
    assert.equal(await session.loadRows([{ id: 1, city: '上海' }, { id: 2, city: '北京' }]), true);
    const result = await session.query('SELECT id, city FROM input ORDER BY id', 10);
    assert.deepEqual(result.rows, [{ id: 1, city: '上海' }, { id: 2, city: '北京' }]);
    const settings = await session.query("SELECT current_setting('enable_external_access') AS external, current_setting('allow_unsigned_extensions') AS unsigned", 1);
    assert.deepEqual(settings.rows, [{ external: false, unsigned: false }]);
    await assert.rejects(session.query(`SELECT * FROM read_csv_auto(${literal(hostFile)})`, 1), (err: any) => err.code === 'PIPELINE_DUCKDB_QUERY');
    await assert.rejects(session.query(`COPY input TO ${literal(copyFile)} (FORMAT CSV)`, 1), (err: any) => err.code === 'PIPELINE_DUCKDB_QUERY');

    // 同一运行的后续 SQL step 可复用 input；下一次注册输入会重建干净连接。
    assert.equal((await session.query('SELECT count(*) AS n FROM input', 1)).rows[0].n, 2);
    assert.equal(await session.loadRows([{ id: 3 }]), true);
    assert.deepEqual((await session.query('SELECT * FROM input', 10)).rows, [{ id: 3 }]);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct SQL without input is hardened before execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-duckdb-direct-'));
  const session = new DuckdbSession(join(dir, 'work'));
  const hostFile = join(dir, 'host.csv');
  writeFileSync(hostFile, 'secret\n');
  try {
    assert.deepEqual((await session.query('SELECT 1 AS n', 1)).rows, [{ n: 1 }]);
    await assert.rejects(session.query(`SELECT * FROM read_csv_auto(${literal(hostFile)})`, 1), (err: any) => err.code === 'PIPELINE_DUCKDB_QUERY');
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
