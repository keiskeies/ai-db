import { isIP } from 'node:net';

/** URL/URI authority 中的 IPv6 字面量必须保留方括号。 */
export function authorityHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
