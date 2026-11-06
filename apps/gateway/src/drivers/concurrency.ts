/**
 * 有界并发映射：结果按输入顺序返回，失败由调用方在 fn 内部自行降级。
 *
 * 元数据探测（逐个集合 / 标签 / 索引）原本是串行的，集合一多就是几百次往返；
 * 并发上限保持在小值（4-6），避免把远端服务一次性打满。
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}
