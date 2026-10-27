import { useState } from 'react';
import { Archive, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal } from './ui';

export type DatabaseDialogKind = 'create' | 'drop' | 'rename' | 'dump';

interface Props {
  kind: DatabaseDialogKind;
  connectionId: string;
  database: string;
  onClose: () => void;
}

export function DatabaseOpsDialog({ kind, connectionId, database, onClose }: Props) {
  const notify = useApp((s) => s.notify);
  const loadSchema = useApp((s) => s.loadSchema);

  const [name, setName] = useState(kind === 'rename' ? database : kind === 'create' ? '' : database);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  const title =
    kind === 'create' ? '新建数据库' : kind === 'drop' ? `删除数据库 · ${database}` : kind === 'rename' ? `重命名数据库 · ${database}` : `转储 SQL 文件 · ${database}`;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (kind === 'dump') {
        const { backup } = await api.createBackup({ connectionId, database, label: `dump-${database}` });
        setResult(`${backup.path} · ${(backup.bytes / 1024).toFixed(1)} KB`);
        notify('success', '数据库已转储', backup.path);
        return;
      }
      if (kind === 'drop' && confirmText.trim() !== database) {
        setError('请输入完整数据库名确认删除');
        return;
      }
      const payload =
        kind === 'create'
          ? { connectionId, database: name.trim(), op: 'create' }
          : kind === 'rename'
            ? { connectionId, database, op: 'rename', newName: name.trim() }
            : { connectionId, database, op: 'drop' };
      const res = await api.databaseOps(payload);
      if (res.supported === false) {
        setError(res.message ?? '当前引擎不支持该操作');
        return;
      }
      notify('success', kind === 'create' ? '数据库已创建' : kind === 'rename' ? '数据库已重命名' : '数据库已删除', name.trim() || database);
      await loadSchema(connectionId, true);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const footer =
    kind === 'dump' ? (
      <>
        <button className="btn" onClick={onClose}>关闭</button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy} data-testid="db-op-submit">
          {busy ? <Loader2 size={12} className="spin" /> : <Archive size={12} />} 开始转储
        </button>
      </>
    ) : (
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className={`btn ${kind === 'drop' ? 'danger' : 'primary'}`} onClick={() => void submit()} disabled={busy} data-testid="db-op-submit">
          {busy ? <Loader2 size={12} className="spin" /> : null} 确认
        </button>
      </>
    );

  return (
    <Modal title={title} onClose={onClose} footer={footer}>
      <div className="col gap-10">
        {kind === 'create' || kind === 'rename' ? (
          <div className="field">
            <label>{kind === 'create' ? '数据库名' : '新数据库名'}</label>
            <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="db-op-name" />
          </div>
        ) : null}
        {kind === 'drop' ? (
          <div className="field">
            <label>输入 <span className="mono">{database}</span> 确认删除</label>
            <input className="input mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus data-testid="db-op-confirm" />
          </div>
        ) : null}
        {kind === 'dump' ? (
          <p className="hint" style={{ margin: 0 }}>生成逻辑 SQL 转储文件，可在设置 → 数据中查看与恢复。</p>
        ) : null}
        {result ? <pre className="ddl-block">{result}</pre> : null}
        {error ? <div className="risk-banner">{error}</div> : null}
      </div>
    </Modal>
  );
}
