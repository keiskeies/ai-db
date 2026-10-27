import { useEffect, useState } from 'react';
import { Code2, Copy, Loader2, Play, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal } from './ui';

export type TableDialogKind = 'rename' | 'duplicate' | 'maintenance' | 'ddl';

interface Props {
  kind: TableDialogKind;
  connectionId: string;
  database?: string;
  schema?: string;
  table: string;
  initialWithData?: boolean;
  onClose: () => void;
}

const ACTIONS: Array<{ key: 'analyze' | 'optimize' | 'check' | 'repair' | 'vacuum'; label: string; hint: string }> = [
  { key: 'analyze', label: '分析统计', hint: '更新优化器统计信息' },
  { key: 'optimize', label: '优化表', hint: '整理碎片 / 重建索引' },
  { key: 'check', label: '检查表', hint: '完整性或一致性检查' },
  { key: 'repair', label: '修复表', hint: '仅部分引擎支持' },
  { key: 'vacuum', label: '回收空间', hint: 'SQLite / PostgreSQL' },
];

export function TableOpsDialog({ kind, connectionId, database, schema, table, initialWithData = true, onClose }: Props) {
  const notify = useApp((s) => s.notify);
  const loadSchema = useApp((s) => s.loadSchema);
  const openData = useApp((s) => s.openData);
  const openQuery = useApp((s) => s.openQuery);

  const [newName, setNewName] = useState(kind === 'rename' ? `${table}_new` : `${table}_copy`);
  const [withData, setWithData] = useState(initialWithData);
  const [ddl, setDdl] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kind !== 'ddl') return;
    setBusy(true);
    setError('');
    api
      .tableOps({ connectionId, database, schema, table, op: 'ddl' })
      .then((res) => {
        if (res.ddl) setDdl(res.ddl);
        else if (res.message) setError(res.message);
        else setDdl(res.statements.join('\n'));
      })
      .catch((err) => setError(err?.message ?? '读取 DDL 失败'))
      .finally(() => setBusy(false));
  }, [kind, connectionId, database, schema, table]);

  const submit = async () => {
    if (!newName.trim()) {
      setError('请填写新表名');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.tableOps({ connectionId, database, schema, table, op: kind, newName: newName.trim(), withData });
      notify('success', kind === 'rename' ? '表已重命名' : '表已复制', newName.trim());
      await loadSchema(connectionId, true);
      if (kind === 'duplicate') openData(connectionId, newName.trim(), database);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const runMaintenance = async (action: (typeof ACTIONS)[number]['key']) => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const res = await api.tableOps({ connectionId, database, schema, table, op: 'maintenance', action });
      if (res.supported === false) {
        setResult(res.message ?? '当前引擎不支持该操作');
      } else {
        setResult(res.batch?.messages?.join('\n') || '执行完成');
        notify('success', '维护完成', action);
      }
    } catch (err: any) {
      setError(err?.message ?? '维护失败');
    } finally {
      setBusy(false);
    }
  };

  const title =
    kind === 'rename' ? `重命名表 · ${table}` : kind === 'duplicate' ? `复制表 · ${table}` : kind === 'maintenance' ? `维护表 · ${table}` : `表 DDL · ${table}`;

  const footer =
    kind === 'ddl' ? (
      <>
        <button className="btn" onClick={onClose}>关闭</button>
        <button
          className="btn"
          onClick={() => void navigator.clipboard.writeText(ddl).then(() => notify('success', '已复制 DDL'))}
          disabled={!ddl}
        >
          <Copy size={12} /> 复制
        </button>
        <button className="btn primary" onClick={() => { openQuery(connectionId, ddl); onClose(); }} disabled={!ddl}>
          <Code2 size={12} /> 在编辑器打开
        </button>
      </>
    ) : kind === 'maintenance' ? (
      <button className="btn" onClick={onClose}>关闭</button>
    ) : (
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy} data-testid="table-op-submit">
          {busy ? <Loader2 size={12} className="spin" /> : null} 确认
        </button>
      </>
    );

  return (
    <Modal title={title} onClose={onClose} footer={footer}>
      {kind === 'rename' || kind === 'duplicate' ? (
        <div className="col gap-10">
          <div className="field">
            <label>{kind === 'rename' ? '新表名' : '新表名'}</label>
            <input className="input mono" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus data-testid="table-op-name" />
          </div>
          {kind === 'duplicate' ? (
            <label className="checkbox">
              <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} /> 同时复制数据（自增列将重新生成）
            </label>
          ) : null}
          {error ? <div className="risk-banner">{error}</div> : null}
        </div>
      ) : kind === 'maintenance' ? (
        <div className="col gap-10">
          <p className="hint" style={{ margin: 0 }}>按当前引擎能力执行；不支持的动作会返回明确提示。</p>
          <div className="ops-actions">
            {ACTIONS.map((action) => (
              <button key={action.key} className="ops-action" onClick={() => void runMaintenance(action.key)} disabled={busy}>
                <Wrench size={14} />
                <span>
                  <strong>{action.label}</strong>
                  <small>{action.hint}</small>
                </span>
                <Play size={11} />
              </button>
            ))}
          </div>
          {result ? <pre className="ddl-block">{result}</pre> : null}
          {error ? <div className="risk-banner">{error}</div> : null}
        </div>
      ) : (
        <div className="col gap-10">
          {busy ? (
            <div className="loading-inline"><span className="spinner" /> 读取 DDL…</div>
          ) : error ? (
            <div className="risk-banner">{error}</div>
          ) : (
            <pre className="ddl-block">{ddl}</pre>
          )}
        </div>
      )}
    </Modal>
  );
}
