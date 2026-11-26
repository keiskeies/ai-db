const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 明显小于网关的 1 MiB 上限；正常 OpenSSH / PuTTY 私钥都远小于此值。
const SSH_PRIVATE_KEY_MAX_BYTES = 64 * 1024;
const SSH_PRIVATE_KEY_DIR_NAME = 'ssh-keys';
const COPY_CHUNK_BYTES = 16 * 1024;
const MAX_FILENAME_ATTEMPTS = 8;

class SshKeyImportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SshKeyImportError';
    this.code = code;
  }
}

function fail(code) {
  throw new SshKeyImportError(code);
}

function privateKeyDirectory(userData) {
  return path.join(path.resolve(userData), SSH_PRIVATE_KEY_DIR_NAME);
}

function insideDirectory(file, root) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function unsupportedModeError(err) {
  return ['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(err?.code);
}

async function protectDirectory(directory) {
  let info;
  try {
    try {
      info = await fs.promises.lstat(directory);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      try {
        await fs.promises.mkdir(directory, { mode: 0o700 });
      } catch (mkdirErr) {
        // 并发导入/启动可能都已创建目录；仍须在下面重新 lstat 校验。
        if (mkdirErr?.code !== 'EEXIST') throw mkdirErr;
      }
      info = await fs.promises.lstat(directory);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('SSH_KEY_STORE_FAILED');
    if (process.platform !== 'win32') {
      try {
        await fs.promises.chmod(directory, 0o700);
      } catch (err) {
        if (!unsupportedModeError(err)) throw err;
      }
    }
    const confirmed = await fs.promises.lstat(directory);
    if (confirmed.isSymbolicLink() || !confirmed.isDirectory()
      || confirmed.dev !== info.dev || confirmed.ino !== info.ino) fail('SSH_KEY_STORE_FAILED');
  } catch (err) {
    if (err instanceof SshKeyImportError) throw err;
    fail('SSH_KEY_STORE_FAILED');
  }
}

async function ensurePrivateKeyDirectory(userData) {
  const directory = privateKeyDirectory(userData);
  await protectDirectory(directory);
  return directory;
}

async function readSelectedFile(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) fail('SSH_KEY_READ_FAILED');
  const resolved = path.resolve(sourcePath);
  let selected;
  try {
    selected = await fs.promises.lstat(resolved);
  } catch {
    fail('SSH_KEY_READ_FAILED');
  }
  if (selected.isSymbolicLink()) fail('SSH_KEY_SYMLINK_REJECTED');
  if (!selected.isFile()) fail('SSH_KEY_READ_FAILED');

  let handle;
  try {
    // POSIX 上 O_NOFOLLOW 同时封住 lstat 与 open 之间的符号链接替换竞态。
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    handle = await fs.promises.open(resolved, flags);
  } catch (err) {
    if (err?.code === 'ELOOP') fail('SSH_KEY_SYMLINK_REJECTED');
    fail('SSH_KEY_READ_FAILED');
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) fail('SSH_KEY_READ_FAILED');
    if (opened.size > SSH_PRIVATE_KEY_MAX_BYTES) fail('SSH_KEY_TOO_LARGE');
    if (opened.dev !== selected.dev || opened.ino !== selected.ino) fail('SSH_KEY_READ_FAILED');

    const chunks = [];
    let total = 0;
    while (total <= SSH_PRIVATE_KEY_MAX_BYTES) {
      const length = Math.min(COPY_CHUNK_BYTES, SSH_PRIVATE_KEY_MAX_BYTES + 1 - total);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > SSH_PRIVATE_KEY_MAX_BYTES) fail('SSH_KEY_TOO_LARGE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (!total) fail('SSH_KEY_READ_FAILED');

    const finished = await handle.stat();
    if (!finished.isFile() || finished.size !== total || finished.mtimeMs !== opened.mtimeMs) {
      fail('SSH_KEY_READ_FAILED');
    }
    return Buffer.concat(chunks, total);
  } catch (err) {
    if (err instanceof SshKeyImportError) throw err;
    fail('SSH_KEY_READ_FAILED');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function removePartialFile(file) {
  await fs.promises.unlink(file).catch(() => undefined);
}

async function writeProtectedFile(directory, sourceFileName, bytes) {
  for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt += 1) {
    const generatedName = `${crypto.randomBytes(18).toString('hex')}.key`;
    const destination = path.join(directory, generatedName);
    if (!insideDirectory(destination, directory)) fail('SSH_KEY_STORE_FAILED');

    let handle;
    try {
      handle = await fs.promises.open(
        destination,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      fail('SSH_KEY_STORE_FAILED');
    }

    let written;
    let writeError;
    try {
      await handle.writeFile(bytes);
      if (process.platform !== 'win32') {
        try {
          await handle.chmod(0o600);
        } catch (err) {
          if (!unsupportedModeError(err)) throw err;
        }
      }
      written = await handle.stat();
      if (!written.isFile() || written.size !== bytes.length) fail('SSH_KEY_STORE_FAILED');
    } catch (err) {
      writeError = err;
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (writeError) {
      // 先关闭句柄再清理，Windows 才能可靠删除半成品。
      await removePartialFile(destination);
      if (writeError instanceof SshKeyImportError) throw writeError;
      fail('SSH_KEY_STORE_FAILED');
    }

    try {
      const confirmed = await fs.promises.lstat(destination);
      if (confirmed.isSymbolicLink() || !confirmed.isFile()
        || confirmed.dev !== written.dev || confirmed.ino !== written.ino) {
        await removePartialFile(destination);
        fail('SSH_KEY_STORE_FAILED');
      }
    } catch (err) {
      if (err instanceof SshKeyImportError) throw err;
      fail('SSH_KEY_STORE_FAILED');
    }

    return {
      path: destination,
      fileName: generatedName,
      sourceFileName,
      sizeBytes: bytes.length,
    };
  }
  fail('SSH_KEY_STORE_FAILED');
}

/** 只返回路径/文件名/大小等元数据；私钥字节既不返回也不记录日志。 */
async function importPrivateKeyFile(sourcePath, userData) {
  const directory = await ensurePrivateKeyDirectory(userData);
  const bytes = await readSelectedFile(sourcePath);
  const sourceFileName = path.basename(path.resolve(sourcePath))
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .slice(0, 255);
  return writeProtectedFile(directory, sourceFileName, bytes);
}

/** 追加桌面受保护目录，不覆盖部署方显式配置的 FILE/DIRS。 */
function addPrivateKeyDirectory(env, userData) {
  const directory = privateKeyDirectory(userData);
  const configured = typeof env.AIDB_SSH_PRIVATE_KEY_DIRS === 'string'
    ? env.AIDB_SSH_PRIVATE_KEY_DIRS
    : '';
  const roots = configured.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!roots.includes(directory)) roots.push(directory);
  return { ...env, AIDB_SSH_PRIVATE_KEY_DIRS: roots.join(',') };
}

module.exports = {
  SSH_PRIVATE_KEY_MAX_BYTES,
  SshKeyImportError,
  addPrivateKeyDirectory,
  ensurePrivateKeyDirectory,
  importPrivateKeyFile,
  insideDirectory,
  privateKeyDirectory,
};
