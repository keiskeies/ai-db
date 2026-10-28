import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookMarked, Columns3, Link2, Loader2, Plus, Table2, Trash2 } from 'lucide-react';
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
import { useApp } from '../../store';

type Tab = 'tables' | 'columns' | 'relations' | 'terms';

const TABS: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: 'tables', label: '表管理', icon: <Table2 size={12} /> },
  { id: 'columns', label: '字段语义', icon: <Columns3 size={12} /> },
  { id: 'relations', label: '关联关系', icon: <Link2 size={12} /> },
  { id: 'terms', label: '术语与示例', icon: <BookMarked size={12} /> },
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
  const [draftTerm, setDraftTerm] = useState({ title: '', content: '' });
  const [draftExample, setDraftExample] = useState({ title: '', content: '' });
  const [draftRelation, setDraftRelation] = useState({ table: '', column: '', refTable: '', refColumn: '', description: '' });

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
      notify('error', '加载业务上下文失败', err?.message);
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
      if (okMessage) notify('success', '已保存', okMessage);
    } catch (err: any) {
      notify('error', '保存失败', err?.message);
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
      enabled ? '已启用' : '已禁用',
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
      notify('error', '关系不完整', '左表、左列、右表、右列都必填');
      return;
    }
    void save(
      () => api.putContextRelation({ connectionId: connId, database, table, column, refTable, refColumn, description: description || null }),
      `${table}.${column} → ${refTable}.${refColumn}`,
    );
    setDraftRelation({ table: '', column: '', refTable: '', refColumn: '', description: '' });
  };

  const clearAll = () => {
    if (!window.confirm(`清空「${conn?.name ?? connId}${database ? ` / ${database}` : ''}」的全部业务上下文配置？Agent 将回到默认行为。`)) return;
    void save(() => api.clearAgentContext(connId, database), '已清空');
  };

  const addMemory = (kind: 'glossary' | 'sql_example', draft: { title: string; content: string }, reset: () => void) => {
    if (!draft.title.trim() || !draft.content.trim()) {
      notify('error', '内容不完整', kind === 'glossary' ? '术语与释义都必填' : '问题与 SQL 都必填');
      return;
    }
    void (async () => {
      setBusy(true);
      try {
        await api.createMemory({ kind, title: draft.title.trim(), content: draft.content.trim(), connectionId: connId, database });
        reset();
        await reloadMemories();
        notify('success', '已保存', kind === 'glossary' ? '术语已加入词典' : '示例 SQL 已加入校准库');
      } catch (err: any) {
        notify('error', '保存失败', err?.message);
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
        notify('error', '删除失败', err?.message);
      }
    })();

  if (!connections.length) return <div className="dash-empty">请先创建一个数据库连接。</div>;

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <BookMarked size={15} /> Agent 业务上下文
        <span className="muted">给模型划定知识边界、注入业务语义，是问数准确率的直接来源</span>
      </div>

      <div className="tool-row">
        <select className="select" value={connId} onChange={(e) => { setConnId(e.target.value); setDatabase(''); }} data-testid="ctx-connection">
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select className="select" value={database} onChange={(e) => setDatabase(e.target.value)} data-testid="ctx-database">
          {databases.map((d) => (
            <option key={d.name} value={d.name}>{d.name}{d.tables.length ? '' : '（未加载）'}</option>
          ))}
        </select>
        <span className="spacer" />
        <span className="badge">{tables.length ? `启用 ${enabledCount}/${tables.length} 表` : '表未加载'}</span>
        <span className="badge agent" data-testid="ctx-tokens">上下文 ≈ {tokens.toLocaleString()} tokens</span>
        <button className="btn small danger" onClick={clearAll} disabled={busy || !entries.length} data-testid="ctx-clear">
          <Trash2 size={11} /> 清空配置
        </button>
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
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选表名…" data-testid="ctx-filter" />
            </div>
            <button className="btn small" onClick={() => bulk(true)} disabled={busy || !visibleTables.length}>全部启用</button>
            <button className="btn small" onClick={() => bulk(false)} disabled={busy || !visibleTables.length}>全部禁用</button>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 10.5 }}>
              未配置的表默认启用；禁用的表不会出现在模型的 schema 里
            </span>
          </div>
          <div className="tool-scroll">
            {!tables.length ? <div className="dash-empty">该库的表尚未加载，点击左侧库名或稍候重试。</div> : null}
            <table className="ctx-grid" data-testid="ctx-table-grid">
              <thead>
                <tr><th style={{ width: 46 }}>启用</th><th style={{ width: 200 }}>表</th><th style={{ width: 160 }}>业务别名</th><th>业务描述（模型看到的语义）</th></tr>
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
                          placeholder={t.comment ? t.comment.slice(0, 20) : '如：线索表'}
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
                          placeholder="这张表存什么、有哪些状态、口径是什么"
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
            <select className="select" value={selectedTable} onChange={(e) => setSelectedTable(e.target.value)} data-testid="ctx-column-table">
              <option value="">选择表…</option>
              {tables.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            {currentTable ? <span className="muted" style={{ fontSize: 10.5 }}>{currentTable.columns?.length ?? 0} 列</span> : null}
          </div>
          <div className="tool-scroll">
            {!currentTable ? <div className="dash-empty">选择一张表以编辑字段的启用状态、业务别名与取值释义。</div> : null}
            {currentTable ? (
              <table className="ctx-grid">
                <thead>
                  <tr><th style={{ width: 46 }}>启用</th><th style={{ width: 180 }}>字段</th><th style={{ width: 130 }}>类型</th><th style={{ width: 150 }}>业务别名</th><th>描述 / 枚举释义</th></tr>
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
                            placeholder={c.comment ? c.comment.slice(0, 16) : '如：客户名称'}
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
                            placeholder="枚举值：FOLLOWING=跟进中，NEW=新建"
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
            <div className="ctx-section-head">来自外键的关系（只读）</div>
            {tables.some((t) => t.foreignKeys?.length) ? (
              <table className="ctx-grid">
                <tbody>
                  {tables.flatMap((t) =>
                    (t.foreignKeys ?? []).map((fk, i) => (
                      <tr key={`${t.name}-${i}`}>
                        <td style={{ width: 220 }}>{t.name}.{fk.columns.join(',')}</td>
                        <td style={{ width: 24 }} className="muted">→</td>
                        <td>{fk.refTable}.{fk.refColumns.join(',')}</td>
                        <td className="muted" style={{ width: 90 }}>外键</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            ) : (
              <div className="dash-empty">该库没有物理外键。下面的手工关系可以让模型在没有外键的库上也能正确 JOIN。</div>
            )}
          </div>

          <div className="ctx-section">
            <div className="ctx-section-head">手工维护的关系（注入 prompt，指导 JOIN）</div>
            <div className="tool-row">
              <select className="select" value={draftRelation.table} onChange={(e) => setDraftRelation({ ...draftRelation, table: e.target.value })}>
                <option value="">左表…</option>
                {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              <input className="input" style={{ width: 120 }} placeholder="左列" value={draftRelation.column} onChange={(e) => setDraftRelation({ ...draftRelation, column: e.target.value })} />
              <span className="muted">→</span>
              <select className="select" value={draftRelation.refTable} onChange={(e) => setDraftRelation({ ...draftRelation, refTable: e.target.value })}>
                <option value="">右表…</option>
                {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              <input className="input" style={{ width: 120 }} placeholder="右列" value={draftRelation.refColumn} onChange={(e) => setDraftRelation({ ...draftRelation, refColumn: e.target.value })} />
              <input className="input" style={{ width: 180 }} placeholder="备注（可选）" value={draftRelation.description} onChange={(e) => setDraftRelation({ ...draftRelation, description: e.target.value })} />
              <button className="btn small primary" onClick={addRelation} disabled={busy} data-testid="ctx-add-relation"><Plus size={11} /> 添加</button>
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
                        <button className="icon-btn" onClick={() => void save(() => api.deleteContextEntry(r.id))} title="删除"><Trash2 size={11} /></button>
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
          <div className="ctx-section">
            <div className="ctx-section-head">术语词典（消除简称 / 黑话歧义）</div>
            <div className="tool-row">
              <input className="input" style={{ width: 160 }} placeholder="术语，如 JS" value={draftTerm.title} onChange={(e) => setDraftTerm({ ...draftTerm, title: e.target.value })} />
              <input className="input" style={{ flex: 1 }} placeholder="释义，如 JumpServer 堡垒机" value={draftTerm.content} onChange={(e) => setDraftTerm({ ...draftTerm, content: e.target.value })} />
              <button className="btn small primary" onClick={() => addMemory('glossary', draftTerm, () => setDraftTerm({ title: '', content: '' }))} disabled={busy}>
                <Plus size={11} /> 添加术语
              </button>
            </div>
            {terms.length ? (
              <table className="ctx-grid">
                <tbody>
                  {terms.map((m) => (
                    <tr key={m.id}>
                      <td style={{ width: 160 }}><strong>{m.title}</strong></td>
                      <td>{m.content}</td>
                      <td style={{ width: 110 }} className="muted">{MEMORY_KIND_LABELS[m.kind].zh} · {m.scopeType}</td>
                      <td style={{ width: 40 }}>
                        <button className="icon-btn" onClick={() => removeMemory(m.id)} title="删除"><Trash2 size={11} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="dash-empty">还没有术语。对话里说「记住 JS 就是 JumpServer」也会自动收录到这里。</div>
            )}
          </div>

          <div className="ctx-section">
            <div className="ctx-section-head">示例 SQL（标准问答对，作为 few-shot 校准统计口径）</div>
            <div className="ctx-section-form">
              <input className="input" placeholder="标准问题，如：今年第三季度东区制造业赢单总数" value={draftExample.title} onChange={(e) => setDraftExample({ ...draftExample, title: e.target.value })} />
              <textarea
                className="input ctx-sql"
                placeholder="标准答案 SQL（会被截断到 600 字符注入 prompt）"
                value={draftExample.content}
                onChange={(e) => setDraftExample({ ...draftExample, content: e.target.value })}
                rows={4}
              />
              <div className="tool-row">
                <span className="spacer" />
                <button className="btn small primary" onClick={() => addMemory('sql_example', draftExample, () => setDraftExample({ title: '', content: '' }))} disabled={busy}>
                  <Plus size={11} /> 添加示例
                </button>
              </div>
            </div>
            {examples.length ? (
              <table className="ctx-grid">
                <tbody>
                  {examples.map((m) => (
                    <tr key={m.id}>
                      <td style={{ width: 220 }}><strong>{m.title}</strong></td>
                      <td><pre className="ctx-pre">{m.content}</pre></td>
                      <td style={{ width: 40 }}>
                        <button className="icon-btn" onClick={() => removeMemory(m.id)} title="删除"><Trash2 size={11} /></button>
                      </td>
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
          {entries.length ? `${entries.length} 条配置生效中 · 改动即时写入，下一轮问数生效` : '尚未配置：Agent 当前使用完整 schema，行为与默认一致'}
        </span>
      </div>
    </div>
  );
}
