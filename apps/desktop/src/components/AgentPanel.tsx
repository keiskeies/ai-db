import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  AtSign,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock,
  Copy,
  Database,
  Expand,
  History,
  Loader2,
  MessageSquarePlus,
  Minimize2,
  PanelRightClose,
  Plus,
  ShieldAlert,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import type { AgentMessageBlock, PermissionMode, Risk, ToolResult } from '@aidb/core';
import { formatCell, formatDuration, formatRelative } from '../lib/format';
import { useApp, type LiveTool } from '../store';
import { ChartView, type ChartSpec } from './ChartView';
import { CopyButton, Markdown, RiskBadge } from './ui';

const MODE_OPTIONS: Array<{ value: PermissionMode; zh: string; en: string }> = [
  { value: 'readonly', zh: '只读', en: 'Read-only' },
  { value: 'ask', zh: '询问', en: 'Ask' },
  { value: 'auto', zh: '自动', en: 'Auto' },
  { value: 'full', zh: '全自动', en: 'Full auto' },
];

const SLASH = [
  { key: '/schema', label: '梳理库结构', prompt: '生成当前库的结构摘要：主要表、关系、字段含义与可疑点。' },
  { key: '/audit', label: '数据库体检', prompt: '对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。' },
  { key: '/quality', label: '数据质量', prompt: '检查 orders 的空值、空串和重复主键，并给出排查 SQL。' },
  { key: '/chart', label: '画图分析', prompt: '按 status 统计 orders 并画柱状图。' },
  { key: '/explain', label: '解释执行计划', prompt: '解释最近一次查询的执行计划，指出瓶颈并给出优化建议。' },
  { key: '/optimize', label: '优化 SQL', prompt: '优化当前 SQL，并给出索引建议和改写后的语句。' },
  { key: '/backup', label: '备份数据库', prompt: '备份当前数据库。' },
  { key: '/memory', label: '打开记忆', prompt: '' },
  { key: '/clear', label: '清空上下文（新会话）', prompt: '' },
];

function statusIcon(status: LiveTool['status']) {
  if (status === 'running') return <Loader2 size={11} className="spin" style={{ animation: 'spin .8s linear infinite' }} />;
  if (status === 'ok') return <Check size={11} style={{ color: 'var(--success)' }} />;
  if (status === 'awaiting') return <Clock size={11} style={{ color: 'var(--warning)' }} />;
  return <X size={11} style={{ color: 'var(--danger)' }} />;
}

function MiniTable({ data, max = 8 }: { data: { columns?: Array<{ name: string } | string>; rows?: unknown[][] }; max?: number }) {
  if (!data?.columns || !Array.isArray(data.rows)) return null;
  const names = data.columns.map((c) => (typeof c === 'string' ? c : c.name));
  const rows = data.rows.slice(0, max);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tool-table">
        <thead>
          <tr>{names.map((n) => <th key={n}>{n}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j} title={formatCell(v).text}>{formatCell(v).text}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > max ? <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>… 共 {data.rows.length} 行</div> : null}
    </div>
  );
}

function ResultView({ result, onOpenEditor }: { result: ToolResult; onOpenEditor?: (sql: string) => void }) {
  const data = result.data as Record<string, any> | undefined;
  const sql = typeof data?.sql === 'string' ? data.sql : undefined;
  const chart = data?.chart as ChartSpec | undefined;
  return (
    <div>
      <div className="tool-result-line">
        <span className={result.ok ? 'ok' : 'err'}>{result.ok ? '✓' : '✗'}</span>
        <span>{result.summary}</span>
        <span className="muted">· {formatDuration(result.meta.durationMs)}</span>
      </div>
      {result.error ? (
        <div style={{ color: 'var(--danger)', marginTop: 6 }}>
          {result.error.message}
          {result.error.hint ? <div className="muted" style={{ marginTop: 3 }}>{result.error.hint}</div> : null}
        </div>
      ) : null}
      {sql ? (
        <div className="sql-block" style={{ marginTop: 7 }}>
          {sql}
          <span style={{ position: 'absolute', top: 4, right: 4 }}>
            <CopyButton text={sql} />
          </span>
        </div>
      ) : null}
      {sql && onOpenEditor ? (
        <button className="btn ghost small" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => onOpenEditor(sql)}>
          <ArrowUpRight size={11} /> 打开到编辑器
        </button>
      ) : null}
      {chart ? (
        <div style={{ marginTop: 8 }}>
          <ChartView chart={chart} onOpenEditor={onOpenEditor} />
        </div>
      ) : null}
      {!chart && data?.ddl ? <div className="sql-block" style={{ marginTop: 7 }}>{data.ddl}</div> : null}
      {!chart && data?.columns && data?.rows ? (
        <div style={{ marginTop: 7 }}>
          <MiniTable data={data} />
        </div>
      ) : null}
      {!chart && !data?.columns && data?.tables ? (
        <div style={{ marginTop: 6 }}>
          {(data.tables as Array<{ name: string; columns?: unknown[] }>).slice(0, 30).map((tbl) => (
            <div key={tbl.name} className="mono" style={{ fontSize: 10.5 }}>
              {tbl.name} {tbl.columns?.length ? <span className="muted">· {tbl.columns.length} cols</span> : null}
            </div>
          ))}
          {(data.tables as unknown[]).length > 30 ? <div className="muted">…</div> : null}
        </div>
      ) : null}
      {data?.memories ? (
        <div style={{ marginTop: 6 }}>
          {(data.memories as Array<{ title: string; content: string; kind: string }>).slice(0, 6).map((m, i) => (
            <div key={i} style={{ fontSize: 10.5, marginTop: 3 }}>
              <span style={{ color: 'var(--agent)' }}>[{m.kind}]</span> {m.title} — <span className="muted">{m.content}</span>
            </div>
          ))}
        </div>
      ) : null}
      {data?.path ? <div className="mono" style={{ marginTop: 6, fontSize: 10.5, overflowWrap: 'anywhere' }}>{data.path}</div> : null}
      {data?.backupPath ? <div className="mono" style={{ marginTop: 6, fontSize: 10.5, overflowWrap: 'anywhere' }}>backup: {data.backupPath}</div> : null}
      {Array.isArray(data?.findings) && data.findings.length ? (
        <div className="findings">
          {data.findings.slice(0, 8).map((finding: any, index: number) => (
            <div key={index} className="finding">
              <div className="finding-head">
                <span className={`badge ${finding.severity === 'high' ? 'destructive' : finding.severity === 'medium' ? 'write' : finding.severity === 'low' ? 'ddl' : 'read'}`}>
                  {String(finding.severity).toUpperCase()}
                </span>
                <strong>{finding.title}</strong>
                {finding.table ? <span className="mono muted">{finding.table}</span> : null}
              </div>
              <div className="finding-detail">{finding.detail}</div>
              {finding.suggestedSql ? (
                <div className="sql-block finding-sql">
                  {finding.suggestedSql}
                  <span style={{ position: 'absolute', top: 4, right: 4 }}><CopyButton text={finding.suggestedSql} /></span>
                </div>
              ) : null}
              {finding.suggestedSql && onOpenEditor ? (
                <button className="btn ghost small" onClick={() => onOpenEditor(finding.suggestedSql)}>
                  <ArrowUpRight size={11} /> 打开到编辑器
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {!chart && Array.isArray(data?.columnStats) ? (
        <table className="tool-table stats-table">
          <thead>
            <tr><th>列</th><th>NULL</th><th>空串</th><th>不同值</th></tr>
          </thead>
          <tbody>
            {data.columnStats.slice(0, 12).map((stat: any) => (
              <tr key={stat.name}>
                <td>{stat.name}</td>
                <td>{stat.nulls} · {(Number(stat.nullRatio) * 100).toFixed(1)}%</td>
                <td>{stat.blanks ?? 0}</td>
                <td>{stat.distinct}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {data && !data.columns && !data.tables && !data.memories && !data.path && !data.ddl && !sql && !chart && !data.findings && !data.columnStats ? (
        <pre style={{ marginTop: 6, maxHeight: 160, overflow: 'auto' }}>{JSON.stringify(data, null, 2).slice(0, 2400)}</pre>
      ) : null}
    </div>
  );
}

function ToolCard({
  tool,
  args,
  risk,
  status,
  result,
  summary,
  live,
  onOpenEditor,
}: {
  tool: string;
  args: unknown;
  risk?: Risk;
  status: LiveTool['status'];
  result?: ToolResult;
  summary?: string;
  live?: boolean;
  onOpenEditor?: (sql: string) => void;
}) {
  const artifact = result?.data as Record<string, any> | undefined;
  const hasArtifact = Boolean(artifact?.chart || (Array.isArray(artifact?.findings) && artifact.findings.length));
  const [open, setOpen] = useState(status === 'error' || status === 'awaiting' || hasArtifact);
  useEffect(() => {
    if (hasArtifact) setOpen(true);
  }, [hasArtifact]);
  const sqlArg = args && typeof args === 'object' ? (args as Record<string, unknown>).sql : undefined;
  return (
    <div className={`tool-card status-${status}`} data-testid="tool-card">
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        {statusIcon(status)}
        <span className="tool-name">{tool}</span>
        <span className="tool-summary">{summary ?? (typeof sqlArg === 'string' ? sqlArg.replace(/\s+/g, ' ').slice(0, 70) : '')}</span>
        <RiskBadge risk={risk} />
        {result ? <span className="muted" style={{ fontSize: 10 }}>{formatDuration(result.meta.durationMs)}</span> : null}
        {status === 'awaiting' ? <span className="badge write">等待授权</span> : null}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </div>
      {open ? (
        <div className="tool-body">
          <div className="tool-section-label">参数</div>
          {typeof sqlArg === 'string' ? <pre>{String(sqlArg)}</pre> : <pre>{JSON.stringify(args, null, 2).slice(0, 4000)}</pre>}
          {result ? (
            <>
              <div className="tool-section-label">结果</div>
              <ResultView result={result} onOpenEditor={onOpenEditor} />
            </>
          ) : (
            <div className="tool-section-label">{live ? '执行中…' : '无结果'}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PlanCard({ items }: { items: Array<{ id: string; text: string; status: string }> }) {
  if (!items.length) return null;
  return (
    <div className="plan-card">
      <div className="plan-title">
        <Check size={11} /> 计划 · {items.filter((i) => i.status === 'done').length}/{items.length}
      </div>
      {items.map((item) => (
        <div key={item.id} className={`plan-item ${item.status}`}>
          <span className="plan-icon">{item.status === 'done' ? '✓' : ''}</span>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

function AssistantBlocks({ blocks, messageId }: { blocks: AgentMessageBlock[]; messageId: string }) {
  const openQuery = useApp((s) => s.openQuery);
  const results = new Map<string, ToolResult>();
  for (const block of blocks) if (block.type === 'tool_result' && block.callId) results.set(block.callId, block.result as ToolResult);
  const thinking = blocks.find((b) => b.type === 'thinking')?.text;
  return (
    <>
      {thinking ? (
        <details className="thinking">
          <summary><Brain size={11} /> 思考过程</summary>
          <div className="thinking-body">{thinking}</div>
        </details>
      ) : null}
      {blocks.map((block, index) => {
        if (block.type === 'tool_call') {
          const result = block.callId ? results.get(block.callId) : undefined;
          return (
            <ToolCard
              key={`${messageId}_${block.callId ?? index}`}
              tool={block.tool ?? 'tool'}
              args={block.args}
              risk={block.risk}
              status={result ? (result.ok ? 'ok' : 'error') : 'error'}
              result={result}
              onOpenEditor={(sql) => openQuery(undefined, sql)}
            />
          );
        }
        if (block.type === 'plan') return <PlanCard key={`${messageId}_plan_${index}`} items={block.items ?? []} />;
        return null;
      })}
    </>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg-user">
      <span className="prompt-mark">❯</span>
      <div className="bubble">{text}</div>
    </div>
  );
}

function AssistantShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="msg-assistant">
      <span className="avatar"><Sparkles size={11} /></span>
      <div className="content">{children}</div>
    </div>
  );
}

export function AgentPanel() {
  const t = useApp((s) => s.t);
  const agentOpen = useApp((s) => s.agentOpen);
  const expanded = useApp((s) => s.agentExpanded);
  const messages = useApp((s) => s.agentMessages);
  const live = useApp((s) => s.live);
  const approval = useApp((s) => s.approval);
  const sessions = useApp((s) => s.sessions);
  const sessionsOpen = useApp((s) => s.sessionsOpen);
  const agentSessionId = useApp((s) => s.agentSessionId);
  const sessionMeta = useApp((s) => s.agentSessionMeta);
  const settings = useApp((s) => s.settings);
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const schemas = useApp((s) => activeConnectionId ? s.schemas[activeConnectionId] : undefined);
  const agentMode = useApp((s) => s.agentMode);
  const prefill = useApp((s) => s.agentPrefill);

  const setAgentOpen = useApp((s) => s.setAgentOpen);
  const setAgentExpanded = useApp((s) => s.setAgentExpanded);
  const setAgentMode = useApp((s) => s.setAgentMode);
  const setSessionsOpen = useApp((s) => s.setSessionsOpen);
  const newAgentSession = useApp((s) => s.newAgentSession);
  const loadAgentSession = useApp((s) => s.loadAgentSession);
  const deleteAgentSession = useApp((s) => s.deleteAgentSession);
  const sendAgent = useApp((s) => s.sendAgent);
  const abortAgent = useApp((s) => s.abortAgent);
  const resolveApproval = useApp((s) => s.resolveApproval);
  const openMemory = useApp((s) => s.openMemory);
  const clearPrefill = useApp((s) => s.clearPrefill);
  const setActiveConnection = useApp((s) => s.setActiveConnection);
  const openQuery = useApp((s) => s.openQuery);

  const [input, setInput] = useState('');
  const [popover, setPopover] = useState<'none' | 'mention' | 'slash'>('none');
  const [mentionQuery, setMentionQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const tables = useMemo(() => (schemas ?? []).flatMap((s) => s.tables), [schemas]);
  const busy = live?.status === 'streaming' || live?.status === 'awaiting';

  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      clearPrefill();
      setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [prefill, clearPrefill]);

  useEffect(() => {
    if (live) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [live?.text, live?.thinking, live?.tools.length, live?.status, live?.plan, messages.length]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`;
  }, [input]);

  if (!agentOpen) return null;

  const providerLabel =
    settings.agent.provider === 'local' ? 'Local' : settings.agent.provider === 'anthropic' ? settings.agent.model.replace(/^claude-/, '') : settings.agent.model;
  const modeLabel = MODE_OPTIONS.find((m) => m.value === agentMode);
  const filteredSessions = sessions;

  const send = () => {
    if (!input.trim() || busy) return;
    const text = input;
    setInput('');
    setPopover('none');
    void sendAgent(text);
  };

  const onInput = (value: string) => {
    setInput(value);
    const mention = value.match(/@([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (mention) {
      setMentionQuery(mention[1] ?? '');
      setPopover('mention');
      return;
    }
    if (/^\/[A-Za-z]*$/.test(value)) {
      setPopover('slash');
      return;
    }
    if (popover !== 'mention' && popover !== 'slash') setPopover('none');
    if (popover === 'mention' && !mention) setPopover('none');
    if (popover === 'slash' && !value.startsWith('/')) setPopover('none');
  };

  const insertMention = (name: string) => {
    setInput((prev) => prev.replace(/@([A-Za-z_][A-Za-z0-9_]*)?$/, `@${name} `));
    setPopover('none');
    textareaRef.current?.focus();
  };

  const runSlash = (key: string) => {
    if (key === '/memory') {
      openMemory();
      setInput('');
      setPopover('none');
      return;
    }
    if (key === '/clear') {
      void newAgentSession();
      setInput('');
      setPopover('none');
      return;
    }
    const command = SLASH.find((c) => c.key === key);
    if (command) {
      setInput(command.prompt);
      setPopover('none');
      textareaRef.current?.focus();
    }
  };

  const renderPersisted = (message: (typeof messages)[number]) => {
    if (message.role === 'user') return <UserMessage key={message.id} text={message.content} />;
    const toolCount = message.blocks.filter((b) => b.type === 'tool_call').length;
    return (
      <AssistantShell key={message.id}>
        {message.content ? <Markdown>{message.content}</Markdown> : null}
        <AssistantBlocks blocks={message.blocks} messageId={message.id} />
        {toolCount ? <div className="turn-end">{toolCount} 次工具调用</div> : null}
      </AssistantShell>
    );
  };

  return (
    <aside className={`agent-panel ${expanded ? 'expanded' : ''}`} data-testid="agent-panel">
      <div className="agent-head">
        <div className="agent-title">
          <span className="agent-dot">AI</span>
          <span>AI 助手</span>
        </div>
        <span className="badge agent" style={{ fontSize: 9 }}>{providerLabel}</span>
        <div className="spacer" />
        <button className="icon-btn" title={t('sessions')} onClick={() => setSessionsOpen(!sessionsOpen)} data-testid="agent-sessions">
          <History size={14} />
        </button>
        <button className="icon-btn" title={t('memory')} onClick={openMemory} data-testid="agent-memory">
          <Brain size={14} />
        </button>
        <button className="icon-btn" title={t('newSession')} onClick={() => void newAgentSession()} data-testid="agent-new-session">
          <MessageSquarePlus size={14} />
        </button>
        <button className="icon-btn" title={expanded ? 'collapse' : 'expand'} onClick={() => setAgentExpanded(!expanded)}>
          {expanded ? <Minimize2 size={14} /> : <Expand size={14} />}
        </button>
        <button className="icon-btn" title={t('close')} onClick={() => setAgentOpen(false)}>
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className="agent-sub">
        <Database size={11} />
        <select
          className="mode-select"
          style={{ border: 'none', background: 'transparent', maxWidth: 150 }}
          value={activeConnectionId ?? ''}
          onChange={(e) => setActiveConnection(e.target.value || undefined)}
          title={t('connections')}
        >
          <option value="">未选择连接</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <span>·</span>
        <span>{sessionMeta?.title ?? t('emptyAgentTitle')}</span>
        <div className="spacer" />
        <span title={settings.agent.hasApiKey ? 'API key configured' : t('noApiKey')} style={{ color: settings.agent.provider !== 'local' && !settings.agent.hasApiKey ? 'var(--warning)' : undefined }}>
          {settings.agent.provider === 'local' ? 'offline' : settings.agent.model}
        </span>
      </div>

      <div className="agent-transcript" ref={scrollRef}>
        {!messages.length && !live ? (
          <div className="agent-empty">
            <div className="hero"><Sparkles size={22} /></div>
            <h3>{t('emptyAgentTitle')}</h3>
            <p>{t('emptyAgentHint')}</p>
            <div className="cap-grid">
              {[
                { icon: <ShieldAlert size={13} />, label: '数据库体检', prompt: '对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。' },
                { icon: <Sparkles size={13} />, label: '画图分析', prompt: tables.find((x) => x.name === 'orders') ? '按 status 统计 orders 并画柱状图。' : '按第一个分组列统计并画柱状图。' },
                { icon: <Check size={13} />, label: '数据质量', prompt: tables.find((x) => x.name === 'orders') ? '检查 orders 的空值、空串和重复主键，并给出排查 SQL。' : '检查当前表的空值、空串和重复主键。' },
                { icon: <Database size={13} />, label: '备份数据库', prompt: '备份当前数据库。' },
              ].map((cap) => (
                <button key={cap.label} className="cap-card" onClick={() => setInput(cap.prompt)}>
                  {cap.icon}
                  {cap.label}
                </button>
              ))}
            </div>
            {sessions.length ? (
              <div style={{ marginTop: 18, textAlign: 'left' }}>
                <div className="plan-title" style={{ padding: '0 2px' }}>{t('recent')}</div>
                {sessions.slice(0, 3).map((session) => (
                  <button key={session.id} className="recent-item" onClick={() => void loadAgentSession(session.id)}>
                    <TerminalSquare size={12} style={{ color: 'var(--agent)' }} />
                    <span className="truncate" style={{ flex: 1 }}>{session.title}</span>
                    <span className="muted" style={{ fontSize: 9.5 }}>{formatRelative(session.updatedAt)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {messages.map(renderPersisted)}

        {live ? (
          <>
            <UserMessage text={live.userText} />
            <AssistantShell>
              {live.thinking ? (
                <details className="thinking" open={!live.text && !live.tools.length}>
                  <summary><Brain size={11} /> {t('thinking')}</summary>
                  <div className="thinking-body">{live.thinking}</div>
                </details>
              ) : null}
              {live.memories.length ? (
                <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
                  {live.memories.map((m) => (
                    <span key={m.id} className="memory-pill"><Brain size={9} /> {m.title}</span>
                  ))}
                </div>
              ) : null}
              {live.text ? (
                <div className="prose">
                  <Markdown>{live.text}</Markdown>
                  {busy ? <span className="typing-caret" /> : null}
                </div>
              ) : busy ? (
                <div className="loading-inline">
                  <Loader2 size={12} className="spin" style={{ animation: 'spin .9s linear infinite' }} />
                  {live.status === 'awaiting' ? t('waitingApproval') : '正在处理…'}
                </div>
              ) : null}
              {live.tools.map((tool) => (
                <ToolCard
                  key={tool.callId}
                  tool={tool.tool}
                  args={tool.args}
                  risk={tool.risk}
                  status={tool.status}
                  result={tool.result}
                  summary={tool.summary}
                  live
                  onOpenEditor={(sql) => openQuery(undefined, sql)}
                />
              ))}
              <PlanCard items={live.plan} />
              {live.error ? <div className="risk-banner">{live.error}</div> : null}
              {!busy ? (
                <div className="turn-end">
                  {live.status === 'aborted' ? t('aborted') : live.status === 'error' ? t('failed') : t('completed')} · {live.tools.length} 次工具 · {formatDuration(Date.now() - live.startedAt)}
                  {live.tokensIn || live.tokensOut ? ` · ↑${live.tokensIn} ↓${live.tokensOut}` : ''}
                </div>
              ) : null}
            </AssistantShell>
          </>
        ) : null}
      </div>

      {popover === 'mention' ? (
        <div className="popover mention-popover">
          {tables
            .filter((tbl) => tbl.name.toLowerCase().includes(mentionQuery.toLowerCase()))
            .slice(0, 8)
            .map((tbl) => (
              <button key={tbl.name} className="popover-item" onClick={() => insertMention(tbl.name)}>
                <Database size={12} />
                <span>{tbl.name}</span>
                <span className="k">{tbl.columns?.length ?? 0} cols</span>
              </button>
            ))}
          {!tables.length ? <div className="popover-item muted">当前连接没有可引用表</div> : null}
        </div>
      ) : null}
      {popover === 'slash' ? (
        <div className="popover mention-popover">
          {SLASH.filter((c) => c.key.startsWith(input.trim())).map((c) => (
            <button key={c.key} className="popover-item" onClick={() => runSlash(c.key)}>
              <TerminalSquare size={12} />
              <span>{c.key}</span>
              <span className="k">{c.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="composer">
        <div className="composer-box">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            placeholder={t('composerHint')}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              if (e.key === 'Escape') setPopover('none');
            }}
            data-testid="agent-input"
          />
          <div className="composer-tools">
            <button
              className="icon-btn"
              title={t('attachTable')}
              onClick={() => {
                setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@`);
                setPopover('mention');
                textareaRef.current?.focus();
              }}
            >
              <AtSign size={13} />
            </button>
            <button
              className="icon-btn"
              title={t('slashCommands')}
              onClick={() => {
                setInput('/');
                setPopover('slash');
                textareaRef.current?.focus();
              }}
            >
              <Zap size={13} />
            </button>
            <button className="icon-btn" title={t('memory')} onClick={openMemory}>
              <Brain size={13} />
            </button>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <div className="composer-foot">
            <span className="composer-perm-label">权限</span>
            <select
              className="mode-select"
              value={agentMode}
              onChange={(e) => setAgentMode(e.target.value as PermissionMode)}
              title={t('permission')}
              data-testid="agent-mode"
            >
              {MODE_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{settings.locale === 'en' ? m.en : m.zh}</option>
              ))}
            </select>
            <div className="spacer" />
            {busy ? (
              <button className="send-btn stop" onClick={() => void abortAgent()} title={t('stop')} data-testid="agent-stop">
                <Square size={12} />
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!input.trim()} title={t('send')} data-testid="agent-send">
                <Sparkles size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">
          <ShieldAlert size={9} /> {t('transactionNote')}
        </div>
      </div>

      {sessionsOpen ? (
        <div className="sessions-drawer">
          <div className="sessions-head">
            <span style={{ fontWeight: 600, flex: 1 }}>{t('sessions')}</span>
            <button className="btn small primary" onClick={() => void newAgentSession()}>
              <Plus size={12} /> {t('newSession')}
            </button>
            <button className="icon-btn" onClick={() => setSessionsOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {filteredSessions.length ? (
              filteredSessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-item ${session.id === agentSessionId ? 'active' : ''}`}
                  onClick={() => void loadAgentSession(session.id)}
                >
                  <TerminalSquare size={13} style={{ color: 'var(--agent)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="s-title">{session.title}</div>
                    <div className="s-meta">
                      {formatRelative(session.updatedAt)} · {session.permissionMode} · {session.tokensIn + session.tokensOut} tokens
                    </div>
                  </div>
                  <button
                    className="icon-btn danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm('删除该会话？')) void deleteAgentSession(session.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            ) : (
              <div className="muted" style={{ padding: 16, fontSize: 11.5 }}>还没有会话</div>
            )}
          </div>
        </div>
      ) : null}

      {approval ? (
        <div className="overlay" style={{ zIndex: 70 }}>
          <div className="modal approval-modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>
                <ShieldAlert size={15} style={{ color: 'var(--warning)' }} />
                {t('approval')}
              </h2>
            </div>
            <div className="modal-body">
              <div className="approval-risk">
                <RiskBadge risk={approval.risk} />
                <span className="mono" style={{ fontSize: 12 }}>{approval.tool}</span>
                <div className="spacer" />
                <span className="muted" style={{ fontSize: 10.5 }}>{t('permission')}：{agentMode}</span>
              </div>
              <div className="approval-summary">{approval.summary}</div>
              {approval.sql ? (
                <div className="sql-block approval-sql">
                  {approval.sql}
                  <span style={{ position: 'absolute', top: 4, right: 4 }}><CopyButton text={approval.sql} /></span>
                </div>
              ) : (
                <pre className="code-block-small" style={{ maxHeight: 180, overflow: 'auto' }}>{JSON.stringify(approval.args, null, 2)}</pre>
              )}
              {approval.risk === 'destructive' ? (
                <div className="risk-banner" style={{ marginTop: 10 }}>
                  这是破坏性操作，可能永久删除数据。确认前 Agent 已按设置尝试创建备份。
                </div>
              ) : null}
              <p className="hint" style={{ marginTop: 10 }}>{t('transactionNote')}</p>
            </div>
            <div className="modal-foot" style={{ flexWrap: 'wrap' }}>
              <button className="btn ghost" onClick={() => void resolveApproval('deny', 'once')} data-testid="approval-deny">
                {t('deny')}
              </button>
              <div className="spacer" />
              <button className="btn" onClick={() => void resolveApproval('deny', 'once')} style={{ display: 'none' }} />
              <button className="btn" onClick={() => void resolveApproval('allow', 'once')} data-testid="approval-allow-once">
                {t('allowOnce')}
              </button>
              <button className="btn" onClick={() => void resolveApproval('allow', 'session')}>
                {t('allowSession')}
              </button>
              <button className="btn primary" onClick={() => void resolveApproval('allow', 'always')}>
                {t('allowAlways')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
