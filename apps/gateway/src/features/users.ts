import { engineMeta, quoteIdent, quoteLiteral } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

export interface DbUser {
  name: string;
  host?: string;
  attributes: string[];
  superuser?: boolean;
  login?: boolean;
  disabled?: boolean;
}

export interface UsersResult {
  supported: boolean;
  users: DbUser[];
  note?: string;
}

const USER_RE = /^[A-Za-z0-9_.$@-]{1,64}$/;
const ROLE_RE = /^[A-Za-z0-9_.$@-]{1,64}$/;
const HOST_RE = /^[A-Za-z0-9_.%:-]{1,128}$/;
const PRIV_RE = /^[A-Za-z0-9_ ,]+$/;
const SCOPE_RE = /^[A-Za-z0-9_.%*-]+$/;

function requireUser(name: unknown): string {
  const text = String(name ?? '').trim();
  if (!USER_RE.test(text)) throw new Error('用户名不合法（允许字母、数字、_ . $ @ -）');
  return text;
}

function requireRole(name: unknown): string {
  const text = String(name ?? '').trim();
  if (!ROLE_RE.test(text)) throw new Error('角色名不合法');
  return text;
}

function requirePassword(value: unknown): string {
  const text = String(value ?? '');
  if (text.length < 4) throw new Error('密码至少 4 位');
  return text;
}

export async function listUsers(store: Store, manager: ConnectionManager, connectionId: string): Promise<UsersResult> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const family = engineMeta(conn.engine).dialect;
  const query = async (sql: string) => {
    const batch = await manager.query(connectionId, sql, { database: conn.database, maxRows: 500, allowMulti: false, autoLimit: false, actor: 'user' });
    const set = batch.sets[0];
    return { names: set?.columns.map((column) => column.name) ?? [], rows: set?.rows ?? [] };
  };
  if (family === 'sqlite') return { supported: false, users: [], note: 'SQLite 没有服务器账户体系，权限由文件系统决定。' };
  if (family === 'mysql') {
    const result = await query('SELECT User, Host, plugin, account_locked FROM mysql.user ORDER BY User, Host');
    const names = result.names.map((name) => name.toLowerCase());
    return {
      supported: true,
      users: result.rows.map((row) => ({
        name: String(row[names.indexOf('user')] ?? ''),
        host: String(row[names.indexOf('host')] ?? ''),
        attributes: [String(row[names.indexOf('plugin')] ?? '')].filter(Boolean),
        disabled: String(row[names.indexOf('account_locked')] ?? 'N') === 'Y',
        login: true,
      })),
    };
  }
  if (family === 'postgres') {
    const result = await query("SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg_%' ORDER BY rolname");
    const names = result.names.map((name) => name.toLowerCase());
    return {
      supported: true,
      users: result.rows.map((row) => ({
        name: String(row[names.indexOf('rolname')] ?? ''),
        attributes: [
          String(row[names.indexOf('rolsuper')]) === 't' ? 'superuser' : '',
          String(row[names.indexOf('rolcreaterole')]) === 't' ? 'createrole' : '',
          String(row[names.indexOf('rolcreatedb')]) === 't' ? 'createdb' : '',
        ].filter(Boolean),
        superuser: String(row[names.indexOf('rolsuper')]) === 't',
        login: String(row[names.indexOf('rolcanlogin')]) === 't',
      })),
    };
  }
  if (family === 'mssql') {
    const result = await query("SELECT name, type_desc, is_disabled FROM sys.server_principals WHERE type IN ('S','U','G') AND name NOT LIKE '##%' ORDER BY name");
    const names = result.names.map((name) => name.toLowerCase());
    return {
      supported: true,
      users: result.rows.map((row) => ({
        name: String(row[names.indexOf('name')] ?? ''),
        attributes: [String(row[names.indexOf('type_desc')] ?? '')],
        disabled: Number(row[names.indexOf('is_disabled')] ?? 0) === 1,
        login: true,
      })),
    };
  }
  if (family === 'oracle' || family === 'dm') {
    const result = await query('SELECT username, account_status, default_tablespace FROM all_users ORDER BY username');
    const names = result.names.map((name) => name.toLowerCase());
    return {
      supported: true,
      users: result.rows.map((row) => ({
        name: String(row[names.indexOf('username')] ?? ''),
        attributes: [String(row[names.indexOf('account_status')] ?? ''), String(row[names.indexOf('default_tablespace')] ?? '')].filter(Boolean),
        disabled: String(row[names.indexOf('account_status')] ?? '') !== 'OPEN',
        login: true,
      })),
    };
  }
  if (family === 'clickhouse') {
    const result = await query('SELECT name, storage, auth_type FROM system.users ORDER BY name');
    const names = result.names.map((name) => name.toLowerCase());
    return {
      supported: true,
      users: result.rows.map((row) => ({
        name: String(row[names.indexOf('name')] ?? ''),
        attributes: [String(row[names.indexOf('storage')] ?? ''), String(row[names.indexOf('auth_type')] ?? '')].filter(Boolean),
        login: true,
      })),
    };
  }
  return { supported: false, users: [], note: '暂不支持该引擎的用户管理' };
}

export async function manageUser(
  store: Store,
  manager: ConnectionManager,
  connectionId: string,
  action: 'create' | 'drop' | 'grant',
  payload: { name?: string; host?: string; password?: string; privileges?: string; scope?: string; role?: string },
): Promise<{ sql: string[] }> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const family = engineMeta(conn.engine).dialect;
  const name = requireUser(payload.name);
  const statements: string[] = [];
  const isMysql = family === 'mysql';
  if (isMysql) {
    const host = String(payload.host ?? '%').trim() || '%';
    if (!HOST_RE.test(host)) throw new Error('主机名不合法');
    if (action === 'create') {
      statements.push(`CREATE USER ${quoteLiteral(name)}@${quoteLiteral(host)} IDENTIFIED BY ${quoteLiteral(requirePassword(payload.password))}`);
    } else if (action === 'drop') {
      statements.push(`DROP USER ${quoteLiteral(name)}@${quoteLiteral(host)}`);
    } else {
      const privileges = String(payload.privileges ?? 'SELECT').trim();
      const scope = String(payload.scope ?? '*.*').trim();
      if (!PRIV_RE.test(privileges)) throw new Error('权限表达式不合法');
      if (!SCOPE_RE.test(scope)) throw new Error('权限范围不合法');
      statements.push(`GRANT ${privileges} ON ${scope} TO ${quoteLiteral(name)}@${quoteLiteral(host)}`);
    }
  } else if (family === 'postgres') {
    const user = quoteIdent(name, conn.engine);
    if (action === 'create') statements.push(`CREATE ROLE ${user} LOGIN PASSWORD ${quoteLiteral(requirePassword(payload.password))}`);
    else if (action === 'drop') statements.push(`DROP ROLE ${user}`);
    else {
      const role = requireRole(payload.role ?? payload.privileges);
      statements.push(`GRANT ${quoteIdent(role, conn.engine)} TO ${user}`);
    }
  } else if (family === 'mssql') {
    const user = quoteIdent(name, conn.engine);
    if (action === 'create') {
      statements.push(`CREATE LOGIN ${user} WITH PASSWORD = ${quoteLiteral(requirePassword(payload.password))}`);
      statements.push(`CREATE USER ${user} FOR LOGIN ${user}`);
    } else if (action === 'drop') {
      statements.push(`DROP USER IF EXISTS ${user}`);
      statements.push(`DROP LOGIN ${user}`);
    } else {
      const role = requireRole(payload.role ?? payload.privileges);
      statements.push(`ALTER SERVER ROLE ${quoteIdent(role, conn.engine)} ADD MEMBER ${user}`);
    }
  } else if (family === 'oracle' || family === 'dm') {
    const upper = name.toUpperCase();
    const user = quoteIdent(upper, conn.engine);
    if (action === 'create') statements.push(`CREATE USER ${user} IDENTIFIED BY ${quoteLiteral(requirePassword(payload.password))}`);
    else if (action === 'drop') statements.push(`DROP USER ${user} CASCADE`);
    else statements.push(`GRANT ${requireRole(payload.role ?? payload.privileges)} TO ${user}`);
  } else if (family === 'clickhouse') {
    const user = quoteIdent(name, conn.engine);
    if (action === 'create') statements.push(`CREATE USER ${user} IDENTIFIED BY ${quoteLiteral(requirePassword(payload.password))}`);
    else if (action === 'drop') statements.push(`DROP USER ${user}`);
    else statements.push(`GRANT ${requireRole(payload.role ?? payload.privileges)} TO ${user}`);
  } else {
    throw new Error('该引擎不支持用户管理');
  }
  const sql = statements.join(';\n');
  const started = Date.now();
  try {
    await manager.query(connectionId, sql, { database: conn.database, allowMulti: true, autoLimit: false, actor: 'user' });
    store.addAudit({
      actor: 'user',
      connectionId,
      database: conn.database,
      tool: `users.${action}`,
      sql,
      risk: action === 'drop' ? 'destructive' : 'ddl',
      approval: 'manual',
      status: 'ok',
      durationMs: Date.now() - started,
      meta: { user: name },
    });
    return { sql: statements };
  } catch (err: any) {
    store.addAudit({
      actor: 'user',
      connectionId,
      database: conn.database,
      tool: `users.${action}`,
      sql,
      risk: action === 'drop' ? 'destructive' : 'ddl',
      approval: 'manual',
      status: 'error',
      durationMs: Date.now() - started,
      meta: { user: name, error: err.message },
    });
    throw err;
  }
}
