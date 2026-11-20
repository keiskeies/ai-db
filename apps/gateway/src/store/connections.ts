import { randomUUID } from 'node:crypto';
import type {
  BackupInfo,
  ConnectionColor,
  ConnectionConfig,
  ConnectionOptions,
  ConnectionSecret,
  Engine,
  Environment,
  SshConfig,
} from '@aidb/core';
import { StoreDb, iso } from './db';

export interface ConnectionRow {
  id: string;
  name: string;
  engine: Engine;
  color: ConnectionColor;
  environment: Environment;
  group_name: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  secret: string | null;
  ssl: number;
  ssl_insecure: number;
  auth_mode: string | null;
  options_json: string | null;
  ssh_json: string | null;
  readonly: number;
  note: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface ConnectionInput {
  name: string;
  engine: Engine;
  color?: ConnectionColor;
  environment?: Environment;
  groupName?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  ssl?: boolean;
  sslInsecure?: boolean;
  authMode?: 'basic' | 'apikey';
  options?: ConnectionOptions;
  ssh?: SshConfig;
  readonly?: boolean;
  note?: string;
}

export interface DatabaseBriefRecord {
  scopeKey: string;
  connectionId: string;
  database?: string;
  path: string;
  schemaHash?: string;
  generatedAt: string;
  updatedAt: string;
}

export class ConnectionsRepo {
  constructor(private db: StoreDb) {}

  // ---------- connections ----------
  private rowToConfig(row: ConnectionRow): ConnectionConfig {
    let ssh: SshConfig | undefined;
    if (row.ssh_json) {
      try {
        ssh = JSON.parse(row.ssh_json) as SshConfig;
      } catch {
        ssh = undefined;
      }
    }
    let options: ConnectionOptions | undefined;
    if (row.options_json) {
      try {
        options = JSON.parse(row.options_json) as ConnectionOptions;
      } catch {
        options = undefined;
      }
    }
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      color: row.color,
      environment: row.environment,
      groupName: row.group_name,
      host: row.host ?? undefined,
      port: row.port ?? undefined,
      database: row.database ?? undefined,
      username: row.username ?? undefined,
      hasPassword: Boolean(row.secret),
      ssl: Boolean(row.ssl),
      sslInsecure: Boolean(row.ssl_insecure),
      authMode: row.auth_mode === 'apikey' ? 'apikey' : row.auth_mode === 'basic' ? 'basic' : undefined,
      options,
      ssh,
      readonly: Boolean(row.readonly),
      note: row.note ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  listConnections(): ConnectionConfig[] {
    return this.db.all<ConnectionRow>('SELECT * FROM connections ORDER BY group_name, name').map((r) => this.rowToConfig(r));
  }

  getConnectionRow(id: string): ConnectionRow | undefined {
    return this.db.one<ConnectionRow>('SELECT * FROM connections WHERE id = ?', [id]);
  }

  getConnection(id: string): ConnectionConfig | undefined {
    const row = this.getConnectionRow(id);
    return row ? this.rowToConfig(row) : undefined;
  }

  getConnectionSecret(id: string): ConnectionSecret {
    const row = this.getConnectionRow(id);
    if (!row?.secret) return {};
    return this.db.box.decrypt<ConnectionSecret>(row.secret) ?? {};
  }

  createConnection(input: ConnectionInput): ConnectionConfig {
    const id = randomUUID();
    const now = iso();
    const secret: ConnectionSecret & { sshPassphrase?: string } = {};
    const sshPassword = input.sshPassword ?? input.ssh?.password;
    const sshPassphrase = input.sshPassphrase ?? input.ssh?.passphrase;
    if (input.password) secret.password = input.password;
    if (sshPassword) secret.sshPassword = sshPassword;
    if (input.sshPrivateKey) secret.sshPrivateKey = input.sshPrivateKey;
    if (sshPassphrase) secret.sshPassphrase = sshPassphrase;
    const ssh = input.ssh ? { ...input.ssh, password: undefined, passphrase: undefined } : undefined;
    this.db.exec(
      `INSERT INTO connections (id,name,engine,color,environment,group_name,host,port,database,username,secret,ssl,ssl_insecure,auth_mode,options_json,ssh_json,readonly,note,created_at,updated_at,last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [
        id,
        input.name,
        input.engine,
        input.color ?? 'blue',
        input.environment ?? 'dev',
        input.groupName ?? '默认',
        input.host ?? null,
        input.port ?? null,
        input.database ?? null,
        input.username ?? null,
        Object.keys(secret).length ? this.db.box.encrypt(secret) : null,
        input.ssl ? 1 : 0,
        input.sslInsecure ? 1 : 0,
        input.authMode ?? null,
        input.options ? JSON.stringify(input.options) : null,
        ssh ? JSON.stringify(ssh) : null,
        input.readonly ? 1 : 0,
        input.note ?? null,
        now,
        now,
      ],
    );
    return this.getConnection(id)!;
  }

  updateConnection(id: string, patch: Partial<ConnectionInput>): ConnectionConfig {
    const row = this.getConnectionRow(id);
    if (!row) throw new Error('连接不存在');
    const existingSecret = row.secret ? this.db.box.decrypt<Record<string, unknown>>(row.secret) ?? {} : {};
    const secret: Record<string, unknown> = { ...existingSecret };
    const setOrClear = (key: string, value?: string) => {
      if (value === undefined) return;
      if (value === '') delete secret[key];
      else secret[key] = value;
    };
    setOrClear('password', patch.password);
    setOrClear('sshPassword', patch.sshPassword ?? patch.ssh?.password);
    setOrClear('sshPrivateKey', patch.sshPrivateKey);
    setOrClear('sshPassphrase', patch.sshPassphrase ?? patch.ssh?.passphrase);

    let ssh = row.ssh_json;
    if (patch.ssh !== undefined) {
      ssh = patch.ssh ? JSON.stringify({ ...patch.ssh, password: undefined, passphrase: undefined }) : null;
    }
    const next = {
      name: patch.name ?? row.name,
      engine: patch.engine ?? row.engine,
      color: patch.color ?? row.color,
      environment: patch.environment ?? row.environment,
      group: patch.groupName ?? row.group_name,
      host: patch.host !== undefined ? patch.host : row.host,
      port: patch.port !== undefined ? patch.port : row.port,
      database: patch.database !== undefined ? patch.database : row.database,
      username: patch.username !== undefined ? patch.username : row.username,
      ssl: patch.ssl !== undefined ? (patch.ssl ? 1 : 0) : row.ssl,
      sslInsecure: patch.sslInsecure !== undefined ? (patch.sslInsecure ? 1 : 0) : row.ssl_insecure,
      authMode: patch.authMode !== undefined ? patch.authMode : row.auth_mode,
      optionsJson: patch.options !== undefined ? (patch.options ? JSON.stringify(patch.options) : null) : row.options_json,
      readonly: patch.readonly !== undefined ? (patch.readonly ? 1 : 0) : row.readonly,
      note: patch.note !== undefined ? patch.note : row.note,
    };
    this.db.exec(
      `UPDATE connections SET name=?, engine=?, color=?, environment=?, group_name=?, host=?, port=?, database=?, username=?,
        secret=?, ssl=?, ssl_insecure=?, auth_mode=?, options_json=?, ssh_json=?, readonly=?, note=?, updated_at=? WHERE id=?`,
      [
        next.name,
        next.engine,
        next.color,
        next.environment,
        next.group,
        next.host ?? null,
        next.port ?? null,
        next.database ?? null,
        next.username ?? null,
        Object.keys(secret).length ? this.db.box.encrypt(secret) : null,
        next.ssl,
        next.sslInsecure,
        next.authMode ?? null,
        next.optionsJson,
        ssh,
        next.readonly,
        next.note ?? null,
        iso(),
        id,
      ],
    );
    return this.getConnection(id)!;
  }

  deleteConnection(id: string): void {
    this.db.exec('DELETE FROM connections WHERE id = ?', [id]);
    // 仪表板卡片是我们自己的元数据：连接没了还留着，就是指向不存在库的死配置
    this.db.exec('DELETE FROM dashboard_cards WHERE connection_id = ?', [id]);
  }

  touchConnection(id: string): void {
    this.db.exec('UPDATE connections SET last_used_at = ? WHERE id = ?', [iso(), id]);
  }

  // ---------- database briefs (AI_DB.md) ----------
  getDatabaseBrief(connectionId: string, database?: string): DatabaseBriefRecord | undefined {
    const row = this.db.one<Record<string, any>>('SELECT * FROM database_briefs WHERE scope_key = ?', [`${connectionId}/${database ?? ''}`]);
    if (!row) return undefined;
    return {
      scopeKey: row.scope_key,
      connectionId: row.connection_id,
      database: row.database_name ?? undefined,
      path: row.path,
      schemaHash: row.schema_hash ?? undefined,
      generatedAt: row.generated_at,
      updatedAt: row.updated_at,
    };
  }

  saveDatabaseBrief(record: Omit<DatabaseBriefRecord, 'scopeKey' | 'updatedAt'>): DatabaseBriefRecord {
    const scopeKey = `${record.connectionId}/${record.database ?? ''}`;
    const now = iso();
    this.db.exec(
      `INSERT INTO database_briefs (scope_key,connection_id,database_name,path,schema_hash,generated_at,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(scope_key) DO UPDATE SET path=excluded.path, schema_hash=excluded.schema_hash, generated_at=excluded.generated_at, updated_at=excluded.updated_at`,
      [scopeKey, record.connectionId, record.database ?? null, record.path, record.schemaHash ?? null, record.generatedAt, now],
    );
    return this.getDatabaseBrief(record.connectionId, record.database)!;
  }

  renameGroup(from: string, to: string): number {
    return this.db.exec('UPDATE connections SET group_name = ?, updated_at = ? WHERE group_name = ?', [to, new Date().toISOString(), from]).changes;
  }

  deleteGroup(name: string): number {
    return this.db.exec("UPDATE connections SET group_name = '默认', updated_at = ? WHERE group_name = ?", [new Date().toISOString(), name]).changes;
  }

  // ---------- schema cache ----------
  getSchemaCache(connectionId: string, database: string): { payload: string; fetchedAt: string } | undefined {
    const row = this.db.one<{ payload: string; fetched_at: string }>('SELECT payload, fetched_at FROM schema_cache WHERE connection_id = ? AND database_name = ?', [
      connectionId,
      database,
    ]);
    return row ? { payload: row.payload, fetchedAt: row.fetched_at } : undefined;
  }

  setSchemaCache(connectionId: string, database: string, payload: unknown): void {
    this.db.exec(
      'INSERT INTO schema_cache (connection_id,database_name,payload,fetched_at) VALUES (?,?,?,?) ON CONFLICT(connection_id,database_name) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at',
      [connectionId, database, JSON.stringify(payload), iso()],
    );
  }

  clearSchemaCache(connectionId: string): void {
    this.db.exec('DELETE FROM schema_cache WHERE connection_id = ?', [connectionId]);
  }

  // ---------- backups ----------
  addBackup(input: Omit<BackupInfo, 'id' | 'createdAt'>): BackupInfo {
    const backup: BackupInfo = { ...input, id: randomUUID(), createdAt: iso() };
    this.db.exec('INSERT INTO backups (id,connection_id,database_name,path,format,bytes,label,created_at) VALUES (?,?,?,?,?,?,?,?)', [
      backup.id,
      backup.connectionId,
      backup.database ?? null,
      backup.path,
      backup.format,
      backup.bytes,
      backup.label ?? null,
      backup.createdAt,
    ]);
    return backup;
  }

  listBackups(connectionId?: string): BackupInfo[] {
    const rows = connectionId
      ? this.db.all<Record<string, any>>('SELECT * FROM backups WHERE connection_id = ? ORDER BY created_at DESC', [connectionId])
      : this.db.all<Record<string, any>>('SELECT * FROM backups ORDER BY created_at DESC');
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      database: r.database_name ?? undefined,
      path: r.path,
      format: r.format,
      bytes: r.bytes ?? 0,
      label: r.label ?? undefined,
      createdAt: r.created_at,
    }));
  }
}
