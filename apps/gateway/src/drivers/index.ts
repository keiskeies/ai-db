import { engineDefaultPort, engineMeta, type ConnectionConfig, type ConnectionSecret } from '@aidb/core';
import { ClickHouseDriver } from './clickhouse';
import { CassandraDriver } from './cassandra';
import { DmDriver } from './dm';
import { DuckdbDriver } from './duckdb';
import { ElasticsearchDriver } from './elasticsearch';
import { MongoDriver } from './mongodb';
import { MilvusDriver } from './milvus';
import { MysqlDriver } from './mysql';
import { Neo4jDriver } from './neo4j';
import { OracleDriver } from './oracle';
import { PostgresDriver } from './postgres';
import { QdrantDriver } from './qdrant';
import { RedisDriver } from './redis';
import { SqliteDriver } from './sqlite';
import { SqlServerDriver } from './sqlserver';
import { TdengineDriver } from './tdengine';
import { WeaviateDriver } from './weaviate';
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
  if (meta.transport === 'duckdb-file') {
    if (!config.database) throw new DbError('DuckDB 连接缺少文件路径', { code: 'NO_DUCKDB_PATH' });
    const driver = new DuckdbDriver(config.database, config.readonly);
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
    case 'cassandra': {
      const driver = new CassandraDriver(
        {
          host: connectHost,
          port: connectPort,
          user: config.username,
          password: secret.password,
          database: config.database,
          ssl: config.ssl,
        },
        config.engine,
      );
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'dm': {
      const driver = new DmDriver({
        host: connectHost,
        port: connectPort,
        user: config.username ?? 'SYSDBA',
        password: secret.password,
        database: config.database,
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
      const driver = new Neo4jDriver(
        {
          host: connectHost,
          port: connectPort,
          user: config.username,
          password: secret.password,
          database: config.database,
          defaultDatabase: meta.defaultDatabase,
          ssl: config.ssl,
        },
        config.engine,
      );
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'qdrant-http': {
      const driver = new QdrantDriver({
        host: connectHost,
        port: connectPort,
        apiKey: secret.password,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'milvus-http': {
      const driver = new MilvusDriver({
        host: connectHost,
        port: connectPort,
        token: secret.password,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'weaviate-http': {
      const driver = new WeaviateDriver({
        host: connectHost,
        port: connectPort,
        apiKey: secret.password,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'tdengine-http': {
      const driver = new TdengineDriver({
        host: connectHost,
        port: connectPort,
        user: config.username ?? 'root',
        password: secret.password,
        database: config.database || meta.defaultDatabase,
        ssl: config.ssl,
      });
      return { driver, close: () => closeWithTunnel(driver) };
    }
    case 'elasticsearch-http': {
      const driver = new ElasticsearchDriver(
        {
          host: connectHost,
          port: connectPort,
          user: config.username,
          password: secret.password,
          ssl: config.ssl,
        },
        config.engine,
      );
      return { driver, close: () => closeWithTunnel(driver) };
    }
    default:
      throw new DbError(`不支持的数据库类型：${config.engine}`, { code: 'UNSUPPORTED_ENGINE' });
  }
}

export type { Driver } from './types';
export { DbError } from './types';
export { SqliteDriver } from './sqlite';
