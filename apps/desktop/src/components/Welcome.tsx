import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Brain,
  Database,
  Plus,
  ShieldCheck,
  Sparkles,
  Table2,
  TerminalSquare,
  TrendingUp,
  Zap,
} from 'lucide-react';
import type { QueryHistoryItem } from '@aidb/core';
import { api } from '../lib/api';
import { formatDuration, formatRelative, sqlPreview } from '../lib/format';
import { useApp } from '../store';

export function Welcome() {
  const t = useApp((s) => s.t);
  const connections = useApp((s) => s.connections);
  const schemas = useApp((s) => s.schemas);
  const tools = useApp((s) => s.tools);
  const sessions = useApp((s) => s.sessions);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const openConnectionEditor = useApp((s) => s.openConnectionEditor);
  const openQuery = useApp((s) => s.openQuery);
  const openData = useApp((s) => s.openData);
  const setAgentOpen = useApp((s) => s.setAgentOpen);
  const prefillAgent = useApp((s) => s.prefillAgent);
  const loadAgentSession = useApp((s) => s.loadAgentSession);
  const selectConnection = useApp((s) => s.selectConnection);
  const toggleConnection = useApp((s) => s.toggleConnection);

  const [history, setHistory] = useState<QueryHistoryItem[]>([]);

  const active = connections.find((c) => c.id === activeConnectionId) ?? connections[0];
  const activeSchemas = active ? schemas[active.id] ?? [] : [];
  const tables = activeSchemas.flatMap((s) => s.tables);
  const totalRows = tables.reduce((sum, table) => sum + (table.rowEstimate ?? 0), 0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api
      .history({ connectionId: active.id, limit: 6 })
      .then((result) => !cancelled && setHistory(result.items as QueryHistoryItem[]))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active?.id]);

  const openDemo = () => {
    if (!active) {
      openConnectionEditor('new');
      return;
    }
    selectConnection(active.id);
    toggleConnection(active.id);
    const orders = tables.find((table) => table.name === 'orders') ?? tables[0];
    if (orders) openData(active.id, orders.name, activeSchemas.find((schema) => schema.tables.includes(orders))?.name);
  };

  const askAi = () => {
    setAgentOpen(true);
    prefillAgent('帮我快速了解这个数据库：有哪些表、数据量如何、可以做哪些分析？');
  };

  const skills = [
    { icon: <ShieldCheck size={14} />, label: '数据库体检', desc: '主键 / 外键索引 / 重复索引 / 空表', prompt: '对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。' },
    { icon: <TrendingUp size={14} />, label: '画图分析', desc: '把聚合结果渲染成图表', prompt: tables.find((x) => x.name === 'orders') ? '按 status 统计 orders 并画柱状图。' : '按第一个分组列统计并画柱状图。' },
    { icon: <Activity size={14} />, label: '数据质量', desc: '空值 / 空串 / 重复主键 / 基数', prompt: tables.find((x) => x.name === 'orders') ? '检查 orders 的空值、空串和重复主键，并给出排查 SQL。' : '检查当前表的空值、空串和重复主键。' },
    { icon: <Brain size={14} />, label: '记忆沉淀', desc: '跨会话记住业务口径', prompt: '总结当前库的关键业务口径，并写入长期记忆。' },
  ];

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <div className="welcome-mark">
            <Zap size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <h1>{t('welcomeTitle')}</h1>
            <p className="lead">{t('welcomeSubtitle')}</p>
          </div>
          <button className="btn ai" onClick={askAi}>
            <Sparkles size={12} /> {t('askAI')}
          </button>
        </div>

        <div className="welcome-grid">
          <button className="welcome-card" onClick={openDemo} data-testid="welcome-open-demo">
            <span className="wc-icon">
              <Database size={15} />
            </span>
            <h3>{t('openDemo')}</h3>
            <p>{active ? `${active.name} · ${tables.length} ${t('table')}` : '创建一个 SQLite 示例库并立即体验'}</p>
          </button>
          <button className="welcome-card" onClick={() => openQuery()} data-testid="welcome-new-query">
            <span className="wc-icon">
              <TerminalSquare size={15} />
            </span>
            <h3>{t('newQuery')}</h3>
            <p>多标签 SQL、方言高亮、结果集与历史</p>
          </button>
          <button className="welcome-card" onClick={() => openConnectionEditor('new')} data-testid="welcome-new-connection">
            <span className="wc-icon">
              <Plus size={15} />
            </span>
            <h3>{t('newConnection')}</h3>
            <p>8 种引擎 · SSH / SSL · 只读与环境标签</p>
          </button>
          <button className="welcome-card" onClick={askAi} data-testid="welcome-ask-ai">
            <span className="wc-icon" style={{ color: 'var(--agent)', background: 'var(--agent-soft)' }}>
              <Sparkles size={15} />
            </span>
            <h3>AI 数据库体检</h3>
            <p>可执行修复 SQL、数据质量与图表分析</p>
          </button>
        </div>

        <div className="welcome-metrics">
          <div className="metric">
            <span className="metric-label">连接</span>
            <strong>{connections.length}</strong>
            <em>SQLite / MySQL / PG / …</em>
          </div>
          <div className="metric">
            <span className="metric-label">对象</span>
            <strong>{tables.length}</strong>
            <em>表与视图</em>
          </div>
          <div className="metric">
            <span className="metric-label">数据量</span>
            <strong>{totalRows >= 1000 ? `${(totalRows / 1000).toFixed(1)}k` : totalRows.toLocaleString()}</strong>
            <em>估算行数</em>
          </div>
          <div className="metric accent">
            <span className="metric-label">Agent</span>
            <strong>{tools.length}</strong>
            <em>工具 · 四层记忆</em>
          </div>
        </div>

        <div className="welcome-dashboard">
          <div className="panel">
            <div className="panel-head">
              <Activity size={12} style={{ color: 'var(--accent)' }} /> 最近查询
              <span className="badge">{history.length}</span>
              <div className="spacer" />
              <button className="btn ghost small" onClick={() => openQuery()}>
                <Plus size={11} /> 新查询
              </button>
            </div>
            <div className="dash-list">
              {history.length ? (
                history.map((item) => (
                  <button key={item.id} className="dash-row" onClick={() => openQuery(active?.id, item.sql)} title={item.sql}>
                    <span className={`status-led ${item.status === 'ok' ? 'ok' : 'error'}`} />
                    <span className="dash-main mono">{sqlPreview(item.sql, 92)}</span>
                    <span className="dash-meta">{item.rowCount ?? 0} 行</span>
                    <span className="dash-meta">{formatDuration(item.durationMs)}</span>
                    <ArrowUpRight size={11} className="dash-open" />
                  </button>
                ))
              ) : (
                <div className="dash-empty">执行 SQL 或让 Agent 查询后，这里会出现活动记录。</div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <Table2 size={12} style={{ color: 'var(--accent)' }} /> 对象概览
              <span className="badge">{tables.length}</span>
            </div>
            <div className="dash-list">
              {tables.slice(0, 8).map((table) => (
                <button
                  key={table.name}
                  className="dash-row"
                  onClick={() => openData(active!.id, table.name, activeSchemas.find((schema) => schema.tables.includes(table))?.name)}
                >
                  {table.type === 'view' ? <span className="status-led view" /> : <Table2 size={11} style={{ color: 'var(--accent)' }} />}
                  <span className="dash-main mono">{table.name}</span>
                  <span className="dash-meta">{table.columns?.length ?? 0} 列</span>
                  <span className="dash-meta">{table.rowEstimate?.toLocaleString() ?? '—'} 行</span>
                </button>
              ))}
              {!tables.length ? <div className="dash-empty">连接数据库后加载对象结构。</div> : null}
            </div>
          </div>
        </div>

        <div className="welcome-dashboard">
          <div className="panel">
            <div className="panel-head">
              <Sparkles size={12} style={{ color: 'var(--agent)' }} /> AI 快捷能力
              <span className="badge agent">Local / Cloud</span>
            </div>
            <div className="skills-list">
              {skills.map((skill) => (
                <button
                  key={skill.label}
                  className="skill-row"
                  onClick={() => {
                    setAgentOpen(true);
                    prefillAgent(skill.prompt);
                  }}
                >
                  <span className="skill-icon">{skill.icon}</span>
                  <span className="skill-text">
                    <strong>{skill.label}</strong>
                    <em>{skill.desc}</em>
                  </span>
                  <ArrowUpRight size={11} />
                </button>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <TerminalSquare size={12} style={{ color: 'var(--agent)' }} /> 最近会话
              <div className="spacer" />
              <button className="icon-btn" onClick={() => void loadAgentSession(sessions[0]?.id)} disabled={!sessions.length}>
                <ArrowUpRight size={12} />
              </button>
            </div>
            <div className="dash-list">
              {sessions.length ? (
                sessions.slice(0, 5).map((session) => (
                  <button key={session.id} className="dash-row" onClick={() => void loadAgentSession(session.id)}>
                    <span className="status-led agent" />
                    <span className="dash-main truncate">{session.title}</span>
                    <span className="dash-meta">{formatRelative(session.updatedAt)}</span>
                  </button>
                ))
              ) : (
                <div className="dash-empty">还没有会话。向 AI 提一个具体问题开始。</div>
              )}
            </div>
          </div>
        </div>

        <div className="welcome-footnote">
          <span className="badge">{connections.length} 连接</span>
          <span className="badge">{tables.length} 对象</span>
          <span className="badge agent">{tools.length} Agent 工具</span>
          <span className="badge">四层记忆</span>
          <span className="muted">{t('welcome_tip')}</span>
        </div>
      </div>
    </div>
  );
}
