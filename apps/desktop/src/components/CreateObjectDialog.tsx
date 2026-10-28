import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ConnectionConfig } from '@aidb/core';
import { engineMeta } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';

const ES_TYPES = ['text', 'keyword', 'boolean', 'integer', 'long', 'float', 'double', 'date', 'ip', 'nested', 'object'];
const WEAVIATE_TYPES = ['text', 'int', 'number', 'boolean', 'date'];

export function CreateObjectDialog({
  connection,
  database,
  onClose,
}: {
  connection: ConnectionConfig;
  database?: string;
  onClose: () => void;
}) {
  const meta = engineMeta(connection.engine);
  const isVector = meta.model === 'vector';
  const isSearch = meta.model === 'search';
  const isDocument = meta.model === 'document';
  const isAql = meta.languages.includes('aql');
  const plainFields = !isVector && !isDocument && !isAql;
  const notify = useApp((s) => s.notify);
  const loadSchema = useApp((s) => s.loadSchema);
  const [name, setName] = useState('');
  const [dimension, setDimension] = useState('384');
  const [distance, setDistance] = useState('Cosine');
  const [edge, setEdge] = useState(false);
  const [fields, setFields] = useState<Array<{ name: string; type: string }>>(
    isSearch ? [{ name: 'message', type: 'text' }] : [{ name: 'title', type: 'text' }],
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('名称不能为空');
      return;
    }
    if (isVector && (!Number(dimension) || Number(dimension) < 1)) {
      setError('向量维度需要大于 0');
      return;
    }
    setRunning(true);
    try {
      const { result } = await api.createObject({
        connectionId: connection.id,
        database,
        name: name.trim(),
        dimension: isVector ? Number(dimension) : undefined,
        distance: isVector ? distance : undefined,
        edge: isAql ? edge : undefined,
        fields: plainFields ? fields.filter((field) => field.name.trim()) : [],
      });
      notify('success', result.kind === 'index' ? '索引已创建' : '集合已创建', result.name);
      onClose();
      void loadSchema(connection.id, true, database).catch(() => undefined);
    } catch (err: any) {
      setError(err?.message ?? '创建失败');
    } finally {
      setRunning(false);
    }
  };

  const typeOptions = connection.engine === 'weaviate' ? WEAVIATE_TYPES : isSearch ? ES_TYPES : WEAVIATE_TYPES;

  return (
    <Modal
      title={`新建${isSearch ? '索引' : '集合'}`}
      icon={<Plus size={15} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={running} data-testid="create-object-submit">
            {running ? <Spinner /> : null} 创建
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>{isSearch ? '索引名' : connection.engine === 'weaviate' ? 'class 名' : '集合名'}</label>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={isSearch ? 'logs-2026' : 'documents'}
          autoFocus
          data-testid="create-object-name"
        />
        {isVector ? (
          <>
            <label>向量维度</label>
            <input
              className="input"
              value={dimension}
              onChange={(event) => setDimension(event.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              data-testid="create-object-dimension"
            />
            {connection.engine === 'qdrant' ? (
              <>
                <label>距离函数</label>
                <select className="select" value={distance} onChange={(event) => setDistance(event.target.value)} data-testid="create-object-distance">
                  <option value="Cosine">Cosine</option>
                  <option value="Euclid">Euclid</option>
                  <option value="Dot">Dot</option>
                  <option value="Manhattan">Manhattan</option>
                </select>
              </>
            ) : null}
          </>
        ) : null}
        {isAql ? (
          <>
            <label>集合类型</label>
            <select
              className="select"
              value={edge ? 'edge' : 'document'}
              onChange={(event) => setEdge(event.target.value === 'edge')}
              data-testid="create-object-kind"
            >
              <option value="document">文档集合</option>
              <option value="edge">边集合</option>
            </select>
          </>
        ) : null}
      </div>
      {plainFields ? (
        <>
          <div className="muted" style={{ fontSize: 11, margin: '12px 0 6px' }}>
            字段（{connection.engine === 'weaviate' ? 'Weaviate 属性' : 'ES mapping'}）
          </div>
          {fields.map((field, index) => (
            <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={field.name}
                placeholder="字段名"
                onChange={(event) => {
                  const next = [...fields];
                  next[index] = { ...next[index], name: event.target.value };
                  setFields(next);
                }}
                data-testid={`create-object-field-${index}`}
              />
              <select
                className="select"
                style={{ width: 130 }}
                value={field.type}
                onChange={(event) => {
                  const next = [...fields];
                  next[index] = { ...next[index], type: event.target.value };
                  setFields(next);
                }}
              >
                {typeOptions.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <button className="icon-btn" title="删除字段" onClick={() => setFields(fields.filter((_, i) => i !== index))}>
                ×
              </button>
            </div>
          ))}
          <button
            className="btn small"
            onClick={() => setFields([...fields, { name: '', type: typeOptions[0] }])}
            data-testid="create-object-add-field"
          >
            <Plus size={12} /> 添加字段
          </button>
        </>
      ) : null}
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }} data-testid="create-object-error">{error}</div> : null}
    </Modal>
  );
}
