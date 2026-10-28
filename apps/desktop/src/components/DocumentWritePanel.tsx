import { useEffect, useMemo, useState } from 'react';
import { FilePlus } from 'lucide-react';
import type { ConnectionConfig } from '@aidb/core';
import { engineMeta } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';

const TEMPLATES: Record<string, Record<string, unknown>> = {
  qdrant: { id: 1, vector: [0.1, 0.2, 0.3], payload: { title: 'hello' } },
  weaviate: { properties: { title: 'hello' }, vector: [0.1, 0.2, 0.3] },
  milvus: { id: 1, vector: [0.1, 0.2, 0.3], title: 'hello' },
  elasticsearch: { title: 'hello', body: 'indexed from AiDB' },
  opensearch: { title: 'hello', body: 'indexed from AiDB' },
};

function templateFor(engine: string): Record<string, unknown> {
  return TEMPLATES[engine] ?? { title: 'hello' };
}

export function DocumentWritePanel({
  connection,
  database,
  initialCollection,
  onClose,
  onDone,
}: {
  connection: ConnectionConfig;
  database?: string;
  initialCollection?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const schemas = useApp((s) => s.schemas[connection.id]);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const meta = engineMeta(connection.engine);
  const isSearch = meta.model === 'search';
  const tables = useMemo(() => (schemas ?? []).flatMap((schema) => schema.tables), [schemas]);
  const [collection, setCollection] = useState(initialCollection ?? '');
  const [id, setId] = useState('');
  const [text, setText] = useState(() => JSON.stringify(templateFor(connection.engine), null, 2));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSchema(connection.id, false, isSearch ? 'default' : database);
  }, [connection.id, database, isSearch, loadSchema]);

  useEffect(() => {
    if (!collection && initialCollection) setCollection(initialCollection);
  }, [collection, initialCollection]);

  const submit = async () => {
    setError(null);
    if (!collection.trim()) {
      setError('请选择或填写集合名');
      return;
    }
    let document: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
      document = parsed as Record<string, unknown>;
    } catch (err: any) {
      setError(`JSON 解析失败：${err?.message ?? '格式错误'}`);
      return;
    }
    setRunning(true);
    try {
      const { result } = await api.upsertDocument({
        connectionId: connection.id,
        database: isSearch ? undefined : database,
        collection: collection.trim(),
        id: id.trim() || undefined,
        document,
      });
      notify('success', '写入成功', result.id ? `${collection} · ${result.id}` : collection);
      onDone?.();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '写入失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`写入${isSearch ? '文档' : '向量点'}`}
      icon={<FilePlus size={15} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={running} data-testid="document-write-submit">
            {running ? <Spinner /> : null} 写入
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>集合 / 索引</label>
        <input
          list={`document-write-collections-${connection.id}`}
          value={collection}
          onChange={(event) => setCollection(event.target.value)}
          placeholder={isSearch ? '例如 logs' : '例如 docs'}
          data-testid="document-write-collection"
        />
        <datalist id={`document-write-collections-${connection.id}`}>
          {tables.map((table) => (
            <option key={table.name} value={table.name} />
          ))}
        </datalist>
        <label>ID（可选）</label>
        <input value={id} onChange={(event) => setId(event.target.value)} placeholder="留空则由服务端生成" data-testid="document-write-id" />
      </div>
      <div className="muted" style={{ fontSize: 11, margin: '10px 0 6px' }}>
        {isSearch
          ? '输入要索引的 JSON 文档；指定 ID 时覆盖同 ID 文档。'
          : connection.engine === 'qdrant'
            ? '需要 vector 与可选 payload；Qdrant 的 id 必须是整数或 UUID。'
            : connection.engine === 'weaviate'
              ? 'properties 为对象属性，vector 可选；指定 ID 时覆盖同 ID 对象。'
              : '按集合 schema 提供字段；向量库需要 vector 字段。'}
      </div>
      <textarea
        className="textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        style={{ width: '100%', minHeight: 220, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
        data-testid="document-write-json"
      />
      {error ? <div className="error-text" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }} data-testid="document-write-error">{error}</div> : null}
    </Modal>
  );
}
