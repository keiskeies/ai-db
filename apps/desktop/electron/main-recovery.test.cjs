const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

// main.cjs 依赖 electron，无法在纯 node 里实例化；沿用 upgrade.test.cjs 的源码断言风格，
// 守住崩溃恢复 / 孤儿进程 / PDF 超时这几条关键约束不被后续改动悄悄拆掉。
const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
const upgrade = readFileSync(join(__dirname, 'upgrade.cjs'), 'utf8');

test('E1 意外退出按指数退避重启：1s 起、30s 封顶、10 分钟 5 次上限', () => {
  assert.match(main, /let restartDelay = 1000/);
  assert.match(main, /RESTART_DELAY_CAP_MS = 30_000/);
  assert.match(main, /RESTART_WINDOW_MS = 10 \* 60_000/);
  assert.match(main, /RESTART_MAX = 5/);
  assert.match(main, /restartDelay = Math\.min\(restartDelay \* 2, RESTART_DELAY_CAP_MS\)/);
  // 超限必须通知渲染进程（或无窗口时弹系统对话框）。
  assert.match(main, /gateway:event', \{ type: 'fatal'/);
});

test('E1 主动退出不重启：before-quit 先置 quitting 再 kill', () => {
  const quitAt = main.indexOf("app.on('before-quit'");
  assert.ok(quitAt > 0);
  const quitBlock = main.slice(quitAt);
  const flagAt = quitBlock.indexOf('quitting = true');
  const killAt = quitBlock.indexOf('gatewayProcess.kill()');
  assert.ok(flagAt > 0 && killAt > flagAt, '必须先置 quitting 再 kill，否则 exit 回调会拉起新网关');
  assert.match(main, /if \(quitting \|\| gatewayProcess !== child\) return/);
});

test('E1 启动健康检查失败弹重试/退出对话框，不再静默 quit', () => {
  assert.match(main, /async function bootstrapWindow/);
  assert.match(main, /buttons: \['重试', '退出'\]/);
  assert.match(main, /if \(response === 0\) return bootstrapWindow\(\)/);
});

test('E2 spawn 前复用存活网关，杜绝 macOS 孤儿进程', () => {
  assert.match(main, /gatewayProcess\.exitCode === null && !gatewayProcess\.killed/);
  const reuseAt = main.indexOf('if (gatewayAlive() && gatewayInfo)');
  const spawnAt = main.indexOf('gatewayProcess = spawn');
  assert.ok(reuseAt > 0 && spawnAt > reuseAt, '复用检查必须先于 spawn');
});

test('E3 主进程不再有 spawnSync / copyFileSync 阻塞', () => {
  // 只查真实调用与导入，WHY 注释里提到旧 API 名不算违规。
  assert.doesNotMatch(main, /spawnSync\(/);
  assert.doesNotMatch(main, /spawn, spawnSync/);
  assert.doesNotMatch(upgrade, /copyFileSync\(/);
  assert.match(upgrade, /await fs\.promises\.copyFile/);
  assert.match(main, /await backupBeforeUpgrade/);
  assert.match(main, /await findSystemNode\(\)/);
});

test('E4 export-pdf 整体 60s 超时 + 5MB 上限，到期销毁隐藏窗口', () => {
  assert.match(main, /PDF_TIMEOUT_MS = 60_000/);
  assert.match(main, /PDF_HTML_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(main, /Promise\.race\(\[timeout, render\]\)/);
  const pdfAt = main.indexOf("ipcMain.handle('export-pdf'");
  const pdfBlock = main.slice(pdfAt, main.indexOf('registerExportDialogs'));
  assert.match(pdfBlock, /win\.destroy\(\)/);
  assert.match(pdfBlock, /clearTimeout\(timer\)/);
});