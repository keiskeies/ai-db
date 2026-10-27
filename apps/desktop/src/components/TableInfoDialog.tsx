import { useMemo } from 'react';
import type { TableInfo } from '@aidb/core';
import { useApp } from '../store';
import { Modal } from './ui';

interface Props {
  table: TableInfo;
  database?: string;
  onClose: () => void;
}

export function TableInfoDialog({ table, database, onClose }: Props) {
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
          <span>类型</span><strong>{table.type === 'view' ? '视图' : '表'}</strong>
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
              <thead><tr><th>#</th><th>名称</th><th>类型</th><th>可空</th><th>默认值</th><th>主键</th><th>自增</th></tr></thead>
              <tbody>
                {columns.map((column, index) => (
                  <tr key={column.name}>
                    <td className="muted">{index + 1}</td>
                    <td className="mono">{column.name}</td>
                    <td className="mono">{column.type}</td>
                    <td>{column.nullable ? 'YES' : 'NO'}</td>
                    <td className="mono">{column.defaultValue ?? '—'}</td>
                    <td>{column.primaryKey ? 'PK' : ''}</td>
                    <td>{column.autoIncrement ? 'AUTO' : ''}</td>
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
              <thead><tr><th>名称</th><th>列</th><th>唯一</th><th>主键</th></tr></thead>
              <tbody>
                {indexes.map((index) => (
                  <tr key={index.name}>
                    <td className="mono">{index.name}</td>
                    <td className="mono">{index.columns.join(', ')}</td>
                    <td>{index.unique ? 'YES' : ''}</td>
                    <td>{index.primary ? 'PK' : ''}</td>
                  </tr>
                ))}
                {!indexes.length ? <tr><td colSpan={4} className="muted">无索引</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>

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
        <p className="hint" style={{ margin: 0 }}>{t('readonly')}：对象信息为只读；修改请使用设计表或 SQL 编辑器。</p>
      </div>
    </Modal>
  );
}
