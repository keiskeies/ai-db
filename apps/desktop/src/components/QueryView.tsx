import { useEffect, useMemo, useRef, useState } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, Prec } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { keymap } from '@codemirror/view';
import { MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, sql as sqlLang } from '@codemirror/lang-sql';
import { AlignLeft, BarChart3, Bookmark, Database, Download, FileDown, FileUp, History, ListChecks, Network, Play, Plus, Sparkles, Table2, TerminalSquare, Trash2, WandSparkles, Wrench } from 'lucide-react';
import type { ConnectionConfig, QueryBatchResult } from '@aidb/core';
import { engineMeta } from '@aidb/core';
import { api } from '../lib/api';
import { formatDuration } from '../lib/format';
import { formatSql } from '../lib/sqlFormat';
import { useApp, type Tab } from '../store';
import { ChartView, type ChartSpec } from './ChartView';
import { DataGrid } from './DataGrid';
import { GraphView } from './GraphView';
import { VectorSearchPanel } from './VectorSearchPanel';
import { Spinner } from './ui';

type QueryTab = Extract<Tab, { kind: 'query' }>;

// 语法着色的暖色版本：默认高亮是给浅色底调的，放在铸铁底上又冷又灰
const sqlHighlight = (dark: boolean) =>
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier], color: dark ? '#5fd8d3' : '#0a7370' },
    { tag: [t.string, t.special(t.string)], color: dark ? '#a9c97e' : '#4d6b22' },
    { tag: [t.number, t.bool], color: dark ? '#e0af63' : '#8a5f0d' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: dark ? '#858d88' : '#6a726e', fontStyle: 'italic' },
    { tag: [t.typeName, t.className, t.namespace], color: dark ? '#8fa8f0' : '#3d4f9e' },
    { tag: [t.atom, t.null], color: dark ? '#f07c86' : '#bd3546' },
    { tag: [t.propertyName, t.attributeName], color: dark ? '#b8beba' : '#4c5350' },
    { tag: [t.variableName, t.name], color: dark ? '#f1f3f1' : '#131716' },
    { tag: [t.operator, t.punctuation, t.bracket], color: dark ? '#8b9490' : '#5f6663' },
    { tag: t.invalid, color: dark ? '#f07c86' : '#bd3546' },
  ]);

function dialectFor(engine?: ConnectionConfig['engine']) {
  const dialect = engine ? engineMeta(engine).dialect : undefined;
  if (dialect === 'mysql') return MySQL;
  if (dialect === 'postgres') return PostgreSQL;
  if (dialect === 'mssql') return MSSQL;
  if (dialect === 'oracle' || dialect === 'clickhouse') return StandardSQL;
  return SQLite;
}

export function QueryView({ tab }: { tab: QueryTab }) {
  const t = useApp((s) => s.t);
  const settings = useApp((s) => s.settings);
  const connections = useApp((s) => s.connections);
  const notify = useApp((s) => s.notify);
  const updateTab = useApp((s) => s.updateTab);
  const prefillAgent = useApp((s) => s.prefillAgent);
  const setActiveConnection = useApp((s) => s.setActiveConnection);
  const openTools = useApp((s) => s.openTools);
  const conn = connections.find((c) => c.id === tab.connectionId);
  const isSql = conn ? engineMeta(conn.engine).languages.includes('sql') : true;
  const canVector = conn ? engineMeta(conn.engine).model === 'vector' || engineMeta(conn.engine).dialect === 'postgres' : false;
  const [vectorOpen, setVectorOpen] = useState(false);

  const [sql, setSql] = useState(tab.sql);
  const [batch, setBatch] = useState<QueryBatchResult | null>(null);
  const [activeSet, setActiveSet] = useState(0);
  const [resultTab, setResultTab] = useState<'results' | 'messages' | 'history' | 'chart' | 'snippets'>('results');
  const [resultMode, setResultMode] = useState<'table' | 'graph'>('table');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [editorPct, setEditorPct] = useState(38);
  const [history, setHistory] = useState<Array<{ id: string; sql: string; status: string; durationMs?: number; rowCount?: number; error?: string; createdAt: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chartType, setChartType] = useState<'bar' | 'line' | 'pie'>('bar');
  const [snippets, setSnippets] = useState<Array<{ id: string; name: string; sql: string; createdAt: string }>>([]);
  const [snippetsLoading, setSnippetsLoading] = useState(false);
  const [chartX, setChartX] = useState('');
  const [chartY, setChartY] = useState('');
  const [databases, setDatabases] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>();
  const sqlRef = useRef(sql);
  const tabIdRef = useRef(tab.id);
  const runRef = useRef<() => void>(() => undefined);
  const isDark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (tabIdRef.current !== tab.id) {
      tabIdRef.current = tab.id;
      sqlRef.current = tab.sql;
      setSql(tab.sql);
      setBatch(null);
      setError(null);
      setActiveSet(0);
      setResultTab('results');
      setResultMode('table');
    }
    const theme = EditorView.theme(
      {
        '&': { backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)', height: '100%' },
        '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
        '.cm-gutters': { backgroundColor: 'var(--bg-app)', color: 'var(--text-muted)', border: 'none', paddingRight: 4 },
        '.cm-activeLine': { backgroundColor: 'rgba(69,200,195,.06)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(69,200,195,.09)', color: 'var(--text-secondary)' },
        '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(69,200,195,.24) !important' },
        '.cm-cursor': { borderLeftColor: 'var(--accent)' },
        '.cm-tooltip': { backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: '6px' },
        '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' },
      },
      { dark: isDark },
    );
    const state = EditorState.create({
      doc: sqlRef.current,
      extensions: [
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                runRef.current();
                return true;
              },
            },
          ]),
        ),
        basicSetup,
        sqlLang({ dialect: dialectFor(conn?.engine) }),
        syntaxHighlighting(sqlHighlight(isDark)),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const next = update.state.doc.toString();
            sqlRef.current = next;
            setSql(next);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = undefined;
    };
  }, [tab.id, conn?.engine, isDark]);

  useEffect(() => () => updateTab(tab.id, { sql: sqlRef.current }), [tab.id, updateTab]);

  useEffect(() => {
    let active = true;
    api
      .databases(tab.connectionId)
      .then((result) => {
        if (active) setDatabases(result.databases);
      })
      .catch(() => {
        if (active) setDatabases([]);
      });
    return () => {
      active = false;
    };
  }, [tab.connectionId]);

  const currentSql = () => {
    const view = viewRef.current;
    if (view) {
      const { from, to } = view.state.selection.main;
      if (from !== to) return view.state.sliceDoc(from, to);
      return view.state.doc.toString();
    }
    return sqlRef.current;
  };

  const run = async () => {
    const text = currentSql().trim();
    if (!text) {
      notify('warning', '请输入查询');
      return;
    }
    setRunning(true);
    setError(null);
    updateTab(tab.id, { sql: text });
    try {
      const { batch: result } = await api.query({
        connectionId: tab.connectionId,
        database: tab.database,
        sql: text,
        limit: settings.defaultLimit,
      });
      setBatch(result);
      setActiveSet(0);
      setResultTab('results');
      if (result.sets.length > 1) notify('info', `执行成功，返回 ${result.sets.length} 个结果集`);
    } catch (err: any) {
      setError(`${err?.message ?? '执行失败'}${err?.hint ? `\n${err.hint}` : ''}`);
      setBatch(null);
      setResultTab('messages');
    } finally {
      setRunning(false);
    }
  };
  runRef.current = () => {
    void run();
  };

  const explain = async () => {
    const text = currentSql().trim();
    if (!text) return;
    const explainSql =
      conn?.engine === 'sqlite'
        ? `EXPLAIN QUERY PLAN ${text.replace(/;\s*$/, '')}`
        : conn?.engine === 'mysql'
          ? `EXPLAIN FORMAT=JSON ${text.replace(/;\s*$/, '')}`
          : `EXPLAIN (FORMAT JSON, ANALYZE false) ${text.replace(/;\s*$/, '')}`;
    setRunning(true);
    setError(null);
    try {
      const { batch: result } = await api.query({ connectionId: tab.connectionId, database: tab.database, sql: explainSql });
      setBatch(result);
      setActiveSet(0);
      setResultTab('results');
    } catch (err: any) {
      setError(err?.message ?? '执行计划失败');
      setResultTab('messages');
    } finally {
      setRunning(false);
    }
  };

  const format = () => {
    const view = viewRef.current;
    if (!view) return;
    const formatted = formatSql(view.state.doc.toString());
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
    sqlRef.current = formatted;
    setSql(formatted);
  };

  const runScript = async () => {
    const text = currentSql().trim();
    if (!text) {
      notify('warning', '请输入 SQL 脚本');
      return;
    }
    setRunning(true);
    setError(null);
    updateTab(tab.id, { sql: text });
    try {
      const { batch: result } = await api.query({
        connectionId: tab.connectionId,
        database: tab.database,
        sql: text,
        limit: settings.defaultLimit,
        allowMulti: true,
      });
      setBatch(result);
      setActiveSet(0);
      setResultTab('results');
      notify('info', '脚本执行完成', `${result.sets.length} 个结果集`);
    } catch (err: any) {
      setError(`${err?.message ?? '执行失败'}${err?.hint ? `\n${err.hint}` : ''}`);
      setBatch(null);
      setResultTab('messages');
    } finally {
      setRunning(false);
    }
  };

  const openSqlFile = async (file: File) => {
    const text = await file.text();
    const view = viewRef.current;
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    sqlRef.current = text;
    setSql(text);
    updateTab(tab.id, { sql: text });
    notify('success', 'SQL 文件已载入', file.name);
  };

  const saveSqlFile = () => {
    const text = currentSql();
    const blob = new Blob([text], { type: 'text/sql;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${tab.title.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}.sql`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const askCopilot = (kind: 'explain' | 'optimize') => {
    const text = currentSql().trim();
    if (!text) {
      notify('warning', '请输入或选中 SQL');
      return;
    }
    const prompt =
      kind === 'explain'
        ? `解释下面这段 SQL 的执行计划、瓶颈与索引建议，给出具体到列和 DDL 的优化方案：

\`\`\`sql
${text}
\`\`\``
        : `优化下面这段 SQL：请给出改写后的 SQL、精确的 CREATE INDEX DDL、EXPLAIN 依据和验证查询：

\`\`\`sql
${text}
\`\`\``;
    prefillAgent(prompt);
  };

  const exportResult = async () => {
    const text = currentSql().trim();
    if (!text) return;
    try {
      const { file } = await api.exportData({ connectionId: tab.connectionId, database: tab.database, sql: text, format: 'csv', limit: 20000 });
      notify('success', t('export'), `${file.rows} 行 · ${file.path}`);
    } catch (err: any) {
      notify('error', t('error'), err?.message);
    }
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const { items } = await api.history({ connectionId: tab.connectionId, limit: 100 });
      setHistory(items);
    } catch {
      /* ignore */
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (resultTab === 'history') void loadHistory();
    if (resultTab === 'snippets') void loadSnippets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultTab]);

  const loadSnippets = async () => {
    setSnippetsLoading(true);
    try {
      const { snippets: list } = await api.snippets();
      setSnippets(list);
    } catch {
      /* ignore */
    } finally {
      setSnippetsLoading(false);
    }
  };

  const saveSnippet = async () => {
    const sql = currentSql().trim();
    if (!sql) {
      notify('warning', '编辑器为空');
      return;
    }
    const name = window.prompt('片段名称', tab.title);
    if (!name) return;
    try {
      await api.createSnippet({ name, sql });
      await loadSnippets();
      notify('success', 'SQL 片段已保存');
    } catch (err: any) {
      notify('error', '保存失败', err?.message);
    }
  };

  const set = batch?.sets[activeSet];
  const messages = batch?.messages ?? [];

  const chartSpec: ChartSpec | null = useMemo(() => {
    if (!set?.columns.length || !set.rows.length) return null;
    const names = set.columns.map((column) => column.name);
    const fallbackX = names[0];
    const numericIndex = set.columns.findIndex((_, index) => set.rows.some((row) => Number.isFinite(Number(row[index]))));
    const effectiveX = chartX && names.includes(chartX) ? chartX : fallbackX;
    const effectiveY = chartY && names.includes(chartY) ? chartY : names[numericIndex > 0 ? numericIndex : Math.min(1, names.length - 1)];
    if (!effectiveX || !effectiveY || effectiveX === effectiveY) return null;
    const xIndex = names.indexOf(effectiveX);
    const yIndex = names.indexOf(effectiveY);
    const series = set.rows
      .slice(0, 24)
      .map((row) => ({ label: String(row[xIndex] ?? '—'), value: Number(row[yIndex]) }))
      .filter((point) => Number.isFinite(point.value));
    if (!series.length) return null;
    return { type: chartType, title: `${effectiveY} by ${effectiveX}`, xLabel: effectiveX, yLabel: effectiveY, series };
  }, [set, chartX, chartY, chartType]);

  const applyHistory = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    sqlRef.current = text;
    setSql(text);
    updateTab(tab.id, { sql: text });
    setResultTab('results');
  };

  return (
    <div className="view">
      <div className="toolbar query-meta">
        <span className="title">
          <TerminalSquare size={14} style={{ color: 'var(--accent)' }} />
          {tab.title}
          <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
            {conn?.name}
          </span>
        </span>
        <Database size={12} className="muted" />
        <select
          className="select query-select"
          value={tab.connectionId}
          onChange={(e) => {
            const next = connections.find((item) => item.id === e.target.value);
            updateTab(tab.id, { connectionId: e.target.value, database: next?.database });
            setActiveConnection(e.target.value);
          }}
          data-testid="query-connection"
        >
          {connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select
          className="select query-select"
          value={tab.database ?? ''}
          onChange={(e) => updateTab(tab.id, { database: e.target.value || undefined })}
          data-testid="query-database"
        >
          <option value="">默认数据库</option>
          {databases.map((database) => <option key={database} value={database}>{database}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn primary small" onClick={() => void run()} disabled={running} data-testid="query-run">
          {running ? <Spinner /> : <Play size={12} />} {t('run')}
        </button>
      </div>

      <div className="toolbar query-actions">
        {isSql ? (
          <>
            <button className="btn small" onClick={saveSqlFile}>
              <FileDown size={12} /> 保存
            </button>
            <button className="btn small" onClick={() => openTools('builder')} title="打开可视化查询构建器">
              <Wrench size={12} /> 查询创建工具
            </button>
            <button className="btn small" onClick={format}>
              <AlignLeft size={12} /> 美化 SQL
            </button>
            <button className="btn small" onClick={() => setResultTab('snippets')} title="SQL 代码段">
              <Bookmark size={12} /> 代码段
            </button>
            <div className="sep" />
            <button className="btn small" onClick={() => void explain()} disabled={running}>
              <WandSparkles size={12} /> {t('explain')}
            </button>
            <button className="btn small ai" onClick={() => askCopilot('explain')} title="AI 解释执行计划">
              <Sparkles size={12} /> AI 解释
            </button>
            <button className="btn small ai" onClick={() => askCopilot('optimize')} title="AI 优化 SQL 与索引">
              <Sparkles size={12} /> AI 优化
            </button>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            {conn && engineMeta(conn.engine).languages.includes('mql')
              ? 'MongoDB：使用 JSON 结构化查询（collection / op / filter / pipeline）'
              : conn && engineMeta(conn.engine).languages.includes('cypher')
                ? 'Neo4j：输入 Cypher，例如 MATCH (n) RETURN n LIMIT 100'
                : conn && engineMeta(conn.engine).model === 'vector'
                  ? '向量库：输入 JSON，例如 {"collection":"docs","vector":[...],"topK":5}；scroll 可浏览全部点'
                  : conn && engineMeta(conn.engine).model === 'search'
                    ? '搜索：输入 JSON，例如 {"index":"logs","query":{"match_all":{}},"size":20}'
                    : conn && engineMeta(conn.engine).model === 'widecolumn'
                      ? 'Cassandra：输入 CQL，例如 SELECT * FROM ks.tbl LIMIT 100（不支持 JOIN）'
                      : 'Redis：输入单条命令，例如 SCAN 0 COUNT 100 或 HGETALL user:1'}
          </span>
        )}
        <div className="spacer" />
        {canVector ? (
          <button className="btn small ai" onClick={() => setVectorOpen(true)} data-testid="open-vector-search">
            <Sparkles size={12} /> 向量检索
          </button>
        ) : null}
        {isSql ? (
          <>
            <button className="icon-btn" title="导出结果" onClick={() => void exportResult()}>
              <Download size={13} />
            </button>
            <button className="icon-btn" title="执行整个脚本（允许多语句）" onClick={() => void runScript()} disabled={running}>
              <ListChecks size={13} />
            </button>
            <button className="icon-btn" title="打开 SQL 文件" onClick={() => fileInputRef.current?.click()}>
              <FileUp size={13} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".sql,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void openSqlFile(file);
                e.target.value = '';
              }}
            />
          </>
        ) : null}
        <span className="kbd">Ctrl/⌘ + Enter</span>
      </div>

      <div className="query-layout">
        <div className="editor-pane" style={{ flexBasis: `${editorPct}%` }}>
          <div className="editor-host" ref={hostRef} data-testid="query-editor" />
        </div>
        <div
          className="splitter"
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const start = editorPct;
            const move = (ev: MouseEvent) => setEditorPct(Math.min(75, Math.max(18, start + ((ev.clientY - startY) / window.innerHeight) * 100)));
            const up = () => {
              window.removeEventListener('mousemove', move);
              window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
          }}
        />
        <div className="result-pane">
          <div className="result-tabs">
            {batch
              ? batch.sets.map((s, i) => (
                  <button key={i} className={`result-tab ${resultTab === 'results' && activeSet === i ? 'active' : ''}`} onClick={() => { setResultTab('results'); setActiveSet(i); }}>
                    <Table2 size={11} /> {`结果 ${i + 1}`}
                    <span className="muted">{s.columns.length ? s.rowCount : s.affected ?? 0}</span>
                  </button>
                ))
              : null}
            <button className={`result-tab ${resultTab === 'messages' ? 'active' : ''}`} onClick={() => setResultTab('messages')} data-testid="query-messages">
              消息 {error ? <span style={{ color: 'var(--danger)' }}>!</span> : null}
            </button>
            {set && set.resultKind === 'graph' && set.graph ? (
              <>
                <button
                  className={`result-tab ${resultMode === 'table' ? 'active' : ''}`}
                  onClick={() => { setResultTab('results'); setResultMode('table'); }}
                  data-testid="result-mode-table"
                >
                  <Table2 size={11} /> 表格
                </button>
                <button
                  className={`result-tab ${resultMode === 'graph' ? 'active' : ''}`}
                  onClick={() => { setResultTab('results'); setResultMode('graph'); }}
                  data-testid="result-mode-graph"
                >
                  <Network size={11} /> 图
                </button>
              </>
            ) : null}
            {set && set.columns.length > 1 ? (
              <button className={`result-tab ${resultTab === 'chart' ? 'active' : ''}`} onClick={() => setResultTab('chart')}>
                <BarChart3 size={11} /> 图表
              </button>
            ) : null}
            <button className={`result-tab ${resultTab === 'history' ? 'active' : ''}`} onClick={() => setResultTab('history')} data-testid="query-history">
              <History size={11} /> {t('history')}
            </button>
            <button className={`result-tab ${resultTab === 'snippets' ? 'active' : ''}`} onClick={() => setResultTab('snippets')}>
              <Bookmark size={11} /> 片段
            </button>
            <div className="spacer" />
            {batch ? <span className="muted">{formatDuration(batch.durationMs)}</span> : null}
          </div>

          {resultTab === 'results' ? (
            set && set.columns.length ? (
              set.resultKind === 'graph' && set.graph && resultMode === 'graph' ? (
                <div style={{ padding: 10 }}>
                  <GraphView graph={set.graph} />
                </div>
              ) : (
                <DataGrid columns={set.columns} rows={set.rows} testId="query-result-grid" />
              )
            ) : set ? (
              <div className="messages-panel">
                <div className="ok">执行成功</div>
                <div>影响 {set.affected ?? 0} 行</div>
                {set.lastInsertId !== undefined ? <div>lastInsertId: {String(set.lastInsertId)}</div> : null}
              </div>
            ) : (
              <div className="empty-state">
                <div>
                  <div className="icon">
                    <TerminalSquare size={20} />
                  </div>
                  <h3>{t('query')}</h3>
                  <p>{t('queryPlaceholder')}</p>
                </div>
              </div>
            )
          ) : null}

          {resultTab === 'chart' ? (
            <div className="query-chart-panel">
              {chartSpec ? (
                <ChartView
                  chart={chartSpec}
                  typeOverride={chartType}
                  onTypeChange={setChartType}
                  maxPoints={60}
                  columns={set?.columns.map((column) => column.name)}
                  x={chartX}
                  y={chartY}
                  onX={setChartX}
                  onY={setChartY}
                />
              ) : (
                <div className="dash-empty">当前结果没有可绘制的数值列。</div>
              )}
            </div>
          ) : null}

          {resultTab === 'messages' ? (
            <div className="messages-panel">
              {error ? <div className="err" style={{ whiteSpace: 'pre-wrap' }}>{error}</div> : null}
              {!error ? messages.length ? messages.map((m, i) => <div key={i} className="ok">{m}</div>) : <div className="muted">暂无消息</div> : null}
              {batch && !error ? <div className="muted" style={{ marginTop: 8 }}>总计 {formatDuration(batch.durationMs)}</div> : null}
            </div>
          ) : null}

          {resultTab === 'snippets' ? (
            <div className="history-panel">
              <div className="tool-row" style={{ borderBottom: '1px solid var(--border-subtle)', padding: '6px 8px' }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>已保存 SQL 片段</span>
                <div className="spacer" />
                <button className="btn small primary" onClick={() => void saveSnippet()}><Plus size={11} /> 保存当前 SQL</button>
              </div>
              {snippetsLoading ? <div className="loading-inline" style={{ padding: 12 }}><Spinner /> {t('loading')}</div> : null}
              {snippets.map((snippet) => (
                <div key={snippet.id} className="history-item">
                  <Bookmark size={12} style={{ color: 'var(--accent)', marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }} onClick={() => applyHistory(snippet.sql)}>
                    <div style={{ fontSize: 11.5, fontWeight: 600 }}>{snippet.name}</div>
                    <div className="sql">{snippet.sql.replace(/\s+/g, ' ')}</div>
                  </div>
                  <button className="icon-btn danger" onClick={async () => { await api.deleteSnippet(snippet.id); await loadSnippets(); }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {!snippets.length && !snippetsLoading ? <div className="muted" style={{ padding: 12 }}>暂无片段。保存常用 SQL，点击即可插入编辑器。</div> : null}
            </div>
          ) : null}

          {resultTab === 'history' ? (
            <div className="history-panel">
              {historyLoading ? (
                <div className="loading-inline" style={{ padding: 14 }}>
                  <Spinner /> {t('loading')}
                </div>
              ) : history.length ? (
                history.map((item) => (
                  <div key={item.id} className="history-item" onClick={() => applyHistory(item.sql)} title="点击插入编辑器">
                    <span className={`badge ${item.status === 'ok' ? 'read' : 'destructive'}`}>{item.status}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="sql">{item.sql.replace(/\s+/g, ' ')}</div>
                      {item.error ? <div className="meta" style={{ color: 'var(--danger)' }}>{item.error}</div> : null}
                    </div>
                    <span className="meta">
                      {item.rowCount ?? 0} 行 · {formatDuration(item.durationMs)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="muted" style={{ padding: 14 }}>暂无历史</div>
              )}
            </div>
          ) : null}
        </div>
      </div>
      {vectorOpen && conn ? <VectorSearchPanel connection={conn} database={tab.database} onClose={() => setVectorOpen(false)} /> : null}
    </div>
  );
}
