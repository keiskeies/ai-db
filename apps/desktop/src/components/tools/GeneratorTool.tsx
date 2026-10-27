import { useState } from 'react';
import { Loader2, Sparkles, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';

export function GeneratorTool() {
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const connections = useApp((s) => s.connections);
  const schemasByConn = useApp((s) => s.schemas);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const conn = connections.find((c) => c.id === activeConnectionId);
  const tables = (activeConnectionId ? schemasByConn[activeConnectionId] ?? [] : []).flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
  const [table, setTable] = useState(tables[0]?.name ?? '');
  const [rows, setRows] = useState(20);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const generate = async (dryRun: boolean) => {
    if (!activeConnectionId || !table) return;
    setLoading(true);
    try {
      const { result: generated } = await api.generateData({ connectionId: activeConnectionId, database: conn?.database, table, rows, dryRun });
      setResult(generated);
      if (!dryRun) {
        notify('success', '示例数据已生成', `${generated.inserted} 行 → ${table}`);
        await loadSchema(activeConnectionId, true);
      }
    } catch (err: any) {
      notify('error', '生成失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  if (!conn) return <div className="dash-empty">请选择连接。</div>;

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Sparkles size={15} /> 数据生成
        <span className="muted">按列名/类型生成贴近业务的测试数据，自动处理外键</span>
      </div>
      <div className="tool-row" style={{ flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label>目标表</label>
          <select className="select" value={table} onChange={(e) => { setTable(e.target.value); setResult(null); }}>
            {tables.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.columns?.length ?? 0} 列</option>)}
          </select>
        </div>
        <div className="field" style={{ width: 120 }}>
          <label>行数</label>
          <input className="input" type="number" min={1} max={5000} value={rows} onChange={(e) => setRows(Number(e.target.value))} />
        </div>
        <button className="btn" style={{ alignSelf: 'flex-end' }} onClick={() => void generate(true)} disabled={loading || !table}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Wand2 size={12} />} 预览
        </button>
        <button
          className="btn primary"
          style={{ alignSelf: 'flex-end' }}
          onClick={() => {
            if (!window.confirm(`向 ${table} 插入 ${rows} 行生成数据？`)) return;
            void generate(false);
          }}
          disabled={loading || !table}
        >
          <Sparkles size={12} /> 生成并插入
        </button>
      </div>

      <div className="tool-scroll">
        {!result ? (
          <div className="dash-empty">生成器会跳过自增主键，按 name/email/status/amount/date 等语义与类型填充；外键会从被引用表中取现有值。</div>
        ) : (
          <>
            <div className="tool-summary">
              {result.table} · {result.columns.length} 列 · {result.dryRun ? '预览' : `已插入 ${result.inserted} 行`}
            </div>
            <div className="mini-table-wrap">
              <table className="tool-table">
                <thead><tr>{result.columns.map((column: string) => <th key={column}>{column}</th>)}</tr></thead>
                <tbody>
                  {result.rowsPreview.map((row: unknown[], index: number) => (
                    <tr key={index}>{row.map((value, valueIndex) => <td key={valueIndex}>{value === null ? 'NULL' : String(value).slice(0, 80)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="tool-section-title" style={{ marginTop: 10 }}>INSERT 预览</div>
            <pre className="sql-block" style={{ maxHeight: 180, overflow: 'auto' }}>{result.sqlPreview}</pre>
          </>
        )}
      </div>
    </div>
  );
}
