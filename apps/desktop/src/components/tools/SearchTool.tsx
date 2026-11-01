import { useMemo, useState } from 'react';
import { FileSearch, Loader2, Search } from 'lucide-react';
import { applyCapabilityDefaults, CAPABILITIES, getCapability, type Capability } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';
import { CapabilityForm } from './CapabilityForm';

interface ObjectMatch {
  kind: string;
  table: string;
  column?: string;
  detail?: string;
}
interface DataMatch {
  table: string;
  columns: string[];
  rows: unknown[][];
}

export function SearchTool() {
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const connections = useApp((s) => s.connections);
  const openData = useApp((s) => s.openData);
  const closeTools = useApp((s) => s.closeTools);
  const notify = useApp((s) => s.notify);
  const capability = useMemo<Capability>(() => getCapability('search') ?? CAPABILITIES[0], []);
  const [values, setValues] = useState<Record<string, unknown>>(() => applyCapabilityDefaults(capability));
  const query = String(values.query ?? '');
  const database = String(values.database ?? '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ objects: ObjectMatch[]; data: DataMatch[]; scannedTables: number } | null>(null);
  const conn = connections.find((c) => c.id === activeConnectionId);

  const run = async () => {
    if (!activeConnectionId) {
      notify('warning', '请先选择连接');
      return;
    }
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await api.searchDatabase({
        connectionId: activeConnectionId,
        database: database || undefined,
        query,
        scope: (values.scope as 'all' | 'objects' | 'data') ?? 'all',
      });
      setResult(res);
    } catch (err: any) {
      notify('error', '搜索失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <FileSearch size={15} /> 数据库搜索
        <span className="muted">对象名称、注释与文本列内容</span>
      </div>
      <div className="tool-row">
        <div className="search-box" style={{ flex: 1 }}>
          <Search size={13} />
          <input value={query} onChange={(e) => setValues((current) => ({ ...current, query: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && void run()} placeholder="表名、列名或任意文本…" autoFocus />
        </div>
        <CapabilityForm
          capability={capability}
          values={values}
          onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
          connectionId={activeConnectionId ?? undefined}
          disabled={loading}
          testIdPrefix="search"
          // 关键词由上面的 search-box 承载，这里只渲染「库 / 范围」两个下拉
          omit={['query']}
        />
        <button className="btn primary" onClick={() => void run()} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Search size={12} />} 搜索
        </button>
      </div>
      <div className="tool-scroll">
        {result ? (
          <>
            <div className="tool-summary">
              扫描 {result.scannedTables} 张表 · 对象 {result.objects.length} · 数据命中 {result.data.length}
            </div>
            {result.objects.length ? (
              <div className="tool-section">
                <div className="tool-section-title">对象</div>
                {result.objects.map((item, index) => (
                  <button
                    key={`${item.table}_${item.column ?? ''}_${index}`}
                    className="result-row"
                    onClick={() => {
                      openData(activeConnectionId!, item.table, database || conn?.database);
                      closeTools();
                    }}
                  >
                    <span className={`badge ${item.kind === 'column' ? 'ddl' : 'read'}`}>{item.kind}</span>
                    <span className="mono">{item.table}</span>
                    {item.column ? <span className="mono muted">.{item.column}</span> : null}
                    <span className="spacer" />
                    <span className="muted" style={{ fontSize: 10 }}>{item.detail ?? ''}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {result.data.length ? (
              <div className="tool-section">
                <div className="tool-section-title">数据命中</div>
                {result.data.map((match) => (
                  <div key={match.table} className="data-match">
                    <div className="tool-row" style={{ marginBottom: 4 }}>
                      <span className="badge agent">rows</span>
                      <strong className="mono">{match.table}</strong>
                      <span className="muted" style={{ fontSize: 10 }}>{match.rows.length} 行</span>
                      <span className="spacer" />
                      <button className="btn ghost small" onClick={() => { openData(activeConnectionId!, match.table, database || conn?.database); closeTools(); }}>
                        打开表
                      </button>
                    </div>
                    <div className="mini-table-wrap">
                      <table className="tool-table">
                        <thead><tr>{match.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                        <tbody>
                          {match.rows.slice(0, 4).map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {row.map((value, index) => (
                                <td key={index} title={String(value)}>{value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value).slice(0, 80)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {!result.objects.length && !result.data.length ? <div className="dash-empty">没有匹配结果。</div> : null}
          </>
        ) : (
          <div className="dash-empty">输入关键词，跨表搜索表名、列名、注释与文本内容（最多扫描 25 张表）。</div>
        )}
      </div>
    </div>
  );
}
