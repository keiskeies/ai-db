const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { backupBeforeUpgrade, markVersion } = require('./upgrade.cjs');
const { installMenu, configureAboutPanel } = require('./menu.cjs');
const updater = require('./updater.cjs');
const sshKeyImport = require('./ssh-key-import.cjs');
const { SshKeyImportError, addPrivateKeyDirectory } = sshKeyImport;

let gatewayProcess = null;
let mainWindow = null;
// 网关端口/token 由主进程持有；token 只经现有 preload 的 gateway:event 通道送入渲染层内存，
// 不放进页面 URL、localStorage 或 sessionStorage。窗口重载时由 dom-ready 重新交付。
let gatewayInfo = null;
// 主动退出（before-quit）置位：exit 回调据此区分「用户 quitting」与「意外崩溃」。
let quitting = false;
let restartTimer = null;
let restartDelay = 1000;
let restartTimestamps = [];
const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_MAX = 5;
const RESTART_DELAY_CAP_MS = 30_000;

/**
 * 开发态窗口会沿用 electron.exe 自身的图标（标题栏、任务栏都是 Electron 的默认图标），
 * 而打包配置里的 icon 只写进 exe / .app 的资源，运行时不会自己加载。
 * 这里给未打包的场景补一个显式路径；打包态交给 exe 资源，不再重复覆盖。
 */
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.png');
const windowIcon = !app.isPackaged && fs.existsSync(DEV_ICON) ? DEV_ICON : undefined;

// 只放行应用自己展示的 HTTPS 外链。搜索/模型文本里的URL也走这里，不能借此打开任意协议或站点。
const EXTERNAL_HTTPS_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'platform.deepseek.com',
  'console.anthropic.com',
  'platform.openai.com',
  'api.openai.com',
  'api.search.brave.com',
  'app.tavily.com',
  'serper.dev',
  'www.mojeek.com',
]);

function isAllowedExternalUrl(target) {
  try {
    const url = new URL(target);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && EXTERNAL_HTTPS_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function openAllowedExternalUrl(target) {
  if (!isAllowedExternalUrl(target)) return false;
  try {
    void Promise.resolve(shell.openExternal(target)).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// 主框架只允许留在启动时确定的本地应用 origin（开发态为 Vite origin）。
// 外链仍只经 setWindowOpenHandler 交给系统浏览器，重定向/脚本跳转不能替换整个应用。
function isTrustedAppUrl(target, trustedOrigin) {
  try {
    const url = new URL(target, trustedOrigin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && url.origin === trustedOrigin;
  } catch {
    return false;
  }
}

function guardMainFrameNavigation(event, target, trustedOrigin) {
  if (isTrustedAppUrl(target, trustedOrigin)) return true;
  event.preventDefault();
  return false;
}

function readOpenTableArg(argv = process.argv) {
  const arg = argv.find((item) => item.startsWith('--open-table='));
  if (!arg) return null;
  try {
    return JSON.parse(Buffer.from(arg.slice('--open-table='.length), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Windows 不实现 POSIX mode。私钥目录/文件必须显式移除继承，只保留当前用户、SYSTEM
// 和 Administrators；随后用 Get-Acl 复核 owner、ACE 集合、继承标志与权限，失败即拒绝导入。
const WINDOWS_ACL_TIMEOUT_MS = 10_000;
const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:AIDB_SSH_ACL_TARGET
$kind = $env:AIDB_SSH_ACL_KIND
if ([string]::IsNullOrWhiteSpace($target)) { throw 'missing ACL target' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
if ($kind -eq 'Directory') {
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
} elseif ($kind -eq 'File') {
  $security = New-Object System.Security.AccessControl.FileSecurity
} else {
  throw 'invalid ACL kind'
}
$security.SetOwner($identity.User)
$security.SetAccessRuleProtection($true, $false)
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
foreach ($sid in @($userSid, 'S-1-5-18', 'S-1-5-32-544')) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]$sid, $rights, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $security
$actual = Get-Acl -LiteralPath $target
if (-not $actual.AreAccessRulesProtected) { throw 'ACL inheritance is not blocked' }
$owner = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $userSid) { throw 'unexpected ACL owner' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$actualSids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
$expectedSids = @(@($userSid, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object)
if (($actualSids -join '|') -ne ($expectedSids -join '|')) { throw 'unexpected ACL principals' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne $rights -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'unexpected ACL rule' }
}
`;

function runWindowsAcl(target, kind) {
  return new Promise((resolve) => {
    let settled = false;
    let outputBytes = 0;
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const countOutput = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        child.kill();
        finish(false);
      }
    };
    let child;
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_SCRIPT], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          SystemRoot: systemRoot,
          WINDIR: process.env.WINDIR || systemRoot,
          PATH: process.env.PATH,
          AIDB_SSH_ACL_TARGET: target,
          AIDB_SSH_ACL_KIND: kind,
        },
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, WINDOWS_ACL_TIMEOUT_MS);
    child.stdout?.on('data', countOutput);
    child.stderr?.on('data', countOutput);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

async function hardenWindowsPrivateKeyPath(target, kind) {
  if (process.platform !== 'win32') return;
  if (typeof target !== 'string' || !target || !['File', 'Directory'].includes(kind)) {
    throw new SshKeyImportError('SSH_KEY_STORE_FAILED');
  }
  if (!await runWindowsAcl(target, kind)) {
    // 不记录命令输出：其中可能包含本机路径/账户信息；调用方只会看到固定错误码。
    throw new SshKeyImportError('SSH_KEY_ACL_UNAVAILABLE');
  }
}

async function ensurePrivateKeyDirectory(userData) {
  const directory = await sshKeyImport.ensurePrivateKeyDirectory(userData);
  await hardenWindowsPrivateKeyPath(directory, 'Directory');
  return directory;
}

async function hardenExistingPrivateKeys(directory) {
  if (process.platform !== 'win32') return;
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    throw new SshKeyImportError('SSH_KEY_STORE_FAILED');
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.key')) continue;
    const file = path.join(directory, entry.name);
    let info;
    try {
      info = await fs.promises.lstat(file);
    } catch {
      throw new SshKeyImportError('SSH_KEY_STORE_FAILED');
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new SshKeyImportError('SSH_KEY_STORE_FAILED');
    }
    await hardenWindowsPrivateKeyPath(file, 'File');
  }
}

async function importPrivateKeyFile(sourcePath, userData) {
  const directory = await ensurePrivateKeyDirectory(userData);
  await hardenExistingPrivateKeys(directory);
  let imported;
  try {
    imported = await sshKeyImport.importPrivateKeyFile(sourcePath, userData);
    // 目录 ACL 先收紧，新文件继承受限权限；写入完成后再显式验证文件 ACL。
    await hardenWindowsPrivateKeyPath(imported.path, 'File');
    return imported;
  } catch (err) {
    // ACL 工具不可用/超时时不能留下一个权限未确认的私钥副本。
    if (typeof imported?.path === 'string') {
      await fs.promises.unlink(imported.path).catch(() => undefined);
    }
    throw err;
  }
}

// 渲染层生成菜单树后经 IPC 下发；语言变更时重发一次即可整体重建。
ipcMain.handle('menu:set', (_event, spec) => {
  try {
    return installMenu(spec);
  } catch (err) {
    console.error('[desktop] install menu failed', err);
    return false;
  }
});

function sshImportDialogText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback;
}

function sshKeyImportFailure(err) {
  const code = err instanceof SshKeyImportError ? err.code : 'SSH_KEY_IMPORT_FAILED';
  // 只记错误码：绝不把所选路径、私钥内容或任何密码写进日志。
  console.error('[desktop] SSH private-key import failed:', code);
  return { ok: false, code };
}

// 渲染层只能请求“打开选择器并导入”，不能指定要读取的路径。选择结果只留在主进程。
ipcMain.handle('ssh:import-private-key', async (event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) {
    return { ok: false, code: 'SSH_KEY_IMPORT_UNAVAILABLE' };
  }
  const ui = payload?.ui;
  let selection;
  try {
    selection = await dialog.showOpenDialog(mainWindow, {
      title: sshImportDialogText(ui?.title, 'Import SSH private key'),
      buttonLabel: sshImportDialogText(ui?.buttonLabel, 'Import'),
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile'],
      filters: [
        { name: sshImportDialogText(ui?.privateKeys, 'SSH private keys'), extensions: ['pem', 'key', 'ppk'] },
        { name: sshImportDialogText(ui?.allFiles, 'All files'), extensions: ['*'] },
      ],
    });
  } catch {
    console.error('[desktop] SSH private-key picker failed');
    return { ok: false, code: 'SSH_KEY_DIALOG_FAILED' };
  }
  if (selection.canceled || !Array.isArray(selection.filePaths) || !selection.filePaths[0]) {
    return { canceled: true };
  }
  try {
    const imported = await importPrivateKeyFile(selection.filePaths[0], app.getPath('userData'));
    return { ok: true, ...imported };
  } catch (err) {
    return sshKeyImportFailure(err);
  }
});

// 更新：检查 / 下载 / 安装都由主进程执行，进度通过 update:event 推给渲染层。
// 通道判定（能不能自动装）在 updater.cjs 里按平台决定，渲染层只显示结果。
ipcMain.handle('update:status', () => updater.status());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('update:open-download', (_event, url) => updater.openDownload(url));
updater.onEvent((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:event', event);
});

ipcMain.handle('create-table-shortcut', async (_event, payload) => {
  const errors = payload?.ui?.errors ?? {};
  if (process.platform !== 'win32') return { ok: false, error: errors.shortcutWindows ?? '仅 Windows 支持 .lnk 快捷方式' };
  const connectionId = String(payload?.connectionId ?? '');
  const table = String(payload?.table ?? '');
  if (!connectionId || !table) return { ok: false, error: errors.shortcutArgs ?? '缺少连接或表名' };
  const safeName = String(payload?.name || table).replace(/[\/:*?"<>|]+/g, '_').slice(0, 60) || 'AiDB';
  const file = path.join(app.getPath('desktop'), `${safeName}.lnk`);
  const args = `--open-table=${Buffer.from(JSON.stringify({ connectionId, table, database: payload?.database })).toString('base64')}`;
  try {
    const ok = shell.writeShortcutLink(file, fs.existsSync(file) ? 'update' : 'create', {
      target: process.execPath,
      args,
      description: `AiDB Studio · ${table}`,
      icon: process.execPath,
      iconIndex: 0,
    });
    return ok ? { ok: true, path: file } : { ok: false, error: errors.shortcutWrite ?? '写入快捷方式失败' };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

const EXPORT_FILTERS = {
  png: { name: 'PNG 图片', extensions: ['png'] },
  svg: { name: 'SVG 矢量图', extensions: ['svg'] },
  csv: { name: 'CSV 文件', extensions: ['csv'] },
  sql: { name: 'SQL 脚本', extensions: ['sql'] },
  json: { name: 'JSON 文件', extensions: ['json'] },
  xml: { name: 'XML 文件', extensions: ['xml'] },
  xlsx: { name: 'Excel 工作簿', extensions: ['xlsx'] },
  pptx: { name: 'PowerPoint 演示文稿', extensions: ['pptx'] },
  md: { name: 'Markdown 文档', extensions: ['md'] },
};

// 数据导出由网关直接写进 userData/exports，Skill Worker 产物在 userData/skill-runs；
// 桌面端在这里补系统「另存为」：只允许搬运这两个目录内的文件，用户取消时原文件保留。
ipcMain.handle('save-export-file', async (_event, payload) => {
  const ui = payload?.ui ?? {};
  const errors = ui.errors ?? {};
  const labels = ui.filters ?? {};
  const allFiles = ui.allFiles ?? '所有文件';
  const source = path.resolve(String(payload?.sourcePath ?? ''));
  const userData = app.getPath('userData');
  const inside = (root) => {
    const rel = path.relative(root, source);
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (!inside(path.join(userData, 'exports')) && !inside(path.join(userData, 'skill-runs'))) {
    return { ok: false, error: errors.outside ?? '只允许保存导出目录或 Skill 产物目录中的文件' };
  }
  try {
    await fs.promises.access(source, fs.constants.R_OK);
  } catch {
    return { ok: false, error: errors.missing ?? '导出文件不存在，请重试' };
  }
  const name = path.basename(source);
  const kind = path.extname(name).slice(1).toLowerCase();
  const base = EXPORT_FILTERS[kind];
  const filter = base ? { ...base, name: labels[kind] ?? base.name } : undefined;
  const options = {
    title: ui.saveTitle ?? '保存导出文件',
    buttonLabel: ui.save ?? '保存',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: filter ? [filter, { name: allFiles, extensions: ['*'] }] : [{ name: allFiles, extensions: ['*'] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  if (path.resolve(result.filePath) === source) return { ok: true, path: result.filePath };
  try {
    await fs.promises.copyFile(source, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// 回答导出 PDF：主进程渲染 HTML 后打印为 PDF，避免新窗口被 windowOpenHandler 拦截。
// 隐藏窗口渲染不受用户控制，loadURL/printToPDF 任一环节挂起都会让 IPC 永久 pending，
// 因此整体限时 60s，到期销毁窗口并 reject；HTML 超过 5MB 直接拒绝，避免 data URL 撑爆渲染进程。
const PDF_HTML_MAX_BYTES = 5 * 1024 * 1024;
const PDF_TIMEOUT_MS = 60_000;
ipcMain.handle('export-pdf', async (_event, payload) => {
  const ui = payload?.ui ?? {};
  const errors = ui.errors ?? {};
  const labels = ui.filters ?? {};
  const html = String(payload?.html ?? '');
  if (!html) return { ok: false, error: errors.emptyPdf ?? '导出内容为空' };
  if (Buffer.byteLength(html, 'utf8') > PDF_HTML_MAX_BYTES) {
    return { ok: false, error: errors.pdfTooLarge ?? '导出内容过大（上限 5MB），请精简后重试' };
  }
  const safeName = String(payload?.name ?? 'aidb-answer.pdf').replace(/[^\w.\-一-鿿]+/g, '_');
  const options = {
    title: ui.pdfTitle ?? '导出 PDF',
    buttonLabel: ui.save ?? '保存',
    defaultPath: path.join(app.getPath('downloads'), safeName),
    filters: [{ name: labels.pdf ?? 'PDF 文档', extensions: ['pdf'] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let timer;
  try {
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        // 到期先销毁窗口：挂起的 loadURL/printToPDF 会随渲染进程终止而 settle，
        // Promise.race 已订阅两条分支，迟到的 rejection 不会变成 unhandledRejection。
        if (!win.isDestroyed()) win.destroy();
        reject(new Error(errors.pdfTimeout ?? '导出 PDF 超时（60 秒），请重试'));
      }, PDF_TIMEOUT_MS);
    });
    const render = (async () => {
      await win.loadURL(`data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
      return win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    })();
    const pdf = await Promise.race([timeout, render]);
    await fs.promises.writeFile(result.filePath, pdf);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
});

// 图表 PNG、ERD SVG、审计 CSV 这类导出在桌面端一律走原生「另存为」。Electron 不挂
// 这个处理器时也会弹框，但没有类型过滤器，用户存出来的文件可能丢扩展名。
function registerExportDialogs() {
  session.defaultSession.on('will-download', (_event, item) => {
    const filename = item.getFilename() || 'export';
    const filter = EXPORT_FILTERS[filename.split('.').pop().toLowerCase()];
    item.setSaveDialogOptions({
      defaultPath: filename,
      buttonLabel: '保存',
      ...(filter ? { filters: [filter, { name: '所有文件', extensions: ['*'] }] } : {}),
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForBridgeReady(port, token, timeoutMs = 25000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || typeof token !== 'string' || !token
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Bridge readiness credentials are invalid'));
  }
  const url = `http://127.0.0.1:${port}/api/health/ready`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer = null;
    let request = null;
    const clearDeadline = () => clearTimeout(deadline);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      if (retryTimer) clearTimeout(retryTimer);
      if (request && !request.destroyed) request.destroy();
      if (error) reject(error);
      else resolve();
    };
    // 总时限同时覆盖重试间隔和单次请求；错误不携带 URL、响应或 token。
    const deadline = setTimeout(() => {
      finish(new Error('Bridge did not become authenticated ready'));
    }, timeoutMs);
    const retry = () => {
      if (settled || retryTimer) return;
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) return finish(new Error('Bridge did not become authenticated ready'));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attempt();
      }, Math.min(250, remaining));
    };
    const attempt = () => {
      if (settled) return;
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) return finish(new Error('Bridge did not become authenticated ready'));
      let currentRequest;
      try {
        currentRequest = http.get(url, {
          agent: false,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'cache-control': 'no-store',
          },
        }, (res) => {
          res.on('error', retry);
          res.on('aborted', retry);
          res.resume();
          // /api/health 是公开 liveness；只有带本地凭据的 readiness 2xx 才可放行。
          if (res.statusCode === 200) finish();
          else retry();
        });
      } catch {
        finish(new Error('Bridge did not become authenticated ready'));
        return;
      }
      request = currentRequest;
      currentRequest.on('error', retry);
      currentRequest.setTimeout(Math.min(1200, remaining), () => {
        currentRequest.destroy();
        retry();
      });
    };
    attempt();
  });
}

// spawnSync 探测 node 会阻塞主进程（Windows 上 where/which 可能数百毫秒，node -v 挂起直接冻住 UI），
// 改异步 spawn + 5s 看门狗：探测失败/超时一律返回空串，交给下一个候选。
function captureCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish('');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => finish(''));
    child.on('close', () => finish(stdout));
  });
}

async function findSystemNode() {
  const configured = process.env.AIDB_NODE_BIN;
  const candidates = [];
  if (configured) candidates.push(configured);
  const where = await captureCommand(process.platform === 'win32' ? 'where' : 'which', ['node']);
  for (const line of String(where).split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const version = (await captureCommand(candidate, ['-v'])).trim();
      const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
      // node:sqlite 从 22.13 / 23.4 起才不需要 --experimental-sqlite；更早的 22.x 会让 Bridge 启动失败。
      const sqliteReady = major >= 24 || (major === 22 && minor >= 13) || (major === 23 && minor >= 4);
      if (sqliteReady) return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

function gatewayAlive() {
  return Boolean(gatewayProcess && gatewayProcess.exitCode === null && !gatewayProcess.killed);
}

function notifyGatewayFatal(message) {
  console.error('[desktop] gateway fatal:', message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway:event', { type: 'fatal', message });
  } else {
    // macOS 可能所有窗口都关了：没有渲染层可通知时用系统对话框兜底。
    dialog.showErrorBox('AiDB Studio', message);
  }
}

function sendSessionToken(token) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('gateway:event', { type: 'token', token });
}

function scheduleGatewayRestart() {
  if (quitting || restartTimer) return;
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
  if (restartTimestamps.length >= RESTART_MAX) {
    notifyGatewayFatal('本地服务（Bridge）反复崩溃，已达自动重启上限（10 分钟内 5 次）。请重启应用；若仍失败请检查数据目录权限或反馈日志。');
    return;
  }
  const delay = restartDelay;
  restartDelay = Math.min(restartDelay * 2, RESTART_DELAY_CAP_MS);
  console.log(`[desktop] gateway will restart in ${delay}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void attemptGatewayRestart();
  }, delay);
}

async function attemptGatewayRestart() {
  if (quitting) return;
  restartTimestamps.push(Date.now());
  try {
    const info = await startEmbeddedGateway();
    sendSessionToken(info.token);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('gateway:event', { type: 'recovered' });
  } catch (err) {
    console.error('[desktop] gateway restart failed', err);
    // 健康检查失败时 startEmbeddedGateway 已杀掉半死进程，继续按退避节奏重试。
    scheduleGatewayRestart();
  }
}

async function startEmbeddedGateway() {
  // macOS 关窗不退出应用，再激活时旧网关往往还活着：复用当前进程（端口/token 不变），
  // 杜绝重复 spawn 造成的孤儿进程。健康检查不过才杀掉重建。
  if (gatewayAlive() && gatewayInfo) {
    try {
      await waitForBridgeReady(gatewayInfo.port, gatewayInfo.token);
      return gatewayInfo;
    } catch {
      const stale = gatewayProcess;
      gatewayProcess = null;
      gatewayInfo = null;
      stale.kill();
    }
  }
  const port = await getFreePort();
  const token = crypto.randomBytes(24).toString('hex');
  const gatewayEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'gateway', 'index.js')
    : path.join(__dirname, '..', '..', 'gateway', 'dist', 'index.js');
  const staticDir = app.isPackaged ? path.join(process.resourcesPath, 'desktop') : path.join(__dirname, '..', 'dist');
  if (app.isPackaged) {
    const { backupDir } = await backupBeforeUpgrade({ home: app.getPath('userData'), version: app.getVersion() });
    if (backupDir) console.log('[desktop] pre-upgrade backup:', backupDir);
  }
  // dmdb 需要 --openssl-legacy-provider，而 Electron 内置 Node 不接受该参数；
  // 有系统 Node（>=22.13）时优先用它启动 Bridge，否则回退到 Electron Node（达梦连接会给出明确提示）。
  const nodeBin = await findSystemNode();
  const userData = app.getPath('userData');
  // 导入目录必须先存在且权限受控，网关启动时即可读取后续导入的私钥，无需重启。
  // Windows 同时复核旧版本已生成的 .key，避免升级后继续使用未显式加固的副本。
  const privateKeyDir = await ensurePrivateKeyDirectory(userData);
  await hardenExistingPrivateKeys(privateKeyDir);
  const defaultKnownHosts = path.join(app.getPath('home'), '.ssh', 'known_hosts');
  const env = addPrivateKeyDirectory({
    ...process.env,
    NODE_ENV: 'production',
    AIDB_HOME: userData,
    AIDB_HOST: '127.0.0.1',
    AIDB_PORT: String(port),
    AIDB_TOKEN: token,
    AIDB_STATIC_DIR: staticDir,
    AIDB_ALLOW_LOCAL_KEY: '1',
  }, userData);
  // 复用用户已有的 OpenSSH 信任库；文件不存在时保持未知主机拒绝，绝不自动信任。
  if (!env.AIDB_SSH_KNOWN_HOSTS_FILE && fs.existsSync(defaultKnownHosts)) {
    env.AIDB_SSH_KNOWN_HOSTS_FILE = defaultKnownHosts;
  }
  if (nodeBin) {
    delete env.ELECTRON_RUN_AS_NODE;
  } else {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  gatewayProcess = spawn(nodeBin ?? process.execPath, nodeBin ? ['--openssl-legacy-provider', gatewayEntry] : [gatewayEntry], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  const child = gatewayProcess;
  gatewayInfo = { port, token };
  const onGone = (reason) => {
    // 只处理当前引用进程的退出：被替换的旧进程迟到的 exit 不能再触发一轮重启。
    if (quitting || gatewayProcess !== child) return;
    console.error('[desktop] gateway gone:', reason);
    gatewayProcess = null;
    scheduleGatewayRestart();
  };
  child.on('exit', (code, signal) => onGone(`exit code=${code} signal=${signal}`));
  child.on('error', (err) => onGone(`error ${err?.message ?? err}`));
  try {
    await waitForBridgeReady(port, token);
  } catch (err) {
    // 半启动进程不能继续占用端口或携带未交付的 token 进入下一轮复用。
    if (gatewayProcess === child) {
      gatewayProcess = null;
      gatewayInfo = null;
      child.kill();
    }
    throw err;
  }
  // 恢复健康后退避复位：下一次意外崩溃从 1s 重新开始。
  restartDelay = 1000;
  if (app.isPackaged) markVersion(app.getPath('userData'), app.getVersion());
  return { port, token };
}

async function createWindow() {
  let url;
  let trustedOrigin;
  let sessionToken = 'dev-token';
  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    if (!['http:', 'https:'].includes(devUrl.protocol) || devUrl.username || devUrl.password) {
      throw new Error('Invalid VITE_DEV_SERVER_URL');
    }
    url = `${process.env.VITE_DEV_SERVER_URL.replace(/\/$/, '')}/`;
    trustedOrigin = devUrl.origin;
  } else {
    const { port, token } = await startEmbeddedGateway();
    url = `http://127.0.0.1:${port}/`;
    trustedOrigin = new URL(url).origin;
    sessionToken = token;
  }
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#090a09',
    title: 'AiDB Studio',
    icon: windowIcon,
    // 菜单栏跟随窗口显示：Windows / Linux 直接排在原生标题栏下方（与 Navicat 同形），
    // macOS 走屏幕顶部的系统菜单栏，这个选项无效但也无害。
    autoHideMenuBar: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  const deliverToken = () => sendSessionToken(sessionToken);
  // preload 在 dom-ready 前已注册监听；每次重载都重新交付，令牌仍只存在于当前渲染层内存。
  mainWindow.webContents.on('dom-ready', deliverToken);
  // 首轮 loadURL 前装好守卫：同 origin 的开发热更新/应用内跳转不受影响，外部重定向与
  // javascript/data/file 跳转一律拦截。外链只从下面的新窗口处理器交给系统浏览器。
  mainWindow.webContents.on('will-navigate', (event, target) => {
    guardMainFrameNavigation(event, target, trustedOrigin);
  });
  mainWindow.webContents.on('will-redirect', (event, target) => {
    guardMainFrameNavigation(event, target, trustedOrigin);
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    openAllowedExternalUrl(target);
    return { action: 'deny' };
  });
  mainWindow.loadURL(url);
  mainWindow.webContents.once('did-finish-load', () => {
    const openTable = readOpenTableArg();
    if (openTable) mainWindow?.webContents.send('open-table', openTable);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 启动健康检查超时不再静默 app.quit：给用户重试/退出的选择。
// 重试重新走 createWindow（startEmbeddedGateway 会先杀掉半死进程再重建）。
async function bootstrapWindow() {
  try {
    await createWindow();
  } catch (err) {
    console.error('[desktop] failed to start', err);
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'AiDB Studio 启动失败',
      message: '本地服务（Bridge）未能在限时内就绪。',
      detail: String(err?.message ?? err),
      buttons: ['重试', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) return bootstrapWindow();
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const payload = readOpenTableArg(argv);
    if (!mainWindow) {
      void bootstrapWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (payload) mainWindow.webContents.send('open-table', payload);
  });

  app.whenReady().then(() => {
    configureAboutPanel();
    // Windows 的任务栏分组、通知来源都靠 AppUserModelId；与 electron-builder 的 appId 保持一致。
    if (process.platform === 'win32') app.setAppUserModelId('top.keiskei.aidb');
    // macOS 开发态的 Dock 图标同样来自 Electron.app，未打包时手动换成产品图标。
    if (!app.isPackaged && process.platform === 'darwin' && windowIcon && app.dock) app.dock.setIcon(windowIcon);
    registerExportDialogs();
    return bootstrapWindow();
  }).catch((err) => {
    console.error('[desktop] failed to start', err);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void bootstrapWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

app.on('before-quit', () => {
  // 主动退出必须先置位：exit 回调据此跳过自动重启，否则会把刚杀掉的网关又拉起来。
  quitting = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (gatewayProcess) {
    gatewayProcess.kill();
    gatewayProcess = null;
  }
});
