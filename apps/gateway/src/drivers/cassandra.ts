import { Client, auth } from 'cassandra-driver';
import type { ColumnInfo, Engine, QueryResult, StructuredQuery, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions } from './types';
import { DbError } from './types';

export interface CassandraOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? '';
    if (/Long|Integer|Uuid|BigDecimal|LocalDate|LocalTime|Duration|InetAddress/.test(name)) return String(value);
    return JSON.stringify(value);
  }
  return value;
}

/** Cassandra 2.x 的 validator 是 Java 类名，展示成 CQL 类型名才有意义。 */
function legacyColumnType(validator: unknown): string {
  const raw = String(validator ?? '').split('.').pop() ?? '';
  const map: Record<string, string> = {
    UTF8Type: 'text',
    AsciiType: 'ascii',
    SimpleUUIDType: 'uuid',
    UUIDType: 'uuid',
    TimeUUIDType: 'timeuuid',
    Int32Type: 'int',
    Int64Type: 'bigint',
    LongType: 'bigint',
    BooleanType: 'boolean',
    DoubleType: 'double',
    FloatType: 'float',
    DecimalType: 'decimal',
    BytesType: 'blob',
    TimestampType: 'timestamp',
    DateType: 'date',
    InetAddressType: 'inet',
    CounterColumnType: 'counter',
    ListType: 'list',
    SetType: 'set',
    MapType: 'map',
  };
  return map[raw] ?? raw.replace(/Type$/, '').toLowerCase();
}

export class CassandraDriver implements Driver {
  engine: Engine;
  private clients = new Map<string, Client>();

  constructor(private opts: CassandraOptions, engine: Engine = 'cassandra') {
    this.engine = engine;
  }

  private client(keyspace?: string): Client {
    const key = keyspace ?? '';
    let client = this.clients.get(key);
    if (!client) {
      client = new Client({
        contactPoints: [this.opts.host || '127.0.0.1'],
        protocolOptions: { port: this.opts.port || 9042 },
        localDataCenter: 'datacenter1',
        keyspace: keyspace || undefined,
        authProvider: this.opts.user ? new auth.PlainTextAuthProvider(this.opts.user, this.opts.password ?? '') : undefined,
        sslOptions: this.opts.ssl ? {} : undefined,
        socketOptions: { connectTimeout: 10000 },
      });
      client.on('error', () => undefined);
      this.clients.set(key, client);
    }
    return client;
  }

  private async ready(keyspace?: string): Promise<Client> {
    const client = this.client(keyspace);
    await client.connect();
    return client;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const client = await this.ready();
      const result = await client.execute('SELECT release_version, cluster_name FROM system.local');
      const row = result.rows[0] as { release_version?: string; cluster_name?: string } | undefined;
      return { ok: true, version: `${this.engine === 'scylla' ? 'ScyllaDB' : 'Cassandra'} ${row?.release_version ?? ''}`.trim(), latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    let client: Client;
    try {
      client = await this.ready();
    } catch (err: any) {
      throw new DbError(err?.message ?? '无法读取 keyspace', { code: 'CASSANDRA_ERROR' });
    }
    try {
      const result = await client.execute('SELECT keyspace_name FROM system_schema.keyspaces');
      return (result.rows as unknown as Array<{ keyspace_name: string }>).map((row) => String(row.keyspace_name)).sort();
    } catch (err: any) {
      // 3.0 之前元数据在 system.schema_keyspaces；不能因为表名搬家就报「读不到 keyspace」。
      try {
        const legacy = await client.execute('SELECT keyspace_name FROM system.schema_keyspaces');
        return (legacy.rows as unknown as Array<{ keyspace_name: string }>).map((row) => String(row.keyspace_name)).sort();
      } catch {
        throw new DbError(err?.message ?? '无法读取 keyspace', { code: 'CASSANDRA_ERROR' });
      }
    }
  }

  /** Cassandra 2.x 的表与列布局（没有 views，kind 用 type，类型用 validator）。 */
  private async legacyDescribe(client: Client, keyspace: string): Promise<TableInfo[]> {
    const [tables, columns] = await Promise.all([
      client.execute('SELECT columnfamily_name FROM system.schema_columnfamilies WHERE keyspace_name = ?', [keyspace]),
      client.execute('SELECT columnfamily_name, column_name, type, component_index, validator FROM system.schema_columns WHERE keyspace_name = ?', [keyspace]),
    ]);
    const columnsByTable = new Map<string, Array<ColumnInfo & { position: number; kind: string }>>();
    for (const row of columns.rows as unknown as Array<{ columnfamily_name: string; column_name: string; type: string; component_index: number | null; validator: string }>) {
      const list = columnsByTable.get(String(row.columnfamily_name)) ?? [];
      const kind = String(row.type ?? '');
      list.push({
        name: String(row.column_name),
        type: legacyColumnType(row.validator),
        nullable: kind !== 'partition_key' && kind !== 'clustering',
        defaultValue: null,
        primaryKey: kind === 'partition_key' || kind === 'clustering',
        autoIncrement: false,
        position: Number(row.component_index ?? 0),
        kind,
      });
      columnsByTable.set(String(row.columnfamily_name), list);
    }
    return (tables.rows as unknown as Array<{ columnfamily_name: string }>).map((row) => {
      const name = String(row.columnfamily_name);
      const list = (columnsByTable.get(name) ?? []).sort((a, b) => a.position - b.position);
      return {
        name,
        type: 'table',
        schema: keyspace,
        columns: list.map(({ position, kind, ...column }) => column),
      } satisfies TableInfo;
    });
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const keyspace = database || this.opts.database || 'system';
    let client: Client;
    try {
      client = await this.ready();
    } catch (err: any) {
      throw new DbError(err?.message ?? `无法读取 keyspace ${keyspace}`, { code: 'CASSANDRA_ERROR' });
    }
    try {
      const [tables, views, columns] = await Promise.all([
        client.execute('SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [keyspace], { prepare: true }),
        client.execute('SELECT view_name FROM system_schema.views WHERE keyspace_name = ?', [keyspace], { prepare: true }),
        client.execute(
          'SELECT table_name, column_name, kind, position, type FROM system_schema.columns WHERE keyspace_name = ?',
          [keyspace],
          { prepare: true },
        ),
      ]);
      const viewNames = new Set((views.rows as unknown as Array<{ view_name: string }>).map((row) => String(row.view_name)));
      const columnsByTable = new Map<string, Array<ColumnInfo & { position: number; kind: string }>>();
      for (const row of columns.rows as unknown as Array<{ table_name: string; column_name: string; kind: string; position: number; type: string }>) {
        const list = columnsByTable.get(row.table_name) ?? [];
        list.push({
          name: String(row.column_name),
          type: String(row.type),
          nullable: row.kind !== 'partition_key' && row.kind !== 'clustering',
          defaultValue: null,
          primaryKey: row.kind === 'partition_key' || row.kind === 'clustering',
          autoIncrement: false,
          position: Number(row.position ?? 0),
          kind: String(row.kind),
        });
        columnsByTable.set(row.table_name, list);
      }
      return (tables.rows as unknown as Array<{ table_name: string }>).map((row) => {
        const name = String(row.table_name);
        const list = (columnsByTable.get(name) ?? []).sort((a, b) => a.position - b.position);
        return {
          name,
          type: viewNames.has(name) ? 'view' : 'table',
          schema: keyspace,
          columns: list.map(({ position, kind, ...column }) => column),
        } satisfies TableInfo;
      });
    } catch (err: any) {
      // 2.x 没有 system_schema.*：退回 system.schema_columnfamilies / schema_columns
      try {
        return await this.legacyDescribe(client, keyspace);
      } catch {
        throw new DbError(err?.message ?? `无法读取 keyspace ${keyspace}`, { code: 'CASSANDRA_ERROR' });
      }
    }
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'cql') throw new DbError('Cassandra 驱动只接受 CQL', { code: 'CQL_ONLY' });
    const text = query.text.trim();
    if (!text) throw new DbError('CQL 不能为空', { code: 'CQL_EMPTY' });
    const started = Date.now();
    try {
      const client = await this.ready(opts.database);
      const result = await client.execute(text, query.params ?? [], {
        prepare: Boolean(query.params?.length),
        fetchSize: opts.maxRows && opts.maxRows > 0 ? opts.maxRows : undefined,
      });
      const columns = (result.columns ?? []).map((column) => ({ name: column.name, type: String(column.type?.code ?? '') }));
      const rows = ((result.rows ?? []) as Array<Record<string, unknown>>).map((row) => columns.map((column) => normalize(row[column.name])));
      return {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
        statement: text,
      };
    } catch (err: any) {
      throw new DbError(err?.message ?? 'CQL 执行失败', { code: 'CASSANDRA_ERROR' });
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.executeQuery({ language: 'cql', text: sql }, opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    return this.executeQuery({ language: 'cql', text: sql, params }, opts);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        try {
          await client.shutdown();
        } catch {
          /* ignore */
        }
      }),
    );
    this.clients.clear();
  }
}
