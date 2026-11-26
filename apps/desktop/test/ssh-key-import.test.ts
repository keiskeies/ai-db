import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');
const {
  SSH_PRIVATE_KEY_MAX_BYTES,
  SshKeyImportError,
  addPrivateKeyDirectory,
  ensurePrivateKeyDirectory,
  importPrivateKeyFile,
  insideDirectory,
  privateKeyDirectory,
} = require('../electron/ssh-key-import.cjs') as {
  SSH_PRIVATE_KEY_MAX_BYTES: number;
  SshKeyImportError: new (code: string) => Error & { code: string };
  addPrivateKeyDirectory: (env: Record<string, string>, userData: string) => Record<string, string>;
  ensurePrivateKeyDirectory: (userData: string) => Promise<string>;
  importPrivateKeyFile: (sourcePath: string, userData: string) => Promise<{
    path: string;
    fileName: string;
    sourceFileName: string;
    sizeBytes: number;
  }>;
  insideDirectory: (file: string, root: string) => boolean;
  privateKeyDirectory: (userData: string) => string;
};

const sourceText = (relative: string) => readFileSync(path.resolve(import.meta.dirname, relative), 'utf8').replace(/\r\n/g, '\n');
// vm 中创建的对象来自另一个 realm，比较前归一化，避免原型差异造成假失败。
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function withTemp(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'aidb-ssh-key-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function expectImportCode(sourcePath: string, userData: string, code: string): Promise<void> {
  await assert.rejects(importPrivateKeyFile(sourcePath, userData), (err: unknown) => {
    assert.ok(err instanceof SshKeyImportError);
    assert.equal(err.code, code);
    return true;
  });
}

test('私钥导入复制字节到 userData 随机文件名，只返回元数据并收紧 POSIX 权限', async () => {
  await withTemp(async (root) => {
    const userData = path.join(root, 'user-data');
    const picked = path.join(root, 'picked');
    mkdirSync(userData);
    mkdirSync(picked);
    const bytes = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nTEST-ONLY-KEY-BYTES\n-----END OPENSSH PRIVATE KEY-----\n');
    const source = path.join(picked, 'id_ed25519');
    writeFileSync(source, bytes);

    const first = await importPrivateKeyFile(source, userData);
    const directory = privateKeyDirectory(userData);
    assert.equal(path.dirname(first.path), directory);
    assert.equal(first.sourceFileName, 'id_ed25519');
    assert.equal(first.sizeBytes, bytes.length);
    assert.match(first.fileName, /^[0-9a-f]{36}\.key$/);
    assert.deepEqual(readFileSync(first.path), bytes);
    assert.equal(JSON.stringify(first).includes(bytes.toString('utf8')), false);
    assert.equal(lstatSync(first.path).isSymbolicLink(), false);
    assert.equal(lstatSync(first.path).isFile(), true);
    if (process.platform !== 'win32') {
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      assert.equal(lstatSync(first.path).mode & 0o777, 0o600);
      chmodSync(directory, 0o755);
      await ensurePrivateKeyDirectory(userData);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700, '已有宽松目录必须重新收紧');
    }

    const second = await importPrivateKeyFile(source, userData);
    assert.notEqual(second.path, first.path, '重复导入不得覆盖或复用文件名');
    assert.equal(readdirSync(directory).length, 2);
  });
});

test('路径封闭检查拒绝目录本身、父目录穿越和外部绝对路径', () => {
  const root = path.resolve('protected-keys');
  assert.equal(insideDirectory(path.join(root, 'generated.key'), root), true);
  assert.equal(insideDirectory(root, root), false);
  assert.equal(insideDirectory(path.join(root, '..', 'escape.key'), root), false);
  assert.equal(insideDirectory(path.resolve('elsewhere', 'key'), root), false);
});

test('导入拒绝不存在文件、目录、空文件和超过 64 KiB 的文件', async () => {
  await withTemp(async (root) => {
    const userData = path.join(root, 'user-data');
    mkdirSync(userData);
    await expectImportCode(path.join(root, 'missing'), userData, 'SSH_KEY_READ_FAILED');
    await expectImportCode(root, userData, 'SSH_KEY_READ_FAILED');

    const empty = path.join(root, 'empty');
    writeFileSync(empty, Buffer.alloc(0));
    await expectImportCode(empty, userData, 'SSH_KEY_READ_FAILED');

    const oversized = path.join(root, 'oversized');
    writeFileSync(oversized, Buffer.alloc(SSH_PRIVATE_KEY_MAX_BYTES + 1, 1));
    await expectImportCode(oversized, userData, 'SSH_KEY_TOO_LARGE');
    assert.deepEqual(readdirSync(privateKeyDirectory(userData)), [], '失败导入不得留下半成品');
  });
});

test('导入拒绝源文件符号链接', async (t) => {
  await withTemp(async (root) => {
    const userData = path.join(root, 'user-data');
    mkdirSync(userData);
    const source = path.join(root, 'actual-key');
    const link = path.join(root, 'linked-key');
    writeFileSync(source, 'TEST-ONLY-KEY');
    try {
      symlinkSync(source, link, 'file');
    } catch (err: any) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err?.code)) {
        t.skip('Windows 未授予创建文件符号链接的权限');
        return;
      }
      throw err;
    }
    await expectImportCode(link, userData, 'SSH_KEY_SYMLINK_REJECTED');
    assert.deepEqual(readdirSync(privateKeyDirectory(userData)), []);
  });
});

test('主进程 lstat 判定所选文件为符号链接时拒绝，不依赖宿主创建权限', async () => {
  await withTemp(async (root) => {
    const userData = path.join(root, 'user-data');
    const source = path.join(root, 'selected-key');
    mkdirSync(userData);
    writeFileSync(source, 'TEST-ONLY-KEY');
    const mutableFs = fs as any;
    const originalLstat = mutableFs.promises.lstat;
    mutableFs.promises.lstat = async (target: any, ...args: any[]) => {
      if (path.resolve(String(target)) === source) return { isSymbolicLink: () => true };
      return originalLstat(target, ...args);
    };
    try {
      await expectImportCode(source, userData, 'SSH_KEY_SYMLINK_REJECTED');
    } finally {
      mutableFs.promises.lstat = originalLstat;
    }
    assert.deepEqual(readdirSync(privateKeyDirectory(userData)), []);
  });
});

test('受保护目录自身是符号链接时拒绝导入', async () => {
  await withTemp(async (root) => {
    const userData = path.join(root, 'user-data');
    const outside = path.join(root, 'outside');
    mkdirSync(userData);
    mkdirSync(outside);
    symlinkSync(outside, privateKeyDirectory(userData), process.platform === 'win32' ? 'junction' : 'dir');
    await expectImportCode(path.join(root, 'not-read'), userData, 'SSH_KEY_STORE_FAILED');
    assert.deepEqual(readdirSync(outside), []);
  });
});

test('网关环境追加受保护目录并保留外部 FILE/DIRS，重复配置不重复追加', () => {
  const userData = path.resolve('user-data');
  const directory = privateKeyDirectory(userData);
  const external = {
    AIDB_SSH_PRIVATE_KEY_FILE: path.resolve('external-key'),
    AIDB_SSH_PRIVATE_KEY_DIRS: ` ${path.resolve('keys-one')} , ${path.resolve('keys-two')} `,
    AIDB_SSH_KNOWN_HOSTS_FILE: path.resolve('known_hosts'),
  };
  const next = addPrivateKeyDirectory(external, userData);
  assert.equal(next.AIDB_SSH_PRIVATE_KEY_FILE, external.AIDB_SSH_PRIVATE_KEY_FILE);
  assert.equal(next.AIDB_SSH_KNOWN_HOSTS_FILE, external.AIDB_SSH_KNOWN_HOSTS_FILE);
  assert.deepEqual(next.AIDB_SSH_PRIVATE_KEY_DIRS.split(','), [
    path.resolve('keys-one'),
    path.resolve('keys-two'),
    directory,
  ]);
  assert.equal(external.AIDB_SSH_PRIVATE_KEY_DIRS.includes(directory), false, '不得修改调用方环境对象');
  assert.equal(addPrivateKeyDirectory(next, userData).AIDB_SSH_PRIVATE_KEY_DIRS, next.AIDB_SSH_PRIVATE_KEY_DIRS);
  assert.equal(addPrivateKeyDirectory({}, userData).AIDB_SSH_PRIVATE_KEY_DIRS, directory);
});

test('preload 只暴露窄导入通道，不暴露任意文件读取', async () => {
  const preload = sourceText('../electron/preload.cjs');
  const invocations: Array<{ channel: string; payload: any }> = [];
  let bridge: any;
  vm.runInNewContext(preload, {
    process: { platform: 'win32' },
    require(id: string) {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name: string, value: unknown) { bridge = value; } },
        ipcRenderer: {
          on() {},
          async invoke(channel: string, payload: unknown) {
            invocations.push({ channel, payload });
            return { canceled: true };
          },
        },
      };
    },
  });
  const ui = { title: 'Import SSH private key', buttonLabel: 'Import', privateKeys: 'Keys', allFiles: 'All files' };
  assert.deepEqual(await bridge.importSshPrivateKey(ui), { canceled: true });
  assert.deepEqual(plain(invocations), [{ channel: 'ssh:import-private-key', payload: { ui } }]);
  assert.equal(typeof bridge.readFile, 'undefined');
  assert.doesNotMatch(preload, /require\(['"]node:fs['"]\)|ipcRenderer\.(?:readFile|sendSync)/);
});

test('主进程导入处理器忽略渲染层路径、校验发送窗口并安全处理取消/错误', async () => {
  const main = sourceText('../electron/main.cjs');
  const start = main.indexOf('function sshImportDialogText');
  const end = main.indexOf('// 更新：检查 / 下载 / 安装', start);
  assert.ok(start >= 0 && end > start);
  let handler: (event: any, payload?: any) => Promise<any>;
  let pickerResult: any = { canceled: true, filePaths: [] };
  const imports: Array<{ source: string; userData: string }> = [];
  const logs: unknown[][] = [];
  const webContents = {};
  const mainWindow = { isDestroyed: () => false, webContents };
  const dialogOptions: any[] = [];
  vm.runInNewContext(main.slice(start, end), {
    path,
    mainWindow,
    app: { getPath: (name: string) => name === 'userData' ? '/user-data' : '/home' },
    dialog: {
      async showOpenDialog(parent: unknown, options: unknown) {
        assert.equal(parent, mainWindow);
        dialogOptions.push(options);
        if (pickerResult instanceof Error) throw pickerResult;
        return pickerResult;
      },
    },
    ipcMain: { handle(channel: string, value: typeof handler) { assert.equal(channel, 'ssh:import-private-key'); handler = value; } },
    SshKeyImportError,
    async importPrivateKeyFile(source: string, userData: string) {
      imports.push({ source, userData });
      if (source === '/selected/symlink') throw new SshKeyImportError('SSH_KEY_SYMLINK_REJECTED');
      return { path: '/user-data/ssh-keys/generated.key', fileName: 'generated.key', sourceFileName: 'id_ed25519', sizeBytes: 42 };
    },
    console: { error(...args: unknown[]) { logs.push(args); } },
  });

  const event = { sender: webContents };
  assert.deepEqual(plain(await handler!({ sender: {} }, {})), { ok: false, code: 'SSH_KEY_IMPORT_UNAVAILABLE' });
  assert.equal(dialogOptions.length, 0);
  assert.deepEqual(plain(await handler!(event, { sourcePath: '/renderer/secret' })), { canceled: true });
  assert.equal(imports.length, 0, '取消时不得读取任何文件');

  pickerResult = { canceled: false, filePaths: ['/selected/id_ed25519'] };
  const imported = await handler!(event, {
    sourcePath: '/renderer/secret',
    ui: { title: '  Import key  ', buttonLabel: 'Import', privateKeys: 'Keys', allFiles: 'All files' },
  });
  assert.deepEqual(imports, [{ source: '/selected/id_ed25519', userData: '/user-data' }], '只能使用原生选择器返回的路径');
  assert.equal(imported.ok, true);
  assert.equal(imported.path, '/user-data/ssh-keys/generated.key');
  assert.equal(JSON.stringify(imported).includes('TEST-ONLY'), false);
  assert.equal(dialogOptions.at(-1).title, 'Import key');
  assert.deepEqual(plain(dialogOptions.at(-1).properties), ['openFile']);

  pickerResult = { canceled: false, filePaths: ['/selected/symlink'] };
  assert.deepEqual(plain(await handler!(event, {})), { ok: false, code: 'SSH_KEY_SYMLINK_REJECTED' });
  assert.equal(JSON.stringify(logs).includes('/selected/symlink'), false, '日志不得包含所选路径');
  pickerResult = new Error('picker detail must not be logged');
  assert.deepEqual(plain(await handler!(event, {})), { ok: false, code: 'SSH_KEY_DIALOG_FAILED' });
  assert.equal(JSON.stringify(logs).includes('picker detail'), false);
});

test('API 仅经桌面 Bridge 导入，Web 形态返回不支持', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    const calls: unknown[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        aidbDesktop: {
          async importSshPrivateKey(ui: unknown) {
            calls.push(ui);
            return { canceled: true };
          },
        },
      },
    });
    const desktop = await import(`../src/lib/api.ts?ssh-import-desktop=${Date.now()}`) as typeof import('../src/lib/api');
    const ui = { title: 'Import', buttonLabel: 'Import', privateKeys: 'Keys', allFiles: 'All files' };
    assert.equal(desktop.api.canImportSshPrivateKey(), true);
    assert.deepEqual(await desktop.api.importSshPrivateKey(ui), { canceled: true });
    assert.deepEqual(calls, [ui]);

    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const web = await import(`../src/lib/api.ts?ssh-import-web=${Date.now()}`) as typeof import('../src/lib/api');
    assert.equal(web.api.canImportSshPrivateKey(), false);
    assert.deepEqual(await web.api.importSshPrivateKey(ui), { ok: false, code: 'SSH_KEY_IMPORT_UNAVAILABLE' });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as any).window;
  }
});

test('ConnectionModal 保留手动路径/密码认证，导入取消与旧异步结果不覆盖表单', () => {
  const modal = sourceText('../src/components/ConnectionModal.tsx');
  const start = modal.indexOf('const importSshKey = async');
  const end = modal.indexOf('const buildBody', start);
  assert.ok(start >= 0 && end > start);
  const handler = modal.slice(start, end);
  const staleGuard = handler.indexOf('if (sshKeyImportGeneration.current !== generation) return;');
  const canceled = handler.indexOf('if (result.canceled) return;');
  const writePath = handler.indexOf('setSshKeyPath(result.path)');
  assert.ok(staleGuard >= 0 && canceled > staleGuard && writePath > canceled, '必须先丢弃旧结果和取消，再写回路径');
  assert.match(handler, /if \(sshKeyImportGeneration\.current === generation\) setSshKeyImportError/);
  assert.match(handler, /if \(sshKeyImportGeneration\.current === generation\) \{[\s\S]*sshKeyImportPending\.current = false/);
  assert.match(handler, /if \(sshKeyImportPending\.current\) return;/);
  assert.match(modal, /invalidateSshKeyImport\(\); setSshEnabled\(e\.target\.checked\)/);
  assert.match(modal, /invalidateSshKeyImport\(\); setSshAuth\(e\.target\.value/);
  assert.match(modal, /if \(importedSshKey && importedSshKey\.path !== next\) setImportedSshKey\(null\)/);
  assert.match(modal, /data-testid="ssh-key-import"/);
  assert.match(modal, /disabled=\{!canImportSshKey \|\| sshKeyImporting\}/);
  assert.match(modal, /data-testid="ssh-key-import-status"/);
  assert.match(modal, /data-testid="ssh-key-import-error"/);
  assert.match(modal, /importedSshKey\.sourceFileName, importedSshKey\.sizeBytes/);
  assert.doesNotMatch(modal, /dangerouslySetInnerHTML/);
  assert.match(modal, /privateKeyPath: sshAuth === 'key' \? sshKeyPath\.trim\(\) : undefined/);
  assert.match(modal, /sshPassword: sshAuth === 'password' \? sshPassword \|\| undefined : undefined/);
  assert.match(modal, /data-testid="ssh-password"/);
  assert.match(modal, /data-testid="ssh-known-hosts-hint"/);
});

test('主进程启动时先创建受保护目录再追加网关允许根目录，known_hosts 逻辑保持独立', () => {
  const main = sourceText('../electron/main.cjs');
  const ensureAt = main.indexOf('await ensurePrivateKeyDirectory(userData)');
  const envAt = main.indexOf('const env = addPrivateKeyDirectory(', ensureAt);
  const spawnAt = main.indexOf('gatewayProcess = spawn', envAt);
  assert.ok(ensureAt >= 0 && envAt > ensureAt && spawnAt > envAt);
  assert.match(main, /!env\.AIDB_SSH_KNOWN_HOSTS_FILE && fs\.existsSync\(defaultKnownHosts\)/);
  assert.match(main, /env\.AIDB_SSH_KNOWN_HOSTS_FILE = defaultKnownHosts/);
});

test('新增私钥导入文案具有英文目录且中文源码可提取', () => {
  const modal = sourceText('../src/components/ConnectionModal.tsx');
  const en = JSON.parse(sourceText('../src/i18n/locales/en.json')) as Record<string, string>;
  const messages = [
    '导入 SSH 私钥',
    'SSH 私钥文件',
    'SSH 私钥文件不能超过 64 KiB。',
    'SSH 私钥导入失败，请重试。',
    '当前环境不支持原生私钥导入，请使用桌面应用。',
    '正在导入 SSH 私钥…',
    '手动路径必须位于网关明确授权的目录；推荐使用「导入 SSH 私钥」复制到桌面应用受保护目录。',
    '已导入：{0}（{1} 字节）',
    '无法打开私钥文件选择器。',
    '无法读取所选文件，请确认它是可读的普通私钥文件。',
    '已拒绝导入符号链接，请选择实际私钥文件。',
    '无法创建或写入受保护的私钥目录。',
  ];
  for (const message of messages) {
    assert.ok(modal.includes(message), `中文源码缺少 ${message}`);
    assert.ok(en[message]?.trim(), `英文目录缺少 ${message}`);
  }
});
