import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { ConnectionConfig, SshConfig } from '@aidb/core';
import { createDriver } from '../src/drivers/index';
import { openTunnel } from '../src/drivers/ssh';

const SSH_PORT = process.env.AIDB_TEST_SSH_PORT ? Number(process.env.AIDB_TEST_SSH_PORT) : undefined;
const TARGET_HOST = process.env.AIDB_TEST_SSH_TARGET_HOST;
const TARGET_PORT = process.env.AIDB_TEST_SSH_TARGET_PORT ? Number(process.env.AIDB_TEST_SSH_TARGET_PORT) : 3306;
const SSH_USER = process.env.AIDB_TEST_SSH_USER ?? 'root';
const SSH_PASSWORD = process.env.AIDB_TEST_SSH_PASSWORD ?? 'testpass';
const SSH_KEY = process.env.AIDB_TEST_SSH_KEY;
const DB_PASSWORD = process.env.AIDB_TEST_MYSQL_PASSWORD ?? 'testpass';

const skip = !SSH_PORT || !TARGET_HOST;

function sshConfig(): SshConfig {
  return { enabled: true, host: '127.0.0.1', port: SSH_PORT!, user: SSH_USER, authMethod: 'password' };
}

function mysqlConfig(): ConnectionConfig {
  const now = new Date().toISOString();
  return {
    id: 'ssh-e2e',
    name: 'ssh-e2e',
    engine: 'mysql',
    color: 'cyan',
    environment: 'dev',
    groupName: '',
    host: TARGET_HOST!,
    port: TARGET_PORT,
    username: 'root',
    ssh: sshConfig(),
    readonly: false,
    createdAt: now,
    updatedAt: now,
  };
}

test('SSH 隧道转发目标端口，关闭后本地端口释放', { skip }, async () => {
  const tunnel = await openTunnel(sshConfig(), TARGET_HOST!, TARGET_PORT, { password: SSH_PASSWORD });
  let banner = '';
  try {
    banner = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(tunnel.localPort, tunnel.localHost);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('隧道 5s 内没有转发任何数据'));
      }, 5000);
      socket.once('data', (chunk) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(chunk.toString('latin1'));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await tunnel.close();
  }
  // 握手包里的服务端版本号，证明数据确实从目标端口转发过来
  assert.match(banner, /\d+\.\d+\.\d+/);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = net.connect(tunnel.localPort, tunnel.localHost);
      socket.once('connect', () => {
        socket.destroy();
        resolve(null);
      });
      socket.once('error', reject);
    }),
    /ECONNREFUSED/,
  );
});

test('连接配置走 SSH 隧道完成 MySQL 查询', { skip }, async () => {
  const bundle = await createDriver(mysqlConfig(), { password: DB_PASSWORD, sshPassword: SSH_PASSWORD });
  try {
    const probed = await bundle.driver.test();
    assert.equal(probed.ok, true, probed.message);
    const result = await bundle.driver.run('SELECT 1 AS n');
    assert.equal(Number(result.rows[0]?.[0]), 1);
  } finally {
    await bundle.close();
  }
});

test('SSH 私钥认证转发目标端口', { skip: skip || !SSH_KEY }, async () => {
  const tunnel = await openTunnel({ ...sshConfig(), authMethod: 'key', privateKeyPath: SSH_KEY }, TARGET_HOST!, TARGET_PORT);
  let banner = '';
  try {
    banner = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(tunnel.localPort, tunnel.localHost);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('私钥隧道 5s 内没有转发任何数据'));
      }, 5000);
      socket.once('data', (chunk) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(chunk.toString('latin1'));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await tunnel.close();
  }
  assert.match(banner, /\d+\.\d+\.\d+/);
});

test('SSH 密码错误返回 SSH_CONNECT', { skip }, async () => {
  await assert.rejects(
    openTunnel(sshConfig(), TARGET_HOST!, TARGET_PORT, { password: 'definitely-wrong' }),
    (err: any) => err?.code === 'SSH_CONNECT',
  );
});
