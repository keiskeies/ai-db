import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  fstatSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretBox } from './crypto';

export const VERSION = '0.0.10';
const MIN_MASTER_SECRET_LENGTH = 32;
const MAX_SECRET_FILE_BYTES = 64 * 1024;

export interface GatewayConfig {
  version: string;
  home: string;
  dbPath: string;
  host: string;
  port: number;
  token: string;
  secret: string;
  /** 密文格式版本；旧 v1 密文仍可读取，新密文始终写 v2。 */
  secretVersion?: number;
  /** 反代/公网访问时的外部地址，例如 https://db.example.com；用于配对二维码与提示。 */
  publicUrl?: string;
  demoDir: string;
  exportDir: string;
  importDir: string;
  backupDir: string;
  attachmentDir: string;
  staticDir: string;
  production: boolean;
  /** 显式允许访问私网/回环的出站 origin；只接受完整 origin，不接受通配符。 */
  allowedPrivateOrigins?: string[];
  /** 跨请求事务空闲回收阈值，默认 15 分钟；测试可调小。 */
  txIdleMs?: number;
  /** Agent 回合绝对预算；0 表示关闭。 */
  agentTurnMs?: number;
  /** 进程实例标识，用于回合所有权与恢复审计。 */
  instanceId?: string;
  /** 可选运维告警 webhook。 */
  alertWebhookUrl?: string;
}

interface MasterKeyFile {
  version: 1;
  secret: string;
  canary: string;
  createdAt: string;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function configError(message: string): Error {
  return Object.assign(new Error(message), { code: 'AIDB_MASTER_KEY_INVALID' });
}

function validateMasterSecret(secret: string): string {
  const value = secret.trim();
  if (value.length < MIN_MASTER_SECRET_LENGTH) {
    throw configError(`主密钥长度至少为 ${MIN_MASTER_SECRET_LENGTH} 个字符`);
  }
  return value;
}

function windowsIdentity(): { sid: string; username: string } {
  const script = "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
  const sid = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  }).trim();
  if (!/^S-1-\d+-\d+/.test(sid)) throw configError('无法确认当前 Windows 用户 SID');
  return { sid, username: userInfo().username };
}

function hardenWindowsAcl(file: string, sid: string): void {
  const script = [
    '$ar = New-Object System.Security.AccessControl.FileSecurity',
    '$ar.SetAccessRuleProtection($true, $false)',
    `$sid = [Security.Principal.SecurityIdentifier]'${sid}'`,
    '$ar.SetOwner($sid)',
    "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList $sid, 'FullControl', 'Allow'",
    '$ar.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $env:AIDB_ACL_PATH -AclObject $ar',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, AIDB_ACL_PATH: file },
    stdio: 'pipe',
    windowsHide: true,
    timeout: 10_000,
  });
}

function assertWindowsAcl(file: string): void {
  const { sid } = windowsIdentity();
  const script = [
    '$a = Get-Acl -LiteralPath $env:AIDB_ACL_PATH',
    '$a.GetOwner([Security.Principal.SecurityIdentifier]).Value',
    "@($a.Access | ForEach-Object { $_.AccessControlType.ToString() + '|' + $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + '|' + $_.FileSystemRights.ToString() }) -join [Environment]::NewLine",
  ].join('; ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, AIDB_ACL_PATH: file },
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    timeout: 10_000,
  }).trim();
  const [owner, ...rules] = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (owner !== sid) throw configError('主密钥文件所有者不是当前用户');
  if (!rules.length || rules.some((rule) => {
    const [type, identity, rights] = rule.split('|');
    return type !== 'Allow' || identity !== sid || rights !== 'FullControl';
  })) {
    throw configError('主密钥文件 ACL 必须只允许当前用户完全控制');
  }
}

function assertSecureFile(file: string): void {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw configError('主密钥文件不存在或不可读取');
  }
  if (!info.isFile() || info.isSymbolicLink()) throw configError('主密钥文件必须是普通文件，不能是符号链接');
  if (info.size > MAX_SECRET_FILE_BYTES) throw configError('主密钥文件过大');
  if (process.platform === 'win32') {
    assertWindowsAcl(file);
  } else {
    if ((info.mode & 0o077) !== 0) throw configError('主密钥文件权限不能允许组/其他用户访问（应为 0600）');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw configError('主密钥文件所有者不是当前用户');
    }
  }
}

function readSecureFile(file: string): string {
  assertSecureFile(file);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(file, flags);
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(file);
    // 校验实际打开的 inode 与路径仍指向同一文件；O_NOFOLLOW 在 POSIX 上再挡一次符号链接。
    if (!opened.isFile() || opened.size > MAX_SECRET_FILE_BYTES
      || named.dev !== opened.dev || named.ino !== opened.ino) throw configError('主密钥文件状态不安全');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function parseKeyFile(raw: string, file: string): { secret: string; canary?: string; legacy: boolean } {
  const text = raw.trim();
  if (!text) throw configError('主密钥文件为空');
  if (!text.startsWith('{')) return { secret: validateMasterSecret(text), legacy: true };
  let parsed: Partial<MasterKeyFile>;
  try {
    parsed = JSON.parse(text) as Partial<MasterKeyFile>;
  } catch {
    throw configError('主密钥文件不是合法 JSON');
  }
  if (parsed.version !== 1 || typeof parsed.secret !== 'string' || typeof parsed.canary !== 'string') {
    throw configError(`主密钥文件格式不受支持：${file}`);
  }
  return { secret: validateMasterSecret(parsed.secret), canary: parsed.canary, legacy: false };
}

function createKeyFile(file: string, secret: string, replace = false): void {
  const payload: MasterKeyFile = {
    version: 1,
    secret,
    canary: new SecretBox(secret).canary(),
    createdAt: new Date().toISOString(),
  };
  const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (process.platform === 'win32') hardenWindowsAcl(temp, windowsIdentity().sid);
    // link 是“不覆盖”的原子发布；显式迁移才用 rename 原子替换旧密钥文件。
    if (replace) renameSync(temp, file);
    else linkSync(temp, file);
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw configError(`无法原子创建主密钥文件：${err?.code ?? 'unknown'}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* 已 link 或从未创建 */
    }
  }
}

function verifyExternalSecret(secret: string, canary: string | undefined, production: boolean): string {
  const value = validateMasterSecret(secret);
  if (production && !canary) {
    throw configError('生产模式使用 AIDB_SECRET/AIDB_SECRET_FILE 时必须同时配置 AIDB_SECRET_CANARY，以拒绝错误主密钥启动');
  }
  if (canary && !new SecretBox(value).verifyCanary(canary)) {
    throw configError('AIDB_SECRET_CANARY 与主密钥不匹配，拒绝启动');
  }
  return value;
}

function loadSecret(home: string, production: boolean, allowLocalKey: boolean): string {
  const inline = process.env.AIDB_SECRET?.trim();
  const externalFile = process.env.AIDB_SECRET_FILE?.trim();
  if (inline && externalFile) throw configError('AIDB_SECRET 与 AIDB_SECRET_FILE 不能同时配置');
  const canary = process.env.AIDB_SECRET_CANARY?.trim() || undefined;
  if (inline) return verifyExternalSecret(inline, canary, production);
  if (externalFile) {
    const file = resolve(externalFile);
    const parsed = parseKeyFile(readSecureFile(file), file);
    return verifyExternalSecret(parsed.secret, canary ?? parsed.canary, production);
  }

  const file = join(home, 'secret');
  if (existsSync(file)) {
    const parsed = parseKeyFile(readSecureFile(file), file);
    if (parsed.legacy && production) {
      if (!allowLocalKey) throw configError('生产模式拒绝没有 canary 的旧版主密钥文件；请通过 AIDB_SECRET + AIDB_SECRET_CANARY 注入并验证主密钥');
      createKeyFile(file, parsed.secret, true);
      const upgraded = parseKeyFile(readSecureFile(file), file);
      if (upgraded.legacy || upgraded.secret !== parsed.secret || !new SecretBox(parsed.secret).verifyCanary(upgraded.canary)) {
        throw configError('旧版主密钥文件迁移校验失败');
      }
      return parsed.secret;
    }
    if (parsed.canary && !new SecretBox(parsed.secret).verifyCanary(parsed.canary)) {
      throw configError('本地主密钥 canary 校验失败，拒绝启动');
    }
    return parsed.secret;
  }
  if (production && !allowLocalKey) {
    throw configError('生产模式缺少主密钥：请设置 AIDB_SECRET + AIDB_SECRET_CANARY，或挂载 AIDB_SECRET_FILE（secret manager）');
  }
  const secret = randomBytes(32).toString('hex');
  createKeyFile(file, secret);
  // 发布后重新走同一套权限/所有者/canary 校验，不信任“写入大概成功”。
  const created = parseKeyFile(readSecureFile(file), file);
  if (!created.canary || !new SecretBox(secret).verifyCanary(created.canary) || created.secret !== secret) {
    throw configError('新创建的主密钥文件校验失败');
  }
  return secret;
}

function publicUrlOf(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AIDB_PUBLIC_URL 不是合法地址：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`AIDB_PUBLIC_URL 只支持 http/https：${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('AIDB_PUBLIC_URL 不能携带凭据、查询或片段');
  return url.origin;
}

export function parseAllowedPrivateOrigins(value?: string): string[] {
  const out = new Set<string>();
  for (const item of (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`AIDB_EGRESS_ALLOW_PRIVATE_ORIGINS 包含非法 origin：${item}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('私网出站白名单只支持 http/https origin');
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('私网出站白名单只接受不含路径、查询、片段或凭据的完整 origin');
    }
    out.add(url.origin);
  }
  return [...out];
}

function turnBudget(value: unknown): number {
  const ms = Number(value ?? 30 * 60 * 1000);
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0 || ms > 24 * 60 * 60 * 1000) {
    throw new Error('AIDB_AGENT_TURN_MS 必须是 0..86400000 的整数；0 表示关闭');
  }
  return ms;
}

function alertWebhook(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AIDB_ALERT_WEBHOOK_URL 不是合法地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('AIDB_ALERT_WEBHOOK_URL 只支持 http/https');
  if (url.username || url.password || url.hash) throw new Error('AIDB_ALERT_WEBHOOK_URL 不能携带凭据或片段');
  return url.toString();
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const home = overrides.home ?? process.env.AIDB_HOME ?? join(homedir(), '.aidb');
  ensureDir(home);
  const production = process.env.NODE_ENV === 'production';
  const allowLocalKey = process.env.AIDB_ALLOW_LOCAL_KEY === '1';
  const defaultStatic = resolve(fileURLToPath(new URL('../../desktop/dist', import.meta.url)));
  const token = overrides.token ?? process.env.AIDB_TOKEN ?? (production ? randomBytes(24).toString('hex') : 'dev-token');
  const secret = overrides.secret !== undefined
    ? (production ? verifyExternalSecret(overrides.secret, process.env.AIDB_SECRET_CANARY?.trim() || undefined, true) : overrides.secret)
    : loadSecret(home, production, allowLocalKey);
  return {
    version: VERSION,
    home,
    dbPath: overrides.dbPath ?? process.env.AIDB_DB ?? join(home, 'aidb.db'),
    host: overrides.host ?? process.env.AIDB_HOST ?? '127.0.0.1',
    port: overrides.port ?? Number(process.env.AIDB_PORT ?? 8787),
    token,
    secret,
    secretVersion: 2,
    publicUrl: publicUrlOf(overrides.publicUrl ?? process.env.AIDB_PUBLIC_URL),
    demoDir: overrides.demoDir ?? ensureDir(join(home, 'demo')),
    exportDir: overrides.exportDir ?? ensureDir(join(home, 'exports')),
    importDir: overrides.importDir ?? ensureDir(join(home, 'imports')),
    backupDir: overrides.backupDir ?? ensureDir(join(home, 'backups')),
    attachmentDir: overrides.attachmentDir ?? ensureDir(join(home, 'attachments')),
    staticDir: overrides.staticDir ?? process.env.AIDB_STATIC_DIR ?? defaultStatic,
    production,
    allowedPrivateOrigins: overrides.allowedPrivateOrigins ?? parseAllowedPrivateOrigins(process.env.AIDB_EGRESS_ALLOW_PRIVATE_ORIGINS),
    txIdleMs: overrides.txIdleMs ?? (process.env.AIDB_TX_IDLE_MS ? Number(process.env.AIDB_TX_IDLE_MS) : undefined),
    agentTurnMs: turnBudget(overrides.agentTurnMs ?? process.env.AIDB_AGENT_TURN_MS),
    instanceId: overrides.instanceId ?? randomBytes(16).toString('hex'),
    alertWebhookUrl: alertWebhook(overrides.alertWebhookUrl ?? process.env.AIDB_ALERT_WEBHOOK_URL),
  };
}
