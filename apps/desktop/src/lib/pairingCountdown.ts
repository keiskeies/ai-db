import { useEffect, useState } from 'react';

/** 剩余秒数（向上取整，最小 0）。createdAt 为生成码的本地时间戳（毫秒）。 */
export function secondsLeft(createdAt: number, expiresInSeconds: number, now: number): number {
  return Math.max(0, Math.ceil((createdAt + expiresInSeconds * 1000 - now) / 1000));
}

/** 每秒刷新一次，返回当前时间戳；active=false 时不启动定时器。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
