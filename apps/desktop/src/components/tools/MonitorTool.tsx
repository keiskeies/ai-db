import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Loader2, RefreshCw, Skull } from 'lucide-react';
import { applyCapabilityDefaults, CAPABILITIES, getCapability, type Capability } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';
import { CapabilityForm } from './CapabilityForm';

/**
 * 服务器监控 —— 表单迁移到能力契约（`capabilities/monitor.json`）。
 *
 * 契约里只有 `connectionId` 一个字段，所以这里走的是 **可编辑 connection 字段**路径
 * （不传 `connectionId` prop，由 `CapabilityForm` 渲染连接选择器）。
 * 「每 10s 自动刷新」「终止会话」是 UI 行为，不属于表单字段，保持手写。
 */
export function MonitorTool() {
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const connections = useApp((s) => s.connections);
  const notify = useApp((s) => s.notify);
  const capability = useMemo<Capability>(() => getCapability('monitor') ?? CAPABILITIES[0], []);

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    applyCapabilityDefaults(capability, { connectionId: activeConnectionId ?? connections[0]?.id ?? '' }),
  );
  const [monitor, setMonitor] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);

  const connectionId = String(values.connectionId ?? '');

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const { monitor: data } = await api.monitor(connectionId);
      setMonitor(data);
    } catch (err: any) {
      notify('error', '监控失败', err?.message);
    } finally {
      setLoading(false);
    }
  }, [connectionId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [auto, load]);

  const kill = async (sessionId: string) => {
    if (!window.confirm(`终止会话 ${sessionId}？该操作不可撤销。`)) return;
    try {
      await api.killSession({ connectionId, sessionId });
      notify('success', '会话已终止');
      await load();
    } catch (err: any) {
      notify('error', '终止失败', err?.message);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Activity size={15} /> 服务器监控
        <span className="muted">{capability.title.en} · 指标 / 会话 / 终止</span>
      </div>
      <div className="tool-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: 240 }}>
          <CapabilityForm
            capability={capability}
            values={values}
            onChange={(key, value) => {
              setValues((current) => ({ ...current, [key]: value }));
              if (key === 'connectionId') setMonitor(null);
            }}
            disabled={loading}
            testIdPrefix="monitor"
          />
        </div>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={12} />} 刷新
        </button>
        <label className="checkbox"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 每 10s 自动刷新</label>
        <span className="spacer" />
        {monitor?.version ? <span className="badge">{monitor.version}</span> : null}
      </div>
      <div className="tool-scroll">
        {!monitor ? <div className="dash-empty">选择连接以读取指标。</div> : null}
        {monitor?.error ? <div className="risk-banner">{monitor.error}</div> : null}
        <div className="monitor-grid">
          {(monitor?.sections ?? []).map((section: any) => (
            <div key={section.title} className="panel">
              <div className="panel-head">{section.title}{section.error ? <span className="badge destructive">错误</span> : null}</div>
              <div className="monitor-items">
                {section.items.map((item: any) => (
                  <div key={item.label} className="monitor-item">
                    <span>{item.label}</span>
                    <strong>{String(item.value)}</strong>
                  </div>
                ))}
                {section.error ? <div className="dash-empty" style={{ padding: 6 }}>{section.error}</div> : null}
              </div>
            </div>
          ))}
        </div>
        {monitor?.sessions?.length ? (
          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-head">会话 <span className="badge">{monitor.sessions.length}</span></div>
            <div className="mini-table-wrap">
              <table className="tool-table">
                <thead><tr><th>ID</th><th>用户</th><th>库</th><th>状态</th><th>耗时</th><th>SQL</th><th /></tr></thead>
                <tbody>
                  {monitor.sessions.slice(0, 50).map((session: any) => (
                    <tr key={session.id}>
                      <td className="mono">{session.id}</td>
                      <td>{session.user}</td>
                      <td>{session.database}</td>
                      <td>{session.state}</td>
                      <td>{session.elapsed}</td>
                      <td title={session.query}>{String(session.query ?? '').slice(0, 90)}</td>
                      <td>
                        <button className="icon-btn danger" title="终止会话" onClick={() => void kill(session.id)}>
                          <Skull size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
