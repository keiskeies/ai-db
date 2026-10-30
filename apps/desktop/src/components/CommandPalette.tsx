import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  Braces,
  Database,
  Moon,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  Sun,
} from 'lucide-react';
import { COMMANDS } from '@aidb/core';
import { useApp } from '../store';

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const t = useApp((s) => s.t);
  const theme = useApp((s) => s.settings.theme);
  const openConnectionEditor = useApp((s) => s.openConnectionEditor);
  const openQuery = useApp((s) => s.openQuery);
  const refreshAll = useApp((s) => s.refreshAllSchemas);
  const setAgentOpen = useApp((s) => s.setAgentOpen);
  const agentOpen = useApp((s) => s.agentOpen);
  const openMemory = useApp((s) => s.openMemory);
  const openTools = useApp((s) => s.openTools);
  const openCommandSheet = useApp((s) => s.openCommandSheet);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const openBackup = useApp((s) => s.openBackup);
  const saveSettings = useApp((s) => s.saveSettings);
  const connections = useApp((s) => s.connections);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo(
    () => [
      { id: 'new-conn', label: t('newConnection'), hint: 'Connection', icon: <Database size={14} />, run: () => openConnectionEditor('new') },
      { id: 'new-query', label: t('newQuery'), hint: 'Ctrl+T', icon: <TerminalSquare size={14} />, run: () => openQuery() },
      { id: 'refresh', label: t('command_refresh'), hint: 'F5', icon: <RefreshCw size={14} />, run: () => void refreshAll() },
      { id: 'agent', label: t('command_toggle_agent'), hint: 'Ctrl+Shift+A', icon: <Bot size={14} />, run: () => setAgentOpen(!agentOpen) },
      { id: 'memory', label: t('command_memory'), hint: 'Brain', icon: <Brain size={14} />, run: () => openMemory() },
      { id: 'tools', label: '工具箱（搜索 / 对比 / 传输 / 监控 / 调度）', hint: 'Tools', icon: <Wrench size={14} />, run: () => openTools() },
      ...COMMANDS.filter((command) => command.id !== 'ask').map((command) => ({
        id: `command-${command.id}`,
        label: `${command.title.zh} /${command.id}`,
        hint: '命令',
        icon: <TerminalSquare size={14} />,
        run: () => openCommandSheet(command.id),
      })),
      { id: 'backup', label: t('command_backup'), hint: 'Backup', icon: <ShieldCheck size={14} />, run: () => void openBackup() },
      { id: 'settings', label: t('command_settings'), hint: 'Ctrl+,', icon: <Settings size={14} />, run: () => setSettingsOpen(true) },
      {
        id: 'theme',
        label: t('command_theme'),
        hint: theme === 'dark' ? 'Light' : 'Dark',
        icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />,
        run: () => void saveSettings({ theme: theme === 'dark' ? 'light' : 'dark' }),
      },
      ...connections.map((conn) => ({
        id: `conn-${conn.id}`,
        label: conn.name,
        hint: `${conn.engine} · ${conn.environment}`,
        icon: <Braces size={14} />,
        run: () => openQuery(conn.id),
      })),
    ],
    [t, theme, connections, openConnectionEditor, openQuery, refreshAll, setAgentOpen, agentOpen, openMemory, openTools, openCommandSheet, setSettingsOpen, openBackup, saveSettings],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  return (
    <div
      className="overlay"
      style={{ alignItems: 'flex-start', paddingTop: 0, background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="palette" role="dialog" aria-modal="true" style={{ position: 'relative', top: 0, left: 0, transform: 'none', marginTop: '12vh' }}>
        <div className="row" style={{ borderBottom: '1px solid var(--border-subtle)', paddingRight: 10 }}>
          <Search size={15} style={{ marginLeft: 14, color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('typeCommand')}
            style={{ border: 'none', flex: 1 }}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                const command = filtered[active];
                if (command) {
                  setOpen(false);
                  command.run();
                }
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <span className="kbd">ESC</span>
        </div>
        <div className="palette-list">
          {filtered.map((command, index) => (
            <button
              key={command.id}
              className={`palette-item ${index === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                setOpen(false);
                command.run();
              }}
            >
              <span style={{ color: index === active ? 'var(--accent)' : 'var(--text-muted)' }}>{command.icon}</span>
              <span className="label">{command.label}</span>
              <span className="kbd">{command.hint}</span>
            </button>
          ))}
          {!filtered.length ? <div className="muted" style={{ padding: 14, fontSize: 12 }}>没有匹配的命令</div> : null}
        </div>
      </div>
    </div>
  );
}
