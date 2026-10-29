import { useEffect, useState, type ReactNode } from 'react';
import type { ContextMenuItem } from './store';
import { desktopBridge, type OpenTablePayload } from './lib/desktop';
import {
  Archive,
  BarChart3,
  Bot,
  Boxes,
  Clipboard,
  Copy,
  PanelLeft,
  Scissors,
  Braces,
  Cable,
  Clock,
  Eye,
  History,
  Moon,
  Network,
  Settings,
  Sun,
  Table2,
  TerminalSquare,
  Users,
} from 'lucide-react';
import { useApp } from './store';
import { CommandPalette } from './components/CommandPalette';
import { ContextMenuHost } from './components/ContextMenu';
import { PaneSplitter } from './components/PaneSplitter';
import { ConnectionModal } from './components/ConnectionModal';
import { MemoryDrawer } from './components/MemoryDrawer';
import { SettingsModal } from './components/SettingsModal';
import { ToolsHub } from './components/tools/ToolsHub';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/ui';
import { Workspace } from './components/Workspace';

function RibbonButton({
  icon,
  label,
  onClick,
  active,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}) {
  return (
    <button className={`ribbon-btn ${active ? 'active' : ''}`} onClick={onClick} title={label} data-testid={testId}>
      <span className="ribbon-icon">{icon}</span>
      <span className="ribbon-label">{label}</span>
    </button>
  );
}

async function pasteInto(editable: HTMLElement): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    editable.focus();
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      const start = editable.selectionStart ?? editable.value.length;
      const end = editable.selectionEnd ?? start;
      const proto = editable instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(editable, editable.value.slice(0, start) + text + editable.value.slice(end));
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.setSelectionRange(start + text.length, start + text.length);
      return;
    }
    document.execCommand('insertText', false, text);
  } catch {
    /* 剪贴板拒绝读取时保持原样 */
  }
}

/** 没有专门菜单的区域走这套默认项，保证任何地方右键都有反应 */
function buildDefaultMenu(target: HTMLElement): ContextMenuItem[] {
  const state = useApp.getState();
  const items: ContextMenuItem[] = [];
  const selection = window.getSelection()?.toString().trim() ?? '';
  const editable = target.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null;

  if (selection) items.push({ label: '复制所选', icon: <Copy size={12} />, onClick: () => void navigator.clipboard.writeText(selection).catch(() => undefined) });
  if (editable) {
    if (items.length) items.push({ sep: true });
    items.push({ label: '剪切', icon: <Scissors size={12} />, onClick: () => document.execCommand('cut') });
    items.push({ label: '复制', icon: <Copy size={12} />, onClick: () => document.execCommand('copy') });
    items.push({ label: '粘贴', icon: <Clipboard size={12} />, onClick: () => void pasteInto(editable) });
    items.push({
      label: '全选',
      onClick: () => {
        if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
          editable.select();
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(editable);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      },
    });
  }
  items.push({ sep: true });
  items.push({ label: '刷新结构', onClick: () => { const id = state.activeConnectionId; if (id) void state.loadSchema(id, true); } });
  items.push({ label: '新建查询', onClick: () => state.openQuery() });
  items.push({ label: state.agentOpen ? '隐藏 AI 助手' : '显示 AI 助手', onClick: () => state.setAgentOpen(!state.agentOpen) });
  return items;
}

export default function App() {
  const boot = useApp((s) => s.boot);
  const booted = useApp((s) => s.booted);
  const [pendingOpenTable, setPendingOpenTable] = useState<OpenTablePayload | null>(null);

  useEffect(() => desktopBridge?.onOpenTable((payload) => setPendingOpenTable(payload)), []);

  useEffect(() => {
    if (!booted || !pendingOpenTable?.table) return;
    const state = useApp.getState();
    const connectionId = pendingOpenTable.connectionId ?? state.activeConnectionId ?? state.connections[0]?.id;
    if (connectionId) state.openData(connectionId, pendingOpenTable.table, pendingOpenTable.database);
    setPendingOpenTable(null);
  }, [booted, pendingOpenTable]);
  const bootError = useApp((s) => s.bootError);
  const settings = useApp((s) => s.settings);
  const t = useApp((s) => s.t);
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const activeTabId = useApp((s) => s.activeTabId);
  const tabs = useApp((s) => s.tabs);
  const agentOpen = useApp((s) => s.agentOpen);
  const setAgentOpen = useApp((s) => s.setAgentOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const setSidebarWidth = useApp((s) => s.setSidebarWidth);
  const agentWidth = useApp((s) => s.agentWidth);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const openTools = useApp((s) => s.openTools);
  const openQuery = useApp((s) => s.openQuery);
  const openRelations = useApp((s) => s.openRelations);
  const openConnectionEditor = useApp((s) => s.openConnectionEditor);
  const selectConnection = useApp((s) => s.selectConnection);
  const toggleConnection = useApp((s) => s.toggleConnection);
  const saveSettings = useApp((s) => s.saveSettings);
  const loadSchema = useApp((s) => s.loadSchema);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.density = settings.density;
  }, [settings.theme, settings.density]);

  useEffect(() => {
    // 接管全局右键：组件自己开菜单时会 preventDefault，这里只兜底
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = event.target as HTMLElement;
      useApp.getState().openContextMenu(event.clientX, event.clientY, buildDefaultMenu(target));
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) {
        if (event.key === 'F5' && !(event.target as HTMLElement)?.closest('input,textarea')) {
          event.preventDefault();
          const id = useApp.getState().activeConnectionId;
          if (id) void loadSchema(id, true);
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (key === 'a' && event.shiftKey) {
        event.preventDefault();
        setAgentOpen(!useApp.getState().agentOpen);
      } else if (key === 'l' && event.shiftKey) {
        event.preventDefault();
        setAgentOpen(true);
        setTimeout(() => (document.querySelector('[data-testid="agent-input"]') as HTMLTextAreaElement | null)?.focus(), 40);
      } else if (key === 'b') {
        event.preventDefault();
        useApp.getState().toggleSidebar();
      } else if (key === 't') {
        event.preventDefault();
        openQuery();
      } else if (key === 'w') {
        event.preventDefault();
        const id = useApp.getState().activeTabId;
        if (id !== 'welcome') useApp.getState().closeTab(id);
      } else if (key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [loadSchema, openQuery, setAgentOpen, setPaletteOpen, setSettingsOpen]);

  if (!booted) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <div className="brand-mark" style={{ width: 46, height: 46, fontSize: 17, margin: '0 auto' }}>AI</div>
          <h1>AiDB Studio</h1>
          {bootError ? (
            <>
              <p style={{ color: 'var(--danger)' }}>{bootError}</p>
              <p className="hint">{t('tokenHint')}</p>
              <button className="btn primary" style={{ marginTop: 12 }} onClick={() => void boot()}>
                {t('retry')}
              </button>
            </>
          ) : (
            <>
              <p>正在连接 Bridge 并装载元数据…</p>
              <div className="spinner" style={{ marginTop: 16 }} />
            </>
          )}
        </div>
      </div>
    );
  }

  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div className="app" data-testid="app-root">
      <div className="titlebar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <div className="brand-name">AiDB Studio</div>
            <div className="brand-sub">AI-native database workbench</div>
          </div>
        </div>
        {activeConn ? (
          <span className={`env-pill ${activeConn.environment}`}>
            <span className="conn-color" style={{ background: 'currentColor' }} />
            {activeConn.environment.toUpperCase()} · {activeConn.engine}
          </span>
        ) : null}
        <div className="spacer" />
        <button className="cmd-hint" onClick={() => setPaletteOpen(true)}>
          <span>搜索或执行命令…</span>
          <span className="kbd">⌘K</span>
        </button>
        <button
          data-testid="toggle-sidebar"
          className="icon-btn"
          title={sidebarOpen ? '隐藏连接栏 (⌘B)' : '显示连接栏 (⌘B)'}
          onClick={toggleSidebar}
          style={sidebarOpen ? undefined : { color: 'var(--text-muted)' }}
        >
          <PanelLeft size={15} />
        </button>
        <button data-testid="agent-toggle" className="icon-btn" title={t('agent')} onClick={() => setAgentOpen(!agentOpen)} style={agentOpen ? { color: 'var(--agent)', background: 'var(--agent-soft)' } : undefined}>
          <Bot size={15} />
        </button>
        <button data-testid="theme-toggle" className="icon-btn" title="切换主题" onClick={() => void saveSettings({ theme: dark ? 'light' : 'dark' })}>
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <button data-testid="open-settings" className="icon-btn" title={t('settings')} onClick={() => setSettingsOpen(true)}>
          <Settings size={15} />
        </button>
      </div>

      <div className="ribbon" data-testid="ribbon">
        <RibbonButton icon={<Cable size={20} />} label="连接" onClick={() => openConnectionEditor('new')} />
        <div className="ribbon-sep" />
        <RibbonButton icon={<TerminalSquare size={20} />} label="新建查询" onClick={() => openQuery()} testId="ribbon-new-query" />
        <RibbonButton
          icon={<Table2 size={20} />}
          label="表"
          active={activeTab?.kind === 'data'}
          onClick={() => {
            const id = activeConnectionId ?? connections[0]?.id;
            if (!id) {
              openConnectionEditor('new');
              return;
            }
            selectConnection(id);
            if (!useApp.getState().expandedConnections[id]) toggleConnection(id);
          }}
        />
        <RibbonButton icon={<Eye size={20} />} label="视图" onClick={() => openTools('objects')} />
        <RibbonButton icon={<Braces size={20} />} label="函数" onClick={() => openTools('objects')} />
        <div className="ribbon-sep" />
        <RibbonButton icon={<Users size={20} />} label="用户" onClick={() => openTools('users')} />
        <RibbonButton icon={<Boxes size={20} />} label="其它" onClick={() => openTools('objects')} />
        <div className="ribbon-sep" />
        <RibbonButton icon={<History size={20} />} label="查询" onClick={() => openQuery()} />
        <RibbonButton icon={<Archive size={20} />} label="备份" onClick={() => setSettingsOpen(true)} />
        <div className="ribbon-sep" />
        <RibbonButton icon={<Clock size={20} />} label="自动运行" onClick={() => openTools('jobs')} />
        <RibbonButton icon={<Network size={20} />} label="模型" onClick={() => openRelations()} />
        <RibbonButton icon={<BarChart3 size={20} />} label="图表" onClick={() => openQuery()} />
      </div>

      <div className="shell" style={{ ['--sidebar-w' as string]: `${sidebarWidth}px`, ['--agent-w' as string]: `${agentWidth}px` }}>
        {sidebarOpen ? (
          <>
            <Sidebar />
            <PaneSplitter
              side="left"
              width={sidebarWidth}
              min={200}
              max={460}
              onChange={(width) => setSidebarWidth(width)}
              onCommit={(width) => setSidebarWidth(width, true)}
              testId="splitter-sidebar"
            />
          </>
        ) : null}
        <Workspace />
      </div>

      <div className="statusbar">
        <span className="item">
          <span className="dot" /> Bridge 已连接
        </span>
        <span className="sep" />
        <span className="item">
          <Network size={10} /> {activeConn?.name ?? '未选择连接'}
        </span>
        {activeConn ? <span className="item">{activeConn.database ?? ''}</span> : null}
        <span className="sep" />
        <span className="item">{activeTab?.title ?? ''}</span>
        <div className="spacer" />
        <span className="item">{settings.agent.provider === 'local' ? 'AI: Local' : `AI: ${settings.agent.model}`}</span>
        <span className="item">{useApp.getState().connections.length} 连接</span>
        <span className="item">v0.1.0</span>
      </div>

      <MemoryDrawer />
      <SettingsModal />
      <ToolsHub />
      <ConnectionModal />
      <CommandPalette />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}
