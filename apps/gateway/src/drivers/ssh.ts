import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Client, type SyncHostVerifier } from 'ssh2';
import type { SshConfig } from '@aidb/core';
import { DbError } from './types';

const { utils: sshUtils } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2');

export interface Tunnel {
  localHost: string;
  localPort: number;
  close: () => Promise<void>;
}

export interface TunnelSecrets {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** JSON 配置不能保存函数；hostVerifier 由受信任的程序调用方显式传入。 */
export interface SshTunnelConfig extends SshConfig {
  knownHosts?: string;
  knownHostsPath?: string;
  privateKeyDirs?: string[];
  knownHostsDirs?: string[];
}

export interface SshTunnelOptions {
  knownHosts?: string;
  knownHostsPath?: string;
  hostVerifier?: SyncHostVerifier;
  /** 允许读取私钥/known_hosts 的明确目录；不接受从请求体动态扩大。 */
  privateKeyDirs?: string[];
  knownHostsDirs?: string[];
}

const MAX_SSH_FILE_BYTES = 1024 * 1024;

function pathList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function withinRoot(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function readScopedFile(file: string, roots: string[], exactFiles: string[], label: string): string {
  const resolved = resolve(file);
  const exact = exactFiles.some((entry) => resolve(entry) === resolved);
  let allowed = exact;
  let realFile = resolved;
  if (!allowed) {
    try {
      realFile = realpathSync(resolved);
      allowed = roots.some((root) => {
        try {
          return withinRoot(realFile, realpathSync(resolve(root)));
        } catch {
          return false;
        }
      });
    } catch {
      allowed = false;
    }
  }
  if (!allowed) throw new DbError(`${label}路径不在用户明确配置的允许范围内`, { code: label === 'SSH 私钥' ? 'SSH_KEY_PATH_DENIED' : 'SSH_KNOWN_HOSTS_PATH_DENIED' });
  try {
    const info = lstatSync(resolved);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
    const realInfo = statSync(realFile);
    if (!realInfo.isFile() || realInfo.size > MAX_SSH_FILE_BYTES) throw new Error('invalid file');
    return readFileSync(realFile, 'utf8');
  } catch {
    throw new DbError(`${label}不存在、不是普通文件或超过大小上限`, { code: label === 'SSH 私钥' ? 'SSH_KEY_READ' : 'SSH_KNOWN_HOSTS_READ' });
  }
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function hashedHostMatches(salt: Buffer, expected: Buffer, candidates: string[]): boolean {
  return candidates.some((candidate) => {
    const actual = createHmac('sha1', salt).update(candidate).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function hostPatternMatches(patterns: string, host: string, port: number): boolean {
  const candidates = port === 22 ? [host] : [host, `[${host}]:${port}`];
  let positive = false;
  for (const raw of patterns.split(',')) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const negated = pattern.startsWith('!');
    // 哈希主机名的 Base64 区分大小写，不能像普通主机模式一样整体转小写。
    const value = negated ? pattern.slice(1) : pattern;
    let matched = false;
    if (value.startsWith('|1|')) {
      const parts = value.split('|');
      if (parts.length === 4) {
        try {
          matched = hashedHostMatches(Buffer.from(parts[2], 'base64'), Buffer.from(parts[3], 'base64'), candidates);
        } catch {
          matched = false;
        }
      }
    } else {
      matched = candidates.some((candidate) => wildcardMatch(value, candidate));
    }
    if (negated && matched) return false;
    if (!negated && matched) positive = true;
  }
  return positive;
}

/** 基于 OpenSSH known_hosts（明文/通配符/|1| 哈希主机名）的同步主机密钥校验。 */
export function createKnownHostsVerifier(content: string, host: string, port: number): SyncHostVerifier {
  const entries = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const fields = line.split(/\s+/);
    return fields.length >= 3 ? { patterns: fields[0], type: fields[1], key: fields[2] } : undefined;
  }).filter((entry): entry is { patterns: string; type: string; key: string } => Boolean(entry));
  return (key: Buffer) => {
    let presented;
    try {
      presented = sshUtils.parseKey(key);
    } catch {
      return false;
    }
    if (presented instanceof Error) return false;
    const presentedKey = presented.getPublicSSH();
    for (const entry of entries) {
      if (!hostPatternMatches(entry.patterns, host, port)) continue;
      let trusted;
      try {
        trusted = sshUtils.parseKey(`${entry.type} ${entry.key}`);
      } catch {
        continue;
      }
      if (trusted instanceof Error) continue;
      const trustedKey = trusted.getPublicSSH();
      if (trustedKey.length === presentedKey.length && timingSafeEqual(trustedKey, presentedKey)) return true;
    }
    return false;
  };
}

export async function openTunnel(
  ssh: SshConfig,
  targetHost: string,
  targetPort: number,
  secrets: TunnelSecrets = {},
  options: SshTunnelOptions = {},
): Promise<Tunnel> {
  const extended = ssh as SshTunnelConfig;
  const privateKeyDirs = options.privateKeyDirs ?? extended.privateKeyDirs ?? pathList(process.env.AIDB_SSH_PRIVATE_KEY_DIRS);
  const knownHostsDirs = options.knownHostsDirs ?? extended.knownHostsDirs ?? pathList(process.env.AIDB_SSH_KNOWN_HOSTS_DIRS);
  const client = new Client();
  let privateKey = secrets.privateKey;
  if (ssh.authMethod === 'key' && !privateKey && ssh.privateKeyPath) {
    try {
      privateKey = readScopedFile(
        ssh.privateKeyPath,
        privateKeyDirs,
        pathList(process.env.AIDB_SSH_PRIVATE_KEY_FILE),
        'SSH 私钥',
      );
    } catch (err: any) {
      if (err instanceof DbError) throw err;
      throw new DbError(`无法读取 SSH 私钥：${err.message}`, { code: 'SSH_KEY_READ' });
    }
  }

  const configuredKnownHostsPath = options.knownHostsPath ?? extended.knownHostsPath;
  const envKnownHostsPath = process.env.AIDB_SSH_KNOWN_HOSTS_FILE?.trim() || undefined;
  const knownHostsPath = configuredKnownHostsPath ?? envKnownHostsPath;
  const knownHosts = options.knownHosts ?? extended.knownHosts ?? process.env.AIDB_SSH_KNOWN_HOSTS?.trim()
    ?? (knownHostsPath ? readScopedFile(knownHostsPath, knownHostsDirs, configuredKnownHostsPath ? [] : [knownHostsPath], 'SSH known_hosts') : undefined);
  const hostVerifier = options.hostVerifier ?? (knownHosts
    ? createKnownHostsVerifier(knownHosts, ssh.host, ssh.port || 22)
    : undefined);
  if (!hostVerifier) {
    client.end();
    throw new DbError('未配置 known_hosts/hostVerifier，已拒绝未知 SSH 主机', { code: 'SSH_HOST_KEY_UNKNOWN' });
  }

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(new DbError(`SSH 连接失败：${err.message}`, { code: 'SSH_CONNECT' })));
    client.connect({
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user,
      password: ssh.authMethod === 'password' ? (secrets.password ?? ssh.password) : undefined,
      privateKey,
      passphrase: secrets.passphrase ?? ssh.passphrase,
      hostVerifier,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
    });
  }).catch((err) => {
    client.end();
    throw err;
  });

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
      if (err) {
        socket.destroy();
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on('error', () => socket.destroy());
      socket.on('error', () => stream.destroy());
    });
  });
  // ready 之后的错误没有消费者，不挂监听会让 EventEmitter 抛出未捕获异常并终止进程。
  client.on('error', () => {
    for (const socket of sockets) socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (err: any) {
    // server 已创建但未进入 listening：必须关闭以释放句柄（Windows 下否则句柄泄漏）。
    // 未 listening 时 close() 会抛 ERR_SERVER_NOT_RUNNING，用 try 保护。
    try {
      server.close(() => undefined);
    } catch {
      /* server 未启动或已关闭，忽略 */
    }
    client.end();
    throw new DbError(`SSH 隧道建立失败：${err.message}`, { code: 'SSH_TUNNEL' });
  }
  const port = (server.address() as net.AddressInfo).port;
  let closing = false;
  return {
    localHost: '127.0.0.1',
    localPort: port,
    close: async () => {
      if (closing) return;
      closing = true;
      // 先断开转发 socket，否则有连接未释放时 server.close 会一直等下去。
      for (const socket of sockets) socket.destroy();
      // destroy 偶发失败会让 close 回调永不触发导致挂起：加 2s 竞速兜底，无论如何都继续。
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      client.end();
    },
  };
}
