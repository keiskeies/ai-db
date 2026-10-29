const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { backupBeforeUpgrade, markVersion } = require('./upgrade.cjs');

let gatewayProcess = null;
let mainWindow = null;

function readOpenTableArg(argv = process.argv) {
  const arg = argv.find((item) => item.startsWith('--open-table='));
  if (!arg) return null;
  try {
    return JSON.parse(Buffer.from(arg.slice('--open-table='.length), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

ipcMain.handle('create-table-shortcut', async (_event, payload) => {
  if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 支持 .lnk 快捷方式' };
  const connectionId = String(payload?.connectionId ?? '');
  const table = String(payload?.table ?? '');
  if (!connectionId || !table) return { ok: false, error: '缺少连接或表名' };
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
    return ok ? { ok: true, path: file } : { ok: false, error: '写入快捷方式失败' };
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
};

// 数据导出由网关直接写进 userData/exports，界面上只拿到路径；桌面端在这里补系统
// 「另存为」：只允许搬运导出目录内的文件，用户取消时原文件保留。
ipcMain.handle('save-export-file', async (_event, payload) => {
  const source = path.resolve(String(payload?.sourcePath ?? ''));
  const root = path.join(app.getPath('userData'), 'exports');
  const rel = path.relative(root, source);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '只允许保存导出目录中的文件' };
  try {
    await fs.promises.access(source, fs.constants.R_OK);
  } catch {
    return { ok: false, error: '导出文件不存在，请重试' };
  }
  const name = path.basename(source);
  const filter = EXPORT_FILTERS[path.extname(name).slice(1).toLowerCase()];
  const options = {
    title: '保存导出文件',
    buttonLabel: '保存',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: filter ? [filter, { name: '所有文件', extensions: ['*'] }] : [{ name: '所有文件', extensions: ['*'] }],
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

function waitForHealth(url, timeoutMs = 25000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1200, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error(`Bridge did not become ready: ${url}`));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

function findSystemNode() {
  const configured = process.env.AIDB_NODE_BIN;
  const candidates = [];
  if (configured) candidates.push(configured);
  try {
    const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true });
    for (const line of String(where.stdout ?? '').split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
  } catch {
    /* no PATH lookup */
  }
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const version = spawnSync(candidate, ['-v'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
      const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
      if (major > 22 || (major === 22 && minor >= 5)) return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

async function startEmbeddedGateway() {
  const port = await getFreePort();
  const token = crypto.randomBytes(24).toString('hex');
  const gatewayEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'gateway', 'index.js')
    : path.join(__dirname, '..', '..', 'gateway', 'dist', 'index.js');
  const staticDir = app.isPackaged ? path.join(process.resourcesPath, 'desktop') : path.join(__dirname, '..', 'dist');
  if (app.isPackaged) {
    const { backupDir } = backupBeforeUpgrade({ home: app.getPath('userData'), version: app.getVersion() });
    if (backupDir) console.log('[desktop] pre-upgrade backup:', backupDir);
  }
  // dmdb 需要 --openssl-legacy-provider，而 Electron 内置 Node 不接受该参数；
  // 有系统 Node（>=22.5）时优先用它启动 Bridge，否则回退到 Electron Node（达梦连接会给出明确提示）。
  const nodeBin = findSystemNode();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    AIDB_HOME: app.getPath('userData'),
    AIDB_HOST: '127.0.0.1',
    AIDB_PORT: String(port),
    AIDB_TOKEN: token,
    AIDB_STATIC_DIR: staticDir,
  };
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
  gatewayProcess.on('exit', (code) => {
    console.error('[desktop] gateway exited', code);
  });
  await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  if (app.isPackaged) markVersion(app.getPath('userData'), app.getVersion());
  return { port, token };
}

async function createWindow() {
  let url;
  if (process.env.VITE_DEV_SERVER_URL) {
    url = `${process.env.VITE_DEV_SERVER_URL}#token=dev-token`;
  } else {
    const { port, token } = await startEmbeddedGateway();
    url = `http://127.0.0.1:${port}/#token=${token}`;
  }
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d0d',
    title: 'AiDB Studio',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.loadURL(url);
  mainWindow.webContents.once('did-finish-load', () => {
    const openTable = readOpenTableArg();
    if (openTable) mainWindow?.webContents.send('open-table', openTable);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target).catch(() => undefined);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const payload = readOpenTableArg(argv);
    if (!mainWindow) {
      void createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (payload) mainWindow.webContents.send('open-table', payload);
  });

  app.whenReady().then(() => {
    registerExportDialogs();
    return createWindow();
  }).catch((err) => {
    console.error('[desktop] failed to start', err);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

app.on('before-quit', () => {
  if (gatewayProcess) {
    gatewayProcess.kill();
    gatewayProcess = null;
  }
});
