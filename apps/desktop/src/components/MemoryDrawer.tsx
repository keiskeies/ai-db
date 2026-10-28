import { useState } from 'react';
import { Brain, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react';
import { MEMORY_KINDS, MEMORY_KIND_LABELS, type MemoryKind } from '@aidb/core';
import { formatRelative } from '../lib/format';
import { useApp } from '../store';

export function MemoryDrawer() {
  const open = useApp((s) => s.memoryOpen);
  const t = useApp((s) => s.t);
  const locale = useApp((s) => s.settings.locale);
  const memories = useApp((s) => s.memories);
  const query = useApp((s) => s.memoryQuery);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const close = useApp((s) => s.closeMemory);
  const load = useApp((s) => s.loadMemories);
  const add = useApp((s) => s.addMemory);
  const save = useApp((s) => s.saveMemory);
  const remove = useApp((s) => s.removeMemory);

  const [search, setSearch] = useState(query);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [scope, setScope] = useState('connection');
  const [importance, setImportance] = useState(0.7);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  if (!open) return null;

  const submit = async () => {
    if (!title.trim() || !content.trim()) return;
    await add({ kind, title: title.trim(), content: content.trim(), scopeType: scope, importance, connectionId: activeConnectionId });
    setTitle('');
    setContent('');
    setShowForm(false);
  };

  return (
    <div className="drawer" data-testid="memory-drawer">
      <div className="drawer-head">
        <h2>
          <Brain size={15} style={{ color: 'var(--agent)' }} /> {t('memory')}
          <span className="badge agent">{memories.length}</span>
        </h2>
        <button className="icon-btn" onClick={() => setShowForm((v) => !v)} title={t('addMemory')}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="search-box">
          <Search size={13} />
          <input
            value={search}
            placeholder={t('searchMemory')}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load(search)}
          />
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          四层记忆：工作记忆（会话）、情景记忆（摘要）、语义记忆（事实/偏好/结构）、程序记忆（流程）。术语与示例 SQL 属于业务上下文，在工具箱「Agent 上下文」中维护。跨会话自动检索。
        </p>
      </div>
      <div className="drawer-body">
        {showForm ? (
          <div className="memory-form">
            <div className="row gap-6">
              <select className="select" style={{ height: 26, fontSize: 11 }} value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
                {MEMORY_KINDS.map((k) => (
                  <option key={k} value={k}>{MEMORY_KIND_LABELS[k][locale]}</option>
                ))}
              </select>
              <select className="select" style={{ height: 26, fontSize: 11 }} value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="global">全局</option>
                <option value="connection">当前连接</option>
                <option value="database">当前库</option>
              </select>
              <div className="spacer" />
              <input
                className="input"
                style={{ width: 70, height: 26 }}
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={importance}
                onChange={(e) => setImportance(Number(e.target.value))}
                title={t('importance')}
              />
            </div>
            <input className="input" placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="textarea" rows={3} placeholder="内容（不要写入密码、密钥等凭据）" value={content} onChange={(e) => setContent(e.target.value)} />
            <div className="row">
              <div className="spacer" />
              <button className="btn small" onClick={() => setShowForm(false)}>{t('cancel')}</button>
              <button className="btn primary small" onClick={() => void submit()}>{t('save')}</button>
            </div>
          </div>
        ) : null}

        {!memories.length ? (
          <div className="empty-state" style={{ padding: 30 }}>
            <div>
              <div className="icon"><Brain size={20} /></div>
              <h3>{t('memory')}</h3>
              <p>{t('emptyMemory')}</p>
            </div>
          </div>
        ) : null}

        {memories.map((memory) => (
          <div key={memory.id} className="memory-card">
            {editing === memory.id ? (
              <div className="col gap-6">
                <input className="input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                <textarea className="textarea" rows={3} value={editContent} onChange={(e) => setEditContent(e.target.value)} />
                <div className="row">
                  <div className="spacer" />
                  <button className="btn small" onClick={() => setEditing(null)}>{t('cancel')}</button>
                  <button
                    className="btn primary small"
                    onClick={async () => {
                      await save(memory.id, { title: editTitle, content: editContent });
                      setEditing(null);
                    }}
                  >
                    {t('save')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="m-head">
                  <span className="badge agent">{MEMORY_KIND_LABELS[memory.kind]?.[locale] ?? memory.kind}</span>
                  <span className="m-title">{memory.title}</span>
                  {memory.pinned ? <Pin size={11} style={{ color: 'var(--warning)' }} /> : null}
                </div>
                <div className="m-content">{memory.content}</div>
                <div className="m-foot">
                  <span>{memory.scopeType} · {memory.scopeKey === '*' ? 'global' : memory.scopeKey}</span>
                  <span>imp {memory.importance.toFixed(1)}</span>
                  <span>{formatRelative(memory.updatedAt)}</span>
                  <div className="spacer" />
                  <button className="icon-btn" title={t('pinned')} onClick={() => void save(memory.id, { pinned: !memory.pinned })}>
                    {memory.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      setEditing(memory.id);
                      setEditTitle(memory.title);
                      setEditContent(memory.content);
                    }}
                  >
                    <Pencil size={11} />
                  </button>
                  <button className="icon-btn danger" onClick={() => window.confirm('删除这条记忆？') && void remove(memory.id)}>
                    <Trash2 size={11} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
