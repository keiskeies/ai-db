import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ConnectionConfig } from '@aidb/core';
import { engineMeta, fieldTypeOptions } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Option, Select, Spinner } from './ui';
import { t as tr } from '../i18n';

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
      setError(tr("名称不能为空"));
      return;
    }
    if (isVector && (!Number(dimension) || Number(dimension) < 1)) {
      setError(tr("向量维度需要大于 0"));
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
      notify('success', result.kind === 'index' ? tr("索引已创建") : tr("集合已创建"), result.name);
      onClose();
      void loadSchema(connection.id, true, database).catch(() => undefined);
    } catch (err: any) {
      setError(err?.message ?? tr("创建失败"));
    } finally {
      setRunning(false);
    }
  };

  const engineTypes = fieldTypeOptions(connection.engine);
  const typeOptions = engineTypes.length ? engineTypes : ['text'];

  return (
    <Modal
      title={tr("新建{0}", [isSearch ? tr("索引") : tr("集合")])}
      icon={<Plus size={15} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>{tr("取消")}</button>
          <button className="btn primary" onClick={() => void submit()} disabled={running} data-testid="create-object-submit">
            {running ? <Spinner /> : null}{tr(" 创建 ")}</button>
        </>
      }
    >
      <div className="form-grid">
        <label>{isSearch ? tr("索引名") : connection.engine === 'weaviate' ? tr("class 名") : tr("集合名")}</label>
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
            <label>{tr("向量维度")}</label>
            <input
              className="input"
              value={dimension}
              onChange={(event) => setDimension(event.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              data-testid="create-object-dimension"
            />
            {connection.engine === 'qdrant' ? (
              <>
                <label>{tr("距离函数")}</label>
                <Select className="select" value={distance} onChange={(event) => setDistance(event.target.value)} data-testid="create-object-distance">
                  <Option value="Cosine">Cosine</Option>
                  <Option value="Euclid">Euclid</Option>
                  <Option value="Dot">Dot</Option>
                  <Option value="Manhattan">Manhattan</Option>
                </Select>
              </>
            ) : null}
          </>
        ) : null}
        {isAql ? (
          <>
            <label>{tr("集合类型")}</label>
            <Select
              className="select"
              value={edge ? 'edge' : 'document'}
              onChange={(event) => setEdge(event.target.value === 'edge')}
              data-testid="create-object-kind"
            >
              <Option value="document">{tr("文档集合")}</Option>
              <Option value="edge">{tr("边集合")}</Option>
            </Select>
          </>
        ) : null}
      </div>
      {plainFields ? (
        <>
          <div className="muted" style={{ fontSize: 11, margin: '12px 0 6px' }}>
            {tr(" 字段（")}{connection.engine === 'weaviate' ? tr("Weaviate 属性") : 'ES mapping'}）
          </div>
          {fields.map((field, index) => (
            <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input
                className="input grow"
                value={field.name}
                placeholder={tr("字段名")}
                onChange={(event) => {
                  const next = [...fields];
                  next[index] = { ...next[index], name: event.target.value };
                  setFields(next);
                }}
                data-testid={`create-object-field-${index}`}
              />
              <Select
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
                  <Option key={type} value={type}>
                    {type}
                  </Option>
                ))}
              </Select>
              <button className="icon-btn" title={tr("删除字段")} onClick={() => setFields(fields.filter((_, i) => i !== index))}>
                ×
              </button>
            </div>
          ))}
          <button
            className="btn small"
            onClick={() => setFields([...fields, { name: '', type: typeOptions[0] }])}
            data-testid="create-object-add-field"
          >
            <Plus size={12} /> {tr(" 添加字段 ")}</button>
        </>
      ) : null}
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }} data-testid="create-object-error">{error}</div> : null}
    </Modal>
  );
}
