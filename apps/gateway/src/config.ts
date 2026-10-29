import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';

export interface GatewayConfig {
  version: string;
  home: string;
  dbPath: string;
  host: string;
  port: number;
  token: string;
  secret: string;
  demoDir: string;
  exportDir: string;
  importDir: string;
  backupDir: string;
  attachmentDir: string;
  staticDir: string;
  production: boolean;
  /** 跨请求事务空闲回收阈值，默认 15 分钟；测试可调小。 */
  txIdleMs?: number;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSecret(home: string): string {
  if (process.env.AIDB_SECRET) return process.env.AIDB_SECRET;
  const file = join(home, 'secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const home = overrides.home ?? process.env.AIDB_HOME ?? join(homedir(), '.aidb');
  ensureDir(home);
  const production = process.env.NODE_ENV === 'production';
  const defaultStatic = resolve(fileURLToPath(new URL('../../desktop/dist', import.meta.url)));
  const token = overrides.token ?? process.env.AIDB_TOKEN ?? (production ? randomBytes(24).toString('hex') : 'dev-token');
  return {
    version: VERSION,
    home,
    dbPath: overrides.dbPath ?? process.env.AIDB_DB ?? join(home, 'aidb.db'),
    host: overrides.host ?? process.env.AIDB_HOST ?? '127.0.0.1',
    port: overrides.port ?? Number(process.env.AIDB_PORT ?? 8787),
    token,
    secret: overrides.secret ?? loadSecret(home),
    demoDir: overrides.demoDir ?? ensureDir(join(home, 'demo')),
    exportDir: overrides.exportDir ?? ensureDir(join(home, 'exports')),
    importDir: overrides.importDir ?? ensureDir(join(home, 'imports')),
    backupDir: overrides.backupDir ?? ensureDir(join(home, 'backups')),
  attachmentDir: overrides.attachmentDir ?? ensureDir(join(home, 'attachments')),
    staticDir: overrides.staticDir ?? process.env.AIDB_STATIC_DIR ?? defaultStatic,
    production,
    txIdleMs: overrides.txIdleMs ?? (process.env.AIDB_TX_IDLE_MS ? Number(process.env.AIDB_TX_IDLE_MS) : undefined),
  };
}
