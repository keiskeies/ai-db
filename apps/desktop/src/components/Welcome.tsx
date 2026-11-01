import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Database,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Table2,
  TerminalSquare,
  TrendingUp,
} from 'lucide-react';
import type { QueryHistoryItem } from '@aidb/core';
import { api } from '../lib/api';
import {
  computeFacts,
  engineLabel,
  formatCount,
  interestingHistory,
  isRelational,
  loadSuggestions,
  resolveHomeDatabase,
  scopeSchemas,
  type HomeSuggestion,
} from '../lib/dbHome';
import { formatDuration, formatRelative, sqlPreview } from '../lib/format';
import { useApp } from '../store';

/** 侧栏用的连接色，头部图标复用同一套，避免又引入一种颜色语义。 */
const CONNECTION_COLORS: Record<string, string> = {
  blue: '#5b93ff',
  green: '#46c46b',
  orange: '#e0a155',
  red: '#f16b62',
  purple: '#a78bfa',
  cyan: '#38bdf8',
  gray: '#7d8b9a',
};

/** 文件型连接的「库名」就是文件路径，塞进标题旁只会变成一串没用的长字符。 */
function isFileLike(database: string, connectionName: string): boolean {
  if (database === connectionName) return true;
  return /[\\/]/.test(database) || /\.(sqlite3?|duckdb|db)$/i.test(database);
}

/**
 * 欢迎页 = 当前库的家。
 *
 * 结构（方案 A）：一根「当前库」头部条 → 三栏工作区（库里的表 / 接下来能做什么）
 * → 一行「最近跑过」。整页只有「当前库」这一个作用域，不再混入全局统计。
 */
export function Welcome() {
  const t = useApp((s) => s.t);
  const connections = useApp((s) => s.connections);
  const schemas = useApp((s) => s.schemas);
  const loadedDatabases = useApp((s) => s.loadedDatabases);
  const schemaLoading = useApp((s) => s.schemaLoading);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const homeDatabase = useApp((s) => s.homeDatabase);
  const setHomeDatabase = useApp((s) => s.setHomeDatabase);
  const loadSchema = useApp((s) => s.loadSchema);
  const openConnectionEditor = useApp((s) => s.openConnectionEditor);
  const openQuery = useApp((s) => s.openQuery);
  const openData = useApp((s) => s.openData);
  const openDashboard = useApp((s) => s.openDashboard);
  const setAgentOpen = useApp((s) => s.setAgentOpen);
  const prefillAgent = useApp((s) => s.prefillAgent);
  const requestAgentTask = useApp((s) => s.requestAgentTask);
  const selectConnection = useApp((s) => s.selectConnection);
  const toggleConnection = useApp((s) => s.toggleConnection);
  const expandedConnections = useApp((s) => s.expandedConnections);

  const connection = connections.find((item) => item.id === activeConnectionId) ?? connections[0];
  const connectionSchemas = connection ? schemas[connection.id] : undefined;
  const database = resolveHomeDatabase(connection, connectionSchemas, homeDatabase);
  const scoped = useMemo(
    () => scopeSchemas(connection, connectionSchemas, database),
    [connection, connectionSchemas, database],
  );
  const relational = isRelational(connection);
  const facts = useMemo(() => computeFacts(scoped, relational), [scoped, relational]);

  const dbLoading = Boolean(connection && database && schemaLoading[`${connection.id}:${database}`]);
  const dbLoaded = Boolean(
    connection && (database ? (loadedDatabases[connection.id] ?? []).includes(database) : (connectionSchemas ?? []).length > 0),
  );

  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [suggestions, setSuggestions] = useState<HomeSuggestion[]>([]);
  const [pickingDb, setPickingDb] = useState(false);

  // 库名变化就重新拉这个库的历史与建议 —— 首页的一切都跟着它走
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    setHistory([]);
    api
      .history({ connectionId: connection.id, limit: 20 })
      .then((result) => {
        if (cancelled) return;
        const items = result.items as QueryHistoryItem[];
        // 历史接口只按连接过滤：这里再按库筛一道，避免 MySQL 下看到别的库的 SQL
        const scopedItems = database
          ? items.filter((item) => !item.database || item.database === database)
          : items;
        setHistory(scopedItems);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection?.id, database]);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    setSuggestions([]);
    loadSuggestions(connection.id, database, 4).then((items) => {
      if (!cancelled) setSuggestions(items);
    });
    return () => {
      cancelled = true;
    };
  }, [connection?.id, database, facts.tableCount]);

  // 打开首页时，如果这个库的表还没内省过，补一次（首页数字必须是真的）
  useEffect(() => {
    if (!connection) return;
    if (dbLoaded || dbLoading) return;
    void loadSchema(connection.id, false, database || undefined);
  }, [connection?.id, database, dbLoaded, dbLoading, loadSchema]);

  const recent = useMemo(() => interestingHistory(history, 4), [history]);

  /**
   * 从首页进数据页时，顺带把左侧连接树展开到这张表所在的位置 ——
   * 用户从首页跳过去之后，侧栏应当已经指向同一个地方，而不是还要再找一次。
   */
  const openTable = (name: string, db: string) => {
    if (!connection) return;
    selectConnection(connection.id);
    if (!expandedConnections[connection.id]) toggleConnection(connection.id);
    setHomeDatabase(db || database);
    openData(connection.id, name, db || undefined);
  };

  /** 首页所有 AI 入口都走这里：运行态由 store 的守卫统一裁决。 */
  const askAi = (prompt: string) => {
    requestAgentTask(prompt);
  };

  const healthPrompt = `对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。`;

  // ---------------------------------------------------------------- 没有连接
  if (!connection) {
    return (
      <div className="welcome home">
        <div className="home-inner">
          <div className="home-empty">
            <div className="home-empty-mark">
              <Database size={22} />
            </div>
            <h1>还没有连接数据库</h1>
            <p>
              建一个连接，或者先用内置示例库跑一遍 —— 示例库有订单、商品、用户四张表，
              可以直接试 SQL、图表和 AI 提问。
            </p>
            <div className="home-empty-actions">
              <button className="btn primary" onClick={() => openConnectionEditor('new')} data-testid="welcome-new-connection">
                <Plus size={13} /> 新建连接
              </button>
              <button className="btn" onClick={() => askAi('帮我建一个示例数据库并演示几个查询。')}>
                <Sparkles size={13} /> 让 AI 帮我建
              </button>
            </div>
            <p className="home-empty-hint">支持 41 种引擎：SQLite / MySQL / PostgreSQL / MongoDB / Redis / 图 / 向量 / 搜索…</p>
          </div>
        </div>
      </div>
    );
  }

  const dbOptions = (connectionSchemas ?? []).map((schema) => schema.name);
  const scopeLabel = database || connection.name;
  const loadingFacts = !dbLoaded || dbLoading;

  return (
    <div className="welcome home" data-testid="welcome-home">
      <div className="home-inner">
        {/* ── 当前库头部：整页唯一的作用域声明 ─────────────────────────── */}
        <header className="home-head">
          <div className="home-scope">
            <span
              className="home-scope-icon"
              style={{ color: CONNECTION_COLORS[connection.color] ?? CONNECTION_COLORS.blue, borderColor: 'transparent', background: 'var(--bg-app)' }}
            >
              <Database size={15} />
            </span>
            <div className="home-scope-text">
              <div className="home-scope-title">
                <h1 title={connection.name}>{connection.name}</h1>
                {dbOptions.length > 1 ? (
                  <button
                    className="home-db-switch"
                    onClick={() => setPickingDb((open) => !open)}
                    title="切换要看的库"
                    data-testid="welcome-db-switch"
                  >
                    {database || '选择库'}
                    <ChevronDown size={11} className={pickingDb ? 'flip' : ''} />
                  </button>
                ) : database && !isFileLike(database, connection.name) ? (
                  <span className="home-db-name mono" title={database}>
                    {database}
                  </span>
                ) : null}
              </div>
              <div className="home-scope-meta">
                <span>{engineLabel(connection)}</span>
                <span className="home-dot" />
                <span className={`env-pill ${connection.environment}`} style={{ padding: '0 5px', fontSize: 9 }}>
                  {connection.environment.toUpperCase()}
                </span>
                {connection.readonly ? (
                  <span className="home-ro">
                    <ShieldCheck size={10} /> 只读
                  </span>
                ) : null}
                <span className="home-dot" />
                {loadingFacts ? (
                  <span className="home-loading">
                    <Loader2 size={10} className="spin" /> 正在读取库结构…
                  </span>
                ) : (
                  <span data-testid="welcome-scope-summary">
                    {facts.tableCount} 表
                    {facts.viewCount ? ` · ${facts.viewCount} 视图` : ''}
                    {facts.rowKnown ? ` · ${formatCount(facts.rowTotal)} 行` : ''}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="home-actions">
            <button className="btn primary" onClick={() => openQuery(connection.id, undefined, undefined, database || undefined)} data-testid="welcome-new-query">
              <TerminalSquare size={13} /> 新建查询
            </button>
            <button className="btn" onClick={() => openDashboard(connection.id, database || undefined)} data-testid="welcome-dashboard-link">
              <TrendingUp size={13} /> 仪表板
            </button>
            <button className="btn agent" onClick={() => askAi(healthPrompt)} data-testid="welcome-ask-ai">
              <Sparkles size={13} /> 让 AI 体检这个库
            </button>
            <button
              className="icon-btn"
              title="重新读取库结构"
              onClick={() => void loadSchema(connection.id, true, database || undefined)}
              data-testid="welcome-refresh"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          {pickingDb && dbOptions.length > 1 ? (
            <div className="home-db-menu">
              {dbOptions.map((name) => (
                <button
                  key={name}
                  className={`home-db-item ${name === database ? 'active' : ''}`}
                  onClick={() => {
                    setHomeDatabase(name);
                    setPickingDb(false);
                  }}
                >
                  <Database size={11} />
                  <span className="truncate">{name}</span>
                </button>
              ))}
            </div>
          ) : null}
        </header>

        {/* ── 三栏工作区 ──────────────────────────────────────────── */}
        <div className="home-grid">
          {/* 这个库里有什么 */}
          <section className="home-col home-col-main">
            <div className="home-col-head">
              <span className="home-col-title">
                <Table2 size={12} /> 这个库里有什么
              </span>
              <span className="home-col-count">{facts.tables.length}</span>
              <div className="spacer" />
              {facts.keylessCount ? (
                <span className="home-warn" title="这些表既没有主键也没有唯一索引，无法安全定位单行">
                  <AlertTriangle size={10} /> {facts.keylessCount} 张无主键
                </span>
              ) : facts.tableCount ? (
                <span className="home-ok">
                  <ShieldCheck size={10} /> 主键齐全
                </span>
              ) : null}
            </div>

            {loadingFacts && !facts.tables.length ? (
              <div className="home-skeleton">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="home-skeleton-row" />
                ))}
              </div>
            ) : facts.tables.length ? (
              <div className="home-table-list">
                {facts.tables.slice(0, 10).map((fact) => (
                  <button
                    key={`${fact.database}.${fact.table.name}`}
                    className="home-table-row"
                    onClick={() => openTable(fact.table.name, fact.database)}
                    title={`打开 ${fact.table.name}`}
                    data-testid={`welcome-table-${fact.table.name}`}
                  >
                    <span className="home-table-kind">
                      {fact.table.type === 'view' ? <span className="status-led view" /> : null}
                      <span className="home-table-name mono">{fact.table.name}</span>
                    </span>
                    <span className="home-table-bar" aria-hidden="true">
                      {typeof fact.rows === 'number' && facts.largest?.rows ? (
                        <span
                          style={{
                            width: `${Math.max(3, Math.round((fact.rows / facts.largest.rows) * 100))}%`,
                          }}
                        />
                      ) : null}
                    </span>
                    <span className="home-table-rows mono">{typeof fact.rows === 'number' ? formatCount(fact.rows) : '—'}</span>
                    <span className="home-table-cols">{fact.columns} 列</span>
                    {fact.keyless ? (
                      <span className="home-table-flag" title="无主键/唯一索引">
                        <KeyRound size={9} />
                      </span>
                    ) : null}
                    <ArrowRight size={11} className="home-table-open" />
                  </button>
                ))}
                {facts.tables.length > 10 ? (
                  <button className="home-more" onClick={() => askAi(`列出 ${scopeLabel} 里全部 ${facts.tables.length} 张表，并说明每张表大概存什么。`)}>
                    还有 {facts.tables.length - 10} 张表 · 让 AI 介绍全部
                    <ArrowRight size={10} />
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="home-empty-block">
                <p>这个库里还没有表。</p>
                <div className="home-empty-actions">
                  <button className="btn small" onClick={() => askAi(`帮我在 ${scopeLabel} 里设计并创建需要的表结构。`)}>
                    <Sparkles size={11} /> 让 AI 建表
                  </button>
                </div>
              </div>
            )}

            {/* 体检摘要：把「要问 AI 才知道」的库健康度直接摆在表清单下面 */}
            {!loadingFacts && facts.tables.length ? (
              <div className="home-health">
                <span className="home-health-title">
                  <ShieldCheck size={11} /> 体检
                </span>
                <span className="home-health-item">
                  {facts.rowKnown === facts.tables.length ? '行数已全部估算' : `${facts.rowKnown}/${facts.tables.length} 张有行数估算`}
                </span>
                <span className={`home-health-item ${facts.keylessCount ? 'warn' : ''}`}>
                  {facts.keylessCount ? `${facts.keylessCount} 张无主键` : '主键齐全'}
                </span>
                {facts.emptyCount ? <span className="home-health-item warn">{facts.emptyCount} 张空表</span> : null}
                <div className="spacer" />
                <button className="btn ghost small" onClick={() => askAi(healthPrompt)} data-testid="welcome-health">
                  让 AI 深入体检
                </button>
              </div>
            ) : null}
          </section>

          {/* 接下来能做什么 */}
          <section className="home-col home-col-side">
            <div className="home-col-head">
              <span className="home-col-title">
                <Sparkles size={12} /> 接下来能做什么
              </span>
              <div className="spacer" />
              <button className="btn ghost small" onClick={() => setAgentOpen(true)}>
                打开助手
              </button>
            </div>

            <div className="home-suggest-list">
              {suggestions.length ? (
                suggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    className="home-suggest"
                    onClick={() => askAi(suggestion.prompt)}
                    title={suggestion.reason}
                    data-testid={`welcome-suggest-${suggestion.kind}`}
                  >
                    <span className="home-suggest-label">{suggestion.label}</span>
                    <span className="home-suggest-prompt">{suggestion.prompt}</span>
                    <ArrowRight size={10} className="home-suggest-go" />
                  </button>
                ))
              ) : (
                <div className="home-empty-block">
                  <p>{loadingFacts ? '正在按这个库的表生成建议…' : '这个库还没法生成建议，直接问 AI 也行。'}</p>
                </div>
              )}
            </div>

            <div className="home-quick">
              <button className="home-quick-item" onClick={() => askAi(healthPrompt)}>
                <ShieldCheck size={12} />
                <span>
                  <strong>数据库体检</strong>
                  <em>主键 / 外键索引 / 重复索引 / 空表</em>
                </span>
              </button>
              <button className="home-quick-item" onClick={() => askAi(`总结 ${scopeLabel} 的关键业务口径，并写入长期记忆。`)}>
                <Database size={12} />
                <span>
                  <strong>沉淀业务口径</strong>
                  <em>跨会话记住这个库的口径</em>
                </span>
              </button>
            </div>
          </section>
        </div>

        {/* ── 最近跑过 ──────────────────────────────────────────── */}
        <footer className="home-recent">
          <span className="home-recent-label">最近跑过</span>
          {recent.length ? (
            <div className="home-recent-list">
              {recent.map((item) => (
                <button
                  key={item.id}
                  className="home-recent-chip"
                  onClick={() => openQuery(connection.id, item.sql, undefined, database || undefined)}
                  title={`${item.sql}\n${formatRelative(item.createdAt)}`}
                >
                  <span className={`status-led ${item.status === 'ok' ? 'ok' : 'error'}`} />
                  <span className="home-recent-sql mono">{sqlPreview(item.sql, 46)}</span>
                  <span className="home-recent-meta">{formatDuration(item.durationMs)}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="home-recent-empty">还没有查询记录 —— 跑第一条 SQL 会出现在这里</span>
          )}
        </footer>
      </div>
    </div>
  );
}
