export function formatCell(value: unknown): { text: string; kind: 'null' | 'number' | 'json' | 'bool' | 'text' } {
  if (value === null || value === undefined) return { text: 'NULL', kind: 'null' };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', kind: 'bool' };
  if (typeof value === 'number') return { text: Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6))), kind: 'number' };
  if (typeof value === 'bigint') return { text: value.toString(), kind: 'number' };
  if (typeof value === 'object') return { text: JSON.stringify(value), kind: 'json' };
  return { text: String(value), kind: 'text' };
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(n?: number): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRelative(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString();
}

export function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export function sqlPreview(sql: string, n = 90): string {
  return truncate(sql.replace(/\s+/g, ' ').trim(), n);
}
