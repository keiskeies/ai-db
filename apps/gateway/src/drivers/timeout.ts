import { DbError } from './types';

/**
 * 给单次查询套上超时。超时后调用 onTimeout 主动断开底层连接，
 * 否则慢命令（如 Redis KEYS、DM 全表扫描）会继续占用连接。
 */
export async function withQueryTimeout<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  opts: { code: string; label: string; onTimeout?: () => void },
): Promise<T> {
  const ms = timeoutMs && timeoutMs > 0 ? timeoutMs : 30000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new DbError(`${opts.label}超时（${ms}ms）`, { code: opts.code, status: 504 }));
          // 先让超时错误赢得竞态，再断连接；否则断开引发的 rejection 可能覆盖超时文案。
          setTimeout(() => opts.onTimeout?.(), 0);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
