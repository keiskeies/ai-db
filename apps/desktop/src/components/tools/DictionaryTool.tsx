import { useState } from 'react';
import { BookOpen, Download, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';

export function DictionaryTool() {
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const connections = useApp((s) => s.connections);
  const notify = useApp((s) => s.notify);
  const conn = connections.find((item) => item.id === activeConnectionId);
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'markdown' | 'sql'>('markdown');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!activeConnectionId) return;
    setLoading(true);
    try {
      const { dictionary } = await api.dictionary(activeConnectionId, conn?.database);
      setData(dictionary);
    } catch (err: any) {
      notify('error', '生成失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  const download = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <BookOpen size={15} /> 数据字典
        <span className="muted">Markdown / DDL / JSON</span>
      </div>
      <div className="tool-row">
        <button className="btn primary" onClick={() => void load()} disabled={loading || !activeConnectionId}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <BookOpen size={12} />} 生成字典
        </button>
        {data ? (
          <>
            <button className="btn small" onClick={() => download(data.markdown, 'aidb-dictionary.md', 'text/markdown')}><Download size={11} /> Markdown</button>
            <button className="btn small" onClick={() => download(data.sql, 'aidb-schema.sql', 'text/sql')}><Download size={11} /> DDL</button>
            <button className="btn small" onClick={() => download(JSON.stringify(data.json, null, 2), 'aidb-dictionary.json', 'application/json')}><Download size={11} /> JSON</button>
            <span className="spacer" />
            <span className="badge">{data.tableCount} 表 / {data.columnCount} 列</span>
          </>
        ) : null}
      </div>
      {data ? (
        <>
          <div className="result-tabs" style={{ flex: '0 0 31px' }}>
            <button className={`result-tab ${tab === 'markdown' ? 'active' : ''}`} onClick={() => setTab('markdown')}>Markdown</button>
            <button className={`result-tab ${tab === 'sql' ? 'active' : ''}`} onClick={() => setTab('sql')}>DDL</button>
          </div>
          <div className="tool-scroll">
            <pre className="sql-block" style={{ whiteSpace: 'pre-wrap', minHeight: 300 }}>{tab === 'markdown' ? data.markdown : data.sql}</pre>
          </div>
        </>
      ) : (
        <div className="dash-empty">生成当前连接的表/列/索引/外键字典，可导出 Markdown、DDL 或 JSON。</div>
      )}
    </div>
  );
}
