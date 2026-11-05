import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Local credential file for the paired read-only MCP device token. */
export function credentialsPath() {
  if (process.env.AIDB_MCP_CREDENTIALS) return resolve(process.env.AIDB_MCP_CREDENTIALS);
  if (platform() === 'win32') {
    const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'aidb-mcp', 'credentials.json');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'aidb-mcp', 'credentials.json');
}

export function readCredentials() {
  const file = credentialsPath();
  if (!existsSync(file)) {
    throw new Error('未找到 MCP 配对凭据，请先运行：npx -y @aidb/mcp pair');
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('MCP 配对凭据已损坏，请重新运行：npx -y @aidb/mcp pair');
  }
  for (const key of ['url', 'token', 'deviceId', 'pairedAt']) {
    if (typeof data[key] !== 'string' || !data[key]) {
      throw new Error('MCP 配对凭据字段不完整，请重新运行：npx -y @aidb/mcp pair');
    }
  }
  return { url: data.url, token: data.token, deviceId: data.deviceId, pairedAt: data.pairedAt };
}

const fsIo = { writeFileSync, renameSync, unlinkSync, chmodSync };

/**
 * 原子替换：先写同目录临时文件，再 rename 覆盖。
 * 绝不能在 rename 之前删除目标文件——rename 失败时旧凭据会一起丢失。
 * io 参数只用于测试注入失败路径。
 */
export function atomicWriteCredentials(file, value, io = fsIo) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    io.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    io.renameSync(tmp, file);
  } catch (err) {
    try { io.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  io.chmodSync(file, 0o600);
  return file;
}

export function writeCredentials(value) {
  const file = credentialsPath();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteCredentials(file, value);
  if (platform() !== 'win32') {
    // 目录权限在 mkdirSync 已存在时不会重设，显式补一次。
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  return file;
}
