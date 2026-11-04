import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Download, Loader2 } from 'lucide-react';
import { applyCapabilityDefaults, CAPABILITIES, getCapability, type Capability } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';
import { CapabilityForm } from './CapabilityForm';
import { t as tr } from '../../i18n';

/**
 * 数据字典 —— 表单向能力契约（`capabilities/dictionary.json`）迁移后的实现。
 *
 * 只有「库」一个字段，但迁移后它与其它模块共享同一套字段渲染与默认值语义，
 * 后续加「导出格式」「是否包含索引」等字段时只改 JSON。
 */
export function DictionaryTool() {
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const capability = useMemo<Capability>(() => getCapability('dictionary') ?? CAPABILITIES[0], []);
  const [values, setValues] = useState<Record<string, unknown>>(() => applyCapabilityDefaults(capability));
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'markdown' | 'sql'>('markdown');
  const [loading, setLoading] = useState(false);

  // 连接从全局取；契约里的 connectionId 字段固定绑定到当前连接，不渲染选择器
  useEffect(() => {
    setData(null);
  }, [activeConnectionId]);

  const database = String(values.database ?? '');

  const load = async () => {
    if (!activeConnectionId) return;
    setLoading(true);
    try {
      const { dictionary } = await api.dictionary(activeConnectionId, database || undefined);
      setData(dictionary);
    } catch (err: any) {
      notify('error', tr("生成失败"), err?.message);
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
        <BookOpen size={15} /> {tr(" 数据字典 ")}<span className="muted">Markdown / DDL / JSON</span>
      </div>
      <div className="tool-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <CapabilityForm
          capability={capability}
          values={values}
          onChange={(key, value) => {
            setValues((current) => ({ ...current, [key]: value }));
            if (key === 'database') setData(null);
          }}
          connectionId={activeConnectionId ?? undefined}
          disabled={loading}
          testIdPrefix="dictionary"
        />
        <button className="btn primary" onClick={() => void load()} disabled={loading || !activeConnectionId}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <BookOpen size={12} />}{tr(" 生成字典 ")}</button>
        {data ? (
          <>
            <button className="btn small" onClick={() => download(data.markdown, 'aidb-dictionary.md', 'text/markdown')}><Download size={11} /> Markdown</button>
            <button className="btn small" onClick={() => download(data.sql, 'aidb-schema.sql', 'text/sql')}><Download size={11} /> DDL</button>
            <button className="btn small" onClick={() => download(JSON.stringify(data.json, null, 2), 'aidb-dictionary.json', 'application/json')}><Download size={11} /> JSON</button>
            <span className="spacer" />
            <span className="badge">{data.tableCount}{tr(" 表 / ")}{data.columnCount}{tr(" 列")}</span>
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
        <div className="dash-empty">{tr("生成当前连接的表/列/索引/外键字典，可导出 Markdown、DDL 或 JSON。")}</div>
      )}
    </div>
  );
}
