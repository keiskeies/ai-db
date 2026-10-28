import { useEffect, useState } from 'react';
import type { RedisKeyDetail } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
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
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const connections = useApp((s) => s.connections);
  const notify = useApp((s) => s.notify);
  const conn = connections.find((item) => item.id === connectionId);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const { result } = await api.deleteRedisKeys({ connectionId, database, keys: [keyName] });
      notify('success', result.deleted ? '键已删除' : '键已不存在', keyName);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '删除失败');
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

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
          <button className="btn" onClick={() => void load()} disabled={loading || deleting} data-testid="redis-key-refresh">
            刷新
          </button>
          {conn && !conn.readonly ? (
            confirming ? (
              <>
                <input
                  className="input"
                  style={{ width: 170 }}
                  value={typed}
                  placeholder={`输入 ${keyName} 确认`}
                  onChange={(event) => setTyped(event.target.value)}
                  data-testid="redis-key-confirm"
                />
                <button
                  className="btn danger"
                  onClick={() => void remove()}
                  disabled={deleting || typed.trim() !== keyName}
                  data-testid="redis-key-delete-submit"
                >
                  {deleting ? <Spinner /> : null} 确认删除
                </button>
                <button className="btn" onClick={() => { setConfirming(false); setTyped(''); }} disabled={deleting}>
                  取消
                </button>
              </>
            ) : (
              <button className="btn danger" onClick={() => setConfirming(true)} disabled={deleting} data-testid="redis-key-delete">
                删除键
              </button>
            )
          ) : null}
          <button className="btn primary" onClick={onClose} disabled={deleting}>关闭</button>
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
