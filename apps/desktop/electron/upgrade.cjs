const fs = require('node:fs');
const path = require('node:path');

const MARKER = '.app-version';

function versionMarker(home) {
  return path.join(home, MARKER);
}

function installedVersion(home) {
  try {
    return fs.readFileSync(versionMarker(home), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 升级安装时 gateway 会对 aidb.db 做结构迁移。先按旧版本号整体备份一份，
 * 迁移失败时用户可以从 backups/upgrade-* 直接取回。
 */
function backupBeforeUpgrade({ home, version, now = Date.now() }) {
  const previous = installedVersion(home);
  if (!previous || previous === version) return { previous, backupDir: undefined };
  const db = path.join(home, 'aidb.db');
  if (!fs.existsSync(db)) return { previous, backupDir: undefined };
  const backupDir = path.join(home, 'backups', `upgrade-${previous}-to-${version}-${now}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${db}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupDir, path.basename(source)));
  }
  return { previous, backupDir };
}

function markVersion(home, version) {
  fs.writeFileSync(versionMarker(home), version);
}

module.exports = { versionMarker, installedVersion, backupBeforeUpgrade, markVersion };
