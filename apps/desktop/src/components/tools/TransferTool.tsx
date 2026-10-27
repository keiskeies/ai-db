import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, Table2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';

interface TransferResult {
  table: string;
  status: string;
  rows: number;
  created: boolean;
  truncated: boolean;
  error?: string;
}

export function TransferTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const [sourceId, setSourceId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [targetId, setTargetId] = useState(connections.find((c) => c.id !== activeConnectionId)?.id ?? connections[0]?.id ?? '');
  const [tables, setTables] = useState<Array<{ name: string; columns?: number }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<TransferResult[] | null>(null);
  const [summary, setSummary] = useState('');

  useEffect(() => {
    if (!sourceId) return;
    api
      .getTables(sourceId)
      .then((result) => {
        const list = result.tables.filter((table) => table.type === 'table').map((table) => ({ name: table.name, columns: table.columns?.length ?? 0 }));
        setTables(list);
        setSelected(new Set(list.slice(0, 3).map((table) => table.name)));
      })
      .catch(() => setTables([]));
  }, [sourceId]);

  const run = async () => {
    if (!sourceId || !targetId || !selected.size) return;
    if (sourceId === targetId && mode === 'replace') {
      if (!window.confirm('源与目标是同一连接，替换模式会清空目标表后再从自身复制。继续？')) return;
    }
    setRunning(true);
    setResults(null);
    try {
      const { result } = await api.transfer({
        sourceId,
        targetId,
        tables: [...selected],
        mode,
        createMissing: true,
      });
      setResults(result.results);
      setSummary(`传输 ${result.results.length} 张表 · ${result.totalRows} 行 · 新建 ${result.createdTables} 张表`);
      notify('success', '数据传输完成', `${result.totalRows} 行`);
      await loadSchema(targetId, true);
    } catch (err: any) {
      notify('error', '数据传输失败', err?.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Table2 size={15} /> 数据传输
        <span className="muted">跨连接复制表结构与数据，目标缺失表自动创建</span>
      </div>
      <div className="tool-row" style={{ flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <label>源连接</label>
          <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name} · {conn.engine}</option>)}
          </select>
        </div>
        <ArrowRight size={15} className="muted" style={{ alignSelf: 'flex-end', marginBottom: 6 }} />
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <label>目标连接</label>
          <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name} · {conn.engine}{conn.readonly ? '（只读）' : ''}</option>)}
          </select>
        </div>
        <div className="field" style={{ width: 140 }}>
          <label>写入模式</label>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'append' | 'replace')}>
            <option value="append">追加</option>
            <option value="replace">清空后写入</option>
          </select>
        </div>
      </div>

      <div className="transfer-grid">
        <div className="panel">
          <div className="panel-head">
            源表 <span className="badge">{selected.size}/{tables.length}</span>
            <div className="spacer" />
            <button className="btn ghost small" onClick={() => setSelected(new Set(tables.map((table) => table.name)))}>全选</button>
            <button className="btn ghost small" onClick={() => setSelected(new Set())}>清空</button>
          </div>
          <div className="transfer-list">
            {tables.map((table) => (
              <label key={table.name} className="transfer-row">
                <input
                  type="checkbox"
                  checked={selected.has(table.name)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(table.name);
                    else next.delete(table.name);
                    setSelected(next);
                  }}
                />
                <span className="mono">{table.name}</span>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 10 }}>{table.columns} 列</span>
              </label>
            ))}
            {!tables.length ? <div className="dash-empty">源连接没有表。</div> : null}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">结果 <div className="spacer" /> <button className="btn primary small" onClick={() => void run()} disabled={running || !selected.size}>{running ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <ArrowRight size={12} />} 开始传输</button></div>
          <div className="transfer-list">
            {summary ? <div className="tool-summary">{summary}</div> : null}
            {results?.map((result) => (
              <div key={result.table} className="transfer-row">
                <span className={`badge ${result.status === 'ok' ? 'read' : 'destructive'}`}>{result.status}</span>
                <span className="mono">{result.table}</span>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 10 }}>
                  {result.status === 'ok' ? `${result.rows} 行${result.created ? ' · 新建' : result.truncated ? ' · 已清空' : ''}` : result.error}
                </span>
              </div>
            ))}
            {!results ? <div className="dash-empty">选择源表并开始传输。目标表不存在时会按目标方言创建；自增序列在跨库复制后可能需要重置。</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
