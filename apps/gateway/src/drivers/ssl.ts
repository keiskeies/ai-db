import { Agent } from 'undici';

export interface TlsFlags {
  ssl?: boolean;
  sslInsecure?: boolean;
}

/**
 * MySQL 8 默认自签证书、内网 IP 证书与很多 PG/MSSQL 实例都没有受信 CA。
 * 「加密但不校验」必须是一个可持久化的连接选项，而不是逼用户关掉 SSL。
 */
export function nodeTlsOptions(flags: TlsFlags): { rejectUnauthorized: boolean } | undefined {
  return flags.ssl ? { rejectUnauthorized: !flags.sslInsecure } : undefined;
}

export function trustServerCertificate(flags: TlsFlags): boolean {
  return Boolean(flags.ssl && flags.sslInsecure);
}

/** 自签 HTTPS 服务（ES / OpenSearch 等）用的 undici dispatcher；调用方负责销毁。 */
export function tlsDispatcher(flags: TlsFlags): Agent | undefined {
  if (!flags.ssl || !flags.sslInsecure) return undefined;
  return new Agent({ connect: { rejectUnauthorized: false } });
}
