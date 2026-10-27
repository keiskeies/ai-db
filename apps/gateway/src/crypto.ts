import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM secret box for connection credentials and API keys at rest. */
export class SecretBox {
  private key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
  }

  decrypt<T>(payload: string | null | undefined): T | null {
    if (!payload) return null;
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    try {
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const ciphertext = Buffer.from(parts[3], 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      return null;
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
  return String(Math.floor(100000 + Math.random() * 900000));
}
