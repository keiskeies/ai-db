import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, promises as fsp, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepDataDirs } from '../src/attachments';

const DAY = 86_400_000;

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-sweep-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function makeFile(path: string, bytes: number, ageMs: number): Promise<void> {
  writeFileSync(path, Buffer.alloc(bytes, 1));
  const at = new Date(Date.now() - ageMs);
  await fsp.utimes(path, at, at);
}

test('超过 7 天的文件按 mtime 删除，新文件保留', () =>
  withDir(async (dir) => {
    await makeFile(join(dir, 'old.png'), 10, 8 * DAY);
    await makeFile(join(dir, 'fresh.png'), 10, 1 * DAY);
    await sweepDataDirs([dir]);
    assert.equal(existsSync(join(dir, 'old.png')), false);
    assert.equal(existsSync(join(dir, 'fresh.png')), true);
  }));

test('单目录超过容量上限按最旧删，直到回到上限内', () =>
  withDir(async (dir) => {
    // 三个 600B 文件都早于 1 小时「使用中」保护线；上限 1000B → 删到剩一个。
    await makeFile(join(dir, 'a.bin'), 600, 4 * 60 * 60_000);
    await makeFile(join(dir, 'b.bin'), 600, 3 * 60 * 60_000);
    await makeFile(join(dir, 'c.bin'), 600, 2 * 60 * 60_000);
    await sweepDataDirs([dir], { maxBytes: 1000, maxAgeMs: 30 * DAY });
    assert.equal(existsSync(join(dir, 'a.bin')), false);
    assert.equal(existsSync(join(dir, 'b.bin')), false);
    assert.equal(existsSync(join(dir, 'c.bin')), true);
  }));

test('最近 1 小时内修改的文件即使超容量也不删（正在使用保护）', () =>
  withDir(async (dir) => {
    await makeFile(join(dir, 'active.bin'), 5000, 60_000);
    await sweepDataDirs([dir], { maxBytes: 100, maxAgeMs: 30 * DAY });
    assert.equal(existsSync(join(dir, 'active.bin')), true);
  }));

test('skill-runs 式子目录：超龄文件删除后空壳目录回收，根目录保留', () =>
  withDir(async (dir) => {
    const runDir = join(dir, 'run-1', 'output');
    await fsp.mkdir(runDir, { recursive: true });
    await makeFile(join(runDir, 'old.csv'), 10, 8 * DAY);
    await makeFile(join(dir, 'keep.txt'), 10, 0);
    await sweepDataDirs([dir]);
    assert.equal(existsSync(join(dir, 'run-1')), false);
    assert.equal(existsSync(dir), true, '根目录必须保留，后续写入不依赖 mkdir');
    assert.equal(existsSync(join(dir, 'keep.txt')), true);
  }));

test('目录不存在或路径是文件时静默跳过，不抛错', async () => {
  await sweepDataDirs([join(tmpdir(), 'aidb-sweep-definitely-missing-xyz')]);
  const dir = mkdtempSync(join(tmpdir(), 'aidb-sweep-file-'));
  try {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    await sweepDataDirs([file]);
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opts.now 可注入：以虚拟时间判定超龄', () =>
  withDir(async (dir) => {
    await makeFile(join(dir, 'x.png'), 10, 2 * DAY);
    // 虚拟「现在」是 10 天后 → 2 天前的文件也超 7 天线。
    await sweepDataDirs([dir], { now: Date.now() + 10 * DAY });
    assert.equal(existsSync(join(dir, 'x.png')), false);
  }));