import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const CURRENT_SECRETBOX_VERSION = 'v2';
const SUPPORTED_SECRETBOX_VERSIONS = new Set(['v1', CURRENT_SECRETBOX_VERSION]);
const CANARY_VALUE = 'aidb-master-key-v2';

/** 密文损坏或主密钥不匹配时必须显式失败，绝不能把 null 当成“没有密钥”。 */
export class SecretDecryptionError extends Error {
  readonly code = 'SECRET_DECRYPT_FAILED';

  constructor() {
    super('主密钥无法解密现有数据；请检查 AIDB_SECRET/密钥文件，未修改任何密文');
    this.name = 'SecretDecryptionError';
  }
}

function keyFor(secret: string, version: string): Buffer {
  // 域分隔避免 v2 与旧版共用裸 SHA-256 密钥语义。
  const hash = createHash('sha256');
  // v1 必须保留旧版的裸 SHA-256 派生以解密现有数据；v2 才使用域分隔。
  if (version === CURRENT_SECRETBOX_VERSION) hash.update('aidb:secretbox:v2\0');
  return hash.update(secret).digest();
}

/** AES-256-GCM secret box for connection credentials and API keys at rest. */
export class SecretBox {
  private readonly keys: Map<string, Buffer>;

  constructor(secret: string) {
    if (typeof secret !== 'string' || !secret.length) throw new Error('主密钥不能为空');
    this.keys = new Map([...SUPPORTED_SECRETBOX_VERSIONS].map((version) => [version, keyFor(secret, version)]));
  }

  get version(): string {
    return CURRENT_SECRETBOX_VERSION;
  }

  encrypt(value: unknown): string {
    const version = CURRENT_SECRETBOX_VERSION;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(version)!, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [version, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
  }

  decrypt<T>(payload: string | null | undefined): T | null {
    if (!payload) return null;
    const parts = payload.split('.');
    if (parts.length !== 4 || !SUPPORTED_SECRETBOX_VERSIONS.has(parts[0])) throw new SecretDecryptionError();
    try {
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const ciphertext = Buffer.from(parts[3], 'base64');
      if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.keys.get(parts[0])!, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      // 不区分错密钥与密文损坏：两者都必须中止当前读写，调用方不得覆盖原密文。
      throw new SecretDecryptionError();
    }
  }

  /** 随主密钥文件/外部 secret manager 保存，用于启动时发现错密钥。 */
  canary(): string {
    return this.encrypt({ canary: CANARY_VALUE, version: 2 });
  }

  verifyCanary(payload: string | null | undefined): boolean {
    if (!payload) return false;
    try {
      const value = this.decrypt<{ canary?: unknown; version?: unknown }>(payload);
      return value?.canary === CANARY_VALUE && value.version === 2;
    } catch {
      return false;
    }
  }
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function pairingCode(): string {
  // CSPRNG：6 位码空间只有 10^6，Math.random() 可被预测，不能用于配对凭据。
  return String(100000 + randomInt(0, 900000));
}
