import { readFileSync } from 'node:fs';
import net from 'node:net';
import { Client } from 'ssh2';
import type { SshConfig } from '@aidb/core';
import { DbError } from './types';

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

export async function openTunnel(ssh: SshConfig, targetHost: string, targetPort: number, secrets: TunnelSecrets = {}): Promise<Tunnel> {
  const client = new Client();
  let privateKey = secrets.privateKey;
  if (ssh.authMethod === 'key' && !privateKey && ssh.privateKeyPath) {
    try {
      privateKey = readFileSync(ssh.privateKeyPath, 'utf8');
    } catch (err: any) {
      throw new DbError(`无法读取 SSH 私钥：${err.message}`, { code: 'SSH_KEY_READ' });
    }
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
