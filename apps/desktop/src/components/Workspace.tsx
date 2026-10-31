import { FileCode2, LayoutDashboard, Network, Plus, Table2, TerminalSquare, Wrench, X } from 'lucide-react';
import { useApp } from '../store';
import { PaneSplitter } from './PaneSplitter';
import { AgentPanel } from './AgentPanel';
import { DashboardView } from './DashboardView';
import { DataView } from './DataView';
import { DesignView } from './DesignView';
import { QueryView } from './QueryView';
import { RelationsView } from './RelationsView';
import { Welcome } from './Welcome';

function TabIcon({ kind }: { kind: string }) {
  if (kind === 'query') return <TerminalSquare size={12} />;
  if (kind === 'data') return <Table2 size={12} />;
  if (kind === 'design') return <Wrench size={12} />;
  if (kind === 'relations') return <Network size={12} />;
  if (kind === 'dashboard') return <LayoutDashboard size={12} />;
  return <FileCode2 size={12} />;
}

export function Workspace() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const closeTab = useApp((s) => s.closeTab);
  const openQuery = useApp((s) => s.openQuery);
  const agentOpen = useApp((s) => s.agentOpen);
  const agentWidth = useApp((s) => s.agentWidth);
  const setAgentWidth = useApp((s) => s.setAgentWidth);
  const openContextMenu = useApp((s) => s.openContextMenu);
  const t = useApp((s) => s.t);

  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <>
      <main className="workspace">
        <div className="tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab ${tab.id === active?.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                const others = tabs.filter((item) => item.id !== tab.id).length;
                openContextMenu(e.clientX, e.clientY, [
                  { label: '关闭', onClick: () => closeTab(tab.id) },
                  { label: '关闭其它', disabled: others === 0, onClick: () => useApp.getState().closeOtherTabs(tab.id) },
                  { label: '关闭全部', onClick: () => useApp.getState().closeAllTabs() },
                ]);
              }}
              title={tab.title}
              data-testid={`tab-${tab.kind}`}
            >
              <TabIcon kind={tab.kind} />
              <span className="truncate" style={{ maxWidth: 150 }}>{tab.title}</span>
              {tab.kind !== 'welcome' ? (
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X size={11} />
                </span>
              ) : null}
            </button>
          ))}
          <button className="tab-add" title={t('newQuery')} onClick={() => openQuery()}>
            <Plus size={14} />
          </button>
          <div className="tab-spacer" />
        </div>
        {active?.kind === 'welcome' || !active ? <Welcome /> : null}
        {active?.kind === 'data' ? <DataView tab={active} /> : null}
        {active?.kind === 'query' ? <QueryView tab={active} /> : null}
        {active?.kind === 'design' ? <DesignView tab={active} /> : null}
        {active?.kind === 'relations' ? <RelationsView tab={active} /> : null}
        {active?.kind === 'dashboard' ? <DashboardView tab={active} /> : null}
      </main>
      {agentOpen ? (
        <>
          <PaneSplitter
            side="right"
            width={agentWidth}
            min={320}
            max={760}
            onChange={(width) => setAgentWidth(width)}
            onCommit={(width) => setAgentWidth(width, true)}
            testId="splitter-agent"
          />
          <AgentPanel />
        </>
      ) : null}
    </>
  );
}
