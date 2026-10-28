import { engineDefaultPort, engineMeta, type ConnectionConfig, type ConnectionSecret } from '@aidb/core';
import { ClickHouseDriver } from './clickhouse';
import { MongoDriver } from './mongodb';
import { MysqlDriver } from './mysql';
import { Neo4jDriver } from './neo4j';
import { OracleDriver } from './oracle';
import { PostgresDriver } from './postgres';
import { RedisDriver } from './redis';
import { SqliteDriver } from './sqlite';
import { SqlServerDriver } from './sqlserver';
import { openTunnel, type Tunnel } from './ssh';
import { DbError, type Driver } from './types';

export interface DriverBundle {
  driver: Driver;
  close: () => Promise<void>;
}

export async function createDriver(config: ConnectionConfig, secret: ConnectionSecret = {}): Promise<DriverBundle> {
  const meta = engineMeta(config.engine);

  if (meta.transport === 'sqlite-file') {
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
  const closeWithTunnel = async (driver: Driver) => {
    await driver.close();
    await tunnel?.close();
  };

  switch (meta.transport) {
    case 'mysql': {
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
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'postgres': {
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
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'tds': {
      const driver = new SqlServerDriver({
        host: connectHost,
        port: connectPort,
        user: config.username ?? 'sa',
        password: secret.password,
        database: config.database,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'oracle': {
      const driver = new OracleDriver({
        host: connectHost,
        port: connectPort,
        user: config.username ?? 'system',
        password: secret.password,
        database: config.database || 'ORCL',
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'clickhouse-http': {
      const driver = new ClickHouseDriver({
        host: connectHost,
        port: connectPort,
        user: config.username ?? 'default',
        password: secret.password,
        database: config.database || 'default',
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'mongodb': {
      const driver = new MongoDriver({
        host: connectHost,
        port: connectPort,
        user: config.username,
        password: secret.password,
        database: config.database,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'redis': {
      const driver = new RedisDriver({
        host: connectHost,
        port: connectPort,
        username: config.username,
        password: secret.password,
        database: config.database,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'bolt': {
      const driver = new Neo4jDriver({
        host: connectHost,
        port: connectPort,
        user: config.username,
        password: secret.password,
        database: config.database,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'qdrant-http':
    case 'milvus-grpc':
    case 'weaviate-http':
      throw new DbError(`${meta.label} 驱动尚未接入`, { code: 'UNSUPPORTED_ENGINE' });
    default:
      throw new DbError(`不支持的数据库类型：${config.engine}`, { code: 'UNSUPPORTED_ENGINE' });
  }
}

export type { Driver } from './types';
export { DbError } from './types';
export { SqliteDriver } from './sqlite';
