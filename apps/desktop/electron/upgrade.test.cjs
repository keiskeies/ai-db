const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { backupBeforeUpgrade, installedVersion, markVersion, versionMarker } = require('./upgrade.cjs');
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'aidb-upgrade-'));
  try {
    // backupBeforeUpgrade 已异步化：必须 await 完成后再清理临时目录。
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('首次安装不备份，写入版本标记', () => {
  withHome((home) => {
    markVersion(home, '0.1.0');
    assert.equal(installedVersion(home), '0.1.0');
    assert.equal(existsSync(versionMarker(home)), true);
  });
});

test('同版本启动不重复备份', async () => {
  await withHome(async (home) => {
    writeFileSync(join(home, 'aidb.db'), 'db');
    markVersion(home, '0.1.0');
    const result = await backupBeforeUpgrade({ home, version: '0.1.0' });
    assert.equal(result.backupDir, undefined);
  });
});

test('覆盖升级先把数据库与 WAL 一起备份', async () => {
  await withHome(async (home) => {
    writeFileSync(join(home, 'aidb.db'), 'main');
    writeFileSync(join(home, 'aidb.db-wal'), 'wal');
    writeFileSync(join(home, 'aidb.db-shm'), 'shm');
    markVersion(home, '0.1.0');

    const { backupDir, previous } = await backupBeforeUpgrade({ home, version: '0.1.1', now: 1234 });
    assert.equal(previous, '0.1.0');
    assert.ok(backupDir && existsSync(backupDir));
    assert.equal(readFileSync(join(backupDir, 'aidb.db'), 'utf8'), 'main');
    assert.equal(readFileSync(join(backupDir, 'aidb.db-wal'), 'utf8'), 'wal');
    assert.equal(readFileSync(join(backupDir, 'aidb.db-shm'), 'utf8'), 'shm');
    assert.match(backupDir, /upgrade-0\.1\.0-to-0\.1\.1-1234$/);
  });
});

test('wal/shm 不存在时只备份主库文件', async () => {
  await withHome(async (home) => {
    writeFileSync(join(home, 'aidb.db'), 'main');
    markVersion(home, '0.1.0');
    const { backupDir } = await backupBeforeUpgrade({ home, version: '0.1.1', now: 5678 });
    assert.ok(backupDir && existsSync(join(backupDir, 'aidb.db')));
    assert.equal(existsSync(join(backupDir, 'aidb.db-wal')), false);
    assert.equal(existsSync(join(backupDir, 'aidb.db-shm')), false);
  });
});

test('升级但数据库尚未创建时只更新版本标记', async () => {
  await withHome(async (home) => {
    markVersion(home, '0.1.0');
    const result = await backupBeforeUpgrade({ home, version: '0.1.1' });
    assert.equal(result.backupDir, undefined);
    markVersion(home, '0.1.1');
    assert.equal(installedVersion(home), '0.1.1');
  });
});

test('NSIS 配置保持按用户覆盖安装并保留数据', () => {
  const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /oneClick:\s*false/);
  assert.match(yml, /perMachine:\s*false/);
  assert.match(yml, /deleteAppDataOnUninstall:\s*false/);
  assert.match(yml, /artifactName:\s*\$\{productName\}-\$\{version\}-setup\.\$\{ext\}/);
});

test('主进程在拉起 Bridge 前备份、健康后才写版本标记', () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /backupBeforeUpgrade/);
  assert.match(main, /markVersion/);
  const backupAt = main.indexOf('backupBeforeUpgrade');
  const spawnAt = main.indexOf('gatewayProcess = spawn');
  const markAt = main.indexOf('markVersion(app.getPath');
  assert.ok(backupAt > 0 && spawnAt > backupAt, '备份必须先于 gateway 启动');
  assert.ok(markAt > spawnAt, '版本标记必须晚于 gateway 启动（健康检查之后）');
});
