import { randomUUID } from 'node:crypto';
import {
  builtinMcpKindOf,
  type DeviceInfo,
  type McpServerInfo,
  type NotificationChannelInfo,
  type NotificationChannelType,
} from '@aidb/core';
import { StoreDb, iso } from './db';

interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args_json: string | null;
  env_secret: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface NotificationChannelRow {
  id: string;
  name: string;
  type: NotificationChannelType;
  config_secret: string;
  summary: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** 未配置 expiry 的设备令牌长期有效；已配置但无法解析的时间按失效处理。 */
function deviceExpired(value: unknown, now = Date.now()): boolean {
  if (value === null || value === undefined || value === '') return false;
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value));
  return !Number.isFinite(timestamp) || timestamp <= now;
}

export class IntegrationsRepo {
  constructor(private db: StoreDb) {}

  // ---------- MCP servers ----------
  private rowToMcpServer(row: McpServerRow): McpServerInfo {
    let args: string[] = [];
    try {
      args = row.args_json ? (JSON.parse(row.args_json) as string[]) : [];
    } catch {
      args = [];
    }
    return {
      id: row.id,
      name: row.name,
      command: row.command,
      args,
      enabled: Boolean(row.enabled),
      builtin: builtinMcpKindOf(row.command),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMcpServers(): McpServerInfo[] {
    return this.db.all<McpServerRow>('SELECT * FROM mcp_servers ORDER BY created_at ASC').map((row) => this.rowToMcpServer(row));
  }

  getMcpServer(id: string): McpServerInfo | undefined {
    const row = this.db.one<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    return row ? this.rowToMcpServer(row) : undefined;
  }

  getMcpServerEnv(id: string): Record<string, string> {
    const row = this.db.one<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    return row?.env_secret ? (this.db.box.decrypt<Record<string, string>>(row.env_secret) ?? {}) : {};
  }

  createMcpServer(input: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }): McpServerInfo {
    const id = randomUUID();
    const now = iso();
    this.db.exec(
      `INSERT INTO mcp_servers (id,name,command,args_json,env_secret,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        id,
        input.name.trim(),
        input.command.trim(),
        JSON.stringify(input.args ?? []),
        input.env && Object.keys(input.env).length ? this.db.box.encrypt(input.env) : null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      ],
    );
    return this.getMcpServer(id)!;
  }

  /** Seed a first-party built-in without overwriting the user's toggles or paths. */
  seedMcpServer(input: { id: string; name: string; command: string; args?: string[]; enabled?: boolean }): void {
    const now = iso();
    this.db.exec(
      `INSERT OR IGNORE INTO mcp_servers (id,name,command,args_json,env_secret,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [input.id, input.name, input.command, JSON.stringify(input.args ?? []), null, input.enabled === false ? 0 : 1, now, now],
    );
  }

  updateMcpServer(
    id: string,
    patch: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
  ): McpServerInfo {
    const row = this.db.one<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    if (!row) throw new Error('MCP Server 不存在');
    this.db.exec(
      'UPDATE mcp_servers SET name = ?, command = ?, args_json = ?, env_secret = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [
        patch.name?.trim() ?? row.name,
        patch.command?.trim() ?? row.command,
        patch.args ? JSON.stringify(patch.args) : row.args_json,
        patch.env ? (Object.keys(patch.env).length ? this.db.box.encrypt(patch.env) : null) : row.env_secret,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        iso(),
        id,
      ],
    );
    return this.getMcpServer(id)!;
  }

  deleteMcpServer(id: string): void {
    this.db.exec('DELETE FROM mcp_servers WHERE id = ?', [id]);
  }

  // ---------- skill secrets ----------
  listSkillSecretNames(skillId: string): string[] {
    return this.db.all<{ name: string }>('SELECT name FROM skill_secrets WHERE skill_id = ? ORDER BY name', [skillId]).map((row) => row.name);
  }

  getSkillSecrets(skillId: string, names: string[]): Record<string, string> {
    if (!names.length) return {};
    const rows = this.db.all<{ name: string; value: string }>(
      `SELECT name, value FROM skill_secrets WHERE skill_id = ? AND name IN (${names.map(() => '?').join(',')})`,
      [skillId, ...names],
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      const value = this.db.box.decrypt<string>(row.value);
      if (typeof value === 'string') out[row.name] = value;
    }
    return out;
  }

  setSkillSecret(skillId: string, name: string, value: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(name)) throw new Error('非法密钥名');
    this.db.exec(
      `INSERT INTO skill_secrets (skill_id,name,value,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(skill_id,name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [skillId, name, this.db.box.encrypt(value), iso()],
    );
  }

  deleteSkillSecret(skillId: string, name: string): void {
    this.db.exec('DELETE FROM skill_secrets WHERE skill_id = ? AND name = ?', [skillId, name]);
  }

  // ---------- notification channels ----------
  private rowToNotificationChannel(row: NotificationChannelRow): NotificationChannelInfo {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: Boolean(row.enabled),
      summary: row.summary ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listNotificationChannels(): NotificationChannelInfo[] {
    return this.db.all<NotificationChannelRow>('SELECT * FROM notification_channels ORDER BY created_at ASC').map((row) =>
      this.rowToNotificationChannel(row),
    );
  }

  getNotificationChannel(id: string): NotificationChannelInfo | undefined {
    const row = this.db.one<NotificationChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    return row ? this.rowToNotificationChannel(row) : undefined;
  }

  getNotificationChannelConfig<T = Record<string, unknown>>(id: string): T | null {
    const row = this.db.one<NotificationChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    return row ? this.db.box.decrypt<T>(row.config_secret) : null;
  }

  createNotificationChannel(input: {
    name: string;
    type: NotificationChannelType;
    config: Record<string, unknown>;
    summary?: string;
    enabled?: boolean;
  }): NotificationChannelInfo {
    const id = randomUUID();
    const now = iso();
    this.db.exec(
      `INSERT INTO notification_channels (id,name,type,config_secret,summary,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.name.trim(), input.type, this.db.box.encrypt(input.config), input.summary ?? null, input.enabled === false ? 0 : 1, now, now],
    );
    return this.getNotificationChannel(id)!;
  }

  updateNotificationChannel(
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; summary?: string; enabled?: boolean },
  ): NotificationChannelInfo {
    const row = this.db.one<NotificationChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    if (!row) throw new Error('通知渠道不存在');
    this.db.exec(
      'UPDATE notification_channels SET name = ?, config_secret = ?, summary = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [
        patch.name?.trim() ?? row.name,
        patch.config ? this.db.box.encrypt(patch.config) : row.config_secret,
        patch.summary === undefined ? row.summary : patch.summary,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        iso(),
        id,
      ],
    );
    return this.getNotificationChannel(id)!;
  }

  deleteNotificationChannel(id: string): void {
    this.db.exec('DELETE FROM notification_channels WHERE id = ?', [id]);
  }

  // ---------- devices ----------
  private rowToDevice(row: Record<string, any>): DeviceInfo {
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at ?? undefined,
      revoked: Boolean(row.revoked) || deviceExpired(row.expires_at),
      // 未知/损坏 scope 按最小权限处理；只有明确保存的 admin 才提升权限。
      scope: row.scope === 'admin' || row.scope === 'mcp:readonly' ? row.scope : 'device',
      connectionIds: this.listDeviceConnectionPermissions(row.id),
    };
  }

  createDevice(input: { name: string; platform: string; tokenHash: string; scope?: DeviceInfo['scope']; connectionIds?: string[] }): DeviceInfo {
    const id = randomUUID();
    const now = iso();
    const scope = input.scope ?? 'device';
    this.db.db.exec('BEGIN');
    try {
      this.db.exec('INSERT INTO devices (id,name,platform,token_hash,paired_at,revoked,scope) VALUES (?,?,?,?,?,0,?)', [id, input.name, input.platform, input.tokenHash, now, scope]);
      if (scope === 'device' && input.connectionIds?.length) {
        const grantedAt = iso();
        for (const connectionId of new Set(input.connectionIds)) {
          this.db.exec('INSERT INTO device_connection_permissions (device_id,connection_id,granted_at) VALUES (?,?,?)', [id, connectionId, grantedAt]);
        }
      }
      this.db.db.exec('COMMIT');
    } catch (err) {
      this.db.db.exec('ROLLBACK');
      throw err;
    }
    return this.rowToDevice(this.db.one<Record<string, any>>('SELECT * FROM devices WHERE id = ?', [id])!);
  }

  findDeviceByTokenHash(hash: string): DeviceInfo | undefined {
    const row = this.db.one<Record<string, any>>('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0', [hash]);
    if (!row || deviceExpired(row.expires_at)) return undefined;
    this.db.exec('UPDATE devices SET last_seen_at = ? WHERE id = ?', [iso(), row.id]);
    return this.rowToDevice(row);
  }

  listDevices(): DeviceInfo[] {
    return this.db.all<Record<string, any>>('SELECT * FROM devices ORDER BY paired_at DESC').map((row) => this.rowToDevice(row));
  }

  listDeviceConnectionPermissions(deviceId: string): string[] {
    return this.db.all<{ connection_id: string }>(
      'SELECT connection_id FROM device_connection_permissions WHERE device_id = ? ORDER BY connection_id',
      [deviceId],
    ).map((row) => row.connection_id);
  }

  canDeviceAccessConnection(deviceId: string, connectionId: string): boolean {
    const row = this.db.one<{ expires_at: string | null }>(
      `SELECT device.expires_at
       FROM device_connection_permissions AS permission
       JOIN devices AS device ON device.id = permission.device_id
       WHERE permission.device_id = ? AND permission.connection_id = ?
         AND device.revoked = 0 AND device.scope = 'device'`,
      [deviceId, connectionId],
    );
    return Boolean(row && !deviceExpired(row.expires_at));
  }

  /** 管理端整体替换 ACL；空数组成员 Explicit deny，未知连接拒绝，避免静默制造失效授权。 */
  setDeviceConnectionPermissions(deviceId: string, connectionIds: string[]): string[] {
    const device = this.db.one<{ scope: string }>('SELECT scope FROM devices WHERE id = ?', [deviceId]);
    if (!device) {
      throw Object.assign(new Error('设备不存在'), { code: 'DEVICE_NOT_FOUND', status: 404 });
    }
    if (device.scope !== 'device') {
      throw Object.assign(new Error('只有 device 角色可以配置连接 ACL'), { code: 'INVALID_INPUT', status: 400 });
    }
    const unique = [...new Set(connectionIds)];
    if (unique.length > 1000) throw Object.assign(new Error('单设备最多授权 1000 个连接'), { code: 'INVALID_INPUT', status: 400 });
    for (const connectionId of unique) {
      if (!this.db.one('SELECT 1 AS one FROM connections WHERE id = ?', [connectionId])) {
        throw Object.assign(new Error(`连接不存在：${connectionId}`), { code: 'CONNECTION_NOT_FOUND', status: 400 });
      }
    }
    this.db.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM device_connection_permissions WHERE device_id = ?', [deviceId]);
      const grantedAt = iso();
      for (const connectionId of unique) {
        this.db.exec('INSERT INTO device_connection_permissions (device_id,connection_id,granted_at) VALUES (?,?,?)', [deviceId, connectionId, grantedAt]);
      }
      this.db.db.exec('COMMIT');
    } catch (err) {
      this.db.db.exec('ROLLBACK');
      throw err;
    }
    return this.listDeviceConnectionPermissions(deviceId);
  }

  revokeDevice(id: string): void {
    this.db.exec('UPDATE devices SET revoked = 1 WHERE id = ?', [id]);
  }
}
