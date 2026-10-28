import { useMemo } from 'react';
import type { TableInfo } from '@aidb/core';
import { useApp } from '../store';
import { Modal } from './ui';

interface Props {
  table: TableInfo;
  database?: string;
  onClose: () => void;
  /** 非关系型对象用「集合 / 索引 / 标签」等自己的名词，并省略外键、自增等关系型专属信息。 */
  objectLabel?: string;
  relational?: boolean;
}

export function TableInfoDialog({ table, database, onClose, objectLabel = '表', relational = true }: Props) {
  const t = useApp((s) => s.t);
  const columns = table.columns ?? [];
  const indexes = table.indexes ?? [];
  const foreignKeys = table.foreignKeys ?? [];
  const pk = useMemo(() => columns.filter((column) => column.primaryKey).map((column) => column.name), [columns]);

  return (
    <Modal
      title={`对象信息 · ${table.name}`}
      onClose={onClose}
      wide
      footer={<button className="btn" onClick={onClose}>关闭</button>}
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
          <div className="tool-section-title">列（{columns.length}）</div>
          <div className="mini-table-wrap">
            <table className="tool-table">
              <thead><tr><th>#</th><th>名称</th><th>类型</th><th>可空</th>{relational ? <><th>默认值</th><th>主键</th><th>自增</th></> : <th>主键</th>}</tr></thead>
              <tbody>
                {columns.map((column, index) => (
                  <tr key={column.name}>
                    <td className="muted">{index + 1}</td>
                    <td className="mono">{column.name}</td>
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
          <div className="tool-section-title">索引（{indexes.length}）</div>
          <div className="mini-table-wrap">
            <table className="tool-table">
              <thead><tr><th>名称</th><th>列</th><th>唯一</th>{relational ? <th>主键</th> : <><th>主键</th><th>方法</th><th>说明</th></>}</tr></thead>
              <tbody>
                {indexes.map((index) => (
                  <tr key={index.name}>
                    <td className="mono" data-testid="object-info-index-name">{index.name}</td>
                    <td className="mono">{index.columns.join(', ')}</td>
                    <td>{index.unique ? 'YES' : ''}</td>
                    <td>{index.primary ? 'PK' : ''}</td>
                    {relational ? null : <td className="mono">{index.method ?? '—'}</td>}
                    {relational ? null : <td className="mono">{index.comment ?? '—'}</td>}
                  </tr>
                ))}
                {!indexes.length ? <tr><td colSpan={relational ? 4 : 6} className="muted">无索引</td></tr> : null}
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
        <p className="hint" style={{ margin: 0 }}>{t('readonly')}：对象信息为只读；{relational ? '修改请使用设计表或 SQL 编辑器。' : '修改请使用写入面板或对应的查询语言。'}</p>
      </div>
    </Modal>
  );
}
