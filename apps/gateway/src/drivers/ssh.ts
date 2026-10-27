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
  });

  const server = net.createServer((socket) => {
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    localHost: '127.0.0.1',
    localPort: port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.end();
    },
  };
}
