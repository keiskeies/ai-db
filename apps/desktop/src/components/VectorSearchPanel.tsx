import { useEffect, useMemo, useState } from 'react';
import { Database, Play, Sparkles } from 'lucide-react';
import type { ConnectionConfig, QueryResult, TableInfo } from '@aidb/core';
import { engineMeta } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { DataGrid } from './DataGrid';
import { Modal, Spinner } from './ui';

export function VectorSearchPanel({
  connection,
  database,
  onClose,
}: {
  connection: ConnectionConfig;
  database?: string;
  onClose: () => void;
}) {
  const schemas = useApp((s) => s.schemas[connection.id]);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const isPg = engineMeta(connection.engine).dialect === 'postgres';
  const tables = useMemo(() => (schemas ?? []).flatMap((schema) => schema.tables), [schemas]);
  const candidates = useMemo(
    () => (isPg ? tables.filter((table) => (table.columns ?? []).some((column) => /^vector/i.test(column.type))) : tables),
    [isPg, tables],
  );
  const [collection, setCollection] = useState('');
  const [field, setField] = useState('');
  const [text, setText] = useState('');
  const [vectorText, setVectorText] = useState('');
  const [topK, setTopK] = useState(5);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected: TableInfo | undefined = candidates.find((table) => table.name === collection);
  const vectorColumns = (selected?.columns ?? []).filter((column) => /^vector/i.test(column.type));

  useEffect(() => {
    void loadSchema(connection.id, false, isPg ? database : 'default');
  }, [connection.id, database, isPg, loadSchema]);

  useEffect(() => {
    if (!candidates.length) {
      setCollection('');
      return;
    }
    if (!candidates.some((table) => table.name === collection)) {
      setCollection(candidates[0].name);
    }
  }, [candidates, collection]);

  useEffect(() => {
    if (!isPg) return;
    if (vectorColumns.length && !vectorColumns.some((column) => column.name === field)) {
      setField(vectorColumns[0].name);
    }
  }, [field, isPg, vectorColumns]);

  const run = async () => {
    if (!collection) {
      notify('warning', '请选择集合/表');
      return;
    }
    let vector: number[] | undefined;
    if (vectorText.trim()) {
      try {
        const parsed = JSON.parse(vectorText);
        if (!Array.isArray(parsed) || !parsed.length || parsed.some((value) => !Number.isFinite(Number(value)))) {
          throw new Error('向量必须是数字数组');
        }
        vector = parsed.map((value) => Number(value));
      } catch (err: any) {
        setError(err?.message ?? '向量 JSON 不合法');
        return;
      }
    }
    if (!vector && !text.trim()) {
      setError('请输入文本（需配置 Embedding）或向量 JSON');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const { result: found } = await api.vectorSearch({
        connectionId: connection.id,
        database,
        collection,
        field: field.trim() || undefined,
        vector,
        text: text.trim() || undefined,
        topK,
      });
      setResult(found);
    } catch (err: any) {
      setError(err?.message ?? '向量检索失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="向量检索"
      icon={<Sparkles size={15} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn primary" onClick={() => void run()} disabled={running || !collection} data-testid="vector-search-run">
            {running ? <Spinner /> : <Play size={12} />} 检索
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label>{isPg ? '表' : '集合'}</label>
          <select className="select" value={collection} onChange={(e) => setCollection(e.target.value)} data-testid="vector-search-collection">
            {candidates.map((table) => (
              <option key={table.name} value={table.name}>{table.name}</option>
            ))}
          </select>
          {!candidates.length ? <span className="hint">{isPg ? '当前库没有 vector 列；请先安装 pgvector 并创建 vector 列。' : '没有可用的集合。'}</span> : null}
        </div>
        <div className="field">
          <label>向量字段 {isPg ? '（必填）' : '（命名向量，可留空）'}</label>
          {isPg ? (
            <select className="select" value={field} onChange={(e) => setField(e.target.value)} data-testid="vector-search-field">
              {vectorColumns.map((column) => (
                <option key={column.name} value={column.name}>{column.name} · {column.type}</option>
              ))}
            </select>
          ) : (
            <input className="input mono" value={field} onChange={(e) => setField(e.target.value)} placeholder="如 image_vector" data-testid="vector-search-field" />
          )}
        </div>
        <div className="field">
          <label>Top K</label>
          <input className="input" type="number" min={1} max={1000} value={topK} onChange={(e) => setTopK(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} data-testid="vector-search-topk" />
        </div>
        <div className="field full">
          <label>查询文本（走 Embedding）</label>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：与退款政策相关的段落" data-testid="vector-search-text" />
          <span className="hint">在设置 → 向量检索（Embedding）中配置服务；也可以直接填入向量 JSON。</span>
        </div>
        <div className="field full">
          <label>向量 JSON（可选，优先于文本）</label>
          <textarea className="input mono" rows={3} value={vectorText} onChange={(e) => setVectorText(e.target.value)} placeholder="[0.12, -0.03, 0.88, ...]" data-testid="vector-search-vector" />
        </div>
        {error ? <div className="field full"><span className="hint" style={{ color: 'var(--danger, #f16b62)' }}>{error}</span></div> : null}
      </div>
      {result ? (
        <div style={{ marginTop: 12 }}>
          <div className="row gap-4" style={{ marginBottom: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
            <Database size={12} /> {result.rowCount} 条结果 · {result.durationMs}ms
          </div>
          <DataGrid columns={result.columns} rows={result.rows} testId="vector-result-grid" />
        </div>
      ) : null}
    </Modal>
  );
}
