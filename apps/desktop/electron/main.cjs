const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

let gatewayProcess = null;
let mainWindow = null;

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

async function startEmbeddedGateway() {
  const port = await getFreePort();
  const token = crypto.randomBytes(24).toString('hex');
  const gatewayEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'gateway', 'index.js')
    : path.join(__dirname, '..', '..', 'gateway', 'dist', 'index.js');
  const staticDir = app.isPackaged ? path.join(process.resourcesPath, 'desktop') : path.join(__dirname, '..', 'dist');
  gatewayProcess = spawn(process.execPath, [gatewayEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      AIDB_HOME: app.getPath('userData'),
      AIDB_HOST: '127.0.0.1',
      AIDB_PORT: String(port),
      AIDB_TOKEN: token,
      AIDB_STATIC_DIR: staticDir,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  gatewayProcess.on('exit', (code) => {
    console.error('[desktop] gateway exited', code);
  });
  await waitForHealth(`http://127.0.0.1:${port}/api/health`);
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
    backgroundColor: '#0b0f14',
    title: 'AiDB Studio',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(url);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target).catch(() => undefined);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow).catch((err) => {
  console.error('[desktop] failed to start', err);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (gatewayProcess) {
    gatewayProcess.kill();
    gatewayProcess = null;
  }
});
