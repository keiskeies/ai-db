import { useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Loader2, Play } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';

interface DiffChange {
  kind: string;
  table: string;
  column?: string;
  detail: string;
  sql?: string;
  destructive?: boolean;
}
interface DiffTable {
  name: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  changes: DiffChange[];
  sql: string[];
}

export function SchemaCompareTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const [sourceId, setSourceId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [targetId, setTargetId] = useState(connections.find((c) => c.id !== activeConnectionId)?.id ?? connections[0]?.id ?? '');
  const [sourceDatabase, setSourceDatabase] = useState('');
  const [targetDatabase, setTargetDatabase] = useState('');
  const [diff, setDiff] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const compare = async () => {
    if (!sourceId || !targetId) return;
    setLoading(true);
    setDiff(null);
    try {
      const result = await api.compareSchemas({
        sourceId,
        sourceDatabase: sourceDatabase || undefined,
        targetId,
        targetDatabase: targetDatabase || undefined,
      });
      setDiff(result.diff);
    } catch (err: any) {
      notify('error', '结构对比失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  const sync = async () => {
    if (!diff?.sql?.length) return;
    const destructive = diff.tables.some((table: DiffTable) => table.changes.some((change) => change.destructive));
    const text = destructive
      ? `包含 ${diff.summary.statements} 条语句，其中存在删除表/列/索引的破坏性变更。确认同步到目标库？\n\n建议先备份目标库。`
      : `将执行 ${diff.summary.statements} 条变更语句到目标库，确认继续？`;
    if (!window.confirm(text)) return;
    setSyncing(true);
    try {
      await api.syncSchema({ connectionId: targetId, database: targetDatabase || undefined, statements: diff.sql });
      notify('success', '结构同步完成', `${diff.summary.statements} 条语句`);
      await loadSchema(targetId, true);
      await compare();
    } catch (err: any) {
      notify('error', '同步失败', err?.message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <ArrowLeftRight size={15} /> 结构对比与同步
        <span className="muted">生成目标方言 DDL，执行前确认</span>
      </div>
      <div className="tool-row" style={{ flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label>源连接</label>
          <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name} · {conn.engine}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label>源数据库（可选）</label>
          <input className="input mono" value={sourceDatabase} onChange={(e) => setSourceDatabase(e.target.value)} placeholder="默认连接数据库" />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label>目标连接</label>
          <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name} · {conn.engine}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label>目标数据库（可选）</label>
          <input className="input mono" value={targetDatabase} onChange={(e) => setTargetDatabase(e.target.value)} placeholder="默认连接数据库" />
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={() => void compare()} disabled={loading || !sourceId || !targetId}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <ArrowLeftRight size={12} />} 对比
        </button>
      </div>

      <div className="tool-scroll">
        {!diff ? (
          <div className="dash-empty">选择源与目标连接后开始对比。将识别新增/删除表、列变更与索引差异，并按目标引擎生成 DDL。</div>
        ) : (
          <>
            <div className="tool-summary">
              源 {diff.sourceTables} 表 → 目标 {diff.targetTables} 表 · 新增 {diff.summary.added} / 删除 {diff.summary.removed} / 变更 {diff.summary.changed} · {diff.summary.statements} 条语句
              {diff.source.engine !== diff.target.engine ? <span className="badge write" style={{ marginLeft: 8 }}>跨引擎：请检查类型映射</span> : null}
            </div>
            <div className="diff-list">
              {diff.tables.filter((table: DiffTable) => table.status !== 'unchanged').map((table: DiffTable) => (
                <div key={table.name} className="diff-item">
                  <div className="diff-head">
                    <span className={`badge ${table.status === 'added' ? 'read' : table.status === 'removed' ? 'destructive' : 'write'}`}>{table.status.toUpperCase()}</span>
                    <strong className="mono">{table.name}</strong>
                    <span className="muted" style={{ fontSize: 10 }}>{table.changes.length} 项变更</span>
                    {table.changes.some((change) => change.destructive) ? <AlertTriangle size={11} style={{ color: 'var(--warning)' }} /> : null}
                  </div>
                  {table.changes.map((change, index) => (
                    <div key={index} className="diff-change">
                      <span className="muted">{change.destructive ? '⚠' : '·'} {change.detail}</span>
                      {change.sql ? <pre className="sql-block" style={{ marginTop: 3 }}>{change.sql}</pre> : null}
                    </div>
                  ))}
                </div>
              ))}
              {!diff.tables.some((table: DiffTable) => table.status !== 'unchanged') ? <div className="dash-empty">两个结构完全一致。</div> : null}
            </div>
            {diff.sql.length ? (
              <div className="tool-section">
                <div className="tool-section-title">同步 SQL</div>
                <pre className="sql-block" style={{ maxHeight: 240, overflow: 'auto' }}>{diff.sql.join('\n\n')}</pre>
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                  <button className="btn primary" onClick={() => void sync()} disabled={syncing}>
                    {syncing ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Play size={12} />} 同步到目标
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
