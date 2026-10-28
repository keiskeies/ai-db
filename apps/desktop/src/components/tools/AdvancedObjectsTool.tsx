import { useEffect, useState } from 'react';
import { Code2, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';
import { DatabaseSelect } from '../DatabaseSelect';

export function AdvancedObjectsTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const [connectionId, setConnectionId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [database, setDatabase] = useState('');
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'triggers' | 'routines' | 'sequences' | 'events'>('triggers');
  const [selected, setSelected] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { objects } = await api.objects(connectionId, database || undefined);
      setData(objects);
      const first = objects.triggers?.[0] ?? objects.routines?.[0] ?? objects.sequences?.[0] ?? objects.events?.[0] ?? null;
      setSelected(first);
      if (first) setTab(first.type === 'procedure' || first.type === 'function' ? 'routines' : first.type === 'sequence' ? 'sequences' : first.type === 'event' ? 'events' : 'triggers');
    } catch (err: any) {
      notify('error', '加载失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connectionId) void load();
  }, [connectionId, database]);

  const list = data?.[tab] ?? [];

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Code2 size={15} /> 高级对象
        <span className="muted">触发器 / 函数 / 序列 / 事件</span>
      </div>
      <div className="tool-row">
        <select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} style={{ width: 260 }}>
          {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name} · {conn.engine}</option>)}
        </select>
        <DatabaseSelect connectionId={connectionId} value={database} onChange={setDatabase} testId="objects-db" />
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={12} />} 刷新
        </button>
        {data ? (
          <span className="badge">
            {data.triggers.length} triggers · {data.routines.length} routines · {data.sequences.length} sequences
          </span>
        ) : null}
      </div>
      {data ? (
        <div className="objects-grid">
          <div className="object-list">
            <div className="result-tabs" style={{ flex: '0 0 31px' }}>
              {(['triggers', 'routines', 'sequences', 'events'] as const).map((key) => (
                <button key={key} className={`result-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
                  {key} <span className="muted">{data[key]?.length ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="transfer-list">
              {list.map((item: any) => (
                <button key={`${item.type}_${item.table ?? ''}_${item.name}`} className={`result-row ${selected?.name === item.name ? 'active' : ''}`} onClick={() => setSelected(item)}>
                  <span className="badge ddl">{item.type}</span>
                  <span className="mono">{item.name}</span>
                  {item.table ? <span className="muted" style={{ fontSize: 9 }}>on {item.table}</span> : null}
                </button>
              ))}
              {!list.length ? <div className="dash-empty">{data.note ?? '该分类没有对象。'}</div> : null}
            </div>
          </div>
          <div className="object-def">
            {selected ? (
              <>
                <div className="row gap-6" style={{ marginBottom: 6 }}>
                  <strong className="mono">{selected.name}</strong>
                  <span className="badge">{selected.type}</span>
                  {selected.detail ? <span className="muted" style={{ fontSize: 10 }}>{selected.detail}</span> : null}
                </div>
                <pre className="sql-block" style={{ minHeight: 220, maxHeight: '100%', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {selected.definition ?? '该引擎未返回定义，可在对象树中查看结构。'}
                </pre>
              </>
            ) : <div className="dash-empty">选择一个对象查看定义。</div>}
          </div>
        </div>
      ) : <div className="dash-empty">选择连接以读取触发器、函数、序列与事件。</div>}
    </div>
  );
}
