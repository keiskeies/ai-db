import { useEffect, useState } from 'react';
import type { RedisKeyDetail } from '@aidb/core';
import { api } from '../lib/api';
import { DataGrid } from './DataGrid';
import { Modal, Spinner } from './ui';

function ttlText(ttl: number): string {
  if (ttl === -2) return '键已过期';
  if (ttl === -1) return '永不过期';
  return `剩余 ${ttl}s`;
}

export function RedisKeyDialog({
  connectionId,
  database,
  keyName,
  onClose,
}: {
  connectionId: string;
  database?: string;
  keyName: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { detail: found } = await api.redisKey({ connectionId, database, key: keyName });
      setDetail(found);
    } catch (err: any) {
      setError(err?.message ?? '读取键失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, database, keyName]);

  return (
    <Modal
      title={keyName}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => void load()} disabled={loading} data-testid="redis-key-refresh">
            刷新
          </button>
          <button className="btn primary" onClick={onClose}>关闭</button>
        </>
      }
    >
      {loading && !detail ? <Spinner /> : null}
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }} data-testid="redis-key-error">{error}</div> : null}
      {detail ? (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
            <span data-testid="redis-key-type">类型 {detail.type}</span>
            <span>TTL {ttlText(detail.ttl)}</span>
            {detail.size !== null && detail.size !== undefined ? <span>规模 {detail.size}</span> : null}
            {detail.encoding ? <span>编码 {detail.encoding}</span> : null}
          </div>
          {detail.note ? <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{detail.note}</div> : null}
          {detail.rows.length ? (
            <DataGrid columns={detail.columns} rows={detail.rows} testId="redis-key-grid" />
          ) : (
            <div className="muted" style={{ fontSize: 11 }}>没有可展示的取值</div>
          )}
        </>
      ) : null}
    </Modal>
  );
}
