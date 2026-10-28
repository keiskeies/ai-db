import { useMemo, useState } from 'react';
import type { Engine, TableInfo } from '@aidb/core';
import { fieldTypeOptions } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';

interface Props {
  table: TableInfo;
  database?: string;
  onClose: () => void;
  /** 非关系型对象用「集合 / 索引 / 标签」等自己的名词，并省略外键、自增等关系型专属信息。 */
  objectLabel?: string;
  relational?: boolean;
  /** 连接 id + 该引擎支持索引管理时，索引区直接可建删。 */
  connectionId?: string;
  manageIndexes?: boolean;
  canAddField?: boolean;
  engine?: Engine;
}

export function TableInfoDialog({
  table,
  database,
  onClose,
  objectLabel = '表',
  relational = true,
  connectionId,
  manageIndexes = false,
  canAddField = false,
  engine,
}: Props) {
  const t = useApp((s) => s.t);
  const notify = useApp((s) => s.notify);
  const loadSchema = useApp((s) => s.loadSchema);
  const columns = table.columns ?? [];
  const indexes = table.indexes ?? [];
  const foreignKeys = table.foreignKeys ?? [];
  const pk = useMemo(() => columns.filter((column) => column.primaryKey).map((column) => column.name), [columns]);
  const singleField = engine === 'qdrant';
  const mongoOptions = engine === 'mongodb';
  const [creating, setCreating] = useState(false);
  const [fields, setFields] = useState('');
  const [indexName, setIndexName] = useState('');
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttl, setTtl] = useState('');
  const [payloadType, setPayloadType] = useState('keyword');
  const [addingField, setAddingField] = useState(false);
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState('');
  const fieldTypes = engine ? fieldTypeOptions(engine) : [];
  const [pendingDrop, setPendingDrop] = useState<string | null>(null);
  const [dropTyped, setDropTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = (title: string, detail: string) => {
    notify('success', title, detail);
    if (connectionId) void loadSchema(connectionId, true, database).catch(() => undefined);
    onClose();
  };

  const submitCreate = async () => {
    if (!connectionId) return;
    const parsed = singleField ? [fields.trim()] : fields.split(',').map((column) => column.trim()).filter(Boolean);
    if (!parsed.length || parsed.some((column) => !column)) {
      setError(singleField ? '请填写一个字段名' : '至少填写一个字段');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { result } = await api.createIndex({
        connectionId,
        database,
        collection: table.name,
        columns: parsed,
        name: mongoOptions ? indexName.trim() || undefined : undefined,
        unique: mongoOptions ? unique : undefined,
        sparse: mongoOptions ? sparse : undefined,
        expireAfterSeconds: mongoOptions && Number(ttl) > 0 ? Math.floor(Number(ttl)) : undefined,
        type: singleField ? payloadType : undefined,
      });
      done('索引已创建', result.name);
    } catch (err: any) {
      setError(err?.message ?? '创建索引失败');
      setBusy(false);
    }
  };

  const submitDrop = async (name: string) => {
    if (!connectionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.dropIndex({ connectionId, database, collection: table.name, name });
      done('索引已删除', name);
    } catch (err: any) {
      setError(err?.message ?? '删除索引失败');
      setBusy(false);
      setPendingDrop(null);
      setDropTyped('');
    }
  };

  const submitField = async () => {
    if (!connectionId) return;
    const name = fieldName.trim();
    if (!name) {
      setError('字段名不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { result } = await api.createField({
        connectionId,
        database,
        object: table.name,
        name,
        type: fieldType || fieldTypes[0] || 'text',
      });
      done('字段已追加', `${result.name} · ${result.type}`);
    } catch (err: any) {
      setError(err?.message ?? '追加字段失败');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`对象信息 · ${table.name}`}
      onClose={onClose}
      wide
      footer={<button className="btn" onClick={onClose} disabled={busy}>关闭</button>}
    >
      <div className="col gap-12">
        <div className="info-grid">
          <span>类型</span><strong>{table.type === 'view' ? '视图' : objectLabel}</strong>
          <span>数据库</span><strong>{database ?? '—'}</strong>
          <span>Schema</span><strong>{table.schema ?? '—'}</strong>
          <span>行数估计</span><strong>{table.rowEstimate ?? '—'}</strong>
          <span>主键</span><strong className="mono">{pk.length ? pk.join(', ') : '无'}</strong>
          <span>注释</span><strong>{table.comment ?? '—'}</strong>
        </div>

        <div>
          <div className="tool-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>列（{columns.length}）</span>
            {canAddField ? (
              <button
                className="btn small"
                onClick={() => {
                  setAddingField((prev) => !prev);
                  setError(null);
                }}
                disabled={busy}
                data-testid="create-field-open"
              >
                新建字段…
              </button>
            ) : null}
          </div>
          {canAddField && addingField ? (
            <div className="form-grid" style={{ marginBottom: 8 }} data-testid="create-field-form">
              <label>字段名</label>
              <input className="input" value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="message" data-testid="field-name" />
              <label>类型</label>
              <select className="select" value={fieldType || fieldTypes[0] || 'text'} onChange={(event) => setFieldType(event.target.value)} data-testid="field-type">
                {fieldTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <label />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={() => void submitField()} disabled={busy} data-testid="field-submit">
                  {busy ? <Spinner /> : null} 追加
                </button>
                <button className="btn" onClick={() => setAddingField(false)} disabled={busy}>
                  取消
                </button>
              </div>
            </div>
          ) : null}
          <div className="mini-table-wrap">
            <table className="tool-table">
              <thead><tr><th>#</th><th>名称</th><th>类型</th><th>可空</th>{relational ? <><th>默认值</th><th>主键</th><th>自增</th></> : <th>主键</th>}</tr></thead>
              <tbody>
                {columns.map((column, index) => (
                  <tr key={column.name}>
                    <td className="muted">{index + 1}</td>
                    <td className="mono" data-testid="object-info-column-name">{column.name}</td>
                    <td className="mono">{column.type}</td>
                    <td>{column.nullable ? 'YES' : 'NO'}</td>
                    {relational ? <td className="mono">{column.defaultValue ?? '—'}</td> : null}
                    <td>{column.primaryKey ? 'PK' : ''}</td>
                    {relational ? <td>{column.autoIncrement ? 'AUTO' : ''}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="tool-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>索引（{indexes.length}）</span>
            {manageIndexes ? (
              <button className="btn small" onClick={() => { setCreating((prev) => !prev); setError(null); }} disabled={busy} data-testid="create-index-open">
                新建索引…
              </button>
            ) : null}
          </div>
          {manageIndexes && creating ? (
            <div className="form-grid" style={{ marginBottom: 8 }} data-testid="create-index-form">
              <label>{singleField ? 'payload 字段' : '字段（逗号分隔）'}</label>
              <input className="input" value={fields} onChange={(event) => setFields(event.target.value)} placeholder={singleField ? 'weight' : 'weight, name'} data-testid="index-fields" />
              {singleField ? (
                <>
                  <label>索引类型</label>
                  <select className="select" value={payloadType} onChange={(event) => setPayloadType(event.target.value)} data-testid="index-type">
                    {['keyword', 'integer', 'float', 'text', 'bool', 'geo'].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </>
              ) : mongoOptions ? (
                <>
                  <label>索引名</label>
                  <input className="input" value={indexName} onChange={(event) => setIndexName(event.target.value)} placeholder="留空自动生成" data-testid="index-name" />
                  <label>TTL（秒）</label>
                  <input className="input" value={ttl} onChange={(event) => setTtl(event.target.value.replace(/\D/g, ''))} placeholder="留空则不过期" data-testid="index-ttl" />
                  <label>选项</label>
                  <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="checkbox" checked={unique} onChange={(event) => setUnique(event.target.checked)} data-testid="index-unique" /> 唯一
                    </label>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="checkbox" checked={sparse} onChange={(event) => setSparse(event.target.checked)} data-testid="index-sparse" /> 稀疏
                    </label>
                  </div>
                </>
              ) : null}
              <label />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={() => void submitCreate()} disabled={busy} data-testid="index-submit">
                  {busy ? <Spinner /> : null} 创建
                </button>
                <button className="btn" onClick={() => setCreating(false)} disabled={busy}>取消</button>
              </div>
            </div>
          ) : null}
          <div className="mini-table-wrap">
            <table className="tool-table">
              <thead>
                <tr>
                  <th>名称</th><th>列</th><th>唯一</th>
                  {relational ? <th>主键</th> : <><th>主键</th><th>方法</th><th>说明</th></>}
                  {manageIndexes ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {indexes.map((index) => (
                  <tr key={index.name}>
                    <td className="mono" data-testid="object-info-index-name">{index.name}</td>
                    <td className="mono">{index.columns.join(', ')}</td>
                    <td>{index.unique ? 'YES' : ''}</td>
                    <td>{index.primary ? 'PK' : ''}</td>
                    {relational ? null : <td className="mono">{index.method ?? '—'}</td>}
                    {relational ? null : <td className="mono">{index.comment ?? '—'}</td>}
                    {manageIndexes ? (
                      <td>
                        {index.primary ? (
                          <span className="muted" style={{ fontSize: 11 }}>主键不可删</span>
                        ) : pendingDrop === index.name ? (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              className="input"
                              style={{ width: 140 }}
                              value={dropTyped}
                              placeholder={`输入 ${index.name}`}
                              onChange={(event) => setDropTyped(event.target.value)}
                              data-testid="index-drop-confirm"
                            />
                            <button
                              className="btn small danger"
                              onClick={() => void submitDrop(index.name)}
                              disabled={busy || dropTyped.trim() !== index.name}
                              data-testid="index-drop-submit"
                            >
                              确认删除
                            </button>
                            <button className="btn small" onClick={() => { setPendingDrop(null); setDropTyped(''); }} disabled={busy}>
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            className="btn small"
                            onClick={() => { setPendingDrop(index.name); setDropTyped(''); setError(null); }}
                            disabled={busy}
                            data-testid="index-drop-open"
                          >
                            删除
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
                {!indexes.length ? (
                  <tr><td colSpan={(relational ? 4 : 6) + (manageIndexes ? 1 : 0)} className="muted">无索引</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {relational ? (
        <div>
          <div className="tool-section-title">外键（{foreignKeys.length}）</div>
          <div className="mini-table-wrap">
            <table className="tool-table">
              <thead><tr><th>名称</th><th>列</th><th>引用</th><th>删除规则</th></tr></thead>
              <tbody>
                {foreignKeys.map((fk, index) => (
                  <tr key={fk.name ?? index}>
                    <td className="mono">{fk.name ?? '—'}</td>
                    <td className="mono">{fk.columns.join(', ')}</td>
                    <td className="mono">{fk.refTable} ({fk.refColumns.join(', ')})</td>
                    <td>{fk.onDelete ?? '—'}</td>
                  </tr>
                ))}
                {!foreignKeys.length ? <tr><td colSpan={4} className="muted">无外键</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
        ) : null}
        {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }} data-testid="index-error">{error}</div> : null}
        <p className="hint" style={{ margin: 0 }}>
          {manageIndexes
            ? '索引在此直接创建与删除；建索引需要扫描整个集合，大集合上先在测试库验证。'
            : `${t('readonly')}：对象信息为只读；${relational ? '修改请使用设计表或 SQL 编辑器。' : '修改请使用写入面板或对应的查询语言。'}`}
        </p>
      </div>
    </Modal>
  );
}
