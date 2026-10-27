import { engineDefaultPort, type ConnectionConfig, type ConnectionSecret } from '@aidb/core';
import { ClickHouseDriver } from './clickhouse';
import { MysqlDriver } from './mysql';
import { OracleDriver } from './oracle';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';
import { SqlServerDriver } from './sqlserver';
import { openTunnel, type Tunnel } from './ssh';
import { DbError, type Driver } from './types';

export interface DriverBundle {
  driver: Driver;
  close: () => Promise<void>;
}

export async function createDriver(config: ConnectionConfig, secret: ConnectionSecret = {}): Promise<DriverBundle> {
  if (config.engine === 'sqlite') {
    if (!config.database) throw new DbError('SQLite 连接缺少文件路径', { code: 'NO_SQLITE_PATH' });
    const driver = new SqliteDriver(config.database, config.readonly);
    return { driver, close: () => driver.close() };
  }

  const defaultPort = engineDefaultPort(config.engine) ?? 0;
  const host = config.host || '127.0.0.1';
  const port = config.port || defaultPort;
  let tunnel: Tunnel | undefined;
  if (config.ssh?.enabled) {
    tunnel = await openTunnel(config.ssh, host, port, {
      password: secret.sshPassword,
      privateKey: secret.sshPrivateKey,
      passphrase: secret.sshPassphrase ?? config.ssh.passphrase,
    });
  }
  const connectHost = tunnel ? tunnel.localHost : host;
  const connectPort = tunnel ? tunnel.localPort : port;

  if (config.engine === 'mysql' || config.engine === 'mariadb') {
    const driver = new MysqlDriver(
      {
        host: connectHost,
        port: connectPort,
        user: config.username ?? 'root',
        password: secret.password,
        database: config.database,
        ssl: config.ssl,
      },
      config.engine,
    );
    return { driver, close: async () => { await driver.close(); await tunnel?.close(); } };
  }
  if (config.engine === 'postgresql' || config.engine === 'cockroachdb') {
    const driver = new PostgresDriver(
      {
        host: connectHost,
        port: connectPort,
        user: config.username ?? 'postgres',
        password: secret.password,
        database: config.database || 'postgres',
        ssl: config.ssl,
      },
      config.engine,
    );
    return { driver, close: async () => { await driver.close(); await tunnel?.close(); } };
  }
  if (config.engine === 'sqlserver') {
    const driver = new SqlServerDriver({
      host: connectHost,
      port: connectPort,
      user: config.username ?? 'sa',
      password: secret.password,
      database: config.database,
      ssl: config.ssl,
    });
    return { driver, close: async () => { await driver.close(); await tunnel?.close(); } };
  }
  if (config.engine === 'oracle') {
    const driver = new OracleDriver({
      host: connectHost,
      port: connectPort,
      user: config.username ?? 'system',
      password: secret.password,
      database: config.database || 'ORCL',
      ssl: config.ssl,
    });
    return { driver, close: async () => { await driver.close(); await tunnel?.close(); } };
  }
  if (config.engine === 'clickhouse') {
    const driver = new ClickHouseDriver({
      host: connectHost,
      port: connectPort,
      user: config.username ?? 'default',
      password: secret.password,
      database: config.database || 'default',
      ssl: config.ssl,
    });
    return { driver, close: async () => { await driver.close(); await tunnel?.close(); } };
  }
  throw new DbError(`不支持的数据库类型：${config.engine}`, { code: 'UNSUPPORTED_ENGINE' });
}

export type { Driver } from './types';
export { DbError } from './types';
export { SqliteDriver } from './sqlite';
