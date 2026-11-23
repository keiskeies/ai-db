import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookMarked, Check, Columns3, Download, Link2, Loader2, Pencil, Plus, Table2, Trash2, Upload, X } from 'lucide-react';
import {
  MEMORY_KIND_LABELS,
  bundleAgentContext,
  compressSchema,
  estimateTokens,
  type AgentContextEntry,
  type Memory,
  type TableInfo,
} from '@aidb/core';
import { api } from '../../lib/api';
import { parseCsv, toCsv } from '../../lib/csv';
import { useApp } from '../../store';
import { askConfirm } from '../AskDialog';
import { Select, Option } from '../ui';
import { t as tr } from '../../i18n';

type Tab = 'tables' | 'columns' | 'relations' | 'terms';

const TABS: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: 'tables', label: tr("表管理"), icon: <Table2 size={12} /> },
  { id: 'columns', label: tr("字段语义"), icon: <Columns3 size={12} /> },
  { id: 'relations', label: tr("关联关系"), icon: <Link2 size={12} /> },
  { id: 'terms', label: tr("术语与示例"), icon: <BookMarked size={12} /> },
];

const lower = (value: string) => value.trim().toLowerCase();

export function AgentContextTool() {
  const connections = useApp((s) => s.connections);
  const schemas = useApp((s) => s.schemas);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const loadedDatabases = useApp((s) => s.loadedDatabases);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);

  const [connId, setConnId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [database, setDatabase] = useState('');
  const [tab, setTab] = useState<Tab>('tables');
  const [entries, setEntries] = useState<AgentContextEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedTable, setSelectedTable] = useState('');
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState<Memory[]>([]);
  const [examples, setExamples] = useState<Memory[]>([]);
  const [draftTerm, setDraftTerm] = useState({ title: '', content: '', synonyms: '' });
  const [draftExample, setDraftExample] = useState({ title: '', content: '' });
  const [draftRelation, setDraftRelation] = useState({ table: '', column: '', refTable: '', refColumn: '', description: '' });
  const [editing, setEditing] = useState<{ id: string; title: string; content: string; synonyms: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const conn = connections.find((c) => c.id === connId);
  const databases = schemas[connId] ?? [];

  useEffect(() => {
    if (connId && !databases.length) void loadSchema(connId);
  }, [connId, databases.length, loadSchema]);

  useEffect(() => {
    if (!database && databases.length) {
      const preferred = conn?.database && databases.some((d) => d.name === conn.database) ? conn.database : databases[0].name;
      setDatabase(preferred);
    }
  }, [databases, database, conn?.database]);

  useEffect(() => {
    if (!connId || !database) return;
    if (!(loadedDatabases[connId] ?? []).includes(database)) void loadSchema(connId, false, database);
  }, [connId, database, loadedDatabases, loadSchema]);

  const reload = useCallback(async () => {
    // 覆盖项按库存储：库名未定时不拉取，否则会把其它库的配置套到当前列表上
    if (!connId || !database) return;
    setBusy(true);
    try {
      const { entries: list } = await api.agentContext(connId, database);
      setEntries(list);
    } catch (err: any) {
      notify('error', tr("加载业务上下文失败"), err?.message);
    } finally {
      setBusy(false);
    }
  }, [connId, database, notify]);

  const reloadMemories = useCallback(async () => {
    try {
      const [g, e] = await Promise.all([api.memories({ kind: 'glossary', limit: 200 }), api.memories({ kind: 'sql_example', limit: 100 })]);
      setTerms(g.memories);
      setExamples(e.memories);
    } catch {
      /* 记忆加载失败不阻塞其它 tab */
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (tab === 'terms') void reloadMemories();
  }, [tab, reloadMemories]);

  const bundle = useMemo(() => bundleAgentContext(entries, { connectionId: connId, database }), [entries, connId, database]);
  const schema = databases.find((d) => d.name === database);
  const tables = useMemo(() => schema?.tables ?? [], [schema]);
  const tableEntries = useMemo(() => {
    const map = new Map<string, AgentContextEntry>();
    for (const e of entries) if (e.kind === 'table') map.set(lower(e.table), e);
    return map;
  }, [entries]);
  const columnEntries = useMemo(() => {
    const map = new Map<string, AgentContextEntry>();
    for (const e of entries) if (e.kind === 'column') map.set(`${lower(e.table)}\u0000${lower(e.column ?? '')}`, e);
    return map;
  }, [entries]);
  const relations = useMemo(() => entries.filter((e) => e.kind === 'relation'), [entries]);
  const disabled = useMemo(() => new Set(bundle.disabledTables.map(lower)), [bundle.disabledTables]);
  const visibleTables = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables;
  }, [tables, filter]);
  const currentTable: TableInfo | undefined = tables.find((t) => t.name === selectedTable);
  const enabledCount = tables.filter((t) => !disabled.has(lower(t.name))).length;
  const tokens = useMemo(() => estimateTokens(compressSchema(schema ? [schema] : [], [], 15, bundle)), [schema, bundle]);

  const save = async (fn: () => Promise<unknown>, okMessage?: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      if (okMessage) notify('success', tr("已保存"), okMessage);
    } catch (err: any) {
      notify('error', tr("保存失败"), err?.message);
    } finally {
      setBusy(false);
    }
  };

  /** 乐观更新：勾选立刻生效，随后与服务端对账；失败时 reload 会把状态纠正回来。 */
  const optimistic = (kind: 'table' | 'column', table: string, column: string | undefined, enabled: boolean) => {
    const stamp = new Date().toISOString();
    setEntries((prev) => {
      const match = (e: AgentContextEntry) =>
        e.kind === kind && lower(e.table) === lower(table) && (kind === 'table' || lower(e.column ?? '') === lower(column ?? ''));
      const existing = prev.find(match);
      if (existing) return prev.map((e) => (match(e) ? { ...e, enabled, updatedAt: stamp } : e));
      return [
        ...prev,
        { id: `pending-${kind}-${table}-${column ?? ''}`, connectionId: connId, database, kind, table, column, enabled, createdAt: stamp, updatedAt: stamp },
      ];
    });
  };

  const setTableEnabled = (name: string, enabled: boolean) => {
    optimistic('table', name, undefined, enabled);
    void save(() => api.putContextEntry({ connectionId: connId, database, kind: 'table', table: name, enabled }));
  };

  const commitTableMeta = (name: string, patch: { alias?: string | null; description?: string | null }) =>
    void save(() => api.putContextEntry({ connectionId: connId, database, kind: 'table', table: name, ...patch }));

  const bulk = (enabled: boolean, names?: string[]) =>
    void save(
      () => api.bulkContextTables({ connectionId: connId, database, tables: names ?? visibleTables.map((t) => t.name), enabled }),
      enabled ? tr("已启用") : tr("已禁用"),
    );

  const setColumnEnabled = (table: string, column: string, enabledFlag: boolean) => {
    optimistic('column', table, column, enabledFlag);
    void save(() => api.putContextEntry({ connectionId: connId, database, kind: 'column', table, column, enabled: enabledFlag }));
  };

  const commitColumnMeta = (table: string, column: string, patch: { alias?: string | null; description?: string | null }) =>
    void save(() => api.putContextEntry({ connectionId: connId, database, kind: 'column', table, column, ...patch }));

  const addRelation = () => {
    const { table, column, refTable, refColumn, description } = draftRelation;
    if (!table || !column || !refTable || !refColumn) {
      notify('error', tr("关系不完整"), tr("左表、左列、右表、右列都必填"));
      return;
    }
    void save(
      () => api.putContextRelation({ connectionId: connId, database, table, column, refTable, refColumn, description: description || null }),
      `${table}.${column} → ${refTable}.${refColumn}`,
    );
    setDraftRelation({ table: '', column: '', refTable: '', refColumn: '', description: '' });
  };

  const clearAll = () => {
    void (async () => {
      const ok = await askConfirm({
        message: tr("清空「{0}{1}」的全部业务上下文配置？", [conn?.name ?? connId, database ? ` / ${database}` : '']),
        detail: tr("Agent 将回到默认行为。"),
        danger: true,
        confirmLabel: tr("清空"),
      });
      if (!ok) return;
      void save(() => api.clearAgentContext(connId, database), tr("已清空"));
    })();
  };

  const addMemory = (kind: 'glossary' | 'sql_example', draft: { title: string; content: string; synonyms?: string }, reset: () => void) => {
    if (!draft.title.trim() || !draft.content.trim()) {
      notify('error', tr("内容不完整"), kind === 'glossary' ? tr("术语与释义都必填") : tr("问题与 SQL 都必填"));
      return;
    }
    void (async () => {
      setBusy(true);
      try {
        const synonyms = kind === 'glossary' && draft.synonyms
          ? draft.synonyms.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
          : undefined;
        await api.createMemory({ kind, title: draft.title.trim(), content: draft.content.trim(), synonyms, connectionId: connId, database });
        reset();
        await reloadMemories();
        notify('success', tr("已保存"), kind === 'glossary' ? tr("术语已加入词典") : tr("示例 SQL 已加入校准库"));
      } catch (err: any) {
        notify('error', tr("保存失败"), err?.message);
      } finally {
        setBusy(false);
      }
    })();
  };

  const removeMemory = (id: string) =>
    void (async () => {
      try {
        await api.deleteMemory(id);
        await reloadMemories();
      } catch (err: any) {
        notify('error', tr("删除失败"), err?.message);
      }
    })();

  const startEdit = (m: Memory) => setEditing({ id: m.id, title: m.title, content: m.content, synonyms: (m.synonyms ?? []).join(', ') });

  const saveEdit = (m: Memory) => {
    if (!editing) return;
    if (!editing.title.trim() || !editing.content.trim()) {
      notify('error', tr("内容不完整"), m.kind === 'glossary' ? tr("术语与释义都必填") : tr("问题与 SQL 都必填"));
      return;
    }
    void (async () => {
      setBusy(true);
      try {
        const body: Record<string, unknown> = { title: editing.title.trim(), content: editing.content.trim() };
        if (m.kind === 'glossary') body.synonyms = editing.synonyms.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
        await api.updateMemory(m.id, body);
        setEditing(null);
        await reloadMemories();
        notify('success', tr("已保存"), tr("记忆已更新"));
      } catch (err: any) {
        notify('error', tr("保存失败"), err?.message);
      } finally {
        setBusy(false);
      }
    })();
  };

  const exportCsv = () => {
    const rows = [
      ['kind', 'title', 'content', 'synonyms'],
      ...terms.map((m) => [m.kind, m.title, m.content, (m.synonyms ?? []).join(';')]),
      ...examples.map((m) => [m.kind, m.title, m.content, '']),
    ];
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const blob = new Blob(['\uFEFF' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-context-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importCsv = (file: File) => {
    void (async () => {
      setBusy(true);
      try {
        const rows = parseCsv(await file.text());
        const start = rows[0]?.[0]?.trim().toLowerCase() === 'kind' ? 1 : 0;
        const dataRows = rows.slice(start);
        const truncated = dataRows.length > 500;
        const bad: string[] = [];
        let imported = 0;
        let merged = 0;
        for (const [idx, row] of dataRows.slice(0, 500).entries()) {
          const lineNo = start + idx + 1;
          const kind = (row[0] ?? '').trim();
          const title = (row[1] ?? '').trim();
          const content = (row[2] ?? '').trim();
          if (kind !== 'glossary' && kind !== 'sql_example') { bad.push(tr("行 {0}：kind 必须是 glossary 或 sql_example", [lineNo])); continue; }
          if (!title || !content) { bad.push(tr("行 {0}：title/content 不能为空", [lineNo])); continue; }
          const synonyms = kind === 'glossary' ? (row[3] ?? '').split(/[;；]/).map((s) => s.trim()).filter(Boolean) : undefined;
          try {
            const res = await api.createMemory({ kind, title, content, synonyms, connectionId: connId, database });
            imported += 1;
            if (res.merged) merged += 1;
          } catch (err: any) {
            bad.push(tr("行 {0}：{1}", [lineNo, err?.message ?? tr("保存失败")]));
          }
        }
        await reloadMemories();
        notify('success', tr("已保存"), tr("导入 {0} 条（合并 {1} 条）", [imported, merged]));
        if (truncated) notify('error', tr("导入被截断"), tr("超出 500 行上限，仅导入前 500 行"));
        if (bad.length) notify('error', tr("导入完成，{0} 行被跳过", [bad.length]), bad.slice(0, 5).join('；'));
      } catch (err: any) {
        notify('error', tr("导入失败"), err?.message);
      } finally {
        setBusy(false);
      }
    })();
  };

  if (!connections.length) return <div className="dash-empty">{tr("请先创建一个数据库连接。")}</div>;

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <BookMarked size={15} /> {tr(" Agent 业务上下文 ")}<span className="muted">{tr("给模型划定知识边界、注入业务语义，是问数准确率的直接来源")}</span>
      </div>

      <div className="tool-row">
        <Select className="select" value={connId} onChange={(e) => { setConnId(e.target.value); setDatabase(''); }} data-testid="ctx-connection">
          {connections.map((c) => (
            <Option key={c.id} value={c.id}>{c.name}</Option>
          ))}
        </Select>
        <Select className="select" value={database} onChange={(e) => setDatabase(e.target.value)} data-testid="ctx-database">
          {databases.map((d) => (
            <Option key={d.name} value={d.name}>{d.name}{d.tables.length ? '' : tr("（未加载）")}</Option>
          ))}
        </Select>
        <span className="spacer" />
        <span className="badge">{tables.length ? tr("启用 {0}/{1} 表", [enabledCount, tables.length]) : tr("表未加载")}</span>
        <span className="badge agent" data-testid="ctx-tokens">{tr("上下文 ≈ ")}{tokens.toLocaleString()} tokens</span>
        <button className="btn small danger" onClick={clearAll} disabled={busy || !entries.length} data-testid="ctx-clear">
          <Trash2 size={11} /> {tr(" 清空配置 ")}</button>
      </div>

      <div className="result-tabs" style={{ flex: '0 0 31px' }}>
        {TABS.map((t) => (
          <button key={t.id} className={`result-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} data-testid={`ctx-tab-${t.id}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'tables' ? (
        <>
          <div className="tool-row">
            <div className="search-box" style={{ width: 220 }}>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr("筛选表名…")} data-testid="ctx-filter" />
            </div>
            <button className="btn small" onClick={() => bulk(true)} disabled={busy || !visibleTables.length}>{tr("全部启用")}</button>
            <button className="btn small" onClick={() => bulk(false)} disabled={busy || !visibleTables.length}>{tr("全部禁用")}</button>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 10.5 }}>
              {tr(" 未配置的表默认启用；禁用的表不会出现在模型的 schema 里 ")}</span>
          </div>
          <div className="tool-scroll">
            {!tables.length ? <div className="dash-empty">{tr("该库的表尚未加载，点击左侧库名或稍候重试。")}</div> : null}
            <table className="ctx-grid" data-testid="ctx-table-grid">
              <thead>
                <tr><th style={{ width: 46 }}>{tr("启用")}</th><th style={{ width: 200 }}>{tr("表")}</th><th style={{ width: 160 }}>{tr("业务别名")}</th><th>{tr("业务描述（模型看到的语义）")}</th></tr>
              </thead>
              <tbody>
                {visibleTables.map((t) => {
                  const entry = tableEntries.get(lower(t.name));
                  const isOn = !disabled.has(lower(t.name));
                  return (
                    <tr key={t.name} className={isOn ? '' : 'ctx-off'}>
                      <td>
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={(e) => setTableEnabled(t.name, e.target.checked)}
                          data-testid={`ctx-enable-${t.name}`}
                        />
                      </td>
                      <td>
                        <button className="link-btn" onClick={() => { setSelectedTable(t.name); setTab('columns'); }}>{t.name}</button>
                        <span className="muted" style={{ fontSize: 10 }}> {t.type === 'view' ? 'view' : ''}{t.rowEstimate !== undefined ? ` ~${t.rowEstimate}` : ''}</span>
                      </td>
                      <td>
                        <input
                          className="input"
                          defaultValue={entry?.alias ?? ''}
                          placeholder={t.comment ? t.comment.slice(0, 20) : tr("如：线索表")}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next !== (entry?.alias ?? '')) commitTableMeta(t.name, { alias: next || null });
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          defaultValue={entry?.description ?? ''}
                          placeholder={tr("这张表存什么、有哪些状态、口径是什么")}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next !== (entry?.description ?? '')) commitTableMeta(t.name, { description: next || null });
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'columns' ? (
        <>
          <div className="tool-row">
            <Select className="select" value={selectedTable} onChange={(e) => setSelectedTable(e.target.value)} data-testid="ctx-column-table">
              <Option value="">{tr("选择表…")}</Option>
              {tables.map((t) => (
                <Option key={t.name} value={t.name}>{t.name}</Option>
              ))}
            </Select>
            {currentTable ? <span className="muted" style={{ fontSize: 10.5 }}>{currentTable.columns?.length ?? 0}{tr(" 列")}</span> : null}
          </div>
          <div className="tool-scroll">
            {!currentTable ? <div className="dash-empty">{tr("选择一张表以编辑字段的启用状态、业务别名与取值释义。")}</div> : null}
            {currentTable ? (
              <table className="ctx-grid">
                <thead>
                  <tr><th style={{ width: 46 }}>{tr("启用")}</th><th style={{ width: 180 }}>{tr("字段")}</th><th style={{ width: 130 }}>{tr("类型")}</th><th style={{ width: 150 }}>{tr("业务别名")}</th><th>{tr("描述 / 枚举释义")}</th></tr>
                </thead>
                <tbody>
                  {(currentTable.columns ?? []).map((c) => {
                    const entry = columnEntries.get(`${lower(currentTable.name)}\u0000${lower(c.name)}`);
                    const isOn = !(bundle.disabledColumns[lower(currentTable.name)] ?? []).includes(lower(c.name));
                    return (
                      <tr key={c.name} className={isOn ? '' : 'ctx-off'}>
                        <td>
                          <input type="checkbox" checked={isOn} onChange={(e) => setColumnEnabled(currentTable.name, c.name, e.target.checked)} />
                        </td>
                        <td>{c.name}{c.primaryKey ? <span className="badge" style={{ marginLeft: 4 }}>PK</span> : null}</td>
                        <td className="muted">{c.type}</td>
                        <td>
                          <input
                            className="input"
                            defaultValue={entry?.alias ?? ''}
                            placeholder={c.comment ? c.comment.slice(0, 16) : tr("如：客户名称")}
                            onBlur={(e) => {
                              const next = e.target.value.trim();
                              if (next !== (entry?.alias ?? '')) commitColumnMeta(currentTable.name, c.name, { alias: next || null });
                            }}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            defaultValue={entry?.description ?? ''}
                            placeholder={tr("枚举值：FOLLOWING=跟进中，NEW=新建")}
                            onBlur={(e) => {
                              const next = e.target.value.trim();
                              if (next !== (entry?.description ?? '')) commitColumnMeta(currentTable.name, c.name, { description: next || null });
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === 'relations' ? (
        <div className="tool-scroll">
          <div className="ctx-section">
            <div className="ctx-section-head">{tr("来自外键的关系（只读）")}</div>
            {tables.some((t) => t.foreignKeys?.length) ? (
              <table className="ctx-grid">
                <tbody>
                  {tables.flatMap((t) =>
                    (t.foreignKeys ?? []).map((fk, i) => (
                      <tr key={`${t.name}-${i}`}>
                        <td style={{ width: 220 }}>{t.name}.{fk.columns.join(',')}</td>
                        <td style={{ width: 24 }} className="muted">→</td>
                        <td>{fk.refTable}.{fk.refColumns.join(',')}</td>
                        <td className="muted" style={{ width: 90 }}>{tr("外键")}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            ) : (
              <div className="dash-empty">{tr("该库没有物理外键。下面的手工关系可以让模型在没有外键的库上也能正确 JOIN。")}</div>
            )}
          </div>

          <div className="ctx-section">
            <div className="ctx-section-head">{tr("手工维护的关系（注入 prompt，指导 JOIN）")}</div>
            <div className="tool-row">
              <Select className="select" value={draftRelation.table} onChange={(e) => setDraftRelation({ ...draftRelation, table: e.target.value })}>
                <Option value="">{tr("左表…")}</Option>
                {tables.map((t) => <Option key={t.name} value={t.name}>{t.name}</Option>)}
              </Select>
              <input className="input" style={{ width: 120 }} placeholder={tr("左列")} value={draftRelation.column} onChange={(e) => setDraftRelation({ ...draftRelation, column: e.target.value })} />
              <span className="muted">→</span>
              <Select className="select" value={draftRelation.refTable} onChange={(e) => setDraftRelation({ ...draftRelation, refTable: e.target.value })}>
                <Option value="">{tr("右表…")}</Option>
                {tables.map((t) => <Option key={t.name} value={t.name}>{t.name}</Option>)}
              </Select>
              <input className="input" style={{ width: 120 }} placeholder={tr("右列")} value={draftRelation.refColumn} onChange={(e) => setDraftRelation({ ...draftRelation, refColumn: e.target.value })} />
              <input className="input" style={{ width: 180 }} placeholder={tr("备注（可选）")} value={draftRelation.description} onChange={(e) => setDraftRelation({ ...draftRelation, description: e.target.value })} />
              <button className="btn small primary" onClick={addRelation} disabled={busy} data-testid="ctx-add-relation"><Plus size={11} /> {tr(" 添加")}</button>
            </div>
            {relations.length ? (
              <table className="ctx-grid">
                <tbody>
                  {relations.map((r) => (
                    <tr key={r.id}>
                      <td style={{ width: 220 }}>{r.table}.{r.column}</td>
                      <td style={{ width: 24 }} className="muted">→</td>
                      <td>{r.refTable}.{r.refColumn}</td>
                      <td className="muted">{r.description ?? ''}</td>
                      <td style={{ width: 40 }}>
                        <button className="icon-btn" onClick={() => void save(() => api.deleteContextEntry(r.id))} title={tr("删除")}><Trash2 size={11} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === 'terms' ? (
        <div className="tool-scroll">
          <div className="tool-row">
            <span className="muted" style={{ fontSize: 10.5 }}>{tr("术语与示例可导出为 CSV（Excel 直接打开不乱码），也可批量导入。")}</span>
            <span className="spacer" />
            <button className="btn small" onClick={exportCsv} disabled={busy || (!terms.length && !examples.length)} data-testid="ctx-export-csv"><Download size={11} /> {tr(" 导出 CSV ")}</button>
            <button className="btn small" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="ctx-import-csv"><Upload size={11} /> {tr(" 导入 CSV ")}</button>
            <input ref={fileRef} className="file-input" type="file" accept=".csv,text/csv" data-testid="ctx-import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ''; }} />
          </div>
          <div className="ctx-section">
            <div className="ctx-section-head">{tr("术语词典（消除简称 / 黑话歧义）")}</div>
            <div className="tool-row">
              <input className="input" style={{ width: 160 }} placeholder={tr("术语，如 JS")} value={draftTerm.title} onChange={(e) => setDraftTerm({ ...draftTerm, title: e.target.value })} />
              <input className="input grow" placeholder={tr("释义，如 JumpServer 堡垒机")} value={draftTerm.content} onChange={(e) => setDraftTerm({ ...draftTerm, content: e.target.value })} />
              <button className="btn small primary" onClick={() => addMemory('glossary', draftTerm, () => setDraftTerm({ title: '', content: '', synonyms: '' }))} disabled={busy}>
                <Plus size={11} /> {tr(" 添加术语 ")}</button>
            </div>
            <div className="tool-row">
              <input className="input grow" placeholder={tr("同义词（逗号分隔），如：堡垒机, 跳板机")} value={draftTerm.synonyms} onChange={(e) => setDraftTerm({ ...draftTerm, synonyms: e.target.value })} data-testid="ctx-term-synonyms" />
            </div>
            {terms.length ? (
              <table className="ctx-grid">
                <tbody>
                  {terms.map((m) => (
                    <tr key={m.id}>
                      {editing?.id === m.id ? (
                        <>
                          <td><input className="input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} data-testid="ctx-edit-title" /></td>
                          <td>
                            <input className="input" value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} data-testid="ctx-edit-content" />
                            <input className="input" style={{ marginTop: 4 }} placeholder={tr("同义词（逗号分隔）")} value={editing.synonyms} onChange={(e) => setEditing({ ...editing, synonyms: e.target.value })} data-testid="ctx-edit-synonyms" />
                          </td>
                          <td className="muted">{tr(MEMORY_KIND_LABELS[m.kind].zh)} · {m.scopeType}</td>
                          <td style={{ width: 70 }}>
                            <button className="icon-btn" onClick={() => saveEdit(m)} title={tr("保存")} data-testid="ctx-edit-save"><Check size={11} /></button>
                            <button className="icon-btn" onClick={() => setEditing(null)} title={tr("取消")} data-testid="ctx-edit-cancel"><X size={11} /></button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{ width: 160 }}><strong>{m.title}</strong></td>
                          <td>
                            {m.content}
                            {m.synonyms?.length ? (
                              <div className="ctx-synonyms" title={tr("同义词")}>
                                {m.synonyms.map((s) => <span key={s} className="badge">{s}</span>)}
                              </div>
                            ) : null}
                          </td>
                          <td style={{ width: 110 }} className="muted">{tr(MEMORY_KIND_LABELS[m.kind].zh)} · {m.scopeType}</td>
                          <td style={{ width: 70 }}>
                            <button className="icon-btn" onClick={() => startEdit(m)} title={tr("编辑")} data-testid={`ctx-edit-term-${m.id}`}><Pencil size={11} /></button>
                            <button className="icon-btn" onClick={() => removeMemory(m.id)} title={tr("删除")}><Trash2 size={11} /></button>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="dash-empty">{tr("还没有术语。对话里说「记住 JS 就是 JumpServer」也会自动收录到这里。")}</div>
            )}
          </div>

          <div className="ctx-section">
            <div className="ctx-section-head">{tr("示例 SQL（标准问答对，作为 few-shot 校准统计口径）")}</div>
            <div className="ctx-section-form">
              <input className="input" placeholder={tr("标准问题，如：今年第三季度东区制造业赢单总数")} value={draftExample.title} onChange={(e) => setDraftExample({ ...draftExample, title: e.target.value })} />
              <textarea
                className="input ctx-sql"
                placeholder={tr("标准答案 SQL（会被截断到 600 字符注入 prompt）")}
                value={draftExample.content}
                onChange={(e) => setDraftExample({ ...draftExample, content: e.target.value })}
                rows={4}
              />
              <div className="tool-row">
                <span className="spacer" />
                <button className="btn small primary" onClick={() => addMemory('sql_example', draftExample, () => setDraftExample({ title: '', content: '' }))} disabled={busy}>
                  <Plus size={11} /> {tr(" 添加示例 ")}</button>
              </div>
            </div>
            {examples.length ? (
              <table className="ctx-grid">
                <tbody>
                  {examples.map((m) => (
                    <tr key={m.id}>
                      {editing?.id === m.id ? (
                        <>
                          <td><input className="input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} data-testid="ctx-edit-title" /></td>
                          <td><textarea className="input ctx-sql" rows={3} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} data-testid="ctx-edit-content" /></td>
                          <td style={{ width: 70 }}>
                            <button className="icon-btn" onClick={() => saveEdit(m)} title={tr("保存")} data-testid="ctx-edit-save"><Check size={11} /></button>
                            <button className="icon-btn" onClick={() => setEditing(null)} title={tr("取消")} data-testid="ctx-edit-cancel"><X size={11} /></button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{ width: 220 }}><strong>{m.title}</strong></td>
                          <td><pre className="ctx-pre">{m.content}</pre></td>
                          <td style={{ width: 70 }}>
                            <button className="icon-btn" onClick={() => startEdit(m)} title={tr("编辑")} data-testid={`ctx-edit-example-${m.id}`}><Pencil size={11} /></button>
                            <button className="icon-btn" onClick={() => removeMemory(m.id)} title={tr("删除")}><Trash2 size={11} /></button>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="designer-status">
        {busy ? <Loader2 size={11} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : null}
        <span className="muted">
          {entries.length ? tr("{0} 条配置生效中 · 改动即时写入，下一轮问数生效", [entries.length]) : tr("尚未配置：Agent 当前使用完整 schema，行为与默认一致")}
        </span>
      </div>
    </div>
  );
}
