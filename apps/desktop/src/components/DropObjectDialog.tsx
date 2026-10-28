import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ConnectionConfig } from '@aidb/core';
import { engineMeta } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';

/** 删除向量集合 / 搜索索引 / Weaviate class / MongoDB 集合：需要手输名字确认。 */
export function DropObjectDialog({
  connection,
  database,
  name,
  onClose,
}: {
  connection: ConnectionConfig;
  database?: string;
  name: string;
  onClose: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const loadSchema = useApp((s) => s.loadSchema);
  const meta = engineMeta(connection.engine);
  const label = meta.model === 'search' ? '索引' : meta.model === 'document' ? '集合' : '集合 / class';
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (typed.trim() !== name) {
      setError('输入的名字需要与对象名完全一致');
      return;
    }
    setRunning(true);
    try {
      await api.dropObject({ connectionId: connection.id, database, name });
      notify('success', `${label}已删除`, name);
      onClose();
      void loadSchema(connection.id, true, database).catch(() => undefined);
    } catch (err: any) {
      setError(err?.message ?? '删除失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`删除${label}`}
      icon={<Trash2 size={15} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>取消</button>
          <button className="btn danger" onClick={() => void submit()} disabled={running || typed.trim() !== name} data-testid="drop-object-submit">
            {running ? <Spinner /> : null} 确认删除
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        <b>{name}</b> 内的全部文档会被销毁，且不可恢复。
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
        输入对象名 <code>{name}</code> 以确认
      </div>
      <input className="input" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus data-testid="drop-object-confirm" />
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }} data-testid="drop-object-error">{error}</div> : null}
    </Modal>
  );
}
