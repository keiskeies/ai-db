import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasBinding, oracleBindingDirs, unavailableEngines } from '../src/engineAvailability';

function withBindings(files: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidb-binding-'));
  for (const file of files) writeFileSync(path.join(dir, file), '');
  return dir;
}

function cleanup(dir: string) {
  // 某些宿主的安全删除钩子会拦 rmSync，清理失败不影响断言结果。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test('macOS Intel 缺 darwin-x64 绑定时 Oracle 标记为不可用', () => {
  const dir = withBindings(['oracledb-26.0.0-darwin-arm64.node']);
  try {
    assert.equal(hasBinding([dir], 'darwin', 'arm64'), true);
    assert.equal(hasBinding([dir], 'darwin', 'x64'), false);

    const blocked = unavailableEngines('darwin', 'x64', [dir]);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].engine, 'oracle');
    assert.equal(blocked[0].code, 'ORACLE_BINDING_MISSING');
    assert.equal(blocked[0].platform, 'darwin-x64');

    // 有绑定的架构不受影响
    assert.deepEqual(unavailableEngines('darwin', 'arm64', [dir]), []);
  } finally {
    cleanup(dir);
  }
});

test('绑定目录缺失时按不可用处理且不抛错', () => {
  const dir = path.join(tmpdir(), 'aidb-binding-missing-dir');
  assert.equal(hasBinding([dir], 'linux', 'x64'), false);
  const blocked = unavailableEngines('win32', 'x64', [dir]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].platform, 'win32-x64');
});

test('默认探测目录同时覆盖打包后与仓库根两种位置', () => {
  const dirs = oracleBindingDirs().map((dir) => path.resolve(dir));
  const releaseTail = path.join('oracledb', 'build', 'Release');
  assert.ok(dirs.length >= 2);
  assert.ok(dirs.every((dir) => dir.endsWith(releaseTail)));
  // 三个候选位置必须互不相同，否则说明相对路径算错了
  assert.equal(new Set(dirs).size, dirs.length);
  // 打包后：<gateway>/node_modules/oracledb/...；dev：<repo>/node_modules/oracledb/...
  assert.ok(dirs.some((dir) => dir.split(path.sep).join('/').endsWith('/gateway/node_modules/oracledb/build/Release')));
});

test('按完整「平台-架构」后缀匹配，不做前缀/子串匹配', () => {
  const dir = withBindings(['oracledb-26.0.0-darwin-arm64.node', 'oracledb-26.0.0-win32-x64.node']);
  try {
    assert.equal(hasBinding([dir], 'darwin', 'x64'), false);
    assert.equal(hasBinding([dir], 'win32', 'x64'), true);
    assert.equal(hasBinding([dir], 'linux', 'x64'), false);
  } finally {
    cleanup(dir);
  }
});
