import { useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';

/** 单条记录编辑：读回驱动原文（MongoDB 为 EJSON，向量/搜索为 JSON），保存时整体写回。 */
export function DocumentEditDialog({
  connectionId,
  database,
  collection,
  docId,
  onClose,
  onSaved,
}: {
  connectionId: string;
  database?: string;
  collection: string;
  docId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .documentGet({ connectionId, database, collection, id: docId })
      .then(({ detail }) => {
        if (!alive) return;
        setText(JSON.stringify(JSON.parse(detail.document), null, 2));
        setError(null);
      })
      .catch((err: any) => {
        if (alive) setError(err?.message ?? '读取文档失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connectionId, database, collection, docId]);

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('JSON 语法错误，无法保存');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('需要一个 JSON 对象');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.upsertDocuments({ connectionId, database, collection, documents: [parsed as Record<string, unknown>] });
      notify('success', '文档已保存', docId);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '保存失败');
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`编辑记录 · ${collection}`}
      icon={<FileCode2 size={15} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn primary" onClick={() => void save()} disabled={saving || loading} data-testid="doc-edit-save">
            {saving ? <Spinner /> : null} 保存
          </button>
        </>
      }
    >
      {loading ? <Spinner /> : null}
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 6 }} data-testid="doc-edit-error">{error}</div> : null}
      {!loading ? (
        <textarea
          className="textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          style={{ width: '100%', minHeight: 320, fontFamily: 'var(--font-mono)', fontSize: 12 }}
          data-testid="doc-edit-json"
        />
      ) : null}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        保存会整体替换 <code>{docId}</code> 这条文档；删除字段即从文档里移除它。
      </div>
    </Modal>
  );
}
