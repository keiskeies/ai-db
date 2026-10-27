import { useState } from 'react';
import { ArrowLeftRight, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';

export function DataCompareTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const [sourceId, setSourceId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [targetId, setTargetId] = useState(connections.find((c) => c.id !== activeConnectionId)?.id ?? connections[0]?.id ?? '');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const compare = async () => {
    setLoading(true);
    setResult(null);
    setSelected(new Set());
    try {
      const { result: compared } = await api.compareData({ sourceId, targetId });
      setResult(compared);
      setSelected(new Set(compared.rows.filter((row: any) => row.status === 'different').map((row: any) => row.table)));
    } catch (err: any) {
      notify('error', '数据对比失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  const sync = async () => {
    if (!selected.size) return;
    if (!window.confirm(`将用源数据替换目标中 ${selected.size} 张表（清空后写入），确认继续？`)) return;
    setLoading(true);
    try {
      const { result: transferred } = await api.transfer({ sourceId, targetId, tables: [...selected], mode: 'replace', createMissing: true });
      notify('success', '数据同步完成', `${transferred.totalRows} 行`);
      await compare();
    } catch (err: any) {
      notify('error', '同步失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <ArrowLeftRight size={15} /> 数据对比
        <span className="muted">行数与表存在性对比；可直接替换同步</span>
      </div>
      <div className="tool-row">
        <div className="field" style={{ flex: 1, minWidth: 160 }}>
          <label>源连接</label>
          <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 160 }}>
          <label>目标连接</label>
          <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name}</option>)}
          </select>
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={() => void compare()} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={12} />} 对比
        </button>
      </div>
      <div className="tool-scroll">
        {!result ? (
          <div className="dash-empty">选择源/目标连接后对比各表行数与存在性。差异表可勾选后使用“替换同步”（清空目标表并复制源数据）。</div>
        ) : (
          <>
            <div className="tool-summary">
              {result.source} → {result.target} · 相同 {result.same} · 不同 {result.different} · 缺失 {result.missing}
            </div>
            <div className="panel">
              <div className="panel-head">表 <span className="badge">{result.rows.length}</span><div className="spacer" /><span className="muted">已选 {selected.size}</span></div>
              <div className="transfer-list">
                {result.rows.map((row: any) => (
                  <label key={row.table} className="transfer-row">
                    <input
                      type="checkbox"
                      checked={selected.has(row.table)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(row.table);
                        else next.delete(row.table);
                        setSelected(next);
                      }}
                      disabled={row.status === 'same' || row.status === 'missing'}
                    />
                    <span className={`badge ${row.status === 'same' ? 'read' : row.status === 'different' ? 'write' : row.status === 'missing' ? 'destructive' : ''}`}>{row.status}</span>
                    <span className="mono">{row.table}</span>
                    <span className="spacer" />
                    <span className="muted" style={{ fontSize: 10 }}>
                      {row.status === 'missing' ? '目标缺少表' : `${row.sourceRows.toLocaleString()} → ${row.targetRows?.toLocaleString?.() ?? '?'}`}
                      {row.error ? ` · ${row.error}` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn primary" onClick={() => void sync()} disabled={!selected.size || loading}>
                <ArrowLeftRight size={12} /> 替换同步所选（{selected.size}）
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
